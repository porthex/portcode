import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  validateConfirmedReportSemantics,
  validateDesignAuditSemantics,
  validateExplorationReportSemantics,
  validateFeatureBriefSemantics,
  validateFeatureModelSemantics,
  validateRiskRegisterSemantics,
  validateRiskVerificationSemantics,
  validateUseCaseScoutSemantics,
} from "./validate-contracts.mjs";

export const PREPARATION_STAGES = [
  {
    id: "real-world-use-case-scout",
    agent: ".qa/agents/real-world-use-case-scout.md",
    schema: ".qa/schemas/use-case-scout.schema.json",
    report: "use-case-scout.json",
  },
  {
    id: "pre-implementation-risk-architect",
    agent: ".qa/agents/pre-implementation-risk-architect.md",
    schema: ".qa/schemas/risk-register.schema.json",
    report: "risk-register.json",
  },
  {
    id: "feature-brief-synthesizer",
    agent: ".qa/agents/feature-brief-synthesizer.md",
    schema: ".qa/schemas/feature-brief.schema.json",
    report: "feature-brief.json",
  },
];

export const VERIFICATION_STAGES = [
  {
    id: "feature-completeness",
    agent: ".qa/agents/feature-completeness.md",
    schema: ".qa/schemas/feature-model.schema.json",
    report: "feature-model.json",
  },
  {
    id: "edge-case-explorer",
    agent: ".qa/agents/edge-case-explorer.md",
    schema: ".qa/schemas/exploration-report.schema.json",
    report: "exploration-report.json",
  },
  {
    id: "design-ux-auditor",
    agent: ".qa/agents/design-ux-auditor.md",
    schema: ".qa/schemas/design-audit-report.schema.json",
    report: "design-audit-report.json",
  },
  {
    id: "post-implementation-risk-verifier",
    agent: ".qa/agents/post-implementation-risk-verifier.md",
    schema: ".qa/schemas/risk-verification.schema.json",
    report: "risk-verification.json",
  },
  {
    id: "independent-reproducer",
    agent: ".qa/agents/independent-reproducer.md",
    schema: ".qa/schemas/confirmed-report.schema.json",
    report: "confirmed-report.json",
  },
];

// Backward-compatible export for existing consumers; the default runtime phase is verification.
export const STAGES = VERIFICATION_STAGES;

export function assertSafeRunId(runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || runId === "." || runId === "..") {
    throw new Error("--resume-run must be a safe run ID, not a path");
  }
  return runId;
}

export function reusableStageCheckpoint(manifest, stageId) {
  const checkpoint = manifest.stages?.find(({ id }) => id === stageId);
  return checkpoint?.validationStatus === "validated" && checkpoint.outcome !== "blocked" ? checkpoint : null;
}

export function pruneInvalidStageCheckpoints(manifest) {
  const stages = manifest.stages ?? [];
  const firstInvalid = stages.findIndex(({ id }) => !reusableStageCheckpoint(manifest, id));
  if (firstInvalid === -1) return [];
  return stages.splice(firstInvalid).map(({ id }) => id);
}

export function resumeProvenanceMismatches(manifest, expected) {
  return [
    "runId", "phase", "mode", "provider", "taskSha256", "gitBase", "gitHead",
    "gitDiffSha256", "gitStatusSha256", "workingTreeSha256",
  ].filter((key) => manifest[key] !== expected[key]);
}

export function nextStageAttempt(entries) {
  const attempts = entries
    .map((entry) => /^attempt-(\d+)$/.exec(entry)?.[1])
    .filter(Boolean)
    .map(Number);
  return attempts.length ? Math.max(...attempts) + 1 : 1;
}

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = resolve(dirname(scriptPath), "../..");

function extractJsonObjects(output) {
  const candidates = [];
  for (let start = 0; start < output.length; start += 1) {
    if (output[start] !== "{") continue;
    const end = findObjectEnd(output, start);
    if (end === -1) continue;
    try {
      const value = JSON.parse(output.slice(start, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        candidates.push(value);
        start = end;
      }
    } catch {
      // This brace belonged to non-JSON diagnostic output.
    }
  }
  return candidates;
}

export function extractJsonObject(output) {
  const candidates = extractJsonObjects(output);
  if (candidates.length !== 1) {
    throw new Error(`Agent output must contain exactly one JSON object; found ${candidates.length}`);
  }
  return candidates[0];
}

export async function extractValidatedJsonObject(output, validate) {
  const candidates = extractJsonObjects(output);
  const valid = [];
  for (const candidate of candidates) if (await validate(candidate)) valid.push(candidate);
  if (valid.length !== 1) {
    throw new Error(`Agent output must contain exactly one schema-valid JSON report; found ${valid.length} of ${candidates.length} parseable objects`);
  }
  return valid[0];
}

function findObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function buildStagePrompt({
  stage,
  projectRoot,
  runRoot,
  taskPath,
  configPath,
  inputPaths,
  outputPath,
  evidenceRoot = resolve(runRoot, "evidence", stage.id),
}) {
  const format = (value) => value.replaceAll("\\", "/");
  return [
    `Execute the project-local QA agent '${stage.id}'.`,
    `Project root: ${format(projectRoot)}`,
    `Agent definition: ${format(resolve(projectRoot, stage.agent))}`,
    `Original task: ${format(taskPath)}`,
    `Git diff: ${format(resolve(runRoot, "inputs/git-diff.patch"))}`,
    `Git status: ${format(resolve(runRoot, "inputs/git-status.txt"))}`,
    `Run identity manifest: ${format(resolve(runRoot, "run-manifest.json"))}`,
    `QA runtime configuration: ${format(configPath)}`,
    `Run artifact root: ${format(runRoot)}`,
    `Stage evidence root: ${format(evidenceRoot)}`,
    `Write every screenshot and trace created by this stage under that stage evidence root and report its path relative to the run artifact root. Do not cite runner inputs, reports, or evidence from another stage.`,
    `Required output contract: ${format(resolve(projectRoot, stage.schema))}`,
    `Runner-owned output destination: ${format(outputPath)}`,
    "Input reports:",
    ...(inputPaths.length ? inputPaths.map((path) => `- ${format(path)}`) : ["- none"]),
    "",
    "Read the agent definition first and obey it exactly.",
    "Use only the supplied Original task for request scope. Do not inspect other task files, prior generated runs/reports, hidden evaluation artifacts, or Git history.",
    "Copy every runner-owned provenance value required by the output schema exactly from the run manifest and supplied input reports, including workingTreeSha256; never invent or recompute policy or identity fields.",
    "Operate only against the safe target declared in the QA runtime configuration.",
    "Application source is read-only. Do not edit source, tests, snapshots, configuration, task text, or QA definitions.",
    "Do not write the report file yourself; the runner captures and validates your final response.",
    "Return exactly one JSON object conforming to the required output contract, with no Markdown fences or surrounding prose.",
  ].join("\n");
}

export function compareSourceSnapshots(before, after) {
  const added = [...after.keys()].filter((path) => !before.has(path)).sort();
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();
  const modified = [...before.keys()]
    .filter((path) => after.has(path) && before.get(path) !== after.get(path))
    .sort();
  return { added, modified, removed };
}

export function hashSourceSnapshot(snapshot) {
  const identity = [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right));
  return sha256(JSON.stringify(identity));
}

