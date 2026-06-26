#!/usr/bin/env node
// scrub-memory.mjs — zero-dependency PII/secret scrubber for Portcode's committed
// project memory. This is the privacy backstop for a PUBLIC repo.
//
// CLI modes (see .claude/README.md / spec §6):
//   node scrub-memory.mjs --check <file...>   exit 0 if clean; exit 2 if ANY pattern
//                                             matches (prints "path:line: <pattern>" to
//                                             stderr per hit). Does not modify files.
//   node scrub-memory.mjs --write <file...>   redact in place; print per-pattern counts; exit 0.
//   node scrub-memory.mjs                     stdin -> scrubbed stdout (pipe mode).
//   node scrub-memory.mjs --hook              read PreToolUse JSON from stdin; emit deny JSON
//                                             (and exit 0) if the tool would write PII into
//                                             .claude/memory/** or `git add/commit` it; else
//                                             print nothing, exit 0. NEVER exits nonzero.
//
// Zero deps: Node stdlib only. UTF-8 safe. All regexes are linear-time (no nested
// quantifiers over overlapping classes) to avoid catastrophic backtracking. Input is
// capped (see MAX_INPUT) as a belt-and-suspenders DoS guard.

import { readFileSync, writeFileSync } from "node:fs";

// Cap any single input we scrub. Large enough for any sane memory file / tool input,
// small enough that even a pathological regex can't run away. Oversized input is
// truncated for matching (the tail is left untouched / passed through).
const MAX_INPUT = 1_000_000; // 1 MB

