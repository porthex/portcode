import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PREPARATION_STAGES,
  VERIFICATION_STAGES,
  deriveCoverageGate,
  deriveFindingGate,
  validateEvidenceArtifacts,
  validateStageProvenance,
} from "../scripts/qa-runner.mjs";
import {
  validateFeatureBriefSemantics,
  validateRiskRegisterSemantics,
  validateRiskVerificationSemantics,
  validateUseCaseScoutSemantics,
} from "../scripts/validate-contracts.mjs";

const qaRoot = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, qaRoot), "utf8");
const readJson = async (path) => JSON.parse(await read(path));

test("pipeline separates pre-implementation evolution from post-implementation verification", () => {
  assert.deepEqual(
    PREPARATION_STAGES.map(({ id }) => id),
    ["real-world-use-case-scout", "pre-implementation-risk-architect", "feature-brief-synthesizer"],
  );
  assert.deepEqual(
    VERIFICATION_STAGES.map(({ id }) => id),
    [
      "feature-completeness",
      "edge-case-explorer",
      "design-ux-auditor",
      "post-implementation-risk-verifier",
      "independent-reproducer",
    ],
  );
});

test("new agents require evidence, preserve the original request, and account for every frozen risk", async () => {
  const prompts = await Promise.all([
    read("agents/real-world-use-case-scout.md"),
    read("agents/pre-implementation-risk-architect.md"),
    read("agents/feature-brief-synthesizer.md"),
    read("agents/post-implementation-risk-verifier.md"),
  ]);
  for (const phrase of ["comparable products", "evidence", "Do not invent"])
    assert.match(prompts[0], new RegExp(phrase, "i"));
  assert.match(prompts[1], /trust boundar/i);
  assert.match(prompts[1], /race condition/i);
  assert.match(prompts[2], /original request.*immutable/i);
  assert.match(prompts[2], /Required.*Expected.*Optional.*Rejected/is);
  assert.match(prompts[3], /every frozen risk/i);
  assert.match(prompts[3], /blocked.*needs-review/is);
  assert.match(prompts[3], /required capabilities.*exact.*indivisible/is);
  assert.match(prompts[3], /compound capability.*every component.*blocked/is);
});

test("new schemas are strict Draft 2020-12 contracts", async () => {
  for (const path of [
    "schemas/use-case-scout.schema.json",
    "schemas/risk-register.schema.json",
    "schemas/feature-brief.schema.json",
    "schemas/risk-verification.schema.json",
  ]) {
    const schema = await readJson(path);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.additionalProperties, false);
  }
  const riskVerification = await readJson("schemas/risk-verification.schema.json");
  assert.ok(riskVerification.$defs.evidence.properties.source);
  assert.ok(riskVerification.$defs.evidence.properties.tests);
});

test("frozen and satisfied risk verification methods use the same vocabulary", async () => {
  const register = await readJson("schemas/risk-register.schema.json");
  const verification = await readJson("schemas/risk-verification.schema.json");
  const frozen = register.$defs.verification.properties.methods.items.enum;
  const satisfied = verification.$defs.verdict.properties.satisfiedMethods.items.enum;
  assert.deepEqual([...satisfied].sort(), [...frozen].sort());
});

test("use-case semantics reject automatic additions without strong evidence", () => {
  const report = {
    outcome: "ready",
    originalRequirements: [{ id: "REQ-001", text: "Changed request" }],
    proposals: [
      {
        id: "UC-001",
        disposition: "expected",
        changeRisk: "additive-low",
        evidence: [
          { type: "comparable-product", locator: "https://example.test/a", claim: "A supports it" },
        ],
      },
    ],
  };
  const errors = validateUseCaseScoutSemantics(report, "Original request");
  assert.ok(errors.some((error) => /strong evidence/i.test(error)));
  assert.ok(errors.some((error) => /not verbatim/i.test(error)));
});

test("risk register requires unique risks mapped into verification plans", () => {
  const report = {
    outcome: "ready",
    risks: [
      { id: "RISK-001", severity: "high", verification: { methods: [] } },
      { id: "RISK-001", severity: "high", verification: { methods: ["runtime"] } },
    ],
  };
  const errors = validateRiskRegisterSemantics(report);
  assert.ok(errors.some((error) => /duplicate/i.test(error)));
  assert.ok(errors.some((error) => /verification method/i.test(error)));
});

test("feature brief cannot mutate or omit explicit original requirements", () => {
  const scout = {
    outcome: "ready",
    originalRequirements: [{ id: "REQ-001", text: "Attach files" }],
    proposals: [],
  };
  const risks = { outcome: "ready", risks: [] };
  const brief = {
    outcome: "ready",
    originalRequestVerbatim: "Mutated task",
    originalRequirements: [{ id: "REQ-001", text: "Upload files" }],
    proposalDecisions: [],
    finalRequirements: [],
  };
  const errors = validateFeatureBriefSemantics(brief, scout, risks, "Original task");
  assert.ok(errors.some((error) => /immutable/i.test(error)));
  assert.ok(errors.some((error) => /original task file/i.test(error)));
});

test("risk verification accounts for every frozen risk and blocked high risk forces review", () => {
  const register = {
    outcome: "ready",
    registerId: "risk-1",
    risks: [
      { id: "RISK-001", severity: "high" },
      { id: "RISK-002", severity: "low" },
    ],
  };
  const report = {
    outcome: "completed",
    riskRegisterId: "risk-1",
    verdicts: [{ riskId: "RISK-001", status: "blocked" }],
  };
  assert.ok(
    validateRiskVerificationSemantics(report, register).some((error) => /RISK-002/gi.test(error)),
  );
  assert.equal(deriveCoverageGate(report, "pass"), "needs-review");
});

