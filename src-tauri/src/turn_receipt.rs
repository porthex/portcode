//! Root-turn mutation provenance and immutable completion-receipt construction.
//!
//! The tracker is shared by the root and all subagents. It never attempts to
//! infer authorship from `git diff` alone: first-class file tools record expected
//! terminal bytes, foreground commands are opaque/observed, overlaps and active
//! background work are ambiguous, and capture failures are unavailable.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fmt::Write as _;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Instant;

use portcode_sync::wire::{
    TurnChangeCertainty, TurnChangeState, TurnChangedFile, TurnFileStatus, TurnReceipt, TurnStatus,
};
use sha2::{Digest, Sha256};
use similar::{ChangeTag, TextDiff};

use crate::db;
use crate::git_review::{self, GitChangeStatus, TurnWorkspaceEntry, TurnWorkspaceSnapshot};

const MAX_RECEIPT_FILES: usize = 200;
const CANCEL_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(10);
const MAX_EXACT_CONTENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_EXACT_CONTENT_TOTAL: usize = 32 * 1024 * 1024;
/// `similar` performs a synchronous Myers diff. Keep it comfortably below the
/// Git capture deadline so a receipt cannot move the latency spike from I/O to
/// post-capture CPU work.
const MAX_LINE_DIFF_BYTES: usize = 256 * 1024;
const MAX_LINE_DIFF_LINES: usize = 4_096;
const MAX_LINE_DIFF_PRODUCT: usize = 1_000_000;
const CAPTURE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(2);
const MAX_CONCURRENT_CAPTURES: usize = 2;
const DISABLE_GIT_ATTRIBUTION_ENV: &str = "PORTCODE_DISABLE_TURN_GIT_ATTRIBUTION";

static CAPTURE_PERMITS: tokio::sync::Semaphore =
    tokio::sync::Semaphore::const_new(MAX_CONCURRENT_CAPTURES);
static ACTIVE_REPOSITORY_TURNS: OnceLock<Mutex<BTreeMap<PathBuf, Vec<Weak<AtomicBool>>>>> =
    OnceLock::new();

/// Durable fail-closed row written before `TurnStart` is emitted or any async
/// workspace capture begins. A crash in that window therefore reloads as an
/// interrupted turn with unavailable provenance rather than disappearing.
#[cfg(test)]
pub(crate) fn unavailable_interrupted_receipt(turn_id: &str, started_at: i64) -> TurnReceipt {
    unavailable_interrupted_receipt_with_account(turn_id, started_at, None)
}

/// Account-attributed form used once session admission has resolved the immutable
/// local profile for the run. The legacy wrapper above remains available for
/// providers and pre-admission failures that have no ChatGPT profile.
pub(crate) fn unavailable_interrupted_receipt_with_account(
    turn_id: &str,
    started_at: i64,
    account_profile_id: Option<String>,
) -> TurnReceipt {
    TurnReceipt {
        turn_id: turn_id.to_string(),
        account_profile_id,
        status: TurnStatus::Interrupted,
        stop_reason: None,
        started_at,
        completed_at: started_at,
        duration_ms: None,
        agent_duration_ms: None,
        changed_files: Vec::new(),
        changed_file_count: 0,
        additions: 0,
        deletions: 0,
        files_truncated: false,
        change_state: Some(TurnChangeState::Unknown),
        change_certainty: TurnChangeCertainty::Unavailable,
        background_tasks_running: false,
    }
}

#[derive(Clone, Debug)]
struct ExactWrite {
    sequence: u64,
    before_hash: Option<String>,
    before_content: Option<Arc<[u8]>>,
    before_missing: bool,
    expected_hash: String,
}

#[derive(Clone, Debug, Default)]
struct MutationState {
    next_sequence: u64,
    active_mutations: usize,
    mutation_attempted: bool,
    may_have_mutated: bool,
    overlapping: bool,
    uncertain_mutation: bool,
    last_opaque_sequence: u64,
    opaque_seen: bool,
    exact_writes: BTreeMap<PathBuf, ExactWrite>,
    exact_content_bytes: usize,
    /// Absolute paths for first-class writes that completed and actually changed
    /// bytes. Kept separately from `exact_writes` because the baseline capture may
    /// have failed before a repository root was known; a later successful boundary
    /// can still prove that the write landed inside a reviewable Git worktree.
    confirmed_exact_paths: BTreeSet<PathBuf>,
    terminal_exact_paths: BTreeSet<PathBuf>,
    background_running: usize,
    background_ever: bool,
}

/// One root turn's baseline plus the mutation facts recorded by every actor in
/// its subagent tree.
pub(crate) struct TurnReceiptTracker {
    turn_id: String,
    account_profile_id: Option<String>,
    started_at: i64,
    started: Instant,
    workspace: PathBuf,
    /// Full-worktree baseline initialized only when an opaque mutator is about to
    /// run. `Some(None)` means capture was attempted and failed; that failure is
    /// cached for the turn so concurrent actors cannot start retry storms.
    opaque_baseline: tokio::sync::OnceCell<Option<Arc<TurnWorkspaceSnapshot>>>,
    /// Every mutator holds this gate exclusively across `tool.run`. The first
    /// opaque capture keeps the same guard, so no actor can mutate through its
    /// baseline boundary and overlapping exact writes are deterministically queued.
    mutation_gate: Arc<tokio::sync::RwLock<()>>,
    state: Mutex<MutationState>,
    sealed_outcome: OnceLock<SealedAgentOutcome>,
    repository_overlap: Arc<AtomicBool>,
    repository_turn: Mutex<Option<RepositoryTurnRegistration>>,
}

struct RepositoryTurnRegistration {
    root: PathBuf,
    marker: Arc<AtomicBool>,
}

impl Drop for RepositoryTurnRegistration {
    fn drop(&mut self) {
        let registry = ACTIVE_REPOSITORY_TURNS.get_or_init(|| Mutex::new(BTreeMap::new()));
        let mut registry = registry.lock().unwrap();
        if let Some(markers) = registry.get_mut(&self.root) {
            markers.retain(|marker| {
                marker
                    .upgrade()
                    .is_some_and(|marker| !Arc::ptr_eq(&marker, &self.marker))
            });
            if markers.is_empty() {
                registry.remove(&self.root);
            }
        }
    }
}

#[derive(Clone, Debug)]
struct SealedAgentOutcome {
    status: TurnStatus,
    stop_reason: Option<String>,
    completed_at: i64,
    duration_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MutationKind {
    Exact,
    Opaque,
}

/// How much provenance a mutating tool needs before it may run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MutationScope {
    /// First-class file tools retain their own target preimage and need no full
    /// worktree capture before executing.
    Exact,
    /// Shell/background work can touch arbitrary paths and therefore requires a
    /// shared, lazy full-worktree baseline.
    Opaque,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PrepareMutationError {
    Cancelled,
}

/// Held exclusively by the caller across `tool.run`, preventing either another
/// exact write or an opaque baseline from racing through the mutation boundary.
pub(crate) struct MutationPermit {
    _guard: tokio::sync::OwnedRwLockWriteGuard<()>,
}

/// What a first-class file tool could prove after its write returned. A missing
/// pre-write read is deliberately `Unknown`, not `Changed`: it may have written
/// identical bytes and therefore cannot serve as positive receipt evidence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExactWriteOutcome {
    Changed,
    Unchanged,
    Unknown,
}

/// RAII token so an early tool error still closes the active mutation interval
/// and marks its provenance uncertain rather than silently claiming no effect.
pub(crate) struct MutationToken {
    tracker: Arc<TurnReceiptTracker>,
    sequence: u64,
    kind: MutationKind,
    completed: bool,
}

impl Drop for MutationToken {
    fn drop(&mut self) {
        if !self.completed {
            self.tracker.finish_uncertain(self.sequence, self.kind);
        }
    }
}

impl MutationToken {
    pub(crate) fn finish_exact(
        mut self,
        full_path: &Path,
        previous: Option<&[u8]>,
        expected: &[u8],
        outcome: ExactWriteOutcome,
    ) {
        self.tracker
            .finish_exact(self.sequence, full_path, previous, expected, outcome);
        self.completed = true;
    }

    pub(crate) fn finish_observed(mut self) {
        self.tracker.finish_observed(self.sequence, self.kind);
        self.completed = true;
    }

    /// Close a guard after a proven pre-side-effect failure (for example, command
    /// construction or spawn failed). This is not mutation evidence and therefore
    /// must not trigger terminal Git capture.
    pub(crate) fn finish_no_effect(mut self) {
        self.tracker.finish_no_effect();
        self.completed = true;
    }
}

pub(crate) struct CompletedReceipt {
    pub receipt: TurnReceipt,
    pub repository_root: Option<String>,
    pub terminal_snapshot_id: Option<String>,
}