export function validateStageProvenance(stageId, report, expected) {
  if (report.outcome === "blocked") return [];
  const errors = [];
  const provenance = report.provenance ?? {};
  const requireEqual = (field, value) => {
    if (value !== undefined && provenance[field] !== value) {
      errors.push(`${stageId} provenance.${field} does not match the runner input`);
    }
  };
  requireEqual("gitBase", expected.gitBase);
  requireEqual("gitHead", expected.gitHead);
  requireEqual("workingTreeSha256", expected.workingTreeSha256);
  const runtimeStages = ["edge-case-explorer", "design-ux-auditor", "post-implementation-risk-verifier", "independent-reproducer"];
  if (runtimeStages.includes(stageId)) {
    requireEqual("artifactRoot", expected.application?.artifactRoot);
    requireEqual("dataProfile", expected.application?.dataProfile);
    if (report.run && report.run.mode !== expected.mode) errors.push(`${stageId} run.mode does not match the runner mode`);
    if (report.environment) {
      if (report.environment.target !== expected.application?.target) errors.push(`${stageId} environment.target does not match the runner target`);
      if (report.environment.appMode !== expected.application?.appMode) errors.push(`${stageId} environment.appMode does not match the runner app mode`);
    }
    if (stageId === "independent-reproducer" && report.environment?.dataResetId !== expected.application?.resetIdentity) {
      errors.push("independent-reproducer environment.dataResetId does not match the runner reset identity");
    }
  }
  if (["real-world-use-case-scout", "pre-implementation-risk-architect", "feature-completeness"].includes(stageId)) {
    requireEqual("taskSha256", expected.taskSha256);
  }
  if (["pre-implementation-risk-architect", "feature-brief-synthesizer"].includes(stageId)) {
    requireEqual("useCaseScoutSha256", expected.useCaseScoutSha256);
  }
  if (stageId === "feature-brief-synthesizer") {
    requireEqual("riskRegisterSha256", expected.riskRegisterSha256);
  }
  if (["feature-completeness", "edge-case-explorer", "design-ux-auditor", "post-implementation-risk-verifier", "independent-reproducer"].includes(stageId)) {
    requireEqual("featureBriefSha256", expected.featureBriefSha256);
    requireEqual("riskRegisterSha256", expected.riskRegisterSha256);
  }
  if (["edge-case-explorer", "design-ux-auditor", "post-implementation-risk-verifier", "independent-reproducer"].includes(stageId)) {
    requireEqual("featureModelSha256", expected.featureModelSha256);
  }
  if (stageId === "independent-reproducer") {
    requireEqual("explorationReportSha256", expected.explorationSha256);
    requireEqual("designReportSha256", expected.designSha256);
    requireEqual("riskVerificationSha256", expected.riskVerificationSha256);
  }
  return errors;
}

export function deriveCoverageGate(riskVerification, findingGate = "needs-review", exploration = null) {
  if (findingGate === "fail") return "fail";
  if (!riskVerification || riskVerification.outcome !== "completed") return "needs-review";
  if ((riskVerification.verdicts ?? []).some(({ status }) => status === "blocked")) return "needs-review";
  if (exploration) {
    if (exploration.outcome !== "completed") return "needs-review";
    if ((exploration.coverage?.blocked ?? 0) > 0) return "needs-review";
  }
  return findingGate;
}

export function deriveFindingGate(confirmationReport, blockingSeverities) {
  if (!confirmationReport || confirmationReport.outcome !== "completed") {
    return { gate: "needs-review", blockingCandidateIds: [] };
  }
  const policy = new Set(blockingSeverities ?? []);
  const blockingCandidateIds = (confirmationReport.verdicts ?? [])
    .filter(({ disposition, finalSeverity }) => disposition === "confirmed" && policy.has(finalSeverity))
    .map(({ candidateId }) => candidateId)
    .sort();
  const hasInconclusive = (confirmationReport.verdicts ?? []).some(({ disposition }) => disposition === "inconclusive");
  return {
    gate: blockingCandidateIds.length ? "fail" : hasInconclusive ? "needs-review" : "pass",
    blockingCandidateIds,
  };
}

