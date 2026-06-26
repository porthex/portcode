#!/usr/bin/env bash
# SessionStart hook for Portcode (see .claude/README.md).
#
# Two jobs:
#   1. Inject .claude/memory/project-memory.md into the session as additionalContext.
#   2. Best-effort, time-boxed, NON-FATAL environment prep (pnpm install; optional
#      graphify refresh) so tests/lint work from ephemeral web/iOS cloud containers.
#
# Hard rule: this script MUST exit 0 always and never stall a session. Every slow or
# fallible step is guarded (`|| true`, `command -v`, `timeout`). NO `set -e`.
# STDOUT is JSON-ONLY (the additionalContext payload). All logs go to STDERR.

# Resolve project dir; fall back to the script's own grandparent if unset.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ]; then
  SELF="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
  PROJECT_DIR="$(cd "$SELF/../.." >/dev/null 2>&1 && pwd)"
fi

MEM="$PROJECT_DIR/.claude/memory/project-memory.md"
BANNER="Portcode project memory (.claude/memory/project-memory.md) — durable, PII-free facts:"

# ---------------------------------------------------------------------------
# 1. Emit memory as SessionStart additionalContext (JSON-only on stdout).
# ---------------------------------------------------------------------------
if [ -f "$MEM" ]; then
  # Prefer node (always present in Claude Code envs) to JSON-encode safely so
  # newlines/quotes in the memory file cannot break the JSON. Fall back to jq,
  # then to a quiet no-op. Never let an encoding failure abort the session.
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const banner = process.argv[1];
      const file = process.argv[2];
      let body = "";
      try { body = fs.readFileSync(file, "utf8"); } catch (e) { process.exit(0); }
      const ctx = banner + "\n\n" + body;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: ctx
        }
      }));
    ' "$BANNER" "$MEM" 2>/dev/null || true
  elif command -v jq >/dev/null 2>&1; then
    { printf '%s\n\n' "$BANNER"; cat "$MEM"; } \
      | jq -Rs '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:.}}' 2>/dev/null \
      || true
  fi
else
  # Memory file not present yet (e.g. WIRING landed before MEMORY). No-op cleanly:
  # emit nothing on stdout so the harness simply adds no extra context.
  echo "session-start: no memory file at $MEM (skipping context injection)" >&2
fi

# ---------------------------------------------------------------------------
# 2. Best-effort env-prep — CLOUD ONLY, all non-fatal, all logged to STDERR.
# ---------------------------------------------------------------------------
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  echo "session-start: remote/cloud session — running best-effort env-prep" >&2

  # pnpm install only when deps look missing and a lockfile exists; time-boxed.
  if [ -f "$PROJECT_DIR/pnpm-lock.yaml" ] && [ ! -d "$PROJECT_DIR/node_modules" ]; then
    if command -v pnpm >/dev/null 2>&1; then
      echo "session-start: installing deps (pnpm install --prefer-offline)" >&2
      ( cd "$PROJECT_DIR" && timeout 90 pnpm install --prefer-offline >/dev/null 2>&1 ) || true
    else
      echo "session-start: pnpm not found — skipping install" >&2
    fi
  fi

  # Optional graphify refresh — ONLY if a graphify CLI binary exists. In this repo
  # graphify is a Skill (not a binary), so this is normally skipped. Future-proofing.
  if command -v graphify >/dev/null 2>&1; then
    echo "session-start: refreshing graphify graph (best-effort)" >&2
    ( cd "$PROJECT_DIR" && timeout 30 graphify update . >/dev/null 2>&1 ) || true
  fi
fi

# Always succeed. Never fail a session.
exit 0
