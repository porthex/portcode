const CATEGORIES = [
  "input",
  "timing",
  "lifecycle",
  "interaction",
  "persistence",
  "layout",
  "accessibility",
  "neighboringRegression",
];

export function validateFeatureModelSemantics(model) {
  const errors = [];
  if (!model || typeof model !== "object") return ["feature model must be an object"];
  if (model.outcome === "blocked") {
    if (!Array.isArray(model.blockers) || model.blockers.length === 0) {
      errors.push("blocked feature model requires at least one blocker");
    }
    return errors;
  }
  if (model.outcome !== "ready") return ["feature model outcome must be ready or blocked"];

  const requirements = model.sourceSummary?.explicitRequirements ?? [];
  const states = model.stateModel?.states ?? [];
  const transitions = model.stateModel?.transitions ?? [];
  const behaviors = model.missingBehaviors ?? [];
  const designs = model.missingDesigns ?? [];

  checkUnique(requirements, "requirement", errors);
  checkUnique(states, "state", errors);
  checkUnique(transitions, "transition", errors);
  checkUnique(behaviors, "missing behavior", errors);
  checkUnique(designs, "missing design", errors);

  const requirementIds = new Set(requirements.map(({ id }) => id));
  const stateIds = new Set(states.map(({ id }) => id));
  const transitionIds = new Set(transitions.map(({ id }) => id));

  for (const transition of transitions) {
    if (!stateIds.has(transition.from)) {
      errors.push(`transition ${transition.id} references unknown source state ${transition.from}`);
    }
    if (!stateIds.has(transition.to)) {
      errors.push(`transition ${transition.id} references unknown destination state ${transition.to}`);
    }
    const failureState = transition.failure?.stateId;
    if (failureState && !stateIds.has(failureState)) {
      errors.push(`transition ${transition.id} failure references unknown state ${failureState}`);
    }
  }

  for (const omission of behaviors) {
    if (!String(omission.id).startsWith("MB-")) {
      errors.push(`missing behavior ID must start with MB-: ${omission.id}`);
    }
  }
  for (const omission of designs) {
    if (!String(omission.id).startsWith("MD-")) {
      errors.push(`missing design ID must start with MD-: ${omission.id}`);
    }
  }

  const cases = collectCases(model, errors);
  checkUnique(cases, "edge-case", errors);
  for (const edgeCase of cases) {
    checkReferences(edgeCase.coversRequirementIds, requirementIds, `edge case ${edgeCase.id} requirement`, errors);
    checkReferences(edgeCase.coversStateIds, stateIds, `edge case ${edgeCase.id} state`, errors);
    checkReferences(edgeCase.coversTransitionIds, transitionIds, `edge case ${edgeCase.id} transition`, errors);
  }

  const mustCases = cases.filter(({ priority }) => priority === "must");
  for (const requirement of requirements) {
    if (!mustCases.some((edgeCase) => edgeCase.coversRequirementIds?.includes(requirement.id))) {
      errors.push(`requirement ${requirement.id} is not covered by a must edge case`);
    }
  }
  for (const state of states.filter(({ risk }) => risk === "critical" || risk === "high")) {
    if (!mustCases.some((edgeCase) => edgeCase.coversStateIds?.includes(state.id))) {
      errors.push(`high-risk state ${state.id} is not covered by a must edge case`);
    }
  }

  const notApplicable = new Set(
    (model.coverageNotes?.notApplicable ?? []).map(({ category }) => category),
  );
  for (const category of CATEGORIES) {
    const categoryCases = model.edgeCaseCharter?.categories?.[category];
    if (!Array.isArray(categoryCases)) {
      errors.push(`edge-case category ${category} is missing`);
    } else if (categoryCases.length === 0 && !notApplicable.has(category)) {
      errors.push(`empty edge-case category ${category} requires a not-applicable reason`);
    }
  }

  return errors;
}