function evidencePaths(value, paths = new Set(), objectPath = []) {
  if (!value || typeof value !== "object") return paths;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...objectPath, key];
    if (key === "screenshots" && Array.isArray(child)) {
      for (const path of child) if (typeof path === "string" && path) paths.add(path);
    } else if (
      key === "trace" &&
      typeof child === "string" &&
      child &&
      !(childPath.length === 2 && childPath[0] === "instrumentation")
    ) {
      paths.add(child);
    } else if (typeof child === "object") {
      evidencePaths(child, paths, childPath);
    }
  }
  return paths;
}

async function inspectEvidenceArtifacts(report, runRoot, stageId = null, attempt = null) {
  const errors = [];
  const artifacts = [];
  const stageEvidenceRoot = stageId
    ? resolve(runRoot, "evidence", stageId, ...(attempt == null ? [] : [`attempt-${attempt}`]))
    : runRoot;
  await mkdir(stageEvidenceRoot, { recursive: true });
  const canonicalEvidenceRoot = await realpath(stageEvidenceRoot);
  for (const declaredPath of evidencePaths(report)) {
    const candidate = isAbsolute(declaredPath) ? resolve(declaredPath) : resolve(runRoot, declaredPath);
    const relativeCandidate = relative(stageEvidenceRoot, candidate);
    if (relativeCandidate === ".." || relativeCandidate.startsWith(`..${sep}`) || isAbsolute(relativeCandidate)) {
      errors.push(`evidence artifact is not owned by stage ${stageId ?? "validation"}: ${declaredPath}`);
      continue;
    }
    try {
      const info = await lstat(candidate);
      if (!info.isFile()) {
        errors.push(`evidence artifact is not a regular file: ${declaredPath}`);
        continue;
      }
      const canonicalCandidate = await realpath(candidate);
      const relativeCanonical = relative(canonicalEvidenceRoot, canonicalCandidate);
      if (relativeCanonical === ".." || relativeCanonical.startsWith(`..${sep}`) || isAbsolute(relativeCanonical)) {
        errors.push(`evidence artifact resolves outside the stage evidence root: ${declaredPath}`);
        continue;
      }
      artifacts.push({
        path: normalizePath(relative(runRoot, candidate)),
        sha256: sha256(await readFile(candidate)),
      });
    } catch (error) {
      if (error?.code === "ENOENT") errors.push(`evidence artifact does not exist: ${declaredPath}`);
      else errors.push(`unable to validate evidence artifact ${declaredPath}: ${error.message}`);
    }
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  return { errors, artifacts };
}

export async function validateEvidenceArtifacts(report, runRoot, stageId = null, attempt = null) {
  return (await inspectEvidenceArtifacts(report, runRoot, stageId, attempt)).errors;
}

async function listArtifactFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(path);
    }
  }
  await visit(root);
  return files;
}

async function captureArtifactSnapshot(runRoot, extraPaths = []) {
  const paths = new Set([...(await listArtifactFiles(runRoot)), ...extraPaths.map((path) => resolve(path))]);
  const snapshot = new Map();
  for (const path of [...paths].sort()) {
    const info = await lstat(path);
    snapshot.set(path, {
      kind: info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other",
      sha256: info.isFile() ? sha256(await readFile(path)) : null,
    });
  }
  return snapshot;
}