// Ordering matters: most specific first so a value isn't partially eaten by a
// broader rule before its precise rule runs. Each entry: { name, re, replace }.
// `replace` is either a string placeholder or a function (match, ...groups) => string.
const PATTERNS = [
  {
    name: "private-key",
    // Multi-line PEM block. Non-greedy body; the END anchor bounds it so there is no
    // unbounded backtracking.
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    replace: "[REDACTED_PRIVATE_KEY]",
  },
  {
    name: "email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replace: "[REDACTED_EMAIL]",
  },
  {
    name: "home-path-unix",
    re: /(?:\/home\/[^/\s"']+|\/Users\/[^/\s"']+)/g,
    replace: "[REDACTED_HOME]",
  },
  {
    name: "home-path-windows",
    re: /[A-Za-z]:\\Users\\[^\\\s"']+/g,
    replace: "[REDACTED_HOME]",
  },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: "[REDACTED_TOKEN]",
  },
  {
    name: "bearer",
    re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g,
    replace: "Bearer [REDACTED_TOKEN]",
  },
  {
    name: "anthropic-openai-key",
    re: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    replace: "[REDACTED_KEY]",
  },
  {
    name: "github-token",
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replace: "[REDACTED_KEY]",
  },
  {
    name: "aws-access-key-id",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: "[REDACTED_KEY]",
  },
  {
    name: "slack-token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    replace: "[REDACTED_KEY]",
  },
  {
    name: "google-api-key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: "[REDACTED_KEY]",
  },
  {
    name: "ipv4",
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    replace: "[REDACTED_IP]",
  },
  {
    name: "ipv6",
    // Require >=2 colon-separated hextet groups to avoid matching lone hex words.
    re: /\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{0,4}\b/g,
    replace: "[REDACTED_IP]",
  },
  {
    name: "secret-assignment",
    // Generic key=value / key: value secret. Preserves the key name; redacts the value
    // only. Requires an actual assignment + a 12+ char value, so bare prose like
    // "the api_key setting" is NOT matched.
    re: /\b(api[_-]?key|secret|token|password|passwd|pwd)\b(\s*[:=]\s*)["']?[^\s"']{12,}["']?/gi,
    replace: (_m, key, sep) => `${key}${sep}[REDACTED_SECRET]`,
  },
];

/**
 * Pure scrub. Returns the scrubbed text and a list of hits with 1-based line numbers.
 * @param {string} input
 * @returns {{ text: string, hits: Array<{line:number, pattern:string}> }}
 */
export function scrub(input) {
  if (typeof input !== "string") input = String(input ?? "");

  let text = input;
  let tail = "";
  if (text.length > MAX_INPUT) {
    tail = text.slice(MAX_INPUT);
    text = text.slice(0, MAX_INPUT);
  }

  const hits = [];

  for (const { name, re, replace } of PATTERNS) {
    // Record hits with their line numbers (computed against the current text) before
    // mutating, so reported lines reflect the text as the user sees it pre-scrub.
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split("\n").length;
      hits.push({ line, pattern: name });
      // Guard against zero-width matches (none of our patterns are, but be safe).
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    re.lastIndex = 0;
    text = text.replace(re, replace);
  }

  hits.sort((a, b) => a.line - b.line);
  return { text: text + tail, hits };
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function runCheck(files) {
  let dirty = false;
  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch (err) {
      process.stderr.write(`${file}: cannot read (${err.code || err.message})\n`);
      dirty = true;
      continue;
    }
    const { hits } = scrub(content);
    for (const h of hits) {
      dirty = true;
      process.stderr.write(`${file}:${h.line}: ${h.pattern}\n`);
    }
  }
  process.exit(dirty ? 2 : 0);
}

function runWrite(files) {
  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch (err) {
      process.stderr.write(`${file}: cannot read (${err.code || err.message})\n`);
      continue;
    }
    const { text, hits } = scrub(content);
    const counts = {};
    for (const h of hits) counts[h.pattern] = (counts[h.pattern] || 0) + 1;
    if (text !== content) writeFileSync(file, text);
    const summary = Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    process.stdout.write(`${file}: ${hits.length ? summary : "clean"}\n`);
  }
  process.exit(0);
}

function runPipe() {
  const input = readStdin();
  const { text } = scrub(input);
  process.stdout.write(text);
  process.exit(0);
}

// --hook: read PreToolUse JSON from stdin. Only act on writes/commits that target
// committed memory. Emit deny JSON if those would introduce PII. Otherwise stay silent.
// NEVER exits nonzero; NEVER blocks unrelated tools.
function runHook() {
  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    process.exit(0);
  }

  const toolName = payload.tool_name || "";
  const toolInput = payload.tool_input || payload || {};

  // Does this action touch the committed memory store? We only police that path.
  const MEMORY_RE = /\.claude\/memory\//;

  let candidateText = null; // the text whose PII we should evaluate
  let label = "memory file";

  if (toolName === "Write" || toolName === "Edit") {
    const fp = String(toolInput.file_path || toolInput.path || "");
    if (!MEMORY_RE.test(fp.replace(/\\/g, "/"))) process.exit(0);
    // For Write: the content; for Edit: the replacement text.
    candidateText =
      toolInput.content != null
        ? String(toolInput.content)
        : toolInput.new_string != null
          ? String(toolInput.new_string)
          : "";
    label = fp;
  } else if (toolName === "Bash") {
    const cmd = String(toolInput.command || "");
    // Only police git add/commit that could stage the memory file.
    const isGitStage = /\bgit\s+(add|commit)\b/.test(cmd);
    const touchesMemory = MEMORY_RE.test(cmd.replace(/\\/g, "/"));
    // A `git commit -a`/`git add .` could stage the memory file even without naming it.
    const isBlanketStage = /\bgit\s+add\s+(-A|--all|\.)/.test(cmd) || /\bgit\s+commit\b[^|;&]*\s-a\b/.test(cmd);
    if (!isGitStage) process.exit(0);
    if (!touchesMemory && !isBlanketStage) process.exit(0);
    // For commits, re-read the committed memory file from disk and check it.
    try {
      candidateText = readFileSync(".claude/memory/project-memory.md", "utf8");
    } catch {
      process.exit(0); // nothing to police
    }
    label = ".claude/memory/project-memory.md";
  } else {
    process.exit(0);
  }

  const { hits } = scrub(candidateText);
  if (hits.length === 0) process.exit(0);

  const detail = hits
    .slice(0, 10)
    .map((h) => `${h.line} (${h.pattern})`)
    .join(", ");
  const reason =
    `Blocked: this would write PII/secrets into committed memory (${label}). ` +
    `Hits at lines: ${detail}. Run the value through .claude/scripts/scrub-memory.mjs ` +
    `or remove it. This repo is PUBLIC — no personal data in memory.`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n",
  );
  process.exit(0);
}

function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0];

  if (mode === "--check") return runCheck(argv.slice(1));
  if (mode === "--write") return runWrite(argv.slice(1));
  if (mode === "--hook") return runHook();
  // No mode (or unknown flagless invocation): stdin -> stdout pipe.
  return runPipe();
}

// Only run the CLI when executed directly (not when imported by the test file).
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) main();