impl TurnReceiptTracker {
    /// Build a tracker after run admission has frozen the selected local profile.
    /// Every pending, interrupted, and terminal receipt emitted by this tracker
    /// inherits that same attribution. Construction is deliberately synchronous:
    /// ordinary chat/read-only turns must perform zero Git or filesystem capture.
    pub(crate) fn new_with_account(
        turn_id: String,
        started_at: i64,
        started: Instant,
        workspace: PathBuf,
        account_profile_id: Option<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            turn_id,
            account_profile_id,
            started_at,
            started,
            workspace,
            opaque_baseline: tokio::sync::OnceCell::new(),
            mutation_gate: Arc::new(tokio::sync::RwLock::new(())),
            state: Mutex::new(MutationState::default()),
            sealed_outcome: OnceLock::new(),
            repository_overlap: Arc::new(AtomicBool::new(false)),
            repository_turn: Mutex::new(None),
        })
    }

    /// Establish the exclusive pre-run barrier for one mutating tool. The first
    /// opaque tool captures one baseline while retaining that same permit across
    /// `tool.run`. Capture failure is cached and fails closed at completion, but it
    /// does not prevent the already-authorized tool from running.
    pub(crate) async fn prepare_mutation(
        self: &Arc<Self>,
        scope: MutationScope,
        cancel: &AtomicBool,
    ) -> Result<MutationPermit, PrepareMutationError> {
        if cancel.load(Ordering::Relaxed) {
            return Err(PrepareMutationError::Cancelled);
        }

        self.ensure_repository_turn();

        let gate = self.mutation_gate.clone();
        let exclusive = tokio::select! {
            biased;
            _ = wait_for_cancellation(cancel) => {
                return Err(PrepareMutationError::Cancelled);
            }
            guard = gate.write_owned() => guard,
        };

        if scope == MutationScope::Opaque && self.opaque_baseline.get().is_none() {
            // Another opaque waiter may have initialized the cell before this
            // writer acquired the gate. Never repeat a failed or successful capture.
            if self.opaque_baseline.get().is_none() {
                let captured = if git_attribution_enabled() {
                    capture_with_cancel(git_review::capture_turn_workspace(&self.workspace), cancel)
                        .await?
                } else {
                    None
                };
                let _ = self.opaque_baseline.set(captured.map(Arc::new));
            }
        }
        Ok(MutationPermit { _guard: exclusive })
    }

    fn ensure_repository_turn(&self) {
        let mut registration = self.repository_turn.lock().unwrap();
        if registration.is_some() {
            return;
        }
        let Some(root) = repository_root_hint(&self.workspace) else {
            return;
        };
        let registry = ACTIVE_REPOSITORY_TURNS.get_or_init(|| Mutex::new(BTreeMap::new()));
        let mut registry = registry.lock().unwrap();
        let markers = registry.entry(root.clone()).or_default();
        markers.retain(|marker| marker.strong_count() > 0);
        if !markers.is_empty() {
            self.repository_overlap.store(true, Ordering::Release);
            for marker in markers.iter().filter_map(Weak::upgrade) {
                marker.store(true, Ordering::Release);
            }
        }
        markers.push(Arc::downgrade(&self.repository_overlap));
        *registration = Some(RepositoryTurnRegistration {
            root,
            marker: self.repository_overlap.clone(),
        });
    }

    #[cfg(test)]
    pub(crate) fn interrupted_placeholder(&self) -> TurnReceipt {
        TurnReceipt {
            turn_id: self.turn_id.clone(),
            account_profile_id: self.account_profile_id.clone(),
            status: TurnStatus::Interrupted,
            stop_reason: None,
            started_at: self.started_at,
            completed_at: self.started_at,
            duration_ms: None,
            agent_duration_ms: None,
            changed_files: Vec::new(),
            changed_file_count: 0,
            additions: 0,
            deletions: 0,
            files_truncated: false,
            change_state: Some(TurnChangeState::Unknown),
            change_certainty: TurnChangeCertainty::Unavailable,
            background_tasks_running: false,
        }
    }

    pub(crate) fn begin_exact(self: &Arc<Self>) -> MutationToken {
        self.begin_mutation(MutationKind::Exact)
    }

    pub(crate) fn begin_opaque(self: &Arc<Self>) -> MutationToken {
        self.begin_mutation(MutationKind::Opaque)
    }

    fn begin_mutation(self: &Arc<Self>, kind: MutationKind) -> MutationToken {
        let mut state = self.state.lock().unwrap();
        state.next_sequence = state.next_sequence.saturating_add(1);
        let sequence = state.next_sequence;
        state.mutation_attempted = true;
        if state.active_mutations > 0 {
            state.overlapping = true;
        }
        state.active_mutations = state.active_mutations.saturating_add(1);
        MutationToken {
            tracker: self.clone(),
            sequence,
            kind,
            completed: false,
        }
    }

    fn finish_exact(
        &self,
        sequence: u64,
        full_path: &Path,
        previous: Option<&[u8]>,
        expected: &[u8],
        outcome: ExactWriteOutcome,
    ) {
        let mut state = self.state.lock().unwrap();
        state.active_mutations = state.active_mutations.saturating_sub(1);
        match outcome {
            ExactWriteOutcome::Unchanged => {
                // The tool completed, but writing identical bytes is not mutation
                // evidence. In particular, do not bless a baseline-to-terminal
                // delta that an external actor created before this no-op write.
                return;
            }
            ExactWriteOutcome::Unknown => {
                // The write returned successfully, but its old bytes were
                // unreadable. It can reduce certainty around an observed delta,
                // never create positive evidence when capture is incomplete.
                state.may_have_mutated = true;
                state.uncertain_mutation = true;
                state.terminal_exact_paths.insert(full_path.to_path_buf());
                return;
            }
            ExactWriteOutcome::Changed => {}
        }
        state.may_have_mutated = true;
        state.confirmed_exact_paths.insert(full_path.to_path_buf());
        state.terminal_exact_paths.insert(full_path.to_path_buf());
        let path = full_path.to_path_buf();
        let expected_hash = digest(expected);
        if let Some(existing) = state.exact_writes.get_mut(&path) {
            // Preserve the first preimage for the whole turn. Only the latest
            // terminal expectation and sequence advance on a repeated write.
            existing.sequence = sequence;
            existing.expected_hash = expected_hash;
            return;
        }

        let before_hash = previous.map(digest);
        let before_content = previous.and_then(|bytes| {
            let within_file = bytes.len() <= MAX_EXACT_CONTENT_BYTES;
            let within_total =
                state.exact_content_bytes.saturating_add(bytes.len()) <= MAX_EXACT_CONTENT_TOTAL;
            if within_file && within_total {
                state.exact_content_bytes = state.exact_content_bytes.saturating_add(bytes.len());
                Some(Arc::<[u8]>::from(bytes))
            } else {
                None
            }
        });
        state.exact_writes.insert(
            path,
            ExactWrite {
                sequence,
                before_hash,
                before_content,
                before_missing: previous.is_none(),
                expected_hash,
            },
        );
    }

    fn finish_observed(&self, sequence: u64, kind: MutationKind) {
        let mut state = self.state.lock().unwrap();
        state.active_mutations = state.active_mutations.saturating_sub(1);
        state.may_have_mutated = true;
        if matches!(kind, MutationKind::Opaque) {
            state.opaque_seen = true;
            state.last_opaque_sequence = state.last_opaque_sequence.max(sequence);
        }
    }

    fn finish_no_effect(&self) {
        let mut state = self.state.lock().unwrap();
        state.active_mutations = state.active_mutations.saturating_sub(1);
    }

    fn finish_uncertain(&self, sequence: u64, kind: MutationKind) {
        let mut state = self.state.lock().unwrap();
        state.active_mutations = state.active_mutations.saturating_sub(1);
        state.may_have_mutated = true;
        state.uncertain_mutation = true;
        if matches!(kind, MutationKind::Opaque) {
            state.opaque_seen = true;
            state.last_opaque_sequence = state.last_opaque_sequence.max(sequence);
        }
    }

    pub(crate) fn background_started(&self) {
        let mut state = self.state.lock().unwrap();
        state.background_ever = true;
        state.background_running = state.background_running.saturating_add(1);
    }

    pub(crate) fn background_finished(&self) {
        let mut state = self.state.lock().unwrap();
        state.background_running = state.background_running.saturating_sub(1);
    }

    /// Cheap post-agent hint used by the event layer to decide whether a visible
    /// finalization phase is expected. Completion rechecks a cloned, sealed ledger.
    #[cfg(test)]
    pub(crate) fn receipt_expected(&self) -> bool {
        git_attribution_enabled() && terminal_capture_needed(&self.state.lock().unwrap())
    }

    /// Freeze the model/tool lifecycle boundary before any optional Git await.
    /// The returned pending checkpoint is crash-safe and carries the exact same
    /// `agent_duration_ms` that the immutable terminal receipt will later expose.
    pub(crate) fn seal_agent_outcome(
        &self,
        status: TurnStatus,
        stop_reason: Option<String>,
    ) -> (TurnReceipt, bool) {
        let sealed = SealedAgentOutcome {
            status,
            stop_reason,
            completed_at: db::now_ms().max(self.started_at),
            duration_ms: elapsed_ms(self.started),
        };
        let _ = self.sealed_outcome.set(sealed);
        let sealed = self
            .sealed_outcome
            .get()
            .expect("sealed outcome was initialized");
        let state = self.state.lock().unwrap();
        let expected = git_attribution_enabled() && terminal_capture_needed(&state);
        let change_state =
            if !state.mutation_attempted && !state.may_have_mutated && !state.background_ever {
                TurnChangeState::NotApplicable
            } else if terminal_capture_needed(&state) {
                // This remains unknown even when attribution is disabled. The kill
                // switch removes latency and evidence collection, not uncertainty.
                TurnChangeState::Unknown
            } else {
                TurnChangeState::None
            };
        (
            TurnReceipt {
                turn_id: self.turn_id.clone(),
                account_profile_id: self.account_profile_id.clone(),
                status: sealed.status,
                stop_reason: sealed.stop_reason.clone(),
                started_at: self.started_at,
                completed_at: sealed.completed_at,
                duration_ms: Some(sealed.duration_ms),
                agent_duration_ms: Some(sealed.duration_ms),
                changed_files: Vec::new(),
                changed_file_count: 0,
                additions: 0,
                deletions: 0,
                files_truncated: expected,
                change_state: Some(change_state),
                change_certainty: if expected {
                    TurnChangeCertainty::Unavailable
                } else {
                    TurnChangeCertainty::Exact
                },
                background_tasks_running: state.background_running > 0,
            },
            expected,
        )
    }

    pub(crate) async fn complete(
        &self,
        status: TurnStatus,
        stop_reason: Option<String>,
    ) -> CompletedReceipt {
        // Freeze agent timing and mutation facts before optional Git finalization.
        // The user-visible work duration therefore cannot be inflated by receipt
        // capture, and background writes landing later cannot alter this receipt.
        let _ = self.seal_agent_outcome(status, stop_reason);
        let sealed = self
            .sealed_outcome
            .get()
            .expect("complete seals the agent outcome")
            .clone();
        let agent_duration_ms = sealed.duration_ms;
        let mut state = self.state.lock().unwrap().clone();
        state.overlapping |= self.repository_overlap.load(Ordering::Acquire);
        let background_running = state.background_running > 0;
        let capture_needed = git_attribution_enabled() && terminal_capture_needed(&state);
        let finalization_deadline = tokio::time::Instant::now() + CAPTURE_DEADLINE;
        let full_terminal = state.opaque_seen
            || state.background_ever
            || (state.may_have_mutated && state.terminal_exact_paths.is_empty());
        let terminal = if capture_needed {
            if full_terminal {
                let paths: Vec<_> = state.terminal_exact_paths.iter().cloned().collect();
                capture_bounded_until(
                    git_review::capture_turn_workspace_with_paths(&self.workspace, &paths),
                    finalization_deadline,
                )
                .await
            } else {
                let paths: Vec<_> = state.terminal_exact_paths.iter().cloned().collect();
                capture_bounded_until(
                    git_review::capture_turn_paths(&self.workspace, &paths),
                    finalization_deadline,
                )
                .await
            }
        } else {
            None
        };
        let baseline = self.opaque_baseline.get().and_then(Option::as_ref).cloned();
        let terminal_succeeded = terminal.is_some();
        let repository_root = terminal
            .as_ref()
            .or(baseline.as_deref())
            .map(|value| value.repository_root.clone());
        let terminal_snapshot_id = terminal.as_ref().map(|value| value.snapshot_id.clone());
        let comparison = if capture_needed {
            let comparison_state = state.clone();
            let comparison_baseline = baseline.clone();
            let comparison_task = tokio::task::spawn_blocking(move || {
                compare_turn_snapshots(
                    full_terminal,
                    true,
                    comparison_baseline.as_deref(),
                    terminal.as_ref(),
                    &comparison_state,
                )
            });
            match tokio::time::timeout_at(finalization_deadline, comparison_task).await {
                Ok(Ok(comparison)) => comparison,
                _ => (Vec::new(), 0, 0, 0, true, TurnChangeCertainty::Unavailable),
            }
        } else {
            compare_turn_snapshots(full_terminal, false, baseline.as_deref(), None, &state)
        };
        let (mut files, mut changed_file_count, additions, deletions, mut truncated, certainty) =
            comparison;
        if files.len() > MAX_RECEIPT_FILES {
            files.truncate(MAX_RECEIPT_FILES);
            truncated = true;
        }
        changed_file_count = changed_file_count.max(files.len() as u64);
        let change_state = receipt_change_state(
            &state,
            capture_needed,
            terminal_succeeded,
            &files,
            changed_file_count,
            certainty,
        );
        let completed = CompletedReceipt {
            receipt: TurnReceipt {
                turn_id: self.turn_id.clone(),
                account_profile_id: self.account_profile_id.clone(),
                status: sealed.status,
                stop_reason: sealed.stop_reason,
                started_at: self.started_at,
                completed_at: sealed.completed_at,
                duration_ms: Some(sealed.duration_ms),
                agent_duration_ms: Some(agent_duration_ms),
                changed_files: files,
                changed_file_count,
                additions,
                deletions,
                files_truncated: truncated,
                change_state: Some(change_state),
                change_certainty: certainty,
                background_tasks_running: background_running,
            },
            repository_root,
            terminal_snapshot_id,
        };
        drop(self.repository_turn.lock().unwrap().take());
        completed
    }
}

