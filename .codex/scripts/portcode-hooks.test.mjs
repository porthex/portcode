import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { handleHook } from "./portcode-hooks.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "portcode-hooks-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".claude", "memory"), { recursive: true });
  writeFileSync(join(root, ".claude", "memory", "project-memory.md"), "# Memory\n\n- clean fact\n");
  return root;
}

test("SessionStart injects the shared Claude/Codex project memory", () => {
  const result = handleHook({ hook_event_name: "SessionStart" }, fixture());
  assert.equal(result.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(result.hookSpecificOutput.additionalContext, /clean fact/);
});

test("PreToolUse stays silent when no graph exists", () => {
  const result = handleHook(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rg auth src" } },
    fixture(),
  );
  assert.equal(result, null);
});

test("PreToolUse nudges broad searches when a graph exists", () => {
  const root = fixture();
  mkdirSync(join(root, "graphify-out"));
  writeFileSync(join(root, "graphify-out", "graph.json"), "{}");
  const result = handleHook(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rg auth src" } },
    root,
  );
  assert.match(result.hookSpecificOutput.additionalContext, /graphify query/);
});

test("PreToolUse denies PII added to project memory through apply_patch", () => {
  const sensitiveEmail = ["person", "example.com"].join("@");
  const patch = `*** Update File: .claude/memory/project-memory.md\n+contact ${sensitiveEmail}`;
  const result = handleHook(
    { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { patch } },
    fixture(),
  );
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
});

test("PreToolUse permits clean project-memory patches", () => {
  const patch = "*** Update File: .claude/memory/project-memory.md\n+Architecture uses a Tauri shell.";
  const result = handleHook(
    { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { patch } },
    fixture(),
  );
  assert.equal(result, null);
});

test("PreToolUse checks memory before blanket staging", () => {
  const root = fixture();
  const sensitiveEmail = ["person", "example.com"].join("@");
  writeFileSync(join(root, ".claude", "memory", "project-memory.md"), `contact ${sensitiveEmail}\n`);
  const result = handleHook(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git add ." } },
    root,
  );
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
});
