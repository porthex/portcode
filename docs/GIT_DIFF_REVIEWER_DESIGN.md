# Git Diff Reviewer Design

Status: Phase 1 implemented; AI review lifecycle and Git handoff remain planned

## Decision

Build a desktop-only **Review Workspace** that temporarily replaces the chat transcript in the main content area. It is a Git-native workspace, not a rendered tool result and not a narrow addition to the Environment dock.

The first release should do four things well:

1. Browse a typed, line-addressable diff for `Working tree`, `Staged`, `Unstaged`, `Branch`, or `Commit` scope.
2. Let the user attach comments to changed lines and submit several comments as one fix request.
3. Run a dedicated, read-only AI review that returns structured, severity-ranked findings.
4. Refresh after changes, retain review threads, and mark anchors outdated when their patch changes.

Fixing, staging, committing, pushing, and posting to a PR are separate actions. A review never mutates the repository by itself.

### Phase 1 status and boundaries

Phase 1 implements the native manifest/lazy-patch boundary, the full-width Review Workspace, all five local scopes, binary/truncation states, refresh, and snapshot-plus-patch-bound manual comments that can be handed to the existing chat draft. The controller remains mounted while Chat is visible so scope, selection, and comments survive a round trip without polling in the background.

The following remain explicit follow-ups, not partial Phase 1 features:

- The dedicated AI review runner, structured findings, severity/evidence filters, persistence, and finding lifecycle are Phase 2.
- Diff-row virtualization, preserved per-file scroll positions, and large-review navigation are performance follow-ups before the AI review corpus grows.
- Stage, unstage, revert, commit, push, and PR actions remain Phase 3 and require fresh snapshot/hash preconditions.

Phase 1 renders only ordinary two-way unified hunks (`@@`). Unmerged working-tree files remain visible as conflicts, but Portcode does not attempt to invent a resolved conflict view. Commit scope rejects merge commits and directs the user to a two-way Branch comparison. Combined merge diffs (`@@@`) are unsupported and must be rejected explicitly rather than partially parsed or attached to line comments.

## Why this fits Portcode

Portcode already has most of the surrounding seams:

- `src-tauri/src/workspace.rs` runs bounded, non-interactive Git commands and returns branch, upstream, file count, and line totals for the configured workspace.
- `src/components/EnvironmentPanel.tsx` owns the live Changes summary and already refreshes on focus, every five seconds while open, and after an agent turn.
- `src/App.tsx` owns the main desktop layout and can switch the center surface without disturbing the sessions sidebar.
- `src/lib/ipc.ts` is the typed boundary for desktop-only workspace commands and browser mocks.
- `src-tauri/src/agent.rs` already parameterizes agent runs with an `AgentConfig`, and `tools::read_only_registry()` is an existing defense-in-depth boundary.
- `src-tauri/src/tools.rs` already uses the `similar` crate for pre-apply text diffs, which can also produce safe empty-to-file patches for untracked text files.
- `src/components/ToolCall.tsx` and `src/components/PermissionPrompt.tsx` establish diff colors, but their private display-only `DiffView` implementations are intentionally capped and lack paths, line numbers, anchors, comments, or lifecycle state.

The reviewer should extend these seams, not route Git inspection through `run_command` and not stretch either existing `DiffView` beyond its purpose.

### Alternatives rejected

- **Reuse the 366px Environment dock:** useful for status, too narrow for a file navigator plus line-numbered diff.
- **Open a 55vw dock beside Chat:** technically reuses the current layout, but leaves both surfaces cramped and encourages split attention during review.
- **Render review as another chat/tool result:** loses stable file navigation, anchors, refresh, and finding lifecycle.
- **Reuse Plan mode unchanged:** it has the right read-only tools, but the wrong prompt, persistence model, cancellation key, and output contract.
- **Ship a Git client in v1:** staging and revert add mutation races and recovery requirements that are not needed to prove the review loop.

## Product inspiration