async function assertRunnerArtifactsUnchanged(before, runRoot, stageEvidenceRoot) {
  const after = await captureArtifactSnapshot(runRoot);
  const errors = [];
  for (const [path, identity] of before) {
    try {
      const info = await lstat(path);
      const current = {
        kind: info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other",
        sha256: info.isFile() ? sha256(await readFile(path)) : null,
      };
      if (current.kind !== identity.kind || current.sha256 !== identity.sha256) errors.push(`modified runner-owned artifact ${path}`);
    } catch (error) {
      if (error?.code === "ENOENT") errors.push(`removed runner-owned artifact ${path}`);
      else throw error;
    }
  }
  for (const path of after.keys()) {
    if (before.has(path)) continue;
    const relativeEvidence = relative(stageEvidenceRoot, path);
    if (relativeEvidence === ".." || relativeEvidence.startsWith(`..${sep}`) || isAbsolute(relativeEvidence)) {
      errors.push(`created artifact outside the stage evidence root ${path}`);
    }
  }
  if (errors.length) throw new Error(`provider changed runner-owned artifacts:\n- ${errors.join("\n- ")}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const projectRoot = resolve(options.projectRoot ?? defaultProjectRoot);
  const configPath = resolve(projectRoot, options.config ?? ".qa/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const providerName = options.provider ?? config.defaultProvider;
  if (!config.providers[providerName]) throw new Error(`Unknown QA provider: ${providerName}`);
  if (options.mode !== "change") throw new Error("--mode currently supports change only; full-repository coverage is not implemented");
  const phase = options.phase ?? "verify";
  if (!new Set(["prepare", "verify"]).has(phase)) throw new Error("--phase must be prepare or verify");
  const taskPath = resolve(projectRoot, requireOption(options.task, "--task is required"));
  const task = await readFile(taskPath, "utf8");
  if (!task.trim()) throw new Error("Task file is empty");
  const selectedStages = phase === "prepare" ? PREPARATION_STAGES : VERIFICATION_STAGES;

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      phase,
      mode: options.mode,
      provider: providerName,
      task: normalizePath(taskPath),
      preparation: options.preparation ? normalizePath(resolve(projectRoot, options.preparation)) : null,
      stages: selectedStages.map(({ id }) => id),
      app: { started: false, target: config.application.target },
    }, null, 2)}\n`);
    return 0;
  }

  const runId = options.resumeRun ? assertSafeRunId(options.resumeRun) : createRunId();
  const runRoot = resolve(projectRoot, config.artifacts.root, runId);
  const inputRoot = resolve(runRoot, "inputs");
  const reportRoot = resolve(runRoot, "reports");
  const rawRoot = resolve(runRoot, "raw");
  const promptRoot = resolve(runRoot, "prompts");
  await Promise.all([inputRoot, reportRoot, rawRoot, promptRoot].map((path) => mkdir(path, { recursive: true })));
  const copiedTaskPath = resolve(inputRoot, "task.md");
  const git = await captureGitContext(projectRoot);
  const sourceBaseline = await captureSourceSnapshot(projectRoot, config.artifacts.root);
  const workingTreeSha256 = hashSourceSnapshot(sourceBaseline);
  let manifest;
  if (options.resumeRun) {
    manifest = JSON.parse(await readFile(resolve(runRoot, "run-manifest.json"), "utf8"));
    if (!new Set(["error", "blocked"]).has(manifest.status)) {
      throw new Error(`Cannot resume run with status ${manifest.status}`);
    }
    const expected = {
      runId,
      phase,
      mode: options.mode,
      provider: providerName,
      taskSha256: sha256(task),
      gitBase: git.base,
      gitHead: git.head,
      gitDiffSha256: sha256(git.diff),
      gitStatusSha256: sha256(git.status),
      workingTreeSha256,
    };
    const mismatches = resumeProvenanceMismatches(manifest, expected);
    if (mismatches.length) throw new Error(`Cannot resume run with changed provenance: ${mismatches.join(", ")}`);
    const copiedTask = await readFile(copiedTaskPath, "utf8");
    if (sha256(copiedTask) !== manifest.taskSha256) throw new Error("Cannot resume run: copied task provenance changed");
    const prunedStages = pruneInvalidStageCheckpoints(manifest);
    manifest.recoveries ??= [];
    manifest.recoveries.push({ resumedAt: new Date().toISOString(), prunedStages });
    manifest.status = "running";
    delete manifest.completedAt;
    delete manifest.error;
    delete manifest.findingGate;
    delete manifest.coverageGate;
    delete manifest.mergeGate;
  } else {
    await copyFile(taskPath, copiedTaskPath);
    await writeFile(resolve(inputRoot, "git-diff.patch"), git.diff, "utf8");
    await writeFile(resolve(inputRoot, "git-status.txt"), git.status, "utf8");
    manifest = {
      version: 3,
      runId,
      phase,
      mode: options.mode,
      provider: providerName,
      startedAt: new Date().toISOString(),
      taskSha256: sha256(task),
      gitBase: git.base,
      gitHead: git.head,
      gitDiffSha256: sha256(git.diff),
      gitStatusSha256: sha256(git.status),
      workingTreeSha256,
      application: {
        target: config.application.target,
        appMode: config.application.appMode,
        artifactRoot: normalizePath(runRoot),
        dataProfile: config.application.profileIdentifier ?? config.application.appMode,
        resetIdentity: sha256(config.application.resetProcedure ?? ""),
      },
      status: "running",
      stages: [],
    };
  }
  await writeJson(resolve(runRoot, "run-manifest.json"), manifest);

  const context = { config, configPath, copiedTaskPath, manifest, originalTask: task, projectRoot, providerName, promptRoot, rawRoot, reportRoot, runRoot, sourceBaseline };
  try {
    if (phase === "prepare") return await runPreparationPhase(context);
    return await runVerificationPhase(context, options.preparation);
  } catch (error) {
    manifest.status = "error";
    manifest.completedAt = new Date().toISOString();
    manifest.error = error instanceof Error ? error.message : String(error);
    await writeJson(resolve(runRoot, "run-manifest.json"), manifest);
    throw error;
  }
}

async function runPreparationPhase(context) {
  const { manifest, originalTask, reportRoot, runRoot } = context;
  const reports = { originalTask };
  reports.scout = await runOrLoadStage({ ...context, stage: PREPARATION_STAGES[0], inputPaths: [] });
  validateSemantic("real-world-use-case-scout", reports);
  validateProvenanceOrThrow("real-world-use-case-scout", reports.scout, manifest);
  if (reports.scout.outcome === "blocked") return finishBlocked(manifest, runRoot, "Use-case research blocked");
  await sealStageCheckpoint(context, "real-world-use-case-scout");
  const scoutPath = resolve(reportRoot, PREPARATION_STAGES[0].report);
  const useCaseScoutSha256 = sha256(await readFile(scoutPath));

  reports.risks = await runOrLoadStage({ ...context, stage: PREPARATION_STAGES[1], inputPaths: [scoutPath] });
  validateSemantic("pre-implementation-risk-architect", reports);
  validateProvenanceOrThrow("pre-implementation-risk-architect", reports.risks, { ...manifest, useCaseScoutSha256 });
  if (reports.risks.outcome === "blocked") return finishBlocked(manifest, runRoot, "Pre-implementation risk analysis blocked");
  await sealStageCheckpoint(context, "pre-implementation-risk-architect");
  const riskPath = resolve(reportRoot, PREPARATION_STAGES[1].report);
  const riskRegisterSha256 = sha256(await readFile(riskPath));

  reports.brief = await runOrLoadStage({ ...context, stage: PREPARATION_STAGES[2], inputPaths: [scoutPath, riskPath] });
  validateSemantic("feature-brief-synthesizer", reports);
  validateProvenanceOrThrow("feature-brief-synthesizer", reports.brief, {
    ...manifest, useCaseScoutSha256, riskRegisterSha256,
  });
  if (reports.brief.outcome === "blocked") return finishBlocked(manifest, runRoot, "Feature brief synthesis blocked");
  await sealStageCheckpoint(context, "feature-brief-synthesizer");
  const briefPath = resolve(reportRoot, PREPARATION_STAGES[2].report);
  const featureBriefSha256 = sha256(await readFile(briefPath));

  manifest.status = "prepared";
  manifest.completedAt = new Date().toISOString();
  manifest.preparation = {
    useCaseScoutSha256,
    riskRegisterSha256,
    featureBriefSha256,
    builderBrief: normalizePath(relative(context.projectRoot, briefPath)),
  };
  await writeJson(resolve(runRoot, "run-manifest.json"), manifest);
  process.stdout.write(`${JSON.stringify({
    runId: manifest.runId,
    preparationRoot: normalizePath(runRoot),
    featureBrief: normalizePath(briefPath),
    riskRegister: normalizePath(riskPath),
    next: `Build from the feature brief, then run --phase verify --preparation ${normalizePath(runRoot)}`,
  }, null, 2)}\n`);
  return 0;
}

