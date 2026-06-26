# `.claude/` — Portcode agent configuration

This directory carries Claude Code configuration that travels with the repo clone, so it
works the same in a local terminal and in ephemeral **web / iOS cloud sessions** (which
start from a fresh clone with no access to your local machine or your user-level
`~/.claude`).

## What's here

- `memory/project-memory.md` — durable, project-scoped, **PII-free** knowledge store.
- `scripts/session-start.sh` — SessionStart hook: loads project memory into context and
  does best-effort env-prep (`pnpm install`, optional graphify refresh) in cloud sessions.
- `scripts/scrub-memory.mjs` (+ `scrub-memory.test.mjs`) — zero-dependency PII scrubber.
- `commands/memory.md` — the `/memory` slash command (distill + append to memory).
- `settings.json` — hooks config: the SessionStart hook above, the existing graphify
  PreToolUse steering hooks, and a PreToolUse PII guard (see below).
- `.mcp.json.example` (repo root) — opt-in Serena LSP server, document-only.
- `skills/graphify/` — the existing graphify knowledge-graph skill.

## Project memory

Durable knowledge lives at **`.claude/memory/project-memory.md`**. It is committed, so it
survives across sessions and devices, and it is **auto-loaded each session** by the
SessionStart hook (`scripts/session-start.sh`), which injects it as `additionalContext`.

To record a new durable fact, run **`/memory`**. The command distills durable, project-
scoped facts from the session and appends them **through the scrubber**.

## THE HARD RULE

**Never put personal data in memory or any committed `.claude/` file. No emails, names,
usernames, home paths (`/home/<u>`, `/Users/<u>`, `C:\Users\<u>`), IPs, hostnames,
tokens/keys, or machine specifics. This repo is PUBLIC.**

The PreToolUse PII guard (`scripts/scrub-memory.mjs --hook`) enforces this on writes to the
memory file and on `git add`/`git commit` of it, and `/memory` routes additions through the
scrubber. **Treat both as a backstop, not a license to be careless** — keep entries about
the PROJECT, not about who is working on it.

## Scrubber usage

Zero dependencies (Node stdlib only). Four modes:

```sh
node .claude/scripts/scrub-memory.mjs --check <file...>  # exit 0 clean, exit 2 if it WOULD redact
node .claude/scripts/scrub-memory.mjs --write <file...>  # redact in place, print counts, exit 0
node .claude/scripts/scrub-memory.mjs                    # stdin -> scrubbed stdout (pipe mode)
node .claude/scripts/scrub-memory.mjs --hook             # PreToolUse guard: emit deny JSON for
                                                         # PII-bearing memory writes/commits; exit 0
```

Run the self-test:

```sh
node --test .claude/scripts/
```

(The scrubber/tests are agent-config files, not app `src/` — they are NOT subject to the
frontend coverage gate.)

## Hooks

- **SessionStart** (`startup|resume`) → `scripts/session-start.sh`:
  - Injects `memory/project-memory.md` as context (no-ops cleanly if the file is absent).
  - In cloud sessions only (`CLAUDE_CODE_REMOTE=true`): best-effort `pnpm install`
    (only when `node_modules` is missing and a lockfile exists) and an **optional**
    graphify refresh **only if a `graphify` CLI binary exists** (it normally does not —
    graphify here is a Skill, not a binary, so this step is skipped).
  - **Non-fatal and time-boxed**: every slow/fallible step is guarded; the script always
    exits 0 and never stalls or fails a session. STDOUT is JSON-only; logs go to STDERR.
- **PreToolUse** (existing graphify hooks): steer the agent to `graphify query/explain/path`
  before grepping or reading source files.
- **PreToolUse** PII guard (`Write|Edit|Bash`): runs `scrub-memory.mjs --hook` to block
  writes/commits that would add PII to committed memory.

## Web / iOS notes

These files work in cloud sessions because they are **committed** and the cloud clones the
repo. Your user-level `~/.claude` config does **not** carry over — anything you need in a
web/iOS session must live here in the repo.

## Serena (optional, local LSP navigation)

To enable LSP-grade navigation via Serena: copy `.mcp.json.example` (repo root) to
`.mcp.json` (pure JSON, no comments), approve it once interactively (`claude`), and ensure
`uv` is installed. It **will not auto-load in web/iOS** sessions (project MCP servers
require interactive approval), so it is opt-in only. Keep any committed `.mcp.json` PII-free
(use `--project .`, never an absolute home path).
