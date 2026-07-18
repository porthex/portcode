#!/usr/bin/env bash
# SessionStart hook for Portcode (see .claude/README.md).
#
# Two jobs:
#   1. Keep .claude/memory/project-memory.md on the local device; never inject it
#      into session context.
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

# ---------------------------------------------------------------------------
# 1. Keep local memory out of SessionStart additionalContext.
# ---------------------------------------------------------------------------
if [ -f "$MEM" ]; then
  echo "session-start: local project memory found; skipping context injection" >&2
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