| Pattern     | Codex                                                                | Claude                                                                                  | Portcode decision                                                               |
| ----------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Scope       | Unstaged, staged, commit, branch, and last-turn views                | Local changes, file, branch, ref range, or PR                                           | Always show a scope selector and the resolved base/target labels                |
| Navigation  | Collapsible files and line-attached comments                         | File list beside diff, with queued line comments                                        | Persistent file navigator plus line-addressed comment threads                   |
| Review      | Dedicated read-only review, inline or detached                       | “Review code” adds inline findings; deep review uses specialist agents and verification | Dedicated read-only review run; fixing is a separate explicit transition        |
| Signal      | P0-P3 internally; hosted reviews publish only P0/P1                  | Important, Nit, and Pre-existing; verification is emphasized                            | P0-P3 internally, user-facing labels, high-signal default, expandable evidence  |
| Fix loop    | Select comments, ask the agent to address them, inspect the new diff | Reply or request a revision, then review the new diff                                   | Batch selected threads into a normal permission-gated Portcode turn             |
| Git actions | Stage, unstage, and revert by diff, file, or hunk                    | PR monitoring and opt-in fix/merge automation                                           | Keep out of the first release; add only behind snapshot checks and confirmation |

Sources:

- [OpenAI Codex code review](https://learn.chatgpt.com/docs/code-review?surface=app)
- [OpenAI Codex GitHub integration](https://learn.chatgpt.com/docs/third-party/github)
- [OpenAI Codex review prompt](https://github.com/openai/codex/blob/main/codex-rs/core/review_prompt.md)
- [OpenAI Codex app-server review protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#example-request-a-code-review)
- [Claude Desktop diff and review flow](https://code.claude.com/docs/en/desktop#review-changes-with-diff-view)
- [Claude Code Review](https://code.claude.com/docs/en/code-review)

## Primary experience

### Entry points

- Make the Environment panel's **Changes** row actionable: `14 changed files · Review`.
- Add **Open review workspace** to the command palette.
- When there are changes, show a compact `+N −N` review button in the title bar.
- Do not add a global shortcut in v1; common Git/reload shortcuts already collide across platforms.

### Main layout

```text
┌ sessions ┬──────────────────────────────────────────────────────────────┐
│          │ Review  [Working tree ▾]  HEAD → files   +642 −87  [Refresh]│
│          ├────────────────┬─────────────────────────────────────────────┤
│          │ Findings (3)   │ src/store/store.ts                  +12 −3 │
│          │ Files (14)     │                                             │
│          │                │  104 │ context                               │
│          │ ▾ Staged       │+ 105 │ added line              [P1 finding] │
│          │ ▾ Unstaged     │- 106 │ removed line                          │
│          │ ▾ Untracked    │  107 │ context                    [+ comment]│
│          │                │                                             │
│          │                │                [Run review] [Fix selected 2]│
└──────────┴────────────────┴─────────────────────────────────────────────┘
```

The sessions sidebar remains visible. The optional file explorer collapses when Review opens because the review navigator replaces it. Chat state remains mounted or restorable, but the center route is `chat | review`; the Environment dock closes to preserve width.

At narrow desktop widths, the file navigator becomes an overlay drawer. The phone client does not expose this surface in v1 because the current mobile command set intentionally omits workspace filesystem access.

### Scope selector

Support these typed targets:

- **Working tree**: current files against `HEAD`, with staged, unstaged, and untracked groups.
- **Staged**: index against `HEAD`.
- **Unstaged**: working tree against index.
- **Branch…**: current `HEAD` against the merge base of a local or remote branch enumerated from the native workspace repository. The UI uses the shared inline Portcode `SelectMenu`; it never accepts a free-form branch name or opens an operating-system select popup.
- **Commit…**: one commit or an explicit ref range.
- **Last agent turn**: later phase, after Portcode records a reliable pre-turn baseline for agent-touched files.

The toolbar must show the resolved comparison, for example `merge-base(origin/main) → HEAD`, not only the friendly scope label.

### Diff interaction

- Group files by staged, unstaged, and untracked state when the selected scope supports it.
- Show status, additions, deletions, binary state, finding count, and highest open severity on every file row.
- Render structured hunks with old/new line numbers; collapse long unchanged context.
- Hover or keyboard-focus a changed line to reveal **Add comment**.
- Allow a comment to cover a short contiguous range, but anchor it to the smallest useful range.
- Clicking a finding scrolls to its line. Clicking its file opens that file in the diff, not the external editor.
- External-editor handoff is a secondary action and includes the line number when one exists.
- A clean result is concise: **No actionable findings** plus any explicit residual test risk. Do not manufacture nits to fill the screen.

### Review and fix loop

1. The user selects a scope and optionally adds focus instructions.
2. **Run review** shows the exact scope, file/line counts, selected provider/model, and whether the run is Fast or Deep.
3. Review runs with read-only tools. Findings stream into the file navigator and summary, but partial text is not treated as a valid finding.
4. The user selects findings and/or their own line comments.
5. **Fix selected** displays a boundary message: `Review is read-only. Applying fixes starts a normal agent turn and uses your permission policy.`
6. Portcode sends a structured fix request to the active session, or offers to create a new session if none is active.
7. At turn end, the review snapshot refreshes. Changed anchors become **Needs re-check**, not automatically **Fixed**.
8. **Re-check changed hunks** performs a focused read-only review and marks a thread Fixed only when the reviewer verifies the issue is gone.

## Finding model

Use severity, evidence, and lifecycle as separate dimensions.

```ts
type ReviewSeverity = "p0" | "p1" | "p2" | "p3";
type ReviewThreadState =
  "open" | "fixRequested" | "needsRecheck" | "fixed" | "dismissed" | "outdated";

interface ReviewAnchor {
  path: string;
  side: "base" | "head";
  oldStart: number | null;
  oldEnd: number | null;
  newStart: number | null;
  newEnd: number | null;
  hunkHeader: string;
  contextHash: string;
  filePatchHash: string;
}

interface ReviewFinding {
  id: string;
  reviewId: string;
  snapshotId: string;
  severity: ReviewSeverity;
  title: string;
  explanation: string;
  evidence: string[];
  anchor: ReviewAnchor;
  confidence: number; // ranking/filtering; not the primary user-facing label
  state: ReviewThreadState;
  origin: "ai" | "user";
}
```

User-facing labels should be:

- **P0 · Blocker** — broadly catastrophic or unsafe to ship.
- **P1 · Major** — should be fixed before merge.
- **P2 · Minor** — real localized defect that should be fixed.
- **P3 · Nit** — non-blocking and hidden by default.

“Pre-existing” is a finding classification, not a severity. It is collapsed by default because the reviewer is responsible for the selected change, not general repository cleanup.

The default queue shows high-confidence P0-P2 findings. Confidence remains available in diagnostics, while the normal UI communicates reliability through **Verified evidence** and expandable reasoning.

## Git data contract

Do not put a multi-megabyte patch in the global Zustand store. Keep only `workspaceSurface` globally in Phase 1. A mounted feature-local controller owns scope, selection, comments, manifests, lazy file patches, and request cancellation across Chat/Review switches. Later persisted review/thread IDs may be global, but patch bodies remain feature-local.

```ts
type GitReviewScope =
  | { kind: "workingTree" }
  | { kind: "staged" }
  | { kind: "unstaged" }
  | { kind: "branch"; base: string }
  | { kind: "commit"; revision: string };

interface GitReviewBranch {
  name: string;
  revision: string;
  kind: "local" | "remote";
  current: boolean;
}

interface GitReviewManifest {
  snapshotId: string;
  repositoryRoot: string;
  scope: GitReviewScope;
  baseLabel: string;
  targetLabel: string;
  headOid: string | null;
  files: GitChangedFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

interface GitChangedFile {
  path: string;
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unmerged";
  areas: Array<"staged" | "unstaged" | "untracked" | "committed">;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

interface GitFilePatch {
  snapshotId: string;
  path: string;
  filePatchHash: string;
  hunks: GitDiffHunk[];
  truncated: boolean;
}
```

Return typed hunks and lines from Rust. A unified-diff string is useful for logs, but it is the wrong UI contract for stable anchors and accessible line numbers.

## Native architecture

### Git service

Create `src-tauri/src/git_review.rs` and extract the hardened Git runner shared with `workspace.rs` into a small internal `git.rs` module.

Desktop commands:

```text
get_git_review_manifest(scope) -> GitReviewManifest
get_git_review_branches() -> GitReviewBranch[]
get_git_review_file(snapshot_id, path) -> GitFilePatch
start_git_review(snapshot_id, options) -> ReviewRunHandle
cancel_git_review(review_id)
```

`get_git_review_manifest` returns metadata only. `get_git_review_branches` lists concrete local and remote refs from the repository that owns the configured workspace, omitting symbolic aliases such as `origin/HEAD`; it accepts no frontend path. `get_git_review_file` lazily materializes and parses one patch. Starting an AI review materializes the bounded review corpus and computes a content-derived snapshot hash.

The file endpoint revalidates its snapshot both before and immediately after patch generation. It returns only ordinary two-way unified hunks and rejects combined merge-diff output as unsupported. Conflict entries can still be inspected when Git supplies an ordinary two-way patch; no Phase 1 action resolves or mutates a conflict.

The Git runner must:

- use `tokio::process::Command`, never a shell;
- set the repository with `current_dir` from application state, not a frontend-supplied root;
- pass fixed arguments, `--`, `--no-ext-diff`, and `--no-textconv` where applicable;
- set `GIT_OPTIONAL_LOCKS=0`, null stdin, `LC_ALL=C`, bounded stdout/stderr, and a timeout;
- use NUL-delimited status/name records so unusual paths are not split incorrectly;
- validate requested file paths against the manifest and repository root;
- synthesize untracked text patches with the existing Rust `similar` dependency rather than launching `git diff --no-index`;
- return binary/oversized-file summaries instead of attempting to render arbitrary bytes;
- cap total review bytes, per-file bytes, hunk count, and line count with explicit truncation metadata.

Resolve repository identity exclusively from the native settings workspace/current-directory fallback. Do not key a review from `Session.workspace`, which is historical session metadata and can drift from the workspace used by the next native agent run. Revision text must be resolved as a Git object with option parsing terminated; preferably select branches from a native-provided ref list instead of accepting arbitrary Git arguments.

Non-UTF-8 paths need an explicit policy. Never silently attach a finding to a lossy path; return a clear unsupported-path state when a path cannot round-trip through the Tauri/JSON boundary.

Use a content hash per file patch. When refresh produces a different `filePatchHash`, retain its threads but mark them outdated or needing re-check. Never silently move a finding to a nearby line based only on a line number.

### Review runner

Add `AgentConfig::review_run()` beside `default_run()` and `plan_run()`:

- tool registry: read-only workspace inspection only;
- prompt: dedicated code-review rubric and a strict structured result schema;
- persistence: review run/results, not ordinary chat messages;
- channel: `review://{reviewId}`, separate from `agent://{sessionId}`;
- cancellation: independent from the active chat turn;
- output: validated overall assessment plus zero or more findings.

The rubric should require:

- only actionable defects introduced by the selected change;
- a concrete failure mode and evidence;
- a short changed-line anchor whenever possible;
- no style/format/linter-only comments;
- no speculative findings or broad pre-existing cleanup;
- one issue per finding;
- an explicit `correct | incorrect | uncertain` overall assessment;
- permission to return zero findings.

Do not reuse Plan mode directly: it has the right tool boundary but the wrong behavioral steer and lifecycle.

### Fast and Deep modes

Ship **Fast** first: one read-only reviewer with a conservative confidence threshold.

Add **Deep** only after Fast is measurable. Deep may fan out fixed read-only specialists for correctness/data flow, security/concurrency, and tests/API contracts, followed by a verifier that reproduces, deduplicates, and ranks candidates. Every child must be constructed with a constrained read-only configuration; it must never inherit the default mutating subagent registry.

Before Deep starts, show scope size, provider/model, estimated time/cost, and the fact that selected code is sent to that provider. Deep runs in the background and is cancellable. Cancelled incomplete output is not published as findings.

## Frontend architecture

Suggested files:

```text
src/components/review/ReviewWorkspace.tsx
src/components/review/ReviewToolbar.tsx
src/components/review/ReviewFileList.tsx
src/components/review/ReviewDiff.tsx
src/components/review/ReviewThread.tsx
src/components/review/ReviewSummary.tsx
src/components/review/WorkspaceActivityProvider.tsx
src/lib/reviewAnchors.ts
src/lib/reviewPrompt.ts
```

Integration changes:

- `src/App.tsx`: route the main center surface between Chat and Review and close conflicting rails/docks.
- `src/store/store.ts`: add a small `workspaceSurface` slice plus open/close/select-thread actions; do not store patch bodies.
- `src/components/EnvironmentPanel.tsx`: make the Changes row open Review.
- `src/components/CommandPalette.tsx`: add Open review workspace.
- `src/lib/ipc.ts`: add typed commands, stream subscription, cancellation, and deterministic browser mocks.
- `src/types.ts`: add Git review, diff hunk, finding, and lifecycle types.

Move the Environment panel's queued refresh/stale-response logic into `WorkspaceActivityProvider`. Environment and Review should consume one native workspace identity and one refresh stream so they cannot poll independently and briefly display contradictory totals.

The existing diff colors can become shared CSS tokens. Do not export either current `DiffView`; both are optimized for bounded, display-only transcript content.

## Persistence and refresh

Persist review runs and threads locally in SQLite, keyed by repository identity and snapshot hash. Store anchors and short evidence, not entire duplicate patches. This supports returning to a review after switching sessions without keeping stale patch data in memory.

Refresh when:

- Review opens;
- the window regains focus;
- an agent turn ends;
- a fix request completes;
- the user presses Refresh;
- a low-frequency timer fires while Review is visible.

Reuse the Environment panel's queued-request pattern so overlapping refreshes coalesce and stale responses cannot overwrite newer state.

## Safety boundaries

- Review is read-only even when the global permission mode is `auto` or `bypass`.
- **Fix selected** is an explicit mode transition into the ordinary agent and its current permission policy.
- No automatic stage, commit, push, PR comment, approval, or merge.
- When later adding stage/unstage/revert, require the expected `filePatchHash`; fail closed if the patch changed.
- Revert is destructive and always receives a confirmation that names the exact file/hunk count.
- External posting and push actions must be visibly labeled as remote side effects.
- Repository review rules may refine severity, ignored paths, generated/vendor exclusions, and required evidence, but cannot loosen the read-only tool boundary.

## Accessibility and performance

- Use a keyboard-navigable tree/list for files and a grid-like diff with explicit old/new line labels.
- The add-comment affordance must appear on focus, not hover only.
- Findings are reachable both in a severity-sorted summary and at their inline anchor.
- Moving between a finding and its line preserves focus; closing Review restores focus to its opener.
- Announce new findings and stale-snapshot transitions in a polite live region without reading the full finding body.
- Virtualize diff rows rather than applying the transcript `MAX_DIFF_LINES = 500` truncation (post-Phase 1 performance follow-up).
- Lazy-load file patches, cancel superseded requests, and preserve per-file scroll positions.
- Oversized and binary diffs get explicit placeholders and an external-editor action.

## Delivery plan

### Phase 1 — trustworthy local diff

- Native manifest and lazy typed-patch commands.
- Full-width Review Workspace with scope selector and file/hunk navigation.
- Working tree, staged, unstaged, branch, and commit scopes.
- Refresh/staleness, binary and truncation states, browser mocks, accessibility.
- Manual line comments held in the current review.

### Phase 2 — review and fix loop

- Fast read-only review runner with structured findings.
- Severity/evidence filters and thread lifecycle.
- Local persistence keyed by snapshot.
- Batch comments/findings into **Fix selected** through the normal agent path.
- Focused re-check after a fix.

### Phase 3 — deeper review and Git handoff

- Verified multi-agent Deep review with cost/scope disclosure.
- Reliable Last agent turn snapshots.
- Stage/unstage by file and hunk with snapshot preconditions.
- Commit/push/PR handoff only after the local review workflow is proven.

## Test plan

Frontend changes under `src/` must ship with tests and pass `pnpm test:coverage`.

Critical frontend cases:

- surface routing, focus restore, and modal/dock exclusion;
- scope selection and resolved base/target labels;
- file grouping, rename/binary/unmerged/truncated states;
- keyboard file/hunk navigation and focus-visible comment creation;
- line anchor mapping on additions, deletions, and zero-context hunks;
- stale request suppression and queued refresh behavior;
- finding filters and every lifecycle transition;
- Fix selected payload ordering, snapshot identity, and permission-boundary copy;
- browser mock behavior.

Critical Rust cases, verified in CI per project policy:

- porcelain v2 and NUL-delimited rename/path parsing;
- initial repository, detached HEAD, no upstream, untracked, binary, submodule, and merge-conflict cases;
- branch merge-base and invalid/missing revisions;
- timeout, missing Git, output caps, invalid UTF-8, and external diff suppression;
- workspace containment and manifest-path validation;
- deterministic patch hashes and stale precondition failures;
- review mode never exposing mutating tools under any permission setting;
- malformed model output rejected without publishing partial findings.

## Success criteria

- A developer can open a 20-file working-tree diff and reach any changed line in two interactions.
- Initial manifest feels immediate; large patch bodies do not block the main thread.
- A review can return zero findings without pressure to create noise.
- Every published finding has a changed-line anchor or an explicit file-level reason, evidence, severity, and lifecycle state.
- No review action mutates Git or files until the user explicitly crosses into Fix or a later Git action.
- After files change, Portcode never presents an old anchor as if it were current.