async function loadPreparation(context, preparationOption, taskSha256) {
  const { projectRoot, config } = context;
  const preparationRoot = resolve(projectRoot, requireOption(preparationOption, "--preparation is required for --phase verify"));
  const manifest = JSON.parse(await readFile(resolve(preparationRoot, "run-manifest.json"), "utf8"));
  if (manifest.phase !== "prepare" || manifest.status !== "prepared") throw new Error("Preparation must be a completed prepare-phase run");
  if (manifest.taskSha256 !== taskSha256) throw new Error("Preparation task hash does not match the verification task");
  const scoutPath = resolve(preparationRoot, "reports", PREPARATION_STAGES[0].report);
  const riskPath = resolve(preparationRoot, "reports", PREPARATION_STAGES[1].report);
  const briefPath = resolve(preparationRoot, "reports", PREPARATION_STAGES[2].report);
  const [scoutBytes, riskBytes, briefBytes] = await Promise.all([readFile(scoutPath), readFile(riskPath), readFile(briefPath)]);
  const hashes = {
    useCaseScoutSha256: sha256(scoutBytes),
    riskRegisterSha256: sha256(riskBytes),
    featureBriefSha256: sha256(briefBytes),
  };
  for (const [key, value] of Object.entries(hashes)) {
    if (manifest.preparation?.[key] !== value) throw new Error(`Preparation ${key} failed integrity validation`);
  }
  const reports = {
    originalTask: context.originalTask,
    scout: JSON.parse(scoutBytes.toString("utf8")),
    risks: JSON.parse(riskBytes.toString("utf8")),
    brief: JSON.parse(briefBytes.toString("utf8")),
  };
  await Promise.all([
    validateJsonSchema(config, resolve(projectRoot, PREPARATION_STAGES[0].schema), scoutPath, projectRoot),
    validateJsonSchema(config, resolve(projectRoot, PREPARATION_STAGES[1].schema), riskPath, projectRoot),
    validateJsonSchema(config, resolve(projectRoot, PREPARATION_STAGES[2].schema), briefPath, projectRoot),
  ]);
  const provenanceErrors = [
    ...validateStageProvenance("real-world-use-case-scout", reports.scout, manifest),
    ...validateStageProvenance("pre-implementation-risk-architect", reports.risks, { ...manifest, useCaseScoutSha256: hashes.useCaseScoutSha256 }),
    ...validateStageProvenance("feature-brief-synthesizer", reports.brief, { ...manifest, ...hashes }),
  ];
  const semanticErrors = [
    ...validateUseCaseScoutSemantics(reports.scout, reports.originalTask),
    ...validateRiskRegisterSemantics(reports.risks, reports.scout),
    ...validateFeatureBriefSemantics(reports.brief, reports.scout, reports.risks, reports.originalTask),
  ];
  const preparationErrors = [...provenanceErrors, ...semanticErrors];
  if (preparationErrors.length) throw new Error(`Preparation validation failed:\n- ${preparationErrors.join("\n- ")}`);
  return { preparationRoot, scoutPath, riskPath, briefPath, reports, hashes };
}

