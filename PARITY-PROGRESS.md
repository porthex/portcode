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

| Phase | Item                                     | Status | Notes                                                                                                                          |
| ----- | ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 0.1   | `LlmProvider` provider seam              | ✅     | PR #82 (`nice-dijkstra-63314b`), CI-green; this branch is stacked on it                                                        |
| 0.2   | Rust SSE-mock test harness               | 🟦     | Implemented + local `fmt`/`clippy -D warnings`/`test` green (16 llm tests, 13 new); adversarial review folded in; CI verifying |
| 0.3   | Injectable tool registry + system prompt | ⬜     | `agent.rs::run_inner` overridable registry/prompt                                                                              |
| 0.4   | Multi-run store model                    | ⬜     | `store.ts` single `streaming` → collection of runs                                                                             |
| 1     | Permission modes + rules + cycling       | ⬜     |                                                                                                                                |
| 1     | Plan mode                                | ⬜     |                                                                                                                                |
| 1     | Pre-apply accept/reject/edit diff        | ⬜     |                                                                                                                                |
| 2     | Subagent runtime + `Task` tool           | ⬜     | sequential first                                                                                                               |
| 2     | Live agents panel                        | ⬜     |                                                                                                                                |
| 2     | Parallel execution + concurrency cap     | ⬜     |                                                                                                                                |
| 2     | Per-agent git worktree isolation         | ⬜     |                                                                                                                                |
| 2     | Background tasks                         | ⬜     |                                                                                                                                |
| 3     | Rename UI                                | ⬜     | backend already exists                                                                                                         |
| 3     | Persist token/cost across reloads        | ⬜     |                                                                                                                                |
| 3     | Fork / branch a conversation             | ⬜     |                                                                                                                                |
| 3     | Checkpoints & rewind                     | ⬜     |                                                                                                                                |
| 3     | Context compaction + `/context` view     | ⬜     | behind `LlmProvider`                                                                                                           |
| 4     | Custom slash commands                    | ⬜     |                                                                                                                                |
| 4     | Hooks                                    | ⬜     |                                                                                                                                |
| 4     | Skills                                   | ⬜     |                                                                                                                                |
| 4     | MCP client                               | ⬜     |                                                                                                                                |
| 4     | Plugins                                  | ⏸      | PAUSE — needs user trust/sandbox decision                                                                                      |

## Decisions log (append-only)

- Build branch stacked on the unmerged seam (`nice-dijkstra-63314b`) so every phase has the
  provider-agnostic seam; fast-forward from `main`, no force-push. Cumulative build PR is
  stacked on PR #82 (GitHub auto-retargets to `main` if #82 merges).
- Single build branch + one cumulative PR; CI is watched per phase on each push, which
  satisfies the protocol's per-phase VERIFY without a sprawl of stacked PRs. `main` is
  protected; no PR is merged or marked ready without explicit user approval.

## PR log

- (build PR — to be opened on first push)
