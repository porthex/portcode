import assert from "node:assert/strict";
import test from "node:test";

import {
  validateExplorationReportSemantics,
  validateFeatureModelSemantics,
} from "../scripts/validate-contracts.mjs";

test("blocked contracts are valid without invented ready-run fields", () => {
  assert.deepEqual(
    validateFeatureModelSemantics({
      schemaVersion: "0.2.0",
      modelId: "fm-blocked",
      outcome: "blocked",
      blockers: [{ id: "BLK-001", area: "original-task", reason: "Original task missing" }],
    }),
    [],
  );

  assert.deepEqual(
    validateExplorationReportSemantics({
      schemaVersion: "0.2.0",
      runId: "run-blocked",
      outcome: "blocked",
      featureModelId: "fm-blocked",
      blockers: [{ id: "BLK-001", area: "feature-model", reason: "Feature model blocked", affectedCaseIds: [] }],
    }),
    [],
  );
});

test("feature model rejects duplicate IDs, dangling transitions, wrong omission prefixes, and uncovered requirements", () => {
  const model = validFeatureModel();
  model.stateModel.states.push({ ...model.stateModel.states[0] });
  model.stateModel.transitions[0].to = "missing-state";
  model.missingBehaviors.push({ ...validOmission("MD-001") });
  model.edgeCaseCharter.categories.input[0].coversRequirementIds = [];

  const errors = validateFeatureModelSemantics(model);
  assert.ok(errors.some((error) => error.includes("duplicate state ID")));
  assert.ok(errors.some((error) => error.includes("unknown destination state")));
  assert.ok(errors.some((error) => error.includes("missing behavior ID must start with MB-")));
  assert.ok(errors.some((error) => error.includes("requirement REQ-001 is not covered")));
});

test("exploration report rejects dangling cases, orphan observations, contradictory totals, impossible reproduction, and empty evidence", () => {
  const model = validFeatureModel();
  const report = validExplorationReport();
  report.scenarioPlan[0].caseId = "EC-UNKNOWN-999";
  report.executedScenarios[0].observationIds = ["OBS-999"];
  report.coverage.executed = 99;
  report.observations[0].reproduction.observed = 3;
  report.observations[0].evidence = {
    screenshots: [],
    trace: null,
    console: [],
    pageErrors: [],
    network: [],
  };

  const errors = validateExplorationReportSemantics(report, model);
  assert.ok(errors.some((error) => error.includes("unknown feature-model case")));
  assert.ok(errors.some((error) => error.includes("unknown observation OBS-999")));
  assert.ok(errors.some((error) => error.includes("coverage.executed")));
  assert.ok(errors.some((error) => error.includes("observed cannot exceed attempts")));
  assert.ok(errors.some((error) => error.includes("at least one evidence item")));
});

test("ready feature and completed exploration fixtures are semantically valid", () => {
  const model = validFeatureModel();
  const report = validExplorationReport();
  assert.deepEqual(validateFeatureModelSemantics(model), []);
  assert.deepEqual(validateExplorationReportSemantics(report, model), []);
});

function validFeatureModel() {
  return {
    schemaVersion: "0.2.0",
    modelId: "fm-work-activity",
    outcome: "ready",
    provenance: {
      agent: "feature-completeness",
      agentVersion: "0.2.0",
      taskSha256: "a".repeat(64),
      gitBase: "main",
      gitHead: "working-tree",
    },
    blockers: [],
    feature: {
      name: "Work activity",
      goal: "Show current work state",
      entryPoints: ["Chat"],
      affectedAreas: ["Message"],
    },
    sourceSummary: {
      explicitRequirements: [
        {
          id: "REQ-001",
          text: "Show active work",
          source: { type: "original-task", locator: "task:1" },
        },
      ],
      inferredConventions: [],
      unknowns: [],
    },
    stateModel: {
      states: [
        {
          id: "state-idle",
          name: "Idle",
          risk: "low",
          entryCondition: "No active work",
          visibleDesign: "No live indicator",
          availableActions: ["start"],
          exitConditions: ["work starts"],
        },
        {
          id: "state-running",
          name: "Running",
          risk: "high",
          entryCondition: "Work starts",
          visibleDesign: "Live indicator",
          availableActions: ["stop"],
          exitConditions: ["work completes"],
        },
      ],
      transitions: [
        {
          id: "transition-start",
          from: "state-idle",
          action: "start",
          to: "state-running",
          expectedFeedback: "Live indicator appears",
          failure: { kind: "modeled", stateId: "state-idle", rationale: "Start can fail" },
        },
      ],
      invariants: ["Only active work appears live"],
    },
    missingBehaviors: [],
    missingDesigns: [],
    edgeCaseCharter: {
      categories: {
        input: [validEdgeCase()],
        timing: [],
        lifecycle: [],
        interaction: [],
        persistence: [],
        layout: [],
        accessibility: [],
        neighboringRegression: [],
      },
      highestRiskSequences: [
        {
          id: "SEQ-001",
          name: "Start then stop",
          steps: ["Start", "Stop"],
          risk: "Stale live indicator",
          expected: "Returns to idle",
        },
      ],
    },
    coverageNotes: {
      notApplicable: [
        { category: "timing", reason: "Fixture scope" },
        { category: "lifecycle", reason: "Fixture scope" },
        { category: "interaction", reason: "Fixture scope" },
        { category: "persistence", reason: "Fixture scope" },
        { category: "layout", reason: "Fixture scope" },
        { category: "accessibility", reason: "Fixture scope" },
        { category: "neighboringRegression", reason: "Fixture scope" },
      ],
      blocked: [],
    },
  };
}