async function runVerificationPhase(context, preparationOption) {
  const { manifest, projectRoot, reportRoot, runRoot } = context;
  const preparation = await loadPreparation(context, preparationOption, manifest.taskSha256);
  manifest.preparationRun = normalizePath(preparation.preparationRoot);
  manifest.preparation = preparation.hashes;
  await writeJson(resolve(runRoot, "run-manifest.json"), manifest);
  const reports = {
    ...preparation.reports,
    identities: {
      ...preparation.hashes,
      blockingSeverities: [...(context.config.gate?.blockingSeverities ?? [])],
    },
  };
  let appProcess = null;
  try {
    reports.feature = await runOrLoadStage({
      ...context,
      stage: VERIFICATION_STAGES[0],
      inputPaths: [preparation.briefPath, preparation.riskPath],
    });
    validateSemantic("feature-completeness", reports);
    validateProvenanceOrThrow("feature-completeness", reports.feature, {
      ...manifest, ...reports.identities,
    });
    if (reports.feature.outcome === "blocked") return finishBlocked(manifest, runRoot, "Feature model blocked");
    await sealStageCheckpoint(context, "feature-completeness");
    const featurePath = resolve(reportRoot, VERIFICATION_STAGES[0].report);
    reports.identities.featureModelSha256 = sha256(await readFile(featurePath));

    appProcess = await startApplication(context.config.application, projectRoot, runRoot);
    reports.exploration = await runOrLoadStage({
      ...context, stage: VERIFICATION_STAGES[1],
      inputPaths: [featurePath, preparation.briefPath, preparation.riskPath],
    });
    validateSemantic("edge-case-explorer", reports);
    validateProvenanceOrThrow("edge-case-explorer", reports.exploration, { ...manifest, ...reports.identities });
    if (reports.exploration.outcome === "blocked") return finishBlocked(manifest, runRoot, "Edge exploration blocked");
    await sealStageCheckpoint(context, "edge-case-explorer");

    reports.design = await runOrLoadStage({
      ...context, stage: VERIFICATION_STAGES[2],
      inputPaths: [featurePath, preparation.briefPath, preparation.riskPath],
    });
    validateSemantic("design-ux-auditor", reports);
    validateProvenanceOrThrow("design-ux-auditor", reports.design, { ...manifest, ...reports.identities });
    if (reports.design.outcome === "blocked") return finishBlocked(manifest, runRoot, "Design audit blocked");
    await sealStageCheckpoint(context, "design-ux-auditor");

    reports.riskVerification = await runOrLoadStage({
      ...context, stage: VERIFICATION_STAGES[3],
      inputPaths: [featurePath, preparation.briefPath, preparation.riskPath],
    });
    validateSemantic("post-implementation-risk-verifier", reports);
    validateProvenanceOrThrow("post-implementation-risk-verifier", reports.riskVerification, {
      ...manifest, ...reports.identities,
    });
    if (reports.riskVerification.outcome === "blocked") return finishBlocked(manifest, runRoot, "Frozen-risk verification blocked");
    await sealStageCheckpoint(context, "post-implementation-risk-verifier");

    const explorationPath = resolve(reportRoot, VERIFICATION_STAGES[1].report);
    const designPath = resolve(reportRoot, VERIFICATION_STAGES[2].report);
    const riskVerificationPath = resolve(reportRoot, VERIFICATION_STAGES[3].report);
    reports.identities.explorationSha256 = sha256(await readFile(explorationPath));
    reports.identities.designSha256 = sha256(await readFile(designPath));
    reports.identities.riskVerificationSha256 = sha256(await readFile(riskVerificationPath));

    reports.confirmed = await runOrLoadStage({
      ...context, stage: VERIFICATION_STAGES[4],
      inputPaths: [featurePath, explorationPath, designPath, riskVerificationPath, preparation.briefPath, preparation.riskPath],
    });
    validateSemantic("independent-reproducer", reports);
    validateProvenanceOrThrow("independent-reproducer", reports.confirmed, {
      ...manifest, ...reports.identities,
    });
    if (reports.confirmed.outcome === "blocked") {
      return finishBlocked(manifest, runRoot, `Independent reproduction blocked: ${reports.confirmed.blockers?.map(({ reason }) => reason).join("; ") || "unspecified blocker"}`);
    }
    await sealStageCheckpoint(context, "independent-reproducer");

    const configuredBlockingSeverities = context.config.gate?.blockingSeverities ?? [];
    const reportedBlockingSeverities = reports.confirmed.summary?.blockingSeverities ?? [];
    if (JSON.stringify([...reportedBlockingSeverities].sort()) !== JSON.stringify([...configuredBlockingSeverities].sort())) {
      throw new Error("independent-reproducer summary.blockingSeverities does not match the runner-owned gate policy");
    }
    const finding = deriveFindingGate(reports.confirmed, configuredBlockingSeverities);
    const findingGate = finding.gate;
    if (reports.confirmed.summary?.mergeGate !== findingGate) {
      throw new Error("independent-reproducer summary.mergeGate does not match the runner-derived finding gate");
    }
    manifest.status = "completed";
    manifest.completedAt = new Date().toISOString();
    manifest.findingGate = findingGate;
    manifest.blockingCandidateIds = finding.blockingCandidateIds;
    manifest.coverageGate = deriveCoverageGate(reports.riskVerification, "pass", reports.exploration);
    manifest.mergeGate = findingGate === "fail"
      ? "fail"
      : findingGate === "needs-review" || manifest.coverageGate !== "pass"
        ? "needs-review"
        : "pass";
    await writeJson(resolve(runRoot, "run-manifest.json"), manifest);
    process.stdout.write(`${JSON.stringify({ runId: manifest.runId, runRoot: normalizePath(runRoot), findingGate, coverageGate: manifest.coverageGate, mergeGate: manifest.mergeGate }, null, 2)}\n`);
    return manifest.mergeGate === "pass" ? 0 : 1;
  } finally {
    if (appProcess) await stopApplication(appProcess);
  }
}

async function runOrLoadStage(context) {
  const { stage, config, manifest, projectRoot, reportRoot, runRoot } = context;
  const checkpoint = reusableStageCheckpoint(manifest, stage.id);
  if (!checkpoint) return runStage(context);
  const outputPath = resolve(reportRoot, stage.report);
  const bytes = await readFile(outputPath);
  if (sha256(bytes) !== checkpoint.reportSha256) throw new Error(`Cannot resume run: ${stage.id} report hash changed`);
  await validateJsonSchema(config, resolve(projectRoot, stage.schema), outputPath, projectRoot);
  const report = JSON.parse(bytes.toString("utf8"));
  const evidenceInspection = await inspectEvidenceArtifacts(report, runRoot, stage.id, checkpoint.attempt);
  if (evidenceInspection.errors.length) {
    throw new Error(`Cannot resume run: ${stage.id} evidence validation failed:\n- ${evidenceInspection.errors.join("\n- ")}`);
  }
  if (JSON.stringify(evidenceInspection.artifacts) !== JSON.stringify(checkpoint.evidenceArtifacts ?? [])) {
    throw new Error(`Cannot resume run: ${stage.id} evidence manifest changed`);
  }
  return report;
}

async function sealStageCheckpoint(context, stageId) {
  const checkpoint = context.manifest.stages?.find(({ id }) => id === stageId);
  if (!checkpoint || checkpoint.validationStatus !== "report-ready") return;
  checkpoint.validationStatus = "validated";
  checkpoint.validatedAt = new Date().toISOString();
  await writeJson(resolve(context.runRoot, "run-manifest.json"), context.manifest);
}

