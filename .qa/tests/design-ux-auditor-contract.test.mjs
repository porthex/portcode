import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const qaRoot = new URL("../", import.meta.url);
const agentUrl = new URL("agents/design-ux-auditor.md", qaRoot);
const schemaUrl = new URL("schemas/design-audit-report.schema.json", qaRoot);

test("design auditor checks reachable states in the real UI without substituting taste", async () => {
  const prompt = await readFile(agentUrl, "utf8");
  for (const requiredText of [
    "name: design-ux-auditor",
    "Application code: read-only",
    "Operate the real application",
    "reachable state",
    "project evidence",
    "loading",
    "empty",
    "error",
    "success",
    "disabled",
    "responsive",
    "focus",
    "reduced motion",
    "screenshot",
    "Do not edit application code",
    "Do not invent findings",
    "Do not mark findings confirmed",
    "design-audit-report.schema.json",
  ]) {
    assert.match(prompt, new RegExp(escapeRegExp(requiredText), "i"), `missing: ${requiredText}`);
  }
});

test("design audit schema requires a complete state plan and screenshot-backed observations", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.required, [
    "schemaVersion",
    "runId",
    "outcome",
    "featureModelId",
    "blockers",
  ]);
  assert.deepEqual(schema.$defs.designStatePlanItem.required, [
    "id",
    "category",
    "sourceStateIds",
    "applicable",
    "rationale",
    "expectedDesign",
    "evidenceBasis",
  ]);
  assert.equal(schema.$defs.designObservation.properties.status.const, "observed-unverified");
  assert.equal(schema.$defs.designEvidence.properties.screenshots.minItems, 1);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