type SnapshotComparison = (
    Vec<TurnChangedFile>,
    u64,
    u64,
    u64,
    bool,
    TurnChangeCertainty,
);

#[derive(Default)]
struct ComparisonBudget {
    text_bytes: usize,
    line_product: usize,
}

fn repository_root_hint(workspace: &Path) -> Option<PathBuf> {
    let workspace = workspace.canonicalize().ok()?;
    let directory = if workspace.is_dir() {
        workspace
    } else {
        workspace.parent()?.to_path_buf()
    };
    directory
        .ancestors()
        .find(|ancestor| ancestor.join(".git").exists())
        .map(Path::to_path_buf)
}

async fn wait_for_cancellation(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(CANCEL_POLL_INTERVAL).await;
    }
}

fn attribution_disabled_value(value: Option<&OsStr>) -> bool {
    value
        .and_then(OsStr::to_str)
        .map(str::trim)
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("1")
                || value.eq_ignore_ascii_case("true")
                || value.eq_ignore_ascii_case("yes")
                || value.eq_ignore_ascii_case("on")
        })
}

fn git_attribution_enabled() -> bool {
    !attribution_disabled_value(std::env::var_os(DISABLE_GIT_ATTRIBUTION_ENV).as_deref())
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

fn terminal_capture_needed(state: &MutationState) -> bool {
    state.may_have_mutated || state.active_mutations > 0 || state.background_ever
}

/// Bound both global queue time and process time under one deadline. Dropping a
/// timed-out Git future also drops its kill-on-drop child process.
async fn capture_bounded<F>(capture: F) -> Option<TurnWorkspaceSnapshot>
where
    F: Future<Output = Result<TurnWorkspaceSnapshot, String>>,
{
    let deadline = tokio::time::Instant::now() + CAPTURE_DEADLINE;
    capture_bounded_until(capture, deadline).await
}

async fn capture_bounded_until<F>(
    capture: F,
    deadline: tokio::time::Instant,
) -> Option<TurnWorkspaceSnapshot>
where
    F: Future<Output = Result<TurnWorkspaceSnapshot, String>>,
{
    let permit = tokio::time::timeout_at(deadline, CAPTURE_PERMITS.acquire())
        .await
        .ok()?
        .ok()?;
    let captured = tokio::time::timeout_at(deadline, capture).await.ok()?.ok();
    drop(permit);
    captured
}

async fn capture_with_cancel<F>(
    capture: F,
    cancel: &AtomicBool,
) -> Result<Option<TurnWorkspaceSnapshot>, PrepareMutationError>
where
    F: Future<Output = Result<TurnWorkspaceSnapshot, String>>,
{
    tokio::select! {
        biased;
        _ = wait_for_cancellation(cancel) => Err(PrepareMutationError::Cancelled),
        captured = capture_bounded(capture) => Ok(captured),
    }
}

fn empty_comparison(certainty: TurnChangeCertainty) -> SnapshotComparison {
    (Vec::new(), 0, 0, 0, false, certainty)
}

fn receipt_change_state(
    state: &MutationState,
    capture_needed: bool,
    terminal_succeeded: bool,
    files: &[TurnChangedFile],
    changed_file_count: u64,
    certainty: TurnChangeCertainty,
) -> TurnChangeState {
    if !files.is_empty() {
        return TurnChangeState::Changed;
    }
    if changed_file_count > 0 {
        // A count without a manifest is deliberately not enough to render a Git
        // summary card; the positive evidence was incomplete.
        return TurnChangeState::Unknown;
    }
    if !state.mutation_attempted && !state.may_have_mutated && !state.background_ever {
        return TurnChangeState::NotApplicable;
    }
    if !terminal_capture_needed(state) {
        return TurnChangeState::None;
    }
    if !capture_needed || !terminal_succeeded || certainty == TurnChangeCertainty::Unavailable {
        TurnChangeState::Unknown
    } else {
        TurnChangeState::None
    }
}

#[cfg(test)]
fn compare_exact_terminal(
    terminal: Option<&TurnWorkspaceSnapshot>,
    state: &MutationState,
) -> SnapshotComparison {
    compare_exact_terminal_with_budget(terminal, state, &mut ComparisonBudget::default())
}

fn compare_exact_terminal_with_budget(
    terminal: Option<&TurnWorkspaceSnapshot>,
    state: &MutationState,
    budget: &mut ComparisonBudget,
) -> SnapshotComparison {
    let Some(terminal) = terminal else {
        return empty_comparison(TurnChangeCertainty::Unavailable);
    };

    let mut changed = Vec::new();
    for (full_path, write) in &state.exact_writes {
        let Some(path) = repository_relative_path(terminal, full_path) else {
            continue;
        };
        let Some(after) = terminal.entries.get(&path) else {
            // A successful scoped capture with no dirty entry means there is no
            // reviewable terminal Git delta for this path. This also suppresses
            // ignored-file writes, as required by the receipt contract.
            continue;
        };

        let terminal_hash = after.content.as_deref().map(digest);
        if write.before_hash.as_ref() == terminal_hash.as_ref() && terminal_hash.is_some() {
            // The path returned to its first pre-turn byte image.
            continue;
        }

        let terminal_matches = terminal_hash
            .as_ref()
            .is_some_and(|hash| hash == &write.expected_hash);
        let ambiguous = terminal.truncated
            || state.overlapping
            || state.uncertain_mutation
            || state.background_running > 0
            || write.sequence <= state.last_opaque_sequence
            || !terminal_matches;
        let certainty = if ambiguous {
            TurnChangeCertainty::Ambiguous
        } else {
            TurnChangeCertainty::Exact
        };
        let (additions, deletions) = exact_line_counts(write, after, budget);
        let binary = after.file.binary
            || write.before_content.as_deref().is_some_and(is_binary)
            || after.content.as_deref().is_some_and(is_binary);
        let status = if write.before_missing {
            TurnFileStatus::Added
        } else {
            match after.file.status {
                GitChangeStatus::Deleted => TurnFileStatus::Deleted,
                GitChangeStatus::Unmerged => TurnFileStatus::Unmerged,
                _ => TurnFileStatus::Modified,
            }
        };
        changed.push(TurnChangedFile {
            path,
            old_path: after.file.old_path.clone(),
            status,
            additions,
            deletions,
            binary,
            certainty,
        });
    }
    changed.sort_by(|left, right| left.path.cmp(&right.path));

    let has_unclassified_mutation = state.uncertain_mutation
        || state
            .terminal_exact_paths
            .iter()
            .any(|path| !state.exact_writes.contains_key(path));
    let certainty = if terminal.membership_truncated || has_unclassified_mutation {
        TurnChangeCertainty::Unavailable
    } else if terminal.truncated || state.overlapping || state.background_running > 0 {
        TurnChangeCertainty::Ambiguous
    } else {
        changed
            .iter()
            .map(|file| file.certainty)
            .max()
            .unwrap_or(TurnChangeCertainty::Exact)
    };
    let count = changed.len() as u64;
    let additions = changed.iter().filter_map(|file| file.additions).sum();
    let deletions = changed.iter().filter_map(|file| file.deletions).sum();
    (
        changed,
        count,
        additions,
        deletions,
        terminal.truncated || has_unclassified_mutation,
        certainty,
    )
}

fn merge_comparisons(base: SnapshotComparison, exact: SnapshotComparison) -> SnapshotComparison {
    let (base_files, base_count, _, _, base_truncated, base_certainty) = base;
    let (exact_files, exact_count, _, _, exact_truncated, exact_certainty) = exact;
    let mut files: BTreeMap<String, TurnChangedFile> = base_files
        .into_iter()
        .map(|file| (file.path.clone(), file))
        .collect();
    let base_unique = files.len() as u64;
    let mut added_unique = 0_u64;
    for file in exact_files {
        if !files.contains_key(&file.path) {
            added_unique = added_unique.saturating_add(1);
        }
        // Exact-preimage comparison is baseline-relative and therefore provides
        // better per-file counts/status when both comparisons saw the same path.
        files.insert(file.path.clone(), file);
    }
    let files: Vec<_> = files.into_values().collect();
    let count = base_count
        .max(base_unique)
        .saturating_add(added_unique)
        .max(exact_count)
        .max(files.len() as u64);
    let additions = files.iter().filter_map(|file| file.additions).sum();
    let deletions = files.iter().filter_map(|file| file.deletions).sum();
    (
        files,
        count,
        additions,
        deletions,
        base_truncated || exact_truncated || count > base_unique.saturating_add(added_unique),
        base_certainty.max(exact_certainty),
    )
}

fn compare_turn_snapshots(
    full_terminal: bool,
    capture_needed: bool,
    baseline: Option<&TurnWorkspaceSnapshot>,
    terminal: Option<&TurnWorkspaceSnapshot>,
    state: &MutationState,
) -> SnapshotComparison {
    let mut budget = ComparisonBudget::default();
    let mut comparison = if full_terminal {
        compare_snapshots_with_budget(baseline, terminal, state, &mut budget)
    } else if capture_needed {
        compare_exact_terminal_with_budget(terminal, state, &mut budget)
    } else {
        return empty_comparison(if terminal_capture_needed(state) {
            TurnChangeCertainty::Unavailable
        } else if state.mutation_attempted {
            TurnChangeCertainty::Exact
        } else {
            TurnChangeCertainty::Unavailable
        });
    };
    if full_terminal && !state.exact_writes.is_empty() {
        comparison = suppress_reverted_exact_rows(comparison, terminal, state);
        comparison = merge_comparisons(
            comparison,
            compare_exact_terminal_with_budget(terminal, state, &mut budget),
        );
    }
    comparison
}

fn suppress_reverted_exact_rows(
    comparison: SnapshotComparison,
    terminal: Option<&TurnWorkspaceSnapshot>,
    state: &MutationState,
) -> SnapshotComparison {
    let Some(terminal) = terminal else {
        return comparison;
    };
    let reverted: BTreeSet<_> = state
        .exact_writes
        .iter()
        .filter_map(|(full_path, write)| {
            let path = repository_relative_path(terminal, full_path)?;
            let terminal_hash = terminal
                .entries
                .get(&path)
                .and_then(|entry| entry.content.as_deref())
                .map(digest)
                .or_else(|| {
                    terminal
                        .exact_paths
                        .get(&path)
                        .and_then(|state| state.digest.clone())
                });
            let restored =
                terminal_hash.as_deref() == write.before_hash.as_deref() && terminal_hash.is_some();
            let created_then_removed = write.before_missing
                && terminal
                    .exact_paths
                    .get(&path)
                    .is_some_and(|state| state.missing);
            (restored || created_then_removed).then_some(path)
        })
        .collect();
    if reverted.is_empty() {
        return comparison;
    }
    let (mut files, count, _, _, truncated, certainty) = comparison;
    let before = files.len();
    files.retain(|file| !reverted.contains(&file.path));
    let removed = before.saturating_sub(files.len()) as u64;
    let additions = files.iter().filter_map(|file| file.additions).sum();
    let deletions = files.iter().filter_map(|file| file.deletions).sum();
    (
        files,
        count.saturating_sub(removed),
        additions,
        deletions,
        truncated,
        certainty,
    )
}

fn repository_relative_path(snapshot: &TurnWorkspaceSnapshot, full_path: &Path) -> Option<String> {
    let root = PathBuf::from(&snapshot.repository_root);
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    let canonical_path = full_path.canonicalize().ok().or_else(|| {
        let parent = full_path.parent()?;
        let name = full_path.file_name()?;
        parent.canonicalize().ok().map(|parent| parent.join(name))
    });
    let relative = canonical_path
        .as_deref()
        .and_then(|path| path.strip_prefix(&canonical_root).ok())
        .or_else(|| full_path.strip_prefix(&root).ok())?;
    if relative.as_os_str().is_empty()
        || relative.components().any(|component| {
            matches!(component, std::path::Component::Normal(name) if name.to_string_lossy().eq_ignore_ascii_case(".git"))
        })
    {
        return None;
    }
    Some(relative.to_string_lossy().replace('\\', "/"))
}

fn exact_line_counts(
    write: &ExactWrite,
    after: &TurnWorkspaceEntry,
    budget: &mut ComparisonBudget,
) -> (Option<u64>, Option<u64>) {
    let after_content = after.content.as_deref();
    if write.before_missing {
        return after_content
            .and_then(|new| bounded_text_line_counts(b"", new, budget))
            .unwrap_or((None, None));
    }
    let Some(before) = write.before_content.as_deref() else {
        return (None, None);
    };
    match after_content {
        Some(after) => bounded_text_line_counts(before, after, budget).unwrap_or((None, None)),
        None if after.file.status == GitChangeStatus::Deleted => {
            bounded_text_line_counts(before, b"", budget).unwrap_or((None, None))
        }
        None => (None, None),
    }
}

#[cfg(test)]
fn compare_snapshots(
    baseline: Option<&TurnWorkspaceSnapshot>,
    terminal: Option<&TurnWorkspaceSnapshot>,
    state: &MutationState,
) -> SnapshotComparison {
    compare_snapshots_with_budget(baseline, terminal, state, &mut ComparisonBudget::default())
}

fn compare_snapshots_with_budget(
    baseline: Option<&TurnWorkspaceSnapshot>,
    terminal: Option<&TurnWorkspaceSnapshot>,
    state: &MutationState,
    budget: &mut ComparisonBudget,
) -> SnapshotComparison {
    let (Some(baseline), Some(terminal)) = (baseline, terminal) else {
        // A missing boundary remains truthfully unavailable; it must never be
        // upgraded to an exact clean delta. Non-Git or opaque-only turns persist as
        // zero/unavailable, which the UI suppresses rather than rendering a
        // misleading changes card. A successful terminal manifest is the only
        // available proof that a completed, byte-changing first-class write's
        // written path participates in reviewable Git state. Baseline-only roots
        // cannot distinguish clean tracked files from ignored or nested metadata,
        // so they conservatively contribute no positive count.
        let confirmed_file_count = terminal
            .map(|snapshot| confirmed_git_write_count(snapshot, state))
            .unwrap_or(0);
        return (
            Vec::new(),
            confirmed_file_count,
            0,
            0,
            confirmed_file_count > 0,
            TurnChangeCertainty::Unavailable,
        );
    };
    if baseline.repository_root != terminal.repository_root {
        // Repository-relative paths are meaningless across different roots. Do
        // not fabricate a manifest by cross-diffing the two maps or by attaching
        // a write recorded under one root to the other.
        return (Vec::new(), 0, 0, 0, false, TurnChangeCertainty::Unavailable);
    }
    let identity_changed = baseline.head_oid != terminal.head_oid;
    let globally_ambiguous = identity_changed
        || baseline.truncated
        || terminal.truncated
        || state.overlapping
        || state.uncertain_mutation
        || state.background_running > 0;
    let membership_incomplete = baseline.membership_truncated || terminal.membership_truncated;

    let mut used_baseline = BTreeSet::new();
    let mut changed = Vec::new();
    for (path, after) in &terminal.entries {
        let before_key = if baseline.entries.contains_key(path) {
            Some(path.as_str())
        } else {
            after
                .file
                .old_path
                .as_deref()
                .filter(|old| baseline.entries.contains_key(*old))
        };
        let before = before_key.and_then(|key| baseline.entries.get(key));
        if before.is_none() && membership_incomplete {
            // With capped membership this may be an unchanged baseline entry that
            // merely moved into the retained prefix. Absence is not a delta.
            continue;
        }
        if before.is_some_and(|entry| entry.fingerprint == after.fingerprint) {
            if let Some(key) = before_key {
                used_baseline.insert(key.to_string());
            }
            continue;
        }
        if let Some(key) = before_key {
            used_baseline.insert(key.to_string());
        }
        changed.push(changed_file(
            terminal,
            path,
            before,
            Some(after),
            state,
            globally_ambiguous,
            budget,
        ));
    }
    for (path, before) in &baseline.entries {
        if used_baseline.contains(path) || terminal.entries.contains_key(path) {
            continue;
        }
        if membership_incomplete {
            // Symmetric cap churn can evict a real terminal entry. Without an
            // independently observed terminal identity, do not call it deleted.
            continue;
        }
        changed.push(changed_file(
            terminal,
            path,
            Some(before),
            None,
            state,
            globally_ambiguous,
            budget,
        ));
    }
    changed.sort_by(|left, right| left.path.cmp(&right.path));

    let changed_file_count = changed.len() as u64;
    let additions = changed.iter().filter_map(|file| file.additions).sum();
    let deletions = changed.iter().filter_map(|file| file.deletions).sum();
    let certainty = if globally_ambiguous {
        TurnChangeCertainty::Ambiguous
    } else if changed.is_empty() {
        if state.opaque_seen || state.background_ever {
            TurnChangeCertainty::Observed
        } else {
            TurnChangeCertainty::Exact
        }
    } else {
        changed
            .iter()
            .map(|file| file.certainty)
            .max()
            .unwrap_or(TurnChangeCertainty::Exact)
    };
    (
        changed,
        changed_file_count,
        additions,
        deletions,
        baseline.truncated || terminal.truncated,
        certainty,
    )
}

fn confirmed_git_write_count(snapshot: &TurnWorkspaceSnapshot, state: &MutationState) -> u64 {
    state
        .confirmed_exact_paths
        .iter()
        .filter(|path| is_reviewable_worktree_path(snapshot, path))
        .count()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn is_reviewable_worktree_path(snapshot: &TurnWorkspaceSnapshot, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(Path::new(&snapshot.repository_root)) else {
        return false;
    };
    if relative.as_os_str().is_empty()
        || relative.components().any(|component| {
            matches!(component, std::path::Component::Normal(name) if name.to_string_lossy().eq_ignore_ascii_case(".git"))
        })
    {
        return false;
    }
    let relative = relative.to_string_lossy().replace('\\', "/");
    snapshot.entries.contains_key(&relative)
}

fn changed_file(
    terminal: &TurnWorkspaceSnapshot,
    path: &str,
    before: Option<&TurnWorkspaceEntry>,
    after: Option<&TurnWorkspaceEntry>,
    state: &MutationState,
    globally_ambiguous: bool,
    budget: &mut ComparisonBudget,
) -> TurnChangedFile {
    let (additions, deletions) = line_counts(before, after, budget);
    let file = after
        .map(|entry| &entry.file)
        .or_else(|| before.map(|entry| &entry.file));
    let binary = file.is_some_and(|value| value.binary)
        || before
            .and_then(|entry| entry.content.as_deref())
            .is_some_and(is_binary)
        || after
            .and_then(|entry| entry.content.as_deref())
            .is_some_and(is_binary);
    let certainty = if globally_ambiguous {
        TurnChangeCertainty::Ambiguous
    } else if exact_terminal_match(terminal, path, after, state) {
        TurnChangeCertainty::Exact
    } else if state.opaque_seen {
        TurnChangeCertainty::Observed
    } else {
        // A delta with no matching first-class write and no opaque command was
        // external to the controlled tool path (or otherwise unexplained).
        TurnChangeCertainty::Ambiguous
    };
    TurnChangedFile {
        path: path.to_string(),
        old_path: after.and_then(|entry| entry.file.old_path.clone()),
        status: after
            .map(|entry| map_status(entry.file.status))
            .unwrap_or_else(|| status_after_return_to_clean(before)),
        additions,
        deletions,
        binary,
        certainty,
    }
}

fn exact_terminal_match(
    terminal: &TurnWorkspaceSnapshot,
    path: &str,
    after: Option<&TurnWorkspaceEntry>,
    state: &MutationState,
) -> bool {
    let Some(expected) = state.exact_writes.iter().find_map(|(full_path, write)| {
        (repository_relative_path(terminal, full_path).as_deref() == Some(path)).then_some(write)
    }) else {
        return false;
    };
    if expected.sequence <= state.last_opaque_sequence {
        return false;
    }
    after
        .and_then(|entry| entry.content.as_deref())
        .is_some_and(|content| digest(content) == expected.expected_hash)
}

fn line_counts(
    before: Option<&TurnWorkspaceEntry>,
    after: Option<&TurnWorkspaceEntry>,
    budget: &mut ComparisonBudget,
) -> (Option<u64>, Option<u64>) {
    match (
        before.and_then(|entry| entry.content.as_deref()),
        after.and_then(|entry| entry.content.as_deref()),
    ) {
        (Some(old), Some(new)) => {
            bounded_text_line_counts(old, new, budget).unwrap_or((None, None))
        }
        (None, Some(_)) => after
            .map(|entry| (entry.file.additions, entry.file.deletions))
            .unwrap_or((None, None)),
        (Some(_), None) => before
            .map(|entry| (entry.file.deletions, entry.file.additions))
            .unwrap_or((None, None)),
        (None, None) if before.is_some() && after.is_none() => before
            .map(|entry| (entry.file.deletions, entry.file.additions))
            .unwrap_or((None, None)),
        _ => (None, None),
    }
}

fn bounded_text_line_counts(
    old: &[u8],
    new: &[u8],
    budget: &mut ComparisonBudget,
) -> Option<(Option<u64>, Option<u64>)> {
    let bytes = old.len().saturating_add(new.len());
    let old_lines = old.iter().filter(|byte| **byte == b'\n').count()
        + usize::from(!old.is_empty() && !old.ends_with(b"\n"));
    let new_lines = new.iter().filter(|byte| **byte == b'\n').count()
        + usize::from(!new.is_empty() && !new.ends_with(b"\n"));
    let lines = old_lines.saturating_add(new_lines);
    let product = old_lines.saturating_mul(new_lines);
    if budget.text_bytes.saturating_add(bytes) > MAX_LINE_DIFF_BYTES
        || lines > MAX_LINE_DIFF_LINES
        || budget.line_product.saturating_add(product) > MAX_LINE_DIFF_PRODUCT
        || is_binary(old)
        || is_binary(new)
    {
        return None;
    }
    let (Ok(old), Ok(new)) = (std::str::from_utf8(old), std::str::from_utf8(new)) else {
        return None;
    };
    budget.text_bytes = budget.text_bytes.saturating_add(bytes);
    budget.line_product = budget.line_product.saturating_add(product);
    let mut additions = 0_u64;
    let mut deletions = 0_u64;
    for change in TextDiff::from_lines(old, new).iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => additions = additions.saturating_add(1),
            ChangeTag::Delete => deletions = deletions.saturating_add(1),
            ChangeTag::Equal => {}
        }
    }
    Some((Some(additions), Some(deletions)))
}

