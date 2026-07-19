# Turn Completion Receipts

Status: Phase 1 implemented; richer activity history and durable historical patches remain follow-ups

## Product contract

Every accepted root agent turn owns one durable `turnId`. Portcode mounts a fixed completion strip when that turn starts and moves it through `Starting`, `Working`, `Waiting for approval`, `Finalizing`, and one terminal state. The strip reports elapsed time, while the assistant's final Markdown remains the summary of what was done. Portcode does not run a second model call to manufacture a summary.

A terminal receipt can append a compact changed-files card after the assistant text. It includes bounded paths and line totals, an explicit attribution certainty, truncation state, and whether background tasks were still running. The card never offers Undo: rollback is a separate, permission-gated workflow with different safety requirements.

## Lifecycle and persistence

- The native core creates the root `turnId` and persists a pending crash-recovery placeholder before provider work begins. Pending rows are never exposed as completed receipts. On the next process start, an abandoned row becomes `process_interrupted` with unknown duration instead of a guessed elapsed time.
- All assistant and tool-result database rows for the root turn carry that ID. Reload grouping therefore reconstructs the same assistant bubble instead of relying on adjacency heuristics.
- A terminal event carries the persisted receipt for completed, stopped, failed, and interrupted turns. `durationMs` is omitted when the interruption instant is unknowable. Older peers may omit the new fields; the frontend treats those frames as legacy rather than inventing historical timing.
- Stop and error paths retain any observed file delta. A receipt may say attribution is unavailable or ambiguous, but it must not claim exact ownership without evidence.
- Root-turn completion is the attribution boundary. Writes performed later by a still-running background task are not silently folded into the closed receipt.

## Change attribution

The native core compares bounded, symlink-safe workspace identities captured at the turn boundaries. Pre-existing dirty files are included only when their identity changes during the turn. File lists and content reads obey native caps; reaching a cap is surfaced through `filesTruncated` and a reduced certainty instead of being hidden.

Certainty is user-visible:

- `exact`: the native lifecycle can safely attribute the captured delta to this turn.
- `observed`: the delta occurred between turn boundaries, but exclusive ownership is not proven.
- `ambiguous`: concurrent or incomplete activity prevents reliable ownership.
- `unavailable`: the workspace could not be captured safely or is not reviewable as Git state.

## Historical Review behavior

The Review button opens a turn-scoped manifest, not the live working-tree scope. Portcode persists the terminal manifest and snapshot identity. It never regenerates an old line patch from a different current tree. When immutable patch bytes are not available, the file summary remains visible and the line diff is explicitly reported as unavailable.

General Review entry points reset the target to the live workspace. Chat and Review remain mounted as sibling surfaces, so changing surfaces preserves the current controller state without background polling while hidden.

## Phase 1 boundaries

- Observable tool and subagent activity may appear in the manual disclosure; hidden provider reasoning never does.
- The file list is compact and bounded. Large-list virtualization and richer per-file navigation remain follow-ups.
- Durable historical patch blobs, cleanup/retention policy for those blobs, and exact old-snapshot line comments remain follow-ups.
- AI review lifecycle, structured findings, staging, rollback, commit, push, and PR actions remain separate future work.
