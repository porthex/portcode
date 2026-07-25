import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  STAGES,
  assertSafeRunId,
  buildStagePrompt,
  extractJsonObject,
  compareSourceSnapshots,
  nextStageAttempt,
  pruneInvalidStageCheckpoints,
  resumeProvenanceMismatches,
  reusableStageCheckpoint,
  validateEvidenceArtifacts,
  validateStageProvenance,
} from "../scripts/qa-runner.mjs";

const projectRoot = new URL("../../", import.meta.url);

test("runner defines the five ordered post-implementation trust stages", () => {
  assert.deepEqual(
    STAGES.map(({ id }) => id),
    [
      "feature-completeness",
      "edge-case-explorer",
      "design-ux-auditor",
      "post-implementation-risk-verifier",
      "independent-reproducer",
    ],
  );
});

test("JSON extraction accepts fenced or noisy agent output but rejects trailing objects", () => {
  assert.deepEqual(extractJsonObject('```json\n{"outcome":"blocked"}\n```'), {
    outcome: "blocked",
  });
  assert.deepEqual(extractJsonObject('result follows:\n{"nested":{"ok":true}}\n'), {
    nested: { ok: true },
  });
  assert.throws(() => extractJsonObject('{"first":1}\n{"second":2}'), /exactly one JSON object/i);
});