fn status_after_return_to_clean(before: Option<&TurnWorkspaceEntry>) -> TurnFileStatus {
    match before.map(|entry| entry.file.status) {
        // An untracked/staged addition that disappears is a baseline-relative delete.
        Some(GitChangeStatus::Added) => TurnFileStatus::Deleted,
        // Restoring a pre-existing deletion adds the path relative to the baseline.
        Some(GitChangeStatus::Deleted) => TurnFileStatus::Added,
        // The file still exists but its dirty baseline contents/index state were reset.
        Some(GitChangeStatus::Modified | GitChangeStatus::Renamed | GitChangeStatus::Copied) => {
            TurnFileStatus::Modified
        }
        Some(GitChangeStatus::Unmerged) => TurnFileStatus::Unmerged,
        None => TurnFileStatus::Deleted,
    }
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0) || std::str::from_utf8(bytes).is_err()
}

fn map_status(status: GitChangeStatus) -> TurnFileStatus {
    match status {
        GitChangeStatus::Added => TurnFileStatus::Added,
        GitChangeStatus::Modified => TurnFileStatus::Modified,
        GitChangeStatus::Deleted => TurnFileStatus::Deleted,
        GitChangeStatus::Renamed => TurnFileStatus::Renamed,
        GitChangeStatus::Copied => TurnFileStatus::Copied,
        GitChangeStatus::Unmerged => TurnFileStatus::Unmerged,
    }
}

