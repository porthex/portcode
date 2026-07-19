//! Root-turn mutation provenance and immutable completion-receipt construction.
//!
//! The tracker is shared by the root and all subagents. It never attempts to
//! infer authorship from `git diff` alone: first-class file tools record expected
//! terminal bytes, foreground commands are opaque/observed, overlaps and active
//! background work are ambiguous, and capture failures are unavailable.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use portcode_sync::wire::{
    TurnChangeCertainty, TurnChangedFile, TurnFileStatus, TurnReceipt, TurnStatus,
};
use sha2::{Digest, Sha256};
use similar::{ChangeTag, TextDiff};

use crate::db;
use crate::git_review::{self, GitChangeStatus, TurnWorkspaceEntry, TurnWorkspaceSnapshot};

const MAX_RECEIPT_FILES: usize = 200;

/// Durable fail-closed row written before `TurnStart` is emitted or any async
/// workspace capture begins. A crash in that window therefore reloads as an
/// interrupted turn with unavailable provenance rather than disappearing.
pub(crate) fn unavailable_interrupted_receipt(turn_id: &str, started_at: i64) -> TurnReceipt {
    TurnReceipt {
        turn_id: turn_id.to_string(),
        status: TurnStatus::Interrupted,
        stop_reason: None,
        started_at,
        completed_at: started_at,
        duration_ms: None,
        changed_files: Vec::new(),
        changed_file_count: 0,
        additions: 0,
        deletions: 0,
        files_truncated: false,
        change_certainty: TurnChangeCertainty::Unavailable,
        background_tasks_running: false,
    }
}

#[derive(Clone, Debug)]
struct ExactWrite {
    sequence: u64,
    expected_hash: String,
}

#[derive(Debug, Default)]
struct MutationState {
    next_sequence: u64,
    active_mutations: usize,
    overlapping: bool,
    uncertain_mutation: bool,
    last_opaque_sequence: u64,
    opaque_seen: bool,
    exact_writes: BTreeMap<String, ExactWrite>,
    background_running: usize,
    background_ever: bool,
}

/// One root turn's baseline plus the mutation facts recorded by every actor in
/// its subagent tree.
pub(crate) struct TurnReceiptTracker {
    turn_id: String,
    started_at: i64,
    started: Instant,
    workspace: PathBuf,
    repository_root: Option<PathBuf>,
    baseline: Option<TurnWorkspaceSnapshot>,
    state: Mutex<MutationState>,
}

#[derive(Clone, Copy, Debug)]
enum MutationKind {
    Exact,
    Opaque,
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
            self.tracker.finish_uncertain(self.kind);
        }
    }
}

impl MutationToken {
    pub(crate) fn finish_exact(mut self, full_path: &Path, expected: &[u8]) {
        self.tracker
            .finish_exact(self.sequence, full_path, expected);
        self.completed = true;
    }

    pub(crate) fn finish_observed(mut self) {
        self.tracker.finish_observed();
        self.completed = true;
    }
}

pub(crate) struct CompletedReceipt {
    pub receipt: TurnReceipt,
    pub repository_root: Option<String>,
    pub terminal_snapshot_id: Option<String>,
}

impl TurnReceiptTracker {
    pub(crate) async fn new(
        turn_id: String,
        started_at: i64,
        started: Instant,
        workspace: PathBuf,
    ) -> Arc<Self> {
        let baseline = git_review::capture_turn_workspace(&workspace).await.ok();
        let repository_root = baseline
            .as_ref()
            .map(|snapshot| PathBuf::from(&snapshot.repository_root))
            .map(|root| root.canonicalize().unwrap_or(root));
        Arc::new(Self {
            turn_id,
            started_at,
            started,
            workspace,
            repository_root,
            baseline,
            state: Mutex::new(MutationState::default()),
        })
    }

