# Turn Completion Receipts

Status: Corrective Phase 1 desktop hot-path implementation landed on 2026-07-21.
The reported slow read-only turns and evidence-free `Changes unavailable` card are fixed
in the current change set. Phase 1 remains open for negotiated remote phase/catch-up
support and exhaustive cross-platform rollout proof.

> **Document role:** durable lifecycle and attribution contract. Work order for
> historical patches and Git Review follow-ups lives in [`ROADMAP.md`](ROADMAP.md).

## Implementation checkpoint — 2026-07-21

The desktop path now implements the corrective behavior that prompted this revision:

- Tracker construction is capture-free. Plain chat, read-only tools, denied operations,
  and cancellation before a mutation permit do not start receipt-related Git work.
  Exact-path writes validate an approval-time precondition again at the side-effect
  boundary; opaque tools prepare one shared baseline immediately before process spawn.
- The mutation ledger is sticky and shared across foreground, background, and subagent
  work. It distinguishes no-effect operations from possible writes, freezes the agent
  outcome before optional capture, and prevents late work from rewriting a closed receipt.
- Terminal attribution uses bulk index metadata instead of one `git ls-files` child per
  dirty path. Exact-path verification is bounded, full capture has a constant child-process
  ceiling, global capture concurrency is capped at two, and queue plus capture plus
  comparison share a two-second terminal deadline. `PORTCODE_DISABLE_TURN_GIT_ATTRIBUTION`
  can disable Git evidence without disabling lifecycle receipts.
- The native core persists the known agent outcome and frozen response duration before
  Git finalization. A local desktop `agent_completed` phase immediately exposes the answer,
  hides Stop, freezes `Done in`, and leaves drafting available while Send is briefly held
  for the bounded receipt. Older remote peers continue to receive only the established
  terminal event, so no unsupported wire variant is sent to them.
- Foreground command output is drained concurrently, and Stop/timeout kills and reaps the
  command promptly. On Windows, the bounded cancellation path terminates the root process
  tree before reaping the shell, preventing a surviving descendant from continuing to
  mutate the workspace after the turn has stopped.
- Successful receipts are quiet inline metadata. The changed-files surface now requires
  positive change evidence, so chat, clean/non-Git work, and legacy empty `unavailable`
  receipts no longer render `Changes unavailable`.

Verification completed for this checkpoint includes the full frontend coverage run
(57 files, 1,662 tests; 96.24% statements, 98.08% lines, 97.76% functions), frontend
type-checking and linting, 402 desktop-core library tests, 56 sync-library tests, the full
Rust workspace test run, formatting, and Clippy with warnings denied. Native coverage added
with the implementation includes a deterministic 200-dirty-file fixture that asserts full
capture stays within eight Git children, plus parser, exact-path, mutation-gating,
stale-precondition, cancellation, Windows descendant-process cleanup, and recovery cases.
This evidence is intentionally narrower than the exhaustive rollout proof defined by the
acceptance matrix below.

Still open before the entire plan can be called complete:

- capability negotiation for remote `turn_phase_v1`, phase/revision catch-up snapshots,
  and end-to-end capable-versus-legacy peer tests;
- the complete 0/10/100/1,000/2,000 dirty-worktree benchmark matrix and p95 validation on
  supported operating systems and repository/storage profiles;
- full cross-platform crash, concurrency, high-volume output, mobile accessibility,
  telemetry, kill-switch, and staged-rollout validation from the acceptance matrix.

## Product contract

Every accepted root agent turn owns one durable `turnId`. Portcode mounts a stable lifecycle row when that turn starts and moves it through `Starting`, `Working`, `Waiting for approval`, an optional bounded `Checking file changes`, and one terminal state. While agent work is live, the row keeps state and elapsed time easy to find. The timer freezes as soon as the agent outcome is known; Git finalization is not counted as agent work. A successful settled turn becomes quiet inline metadata (`Done in 10s`) so repeated receipts do not compete with the assistant's answer. Waiting, stopped, failed, and interrupted states remain visually distinct because they can require attention.

The assistant's final Markdown remains the summary of what was done. Portcode does not run a second model call to manufacture another prose summary.

