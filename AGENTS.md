## graphify

This project can generate a local knowledge graph at `graphify-out/` with god nodes, community structure, and cross-file relationships. The generated graph is optional and Git-ignored.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` only when `graphify-out/graph.json` already exists (AST-only, no API cost).

## Testing & coverage

**Mandatory for every implementation session:** Every behavior-changing code, configuration, installer, workflow, or script change must add or update automated tests in the same change. Bug fixes must include a regression test that exercises the failure when feasible. Do not mark work complete or hand it off until the relevant tests pass.

- Frontend changes require matching `*.test.ts(x)` coverage and a passing `pnpm test:coverage` run.
- Rust changes require focused inline or integration tests and a passing `cargo test --workspace` run.
- Script, installer, workflow, and behavioral configuration changes require an appropriate deterministic test or static validation test.
- Only non-executable documentation, asset-only, formatting-only, or metadata-only changes are exempt. Explicitly state the exemption in the handoff. Behavior-changing code has no test-free exception.

Portcode enforces a **frontend coverage gate on `main`/`release`**: the `Coverage` CI job runs `pnpm test:coverage` against the thresholds in `vitest.config.ts` (statements / lines / functions — branch coverage is intentionally not gated). Coverage on `main`/`release` must stay at or above the threshold, or **`main` goes red**.

When you add or change **frontend** code (`src/`):

- **Run `pnpm test:coverage` and make sure it passes the threshold before opening a PR.** Contributor PRs are _not_ gated on coverage (PR CI runs plain `pnpm test`), but the post-merge `main`/`release` job IS — so a feature that lands under-tested will red `main` even though its PR was green.
- **New code must come with tests.** If you add an export/store action/component, extend the matching `*.test.ts(x)` in the same change. (This exact gap — OAuth shipping without test updates — once reddened `main`.)
- If `test:coverage` reports a shortfall, cover the new lines rather than lowering the threshold.

For the **Rust** core (`src-tauri/`): `cargo test` runs in CI on every PR; `cargo llvm-cov` coverage is computed on `main`/`release` only.

## Self-dev mode

You can build Portcode while running it, dogfood-style. `pnpm app:dev:self` runs a separate **Portcode Dev** build (its own data dir + a "DEV" pill in the title bar) with live frontend reload; `pnpm watch:rust` (needs `cargo install --locked bacon`) gives fast Rust type/clippy feedback without a full build. See `docs/SELF_DEV.md` for the full flow and the Phase 2 roadmap. Phase 1 is **config + tooling only** (no Rust changes); run the stable and dev builds **one at a time** (login/phone-sync state is shared).

## Project memory

Durable, project-scoped knowledge lives locally in `.claude/memory/project-memory.md`. The file is ignored by Git, is not automatically injected at SessionStart, and does not travel with clones.

- In Claude Code, run `/memory`. In Codex, use the `project-memory` skill. Both initialize the local file when needed and pass additions through the same PII scrubber.
- HARD RULE: never commit or force-add `.claude/memory/project-memory.md`. Keep personal data, credentials, machine details, and other sensitive information out of it anyway so the file remains safe to copy deliberately.
- Code-structure questions still go through graphify first (see the graphify section); project memory is for architecture decisions, conventions, gotchas, and active workstreams — not a duplicate of the graph.