async function runStage(context) {
  const {
    stage, config, configPath, copiedTaskPath, inputPaths, manifest, projectRoot,
    providerName, promptRoot, rawRoot, reportRoot, runRoot, sourceBaseline,
  } = context;
  const assertSourceIdentity = async () => {
    const current = await captureSourceSnapshot(projectRoot, config.artifacts.root);
    const changes = compareSourceSnapshots(sourceBaseline, current);
    if (changes.added.length || changes.modified.length || changes.removed.length) {
      throw new Error(`QA agent ${stage.id} modified source: ${JSON.stringify(changes)}`);
    }
    if (hashSourceSnapshot(current) !== manifest.workingTreeSha256) {
      throw new Error(`QA agent ${stage.id} changed the runner-owned working-tree identity`);
    }
  };
  await assertSourceIdentity();
  try {
    const outputPath = resolve(reportRoot, stage.report);
    const stageEvidenceRoot = resolve(runRoot, "evidence", stage.id);
    await mkdir(stageEvidenceRoot, { recursive: true });
    const attempt = nextStageAttempt(await readdir(stageEvidenceRoot));
    const evidenceRoot = resolve(stageEvidenceRoot, `attempt-${attempt}`);
    await mkdir(evidenceRoot, { recursive: true });
    const prompt = buildStagePrompt({
      stage,
      projectRoot,
      runRoot,
      taskPath: copiedTaskPath,
      configPath,
      inputPaths,
      outputPath,
      evidenceRoot,
    });
    const promptPath = resolve(promptRoot, `${stage.id}.attempt-${attempt}.txt`);
    await writeFile(promptPath, prompt, "utf8");
    const protectedArtifacts = await captureArtifactSnapshot(runRoot, [copiedTaskPath, configPath, ...inputPaths]);
    const startedAt = new Date().toISOString();
    let raw;
    try {
      raw = await invokeProvider(config.providers[providerName], prompt, projectRoot);
    } finally {
      await assertRunnerArtifactsUnchanged(protectedArtifacts, runRoot, evidenceRoot);
    }
    await writeFile(resolve(rawRoot, `${stage.id}.attempt-${attempt}.stdout.txt`), raw.stdout, "utf8");
    await writeFile(resolve(rawRoot, `${stage.id}.attempt-${attempt}.stderr.txt`), raw.stderr, "utf8");
    await writeJson(resolve(rawRoot, `${stage.id}.attempt-${attempt}.process.json`), {
      code: raw.code,
      timedOut: raw.timedOut === true,
      spawnError: raw.spawnError === true,
    });
    if (raw.timedOut) throw new Error(`Agent provider timed out after ${config.providers[providerName].timeoutMs}ms`);
    if (raw.spawnError || raw.code !== 0) throw new Error(`Agent provider exited ${raw.code ?? "before start"}: ${raw.stderr || raw.stdout}`);
    let candidateIndex = 0;
    const report = await extractValidatedJsonObject(raw.stdout, async (candidate) => {
      candidateIndex += 1;
      const candidatePath = resolve(rawRoot, `${stage.id}.attempt-${attempt}.candidate-${candidateIndex}.json`);
      await writeJson(candidatePath, candidate);
      try {
        await validateJsonSchema(config, resolve(projectRoot, stage.schema), candidatePath, projectRoot);
        return true;
      } catch {
        return false;
      }
    });
    await writeJson(outputPath, report);
    await validateJsonSchema(config, resolve(projectRoot, stage.schema), outputPath, projectRoot);
    const evidenceInspection = await inspectEvidenceArtifacts(report, runRoot, stage.id, attempt);
    if (evidenceInspection.errors.length) {
      throw new Error(`${stage.id} evidence validation failed:\n- ${evidenceInspection.errors.join("\n- ")}`);
    }
    manifest.stages = (manifest.stages ?? []).filter(({ id }) => id !== stage.id);
    manifest.stages.push({
      id: stage.id,
      attempt,
      validationStatus: "report-ready",
      startedAt,
      completedAt: new Date().toISOString(),
      outcome: report.outcome,
      report: normalizePath(relative(projectRoot, outputPath)),
      reportSha256: sha256(await readFile(outputPath)),
      evidenceArtifacts: evidenceInspection.artifacts,
    });
    await writeJson(resolve(runRoot, "run-manifest.json"), manifest);
    return report;
  } finally {
    await assertSourceIdentity();
  }
}

function validateSemantic(stageId, reports) {
  let errors;
  if (stageId === "real-world-use-case-scout") errors = validateUseCaseScoutSemantics(reports.scout, reports.originalTask);
  else if (stageId === "pre-implementation-risk-architect") errors = validateRiskRegisterSemantics(reports.risks, reports.scout);
  else if (stageId === "feature-brief-synthesizer") errors = validateFeatureBriefSemantics(reports.brief, reports.scout, reports.risks, reports.originalTask);
  else if (stageId === "feature-completeness") errors = validateFeatureModelSemantics(reports.feature, reports.brief);
  else if (stageId === "edge-case-explorer") errors = validateExplorationReportSemantics(reports.exploration, reports.feature);
  else if (stageId === "design-ux-auditor") errors = validateDesignAuditSemantics(reports.design, reports.feature);
  else if (stageId === "post-implementation-risk-verifier") errors = validateRiskVerificationSemantics(reports.riskVerification, reports.risks);
  else errors = validateConfirmedReportSemantics(
    reports.confirmed,
    reports.feature,
    reports.exploration,
    reports.design,
    reports.riskVerification,
    reports.identities,
  );
  if (errors.length) throw new Error(`${stageId} semantic validation failed:\n- ${errors.join("\n- ")}`);
}