A terminal receipt may append a compact Git evidence surface after the assistant text. A normal changed-files card requires positive evidence of a net Git change: a non-zero bounded file count/list or defensively non-zero line totals. Git applicability, capture uncertainty, truncation, or a running background task is not by itself evidence that a file changed. Therefore read-only tasks, non-Git workspaces, clean turns, legacy empty `unavailable` receipts, and recovered zero-file interruptions do not render Git chrome.

Lifecycle is independent of Git attribution. Portcode must not inspect a repository merely to render `Starting`, `Working`, or `Done`. Plain conversation, read-only tools, Plan mode, denied mutations, and cancellation before a side effect execute zero receipt-related Git subprocesses.

There is one fail-closed warning case: required attribution input failed, a first-class exact-path write independently proved that bytes changed, and a stable terminal Git manifest still contains that exact path as reviewable state under its Git root. The surface may say that Git changes could not be verified, but it must not turn the write count into a claim about a wider boundary-to-boundary net delta, show unproven line totals, or offer Review. If terminal verification itself fails, no remaining Git delta can be proven and the surface stays hidden.

When rendered, the card includes bounded paths and non-zero line totals, attribution certainty, truncation state, and relevant incomplete-turn provenance. It never offers Undo: rollback is a separate, permission-gated workflow with different safety requirements.

## Presentation hierarchy

- **Live lifecycle:** `Starting`, `Working`, and `Waiting for approval` remain a stable, accessible status surface. Once the agent outcome is known, the answer is shown, the work timer freezes, and Stop disappears. If bounded Git finalization is perceptible, the same row may quietly say `Response complete · Checking file changes…`; it must not look as though the model is still thinking.
- **Settled success:** render as low-contrast inline metadata without a full-width box, glow, or pulse. If observable activity exists, the metadata is the disclosure trigger; otherwise it is non-interactive.
- **Exceptional terminal states:** stopped, failed, and interrupted turns retain semantic labels and restrained warning/error color. Unknown crash-recovery duration is never guessed.
- **Assistant result:** the Markdown answer is always the primary visual content. Tool/subagent activity is manually disclosed and hidden provider reasoning never appears.

Static historical receipts keep an accessible label but must not each mount a live `status` announcement when a session loads or older messages paginate into view. Only live lifecycle transitions and a terminal transition observed by the mounted turn may announce.

## Changed-files display decision

| Receipt evidence                                             | Git card     | Required behavior                                                                    |
| ------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------ |
| Positive file count/list or positive line totals             | Yes          | Show ownership-safe copy, bounded rows, and only non-zero totals.                    |
| Positive evidence with `observed` or `ambiguous` attribution | Yes          | Qualify ownership; never claim the agent exclusively caused the delta.               |
| Positive evidence with `unavailable` attribution             | Warning only | Say the change could not be verified; do not offer Review without a usable manifest. |
| Zero evidence with `exact` or `observed`                     | No           | A clean/read-only turn needs no Git chrome.                                          |
| Zero evidence with `ambiguous` or `unavailable`              | No           | Uncertainty alone is diagnostic state, not a change summary.                         |
| Truncation or background work with zero evidence             | No           | These qualify known changes; they do not create them.                                |
| Non-Git/no workspace/Git unavailable with zero evidence      | No           | Preserve the lifecycle receipt and omit Git UI entirely.                             |

`changedFileCount` describes the full known delta when both captures completed without membership truncation; `changedFiles` is the bounded displayed subset. When the baseline is missing, a positive unavailable count is only a lower bound of confirmed writes whose paths remain in the terminal Git manifest and is never presented as a boundary-to-boundary change count. A positive truncated snapshot result uses lower-bound/incomplete language rather than presenting its list or totals as exhaustive. Binary-only changes still render a file row without manufacturing `+0 -0` totals.

## Lifecycle and persistence