export function validateExplorationReportSemantics(report, model) {
  const errors = [];
  if (!report || typeof report !== "object") return ["exploration report must be an object"];
  if (report.outcome === "blocked") {
    if (!Array.isArray(report.blockers) || report.blockers.length === 0) {
      errors.push("blocked exploration report requires at least one blocker");
    }
    return errors;
  }
  if (report.outcome !== "completed") return ["exploration outcome must be completed or blocked"];
  if (!model || model.outcome !== "ready") {
    errors.push("completed exploration requires a ready feature model");
    return errors;
  }
  if (report.featureModelId !== model.modelId) {
    errors.push(`feature model identity mismatch: ${report.featureModelId} != ${model.modelId}`);
  }

  const modelCases = collectCases(model, errors);
  const modelCaseById = new Map(modelCases.map((edgeCase) => [edgeCase.id, edgeCase]));
  const plans = report.scenarioPlan ?? [];
  const executed = report.executedScenarios ?? [];
  const observations = report.observations ?? [];
  const blockers = report.blockers ?? [];

  checkUnique(plans, "scenario-plan case", errors, "caseId");
  checkUnique(executed, "executed scenario", errors, "caseId");
  checkUnique(observations, "observation", errors);
  checkUnique(blockers, "blocker", errors);

  const plannedIds = new Set(plans.map(({ caseId }) => caseId));
  const selectedIds = new Set(plans.filter(({ selected }) => selected).map(({ caseId }) => caseId));
  const observationIds = new Set(observations.map(({ id }) => id));
  const blockerIds = new Set(blockers.map(({ id }) => id));

  for (const plan of plans) {
    if (!modelCaseById.has(plan.caseId)) {
      errors.push(`scenario plan references unknown feature-model case ${plan.caseId}`);
    }
  }
  for (const edgeCase of modelCases) {
    if (!plannedIds.has(edgeCase.id)) errors.push(`scenario plan omits feature-model case ${edgeCase.id}`);
  }

  for (const scenario of executed) {
    const sourceCase = modelCaseById.get(scenario.caseId);
    if (scenario.source === "charter" && !sourceCase) {
      errors.push(`executed scenario references unknown feature-model case ${scenario.caseId}`);
    }
    if (scenario.source === "charter" && !selectedIds.has(scenario.caseId)) {
      errors.push(`executed scenario ${scenario.caseId} was not selected in the scenario plan`);
    }
    if (sourceCase && sourceCase.category !== scenario.category) {
      errors.push(`scenario ${scenario.caseId} category does not match the feature model`);
    }

    if (scenario.status === "observation-recorded") {
      if (!Array.isArray(scenario.observationIds) || scenario.observationIds.length === 0) {
        errors.push(`scenario ${scenario.caseId} requires observationIds`);
      }
      for (const id of scenario.observationIds ?? []) {
        if (!observationIds.has(id)) errors.push(`scenario ${scenario.caseId} references unknown observation ${id}`);
      }
    } else if ((scenario.observationIds ?? []).length > 0) {
      errors.push(`scenario ${scenario.caseId} has observations but status is ${scenario.status}`);
    }

    if (scenario.status === "blocked") {
      if (!scenario.blockerId || !blockerIds.has(scenario.blockerId)) {
        errors.push(`blocked scenario ${scenario.caseId} requires a valid blockerId`);
      }
    } else if (scenario.blockerId) {
      errors.push(`scenario ${scenario.caseId} has blockerId but status is ${scenario.status}`);
    }
    if (scenario.status === "not-applicable" && !scenario.dispositionReason) {
      errors.push(`not-applicable scenario ${scenario.caseId} requires dispositionReason`);
    }
    if (scenario.startedAt && scenario.completedAt && Date.parse(scenario.completedAt) < Date.parse(scenario.startedAt)) {
      errors.push(`scenario ${scenario.caseId} completed before it started`);
    }
  }

  const referencedObservations = new Set(executed.flatMap(({ observationIds = [] }) => observationIds));
  for (const observation of observations) {
    if (!referencedObservations.has(observation.id)) errors.push(`orphan observation ${observation.id}`);
    if (observation.reproduction?.observed > observation.reproduction?.attempts) {
      errors.push(`observation ${observation.id}: observed cannot exceed attempts`);
    }
    if (!hasEvidence(observation.evidence)) {
      errors.push(`observation ${observation.id} requires at least one evidence item`);
    }
    for (const artifactPath of evidencePaths(observation.evidence)) {
      if (!isPortableRelativePath(artifactPath)) {
        errors.push(`observation ${observation.id} has unsafe artifact path ${artifactPath}`);
      }
    }
    for (const caseId of observation.charterCaseIds ?? []) {
      if (!modelCaseById.has(caseId)) errors.push(`observation ${observation.id} references unknown charter case ${caseId}`);
    }
  }

  if (report.run?.startedAt && report.run?.completedAt && Date.parse(report.run.completedAt) < Date.parse(report.run.startedAt)) {
    errors.push("exploration run completed before it started");
  }

  validateCoverage(report, modelCases, plans, executed, observations, errors);
  return errors;
}

