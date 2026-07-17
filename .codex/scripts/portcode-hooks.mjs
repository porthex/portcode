#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scrub } from "../../.claude/scripts/scrub-memory.mjs";

const MEMORY_PATH = ".claude/memory/project-memory.md";
const GRAPH_PATH = "graphify-out/graph.json";

export function findProjectRoot(start = process.cwd()) {
  let current = resolve(start);
  const filesystemRoot = parse(current).root;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    if (current === filesystemRoot) return resolve(start);
    current = dirname(current);
  }
}

function hookContext(eventName, additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  };
}

function hookDeny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function addedPatchText(patch) {
  return String(patch ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function piiReason(candidate, label) {
  const { hits } = scrub(candidate);
  if (hits.length === 0) return null;
  const details = hits
    .slice(0, 10)
    .map((hit) => `${hit.line} (${hit.pattern})`)
    .join(", ");
  return (
    `Blocked: this would write PII or secrets into local project memory (${label}). ` +
    `Hits: ${details}. Remove the source fact; do not commit a redaction placeholder.`
  );
}

function memoryWriteCandidate(toolName, toolInput) {
  const input = typeof toolInput === "string" ? { patch: toolInput } : (toolInput ?? {});
  const serialized = typeof toolInput === "string" ? toolInput : JSON.stringify(input);
  const targetsMemory = /\.claude[\\/]memory[\\/]/i.test(serialized);

  if (/^(Write|Edit)$/i.test(toolName) && targetsMemory) {
    return String(input.content ?? input.new_string ?? "");
  }
  if (/^(apply_patch|Write|Edit)$/i.test(toolName) && targetsMemory) {
    return addedPatchText(input.patch ?? input.input ?? serialized);
  }
  return null;
}

function shellCommand(toolName, toolInput) {
  if (!/^Bash$/i.test(toolName)) return "";
  if (typeof toolInput === "string") return toolInput;
  return String(toolInput?.command ?? toolInput?.cmd ?? "");
}

export function handleHook(payload, projectRoot = findProjectRoot(payload?.cwd || process.cwd())) {
  const eventName = String(payload?.hook_event_name ?? "");
  const memoryFile = join(projectRoot, MEMORY_PATH);

  if (eventName === "SessionStart") {
    if (!existsSync(memoryFile)) return null;
    const body = readFileSync(memoryFile, "utf8");
    return hookContext(
      "SessionStart",
      `Portcode project memory (${MEMORY_PATH}) — durable, PII-free facts:\n\n${body}`,
    );
  }

  if (eventName !== "PreToolUse") return null;

  const toolName = String(payload?.tool_name ?? "");
  const toolInput = payload?.tool_input ?? {};
  const candidate = memoryWriteCandidate(toolName, toolInput);
  if (candidate !== null) {
    const reason = piiReason(candidate, MEMORY_PATH);
    if (reason) return hookDeny(reason);
  }

  const command = shellCommand(toolName, toolInput);
  if (command) {
    const stagesMemory =
      /\bgit\s+(?:add|commit)\b/i.test(command) &&
      (/\.claude[\\/]memory[\\/]/i.test(command) ||
        /\bgit\s+add\s+(?:-A\b|--all\b|\.(?=\s|$))/i.test(command) ||
        /\bgit\s+commit\b[^|;&]*\s-a\b/i.test(command));
    if (stagesMemory && existsSync(memoryFile)) {
      const reason = piiReason(readFileSync(memoryFile, "utf8"), MEMORY_PATH);
      if (reason) return hookDeny(reason);
    }

    const graphExists = existsSync(join(projectRoot, GRAPH_PATH));
    const searchesSource =
      /(^|[\s;&|])(rg|grep|ripgrep|find|fd|ack|ag|Get-Content|Select-String)\b/i.test(command);
    const alreadyUsesGraphify = /\bgraphify\s+(query|path|explain)\b/i.test(command);
    if (graphExists && searchesSource && !alreadyUsesGraphify) {
      return hookContext(
        "PreToolUse",
        "graphify-out/graph.json exists. Orient with `graphify query`, `graphify explain`, or `graphify path` before broad raw-source searches; use direct reads afterward for exact edits or debugging.",
      );
    }
  }

  return null;
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    process.exit(0);
  }
  const result = handleHook(payload);
  if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main();