- The native core creates the root `turnId` and persists a pending crash-recovery placeholder before provider work begins. Pending rows are never exposed as completed receipts. On the next process start, an abandoned row becomes `process_interrupted` with unknown duration instead of a guessed elapsed time.
- All assistant and tool-result database rows for the root turn carry that ID. Reload grouping therefore reconstructs the same assistant bubble instead of relying on adjacency heuristics.
- When provider/tool work reaches an outcome, the core first persists an `agent_terminal` checkpoint with the outcome and agent duration. Git finalization starts only after that checkpoint. A crash before it recovers as `process_interrupted`; a crash after it preserves `completed`, `stopped`, or `failed` and marks Git evidence unknown instead of rewriting a delivered answer as interrupted.
- A receipt-ready terminal event carries the persisted receipt for completed, stopped, failed, and interrupted turns. `agentDurationMs` is omitted when the interruption instant is unknowable. Older peers may omit the new fields; the frontend treats those frames as legacy rather than inventing historical timing.
- Stop and error paths retain any observed file delta. A receipt may say attribution is unavailable or ambiguous, but it must not claim exact ownership without evidence.
- Root-turn completion is the attribution boundary. Writes performed later by a still-running background task are not silently folded into the closed receipt.
- Terminal persistence and capture have one bounded retry policy. Failure produces a terminal, non-reviewable receipt; it never leaves the composer locked or causes the core to retry indefinitely.

## Change attribution

Attribution begins at the first approved operation that can actually mutate, not when the user sends a message. Exact-path tools retain a validated preimage immediately before applying their side effect. Opaque workspace tools, such as shell commands, take one full baseline immediately before process spawn. A terminal identity is captured only when the frozen mutation ledger says Git may have changed. Pre-existing dirty files are included only when their identity changes inside the relevant mutation window. File lists and content reads obey native caps; reaching a cap is surfaced through `filesTruncated` and reduced certainty instead of being hidden.

Every tool has a required mutation class:

| Mutation class     | Examples                                                                       | Receipt capture contract                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `read_only`        | chat, search/read, planning, opening a manager                                 | No baseline, terminal snapshot, hashing, or Git subprocess.                                                                                                                    |
| `exact_path`       | first-class create/edit/write with known targets                               | After approval, validate and retain each target's first preimage. At the terminal boundary, inspect only the bounded touched-path set, and only if a side effect may have run. |
| `opaque_workspace` | foreground/background shell and any mutator whose complete targets are unknown | Take one full baseline immediately before the process or side effect can start, then one full terminal snapshot if it may have mutated.                                        |

An unclassified tool that can mutate defaults to `opaque_workspace`, and a registry test prevents new mutating tools from silently omitting a class. Classification is capability-based, not inferred from the model's prose or command text.

Mutation preparation follows one ordering everywhere:

```text
preview/precondition -> permission decision -> cancellation check
-> exact preimage validation OR opaque baseline -> cancellation recheck
-> mutation permit -> possible side effect
```

Permission denial and cancellation before the mutation permit perform no receipt-related Git work. A preview carries the canonical target, existence, and preimage identity; exact-path tools revalidate those facts immediately before applying. If an external process changes the target while permission or preparation is pending, the tool aborts or asks again rather than overwriting against a stale preview. Baseline failure is cached once as an attribution result, not retried for each tool, and does not revoke an already approved operation. Cancellation during baseline prevents that operation from starting.

The root turn and all of its subagents share one mutation ledger and capture gate. The ledger is `pristine`, `active`, `no_effect`, or sticky `may_have_mutated`:

- argument validation, a same-byte exact write, a pre-side-effect failure, or shell spawn failure can settle as `no_effect`;
- the guard changes to `may_have_mutated` at the first point bytes could have changed, on a partial/unknown write, or after any opaque process successfully spawns;
- once set, `may_have_mutated` is not cleared merely because a later operation appears to restore the original bytes;
- an exact operation followed by an opaque operation retains the exact ledger, takes the opaque baseline at the later boundary, and unions the evidence; overlapping paths become ambiguous;
- the terminal boundary seals a clone of the ledger before capture. No later foreground mutation may enter it, and a background completion during capture cannot rewrite the frozen receipt.

Terminal capture is selected from the frozen ledger rather than run unconditionally:

| Frozen turn state                                        | Terminal work and result                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| No operation may have mutated                            | Zero Git work; quiet lifecycle receipt.                                                                            |
| Exact-path operations only, all proven no-op             | Zero terminal work; quiet lifecycle receipt.                                                                       |
| Exact-path operation may have changed                    | One bounded, bulk touched-path verification. A clean comparison renders no card.                                   |
| Any opaque operation may have changed                    | One bounded full snapshot. A clean comparison renders no card.                                                     |
| Background writer is still running at the seal           | Capture the frozen boundary if possible and mark overlapping evidence ambiguous; later writes never patch the row. |
| Required baseline unavailable, exact changed path proven | Permit only the lower-bound warning defined in the product contract.                                               |
| Terminal capture fails, times out, or is non-comparable  | Preserve the agent outcome, emit no positive Git card, and offer no Review.                                        |

