import assert from "node:assert/strict";
import test from "node:test";

import { validateConfirmedReportSemantics } from "../scripts/validate-contracts.mjs";

const model = { modelId: "fm-confirm", outcome: "ready" };
const exploration = {
  outcome: "completed",
  observations: [{ id: "OBS-001", classification: "functional-defect-candidate" }],
};
const design = {
  outcome: "completed",
  observations: [{ id: "DES-001", classification: "missing-state-design" }],
};
const identities = {
  explorationSha256: "b".repeat(64),
  designSha256: "c".repeat(64),
};

test("blocked confirmation report is valid without invented run fields", () => {
  assert.deepEqual(
    validateConfirmedReportSemantics({
      outcome: "blocked",
      blockers: [{ id: "BLK-001", reason: "Target mismatch" }],
    }),
    [],
  );
});

test("complete confirmation report accounts for all candidates and derives the failing gate", () => {
  assert.deepEqual(
    validateConfirmedReportSemantics(validReport(), model, exploration, design, identities),
    [],
  );
});

test("confirmation rejects missing candidates, false confirmation, reused paths, severity leakage, and false gate totals", () => {
  const report = validReport();
  report.candidateManifest.pop();
  report.verdicts[0].reproduction.observed = 0;
  report.verdicts[0].evidence.screenshots = ["../explorer/obs.png"];
  report.verdicts[1].finalSeverity = "low";
  report.summary.confirmed = 99;
  report.summary.mergeGate = "pass";

  const errors = validateConfirmedReportSemantics(report, model, exploration, design, identities);
  assert.ok(errors.some((error) => error.includes("manifest omits candidate DES-001")));
  assert.ok(errors.some((error) => error.includes("confirmed candidate OBS-001 was not observed")));
  assert.ok(errors.some((error) => error.includes("unsafe independent artifact path")));
  assert.ok(
    errors.some((error) =>
      error.includes("rejected candidate DES-001 must not have final severity"),
    ),
  );
  assert.ok(errors.some((error) => error.includes("summary.confirmed")));
  assert.ok(errors.some((error) => error.includes("mergeGate must be fail")));
});

test("confirmation cannot weaken the runner-owned blocking policy", () => {
  const report = validReport();
  report.summary.blockingSeverities = ["low"];
  report.summary.mergeGate = "pass";
  report.summary.gateReasons = [];
  const errors = validateConfirmedReportSemantics(report, model, exploration, design, {
    ...identities,
    blockingSeverities: ["critical", "high"],
  });
  assert.ok(errors.some((error) => /runner-owned gate policy/i.test(error)));
  assert.ok(errors.some((error) => /mergeGate must be fail/i.test(error)));
});

function validReport() {
  return {
    schemaVersion: "0.1.0",
    runId: "confirm-run-001",
    outcome: "completed",
    featureModelId: "fm-confirm",
    provenance: {
      agent: "independent-reproducer",
      agentVersion: "0.1.0",
      featureModelSha256: "a".repeat(64),
      explorationReportSha256: identities.explorationSha256,
      designReportSha256: identities.designSha256,
      gitBase: "main",
      gitHead: "working-tree",
      artifactRoot: ".qa/generated/confirm-run-001",
      dataProfile: "disposable-local",
    },
    run: {
      mode: "change",
      startedAt: "2026-07-24T00:00:00.000Z",
      completedAt: "2026-07-24T00:05:00.000Z",
    },
    environment: {
      target: "Portcode preview",
      appMode: "mock",
      platform: "windows",
      browser: "chromium",
      viewportIds: ["desktop"],
      dataResetId: "reset-v1",
    },
    candidateManifest: [
      {
        candidateId: "OBS-001",
        source: "edge-case-explorer",
        sourceReportSha256: identities.explorationSha256,
      },
      {
        candidateId: "DES-001",
        source: "design-ux-auditor",
        sourceReportSha256: identities.designSha256,
      },
    ],
    verdicts: [
      {
        candidateId: "OBS-001",
        source: "edge-case-explorer",
        disposition: "confirmed",
        reasonCode: "reproduced",
        rationale: "Observed independently from reset",
        classification: "functional-defect",
        finalSeverity: "high",
        reach: "common",
        frequency: "always",
        preconditions: ["Idle"],
        steps: ["Start work"],
        expected: "Indicator appears",
        actual: "Indicator remains hidden",
        reproduction: {
          attempts: 2,
          observed: 2,
          resetBetweenAttempts: true,
          resetExceptionRationale: null,
        },
        oracleBasis: [
          { type: "explicit-requirement", locator: "REQ-001", expectation: "Show active work" },
        ],
        evidence: {
          screenshots: ["screenshots/obs-001.png"],
          trace: null,
          console: [],
          pageErrors: [],
          network: [],
        },
      },
      {
        candidateId: "DES-001",
        source: "design-ux-auditor",
        disposition: "rejected",
        reasonCode: "expected-behavior",
        rationale: "Existing pattern intentionally omits the decoration",
        classification: "missing-state-design",
        finalSeverity: null,
        reach: "common",
        frequency: "not-observed",
        preconditions: ["Idle"],
        steps: ["Open feature"],
        expected: "Matches established project pattern",
        actual: "Matches established project pattern",
        reproduction: {
          attempts: 1,
          observed: 0,
          resetBetweenAttempts: true,
          resetExceptionRationale: null,
        },
        oracleBasis: [
          { type: "existing-pattern", locator: "src/example.tsx", expectation: "No decoration" },
        ],
        evidence: {
          screenshots: ["screenshots/des-001-rejected.png"],
          trace: null,
          console: [],
          pageErrors: [],
          network: [],
        },
      },
    ],
    summary: {
      totalCandidates: 2,
      confirmed: 1,
      rejected: 1,
      inconclusive: 0,
      bySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
      blockingSeverities: ["critical", "high"],
      mergeGate: "fail",
      gateReasons: ["OBS-001 is confirmed high severity"],
    },
    blockers: [],
  };
}