function collectCases(model, errors) {
  const cases = [];
  for (const category of CATEGORIES) {
    for (const edgeCase of model.edgeCaseCharter?.categories?.[category] ?? []) {
      cases.push({ ...edgeCase, category });
    }
  }
  if (cases.length === 0 && model.outcome === "ready") errors.push("ready feature model has no edge cases");
  return cases;
}

function validateCoverage(report, modelCases, plans, executed, observations, errors) {
  const coverage = report.coverage ?? {};
  const selected = plans.filter(({ selected }) => selected);
  const actual = {
    planned: modelCases.length,
    selected: selected.length,
    executed: executed.filter(({ status }) => status === "passed" || status === "observation-recorded").length,
    passed: executed.filter(({ status }) => status === "passed").length,
    observationsRecorded: observations.length,
    blocked: executed.filter(({ status }) => status === "blocked").length,
    notApplicable: executed.filter(({ status }) => status === "not-applicable").length,
  };
  for (const [key, value] of Object.entries(actual)) {
    if (coverage[key] !== value) errors.push(`coverage.${key} must be ${value}, received ${coverage[key]}`);
  }

  for (const category of CATEGORIES) {
    if (!coverage.byCategory?.[category]) {
      errors.push(`coverage.byCategory.${category} is missing`);
      continue;
    }
    const categoryCases = modelCases.filter((edgeCase) => edgeCase.category === category);
    const categoryPlans = plans.filter((plan) => modelCases.find((edgeCase) => edgeCase.id === plan.caseId)?.category === category);
    const categoryExecuted = executed.filter(({ category: value }) => value === category);
    const expected = {
      planned: categoryCases.length,
      selected: categoryPlans.filter(({ selected: value }) => value).length,
      executed: categoryExecuted.filter(({ status }) => status === "passed" || status === "observation-recorded").length,
      passed: categoryExecuted.filter(({ status }) => status === "passed").length,
      observationsRecorded: categoryExecuted.reduce((sum, item) => sum + (item.observationIds?.length ?? 0), 0),
      blocked: categoryExecuted.filter(({ status }) => status === "blocked").length,
      notApplicable: categoryExecuted.filter(({ status }) => status === "not-applicable").length,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (coverage.byCategory[category][key] !== value) {
        errors.push(`coverage.byCategory.${category}.${key} must be ${value}`);
      }
    }
  }
  const extraCategories = Object.keys(coverage.byCategory ?? {}).filter((key) => !CATEGORIES.includes(key));
  for (const category of extraCategories) errors.push(`unknown coverage category ${category}`);
}

function checkUnique(items, label, errors, key = "id") {
  const seen = new Set();
  for (const item of items) {
    const value = item?.[key];
    if (seen.has(value)) errors.push(`duplicate ${label} ID ${value}`);
    seen.add(value);
  }
}

function checkReferences(values = [], validIds, label, errors) {
  for (const value of values) {
    if (!validIds.has(value)) errors.push(`${label} references unknown ID ${value}`);
  }
}

function hasEvidence(evidence) {
  return Boolean(
    evidence &&
      ((evidence.screenshots?.length ?? 0) > 0 ||
        evidence.trace ||
        (evidence.console?.length ?? 0) > 0 ||
        (evidence.pageErrors?.length ?? 0) > 0 ||
        (evidence.network?.length ?? 0) > 0),
  );
}

function evidencePaths(evidence) {
  return [...(evidence?.screenshots ?? []), ...(evidence?.trace ? [evidence.trace] : [])];
}

function isPortableRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (/^(?:[a-zA-Z]:[\\/]|[\\/]{1,2})/.test(value)) return false;
  return !value.split(/[\\/]+/).includes("..");
}

const DESIGN_CATEGORIES = [
  "default", "hover", "focus", "pressed", "selected", "disabled", "loading",
  "empty", "error", "success", "partial", "unsaved", "offline", "stale",
  "overflow", "responsive", "overlay", "motion", "theme",
];