Two simultaneous root turns or detached background writers against the same canonical repository are coordinated. Capture is serialized per repository, but overlapping mutation windows still reduce attribution to `ambiguous`; serialization alone cannot prove ownership.

Certainty is user-visible:

- `exact`: the native lifecycle can safely attribute the captured delta to this turn.
- `observed`: the delta occurred between turn boundaries, but exclusive ownership is not proven.
- `ambiguous`: concurrent or incomplete activity prevents reliable ownership.
- `unavailable`: the workspace could not be captured safely or is not reviewable as Git state.

Certainty qualifies a known or possible delta; it does not decide whether the card exists. For compatibility with receipts written before an orthogonal change-state field exists, the frontend derives presentation as follows:

- positive file/count/line evidence means `changed`;
- empty `unavailable` means legacy/unknown and is suppressed;
- every other empty receipt means no displayable net Git change.

The native tracker should reserve positive `unavailable` evidence for a confirmed first-class write whose path remains in a terminal Git manifest when the baseline could not be captured, and expose only a lower-bound file count. The frontend still suppresses empty `unavailable` cards to avoid false warnings from persisted legacy and client fallback receipts.

## Responsiveness and resource contract

Receipt attribution is optional metadata on the critical path, so it has a smaller budget than agent work and must fail closed when that budget expires. Dirty-file count may increase parsing and bounded hashing work, but it must not increase the number of child Git processes linearly.

- A boundary uses constant-process bulk metadata: preferably porcelain-v2 records with index/worktree identities, or one bulk `git ls-files --stage -z --full-name` for the entire index. Portcode must never launch one `git ls-files` process per dirty path.
- Normal command budgets are zero for `read_only`, at most three total for an exact-only turn, and at most four per full boundary/eight per opaque turn. A single consistency retry may raise the absolute ceilings to six exact or eight per boundary/sixteen per opaque turn. Counts remain constant for 0, 10, 100, 1,000, or 2,000 dirty paths.
- Status A, bounded identities, and Status B validate a stable boundary. There is at most one retry inside the same total deadline; Portcode never loops until a busy repository becomes stable.
- Receipt overhead for a read-only/no-mutation turn is p95 at or below 50 ms with a 100 ms hard ceiling. A snapshot with up to 100 dirty entries is p95 at or below 750 ms; 1,000 entries is p95 at or below 1.5 s. Post-answer finalization has a two-second wall-clock ceiling, including queueing and retry, after which it terminalizes without Git evidence.
- Git output is capped at 4 MiB, one boundary at 32 MiB, and concurrent receipt attribution at 64 MiB. Existing per-file hash limits remain enforced. Line-diff CPU work has its own deadline and bounded worker concurrency; totals are omitted if that budget expires.
- Capture concurrency is one per canonical repository and at most two globally. Queue time consumes the same deadline. No mutable Git snapshot, dirty manifest, hash, HEAD, or index result is cached across turns; only immutable runner capabilities may be cached.
- Git commands never use a shell. They disable prompts, pagers, optional locks, fsmonitor, external diff, and text conversion; use deterministic locale and bounded stdout/stderr drains; and kill the process tree on timeout or cancellation. Windows tests verify that no orphan Git process survives.
- Parsing is NUL-delimited and byte-safe. Spaces, tabs, newlines, Unicode, pathspec-like names, rename pairs, all unmerged stages, and lossy/colliding names either remain distinct or degrade safely. If a fallback must pass paths, it uses literal pathspecs and batches below a conservative Windows UTF-16 command-line limit, with a hard batch-count ceiling.
- Symlink metadata is inspected without following a path outside the root. Submodules are represented as one gitlink/OID/dirty token without recursion. Nested repositories and `.git` internals never leak into a parent receipt. Root changes, index/HEAD races, malformed/truncated records, unsafe repositories, and repository access failures produce non-comparable evidence rather than guessed changes.

Development and production telemetry records only durations, command counts, dirty-entry buckets, timeout/degradation reasons, and certainty outcomes. It never logs file contents, command output, or unsanitized paths. A runtime kill switch may disable Git attribution while preserving lifecycle receipts if the hard budget regresses.

