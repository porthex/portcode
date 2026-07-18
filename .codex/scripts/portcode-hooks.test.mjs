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

test("SessionStart never injects local project memory into agent context", () => {
  const result = handleHook({ hook_event_name: "SessionStart" }, fixture());
  assert.equal(result, null);
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
  const patch =
    "*** Update File: .claude/memory/project-memory.md\n+Architecture uses a Tauri shell.";
  const result = handleHook(
    { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { patch } },
    fixture(),
  );
  assert.equal(result, null);
});

test("PreToolUse denies file, directory, global-option, and blanket staging forms", () => {
  const commands = [
    "git add -f .claude/memory/project-memory.md",
    "git add -f .claude/memory",
    "git add -f .claude",
    "git -C . add -f .claude/memory/project-memory.md",
    "git -C .claude add -f memory/project-memory.md",
    "git -C .claude/memory add -f project-memory.md",
    "git add -f .claude/memory/./project-memory.md",
    "git add -f .claude/*",
    "git add -A",
    "git add --all .",
    "git add -A ':!src'",
    'git commit -am "memory safety"',
    "git commit --pathspec-from-file=paths.txt",
    "bash -lc 'git add -f .claude/memory/project-memory.md'",
    "git update-index --add .claude/memory/project-memory.md",
  ];
  for (const command of commands) {
    const result = handleHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
      fixture(),
    );
    assert.equal(result.hookSpecificOutput.permissionDecision, "deny", command);
  }
});

test("PreToolUse permits unrelated scoped staging and ordinary commits", () => {
  const commands = [
    "git add ./src",
    "git add .github/workflows/ci.yml",
    "git add -A src",
    "git -C src add .",
    'git commit -m "ordinary change"',
  ];
  for (const command of commands) {
    const result = handleHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
      fixture(),
    );
    assert.equal(result, null, command);
  }
});

test("PreToolUse resolves relative paths from payload cwd", () => {
  const root = fixture();
  mkdirSync(join(root, "src"));
  const denied = handleHook(
    {
      cwd: join(root, ".claude"),
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git add -f memory/project-memory.md" },
    },
    root,
  );
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");

  const allowed = handleHook(
    {
      cwd: join(root, "src"),
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git add ." },
    },
    root,
  );
  assert.equal(allowed, null);
});