export function validateDesignAuditSemantics(report, model) {
  const errors = [];
  if (!report || typeof report !== "object") return ["design audit report must be an object"];
  if (report.outcome === "blocked") {
    if (!Array.isArray(report.blockers) || report.blockers.length === 0) {
      errors.push("blocked design audit requires at least one blocker");
    }
    return errors;
  }
  if (report.outcome !== "completed") return ["design audit outcome must be completed or blocked"];
  if (!model || model.outcome !== "ready") return ["completed design audit requires a ready feature model"];
  if (report.featureModelId !== model.modelId) errors.push("design audit feature model identity mismatch");

  const plans = report.designStatePlan ?? [];
  const inspected = report.inspectedStates ?? [];
  const observations = report.observations ?? [];
  const blockers = report.blockers ?? [];
  checkUnique(plans, "design plan", errors);
  checkUnique(observations, "design observation", errors);
  checkUnique(blockers, "design blocker", errors);

  const planById = new Map(plans.map((item) => [item.id, item]));
  const stateIds = new Set((model.stateModel?.states ?? []).map(({ id }) => id));
  const observationIds = new Set(observations.map(({ id }) => id));
  const blockerIds = new Set(blockers.map(({ id }) => id));
  const viewportIds = new Set((report.environment?.viewports ?? []).map(({ id }) => id));

  for (const category of DESIGN_CATEGORIES) {
    if (!plans.some((item) => item.category === category)) {
      errors.push(`design plan omits category ${category}`);
    }
  }
  for (const plan of plans) {
    for (const stateId of plan.sourceStateIds ?? []) {
      if (!stateIds.has(stateId)) errors.push(`design plan ${plan.id} references unknown feature state ${stateId}`);
    }
    const related = inspected.filter(({ planId }) => planId === plan.id);
    if (plan.applicable && related.length === 0) errors.push(`applicable design plan ${plan.id} was not inspected`);
    if (!plan.applicable && !related.some(({ status }) => status === "not-applicable")) {
      errors.push(`non-applicable design plan ${plan.id} lacks not-applicable disposition`);
    }
  }

  for (const item of inspected) {
    const plan = planById.get(item.planId);
    if (!plan) errors.push(`inspected state references unknown plan ${item.planId}`);
    if (item.viewportId && !viewportIds.has(item.viewportId)) {
      errors.push(`inspected state ${item.planId} references unknown viewport ${item.viewportId}`);
    }
    if ((item.status === "passed" || item.status === "observation-recorded") && (item.screenshots?.length ?? 0) === 0) {
      errors.push(`inspected state ${item.planId} requires screenshot evidence`);
    }
    for (const path of item.screenshots ?? []) {
      if (!isPortableRelativePath(path)) errors.push(`inspected state ${item.planId} has unsafe artifact path ${path}`);
    }
    if (item.status === "observation-recorded") {
      if ((item.observationIds?.length ?? 0) === 0) errors.push(`inspected state ${item.planId} requires observation IDs`);
      for (const id of item.observationIds ?? []) {
        if (!observationIds.has(id)) errors.push(`inspected state ${item.planId} references unknown observation ${id}`);
      }
    } else if ((item.observationIds?.length ?? 0) > 0) {
      errors.push(`inspected state ${item.planId} has observations with status ${item.status}`);
    }
    if (item.status === "blocked") {
      if (!item.blockerId || !blockerIds.has(item.blockerId)) errors.push(`blocked design state ${item.planId} requires valid blockerId`);
    } else if (item.blockerId) {
      errors.push(`design state ${item.planId} has blockerId with status ${item.status}`);
    }
    if (item.status === "not-applicable" && !item.dispositionReason) {
      errors.push(`not-applicable design state ${item.planId} requires dispositionReason`);
    }
  }

  const referenced = new Set(inspected.flatMap(({ observationIds = [] }) => observationIds));
  for (const observation of observations) {
    if (!referenced.has(observation.id)) errors.push(`orphan design observation ${observation.id}`);
    for (const planId of observation.planIds ?? []) {
      if (!planById.has(planId)) errors.push(`design observation ${observation.id} references unknown plan ${planId}`);
    }
    for (const viewportId of observation.viewportIds ?? []) {
      if (!viewportIds.has(viewportId)) errors.push(`design observation ${observation.id} references unknown viewport ${viewportId}`);
    }
    if ((observation.evidence?.screenshots?.length ?? 0) === 0) {
      errors.push(`design observation ${observation.id} requires screenshot evidence`);
    }
    for (const path of [
      ...(observation.evidence?.screenshots ?? []),
      ...(observation.evidence?.trace ? [observation.evidence.trace] : []),
    ]) {
      if (!isPortableRelativePath(path)) errors.push(`design observation ${observation.id} has unsafe artifact path ${path}`);
    }
  }

  const expectedCoverage = {
    planned: plans.length,
    applicable: plans.filter(({ applicable }) => applicable).length,
    inspected: inspected.filter(({ status }) => status === "passed" || status === "observation-recorded").length,
    passed: inspected.filter(({ status }) => status === "passed").length,
    observationsRecorded: observations.length,
    blocked: inspected.filter(({ status }) => status === "blocked").length,
    notApplicable: inspected.filter(({ status }) => status === "not-applicable").length,
  };
  for (const [key, value] of Object.entries(expectedCoverage)) {
    if (report.coverage?.[key] !== value) errors.push(`design coverage.${key} must be ${value}`);
  }
  if (report.run?.startedAt && report.run?.completedAt && Date.parse(report.run.completedAt) < Date.parse(report.run.startedAt)) {
    errors.push("design audit run completed before it started");
  }
  return errors;
}