## Truthful finalization and remote protocol

Agent completion and receipt readiness are separate facts. Git evidence must never postpone the assistant answer or make the UI claim the model is still working.

| Lifecycle moment          | Visible behavior                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accepted/starting         | Stable lifecycle row; Stop is available when the backend can still stop work.                                                                                |
| Provider/tools active     | `Working`, tool activity, or `Waiting for approval`; transcript is busy and the agent timer runs.                                                            |
| Stopping                  | Stop remains visible until the backend acknowledges the outcome.                                                                                             |
| Agent outcome known       | Render the answer and terminal outcome, freeze `Done in`, hide Stop, clear transcript busy state, and enable draft editing.                                  |
| Git finalization <250 ms  | Do not flash an intermediate label; settle directly to the quiet receipt.                                                                                    |
| Git finalization >=250 ms | Show `Response complete · Checking file changes…`. Keep Send disabled only until the bounded boundary seals, never beyond the two-second finalization limit. |
| Receipt ready/degraded    | Enable Send, retain the quiet terminal metadata, and append a Git card only when the evidence table permits it.                                              |

The optional checking label is announced only when it lasts roughly 750 ms or more. There is one polite, atomic lifecycle announcer for the active session; historical rows never mount live regions, timer ticks are silent, and finalization does not announce completion twice. When Stop disappears, focus moves predictably to the draft or Send control. Color is never the only state cue, reduced motion is honored, and mobile controls retain their touch targets.

New timing facts are explicit: `acceptedAt`, optional `providerStartedAt`/`firstActivityAt`, `agentCompletedAt`, `agentDurationMs`, and `receiptReadyAt`. `Done in` uses accepted-to-agent-completed monotonic duration, including genuine approval/tool waiting but excluding receipt finalization. New clients prefer `agentDurationMs`; legacy rows continue to use `durationMs` without rewriting history.

A capability-gated `turn_phase_v1` event communicates `provider_started` and `agent_completed` with `turnId`, monotonic `revision`, timestamp, outcome, stop reason, and agent duration where applicable. Existing TurnEnd/Error remains the receipt-ready event. Peers advertise the capability during Hello; the core never sends an unknown enum variant to an older Rust client. Catch-up snapshots include the current phase and revision. Events are idempotent by `(turnId, revision)`, and a late receipt patches its own turn even when another turn or background session is active.

## Edge-case policy

- A read-only or non-file task produces only the quiet lifecycle receipt.
- Plan mode, permission denial, cancellation while permission is open, and cancellation before a mutation permit perform zero receipt-related Git capture.
- An untouched pre-existing dirty file is excluded. If that same file changes during the turn, counts describe only the boundary-to-boundary delta.
- A write that returns the workspace to its starting identity produces no card.
- A failed edit before bytes are written, a same-byte write, or a shell that fails to spawn is not change evidence. A partial write, non-zero shell exit after spawn, timeout after spawn, or cancellation after a possible write still requires terminal capture.
- External edits during model thinking or permission wait precede the mutation boundary and are excluded. An external edit to an exact target after its preview fails revalidation rather than being attributed or overwritten.
- A foreground shell delta is `observed`; overlapping, external, repository-identity, or active-background uncertainty degrades it to `ambiguous`.
- Multiple exact and opaque operations are unioned. Exact-path evidence survives a later opaque baseline; overlap is ambiguous, and an A-to-B-to-A sequence still captures terminal state before correctly rendering no card.
- A cancelled, failed, or interrupted turn shows a Git card only when a positive delta remains; its provenance states that changes may remain from an incomplete turn.
- Background work belongs to lifecycle/activity UI. Capture occurs before child spawn. The mutation guard transfers to the waiter only after successful spawn, a running task with no current delta does not create a Git card, and writes landing after root-turn completion never mutate the closed receipt. Detached or otherwise unobservable writers force opaque/ambiguous handling rather than extended waiting.
- Stop during opaque baseline aborts capture and prevents the tool from starting. After a mutation may have occurred, terminal evidence collection ignores user cancellation but remains subject to the hard finalization deadline.
- Concurrent root turns, a previous turn's background writer, or several subagents share repository coordination. A pure chat turn still performs no capture; a mutating overlap yields ambiguous evidence rather than assigning another turn's write.
- A tool-only turn with no assistant Markdown still retains lifecycle and observable activity, but Portcode never invents a textual summary.
- Mobile/remote clients receive the same facts. Positive changes remain readable, while the action becomes `Review on desktop`; legacy rows without receipt facts keep legacy rendering and never receive unsupported phase variants.
- HEAD/branch/commit movement with a clean file delta is not a changed-files card. A future repository-state receipt may represent that separately.
- Truncated snapshot membership never turns cap churn into fabricated additions or deletions; rows shared by both boundaries may still provide a lower-bound delta.
- A repository-root change makes the two boundaries non-comparable and produces no cross-repository file manifest.
- `.git` metadata, ignored paths, and nested-repository internals do not create a missing-baseline warning unless the terminal manifest exposes the exact path as reviewable state. Index-only changes and submodule gitlinks are represented only when both boundaries can compare them safely.
- Large-file identity work is bounded. Content beyond the hash budget reduces certainty and may be omitted instead of using timestamps or file length as false change evidence.
- If terminal receipt persistence fails, the answer and outcome remain final. Counts and totals may remain visible, but the bounded manifest is withheld so Review is not offered for a row that cannot be retrieved.
- App shutdown before `agent_terminal` recovers as interrupted. Shutdown after that checkpoint preserves the known outcome and suppresses unfinished Git evidence. Database contention, capture timeout, and malformed output all settle within the same deadline.

