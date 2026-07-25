import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const qaRoot = new URL("../", import.meta.url);
const agentUrl = new URL("agents/edge-case-explorer.md", qaRoot);
const schemaUrl = new URL("schemas/exploration-report.schema.json", qaRoot);

test("edge-case explorer requires real interaction, observability, safety, and evidence", async () => {
  const prompt = await readFile(agentUrl, "utf8");

  for (const requiredText of [
    "name: edge-case-explorer",
    "Application code: read-only",
    "feature-model.schema.json",
    "Operate the real application",
    "Reset to a known baseline",
    "console",
    "page error",
    "network",
    "screenshot",
    "trace",
    "Do not edit application code",
    "Do not invent findings",
    "Do not mark findings confirmed",
    "exploration-report.schema.json",
  ]) {
    assert.match(prompt, new RegExp(escapeRegExp(requiredText), "i"), `missing: ${requiredText}`);
  }
});

test("edge-case explorer defines the runner-owned coverage equations exactly", async () => {
  const prompt = await readFile(agentUrl, "utf8");

  for (const requiredText of [
    "executed = passed + observation-recorded",
    "observationsRecorded = observations.length",
    "blocked scenarios are not included in executed",
    "not-applicable scenarios are not included in executed",
    "Apply the same equations independently within every category",
  ]) {
    assert.match(prompt, new RegExp(escapeRegExp(requiredText), "i"), `missing: ${requiredText}`);
  }
});

test("exploration report separates executed coverage from evidence-backed observations", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "schemaVersion",
    "runId",
    "outcome",
    "featureModelId",
    "blockers",
  ]);

  assert.deepEqual(schema.$defs.observation.required, [
    "id",
    "title",
    "classification",
    "provisionalImpact",
    "confidence",
    "charterCaseIds",
    "preconditions",
    "steps",
    "expected",
    "actual",
    "reproduction",
    "evidence",
    "status",
  ]);
  assert.equal(schema.$defs.observation.properties.status.const, "observed-unverified");

  assert.deepEqual(schema.$defs.scenarioResult.properties.status.enum, [
    "passed",
    "observation-recorded",
    "blocked",
    "not-applicable",
  ]);
  assert.deepEqual(schema.$defs.scenarioPlanItem.required, [
    "caseId",
    "selected",
    "selectionReason",
  ]);

  const evidenceRequired = schema.$defs.evidence.required;
  assert.deepEqual(evidenceRequired, ["screenshots", "trace", "console", "pageErrors", "network"]);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
