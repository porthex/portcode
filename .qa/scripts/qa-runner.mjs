import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  validateConfirmedReportSemantics,
  validateDesignAuditSemantics,
  validateExplorationReportSemantics,
  validateFeatureModelSemantics,
} from "./validate-contracts.mjs";

export const STAGES = [
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
    id: "independent-reproducer",
    agent: ".qa/agents/independent-reproducer.md",
    schema: ".qa/schemas/confirmed-report.schema.json",
    report: "confirmed-report.json",
  },
];

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = resolve(dirname(scriptPath), "../..");

export function extractJsonObject(output) {
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
  if (candidates.length !== 1) {
    throw new Error(`Agent output must contain exactly one JSON object; found ${candidates.length}`);
  }
  return candidates[0];
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
    `Required output contract: ${format(resolve(projectRoot, stage.schema))}`,
    `Runner-owned output destination: ${format(outputPath)}`,
    "Input reports:",
    ...(inputPaths.length ? inputPaths.map((path) => `- ${format(path)}`) : ["- none"]),
    "",
    "Read the agent definition first and obey it exactly.",
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
  if (stageId === "feature-completeness") requireEqual("taskSha256", expected.taskSha256);
  if (["edge-case-explorer", "design-ux-auditor", "independent-reproducer"].includes(stageId)) {
    requireEqual("featureModelSha256", expected.featureModelSha256);
  }
  if (stageId === "independent-reproducer") {
    requireEqual("explorationReportSha256", expected.explorationSha256);
    requireEqual("designReportSha256", expected.designSha256);
  }
  return errors;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const projectRoot = resolve(options.projectRoot ?? defaultProjectRoot);
  const configPath = resolve(projectRoot, options.config ?? ".qa/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const providerName = options.provider ?? config.defaultProvider;
  if (!config.providers[providerName]) throw new Error(`Unknown QA provider: ${providerName}`);
  const taskPath = resolve(projectRoot, requireOption(options.task, "--task is required"));
  const task = await readFile(taskPath, "utf8");
  if (!task.trim()) throw new Error("Task file is empty");
  if (!new Set(["change", "full"]).has(options.mode)) throw new Error("--mode must be change or full");

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      mode: options.mode,
      provider: providerName,
      task: normalizePath(taskPath),
      stages: STAGES.map(({ id }) => id),
      app: { started: false, target: config.application.target },
    }, null, 2)}\n`);
    return 0;
  }

  const runId = createRunId();
  const runRoot = resolve(projectRoot, config.artifacts.root, runId);
  const inputRoot = resolve(runRoot, "inputs");
  const reportRoot = resolve(runRoot, "reports");
  const rawRoot = resolve(runRoot, "raw");
  const promptRoot = resolve(runRoot, "prompts");
  await Promise.all([inputRoot, reportRoot, rawRoot, promptRoot].map((path) => mkdir(path, { recursive: true })));
  const copiedTaskPath = resolve(inputRoot, "task.md");
  await copyFile(taskPath, copiedTaskPath);

  const git = await captureGitContext(projectRoot);
  await writeFile(resolve(inputRoot, "git-diff.patch"), git.diff, "utf8");
  await writeFile(resolve(inputRoot, "git-status.txt"), git.status, "utf8");
  const sourceBaseline = await captureSourceSnapshot(projectRoot, config.artifacts.root);
  const manifest = {
    version: 1,
    runId,
    mode: options.mode,
    provider: providerName,
    startedAt: new Date().toISOString(),
    taskSha256: sha256(task),
    gitBase: git.base,
    gitHead: git.head,
    status: "running",
    stages: [],
  };
  await writeJson(resolve(runRoot, "run-manifest.json"), manifest);

  let appProcess = null;
  const reports = {};
  try {
    reports.feature = await runStage({
      stage: STAGES[0], config, configPath, copiedTaskPath, inputPaths: [], manifest,
      projectRoot, providerName, promptRoot, rawRoot, reportRoot, runRoot, sourceBaseline,
    });
    validateSemantic("feature-completeness", reports);
    validateProvenanceOrThrow("feature-completeness", reports.feature, {
      taskSha256: manifest.taskSha256,
      gitBase: manifest.gitBase,
      gitHead: manifest.gitHead,
    });
    if (reports.feature.outcome === "blocked") return await finishBlocked(manifest, runRoot, "Feature model blocked");
    reports.identities = {
      featureModelSha256: sha256(await readFile(resolve(reportRoot, STAGES[0].report))),
    };

    appProcess = await startApplication(config.application, projectRoot, runRoot);

    reports.exploration = await runStage({
      stage: STAGES[1], config, configPath, copiedTaskPath,
      inputPaths: [resolve(reportRoot, STAGES[0].report)], manifest,
      projectRoot, providerName, promptRoot, rawRoot, reportRoot, runRoot, sourceBaseline,
    });
    validateSemantic("edge-case-explorer", reports);
    validateProvenanceOrThrow("edge-case-explorer", reports.exploration, {
      ...reports.identities,
      gitBase: manifest.gitBase,
      gitHead: manifest.gitHead,
    });

    reports.design = await runStage({
      stage: STAGES[2], config, configPath, copiedTaskPath,
      inputPaths: [resolve(reportRoot, STAGES[0].report)], manifest,
      projectRoot, providerName, promptRoot, rawRoot, reportRoot, runRoot, sourceBaseline,
    });
    validateSemantic("design-ux-auditor", reports);
    validateProvenanceOrThrow("design-ux-auditor", reports.design, {
      ...reports.identities,
      gitBase: manifest.gitBase,
      gitHead: manifest.gitHead,
    });

    if (reports.exploration.outcome === "blocked" || reports.design.outcome === "blocked") {
      return await finishBlocked(manifest, runRoot, "Exploration or design audit blocked");
    }

    const explorationBytes = await readFile(resolve(reportRoot, STAGES[1].report));
    const designBytes = await readFile(resolve(reportRoot, STAGES[2].report));
    reports.identities = {
      ...reports.identities,
      explorationSha256: sha256(explorationBytes),
      designSha256: sha256(designBytes),
    };
    reports.confirmed = await runStage({
      stage: STAGES[3], config, configPath, copiedTaskPath,
      inputPaths: STAGES.slice(0, 3).map(({ report }) => resolve(reportRoot, report)), manifest,
      projectRoot, providerName, promptRoot, rawRoot, reportRoot, runRoot, sourceBaseline,
    });
    validateSemantic("independent-reproducer", reports);
    validateProvenanceOrThrow("independent-reproducer", reports.confirmed, {
      ...reports.identities,
      gitBase: manifest.gitBase,
      gitHead: manifest.gitHead,
    });

    manifest.status = "completed";
    manifest.completedAt = new Date().toISOString();
    manifest.mergeGate = reports.confirmed.summary?.mergeGate ?? "needs-review";
    await writeJson(resolve(runRoot, "run-manifest.json"), manifest);
    process.stdout.write(`${JSON.stringify({ runId, runRoot: normalizePath(runRoot), mergeGate: manifest.mergeGate }, null, 2)}\n`);
    return manifest.mergeGate === "pass" ? 0 : manifest.mergeGate === "fail" ? 1 : 2;
  } catch (error) {
    manifest.status = "error";
    manifest.completedAt = new Date().toISOString();
    manifest.error = error instanceof Error ? error.message : String(error);
    await writeJson(resolve(runRoot, "run-manifest.json"), manifest);
    throw error;
  } finally {
    if (appProcess) await stopApplication(appProcess);
  }
}

async function runStage(context) {
  const {
    stage, config, configPath, copiedTaskPath, inputPaths, manifest, projectRoot,
    providerName, promptRoot, rawRoot, reportRoot, runRoot, sourceBaseline,
  } = context;
  const outputPath = resolve(reportRoot, stage.report);
  const prompt = buildStagePrompt({
    stage,
    projectRoot,
    runRoot,
    taskPath: copiedTaskPath,
    configPath,
    inputPaths,
    outputPath,
  });
  const promptPath = resolve(promptRoot, `${stage.id}.txt`);
  await writeFile(promptPath, prompt, "utf8");
  const startedAt = new Date().toISOString();
  const raw = await invokeProvider(config.providers[providerName], prompt, projectRoot);
  await writeFile(resolve(rawRoot, `${stage.id}.stdout.txt`), raw.stdout, "utf8");
  await writeFile(resolve(rawRoot, `${stage.id}.stderr.txt`), raw.stderr, "utf8");
  const report = extractJsonObject(raw.stdout);
  await writeJson(outputPath, report);
  await validateJsonSchema(config, resolve(projectRoot, stage.schema), outputPath, projectRoot);

  const sourceAfter = await captureSourceSnapshot(projectRoot, config.artifacts.root);
  const changes = compareSourceSnapshots(sourceBaseline, sourceAfter);
  if (changes.added.length || changes.modified.length || changes.removed.length) {
    throw new Error(`QA agent ${stage.id} modified source: ${JSON.stringify(changes)}`);
  }
  manifest.stages.push({
    id: stage.id,
    startedAt,
    completedAt: new Date().toISOString(),
    outcome: report.outcome,
    report: normalizePath(relative(projectRoot, outputPath)),
    reportSha256: sha256(await readFile(outputPath)),
  });
  await writeJson(resolve(runRoot, "run-manifest.json"), manifest);
  return report;
}

function validateSemantic(stageId, reports) {
  let errors;
  if (stageId === "feature-completeness") errors = validateFeatureModelSemantics(reports.feature);
  else if (stageId === "edge-case-explorer") errors = validateExplorationReportSemantics(reports.exploration, reports.feature);
  else if (stageId === "design-ux-auditor") errors = validateDesignAuditSemantics(reports.design, reports.feature);
  else errors = validateConfirmedReportSemantics(
    reports.confirmed,
    reports.feature,
    reports.exploration,
    reports.design,
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
  const result = await runProcess(provider.command, args, {
    cwd: projectRoot,
    timeoutMs: provider.timeoutMs,
    shell: false,
  });
  if (result.code !== 0) throw new Error(`Agent provider exited ${result.code}: ${result.stderr || result.stdout}`);
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

async function startApplication(application, projectRoot, runRoot) {
  const logPath = resolve(runRoot, "app.log");
  const processHandle = spawn(application.command, application.args, {
    cwd: projectRoot,
    env: { ...process.env, PORTCODE_QA_RUN: "1" },
    shell: process.platform === "win32",
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
    runGit(["diff", "--no-ext-diff", "--binary", "HEAD", "--", ".", ":(exclude).qa/generated/**"], projectRoot),
  ]);
  return { base: base.trim(), head: head.trim(), status, diff };
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
      snapshot.set(normalizePath(path), sha256(await readFile(resolve(projectRoot, path))));
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

function runProcess(command, args, { cwd, timeoutMs, shell }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
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