test("blocked exploration coverage forces review even when frozen risks and findings pass", () => {
  const risks = {
    outcome: "completed",
    verdicts: [{ riskId: "RISK-001", status: "verified-safe" }],
  };
  const exploration = {
    outcome: "completed",
    coverage: {
      planned: 4,
      selected: 4,
      executed: 3,
      passed: 3,
      observationsRecorded: 0,
      blocked: 1,
      notApplicable: 0,
    },
  };
  assert.equal(deriveCoverageGate(risks, "pass", exploration), "needs-review");
  exploration.coverage.blocked = 0;
  exploration.coverage.executed = 4;
  exploration.coverage.passed = 4;
  assert.equal(deriveCoverageGate(risks, "pass", exploration), "pass");
});

test("risk verification requires evidence before dismissing a frozen risk as not applicable", () => {
  const register = {
    outcome: "ready",
    registerId: "risk-na",
    risks: [{ id: "RISK-001", severity: "high" }],
  };
  const report = {
    outcome: "completed",
    riskRegisterId: "risk-na",
    verdicts: [
      {
        riskId: "RISK-001",
        status: "not-applicable",
        rationale: "Claimed unreachable",
        evidence: {},
      },
    ],
    summary: {
      total: 1,
      verifiedSafe: 0,
      findings: 0,
      notApplicable: 1,
      blocked: 0,
      coverageGate: "pass",
    },
  };
  assert.ok(
    validateRiskVerificationSemantics(report, register).some((error) =>
      /objective evidence/i.test(error),
    ),
  );
});

test("runner derives the finding gate from configured severities, never the agent policy", () => {
  const report = {
    outcome: "completed",
    summary: { blockingSeverities: ["low"], mergeGate: "pass" },
    verdicts: [{ candidateId: "RV-001", disposition: "confirmed", finalSeverity: "critical" }],
  };
  assert.deepEqual(deriveFindingGate(report, ["critical", "high"]), {
    gate: "fail",
    blockingCandidateIds: ["RV-001"],
  });
});

test("runner rejects missing evidence artifacts and accepts contained files", async () => {
  const root = await mkdtemp(join(tmpdir(), "portcode-qa-evidence-"));
  try {
    assert.deepEqual(await validateEvidenceArtifacts({}, root, "empty-stage"), []);
    assert.deepEqual(
      await validateEvidenceArtifacts(
        { instrumentation: { trace: "unavailable" } },
        root,
        "edge-case-explorer",
      ),
      [],
    );
    assert.ok(
      (
        await validateEvidenceArtifacts(
          { evidence: { screenshots: [], trace: "unavailable" } },
          root,
          "edge-case-explorer",
        )
      ).some((error) => /does not exist|not owned by stage/i.test(error)),
    );
    await mkdir(join(root, "screenshots"));
    await mkdir(join(root, "evidence", "edge-case-explorer"), { recursive: true });
    await writeFile(join(root, "screenshots", "real.png"), "runner-owned-not-stage-evidence");
    await writeFile(
      join(root, "evidence", "edge-case-explorer", "real.png"),
      "fresh-stage-evidence",
    );
    assert.deepEqual(
      await validateEvidenceArtifacts(
        { evidence: { screenshots: ["evidence/edge-case-explorer/real.png"], trace: null } },
        root,
        "edge-case-explorer",
      ),
      [],
    );
    assert.ok(
      (
        await validateEvidenceArtifacts(
          { evidence: { screenshots: ["screenshots/real.png"], trace: null } },
          root,
          "edge-case-explorer",
        )
      ).some((error) => /not owned by stage/i.test(error)),
    );
    assert.ok(
      (
        await validateEvidenceArtifacts(
          { evidence: { screenshots: ["evidence/edge-case-explorer/missing.png"], trace: null } },
          root,
          "edge-case-explorer",
        )
      ).some((error) => /does not exist/i.test(error)),
    );
    assert.ok(
      (
        await validateEvidenceArtifacts(
          { evidence: { screenshots: ["../escape.png"], trace: null } },
          root,
          "edge-case-explorer",
        )
      ).some((error) => /owned by stage|outside|unsafe/i.test(error)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preparation provenance pins task and upstream reports while verification pins the frozen brief and risks", () => {
  const expected = {
    taskSha256: "a".repeat(64),
    useCaseScoutSha256: "b".repeat(64),
    riskRegisterSha256: "c".repeat(64),
    featureBriefSha256: "d".repeat(64),
    workingTreeSha256: "e".repeat(64),
  };
  assert.deepEqual(
    validateStageProvenance(
      "feature-brief-synthesizer",
      {
        outcome: "ready",
        provenance: {
          taskSha256: expected.taskSha256,
          useCaseScoutSha256: expected.useCaseScoutSha256,
          riskRegisterSha256: expected.riskRegisterSha256,
          workingTreeSha256: expected.workingTreeSha256,
        },
      },
      expected,
    ),
    [],
  );
  assert.ok(
    validateStageProvenance(
      "post-implementation-risk-verifier",
      {
        outcome: "completed",
        provenance: {
          featureBriefSha256: "wrong",
          riskRegisterSha256: expected.riskRegisterSha256,
        },
      },
      expected,
    ).some((error) => error.includes("featureBriefSha256")),
  );
});