export function validateConfirmedReportSemantics(
  report,
  model,
  explorationReport,
  designReport,
  identities = {},
) {
  const errors = [];
  if (!report || typeof report !== "object") return ["confirmation report must be an object"];
  if (report.outcome === "blocked") {
    if (!Array.isArray(report.blockers) || report.blockers.length === 0) {
      errors.push("blocked confirmation report requires at least one blocker");
    }
    return errors;
  }
  if (report.outcome !== "completed") return ["confirmation outcome must be completed or blocked"];
  if (!model || model.outcome !== "ready") return ["completed confirmation requires a ready feature model"];
  if (report.featureModelId !== model.modelId) errors.push("confirmation feature model identity mismatch");

  const candidates = [
    ...((explorationReport?.outcome === "completed" ? explorationReport.observations : []) ?? [])
      .map(({ id }) => ({ id, source: "edge-case-explorer", hash: identities.explorationSha256 })),
    ...((designReport?.outcome === "completed" ? designReport.observations : []) ?? [])
      .map(({ id }) => ({ id, source: "design-ux-auditor", hash: identities.designSha256 })),
  ];
  checkUnique(candidates, "source candidate", errors);

  const manifest = report.candidateManifest ?? [];
  const verdicts = report.verdicts ?? [];
  checkUnique(manifest, "candidate manifest", errors, "candidateId");
  checkUnique(verdicts, "candidate verdict", errors, "candidateId");
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const manifestById = new Map(manifest.map((item) => [item.candidateId, item]));
  const verdictById = new Map(verdicts.map((item) => [item.candidateId, item]));

  for (const candidate of candidates) {
    if (!manifestById.has(candidate.id)) errors.push(`manifest omits candidate ${candidate.id}`);
    if (!verdictById.has(candidate.id)) errors.push(`verdicts omit candidate ${candidate.id}`);
  }
  for (const item of manifest) {
    const candidate = candidateById.get(item.candidateId);
    if (!candidate) {
      errors.push(`manifest contains unknown candidate ${item.candidateId}`);
      continue;
    }
    if (item.source !== candidate.source) errors.push(`manifest candidate ${item.candidateId} has wrong source`);
    if (candidate.hash && item.sourceReportSha256 !== candidate.hash) {
      errors.push(`manifest candidate ${item.candidateId} has wrong source report hash`);
    }
  }
  if (identities.explorationSha256 && report.provenance?.explorationReportSha256 !== identities.explorationSha256) {
    errors.push("confirmation provenance has wrong exploration report hash");
  }
  if (identities.designSha256 && report.provenance?.designReportSha256 !== identities.designSha256) {
    errors.push("confirmation provenance has wrong design report hash");
  }

  for (const verdict of verdicts) {
    const candidate = candidateById.get(verdict.candidateId);
    if (!candidate) {
      errors.push(`verdict contains unknown candidate ${verdict.candidateId}`);
      continue;
    }
    if (verdict.source !== candidate.source) errors.push(`verdict candidate ${verdict.candidateId} has wrong source`);
    const reproduction = verdict.reproduction ?? {};
    if (reproduction.observed > reproduction.attempts) {
      errors.push(`candidate ${verdict.candidateId}: observed cannot exceed attempts`);
    }
    if (!reproduction.resetBetweenAttempts && !reproduction.resetExceptionRationale) {
      errors.push(`candidate ${verdict.candidateId} requires reset exception rationale`);
    }
    if (reproduction.resetBetweenAttempts && reproduction.resetExceptionRationale) {
      errors.push(`candidate ${verdict.candidateId} has unnecessary reset exception rationale`);
    }
    if (!hasEvidence(verdict.evidence)) {
      errors.push(`candidate ${verdict.candidateId} requires independent evidence`);
    }
    for (const artifactPath of evidencePaths(verdict.evidence)) {
      if (!isPortableRelativePath(artifactPath)) {
        errors.push(`candidate ${verdict.candidateId} has unsafe independent artifact path ${artifactPath}`);
      }
    }

    if (verdict.disposition === "confirmed") {
      if (reproduction.observed < 1) errors.push(`confirmed candidate ${verdict.candidateId} was not observed`);
      if (verdict.reasonCode !== "reproduced") errors.push(`confirmed candidate ${verdict.candidateId} must use reproduced reason`);
      if (!new Set(["critical", "high", "medium", "low"]).has(verdict.finalSeverity)) {
        errors.push(`confirmed candidate ${verdict.candidateId} requires final severity`);
      }
    } else if (verdict.disposition === "rejected") {
      if (verdict.finalSeverity !== null) errors.push(`rejected candidate ${verdict.candidateId} must not have final severity`);
      if (verdict.reasonCode === "reproduced") errors.push(`rejected candidate ${verdict.candidateId} cannot use reproduced reason`);
    } else if (verdict.disposition === "inconclusive") {
      if (verdict.finalSeverity !== null) errors.push(`inconclusive candidate ${verdict.candidateId} must not have final severity`);
      if (!["insufficient-evidence", "environment-blocked", "intermittent", "unsafe-to-reproduce"].includes(verdict.reasonCode)) {
        errors.push(`inconclusive candidate ${verdict.candidateId} has invalid reason`);
      }
    } else {
      errors.push(`candidate ${verdict.candidateId} has invalid disposition`);
    }
  }

  const confirmed = verdicts.filter(({ disposition }) => disposition === "confirmed");
  const expected = {
    totalCandidates: candidates.length,
    confirmed: confirmed.length,
    rejected: verdicts.filter(({ disposition }) => disposition === "rejected").length,
    inconclusive: verdicts.filter(({ disposition }) => disposition === "inconclusive").length,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (report.summary?.[key] !== value) errors.push(`summary.${key} must be ${value}`);
  }
  for (const severity of ["critical", "high", "medium", "low"]) {
    const value = confirmed.filter(({ finalSeverity }) => finalSeverity === severity).length;
    if (report.summary?.bySeverity?.[severity] !== value) errors.push(`summary.bySeverity.${severity} must be ${value}`);
  }

  const blocking = new Set(report.summary?.blockingSeverities ?? []);
  const blockingIds = confirmed
    .filter(({ finalSeverity }) => blocking.has(finalSeverity))
    .map(({ candidateId }) => candidateId);
  const inconclusiveIds = verdicts
    .filter(({ disposition }) => disposition === "inconclusive")
    .map(({ candidateId }) => candidateId);
  const expectedGate = blockingIds.length > 0 ? "fail" : inconclusiveIds.length > 0 ? "needs-review" : "pass";
  if (report.summary?.mergeGate !== expectedGate) {
    errors.push(`summary.mergeGate must be ${expectedGate}`);
  }
  if (expectedGate !== "pass" && (report.summary?.gateReasons?.length ?? 0) === 0) {
    errors.push(`summary.gateReasons required for ${expectedGate} gate`);
  }
  const gateReasonText = (report.summary?.gateReasons ?? []).join(" ");
  for (const id of expectedGate === "fail" ? blockingIds : inconclusiveIds) {
    if (!gateReasonText.includes(id)) errors.push(`summary.gateReasons omits candidate ${id}`);
  }
  if (report.run?.startedAt && report.run?.completedAt && Date.parse(report.run.completedAt) < Date.parse(report.run.startedAt)) {
    errors.push("confirmation run completed before it started");
  }
  return errors;
}

export { CATEGORIES, DESIGN_CATEGORIES };
