import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const qaRoot = new URL("../", import.meta.url);
const agentUrl = new URL("agents/feature-completeness.md", qaRoot);
const schemaUrl = new URL("schemas/feature-model.schema.json", qaRoot);

test("feature-completeness agent has the required safety and completeness contract", async () => {
  const prompt = await readFile(agentUrl, "utf8");

  for (const requiredText of [
    "name: feature-completeness",
    "Application access: read-only",
    "Do not edit application code",
    "Original task",
    "Git diff",
    "State model",
    "Missing behaviors",
    "Missing designs",
    "Edge-case charter",
    "Do not invent findings",
    "feature-model.schema.json",
  ]) {
    assert.match(prompt, new RegExp(escapeRegExp(requiredText), "i"), `missing: ${requiredText}`);
  }
});

test("feature completeness plans atomic executable cases and bounded optional exclusions", async () => {
  const prompt = await readFile(agentUrl, "utf8");
  for (const requiredText of [
    "one principal oracle",
    "one capability family",
    "split executable UI behavior",
    "Optional requirements as bounded exclusion tests",
    "deterministic test or transport evidence",
  ])
    assert.match(prompt, new RegExp(escapeRegExp(requiredText), "i"), `missing: ${requiredText}`);
});

test("feature model schema requires evidence-backed states, omissions, and edge cases", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schemaVersion", "modelId", "outcome", "blockers"]);

  const omission = schema.$defs.omissionBase;
  assert.equal(omission.additionalProperties, false);
  assert.deepEqual(omission.required, [
    "id",
    "title",
    "classification",
    "basis",
    "trigger",
    "expected",
    "risk",
    "confidence",
  ]);
  assert.equal(schema.$defs.behaviorOmission.allOf[1].properties.id.pattern, "^MB-[0-9]{3}$");
  assert.equal(schema.$defs.designOmission.allOf[1].properties.id.pattern, "^MD-[0-9]{3}$");
  assert.match("EC-A11Y-001", new RegExp(schema.$defs.edgeCase.properties.id.pattern));

  const categories = schema.$defs.edgeCaseCharter.properties.categories.required;
  assert.deepEqual(categories, [
    "input",
    "timing",
    "lifecycle",
    "interaction",
    "persistence",
    "layout",
    "accessibility",
    "neighboringRegression",
  ]);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
