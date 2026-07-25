import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const qaRoot = new URL("../", import.meta.url);
const agentUrl = new URL("agents/independent-reproducer.md", qaRoot);
const schemaUrl = new URL("schemas/confirmed-report.schema.json", qaRoot);

test("independent reproducer resets and verifies every candidate without trusting prior verdicts", async () => {
  const prompt = await readFile(agentUrl, "utf8");
  for (const requiredText of [
    "name: independent-reproducer",
    "Application code: read-only",
    "Operate the real application",
    "every candidate",
    "reset",
    "independent evidence",
    "confirmed",
    "rejected",
    "inconclusive",
    "Do not edit application code",
    "Do not invent findings",
    "Do not author custom CDP or input-automation scripts",
    "approved built-in interaction tools",
    "mark the candidate inconclusive",
    "confirmed-report.schema.json",
  ]) {
    assert.match(prompt, new RegExp(escapeRegExp(requiredText), "i"), `missing: ${requiredText}`);
  }
});

test("confirmed report schema makes verdict lifecycle and final severity explicit", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.deepEqual(schema.required, [
    "schemaVersion",
    "runId",
    "outcome",
    "featureModelId",
    "blockers",
  ]);
  assert.deepEqual(schema.$defs.verdict.properties.disposition.enum, [
    "confirmed",
    "rejected",
    "inconclusive",
  ]);
  assert.deepEqual(schema.$defs.verdict.properties.finalSeverity.type, ["string", "null"]);
  assert.equal(schema.$defs.independentEvidence.anyOf.length, 5);
  assert.deepEqual(schema.$defs.summary.properties.mergeGate.enum, [
    "pass",
    "fail",
    "needs-review",
  ]);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
