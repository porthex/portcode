## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Testing & coverage

Portcode enforces a **frontend coverage gate on `main`/`release`**: the `Coverage` CI job runs `pnpm test:coverage` against the thresholds in `vitest.config.ts` (statements / lines / functions — branch coverage is intentionally not gated). Coverage on `main`/`release` must stay at or above the threshold, or **`main` goes red**.

When you add or change **frontend** code (`src/`):
- **Run `pnpm test:coverage` and make sure it passes the threshold before opening a PR.** Contributor PRs are *not* gated on coverage (PR CI runs plain `pnpm test`), but the post-merge `main`/`release` job IS — so a feature that lands under-tested will red `main` even though its PR was green.
- **New code must come with tests.** If you add an export/store action/component, extend the matching `*.test.ts(x)` in the same change. (This exact gap — OAuth shipping without test updates — once reddened `main`.)
- If `test:coverage` reports a shortfall, cover the new lines rather than lowering the threshold.

For the **Rust** core (`src-tauri/`): `cargo test` runs in CI on every PR; `cargo llvm-cov` coverage is computed on `main`/`release` only. The crate is too heavy to build on low-RAM dev machines — **verify Rust tests via CI**, not locally.

## Self-dev mode

You can build Portcode while running it, dogfood-style. `pnpm app:dev:self` runs a separate **Portcode Dev** build (its own data dir + a "DEV" pill in the title bar) with live frontend reload; `pnpm watch:rust` (needs `cargo install --locked bacon`) gives fast Rust type/clippy feedback without a full build. See `docs/SELF_DEV.md` for the full flow and the Phase 2 roadmap. Phase 1 is **config + tooling only** (no Rust changes); run the stable and dev builds **one at a time** (login/phone-sync state is shared).

## Project memory

Durable, project-scoped knowledge lives in `.claude/memory/project-memory.md`. It is auto-loaded each session by the SessionStart hook and is meant to survive across sessions/devices (it's committed).

- To record a new durable fact, run `/memory` (it distills + appends through the PII scrubber).
- HARD RULE: never put personal data in project memory or any committed `.claude/` file — no emails, names, usernames, home paths, IPs, hostnames, tokens, or machine specifics. This repo is PUBLIC. A PreToolUse guard (`.claude/scripts/scrub-memory.mjs`) blocks commits that would add PII; treat it as a backstop, not permission to be careless.
- Code-structure questions still go through graphify first (see the graphify section); project memory is for architecture decisions, conventions, gotchas, and active workstreams — not a duplicate of the graph.