fn digest(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    let mut out = String::with_capacity(hash.len() * 2);
    for byte in hash {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_review::{GitChangeArea, GitChangedFile};

    #[test]
    fn unavailable_receipt_account_attribution_is_explicit_and_optional() {
        assert_eq!(
            unavailable_interrupted_receipt("legacy", 1).account_profile_id,
            None
        );
        assert_eq!(
            unavailable_interrupted_receipt_with_account("pinned", 1, Some("profile-a".into()))
                .account_profile_id
                .as_deref(),
            Some("profile-a")
        );
    }

    #[tokio::test]
    async fn tracker_carries_one_profile_through_pending_and_terminal_receipts() {
        let missing_workspace = std::env::temp_dir().join(format!(
            "portcode-missing-receipt-workspace-{}",
            uuid::Uuid::new_v4()
        ));
        let tracker = TurnReceiptTracker::new_with_account(
            "turn-a".into(),
            1,
            Instant::now(),
            missing_workspace,
            Some("profile-a".into()),
        );

        assert_eq!(
            tracker
                .interrupted_placeholder()
                .account_profile_id
                .as_deref(),
            Some("profile-a")
        );
        let completed = tracker
            .complete(TurnStatus::Completed, Some("end_turn".into()))
            .await;
        assert_eq!(
            completed.receipt.account_profile_id.as_deref(),
            Some("profile-a")
        );
        assert!(tracker.opaque_baseline.get().is_none());
        assert_eq!(
            completed.receipt.change_state,
            Some(TurnChangeState::NotApplicable)
        );
    }

    #[tokio::test]
    async fn read_only_completion_performs_no_workspace_capture_and_freezes_agent_time() {
        let tracker = TurnReceiptTracker::new_with_account(
            "read-only".into(),
            1,
            Instant::now(),
            PathBuf::from("definitely-missing-workspace"),
            None,
        );
        assert!(tracker.opaque_baseline.get().is_none());

        let (checkpoint, expected) =
            tracker.seal_agent_outcome(TurnStatus::Completed, Some("end_turn".into()));
        assert!(!expected);
        let completed = tracker
            .complete(TurnStatus::Completed, Some("end_turn".into()))
            .await;

        assert!(tracker.opaque_baseline.get().is_none());
        assert_eq!(
            completed.receipt.change_state,
            Some(TurnChangeState::NotApplicable)
        );
        assert_eq!(
            checkpoint.agent_duration_ms,
            completed.receipt.agent_duration_ms
        );
    }

    #[tokio::test]
    async fn exact_prepare_and_proven_no_effect_never_initialize_opaque_capture() {
        let tracker = TurnReceiptTracker::new_with_account(
            "exact".into(),
            1,
            Instant::now(),
            PathBuf::from("missing"),
            None,
        );
        let cancel = AtomicBool::new(false);
        let permit = tracker
            .prepare_mutation(MutationScope::Exact, &cancel)
            .await
            .expect("exact permit");
        assert!(tracker.opaque_baseline.get().is_none());
        tracker.begin_exact().finish_no_effect();
        assert!(!tracker.receipt_expected());
        drop(permit);

        let completed = tracker
            .complete(TurnStatus::Completed, Some("end_turn".into()))
            .await;
        assert!(tracker.opaque_baseline.get().is_none());
        assert_eq!(completed.receipt.change_state, Some(TurnChangeState::None));
    }

    #[tokio::test]
    async fn cancelled_opaque_prepare_does_not_initialize_a_baseline() {
        let tracker = TurnReceiptTracker::new_with_account(
            "cancelled".into(),
            1,
            Instant::now(),
            PathBuf::from("missing"),
            None,
        );
        let cancel = AtomicBool::new(true);
        let result = tracker
            .prepare_mutation(MutationScope::Opaque, &cancel)
            .await;
        assert!(matches!(result, Err(PrepareMutationError::Cancelled)));
        assert!(tracker.opaque_baseline.get().is_none());
    }

    #[tokio::test]
    async fn cancelled_opaque_waiter_releases_the_exact_permit_barrier() {
        let tracker = TurnReceiptTracker::new_with_account(
            "barrier".into(),
            1,
            Instant::now(),
            PathBuf::from("missing"),
            None,
        );
        let never_cancel = AtomicBool::new(false);
        let first_exact = tracker
            .prepare_mutation(MutationScope::Exact, &never_cancel)
            .await
            .expect("first exact permit");

        let cancel = Arc::new(AtomicBool::new(false));
        let waiter_tracker = tracker.clone();
        let waiter_cancel = cancel.clone();
        let waiter = tokio::spawn(async move {
            match waiter_tracker
                .prepare_mutation(MutationScope::Opaque, &waiter_cancel)
                .await
            {
                Ok(permit) => {
                    drop(permit);
                    Ok(())
                }
                Err(error) => Err(error),
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        cancel.store(true, Ordering::Relaxed);
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("cancelled waiter must wake")
            .expect("waiter task");
        assert!(matches!(result, Err(PrepareMutationError::Cancelled)));
        assert!(tracker.opaque_baseline.get().is_none());

        drop(first_exact);
        // The cancelled writer must be removed from Tokio's fair queue so the
        // next exclusive exact permit can proceed once the holder exits.
        let second_exact = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            tracker.prepare_mutation(MutationScope::Exact, &never_cancel),
        )
        .await
        .expect("cancelled writer no longer blocks readers")
        .expect("second exact permit");
        drop(second_exact);
    }

    #[tokio::test]
    async fn exact_mutation_permits_are_strictly_ordered() {
        let tracker = TurnReceiptTracker::new_with_account(
            "exclusive".into(),
            1,
            Instant::now(),
            PathBuf::from("missing"),
            None,
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let first = tracker
            .prepare_mutation(MutationScope::Exact, &cancel)
            .await
            .expect("first exact permit");
        let waiting_tracker = tracker.clone();
        let waiting_cancel = cancel.clone();
        let second = tokio::spawn(async move {
            waiting_tracker
                .prepare_mutation(MutationScope::Exact, &waiting_cancel)
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        assert!(
            !second.is_finished(),
            "second exact permit overlapped first"
        );
        drop(first);
        let second = tokio::time::timeout(std::time::Duration::from_secs(1), second)
            .await
            .expect("second exact permit wakes")
            .expect("second task")
            .expect("second exact permit");
        drop(second);
    }

    #[tokio::test]
    async fn concurrent_turns_in_one_canonical_repository_are_both_ambiguous() {
        let root =
            std::env::temp_dir().join(format!("portcode-receipt-overlap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let first = TurnReceiptTracker::new_with_account(
            "first".into(),
            1,
            Instant::now(),
            root.clone(),
            None,
        );
        let second = TurnReceiptTracker::new_with_account(
            "second".into(),
            1,
            Instant::now(),
            root.clone(),
            None,
        );
        let cancel = AtomicBool::new(false);
        let first_permit = first
            .prepare_mutation(MutationScope::Exact, &cancel)
            .await
            .unwrap();
        let second_permit = second
            .prepare_mutation(MutationScope::Exact, &cancel)
            .await
            .unwrap();
        assert!(first.repository_overlap.load(Ordering::Acquire));
        assert!(second.repository_overlap.load(Ordering::Acquire));

        let before = snapshot([]);
        let after = snapshot([("file.txt", entry("file.txt", "after", b"after\n"))]);
        let state = MutationState {
            overlapping: first.repository_overlap.load(Ordering::Acquire),
            ..MutationState::default()
        };
        assert_eq!(
            compare_snapshots(Some(&before), Some(&after), &state).5,
            TurnChangeCertainty::Ambiguous
        );

        drop(first_permit);
        drop(second_permit);
        first
            .complete(TurnStatus::Completed, Some("done".into()))
            .await;
        second
            .complete(TurnStatus::Completed, Some("done".into()))
            .await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_attribution_kill_switch_values_are_explicit() {
        assert!(attribution_disabled_value(Some(OsStr::new("1"))));
        assert!(attribution_disabled_value(Some(OsStr::new(" TRUE "))));
        assert!(attribution_disabled_value(Some(OsStr::new("yes"))));
        assert!(attribution_disabled_value(Some(OsStr::new("On"))));
        assert!(!attribution_disabled_value(Some(OsStr::new("0"))));
        assert!(!attribution_disabled_value(Some(OsStr::new("false"))));
        assert!(!attribution_disabled_value(None));
    }

    fn entry(path: &str, fingerprint: &str, content: &[u8]) -> TurnWorkspaceEntry {
        TurnWorkspaceEntry {
            file: GitChangedFile {
                path: path.into(),
                old_path: None,
                status: GitChangeStatus::Modified,
                areas: vec![GitChangeArea::Unstaged],
                additions: Some(1),
                deletions: Some(1),
                binary: false,
            },
            fingerprint: fingerprint.into(),
            content: Some(content.to_vec()),
        }
    }

    fn snapshot(
        entries: impl IntoIterator<Item = (&'static str, TurnWorkspaceEntry)>,
    ) -> TurnWorkspaceSnapshot {
        TurnWorkspaceSnapshot {
            repository_root: "repo".into(),
            snapshot_id: "snapshot".into(),
            head_oid: Some("head".into()),
            entries: entries
                .into_iter()
                .map(|(path, entry)| (path.into(), entry))
                .collect(),
            exact_paths: BTreeMap::new(),
            membership_truncated: false,
            truncated: false,
        }
    }

    #[test]
    fn untouched_preexisting_dirty_file_is_excluded() {
        let before = snapshot([("old.txt", entry("old.txt", "same", b"dirty\n"))]);
        let after = snapshot([("old.txt", entry("old.txt", "same", b"dirty\n"))]);
        let result = compare_snapshots(Some(&before), Some(&after), &MutationState::default());
        assert!(result.0.is_empty());
        assert_eq!(result.1, 0);
        assert_eq!(result.5, TurnChangeCertainty::Exact);
    }

    #[test]
    fn same_dirty_file_reports_only_baseline_to_terminal_lines() {
        let before = snapshot([("file.txt", entry("file.txt", "before", b"preexisting\n"))]);
        let after = snapshot([(
            "file.txt",
            entry("file.txt", "after", b"preexisting\nagent\n"),
        )]);
        let mut state = MutationState::default();
        state.exact_writes.insert(
            PathBuf::from("repo/file.txt"),
            ExactWrite {
                sequence: 1,
                before_hash: Some(digest(b"preexisting\n")),
                before_content: Some(Arc::from(&b"preexisting\n"[..])),
                before_missing: false,
                expected_hash: digest(b"preexisting\nagent\n"),
            },
        );
        let result = compare_snapshots(Some(&before), Some(&after), &state);
        assert_eq!(result.0.len(), 1);
        assert_eq!(result.0[0].additions, Some(1));
        assert_eq!(result.0[0].deletions, Some(0));
        assert_eq!(result.0[0].certainty, TurnChangeCertainty::Exact);
    }

    #[test]
    fn line_diff_is_omitted_above_the_cpu_budget() {
        let old = vec![b'a'; MAX_LINE_DIFF_BYTES / 2 + 1];
        let new = vec![b'b'; MAX_LINE_DIFF_BYTES / 2 + 1];
        assert_eq!(
            bounded_text_line_counts(&old, &new, &mut ComparisonBudget::default()),
            None
        );
    }

    #[test]
    fn line_diff_budget_is_shared_across_the_whole_turn() {
        let old = vec![b'a'; MAX_LINE_DIFF_BYTES / 4];
        let new = vec![b'b'; MAX_LINE_DIFF_BYTES / 4];
        let mut budget = ComparisonBudget::default();
        assert!(bounded_text_line_counts(&old, &new, &mut budget).is_some());
        assert!(bounded_text_line_counts(&old, &new, &mut budget).is_some());
        assert_eq!(bounded_text_line_counts(&old, &new, &mut budget), None);
    }

    #[test]
    fn adversarial_many_line_diff_is_rejected_before_myers() {
        let old = "old\n".repeat(1_100);
        let new = "new\n".repeat(1_100);
        assert_eq!(
            bounded_text_line_counts(
                old.as_bytes(),
                new.as_bytes(),
                &mut ComparisonBudget::default(),
            ),
            None
        );
    }

    #[test]
    fn exact_terminal_comparison_treats_pathspec_magic_as_plain_path_text() {
        let path = ":(glob)* [receipt].txt";
        let terminal = snapshot([(path, entry(path, "after", b"new\n"))]);
        let state = MutationState {
            mutation_attempted: true,
            may_have_mutated: true,
            confirmed_exact_paths: BTreeSet::from([PathBuf::from("repo").join(path)]),
            terminal_exact_paths: BTreeSet::from([PathBuf::from("repo").join(path)]),
            exact_writes: BTreeMap::from([(
                PathBuf::from("repo").join(path),
                ExactWrite {
                    sequence: 1,
                    before_hash: Some(digest(b"old\n")),
                    before_content: Some(Arc::from(&b"old\n"[..])),
                    before_missing: false,
                    expected_hash: digest(b"new\n"),
                },
            )]),
            ..MutationState::default()
        };

        let result = compare_exact_terminal(Some(&terminal), &state);
        assert_eq!(result.0.len(), 1);
        assert_eq!(result.0[0].path, path);
        assert_eq!(result.0[0].certainty, TurnChangeCertainty::Exact);
    }

    #[test]
    fn unexplained_and_overlapping_changes_are_ambiguous() {
        let before = snapshot([]);
        let after = snapshot([("new.txt", entry("new.txt", "after", b"new\n"))]);
        let unexplained = compare_snapshots(Some(&before), Some(&after), &MutationState::default());
        assert_eq!(unexplained.0[0].certainty, TurnChangeCertainty::Ambiguous);

        let overlapping = compare_snapshots(
            Some(&before),
            Some(&after),
            &MutationState {
                overlapping: true,
                ..MutationState::default()
            },
        );
        assert_eq!(overlapping.5, TurnChangeCertainty::Ambiguous);
    }

    #[test]
    fn non_git_and_opaque_turns_carry_no_positive_change_evidence() {
        let no_tools = compare_snapshots(None, None, &MutationState::default());
        assert_eq!(no_tools.1, 0);
        assert!(!no_tools.4);
        assert_eq!(no_tools.5, TurnChangeCertainty::Unavailable);

        let opaque = compare_snapshots(
            None,
            None,
            &MutationState {
                opaque_seen: true,
                last_opaque_sequence: 1,
                ..MutationState::default()
            },
        );
        assert_eq!(opaque.1, 0);
        assert!(!opaque.4);
        assert_eq!(opaque.5, TurnChangeCertainty::Unavailable);
    }

    #[test]
    fn incomplete_capture_needs_a_confirmed_write_inside_observed_git() {
        let observed = snapshot([]);

        // A failed file edit or an opaque command is not evidence that bytes were
        // changed, so losing the other snapshot must stay silent.
        let attempted = compare_snapshots(
            Some(&observed),
            None,
            &MutationState {
                uncertain_mutation: true,
                opaque_seen: true,
                ..MutationState::default()
            },
        );
        assert_eq!(attempted.1, 0);
        assert_eq!(attempted.5, TurnChangeCertainty::Unavailable);

        let outside = compare_snapshots(
            Some(&observed),
            None,
            &MutationState {
                confirmed_exact_paths: BTreeSet::from([PathBuf::from("elsewhere/file.txt")]),
                ..MutationState::default()
            },
        );
        assert_eq!(outside.1, 0);
        assert_eq!(outside.5, TurnChangeCertainty::Unavailable);

        let git_metadata = compare_snapshots(
            Some(&observed),
            None,
            &MutationState {
                confirmed_exact_paths: BTreeSet::from([
                    PathBuf::from("repo/.git/config"),
                    PathBuf::from("repo/nested/.git/index"),
                ]),
                ..MutationState::default()
            },
        );
        assert_eq!(git_metadata.1, 0);
        assert_eq!(git_metadata.5, TurnChangeCertainty::Unavailable);

        let ignored_or_otherwise_unlisted = compare_snapshots(
            None,
            Some(&observed),
            &MutationState {
                confirmed_exact_paths: BTreeSet::from([PathBuf::from("repo/ignored.log")]),
                ..MutationState::default()
            },
        );
        assert_eq!(ignored_or_otherwise_unlisted.1, 0);
        assert_eq!(
            ignored_or_otherwise_unlisted.5,
            TurnChangeCertainty::Unavailable
        );

        let terminal = snapshot([("file.txt", entry("file.txt", "after", b"changed\n"))]);
        let inside = compare_snapshots(
            None,
            Some(&terminal),
            &MutationState {
                confirmed_exact_paths: BTreeSet::from([PathBuf::from("repo/file.txt")]),
                ..MutationState::default()
            },
        );
        assert!(inside.0.is_empty());
        assert_eq!(inside.1, 1);
        assert!(inside.4, "the unavailable file list is incomplete");
        assert_eq!(inside.5, TurnChangeCertainty::Unavailable);
    }

    #[test]
    fn truncated_membership_does_not_fabricate_additions_or_deletions() {
        let mut before = snapshot([("z.txt", entry("z.txt", "same", b"dirty\n"))]);
        before.membership_truncated = true;
        before.truncated = true;
        let mut after = snapshot([("a.txt", entry("a.txt", "same", b"dirty\n"))]);
        after.membership_truncated = true;
        after.truncated = true;

        let result = compare_snapshots(Some(&before), Some(&after), &MutationState::default());
        assert!(result.0.is_empty());
        assert_eq!(result.1, 0);
        assert!(result.4);
        assert_eq!(result.5, TurnChangeCertainty::Ambiguous);
    }

    #[test]
    fn repository_root_change_is_not_cross_diffed() {
        let before = snapshot([("same.txt", entry("same.txt", "before", b"before\n"))]);
        let mut after = snapshot([("same.txt", entry("same.txt", "after", b"after\n"))]);
        after.repository_root = "other-repo".into();

        let result = compare_snapshots(Some(&before), Some(&after), &MutationState::default());
        assert!(result.0.is_empty());
        assert_eq!(result.1, 0);
        assert_eq!(result.2, 0);
        assert_eq!(result.3, 0);
        assert_eq!(result.5, TurnChangeCertainty::Unavailable);
    }

    #[test]
    fn write_then_revert_uses_the_clean_terminal_snapshot() {
        let before = snapshot([]);
        let after = snapshot([]);
        let result = compare_snapshots(
            Some(&before),
            Some(&after),
            &MutationState {
                confirmed_exact_paths: BTreeSet::from([PathBuf::from("repo/file.txt")]),
                exact_writes: BTreeMap::from([(
                    PathBuf::from("repo/file.txt"),
                    ExactWrite {
                        sequence: 2,
                        before_hash: Some(digest(b"original\n")),
                        before_content: Some(Arc::from(&b"original\n"[..])),
                        before_missing: false,
                        expected_hash: digest(b"original\n"),
                    },
                )]),
                ..MutationState::default()
            },
        );
        assert!(result.0.is_empty());
        assert_eq!(result.1, 0);
        assert_eq!(result.5, TurnChangeCertainty::Exact);
    }

    #[test]
    fn exact_then_opaque_return_to_preimage_suppresses_the_opaque_base_row() {
        let baseline = snapshot([("file.txt", entry("file.txt", "b", b"B\n"))]);
        let terminal = snapshot([("file.txt", entry("file.txt", "a", b"A\n"))]);
        let path = PathBuf::from("repo/file.txt");
        let state = MutationState {
            mutation_attempted: true,
            may_have_mutated: true,
            opaque_seen: true,
            last_opaque_sequence: 2,
            confirmed_exact_paths: BTreeSet::from([path.clone()]),
            terminal_exact_paths: BTreeSet::from([path.clone()]),
            exact_writes: BTreeMap::from([(
                path,
                ExactWrite {
                    sequence: 1,
                    before_hash: Some(digest(b"A\n")),
                    before_content: Some(Arc::from(&b"A\n"[..])),
                    before_missing: false,
                    expected_hash: digest(b"B\n"),
                },
            )]),
            ..MutationState::default()
        };

        let comparison =
            compare_turn_snapshots(true, true, Some(&baseline), Some(&terminal), &state);
        assert!(comparison.0.is_empty());
        assert_eq!(comparison.1, 0);
        assert_eq!(comparison.2, 0);
        assert_eq!(comparison.3, 0);
    }

    #[test]
    fn exact_then_opaque_restore_to_clean_preimage_suppresses_deleted_base_row() {
        let baseline = snapshot([("file.txt", entry("file.txt", "b", b"B\n"))]);
        let mut terminal = snapshot([]);
        terminal.exact_paths.insert(
            "file.txt".into(),
            crate::git_review::TurnExactPathState {
                digest: Some(digest(b"A\n")),
                missing: false,
            },
        );
        let path = PathBuf::from("repo/file.txt");
        let state = MutationState {
            mutation_attempted: true,
            may_have_mutated: true,
            opaque_seen: true,
            last_opaque_sequence: 2,
            confirmed_exact_paths: BTreeSet::from([path.clone()]),
            terminal_exact_paths: BTreeSet::from([path.clone()]),
            exact_writes: BTreeMap::from([(
                path,
                ExactWrite {
                    sequence: 1,
                    before_hash: Some(digest(b"A\n")),
                    before_content: Some(Arc::from(&b"A\n"[..])),
                    before_missing: false,
                    expected_hash: digest(b"B\n"),
                },
            )]),
            ..MutationState::default()
        };

        let comparison =
            compare_turn_snapshots(true, true, Some(&baseline), Some(&terminal), &state);
        assert!(comparison.0.is_empty());
        assert_eq!(comparison.1, 0);
    }

    #[test]
    fn no_op_exact_write_cannot_claim_an_external_delta() {
        let tracker = TurnReceiptTracker::new_with_account(
            "turn".into(),
            1,
            Instant::now(),
            PathBuf::from("repo"),
            None,
        );
        tracker.begin_exact().finish_exact(
            Path::new("repo/file.txt"),
            Some(b"external\n"),
            b"external\n",
            ExactWriteOutcome::Unchanged,
        );

        let state = tracker.state.lock().unwrap();
        assert_eq!(state.active_mutations, 0);
        assert!(state.exact_writes.is_empty());
        assert!(state.confirmed_exact_paths.is_empty());

        let before = snapshot([("file.txt", entry("file.txt", "before", b"baseline\n"))]);
        let after = snapshot([("file.txt", entry("file.txt", "after", b"external\n"))]);
        let result = compare_snapshots(Some(&before), Some(&after), &state);
        assert_eq!(result.0.len(), 1);
        assert_eq!(result.0[0].certainty, TurnChangeCertainty::Ambiguous);
        assert_eq!(result.5, TurnChangeCertainty::Ambiguous);
    }

    #[test]
    fn unreadable_pre_write_bytes_are_uncertain_not_positive_evidence() {
        let tracker = TurnReceiptTracker::new_with_account(
            "turn".into(),
            1,
            Instant::now(),
            PathBuf::from("repo"),
            None,
        );
        tracker.begin_exact().finish_exact(
            Path::new("repo/file.txt"),
            None,
            b"possibly-same\n",
            ExactWriteOutcome::Unknown,
        );

        let state = tracker.state.lock().unwrap();
        assert_eq!(state.active_mutations, 0);
        assert!(state.uncertain_mutation);
        assert!(state.exact_writes.is_empty());
        assert!(state.confirmed_exact_paths.is_empty());

        let observed = snapshot([]);
        let incomplete = compare_snapshots(Some(&observed), None, &state);
        assert_eq!(incomplete.1, 0);
        assert_eq!(incomplete.5, TurnChangeCertainty::Unavailable);
    }
}
