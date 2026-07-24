import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  STAGES,
  buildStagePrompt,
  extractJsonObject,
  extractValidatedJsonObject,
  compareSourceSnapshots,
  resolveApplicationCommand,
  validateStageProvenance,
} from "../scripts/qa-runner.mjs";

const projectRoot = new URL("../../", import.meta.url);

test("runner defines the four ordered trust stages", () => {
  assert.deepEqual(
    STAGES.map(({ id }) => id),
    ["feature-completeness", "edge-case-explorer", "design-ux-auditor", "independent-reproducer"],
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

test("stage extraction ignores tool-preview JSON and requires exactly one schema-valid report", async () => {
  const output = [
    '{"toolPreview":{"status":"ok"}}',
    '{"schemaVersion":"0.2.0","outcome":"completed"}',
  ].join("\n");
  assert.deepEqual(
    await extractValidatedJsonObject(
      output,
      async (candidate) => candidate.schemaVersion === "0.2.0",
    ),
    { schemaVersion: "0.2.0", outcome: "completed" },
  );
  await assert.rejects(
    () =>
      extractValidatedJsonObject(
        '{"schemaVersion":"0.2.0"}\n{"schemaVersion":"0.2.0"}',
        async (candidate) => candidate.schemaVersion === "0.2.0",
      ),
    /exactly one schema-valid JSON report; found 2 of 2 parseable objects/,
  );
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

test("package scripts expose contracts, change, and full workflows", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8"));
  assert.equal(packageJson.scripts["qa:contracts"], "node --test .qa/tests/*.test.mjs");
  assert.match(packageJson.scripts["qa:change"], /qa-runner\.mjs --mode change/);
  assert.match(packageJson.scripts["qa:full"], /qa-runner\.mjs --mode full/);
});

test("application command resolves repository-relative executable paths without a shell", () => {
  const root = "D:/Projects/portcode";
  const resolved = resolveApplicationCommand("src-tauri/target/e2e/debug/portcode.exe", root);
  assert.ok(
    resolved
      .replaceAll("\\", "/")
      .endsWith("/D:/Projects/portcode/src-tauri/target/e2e/debug/portcode.exe") ||
      resolved.replaceAll("\\", "/") ===
        "D:/Projects/portcode/src-tauri/target/e2e/debug/portcode.exe",
  );
  assert.equal(resolveApplicationCommand("node", root), "node");
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