test("stage prompt pins inputs, output contract, and read-only source boundary", () => {
  const prompt = buildStagePrompt({
    stage: STAGES[1],
    projectRoot: "D:/Projects/portcode",
    runRoot: "D:/Projects/portcode/.qa/generated/run-1",
    taskPath: "D:/Projects/portcode/.qa/generated/run-1/inputs/task.md",
    configPath: "D:/Projects/portcode/.qa/config.json",
    inputPaths: ["D:/Projects/portcode/.qa/generated/run-1/reports/feature-model.json"],
    outputPath: "D:/Projects/portcode/.qa/generated/run-1/reports/exploration-report.json",
  });
  for (const expected of [
    "edge-case-explorer",
    "inputs/task.md",
    "feature-model.json",
    "Application source is read-only",
    "Return exactly one JSON object",
    "Do not write the report file yourself",
  ])
    assert.match(prompt, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

test("source snapshot comparison reports modified, added, and removed paths", () => {
  const before = new Map([
    ["src/a.ts", "one"],
    ["src/b.ts", "two"],
  ]);
  const after = new Map([
    ["src/a.ts", "changed"],
    ["src/c.ts", "three"],
  ]);
  assert.deepEqual(compareSourceSnapshots(before, after), {
    added: ["src/c.ts"],
    modified: ["src/a.ts"],
    removed: ["src/b.ts"],
  });
});

test("stage provenance is pinned to the task, Git state, and exact upstream reports", () => {
  const expected = {
    taskSha256: "a".repeat(64),
    gitBase: "base",
    gitHead: "head",
    featureModelSha256: "b".repeat(64),
    explorationSha256: "c".repeat(64),
    designSha256: "d".repeat(64),
  };
  const feature = {
    outcome: "ready",
    provenance: { taskSha256: expected.taskSha256, gitBase: "base", gitHead: "head" },
  };
  assert.deepEqual(validateStageProvenance("feature-completeness", feature, expected), []);
  const confirmation = {
    outcome: "completed",
    provenance: {
      featureModelSha256: expected.featureModelSha256,
      explorationReportSha256: "wrong",
      designReportSha256: expected.designSha256,
      gitBase: "base",
      gitHead: "head",
    },
  };
  assert.ok(
    validateStageProvenance("independent-reproducer", confirmation, expected).some((error) =>
      error.includes("explorationReportSha256"),
    ),
  );
});

test("resume reuses only fully validated stage checkpoints", () => {
  const validated = {
    id: "feature-completeness",
    validationStatus: "validated",
    reportSha256: "a".repeat(64),
  };
  const reportReady = {
    id: "edge-case-explorer",
    validationStatus: "report-ready",
    reportSha256: "b".repeat(64),
  };
  const legacy = { id: "design-ux-auditor", reportSha256: "c".repeat(64) };
  const manifest = { stages: [validated, reportReady, legacy] };

  assert.equal(reusableStageCheckpoint(manifest, "feature-completeness"), validated);
  assert.equal(reusableStageCheckpoint(manifest, "edge-case-explorer"), null);
  assert.equal(reusableStageCheckpoint(manifest, "design-ux-auditor"), null);
});

test("resume prunes the first invalid checkpoint and every downstream stage", () => {
  const manifest = {
    stages: [
      { id: "feature-completeness", validationStatus: "validated" },
      { id: "edge-case-explorer", validationStatus: "report-ready" },
      { id: "design-ux-auditor", validationStatus: "validated" },
    ],
  };
  assert.deepEqual(pruneInvalidStageCheckpoints(manifest), [
    "edge-case-explorer",
    "design-ux-auditor",
  ]);
  assert.deepEqual(
    manifest.stages.map(({ id }) => id),
    ["feature-completeness"],
  );
});

test("resume rejects changed source or invocation provenance", () => {
  const manifest = {
    runId: "run-1",
    phase: "verify",
    mode: "change",
    provider: "hermes",
    taskSha256: "a".repeat(64),
    gitBase: "base",
    gitHead: "head",
    gitDiffSha256: "b".repeat(64),
    gitStatusSha256: "c".repeat(64),
    workingTreeSha256: "d".repeat(64),
  };
  assert.deepEqual(resumeProvenanceMismatches(manifest, { ...manifest }), []);
  assert.deepEqual(
    resumeProvenanceMismatches(manifest, {
      ...manifest,
      provider: "other",
      workingTreeSha256: "e".repeat(64),
    }),
    ["provider", "workingTreeSha256"],
  );
});

test("stage retries allocate isolated evidence attempt directories", () => {
  assert.equal(nextStageAttempt([]), 1);
  assert.equal(nextStageAttempt(["attempt-1", "notes.txt", "attempt-3"]), 4);
});

test("blocked checkpoints are never reusable", () => {
  const blocked = {
    id: "feature-completeness",
    outcome: "blocked",
    validationStatus: "validated",
    reportSha256: "a".repeat(64),
  };
  const manifest = { stages: [blocked] };
  assert.equal(reusableStageCheckpoint(manifest, blocked.id), null);
  assert.deepEqual(pruneInvalidStageCheckpoints(manifest), [blocked.id]);
});

test("resume run IDs cannot escape the generated artifact root", () => {
  assert.equal(assertSafeRunId("2026-07-25T08-00-00-000Z"), "2026-07-25T08-00-00-000Z");
  for (const unsafe of ["../escape", "..", ".", "/absolute", "C:\\absolute", "nested/run"])
    assert.throws(() => assertSafeRunId(unsafe), /safe run ID/i);
});

test("retried reports cannot cite evidence from an earlier attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "portcode-qa-attempt-evidence-"));
  try {
    await mkdir(join(root, "evidence", "edge-case-explorer", "attempt-1"), { recursive: true });
    await mkdir(join(root, "evidence", "edge-case-explorer", "attempt-2"), { recursive: true });
    await writeFile(
      join(root, "evidence", "edge-case-explorer", "attempt-1", "stale.png"),
      "stale",
    );
    const report = {
      evidence: { screenshots: ["evidence/edge-case-explorer/attempt-1/stale.png"] },
    };
    assert.ok(
      (await validateEvidenceArtifacts(report, root, "edge-case-explorer", 2)).some((error) =>
        /attempt-2|not owned/i.test(error),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package scripts expose contracts, preparation, and change-scoped verification", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8"));
  assert.equal(packageJson.scripts["qa:contracts"], "node --test .qa/tests/*.test.mjs");
  assert.match(packageJson.scripts["qa:prepare"], /qa-runner\.mjs --phase prepare --mode change/);
  assert.match(packageJson.scripts["qa:change"], /qa-runner\.mjs --phase verify --mode change/);
  assert.equal(packageJson.scripts["qa:full"], undefined);
});

test("dry-run CLI plans all stages without invoking an agent or starting the app", async () => {
  const directory = await mkdtemp(join(tmpdir(), "portcode-qa-runner-"));
  const taskPath = join(directory, "task.md");
  await writeFile(taskPath, "Add a visible loading state.\n", "utf8");
  try {
    const result = spawnSync(
      process.execPath,
      [".qa/scripts/qa-runner.mjs", "--mode", "change", "--task", taskPath, "--dry-run"],
      {
        cwd: new URL("../..", import.meta.url),
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.mode, "change");
    assert.equal(plan.provider, "hermes");
    assert.deepEqual(
      plan.stages,
      STAGES.map(({ id }) => id),
    );
    assert.equal(plan.app.started, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