function validEdgeCase() {
  return {
    id: "EC-INPUT-001",
    scenario: "Start work",
    why: "Primary behavior",
    priority: "must",
    oracle: "Live indicator is visible",
    coversRequirementIds: ["REQ-001"],
    coversStateIds: ["state-running"],
    coversTransitionIds: ["transition-start"],
  };
}

function validOmission(id) {
  return {
    id,
    title: "Missing state",
    classification: "reachable-state",
    basis: "State model",
    trigger: "Trigger",
    expected: "Expected",
    risk: "medium",
    confidence: "medium",
  };
}

function validExplorationReport() {
  return {
    schemaVersion: "0.2.0",
    runId: "run-001",
    outcome: "completed",
    featureModelId: "fm-work-activity",
    provenance: {
      agent: "edge-case-explorer",
      agentVersion: "0.2.0",
      featureModelSha256: "b".repeat(64),
      gitBase: "main",
      gitHead: "working-tree",
      artifactRoot: ".qa/generated/run-001",
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
      url: "http://localhost:1420",
      platform: "windows",
      browser: "chromium",
      viewport: { width: 1280, height: 800 },
      reducedMotion: "no-preference",
    },
    instrumentation: {
      console: "active",
      pageErrors: "active",
      network: "active",
      trace: "active",
      baselineEvents: [],
    },
    scenarioPlan: [
      {
        caseId: "EC-INPUT-001",
        selected: true,
        selectionReason: "Must case",
      },
    ],
    executedScenarios: [
      {
        caseId: "EC-INPUT-001",
        source: "charter",
        category: "input",
        status: "observation-recorded",
        risk: "Primary behavior",
        oracle: "Live indicator is visible",
        steps: ["Start work"],
        expected: "Live indicator is visible",
        actual: "Indicator remains hidden",
        startedAt: "2026-07-24T00:00:10.000Z",
        completedAt: "2026-07-24T00:00:20.000Z",
        observationIds: ["OBS-001"],
        blockerId: null,
        dispositionReason: null,
        evidenceRefs: ["OBS-001"],
      },
    ],
    observations: [
      {
        id: "OBS-001",
        title: "Live indicator hidden",
        classification: "functional-defect-candidate",
        provisionalImpact: "primary-flow-blocked",
        confidence: "high",
        charterCaseIds: ["EC-INPUT-001"],
        preconditions: ["Idle"],
        steps: ["Start work"],
        expected: "Live indicator appears",
        actual: "Indicator remains hidden",
        reproduction: { attempts: 2, observed: 2, resetBetweenAttempts: true },
        evidence: {
          screenshots: ["screenshots/obs-001.png"],
          trace: null,
          console: [],
          pageErrors: [],
          network: [],
        },
        status: "observed-unverified",
      },
    ],
    coverage: {
      planned: 1,
      selected: 1,
      executed: 1,
      passed: 0,
      observationsRecorded: 1,
      blocked: 0,
      notApplicable: 0,
      byCategory: {
        input: { planned: 1, selected: 1, executed: 1, passed: 0, observationsRecorded: 1, blocked: 0, notApplicable: 0 },
        timing: { planned: 0, selected: 0, executed: 0, passed: 0, observationsRecorded: 0, blocked: 0, notApplicable: 0 },
        lifecycle: { planned: 0, selected: 0, executed: 0, passed: 0, observationsRecorded: 0, blocked: 0, notApplicable: 0 },
        interaction: { planned: 0, selected: 0, executed: 0, passed: 0, observationsRecorded: 0, blocked: 0, notApplicable: 0 },
        persistence: { planned: 0, selected: 0, executed: 0, passed: 0, observationsRecorded: 0, blocked: 0, notApplicable: 0 },
        layout: { planned: 0, selected: 0, executed: 0, passed: 0, observationsRecorded: 0, blocked: 0, notApplicable: 0 },
        accessibility: { planned: 0, selected: 0, executed: 0, passed: 0, observationsRecorded: 0, blocked: 0, notApplicable: 0 },
        neighboringRegression: { planned: 0, selected: 0, executed: 0, passed: 0, observationsRecorded: 0, blocked: 0, notApplicable: 0 },
      },
      untestedRisks: [],
    },
    blockers: [],
  };
}