## Historical Review behavior

The Review button opens a turn-scoped manifest, not the live working-tree scope. Portcode persists the terminal manifest and snapshot identity. It never regenerates an old line patch from a different current tree. When immutable patch bytes are not available, the file summary remains visible and the line diff is explicitly reported as unavailable.

General Review entry points reset the target to the live workspace. Chat and Review remain mounted as sibling surfaces, so changing surfaces preserves the current controller state without background polling while hidden.

## Corrective Phase 1 work order

This is one reopened Phase 1, not a new product phase. The workstreams remain the
authoritative order; the dated checkpoint above records which desktop portions have
landed. Phase 1 remains incomplete until all acceptance gates pass:

1. **Guard and measure — desktop latency path landed; rollout telemetry remains:** remove tracker construction from the eager Git path, add sanitized duration/command-count/degradation telemetry, and provide the Git-attribution kill switch. A read-only turn must hit the zero-capture path before further receipt work ships.
2. **Separate agent outcome from receipt readiness — desktop persistence landed; negotiated remote phases remain:** add the `agent_terminal` checkpoint, optional timing/change-state fields, schema migration/defaults, and capability-gated phase protocol. Preserve completed/stopped/failed outcomes across capture crashes.
3. **Introduce the mutation ledger — implementation landed; exhaustive concurrency proof remains:** classify every tool, enforce permission/cancellation/preimage ordering, share one tracker across subagents, make mutation evidence sticky, and seal the root boundary against late foreground/background writes.
4. **Replace per-path Git execution — bulk desktop path landed; cross-platform process proof remains:** implement bulk, byte-safe metadata parsing; bounded exact-path and full-workspace capture; consistency validation; repository/global capture coordination; deadlines; and process-tree cleanup.
5. **Wire truthful UI states — desktop behavior landed:** expose the answer at agent completion, freeze the agent timer, show the checking label only beyond its delay, bound Send locking, suppress evidence-free Git chrome, and retain the quiet visual/accessibility hierarchy on desktop and mobile.
6. **Prove and roll out — open:** run the full correctness, crash, concurrency, compatibility, adversarial-path, and dirty-worktree benchmarks below. Exercise the kill switch and degradation path before enabling attribution by default.

No workstream may restore eager capture as a fallback. If exact or opaque capture cannot meet its safety or time budget, lifecycle completes without a Git card.

## Phase 1 boundaries

- Observable tool and subagent activity may appear in the manual disclosure; hidden provider reasoning never does.
- The file list is compact and bounded. Large-list virtualization and richer per-file navigation remain follow-ups.
- Durable historical patch blobs, cleanup/retention policy for those blobs, and exact old-snapshot line comments remain follow-ups.
- AI review lifecycle, structured findings, staging, rollback, commit, push, and PR actions remain separate future work.

## Acceptance matrix

Phase 1 receipt behavior is complete only when tests prove:

