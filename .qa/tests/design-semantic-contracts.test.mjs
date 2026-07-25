import assert from "node:assert/strict";
import test from "node:test";

import { DESIGN_CATEGORIES, validateDesignAuditSemantics } from "../scripts/validate-contracts.mjs";

const model = {
  modelId: "fm-design",
  outcome: "ready",
  stateModel: { states: [{ id: "state-default" }] },
  edgeCaseCharter: { categories: {} },
};

test("blocked design audit does not require invented run details", () => {
  assert.deepEqual(
    validateDesignAuditSemantics({
      outcome: "blocked",
      blockers: [{ id: "BLK-001", reason: "App unavailable" }],
    }),
    [],
  );
});

test("valid design audit has complete categories, resolved references, evidence, and derived coverage", () => {
  assert.deepEqual(validateDesignAuditSemantics(validReport(), model), []);
});

test("design audit rejects missing categories, dangling state IDs, empty screenshots, and false totals", () => {
  const report = validReport();
  report.designStatePlan.pop();
  report.designStatePlan[0].sourceStateIds = ["state-missing"];
  report.inspectedStates[0].screenshots = [];
  report.coverage.inspected = 99;

  const errors = validateDesignAuditSemantics(report, model);
  assert.ok(errors.some((error) => error.includes("design plan omits category")));
  assert.ok(errors.some((error) => error.includes("unknown feature state")));
  assert.ok(errors.some((error) => error.includes("requires screenshot evidence")));
  assert.ok(errors.some((error) => error.includes("coverage.inspected")));
});

function validReport() {
  const plans = DESIGN_CATEGORIES.map((category, index) => ({
    id: `DS-${String(index + 1).padStart(3, "0")}`,
    category,
    sourceStateIds: ["state-default"],
    applicable: category === "default",
    rationale: category === "default" ? "Primary rendered state" : "Not applicable to fixture",
    expectedDesign: category === "default" ? "Content is legible" : "No reachable variant",
    evidenceBasis: [
      { type: "feature-state", locator: "state-default", expectation: "Readable state" },
    ],
  }));
  const inspectedStates = plans.map((plan) =>
    plan.applicable
      ? {
          planId: plan.id,
          status: "passed",
          viewportId: "desktop",
          theme: "dark",
          motionMode: "no-preference",
          steps: ["Open feature"],
          actual: "Content is legible",
          screenshots: ["screenshots/ds-001.png"],
          observationIds: [],
          blockerId: null,
          dispositionReason: null,
        }
      : {
          planId: plan.id,
          status: "not-applicable",
          viewportId: null,
          theme: null,
          motionMode: null,
          steps: [],
          actual: "Not reachable in fixture",
          screenshots: [],
          observationIds: [],
          blockerId: null,
          dispositionReason: "Not reachable in fixture",
        },
  );
  return {
    schemaVersion: "0.1.0",
    runId: "design-run-001",
    outcome: "completed",
    featureModelId: "fm-design",
    provenance: {
      agent: "design-ux-auditor",
      agentVersion: "0.1.0",
      featureModelSha256: "a".repeat(64),
      gitBase: "main",
      gitHead: "working-tree",
      artifactRoot: ".qa/generated/design-run-001",
      dataProfile: "disposable-local",
    },
    run: {
      mode: "change",
      startedAt: "2026-07-24T00:00:00.000Z",
      completedAt: "2026-07-24T00:01:00.000Z",
    },
    environment: {
      target: "Portcode preview",
      appMode: "mock",
      platform: "windows",
      browser: "chromium",
      viewports: [{ id: "desktop", width: 1280, height: 800 }],
      themes: ["dark"],
      motionModes: ["no-preference"],
    },
    designStatePlan: plans,
    inspectedStates,
    observations: [],
    coverage: {
      planned: DESIGN_CATEGORIES.length,
      applicable: 1,
      inspected: 1,
      passed: 1,
      observationsRecorded: 0,
      blocked: 0,
      notApplicable: DESIGN_CATEGORIES.length - 1,
      untestedRisks: [],
    },
    blockers: [],
  };
}