function validateProvenanceOrThrow(stageId, report, expected) {
  const errors = validateStageProvenance(stageId, report, expected);
  if (errors.length) throw new Error(`${stageId} provenance validation failed:\n- ${errors.join("\n- ")}`);
}

async function invokeProvider(provider, prompt, projectRoot) {
  const args = provider.args.map((value) => value === "{{prompt}}" ? prompt : value);
  const allowedEnvironment = [
    "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE",
    "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "TERM", "LANG",
    "HERMES_HOME", "HERMES_REAL_HOME",
  ];
  const environment = Object.fromEntries(allowedEnvironment.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  let result;
  try {
    result = await runProcess(provider.command, args, {
      cwd: projectRoot,
      timeoutMs: provider.timeoutMs,
      shell: false,
      env: environment,
      killTree: true,
      captureTimeout: true,
    });
  } catch (error) {
    return { code: null, stdout: "", stderr: error.message, spawnError: true, timedOut: false };
  }
  return result;
}

async function validateJsonSchema(config, schemaPath, documentPath, projectRoot) {
  const script = resolve(projectRoot, ".qa/scripts/validate-json-schema.py");
  const result = await runProcess(config.validation.pythonCommand, [script, schemaPath, documentPath], {
    cwd: projectRoot,
    timeoutMs: 60_000,
    shell: false,
  });
  if (result.code !== 0) throw new Error(`JSON Schema validation failed:\n${result.stderr || result.stdout}`);
}

export function resolveApplicationCommand(command, projectRoot) {
  if (!command.includes("/") && !command.includes("\\")) return command;
  return isAbsolute(command) ? command : resolve(projectRoot, command);
}

async function startApplication(application, projectRoot, runRoot) {
  const logPath = resolve(runRoot, "app.log");
  const command = resolveApplicationCommand(application.command, projectRoot);
  const processHandle = spawn(command, application.args, {
    cwd: projectRoot,
    env: { ...process.env, PORTCODE_QA_RUN: "1" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  const append = async (chunk) => {
    log += chunk.toString();
    await writeFile(logPath, log, "utf8");
  };
  processHandle.stdout.on("data", append);
  processHandle.stderr.on("data", append);
  try {
    await waitForReady(application.readinessUrl, application.startupTimeoutMs, processHandle);
    return processHandle;
  } catch (error) {
    await stopApplication(processHandle);
    throw error;
  }
}

async function waitForReady(url, timeoutMs, processHandle) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Application exited before readiness with code ${processHandle.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Retry until the explicit deadline.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Application did not become ready at ${url} within ${timeoutMs}ms`);
}

async function stopApplication(processHandle) {
  if (processHandle.exitCode !== null) return;
  if (process.platform === "win32" && processHandle.pid) {
    await runProcess("taskkill", ["/pid", String(processHandle.pid), "/t", "/f"], {
      cwd: defaultProjectRoot,
      timeoutMs: 15_000,
      shell: false,
    }).catch(() => {});
  } else {
    processHandle.kill("SIGTERM");
  }
}

async function captureGitContext(projectRoot) {
  const [base, head, status, diff] = await Promise.all([
    runGit(["merge-base", "HEAD", "main"], projectRoot).catch(() => runGit(["rev-parse", "HEAD"], projectRoot)),
    runGit(["rev-parse", "HEAD"], projectRoot),
    runGit(["status", "--short", "--untracked-files=all"], projectRoot),
    runGit(["diff", "--no-ext-diff", "--binary", "HEAD", "--", ".", ":(exclude).qa/**"], projectRoot),
  ]);
  const applicationStatus = status.split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.slice(3).replaceAll("\\", "/").startsWith(".qa/"))
    .join("\n");
  return { base: base.trim(), head: head.trim(), status: applicationStatus, diff };
}

async function captureSourceSnapshot(projectRoot, artifactRoot) {
  const result = await runProcess("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: projectRoot,
    timeoutMs: 60_000,
    shell: false,
  });
  if (result.code !== 0) throw new Error(`Unable to enumerate source files: ${result.stderr}`);
  const excluded = normalizePath(artifactRoot).replace(/\/$/, "") + "/";
  const paths = result.stdout.split("\0").filter(Boolean).filter((path) => !normalizePath(path).startsWith(excluded));
  const snapshot = new Map();
  await Promise.all(paths.map(async (path) => {
    try {
      const absolutePath = resolve(projectRoot, path);
      const info = await lstat(absolutePath);
      const identity = info.isSymbolicLink()
        ? `symlink:${info.mode}:${await readlink(absolutePath)}`
        : info.isFile()
          ? `file:${info.mode}:${sha256(await readFile(absolutePath))}`
          : `other:${info.mode}`;
      snapshot.set(normalizePath(path), identity);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }));
  return snapshot;
}

async function runGit(args, cwd) {
  const result = await runProcess("git", args, { cwd, timeoutMs: 60_000, shell: false });
  if (result.code !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function runProcess(command, args, { cwd, timeoutMs, shell, env = process.env, killTree = false, captureTimeout = false }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      if (killTree && process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
      if (!captureTimeout) reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

async function finishBlocked(manifest, runRoot, reason) {
  manifest.status = "blocked";
  manifest.completedAt = new Date().toISOString();
  manifest.mergeGate = "needs-review";
  manifest.blockedReason = reason;
  await writeJson(resolve(runRoot, "run-manifest.json"), manifest);
  process.stdout.write(`${JSON.stringify({ runId: manifest.runId, runRoot: normalizePath(runRoot), mergeGate: "needs-review", reason }, null, 2)}\n`);
  return 2;
}

function parseArguments(args) {
  const options = { mode: "change", dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument.startsWith("--")) {
      const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[key] = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function requireOption(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function createRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizePath(value) {
  return value.split(sep).join("/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`QA runner error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
