#!/usr/bin/env node
// scrub-memory.mjs — zero-dependency PII/secret scrubber for Portcode's local
// project memory. The memory file is Git-ignored; this keeps deliberate copies safe.
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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";

// Cap any single input we scrub. Large enough for any sane memory file / tool input,
// small enough that even a pathological regex can't run away. Oversized input is
// truncated for matching (the tail is left untouched / passed through).
const MAX_INPUT = 1_000_000; // 1 MB
const PROJECT_MEMORY_PATH = ".claude/memory/project-memory.md";

function shellTokens(command) {
  const tokens = [];
  let current = "";
  let quote = null;

  const pushCurrent = () => {
    if (current) tokens.push(current);
    current = "";
  };

  const source = String(command ?? "");
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (quote === '"' && char === "\\" && index + 1 < source.length) {
        current += char + source[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "\\" && index + 1 < source.length) {
      // Preserve the escape for dual POSIX/Windows path interpretation, but
      // keep the escaped character inside this token (notably escaped spaces).
      current += char + source[index + 1];
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }
    if (";&|()".includes(char)) {
      pushCurrent();
      tokens.push(char);
      continue;
    }
    current += char;
  }
  pushCurrent();
  return tokens;
}

function isShellSeparator(token) {
  return token === ";" || token === "&" || token === "|" || token === "(" || token === ")";
}

function isGitExecutable(token) {
  const normalized = String(token).replace(/\\/g, "/").toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename === "git" || basename === "git.exe";
}

function normalizedAbsolute(path) {
  return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function parsePathspec(token) {
  let path = String(token);
  let exclude = false;
  let top = false;
  let literal = false;

  const longMagic = path.match(/^:\(([^)]*)\)(.*)$/);
  if (longMagic) {
    const magic = longMagic[1]
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    exclude = magic.includes("exclude") || magic.includes("!") || magic.includes("^");
    top = magic.includes("top");
    literal = magic.includes("literal");
    path = longMagic[2];
  } else if (path.startsWith(":!") || path.startsWith(":^")) {
    exclude = true;
    path = path.slice(2);
  } else if (path.startsWith(":/")) {
    top = true;
    path = path.slice(2);
  }

  return { path, exclude, top, literal };
}

function unescapePosixToken(token) {
  const source = String(token);
  let result = "";
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\\" && index + 1 < source.length) {
      result += source[index + 1];
      index += 1;
    } else {
      result += source[index];
    }
  }
  return result;
}

