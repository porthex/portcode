# Portcode → Claude-Code In-Session Parity — Build Progress

> Resumable record of the autonomous, per-phase parity build.
> Build branch: `claude/portcode-claude-code-parity-n8euaf` (stacked on the `LlmProvider`
> seam from PR #82 / `nice-dijkstra-63314b`). One cumulative build PR; each phase is a
> commit (or commits) on this branch, CI-verified before advancing.

## Per-phase protocol

PLAN → IMPLEMENT (code + tests together) → REVIEW (adversarial, ≥3 lenses, loop-until-clean)
→ VERIFY (CI green) → GATE (CI green + review clean + tests) → RECORD → LOOP.

## Status legend

⬜ not started · 🟦 in progress · ✅ done (CI-green) · ⏸ paused (needs user decision)

| Phase | Item                                     | Status | Notes                                                                                             |
| ----- | ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| 0.1   | `LlmProvider` provider seam              | ✅     | PR #82 (`nice-dijkstra-63314b`), CI-green; this branch is stacked on it                           |
| 0.2   | Rust SSE-mock test harness               | ✅     | PR #83; pure `TurnBuilder` + 13 tests; CI green (Rust/Frontend/Smoke/Android)                     |
| 0.3   | Injectable tool registry + system prompt | ✅     | PR #83; `AgentConfig` (registry + prompt override) threaded into `run_inner`; +5 tests; CI green  |
| 0.4   | Multi-run store model                    | ✅     | PR #83; `runs` map + derived active-run mirror; per-run state; +6 tests; coverage green; CI green |
| 1     | Permission modes + rules + cycling       | ⬜     |                                                                                                   |
| 1     | Plan mode                                | ⬜     |                                                                                                   |
| 1     | Pre-apply accept/reject/edit diff        | ⬜     |                                                                                                   |
| 2     | Subagent runtime + `Task` tool           | ⬜     | sequential first                                                                                  |
| 2     | Live agents panel                        | ⬜     |                                                                                                   |
| 2     | Parallel execution + concurrency cap     | ⬜     |                                                                                                   |
| 2     | Per-agent git worktree isolation         | ⬜     |                                                                                                   |
| 2     | Background tasks                         | ⬜     |                                                                                                   |
| 3     | Rename UI                                | ⬜     | backend already exists                                                                            |
| 3     | Persist token/cost across reloads        | ⬜     |                                                                                                   |
| 3     | Fork / branch a conversation             | ⬜     |                                                                                                   |
| 3     | Checkpoints & rewind                     | ⬜     |                                                                                                   |
| 3     | Context compaction + `/context` view     | ⬜     | behind `LlmProvider`                                                                              |
| 4     | Custom slash commands                    | ⬜     |                                                                                                   |
| 4     | Hooks                                    | ⬜     |                                                                                                   |
| 4     | Skills                                   | ⬜     |                                                                                                   |
| 4     | MCP client                               | ⬜     |                                                                                                   |
| 4     | Plugins                                  | ⏸      | PAUSE — needs user trust/sandbox decision                                                         |

## Decisions log (append-only)

- Build branch stacked on the unmerged seam (`nice-dijkstra-63314b`) so every phase has the
  provider-agnostic seam; fast-forward from `main`, no force-push. Cumulative build PR is
  stacked on PR #82 (GitHub auto-retargets to `main` if #82 merges).
- Single build branch + one cumulative PR; CI is watched per phase on each push, which
  satisfies the protocol's per-phase VERIFY without a sprawl of stacked PRs. `main` is
  protected; no PR is merged or marked ready without explicit user approval.

## Phase 1 — design (architect plan, pending user sign-off on trust boundary)

Phase 1 rewrites the permission gate — a security trust boundary `GOVERNANCE.md` flags as
RFC-territory. Designed; **awaiting user confirmation before implementing.** Safe ordering:

- **A — Modes + per-tool/command rules (backward-compat = identical to today).** `permissions.rs`:
  `PermissionMode {Default,AcceptEdits,Plan,Auto,Bypass}` + `Rule {tool, command?, decision}`;
  pure `decide(mode, rules, tool, command?, cancelled)`; **cancel beats everything first**; `Default`
  mode's fallthrough = legacy `default_policy` (zero-op migration). New `Settings` fields via
  `#[serde(default)]`. New install stays `ask`; `auto`/`bypass` opt-in (Settings only, danger HUD
  indicator), NOT in the quick-cycle (default→acceptEdits→plan). Shell match = literal **prefix, no
  regex** (documented as allow-list convenience, not a guarantee).
- **B — Plan mode.** `tools::read_only_registry()` + `AgentConfig::plan_run()` (reuses the 0.3 seam)
  - plan-mode prompt steer; gate denies mutating (defense-in-depth); approve-to-exit toggles the mode.
- **C — Pre-apply diff (display).** `Tool::preview()` computes diff before write (shared helper so
  preview == run); additive `StreamEvent` fields; both store handlers; diff in `PermissionPrompt`.
- **D — Edit outcome (desktop-only v1).** `Decision::AllowEdited{content}`; `resolve_permission` +
  `RemoteCommand.content` + `parse_decision "edit"` (fail-closed); content-only (path stays sandboxed).

## PR log

- **PR #83** — `feat(parity): Claude-Code in-session parity (autonomous phased build)` —
  draft, stacked on #82 (`nice-dijkstra-63314b`). The cumulative build PR; phases land as
  commits. Contains: 0.2 (SSE `TurnBuilder`), 0.3 (injectable registry/prompt),
  0.4 (multi-run store model).
