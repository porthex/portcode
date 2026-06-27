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

| Phase | Item                                     | Status | Notes                                                                                                                                                                         |
| ----- | ---------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1   | `LlmProvider` provider seam              | ✅     | PR #82 (`nice-dijkstra-63314b`), CI-green; this branch is stacked on it                                                                                                       |
| 0.2   | Rust SSE-mock test harness               | ✅     | PR #83; pure `TurnBuilder` + 13 tests; CI green (Rust/Frontend/Smoke/Android)                                                                                                 |
| 0.3   | Injectable tool registry + system prompt | ✅     | PR #83; `AgentConfig` (registry + prompt override) threaded into `run_inner`; +5 tests; CI green                                                                              |
| 0.4   | Multi-run store model                    | ✅     | PR #83; `runs` map + derived active-run mirror; per-run state; +6 tests; coverage green; CI green                                                                             |
| 1     | Permission modes + rules + cycling       | ✅     | PR #83; A1 gate core (modes+rules, security-audited) + A2a mode UI/cycle + A2b Settings editor + guardrails; +~25 tests; CI green                                             |
| 1     | Plan mode                                | ✅     | read-only `plan_run()` registry + plan steer + gate-denies-mutating (defense-in-depth) + approve-to-exit banner; CI green                                                     |
| 1     | Pre-apply accept/reject diff             | ✅     | `Tool::preview()` (shared `compute_edit` so preview==run) → `diff` on `PermissionRequest` → colour-coded prompt diff; CI green                                                |
| 1     | Pre-apply EDIT-in-prompt (deferred)      | ⏭     | DEFERRED follow-up (user decision): `Decision::AllowEdited` + `RemoteCommand.content` + desktop-only edit UI                                                                  |
| 2     | Subagent runtime + `Task` tool           | 🟦     | PR1: `Spawner`/`SubagentSpec` on `ToolCtx`, `run_loop_core` + `Persist` (ephemeral children), `task` tool, depth cap; +11 tests; local clippy/test green; review + CI pending |
| 2     | Live agents panel                        | ⬜     |                                                                                                                                                                               |
| 2     | Parallel execution + concurrency cap     | ⬜     |                                                                                                                                                                               |
| 2     | Per-agent git worktree isolation         | ⬜     |                                                                                                                                                                               |
| 2     | Background tasks                         | ⬜     |                                                                                                                                                                               |
| 3     | Rename UI                                | ⬜     | backend already exists                                                                                                                                                        |
| 3     | Persist token/cost across reloads        | ⬜     |                                                                                                                                                                               |
| 3     | Fork / branch a conversation             | ⬜     |                                                                                                                                                                               |
| 3     | Checkpoints & rewind                     | ⬜     |                                                                                                                                                                               |
| 3     | Context compaction + `/context` view     | ⬜     | behind `LlmProvider`                                                                                                                                                          |
| 4     | Custom slash commands                    | ⬜     |                                                                                                                                                                               |
| 4     | Hooks                                    | ⬜     |                                                                                                                                                                               |
| 4     | Skills                                   | ⬜     |                                                                                                                                                                               |
| 4     | MCP client                               | ⬜     |                                                                                                                                                                               |
| 4     | Plugins                                  | ⏸      | PAUSE — needs user trust/sandbox decision                                                                                                                                     |

## Decisions log (append-only)

- Build branch stacked on the unmerged seam (`nice-dijkstra-63314b`) so every phase has the
  provider-agnostic seam; fast-forward from `main`, no force-push. Cumulative build PR is
  stacked on PR #82 (GitHub auto-retargets to `main` if #82 merges).
- Single build branch + one cumulative PR; CI is watched per phase on each push, which
  satisfies the protocol's per-phase VERIFY without a sprawl of stacked PRs. `main` is
  protected; no PR is merged or marked ready without explicit user approval.

## Phase 1 — design (user-approved; item 1 shipped, plan mode + diff next)

Phase 1 rewrites the permission gate — a security trust boundary `GOVERNANCE.md` flags as
RFC-territory. **User confirmed the safe design** (all 5 modes, auto/bypass opt-in only;
scoped allow-rules; diff-display-now / edit-later). Item 1 (modes + rules) is shipped
(A1+A2a+A2b, CI-green). Safe ordering:

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

## Phase 2 — design (architect plan; headline multi-agent feature)

Full plan archived this session. Spawn architecture: a narrow **`Spawner` trait object on
`ToolCtx`** (one optional field; tools stay decoupled from agent internals). `run_inner`
splits into a reusable **`run_loop_core`** with a `Persist` enum — children are **ephemeral**
(no DB/parent-transcript pollution); they route to `agent://{session}:{agentId}` channels so
their deltas never fold into the parent message. Child-cancel = `own || parent`. Caps:
`MAX_SUBAGENT_DEPTH` + `MAX_PARALLEL_AGENTS` + existing `MAX_AGENT_STEPS` per child.

Safe increment order (each its own CI-green commit):

- **PR1 — Subagent runtime + `Task` tool (sequential).** Backend only; `Spawner`/`SubagentSpec`,
  `ToolCtx::new` migration, `run_loop_core`, `AgentSpawner`, depth cap, `task` in default registry.
- **PR2 — Live agents panel.** `agents.rs` registry + 3 StreamEvents (AgentStarted/Progress/
  Finished) + `CancelAgent` RemoteCommand (full triple-touch + server.rs arm) + a separate store
  `agents` map + StatusHud "N agents" + `AgentsPanel`.
- **PR3 — Parallel execution.** `JoinSet` + `Semaphore` cap for `task` calls; results in block order.
- **PR4 — Per-agent git worktree isolation.** `worktree.rs` (create/assign/cleanup, non-git fallback).
- **PR5 — Background tasks.** `BackgroundRunner` capability on `ToolCtx` + `Shell.background` +
  `BackgroundTaskFinished` StreamEvent.

Open product decisions (recommended defaults): caps depth=3/parallel=4; subagents phone-visible
(panel+Stop); child transcripts ephemeral; **worktree edits ephemeral/isolated (no auto-merge —
the UX-weighty one)**; background completion = in-app event only.

**PR1 shipped** (local clippy/test green; adversarial 4-lens review — security/concurrency/
soundness/coverage — found 0 confirmed defects). Implemented as designed, with one refinement:
`run_loop_core` takes **two channels** rather than one. `agent_channel` carries the agent's
private deltas/results (`agent://{session}:{agentId}` for a subagent, invisible until PR2's
panel); `session_channel` carries the session-level events — permission prompts (so a subagent's
gate prompts reach the existing UI) **and token usage** (so a subagent's cost rolls up into the
session total instead of vanishing on the unwatched child channel). The interactive run passes its
own `agent://{session}` for both, so it is behavior-identical. `SyncHub::publish` skips channels
whose recovered id contains `:` (subagent stream channels) so they never spawn a phantom phone
session; the parent channel (prompts + usage) is still mirrored. `task` is non-mutating (the
subagent's own tools still gate); children share the parent's cancel flag (per-agent Stop = PR2).

## PR log

- **PR #83** — `feat(parity): Claude-Code in-session parity (autonomous phased build)` —
  draft, stacked on #82 (`nice-dijkstra-63314b`). The cumulative build PR; phases land as
  commits. Contains: 0.2 (SSE `TurnBuilder`), 0.3 (injectable registry/prompt),
  0.4 (multi-run store model).