function parsedPathspecCouldSelectProjectMemory(parsed, gitCwd, projectRoot) {
  if (parsed.exclude) return false;
  const base = parsed.top ? projectRoot : gitCwd;
  const target = normalizedAbsolute(resolve(projectRoot, PROJECT_MEMORY_PATH));
  const wildcardIndex = parsed.literal ? -1 : parsed.path.search(/[?*[]/);
  if (wildcardIndex >= 0) {
    const staticPrefix = parsed.path.slice(0, wildcardIndex);
    if (!staticPrefix) return true;
    const prefix = normalizedAbsolute(resolve(base, staticPrefix));
    return target.startsWith(prefix);
  }

  const candidate = normalizedAbsolute(resolve(base, parsed.path || "."));
  return target === candidate || target.startsWith(`${candidate}/`);
}

function pathspecCouldSelectProjectMemory(token, gitCwd, projectRoot) {
  const interpretations = [
    String(token).replace(/\\/g, "/"),
    unescapePosixToken(token),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const parsed = interpretations.map(parsePathspec);
  const positive = parsed.filter((pathspec) => !pathspec.exclude);
  return {
    exclude: positive.length === 0,
    matches: positive.some((pathspec) =>
      parsedPathspecCouldSelectProjectMemory(pathspec, gitCwd, projectRoot),
    ),
  };
}

function findProjectRoot(start) {
  let current = resolve(start);
  const filesystemRoot = parse(current).root;
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    if (current === filesystemRoot) return resolve(start);
    current = dirname(current);
  }
}

function gitSubcommand(tokens, gitIndex, commandCwd) {
  let index = gitIndex + 1;
  let gitCwd = resolve(commandCwd);
  let inlineAlias = false;
  while (index < tokens.length && !isShellSeparator(tokens[index])) {
    const token = tokens[index];
    const lower = token.toLowerCase();

    if (token === "-C") {
      if (tokens[index + 1]) gitCwd = resolve(gitCwd, tokens[index + 1]);
      index += 2;
      continue;
    }
    if (token.startsWith("-C") && token.length > 2) {
      gitCwd = resolve(gitCwd, token.slice(2));
      index += 1;
      continue;
    }
    if (token === "-c") {
      inlineAlias ||= /^alias\./i.test(tokens[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (lower.startsWith("-c") && token.length > 2) {
      inlineAlias ||= /^alias\./i.test(token.slice(2));
      index += 1;
      continue;
    }
    if (lower === "--work-tree") {
      if (tokens[index + 1]) gitCwd = resolve(gitCwd, tokens[index + 1]);
      index += 2;
      continue;
    }
    if (lower.startsWith("--work-tree=")) {
      gitCwd = resolve(gitCwd, token.slice(token.indexOf("=") + 1));
      index += 1;
      continue;
    }
    if (["--git-dir", "--namespace"].includes(lower)) {
      index += 2;
      continue;
    }
    if (lower.startsWith("--git-dir=") || lower.startsWith("--namespace=")) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    return { name: lower, argsStart: index + 1, gitCwd, inlineAlias };
  }
  return null;
}

function gitAddCouldStageMemory(tokens, start, gitCwd, projectRoot) {
  let blanket = false;
  const pathspecs = [];
  let options = true;

  for (let index = start; index < tokens.length && !isShellSeparator(tokens[index]); index++) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    if (options && token === "--") {
      options = false;
      continue;
    }
    if (options && token.startsWith("-")) {
      if (lower === "--pathspec-from-file" || lower.startsWith("--pathspec-from-file=")) {
        return true;
      }
      if (
        lower === "-a" ||
        lower === "--all" ||
        lower === "-u" ||
        lower === "--update" ||
        lower === "-p" ||
        lower === "--patch" ||
        lower === "-i" ||
        lower === "--interactive" ||
        lower === "-e" ||
        lower === "--edit" ||
        lower === "--renormalize"
      ) {
        blanket = true;
      }
      continue;
    }
    pathspecs.push(token);
  }

  const analyzed = pathspecs.map((pathspec) =>
    pathspecCouldSelectProjectMemory(pathspec, gitCwd, projectRoot),
  );
  if (analyzed.some((pathspec) => !pathspec.exclude && pathspec.matches)) return true;
  const positiveCount = analyzed.filter((pathspec) => !pathspec.exclude).length;
  if (positiveCount === 0 && analyzed.some((pathspec) => pathspec.exclude)) return true;
  return blanket && pathspecs.length === 0;
}

function gitCommitCouldStageMemory(tokens, start, gitCwd, projectRoot) {
  const valueOptions = new Set([
    "-m",
    "--message",
    "-f",
    "--file",
    "-c",
    "-C",
    "--reuse-message",
    "--reedit-message",
    "--fixup",
    "--squash",
    "--author",
    "--date",
    "-t",
    "--template",
    "--cleanup",
    "--trailer",
    "-S",
  ]);
  let options = true;
  const pathspecs = [];

  for (let index = start; index < tokens.length && !isShellSeparator(tokens[index]); index++) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    if (options && token === "--") {
      options = false;
      continue;
    }
    if (options && token.startsWith("-")) {
      if (lower === "--pathspec-from-file" || lower.startsWith("--pathspec-from-file=")) {
        return true;
      }
      if (lower === "--all" || (/^-[^-]+/.test(token) && token.slice(1).includes("a"))) {
        return true;
      }
      const shortClusterNeedsValue = /^-[^-]+/.test(token) && token.endsWith("m");
      if ((valueOptions.has(token) || shortClusterNeedsValue) && !token.includes("=")) index += 1;
      continue;
    }
    pathspecs.push(token);
  }

  const analyzed = pathspecs.map((pathspec) =>
    pathspecCouldSelectProjectMemory(pathspec, gitCwd, projectRoot),
  );
  if (analyzed.some((pathspec) => !pathspec.exclude && pathspec.matches)) return true;
  const positiveCount = analyzed.filter((pathspec) => !pathspec.exclude).length;
  return positiveCount === 0 && analyzed.some((pathspec) => pathspec.exclude);
}

function delegatedCommand(tokens, index) {
  if (index === 0 || !tokens[index].includes(" ")) return null;
  const launcherFlag = tokens[index - 1].toLowerCase();
  return ["-c", "-lc", "/c", "-command", "--command"].includes(launcherFlag)
    ? tokens[index]
    : null;
}

function changedShellCwd(tokens, index, currentCwd) {
  const command = tokens[index].toLowerCase();
  if (!["cd", "chdir", "set-location", "pushd", "push-location"].includes(command)) {
    return null;
  }

  for (let cursor = index + 1; cursor < tokens.length; cursor++) {
    const token = tokens[cursor];
    if (isShellSeparator(token)) break;
    const lower = token.toLowerCase();
    if (["/d", "--", "-path", "-literalpath"].includes(lower)) continue;
    if (token.startsWith("-")) continue;
    return resolve(currentCwd, token);
  }
  return null;
}

function commandCouldStageProjectMemory(command, projectRoot, commandCwd, depth) {
  if (depth > 3) return true;
  const tokens = shellTokens(command);
  let shellCwd = resolve(commandCwd);
  const cwdStack = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === "(") {
      cwdStack.push(shellCwd);
      continue;
    }
    if (tokens[index] === ")") {
      shellCwd = cwdStack.pop() ?? shellCwd;
      continue;
    }
    const changedCwd = changedShellCwd(tokens, index, shellCwd);
    if (changedCwd) shellCwd = changedCwd;
    const nested = delegatedCommand(tokens, index);
    if (nested && commandCouldStageProjectMemory(nested, projectRoot, shellCwd, depth + 1)) {
      return true;
    }
    if (!isGitExecutable(tokens[index])) continue;
    const subcommand = gitSubcommand(tokens, index, shellCwd);
    if (!subcommand) continue;
    if (subcommand.inlineAlias) return true;
    if (
      ["add", "stage"].includes(subcommand.name) &&
      gitAddCouldStageMemory(tokens, subcommand.argsStart, subcommand.gitCwd, projectRoot)
    ) {
      return true;
    }
    if (
      subcommand.name === "commit" &&
      gitCommitCouldStageMemory(tokens, subcommand.argsStart, subcommand.gitCwd, projectRoot)
    ) {
      return true;
    }
    if (["update-index", "am"].includes(subcommand.name)) return true;
    if (
      subcommand.name === "apply" &&
      tokens
        .slice(subcommand.argsStart)
        .some((token) => token === "--cached" || token === "--index")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Return true when a shell command contains a Git add/commit form that could
 * stage the local-only project-memory path. This intentionally understands Git
 * global options, working-directory changes, pathspec magic, and common index
 * writers while paths such as `git -C src add .` and `.github/...` remain valid.
 * CI independently rejects any tracked `.claude/memory/**` path, so this hook
 * is an early local backstop rather than the sole repository boundary.
 */
export function gitCommandCouldStageProjectMemory(
  command,
  projectRoot = findProjectRoot(process.cwd()),
  commandCwd = process.cwd(),
) {
  return commandCouldStageProjectMemory(command, resolve(projectRoot), resolve(commandCwd), 0);
}

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
// local memory. Emit deny JSON if those would introduce PII. Otherwise stay silent.
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

  // Does this action touch the local memory store? We only police that path.
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
    const commandCwd = resolve(payload.cwd || process.cwd());
    const projectRoot = findProjectRoot(commandCwd);
    if (!gitCommandCouldStageProjectMemory(cmd, projectRoot, commandCwd)) process.exit(0);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Blocked: .claude/memory/project-memory.md is local-only and must never be staged or committed, including with force-add or blanket Git commands.",
        },
      }) + "\n",
    );
    process.exit(0);
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
    `Blocked: this would write PII/secrets into local project memory (${label}). ` +
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
