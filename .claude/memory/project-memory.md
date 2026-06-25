# Portcode — Project Memory

> Durable, PROJECT-SCOPED, PII-FREE knowledge that persists across Claude Code sessions and devices.
> Auto-loaded each session by the SessionStart hook. Append via `/memory` (which runs the scrubber).
>
> HARD RULE: never put personal data here. No emails, names, usernames, absolute home-directory paths
> (unix or Windows user folders), IPs, hostnames, tokens/keys, or machine specifics. A PreToolUse guard
> blocks commits that would add them. Keep entries about the PROJECT, not about who is working on it.

## Architecture
- Portcode is a native Windows AI coding agent: a Tauri (Rust) shell hosting a React + TypeScript UI.
- Rust core lives in `src-tauri/src/` (modules: agent, llm, tools, permissions, oauth, secrets, settings, db, sync/).
- Frontend lives in `src/`; shared client helpers in `src/lib/` (ipc, platform, scanner, useScramble).
- The agent's tool surface is defined in `src-tauri/src/tools.rs` (e.g. fs_read, list, command/pattern-based file ops); the LLM loop is in `src-tauri/src/llm.rs` and `src-tauri/src/agent.rs`.
- Device-to-device sync uses iroh, implemented under `src-tauri/src/sync/` (client/server transport, Noise encryption, a pairing gate, and session handling).
- Secrets/keys are handled in `src-tauri/src/secrets.rs`; OAuth flows in `src-tauri/src/oauth.rs`; persistence in `src-tauri/src/db.rs`.

## Conventions
- Package manager is pnpm; common scripts: dev, build, tauri, lint, format/format:check, typecheck, test, test:watch, test:coverage, test:e2e.
- Frontend coverage gate on `main`/`release`: `pnpm test:coverage` must meet `vitest.config.ts` thresholds (statements/lines/functions; branch coverage is intentionally NOT gated). New `src/` code must ship with matching `*.test.ts(x)` or it can red `main` post-merge even if the PR was green.
- Contributor PRs run plain `pnpm test` (not coverage-gated); the post-merge `main`/`release` Coverage job IS gated — run `pnpm test:coverage` before opening a PR touching `src/`.
- Rust core (`src-tauri/`): `cargo test` runs in CI on every PR; `cargo llvm-cov` coverage runs on `main`/`release` only. The crate is too heavy to build on low-RAM dev machines — verify Rust via CI, not locally.

## Decisions (dated, append-only)
- 2026-06-25: Added project-scoped, PII-free memory at `.claude/memory/project-memory.md`, auto-loaded by a SessionStart hook, so durable knowledge survives across ephemeral web/iOS cloud sessions (fresh clone each time, no local user-level config). Rationale: committed files are part of the clone and re-clone-safe; user-level config does not carry over.
- 2026-06-25: Memory is policed by a zero-dependency Node scrubber (`.claude/scripts/scrub-memory.mjs`) and a PreToolUse guard. Rationale: the repo is PUBLIC, so a deterministic local backstop must keep PII/secrets out of committed memory without any network dependency.

## Gotchas
- `graphify` is a Skill here (`.claude/skills/graphify/SKILL.md`), not a CLI binary on PATH; do not call `graphify update`/`graphify query` from the shell — it is not installed in cloud sessions. The graph is committed at `graphify-out/` and surfaced via existing PreToolUse hooks.
- `graphify-out/memory/` is gitignored, so committed memory must NOT live under `graphify-out/`; it lives at `.claude/memory/project-memory.md`.
- For codebase-structure questions, orient with the committed `graphify-out/` graph before raw grepping/reading source.

## Active workstreams
- branch claude/web-dev-memory: repo-config memory upgrade (committed PII-free memory store, scrubber + self-test, `/memory` command, SessionStart/PreToolUse wiring, docs).
