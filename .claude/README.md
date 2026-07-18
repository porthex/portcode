# `.claude/` — Portcode agent configuration

This directory carries Claude Code configuration that travels with the repo clone, so it
works the same in a local terminal and in ephemeral **web / iOS cloud sessions** (which
start from a fresh clone with no access to your local machine or your user-level
`~/.claude`).

## What's here

- `memory/project-memory.md` — local-only, durable, project-scoped, **PII-free** knowledge store (Git-ignored).
- `scripts/session-start.sh` — SessionStart hook: keeps local memory out of automatic
  context and does best-effort env-prep (`pnpm install`, optional graphify refresh) in
  cloud sessions.
- `scripts/scrub-memory.mjs` (+ `scrub-memory.test.mjs`) — zero-dependency PII scrubber.
- `commands/memory.md` — the `/memory` slash command (distill + append to memory).
- `settings.json` — hooks config: the SessionStart hook above, the existing graphify
  PreToolUse steering hooks, and a PreToolUse PII guard (see below).
- `.mcp.json.example` (repo root) — opt-in Serena LSP server, document-only.
- `skills/graphify/` — the existing graphify knowledge-graph skill.

## Project memory

Durable knowledge lives at **`.claude/memory/project-memory.md`**. It is local-only and
Git-ignored, so it survives sessions on the same machine but does not travel with clones.
The SessionStart hook (`scripts/session-start.sh`) deliberately does not inject it into
automatic context. The file is read only through an explicit local-memory workflow such as
`/memory`, when the user asks to inspect or update it.

To record a new durable fact, run **`/memory`**. The command creates the local file when
needed, distills durable project-scoped facts, and appends them **through the scrubber**.

## THE HARD RULE

**Never commit or force-add `memory/project-memory.md`. Keep emails, names, usernames,
home paths (`/home/<u>`, `/Users/<u>`, `C:\Users\<u>`), IPs, hostnames, tokens/keys,
and machine specifics out of it anyway so deliberate copies remain safe.**

The PreToolUse PII guard (`scripts/scrub-memory.mjs --hook`) checks writes to the memory
file and blocks common direct, broad, dynamic-pathspec, and delegated Git staging forms.
CI independently rejects every tracked `.claude/memory/**` path, regardless of which Git
command created it, and `/memory` routes additions through the scrubber.
**Treat both as a backstop, not a license to be careless** — keep entries about
the PROJECT, not about who is working on it.

## Scrubber usage

Zero dependencies (Node stdlib only). Four modes:

```sh
node .claude/scripts/scrub-memory.mjs --check <file...>  # exit 0 clean, exit 2 if it WOULD redact
node .claude/scripts/scrub-memory.mjs --write <file...>  # redact in place, print counts, exit 0
node .claude/scripts/scrub-memory.mjs                    # stdin -> scrubbed stdout (pipe mode)
node .claude/scripts/scrub-memory.mjs --hook             # PreToolUse guard: emit deny JSON for
                                                         # unsafe writes or memory staging; exit 0
```

Run the self-test:

```sh
node --test .claude/scripts/
```

(The scrubber/tests are agent-config files, not app `src/` — they are NOT subject to the
frontend coverage gate.)

## Hooks

- **SessionStart** (`startup|resume`) → `scripts/session-start.sh`:
  - Keeps `memory/project-memory.md` local and out of automatic SessionStart context.
  - In cloud sessions only (`CLAUDE_CODE_REMOTE=true`): best-effort `pnpm install`
    (only when `node_modules` is missing and a lockfile exists) and an **optional**
    graphify refresh **only if a `graphify` CLI binary exists** (it normally does not —
    graphify here is a Skill, not a binary, so this step is skipped).
  - **Non-fatal and time-boxed**: every slow/fallible step is guarded; the script always
    exits 0 and never stalls or fails a session. STDOUT is JSON-only; logs go to STDERR.
- **PreToolUse** (existing graphify hooks): steer the agent to `graphify query/explain/path`
  before grepping or reading source files.
- **PreToolUse** PII guard (`Write|Edit|Bash`): runs `scrub-memory.mjs --hook` to protect
  local memory and block staging attempts early; the CI tracked-path gate is authoritative.

## Web / iOS notes

The reusable configuration works in cloud sessions because it is committed and cloned.
The local memory file is intentionally absent from fresh web/iOS clones; create it there
only when that environment needs its own local memory.

## Serena (optional, local LSP navigation)

To enable LSP-grade navigation via Serena: copy `.mcp.json.example` (repo root) to
`.mcp.json` (pure JSON, no comments), approve it once interactively (`claude`), and ensure
`uv` is installed. It **will not auto-load in web/iOS** sessions (project MCP servers
require interactive approval), so it is opt-in only. Keep any committed `.mcp.json` PII-free
(use `--project .`, never an absolute home path).