- **Capture gating:** spy capturers prove chat, read/search, Plan mode, opening a manager, permission denial, and pre-mutation cancellation execute zero receipt-related Git processes. Exact same-byte writes, pre-side-effect failures, and spawn failures perform no terminal capture.
- **Mutation ordering:** approval precedes preparation; stale exact previews are rejected; cancellation during an opaque baseline prevents process spawn; a failed baseline is cached once while approved tools may continue. Four concurrent subagents share one baseline/terminal capture, and no side effect crosses the capture barrier early.
- **Mutation outcomes:** exact changes, partial writes, opaque non-zero exits, post-spawn timeout/cancel, write-then-revert, exact-then-opaque overlap, foreground/background overlap, two background writers, and a background completion during blocked terminal capture all obey the sticky ledger and frozen boundary.
- **Scalability:** 0, 10, 100, 1,000, and 2,000 dirty-path fixtures stay within the constant command ceilings. Reference dirty-worktree benchmarks meet the p95 targets and two-second finalization ceiling. Delayed/flooding fake Git processes prove deadline propagation, bounded output/memory, and no orphan process on Windows.
- **Git correctness:** fixtures cover staged, unstaged, index-only, ignored, untracked, binary, large, same-size content changes, add/delete, rename/copy, case-only paths, unmerged stages, symlinks, submodules, nested repositories, and pre-existing dirty files. Filenames include spaces, tabs, newlines, Unicode, pathspec syntax, and long Windows command lines.
- **Fail-closed capture:** missing Git, non-repository roots, unsafe/corrupt/locked repositories, missing one or both boundaries, root/symlink retargeting, HEAD/index races, output truncation in a NUL record, membership caps, and hash/diff budget exhaustion never fabricate a file count, line total, or Review action.
- **Lifecycle UX:** the assistant answer becomes visible at `agent_completed`; `Done in` excludes finalization and freezes; Stop disappears; draft editing resumes; checking never appears for fast/no-capture turns; slow checking uses distinct copy and settles by the deadline. Empty/unknown/legacy receipts never render `Changes unavailable`.
- **Presentation/accessibility:** successful historical receipts are quiet metadata; active/waiting/error states remain discoverable; session load/pagination do not announce completions; one live announcer avoids duplicate completion; focus recovers when Stop disappears; reduced motion and narrow/mobile touch targets pass.
- **Positive evidence UI:** exact, observed, ambiguous, binary, renamed, deleted, truncated, stopped, failed, and interrupted positive deltas use honest copy and bounded rows. Zero totals are omitted, lower bounds say they are incomplete, and Review appears only for a retrievable usable manifest.
- **Persistence/recovery:** crashes before baseline, during mutation, after `agent_terminal`, during terminal capture, and after receipt save recover to the specified state. Database contention/failure settles without unbounded retry and withholds Review when the manifest is not durable.
- **Remote compatibility:** capable peers receive ordered, idempotent phase/catch-up updates; a late receipt patches the correct turn; background sessions do not hijack the active composer; and legacy Rust/mobile peers receive no unsupported enum and retain their old terminal path within the deadline.
- **Rollout safety:** telemetry contains no paths/content, performance alerts exercise the runtime kill switch, and disabling Git attribution leaves lifecycle persistence and terminal UI intact.

## Corrective Phase 1 data model

The durable model currently overloads `changeCertainty` with three questions: whether Git applies, whether a net delta exists, and how attributable that delta is. Corrective Phase 1 adds an optional/defaulted orthogonal state:

```text
changeState = not_applicable | none | changed | unknown
```

`changeCertainty` then qualifies only `changed` or `unknown`. Optional `acceptedAt`, `providerStartedAt`, `firstActivityAt`, `agentCompletedAt`, `agentDurationMs`, and `receiptReadyAt` separate response time from post-processing time. A sanitized reason code may distinguish `not_repository`, `capture_failed`, `timed_out`, `non_comparable`, and `background_overlap`; it never stores raw command output or a path.

All new fields are defaulted and backward compatible. New UI prefers explicit change state and agent duration. Old rows retain the current evidence-derived display rules and `durationMs`; old peers may ignore the additions. The persisted `agent_terminal` checkpoint is internal lifecycle state and cannot be rendered as a completed receipt until a terminal/degraded receipt row is sealed.