    pub(crate) fn interrupted_placeholder(&self) -> TurnReceipt {
        TurnReceipt {
            turn_id: self.turn_id.clone(),
            status: TurnStatus::Interrupted,
            stop_reason: None,
            started_at: self.started_at,
            completed_at: self.started_at,
            duration_ms: None,
            changed_files: Vec::new(),
            changed_file_count: 0,
            additions: 0,
            deletions: 0,
            files_truncated: self.baseline.as_ref().is_some_and(|value| value.truncated),
            change_certainty: if self.baseline.is_some() {
                TurnChangeCertainty::Ambiguous
            } else {
                TurnChangeCertainty::Unavailable
            },
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
        if state.active_mutations > 0 {
            state.overlapping = true;
        }
        state.active_mutations = state.active_mutations.saturating_add(1);
        if matches!(kind, MutationKind::Opaque) {
            state.opaque_seen = true;
            state.last_opaque_sequence = sequence;
        }
        MutationToken {
            tracker: self.clone(),
            sequence,
            kind,
            completed: false,
        }
    }

    fn finish_exact(&self, sequence: u64, full_path: &Path, expected: &[u8]) {
        let mut state = self.state.lock().unwrap();
        state.active_mutations = state.active_mutations.saturating_sub(1);
        let Some(root) = self.repository_root.as_deref() else {
            state.uncertain_mutation = true;
            return;
        };
        let Ok(relative) = full_path.strip_prefix(root) else {
            state.uncertain_mutation = true;
            return;
        };
        let path = relative.to_string_lossy().replace('\\', "/");
        state.exact_writes.insert(
            path,
            ExactWrite {
                sequence,
                expected_hash: digest(expected),
            },
        );
    }

    fn finish_observed(&self) {
        let mut state = self.state.lock().unwrap();
        state.active_mutations = state.active_mutations.saturating_sub(1);
    }

    fn finish_uncertain(&self, kind: MutationKind) {
        let mut state = self.state.lock().unwrap();
        state.active_mutations = state.active_mutations.saturating_sub(1);
        state.uncertain_mutation = true;
        if matches!(kind, MutationKind::Opaque) {
            state.opaque_seen = true;
        }
    }

    pub(crate) fn background_started(&self) {
        let mut state = self.state.lock().unwrap();
        state.next_sequence = state.next_sequence.saturating_add(1);
        state.last_opaque_sequence = state.next_sequence;
        state.opaque_seen = true;
        state.background_ever = true;
        state.background_running = state.background_running.saturating_add(1);
    }

    pub(crate) fn background_finished(&self) {
        let mut state = self.state.lock().unwrap();
        state.background_running = state.background_running.saturating_sub(1);
    }

    pub(crate) async fn complete(
        &self,
        status: TurnStatus,
        stop_reason: Option<String>,
    ) -> CompletedReceipt {
        // Capture exactly once at the root terminal boundary. Background writes
        // landing later cannot alter this immutable receipt.
        let terminal = git_review::capture_turn_workspace(&self.workspace)
            .await
            .ok();
        let state = self.state.lock().unwrap();
        let background_running = state.background_running > 0;
        let (mut files, changed_file_count, additions, deletions, mut truncated, certainty) =
            compare_snapshots(self.baseline.as_ref(), terminal.as_ref(), &state);
        if files.len() > MAX_RECEIPT_FILES {
            files.truncate(MAX_RECEIPT_FILES);
            truncated = true;
        }
        let completed_at = db::now_ms().max(self.started_at);
        let duration_ms = self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        CompletedReceipt {
            receipt: TurnReceipt {
                turn_id: self.turn_id.clone(),
                status,
                stop_reason,
                started_at: self.started_at,
                completed_at,
                duration_ms: Some(duration_ms),
                changed_files: files,
                changed_file_count,
                additions,
                deletions,
                files_truncated: truncated,
                change_certainty: certainty,
                background_tasks_running: background_running,
            },
            repository_root: terminal
                .as_ref()
                .or(self.baseline.as_ref())
                .map(|value| value.repository_root.clone()),
            terminal_snapshot_id: terminal.as_ref().map(|value| value.snapshot_id.clone()),
        }
    }
}

fn compare_snapshots(
    baseline: Option<&TurnWorkspaceSnapshot>,
    terminal: Option<&TurnWorkspaceSnapshot>,
    state: &MutationState,
) -> (
    Vec<TurnChangedFile>,
    u64,
    u64,
    u64,
    bool,
    TurnChangeCertainty,
) {
    let (Some(baseline), Some(terminal)) = (baseline, terminal) else {
        return (Vec::new(), 0, 0, 0, false, TurnChangeCertainty::Unavailable);
    };
    let identity_changed = baseline.repository_root != terminal.repository_root
        || baseline.head_oid != terminal.head_oid;
    let globally_ambiguous = identity_changed
        || baseline.truncated
        || terminal.truncated
        || state.overlapping
        || state.uncertain_mutation
        || state.background_running > 0;

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
            path,
            before,
            Some(after),
            state,
            globally_ambiguous,
        ));
    }
    for (path, before) in &baseline.entries {
        if used_baseline.contains(path) || terminal.entries.contains_key(path) {
            continue;
        }
        changed.push(changed_file(
            path,
            Some(before),
            None,
            state,
            globally_ambiguous,
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

fn changed_file(
    path: &str,
    before: Option<&TurnWorkspaceEntry>,
    after: Option<&TurnWorkspaceEntry>,
    state: &MutationState,
    globally_ambiguous: bool,
) -> TurnChangedFile {
    let (additions, deletions) = line_counts(before, after);
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
    } else if exact_terminal_match(path, after, state) {
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
    path: &str,
    after: Option<&TurnWorkspaceEntry>,
    state: &MutationState,
) -> bool {
    let Some(expected) = state.exact_writes.get(path) else {
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
) -> (Option<u64>, Option<u64>) {
    match (
        before.and_then(|entry| entry.content.as_deref()),
        after.and_then(|entry| entry.content.as_deref()),
    ) {
        (Some(old), Some(new)) if !is_binary(old) && !is_binary(new) => {
            let (Ok(old), Ok(new)) = (std::str::from_utf8(old), std::str::from_utf8(new)) else {
                return (None, None);
            };
            let mut additions = 0_u64;
            let mut deletions = 0_u64;
            for change in TextDiff::from_lines(old, new).iter_all_changes() {
                match change.tag() {
                    ChangeTag::Insert => additions = additions.saturating_add(1),
                    ChangeTag::Delete => deletions = deletions.saturating_add(1),
                    ChangeTag::Equal => {}
                }
            }
            (Some(additions), Some(deletions))
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
            "file.txt".into(),
            ExactWrite {
                sequence: 1,
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
}
