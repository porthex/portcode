#![cfg(desktop)]

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use std::time::Duration;

use portcode_sync::wire::{TurnChangedFile, TurnReceipt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::TextDiff;
use tauri::State;
use tokio::io::AsyncReadExt;

use crate::{git, AppState};

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const METADATA_CAP: usize = 4 * 1024 * 1024;
const PATCH_CAP: usize = 2 * 1024 * 1024;
const UNTRACKED_TEXT_CAP: u64 = 512 * 1024;
const SNAPSHOT_FILE_CAP: u64 = 8 * 1024 * 1024;
const SNAPSHOT_TOTAL_CAP: u64 = 32 * 1024 * 1024;
const SNAPSHOT_HASH_FILE_CAP: u64 = 16 * 1024 * 1024;
const SNAPSHOT_HASH_TOTAL_CAP: u64 = 32 * 1024 * 1024;
const TURN_SNAPSHOT_ENTRY_CAP: usize = 1_000;
const MAX_DIFF_LINES: usize = 4_000;
const STALE_REVIEW_ERROR: &str =
    "The working tree changed. Refresh the review before opening this file.";
const COMBINED_DIFF_ERROR: &str =
    "Combined merge diffs are not supported. Review the merge as a branch diff instead.";

static TURN_CAPTURE_LOCKS: OnceLock<StdMutex<BTreeMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GitReviewScope {
    WorkingTree,
    Staged,
    Unstaged,
    Branch { base: String },
    Commit { revision: String },
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitChangeArea {
    Staged,
    Unstaged,
    Untracked,
    Committed,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Unmerged,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum GitReviewBranchKind {
    Local,
    Remote,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewBranch {
    pub name: String,
    pub revision: String,
    pub kind: GitReviewBranchKind,
    pub current: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: GitChangeStatus,
    pub areas: Vec<GitChangeArea>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub binary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewManifest {
    pub snapshot_id: String,
    pub repository_root: String,
    pub scope: GitReviewScope,
    pub base_label: String,
    pub target_label: String,
    pub head_oid: Option<String>,
    pub files: Vec<GitChangedFile>,
    pub additions: u64,
    pub deletions: u64,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitDiffLineKind {
    Context,
    Addition,
    Deletion,
    Meta,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffLine {
    pub kind: GitDiffLineKind,
    pub content: String,
    pub old_line: Option<u64>,
    pub new_line: Option<u64>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffHunk {
    pub header: String,
    pub old_start: u64,
    pub old_lines: u64,
    pub new_start: u64,
    pub new_lines: u64,
    pub lines: Vec<GitDiffLine>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFilePatch {
    pub snapshot_id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub status: GitChangeStatus,
    pub binary: bool,
    pub file_patch_hash: String,
    pub hunks: Vec<GitDiffHunk>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnReviewManifest {
    pub turn_id: String,
    pub snapshot_id: String,
    pub repository_root: String,
    pub receipt: TurnReceipt,
    pub files: Vec<TurnChangedFile>,
    pub additions: u64,
    pub deletions: u64,
    pub truncated: bool,
    pub patches_available: bool,
}

/// Bounded workspace identity captured at a root-turn boundary. Entry content is
/// retained only in memory and only under the existing snapshot caps; the durable
/// receipt stores the immutable changed-file manifest, not source bytes.
#[derive(Clone, Debug)]
pub(crate) struct TurnWorkspaceSnapshot {
    pub repository_root: String,
    pub snapshot_id: String,
    pub head_oid: Option<String>,
    pub entries: BTreeMap<String, TurnWorkspaceEntry>,
    /// Current identities for explicitly written paths, including clean tracked
    /// paths omitted by `git status`. This lets turn-relative comparison prove a
    /// restore-to-preimage without another Git child or following unsafe links.
    pub exact_paths: BTreeMap<String, TurnExactPathState>,
    /// True when the bounded entry map may omit paths. Kept separate from the
    /// broader `truncated` flag, which also covers complete membership with
    /// content omitted under byte caps.
    pub membership_truncated: bool,
    pub truncated: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct TurnExactPathState {
    pub digest: Option<String>,
    pub missing: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct TurnWorkspaceEntry {
    pub file: GitChangedFile,
    pub fingerprint: String,
    pub content: Option<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StatusEntry {
    path: String,
    old_path: Option<String>,
    status: GitChangeStatus,
    index_changed: bool,
    worktree_changed: bool,
    untracked: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Numstat {
    additions: Option<u64>,
    deletions: Option<u64>,
}

impl Default for Numstat {
    fn default() -> Self {
        Self {
            additions: Some(0),
            deletions: Some(0),
        }
    }
}

impl Numstat {
    fn binary(self) -> bool {
        self.additions.is_none() || self.deletions.is_none()
    }

    fn merge(self, other: Self) -> Self {
        Self {
            additions: merge_count(self.additions, other.additions),
            deletions: merge_count(self.deletions, other.deletions),
        }
    }
}

#[derive(Clone, Debug)]
enum ResolvedScope {
    WorkingTree { head: Option<String> },
    Staged { head: Option<String> },
    Unstaged { head: Option<String> },
    Branch { base_oid: String, head_oid: String },
    Commit { oid: String },
}

impl ResolvedScope {
    fn labels(&self, requested: &GitReviewScope) -> (String, String) {
        match (self, requested) {
            (Self::WorkingTree { head }, _) => (
                head.as_deref()
                    .map(short_oid)
                    .unwrap_or_else(|| "Empty tree".into()),
                "Working tree".into(),
            ),
            (Self::Staged { head }, _) => (
                head.as_deref()
                    .map(short_oid)
                    .unwrap_or_else(|| "Empty tree".into()),
                "Index".into(),
            ),
            (Self::Unstaged { .. }, _) => ("Index".into(), "Working tree".into()),
            (Self::Branch { base_oid, .. }, GitReviewScope::Branch { base }) => (
                format!(
                    "merge-base({}) · {}",
                    branch_display_name(base),
                    short_oid(base_oid)
                ),
                "HEAD".into(),
            ),
            (Self::Commit { oid }, GitReviewScope::Commit { revision }) => {
                (format!("parent of {}", short_oid(oid)), revision.clone())
            }
            _ => ("Base".into(), "Target".into()),
        }
    }

    /// Bind a review snapshot to the immutable commits its user-facing scope
    /// resolved to. A branch name or abbreviated revision can be moved/reused
    /// without changing the requested scope string, and name/status metadata alone
    /// is not enough to notice that stale-anchor change.
    fn append_snapshot_identity(&self, material: &mut Vec<u8>) {
        material.extend_from_slice(b"\0resolved-scope\0");
        match self {
            Self::WorkingTree { head } => append_optional_oid(material, b"working-tree", head),
            Self::Staged { head } => append_optional_oid(material, b"staged", head),
            Self::Unstaged { head } => append_optional_oid(material, b"unstaged", head),
            Self::Branch { base_oid, head_oid } => {
                material.extend_from_slice(b"branch\0");
                material.extend_from_slice(base_oid.as_bytes());
                material.push(0);
                material.extend_from_slice(head_oid.as_bytes());
            }
            Self::Commit { oid } => {
                material.extend_from_slice(b"commit\0");
                material.extend_from_slice(oid.as_bytes());
            }
        }
    }
}

fn append_optional_oid(material: &mut Vec<u8>, label: &[u8], oid: &Option<String>) {
    material.extend_from_slice(label);
    material.push(0);
    material.extend_from_slice(oid.as_deref().unwrap_or("(initial)").as_bytes());
}

#[derive(Clone, Debug)]
struct RepositoryContext {
    root: PathBuf,
    prefix: String,
}

enum InspectedUntrackedPath {
    File(PathBuf, std::fs::Metadata),
    Symlink(PathBuf, std::fs::Metadata),
}

/// Read the review manifest for the native settings workspace. The frontend
/// selects only a typed scope; it never supplies a repository root.
#[tauri::command]
pub async fn get_git_review_manifest(
    state: State<'_, AppState>,
    scope: GitReviewScope,
) -> Result<GitReviewManifest, String> {
    let workspace = configured_workspace(&state)?;
    build_manifest(&workspace, scope).await
}

/// List concrete local and remote branches from the repository that owns the
/// configured workspace. Symbolic aliases such as `origin/HEAD` are omitted so
/// every option resolves to an actual review base.
#[tauri::command]
pub async fn get_git_review_branches(
    state: State<'_, AppState>,
) -> Result<Vec<GitReviewBranch>, String> {
    let workspace = configured_workspace(&state)?;
    let context = repository_context(&workspace).await?;
    let output = run_ok(
        &context.root,
        vec![
            OsString::from("for-each-ref"),
            OsString::from("--format=%(refname)%00%(HEAD)%00%(symref)%00"),
            OsString::from("--"),
            OsString::from("refs/heads"),
            OsString::from("refs/remotes"),
        ],
        512 * 1024,
    )
    .await?;
    if output.truncated {
        return Err("The repository has too many branches to list safely.".into());
    }
    parse_review_branches(&output.stdout)
}

/// Return one typed, line-addressable patch. The snapshot precondition prevents
/// a delayed file request from presenting a patch under a newer manifest.
#[tauri::command]
pub async fn get_git_review_file(
    state: State<'_, AppState>,
    scope: GitReviewScope,
    snapshot_id: String,
    path: String,
) -> Result<GitFilePatch, String> {
    let workspace = configured_workspace(&state)?;
    let manifest = build_manifest(&workspace, scope.clone()).await?;
    ensure_snapshot_current(&snapshot_id, &manifest.snapshot_id)?;
    let file = manifest
        .files
        .iter()
        .find(|file| file.path == path)
        .cloned()
        .ok_or_else(|| "The requested path is not part of this review snapshot.".to_string())?;
    let context = repository_context(&workspace).await?;
    let resolved = resolve_scope(&context.root, &scope).await?;

    let (patch, command_truncated) = if file.binary {
        (Vec::new(), false)
    } else if file.areas.contains(&GitChangeArea::Untracked) {
        (untracked_patch(&context.root, &file.path).await?, false)
    } else {
        patch_for_file(&context.root, &resolved, &file.path).await?
    };
    let binary =
        file.binary || std::str::from_utf8(&patch).is_err() || patch_has_binary_marker(&patch);

    let file_patch_hash = digest_hex(&patch);
    let (hunks, line_truncated) = if binary {
        (Vec::new(), false)
    } else {
        parse_unified_patch(std::str::from_utf8(&patch).map_err(|_| "Patch is not UTF-8.")?)?
    };

    let response = GitFilePatch {
        snapshot_id: snapshot_id.clone(),
        path: file.path,
        old_path: file.old_path,
        status: file.status,
        binary,
        file_patch_hash,
        hunks,
        truncated: command_truncated || line_truncated,
    };

    // Patch generation can race an agent or external editor. Rebuild the complete
    // manifest after the patch has been read and parsed, as close as possible to
    // returning it, so stale line anchors never escape under the old snapshot id.
    let current = build_manifest(&workspace, scope).await?;
    ensure_snapshot_current(&snapshot_id, &current.snapshot_id)?;
    Ok(response)
}

/// Immutable manifest persisted with a completed root turn. Unlike workspace
/// Review, this never recomputes file membership from the current working tree.
#[tauri::command]
pub async fn get_turn_review_manifest(
    state: State<'_, AppState>,
    turn_id: String,
) -> Result<TurnReviewManifest, String> {
    turn_review_manifest(&state.db, turn_id)
}

fn turn_review_manifest(db: &crate::db::Db, turn_id: String) -> Result<TurnReviewManifest, String> {
    let record = db
        .get_turn_receipt(&turn_id)
        .ok_or_else(|| "Turn receipt was not found.".to_string())?;
    Ok(TurnReviewManifest {
        turn_id,
        snapshot_id: record
            .terminal_snapshot_id
            .unwrap_or_else(|| "unavailable".into()),
        repository_root: record.repository_root.unwrap_or_default(),
        files: record.receipt.changed_files.clone(),
        additions: record.receipt.additions,
        deletions: record.receipt.deletions,
        truncated: record.receipt.files_truncated,
        receipt: record.receipt,
        // Baseline source bytes are intentionally not persisted in this pass.
        patches_available: false,
    })
}

/// Historical patch bytes are not persisted yet. Validate both the receipt and
/// path so callers get a deterministic expiration error rather than accidentally
/// falling back to a similarly named file in the current workspace.
#[tauri::command]
pub async fn get_turn_review_file(
    state: State<'_, AppState>,
    turn_id: String,
    path: String,
) -> Result<GitFilePatch, String> {
    let record = state
        .db
        .get_turn_receipt(&turn_id)
        .ok_or_else(|| "Turn receipt was not found.".to_string())?;
    if !record
        .receipt
        .changed_files
        .iter()
        .any(|file| file.path == path)
    {
        return Err("The requested path is not part of this turn receipt.".into());
    }
    Err("Historical patch unavailable: this receipt retained the immutable file manifest but not source contents.".into())
}

fn ensure_snapshot_current(expected: &str, current: &str) -> Result<(), String> {
    if expected == current {
        Ok(())
    } else {
        Err(STALE_REVIEW_ERROR.into())
    }
}

fn configured_workspace(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let configured = state.settings.lock().unwrap().workspace.clone();
    match configured {
        Some(path) => Ok(PathBuf::from(path)),
        None => std::env::current_dir().map_err(|error| {
            format!("No workspace is set and the current directory is unavailable: {error}")
        }),
    }
}

async fn build_manifest(
    workspace: &Path,
    scope: GitReviewScope,
) -> Result<GitReviewManifest, String> {
    let context = repository_context(workspace).await?;
    build_manifest_in_context(&context, scope).await
}

async fn build_manifest_in_context(
    context: &RepositoryContext,
    scope: GitReviewScope,
) -> Result<GitReviewManifest, String> {
    let resolved = resolve_scope(&context.root, &scope).await?;
    let head_oid = match &resolved {
        ResolvedScope::WorkingTree { head }
        | ResolvedScope::Staged { head }
        | ResolvedScope::Unstaged { head } => head.clone(),
        ResolvedScope::Branch { head_oid, .. } => Some(head_oid.clone()),
        ResolvedScope::Commit { .. } => optional_oid(&context.root, "HEAD").await?,
    };
    let (mut files, mut metadata, mut metadata_truncated) = match &resolved {
        ResolvedScope::WorkingTree { .. }
        | ResolvedScope::Staged { .. }
        | ResolvedScope::Unstaged { .. } => worktree_files(context, &scope, &resolved).await?,
        ResolvedScope::Branch { base_oid, head_oid } => {
            committed_files(context, &[base_oid, head_oid], None).await?
        }
        ResolvedScope::Commit { oid } => committed_files(context, &[], Some(oid.as_str())).await?,
    };

    if matches!(
        scope,
        GitReviewScope::WorkingTree | GitReviewScope::Unstaged
    ) {
        metadata_truncated |=
            append_worktree_fingerprints(&context.root, &files, &mut metadata).await;
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));
    let additions = files.iter().filter_map(|file| file.additions).sum();
    let deletions = files.iter().filter_map(|file| file.deletions).sum();
    let (base_label, target_label) = resolved.labels(&scope);

    let mut snapshot_material = serde_json::to_vec(&scope).map_err(|error| error.to_string())?;
    resolved.append_snapshot_identity(&mut snapshot_material);
    snapshot_material.extend_from_slice(head_oid.as_deref().unwrap_or("(initial)").as_bytes());
    snapshot_material.extend_from_slice(&metadata);

    Ok(GitReviewManifest {
        snapshot_id: digest_hex(&snapshot_material),
        repository_root: context.root.to_string_lossy().into_owned(),
        scope,
        base_label,
        target_label,
        head_oid,
        files,
        additions,
        deletions,
        truncated: metadata_truncated,
    })
}

/// Capture the current working-tree identity for turn attribution. A path entry
/// includes Git/index metadata plus a bounded, symlink-safe worktree fingerprint,
/// so an untouched pre-existing dirty path compares equal at terminal time.
pub(crate) async fn capture_turn_workspace(
    workspace: &Path,
) -> Result<TurnWorkspaceSnapshot, String> {
    let context = repository_context(workspace).await?;
    let capture_lock = turn_capture_lock(&context.root);
    let _capture = capture_lock.lock().await;
    capture_turn_workspace_inner(&context, None).await
}

pub(crate) async fn capture_turn_workspace_with_paths(
    workspace: &Path,
    paths: &[PathBuf],
) -> Result<TurnWorkspaceSnapshot, String> {
    let context = repository_context(workspace).await?;
    let capture_lock = turn_capture_lock(&context.root);
    let _capture = capture_lock.lock().await;
    let selected = exact_repository_paths(&context.root, workspace, paths)?;
    capture_turn_workspace_inner(&context, Some(&selected)).await
}

/// Capture only receipt entries that intersect a bounded set of exact tool
/// targets. Git metadata is still read in bulk for a consistent repository
/// identity; the number of child processes is independent of the path count.
pub(crate) async fn capture_turn_paths(
    workspace: &Path,
    paths: &[PathBuf],
) -> Result<TurnWorkspaceSnapshot, String> {
    let context = repository_context(workspace).await?;
    let capture_lock = turn_capture_lock(&context.root);
    let _capture = capture_lock.lock().await;
    let selected = exact_repository_paths(&context.root, workspace, paths)?;
    capture_turn_paths_inner(&context, &selected).await
}

fn turn_capture_lock(root: &Path) -> Arc<tokio::sync::Mutex<()>> {
    let locks = TURN_CAPTURE_LOCKS.get_or_init(|| StdMutex::new(BTreeMap::new()));
    let mut locks = locks.lock().unwrap();
    if let Some(lock) = locks.get(root).and_then(Weak::upgrade) {
        return lock;
    }
    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(root.to_path_buf(), Arc::downgrade(&lock));
    lock
}

/// Exact turns never need a whole-worktree manifest. Two scoped status reads and
/// two bounded passes over only the selected files provide a race-checked terminal
/// image in three Git children total including repository discovery.
async fn capture_turn_paths_inner(
    context: &RepositoryContext,
    selected: &BTreeSet<String>,
) -> Result<TurnWorkspaceSnapshot, String> {
    let args = exact_status_args(selected);
    let first_status = run_ok(&context.root, args.clone(), METADATA_CAP).await?;
    let (first_entries, first_membership_truncated, first_truncated) =
        scoped_turn_entries(&context.root, &first_status).await?;

    let second_status = run_ok(&context.root, args, METADATA_CAP).await?;
    let (entries, second_membership_truncated, second_truncated) =
        scoped_turn_entries(&context.root, &second_status).await?;
    let raced = first_status.stdout != second_status.stdout
        || first_entries.len() != entries.len()
        || first_entries.iter().any(|(path, first)| {
            entries
                .get(path)
                .is_none_or(|second| first.fingerprint != second.fingerprint)
        });

    let mut snapshot_material = second_status.stdout.clone();
    for (path, entry) in &entries {
        snapshot_material.extend_from_slice(path.as_bytes());
        snapshot_material.push(0);
        snapshot_material.extend_from_slice(entry.fingerprint.as_bytes());
        snapshot_material.push(0);
    }
    Ok(TurnWorkspaceSnapshot {
        repository_root: context.root.to_string_lossy().into_owned(),
        snapshot_id: digest_hex(&snapshot_material),
        head_oid: porcelain_head_oid(&second_status.stdout),
        entries,
        exact_paths: BTreeMap::new(),
        membership_truncated: first_membership_truncated || second_membership_truncated || raced,
        truncated: first_truncated || second_truncated || raced,
    })
}

fn exact_status_args(selected: &BTreeSet<String>) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("status"),
        OsString::from("--porcelain=v2"),
        OsString::from("--branch"),
        OsString::from("-z"),
        OsString::from("--untracked-files=all"),
        OsString::from("--"),
    ];
    args.extend(
        selected
            .iter()
            .map(|path| OsString::from(format!(":(literal){path}"))),
    );
    args
}

async fn scoped_turn_entries(
    root: &Path,
    status: &git::Output,
) -> Result<(BTreeMap<String, TurnWorkspaceEntry>, bool, bool), String> {
    let status_entries = parse_porcelain(&status.stdout)?;
    let membership_truncated = status.truncated || status_entries.len() > TURN_SNAPSHOT_ENTRY_CAP;
    let mut truncated = membership_truncated;
    let mut total = 0_u64;
    let mut hashed_total = 0_u64;
    let mut entries = BTreeMap::new();
    for status_entry in status_entries.into_iter().take(TURN_SNAPSHOT_ENTRY_CAP) {
        let areas = entry_areas(&status_entry, &GitReviewScope::WorkingTree);
        if areas.is_empty() {
            continue;
        }
        let file = GitChangedFile {
            path: status_entry.path,
            old_path: status_entry.old_path,
            status: status_entry.status,
            areas,
            additions: None,
            deletions: None,
            binary: false,
        };
        let (fingerprint, content, entry_truncated) = turn_entry_identity(
            root,
            &file,
            Some(&status.stdout),
            status.truncated,
            &mut total,
            &mut hashed_total,
        )
        .await;
        truncated |= entry_truncated;
        entries.insert(
            file.path.clone(),
            TurnWorkspaceEntry {
                file,
                fingerprint,
                content,
            },
        );
    }
    Ok((entries, membership_truncated, truncated))
}

fn porcelain_head_oid(output: &[u8]) -> Option<String> {
    output
        .split(|byte| *byte == 0)
        .find_map(|field| field.strip_prefix(b"# branch.oid "))
        .and_then(|oid| std::str::from_utf8(oid).ok())
        .filter(|oid| *oid != "(initial)")
        .map(str::to_string)
}

async fn capture_exact_path_states(
    root: &Path,
    selected: Option<&BTreeSet<String>>,
) -> (BTreeMap<String, TurnExactPathState>, bool) {
    let Some(selected) = selected else {
        return (BTreeMap::new(), false);
    };
    let mut states = BTreeMap::new();
    let mut hashed_total = 0_u64;
    let mut truncated = selected.len() > TURN_SNAPSHOT_ENTRY_CAP;
    for path in selected.iter().take(TURN_SNAPSHOT_ENTRY_CAP) {
        match inspect_untracked_path(root, path).await {
            Ok(InspectedUntrackedPath::File(full, metadata)) if metadata.is_file() => {
                let remaining = SNAPSHOT_HASH_TOTAL_CAP.saturating_sub(hashed_total);
                let budget = remaining.min(SNAPSHOT_HASH_FILE_CAP);
                let digest = if metadata.len() <= budget {
                    match hash_file(&full, budget).await {
                        Ok(Some((hash, bytes))) => {
                            hashed_total = hashed_total.saturating_add(bytes);
                            Some(hex_digest(&hash))
                        }
                        _ => {
                            truncated = true;
                            None
                        }
                    }
                } else {
                    truncated = true;
                    None
                };
                states.insert(
                    path.clone(),
                    TurnExactPathState {
                        digest,
                        missing: false,
                    },
                );
            }
            Ok(InspectedUntrackedPath::File(_, _)) | Ok(InspectedUntrackedPath::Symlink(_, _)) => {
                truncated = true;
                states.insert(
                    path.clone(),
                    TurnExactPathState {
                        digest: None,
                        missing: false,
                    },
                );
            }
            Err(_) => {
                let missing = tokio::fs::symlink_metadata(root.join(path))
                    .await
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
                truncated |= !missing;
                states.insert(
                    path.clone(),
                    TurnExactPathState {
                        digest: None,
                        missing,
                    },
                );
            }
        }
    }
    (states, truncated)
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    use std::fmt::Write as _;
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

async fn capture_turn_workspace_inner(
    context: &RepositoryContext,
    selected: Option<&BTreeSet<String>>,
) -> Result<TurnWorkspaceSnapshot, String> {
    // Commands start in the configured workspace but can `cd` within its enclosing
    // repository. Capture the full worktree, not merely the configured subdirectory.
    let root_context = RepositoryContext {
        root: context.root.clone(),
        prefix: ".".into(),
    };
    let manifest = build_manifest_in_context(&root_context, GitReviewScope::WorkingTree).await?;
    let root = PathBuf::from(&manifest.repository_root);
    let (index_identities, index_truncated) = match turn_index_identities(&root).await {
        Ok(value) => value,
        Err(_) => (BTreeMap::new(), true),
    };
    let mut entries = BTreeMap::new();
    let mut total = 0_u64;
    let mut hashed_total = 0_u64;
    let matching_count = manifest.files.len();
    let mut membership_truncated = manifest.truncated || matching_count > TURN_SNAPSHOT_ENTRY_CAP;
    let mut truncated = membership_truncated || index_truncated;

    for file in manifest.files.iter().take(TURN_SNAPSHOT_ENTRY_CAP) {
        let (fingerprint, content, entry_truncated) = turn_entry_identity(
            &root,
            file,
            index_identities.get(&file.path).map(Vec::as_slice),
            index_truncated,
            &mut total,
            &mut hashed_total,
        )
        .await;
        truncated |= entry_truncated;
        entries.insert(
            file.path.clone(),
            TurnWorkspaceEntry {
                file: file.clone(),
                fingerprint,
                content,
            },
        );
    }

    let (exact_paths, exact_truncated) = capture_exact_path_states(&root, selected).await;
    truncated |= exact_truncated;

    // Entry hashing spans multiple filesystem reads. Detect an editor/agent race
    // across that window and degrade provenance instead of blessing a mixed image.
    match build_manifest_in_context(&root_context, GitReviewScope::WorkingTree).await {
        Ok(current) if current.snapshot_id == manifest.snapshot_id => {}
        _ => {
            truncated = true;
            membership_truncated = true;
        }
    }

    Ok(TurnWorkspaceSnapshot {
        repository_root: manifest.repository_root,
        snapshot_id: manifest.snapshot_id,
        head_oid: manifest.head_oid,
        entries,
        exact_paths,
        membership_truncated,
        truncated,
    })
}

fn exact_repository_paths(
    root: &Path,
    workspace: &Path,
    paths: &[PathBuf],
) -> Result<BTreeSet<String>, String> {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut selected = BTreeSet::new();
    for path in paths {
        let full = if path.is_absolute() {
            path.clone()
        } else {
            workspace.join(path)
        };
        let normalized = full.canonicalize().or_else(|_| {
            let parent = full.parent().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
            })?;
            let name = full.file_name().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no name")
            })?;
            parent.canonicalize().map(|parent| parent.join(name))
        });
        let normalized = normalized
            .map_err(|_| "An exact write target could not be resolved safely.".to_string())?;
        let relative = normalized.strip_prefix(&canonical_root).map_err(|_| {
            "An exact write target is outside the workspace repository.".to_string()
        })?;
        selected.insert(relative.to_string_lossy().replace('\\', "/"));
    }
    Ok(selected)
}

/// Read every index stage in one process. The previous implementation launched
/// `git ls-files --stage` once per dirty file, turning a 117-file worktree into
/// hundreds of child processes across the two receipt boundaries.
async fn turn_index_identities(root: &Path) -> Result<(BTreeMap<String, Vec<u8>>, bool), String> {
    let output = run_ok(
        root,
        vec![
            OsString::from("ls-files"),
            OsString::from("--stage"),
            OsString::from("--full-name"),
            OsString::from("-z"),
        ],
        METADATA_CAP,
    )
    .await?;
    let identities = parse_turn_index_identities(&output.stdout)?;
    Ok((identities, output.truncated))
}

fn parse_turn_index_identities(output: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    if !output.is_empty() && !output.ends_with(&[0]) {
        return Err("Git index metadata ended inside a record.".into());
    }
    let mut identities: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for record in output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let separator = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or("Git index metadata is missing its path separator.")?;
        let metadata = strict_text(&record[..separator], "Git index metadata")?;
        let fields: Vec<_> = metadata.split_ascii_whitespace().collect();
        if fields.len() != 3
            || fields[0].len() != 6
            || !fields[0].bytes().all(|byte| byte.is_ascii_digit())
            || !matches!(fields[1].len(), 40 | 64)
            || !fields[1].bytes().all(|byte| byte.is_ascii_hexdigit())
            || !matches!(fields[2], "0" | "1" | "2" | "3")
        {
            return Err("Git index metadata has an invalid stage record.".into());
        }
        let path = strict_path(&record[separator + 1..])?;
        if path.is_empty()
            || Path::new(&path).is_absolute()
            || Path::new(&path)
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("Git index metadata contains an unsafe path.".into());
        }
        let identity = identities.entry(path).or_default();
        identity.extend_from_slice(record);
        identity.push(0);
    }
    Ok(identities)
}

async fn turn_entry_identity(
    root: &Path,
    file: &GitChangedFile,
    index_identity: Option<&[u8]>,
    index_truncated: bool,
    total: &mut u64,
    hashed_total: &mut u64,
) -> (String, Option<Vec<u8>>, bool) {
    let mut material = serde_json::to_vec(file).unwrap_or_default();
    let mut truncated = index_truncated;

    // The index identity is needed even when worktree bytes are unchanged (for
    // example, `git add`/`git reset` during an opaque command).
    match index_identity {
        Some(identity) => material.extend_from_slice(identity),
        None => material.extend_from_slice(b"(not-in-index)"),
    }

    let full = root.join(&file.path);
    let Ok(metadata) = tokio::fs::symlink_metadata(&full).await else {
        material.extend_from_slice(b"(missing)");
        return (digest_hex(&material), None, truncated);
    };
    material.extend_from_slice(&metadata.len().to_le_bytes());
    if metadata.file_type().is_symlink() {
        match tokio::fs::read_link(&full).await {
            Ok(target) => material.extend_from_slice(target.as_os_str().as_encoded_bytes()),
            Err(_) => truncated = true,
        }
        return (digest_hex(&material), None, truncated);
    }
    if !metadata.is_file() {
        truncated = true;
        return (digest_hex(&material), None, truncated);
    }
    let retain_content = metadata.len() <= SNAPSHOT_FILE_CAP
        && total.saturating_add(metadata.len()) <= SNAPSHOT_TOTAL_CAP
        && hashed_total.saturating_add(metadata.len()) <= SNAPSHOT_HASH_TOTAL_CAP;
    if retain_content {
        match read_file_capped(&full, metadata.len()).await {
            Ok(Some(bytes)) => {
                material.extend_from_slice(&Sha256::digest(&bytes));
                *total = total.saturating_add(metadata.len());
                *hashed_total = hashed_total.saturating_add(bytes.len() as u64);
                (digest_hex(&material), Some(bytes), truncated)
            }
            Ok(None) | Err(_) => {
                truncated = true;
                (digest_hex(&material), None, truncated)
            }
        }
    } else {
        // Retention caps limit memory and line-count reconstruction, not identity.
        // Stream the entire file into the fingerprint so same-size large/binary
        // edits still compare differently across turn boundaries.
        let remaining = SNAPSHOT_HASH_TOTAL_CAP.saturating_sub(*hashed_total);
        let hash_budget = remaining.min(SNAPSHOT_HASH_FILE_CAP);
        if metadata.len() > hash_budget {
            truncated = true;
            return (digest_hex(&material), None, truncated);
        }
        match hash_file(&full, hash_budget).await {
            Ok(Some((hash, bytes_hashed))) => {
                material.extend_from_slice(&hash);
                *hashed_total = hashed_total.saturating_add(bytes_hashed);
                truncated = true;
                (digest_hex(&material), None, truncated)
            }
            Ok(None) | Err(_) => {
                truncated = true;
                (digest_hex(&material), None, truncated)
            }
        }
    }
}

async fn read_file_capped(path: &Path, max_bytes: u64) -> std::io::Result<Option<Vec<u8>>> {
    let file = tokio::fs::File::open(path).await?;
    let mut reader = file.take(max_bytes.saturating_add(1));
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).await?;
    if bytes.len() as u64 > max_bytes {
        Ok(None)
    } else {
        Ok(Some(bytes))
    }
}

async fn hash_file(path: &Path, max_bytes: u64) -> std::io::Result<Option<([u8; 32], u64)>> {
    let file = tokio::fs::File::open(path).await?;
    let mut file = file.take(max_bytes.saturating_add(1));
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > max_bytes {
            return Ok(None);
        }
        hash.update(&buffer[..read]);
    }
    Ok(Some((hash.finalize().into(), total)))
}

async fn append_worktree_fingerprints(
    root: &Path,
    files: &[GitChangedFile],
    material: &mut Vec<u8>,
) -> bool {
    let mut hashed_total = 0_u64;
    let mut truncated = false;
    for file in files.iter().filter(|file| {
        file.areas.contains(&GitChangeArea::Unstaged)
            || file.areas.contains(&GitChangeArea::Untracked)
    }) {
        material.extend_from_slice(file.path.as_bytes());
        let (full, metadata) = if file.areas.contains(&GitChangeArea::Untracked) {
            match inspect_untracked_path(root, &file.path).await {
                Ok(InspectedUntrackedPath::File(full, metadata)) => (full, metadata),
                Ok(InspectedUntrackedPath::Symlink(link, metadata)) => {
                    // Fingerprint the link itself, never its target's bytes. This
                    // also covers a symlink in an intermediate path component.
                    material.extend_from_slice(&metadata.len().to_le_bytes());
                    match tokio::fs::read_link(&link).await {
                        Ok(target) => {
                            material.extend_from_slice(target.as_os_str().as_encoded_bytes())
                        }
                        Err(_) => truncated = true,
                    }
                    continue;
                }
                Err(_) => {
                    material.extend_from_slice(b"(unsafe-untracked-path)");
                    truncated = true;
                    continue;
                }
            }
        } else {
            let lexical = root.join(&file.path);
            let Ok(metadata) = tokio::fs::symlink_metadata(&lexical).await else {
                material.extend_from_slice(b"(missing)");
                continue;
            };
            (lexical, metadata)
        };
        material.extend_from_slice(&metadata.len().to_le_bytes());
        if let Ok(modified) = metadata.modified() {
            if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                material.extend_from_slice(&duration.as_nanos().to_le_bytes());
            }
        }
        if metadata.file_type().is_symlink() {
            match tokio::fs::read_link(&full).await {
                Ok(target) => material.extend_from_slice(target.as_os_str().as_encoded_bytes()),
                Err(_) => truncated = true,
            }
            continue;
        }
        if !metadata.is_file() {
            truncated = true;
            continue;
        }
        let remaining = SNAPSHOT_HASH_TOTAL_CAP.saturating_sub(hashed_total);
        let hash_budget = remaining.min(SNAPSHOT_HASH_FILE_CAP);
        if metadata.len() > hash_budget {
            truncated = true;
            continue;
        }
        match hash_file(&full, hash_budget).await {
            Ok(Some((hash, bytes_hashed))) => {
                material.extend_from_slice(&hash);
                hashed_total = hashed_total.saturating_add(bytes_hashed);
            }
            Ok(None) | Err(_) => truncated = true,
        }
    }
    truncated
}

async fn repository_context(workspace: &Path) -> Result<RepositoryContext, String> {
    if !workspace.is_dir() {
        return Err("Workspace is unavailable.".into());
    }
    let output = run_ok(
        workspace,
        vec![
            OsString::from("rev-parse"),
            OsString::from("--show-toplevel"),
        ],
        16 * 1024,
    )
    .await?;
    let root_text = strict_text(&output.stdout, "Repository path")?.trim();
    let root = PathBuf::from(root_text)
        .canonicalize()
        .map_err(|_| "Git returned an unavailable repository root.".to_string())?;
    let workspace = workspace
        .canonicalize()
        .map_err(|_| "Workspace is unavailable.".to_string())?;
    let relative = workspace
        .strip_prefix(&root)
        .map_err(|_| "Workspace is outside the Git repository root.".to_string())?;
    let prefix = if relative.as_os_str().is_empty() {
        ".".to_string()
    } else {
        path_to_git(relative)?
    };
    Ok(RepositoryContext { root, prefix })
}

async fn resolve_scope(root: &Path, scope: &GitReviewScope) -> Result<ResolvedScope, String> {
    let head = optional_oid(root, "HEAD").await?;
    match scope {
        GitReviewScope::WorkingTree => Ok(ResolvedScope::WorkingTree { head }),
        GitReviewScope::Staged => Ok(ResolvedScope::Staged { head }),
        GitReviewScope::Unstaged => Ok(ResolvedScope::Unstaged { head }),
        GitReviewScope::Branch { base } => {
            if base.trim().is_empty() {
                return Err("Choose a base branch or revision.".into());
            }
            let head_oid = head.ok_or("Branch review requires an existing HEAD commit.")?;
            let base_oid = required_oid(root, base).await?;
            let output = run_ok(
                root,
                vec![
                    OsString::from("merge-base"),
                    OsString::from(&base_oid),
                    OsString::from(&head_oid),
                ],
                16 * 1024,
            )
            .await?;
            let merge_base = strict_text(&output.stdout, "Merge base")?
                .trim()
                .to_string();
            if merge_base.is_empty() {
                return Err("The selected branch has no merge base with HEAD.".into());
            }
            Ok(ResolvedScope::Branch {
                base_oid: merge_base,
                head_oid,
            })
        }
        GitReviewScope::Commit { revision } => {
            if revision.trim().is_empty() {
                return Err("Enter a commit revision.".into());
            }
            let oid = required_oid(root, revision).await?;
            // `git show` uses combined output for merge commits, whose `@@@`
            // anchors have multiple parent coordinates and cannot be represented by
            // the review model's single old/new line pair. Branch scope is the
            // supported ordinary two-way review for merges.
            if optional_oid(root, &format!("{oid}^2")).await?.is_some() {
                return Err(COMBINED_DIFF_ERROR.into());
            }
            Ok(ResolvedScope::Commit { oid })
        }
    }
}

async fn optional_oid(root: &Path, revision: &str) -> Result<Option<String>, String> {
    let expression = format!("{revision}^{{commit}}");
    let output = git::run(
        root,
        &[
            OsString::from("rev-parse"),
            OsString::from("--verify"),
            OsString::from("--end-of-options"),
            OsString::from(expression),
        ],
        GIT_TIMEOUT,
        16 * 1024,
    )
    .await
    .map_err(git_failure)?;
    if !output.status.success() {
        return Ok(None);
    }
    let oid = strict_text(&output.stdout, "Revision")?.trim().to_string();
    Ok((!oid.is_empty()).then_some(oid))
}

async fn required_oid(root: &Path, revision: &str) -> Result<String, String> {
    optional_oid(root, revision)
        .await?
        .ok_or_else(|| format!("Git revision '{revision}' does not resolve to a commit."))
}

async fn worktree_files(
    context: &RepositoryContext,
    scope: &GitReviewScope,
    resolved: &ResolvedScope,
) -> Result<(Vec<GitChangedFile>, Vec<u8>, bool), String> {
    let status_args = vec![
        OsString::from("status"),
        OsString::from("--porcelain=v2"),
        OsString::from("--branch"),
        OsString::from("-z"),
        OsString::from("--untracked-files=all"),
        OsString::from("--"),
        OsString::from(&context.prefix),
    ];
    let status = run_ok(&context.root, status_args, METADATA_CAP).await?;
    let entries = parse_porcelain(&status.stdout)?;
    let (numstats, stat_bytes, stat_truncated) = worktree_numstats(context, resolved).await?;
    let mut files = Vec::new();

    for entry in entries {
        let areas = entry_areas(&entry, scope);
        if areas.is_empty() {
            continue;
        }
        let mut stat = numstats.get(&entry.path).copied().unwrap_or_default();
        if entry.untracked || matches!(resolved, ResolvedScope::WorkingTree { head: None }) {
            stat = untracked_numstat(&context.root, &entry.path).await;
        }
        files.push(GitChangedFile {
            path: entry.path,
            old_path: entry.old_path,
            status: entry.status,
            areas,
            additions: stat.additions,
            deletions: stat.deletions,
            binary: stat.binary(),
        });
    }

    let mut metadata = status.stdout;
    metadata.extend_from_slice(&stat_bytes);
    Ok((files, metadata, status.truncated || stat_truncated))
}

async fn worktree_numstats(
    context: &RepositoryContext,
    resolved: &ResolvedScope,
) -> Result<(BTreeMap<String, Numstat>, Vec<u8>, bool), String> {
    match resolved {
        ResolvedScope::WorkingTree { head: Some(head) } => {
            run_numstat(
                &context.root,
                diff_args("--numstat", Some(head), None, &context.prefix),
            )
            .await
        }
        ResolvedScope::WorkingTree { head: None } => {
            let cached = run_numstat(
                &context.root,
                diff_args("--numstat", None, Some("--cached"), &context.prefix),
            )
            .await?;
            let unstaged = run_numstat(
                &context.root,
                diff_args("--numstat", None, None, &context.prefix),
            )
            .await?;
            let mut merged = cached.0;
            for (path, stat) in unstaged.0 {
                merged
                    .entry(path)
                    .and_modify(|current| *current = current.merge(stat))
                    .or_insert(stat);
            }
            let mut bytes = cached.1;
            bytes.extend_from_slice(&unstaged.1);
            Ok((merged, bytes, cached.2 || unstaged.2))
        }
        ResolvedScope::Staged { .. } => {
            run_numstat(
                &context.root,
                diff_args("--numstat", None, Some("--cached"), &context.prefix),
            )
            .await
        }
        ResolvedScope::Unstaged { .. } => {
            run_numstat(
                &context.root,
                diff_args("--numstat", None, None, &context.prefix),
            )
            .await
        }
        _ => unreachable!("worktree_numstats receives only worktree scopes"),
    }
}

async fn committed_files(
    context: &RepositoryContext,
    compare: &[&String],
    commit: Option<&str>,
) -> Result<(Vec<GitChangedFile>, Vec<u8>, bool), String> {
    let (name_args, stat_args) = if let Some(oid) = commit {
        (
            diff_tree_args("--name-status", oid, &context.prefix),
            diff_tree_args("--numstat", oid, &context.prefix),
        )
    } else {
        (
            committed_diff_args("--name-status", compare, &context.prefix),
            committed_diff_args("--numstat", compare, &context.prefix),
        )
    };
    let names = run_ok(&context.root, name_args, METADATA_CAP).await?;
    let changes = parse_name_status(&names.stdout)?;
    let stats = run_numstat(&context.root, stat_args).await?;
    let mut files = Vec::with_capacity(changes.len());
    for (path, old_path, status) in changes {
        let stat = stats.0.get(&path).copied().unwrap_or_default();
        files.push(GitChangedFile {
            path,
            old_path,
            status,
            areas: vec![GitChangeArea::Committed],
            additions: stat.additions,
            deletions: stat.deletions,
            binary: stat.binary(),
        });
    }
    let mut metadata = names.stdout;
    metadata.extend_from_slice(&stats.1);
    Ok((files, metadata, names.truncated || stats.2))
}

fn entry_areas(entry: &StatusEntry, scope: &GitReviewScope) -> Vec<GitChangeArea> {
    match scope {
        GitReviewScope::WorkingTree => {
            let mut areas = Vec::new();
            if entry.index_changed {
                areas.push(GitChangeArea::Staged);
            }
            if entry.worktree_changed {
                areas.push(GitChangeArea::Unstaged);
            }
            if entry.untracked {
                areas.push(GitChangeArea::Untracked);
            }
            areas
        }
        GitReviewScope::Staged if entry.index_changed => vec![GitChangeArea::Staged],
        GitReviewScope::Unstaged if entry.untracked => vec![GitChangeArea::Untracked],
        GitReviewScope::Unstaged if entry.worktree_changed => vec![GitChangeArea::Unstaged],
        _ => Vec::new(),
    }
}

fn diff_args(
    mode: &str,
    revision: Option<&str>,
    extra: Option<&str>,
    pathspec: &str,
) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("diff"),
        OsString::from(mode),
        OsString::from("-z"),
        OsString::from("--find-renames"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-textconv"),
        OsString::from("--no-color"),
    ];
    if let Some(extra) = extra {
        args.push(OsString::from(extra));
    }
    if let Some(revision) = revision {
        args.push(OsString::from(revision));
    }
    args.push(OsString::from("--"));
    args.push(OsString::from(pathspec));
    args
}

fn committed_diff_args(mode: &str, compare: &[&String], pathspec: &str) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("diff"),
        OsString::from(mode),
        OsString::from("-z"),
        OsString::from("--find-renames"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-textconv"),
        OsString::from("--no-color"),
    ];
    args.extend(compare.iter().map(|part| OsString::from(part.as_str())));
    args.push(OsString::from("--"));
    args.push(OsString::from(pathspec));
    args
}

fn diff_tree_args(mode: &str, oid: &str, pathspec: &str) -> Vec<OsString> {
    vec![
        OsString::from("diff-tree"),
        OsString::from("--root"),
        OsString::from("--no-commit-id"),
        OsString::from(mode),
        OsString::from("-r"),
        OsString::from("-z"),
        OsString::from("--find-renames"),
        OsString::from(oid),
        OsString::from("--"),
        OsString::from(pathspec),
    ]
}

async fn run_numstat(
    root: &Path,
    args: Vec<OsString>,
) -> Result<(BTreeMap<String, Numstat>, Vec<u8>, bool), String> {
    let output = run_ok(root, args, METADATA_CAP).await?;
    let stats = parse_numstat_z(&output.stdout)?;
    Ok((stats, output.stdout, output.truncated))
}

async fn patch_for_file(
    root: &Path,
    scope: &ResolvedScope,
    path: &str,
) -> Result<(Vec<u8>, bool), String> {
    let pathspec = literal_pathspec(path);
    let args = match scope {
        ResolvedScope::WorkingTree { head: Some(head) } => {
            patch_diff_args(Some(head), None, &pathspec)
        }
        ResolvedScope::WorkingTree { head: None } => {
            let cached = run_ok(
                root,
                patch_diff_args(None, Some("--cached"), &pathspec),
                PATCH_CAP,
            )
            .await?;
            let unstaged = run_ok(root, patch_diff_args(None, None, &pathspec), PATCH_CAP).await?;
            let mut patch = cached.stdout;
            patch.extend_from_slice(&unstaged.stdout);
            if patch.len() > PATCH_CAP {
                patch.truncate(PATCH_CAP);
                return Ok((patch, true));
            }
            return Ok((patch, cached.truncated || unstaged.truncated));
        }
        ResolvedScope::Staged { .. } => patch_diff_args(None, Some("--cached"), &pathspec),
        ResolvedScope::Unstaged { .. } => patch_diff_args(None, None, &pathspec),
        ResolvedScope::Branch { base_oid, head_oid } => {
            committed_patch_args(base_oid, head_oid, &pathspec)
        }
        ResolvedScope::Commit { oid } => commit_patch_args(oid, &pathspec),
    };
    let output = run_ok(root, args, PATCH_CAP).await?;
    Ok((output.stdout, output.truncated))
}

fn patch_diff_args(revision: Option<&str>, extra: Option<&str>, pathspec: &str) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("diff"),
        OsString::from("--patch"),
        OsString::from("--find-renames"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-textconv"),
        OsString::from("--no-color"),
        OsString::from("--unified=3"),
    ];
    if let Some(extra) = extra {
        args.push(OsString::from(extra));
    }
    if let Some(revision) = revision {
        args.push(OsString::from(revision));
    }
    args.push(OsString::from("--"));
    args.push(OsString::from(pathspec));
    args
}

fn committed_patch_args(base: &str, head: &str, pathspec: &str) -> Vec<OsString> {
    let mut args = patch_diff_args(None, None, pathspec);
    let insert_at = args.len() - 2;
    args.insert(insert_at, OsString::from(head));
    args.insert(insert_at, OsString::from(base));
    args
}

fn commit_patch_args(oid: &str, pathspec: &str) -> Vec<OsString> {
    vec![
        OsString::from("show"),
        OsString::from("--format="),
        OsString::from("--patch"),
        OsString::from("--find-renames"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-textconv"),
        OsString::from("--no-color"),
        OsString::from("--unified=3"),
        OsString::from(oid),
        OsString::from("--"),
        OsString::from(pathspec),
    ]
}

fn patch_has_binary_marker(patch: &[u8]) -> bool {
    patch.split(|byte| *byte == b'\n').any(|line| {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        line == b"GIT binary patch"
            || (line.starts_with(b"Binary files ") && line.ends_with(b" differ"))
    })
}

fn synthetic_untracked_patch_headers(path: &str) -> String {
    let old_path = quote_patch_header_path("a/", path);
    let new_path = quote_patch_header_path("b/", path);
    format!(
        "diff --git {old_path} {new_path}\nnew file mode 100644\n--- /dev/null\n+++ {new_path}\n"
    )
}

/// Quote path text that could break or impersonate a unified-diff header. This
/// follows Git's double-quoted, backslash-escaped shape while leaving ordinary
/// paths unchanged for readability.
fn quote_patch_header_path(prefix: &str, path: &str) -> String {
    let mut raw = String::with_capacity(prefix.len() + path.len());
    raw.push_str(prefix);
    raw.push_str(path);
    if !raw.chars().any(|ch| {
        ch == '"' || ch == '\\' || ch.is_control() || matches!(ch, '\u{2028}' | '\u{2029}')
    }) {
        return raw;
    }

    let mut quoted = String::with_capacity(raw.len() + 2);
    quoted.push('"');
    for ch in raw.chars() {
        match ch {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            ch if ch.is_control() || matches!(ch, '\u{2028}' | '\u{2029}') => {
                use std::fmt::Write as _;
                let mut encoded = [0_u8; 4];
                for byte in ch.encode_utf8(&mut encoded).as_bytes() {
                    let _ = write!(quoted, "\\{byte:03o}");
                }
            }
            ch => quoted.push(ch),
        }
    }
    quoted.push('"');
    quoted
}

async fn untracked_patch(root: &Path, path: &str) -> Result<Vec<u8>, String> {
    let (full, metadata) = safe_untracked_file(root, path).await?;
    if !metadata.is_file() || metadata.len() > UNTRACKED_TEXT_CAP {
        return Err("Untracked file is binary or too large to render.".into());
    }
    let bytes = tokio::fs::read(&full)
        .await
        .map_err(|_| "Untracked file could not be read.".to_string())?;
    if bytes.contains(&0) {
        return Err("Untracked binary files do not have a text patch.".into());
    }
    let text =
        std::str::from_utf8(&bytes).map_err(|_| "Untracked file is not UTF-8 text.".to_string())?;
    let diff = TextDiff::from_lines("", text);
    let mut unified = diff.unified_diff();
    unified.context_radius(3);
    let body = unified.to_string();
    let mut patch = synthetic_untracked_patch_headers(path);
    patch.push_str(&body);
    Ok(patch.into_bytes())
}

async fn untracked_numstat(root: &Path, path: &str) -> Numstat {
    let Ok((full, metadata)) = safe_untracked_file(root, path).await else {
        // A symlink (including one in an intermediate component) is represented as
        // non-text/binary. Never follow it merely to improve review line counts.
        return Numstat {
            additions: None,
            deletions: None,
        };
    };
    if !metadata.is_file() || metadata.len() > UNTRACKED_TEXT_CAP {
        return Numstat {
            additions: None,
            deletions: None,
        };
    }
    let Ok(bytes) = tokio::fs::read(&full).await else {
        return Numstat::default();
    };
    if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
        return Numstat {
            additions: None,
            deletions: None,
        };
    }
    let text = std::str::from_utf8(&bytes).unwrap_or_default();
    Numstat {
        additions: Some(text.lines().count() as u64),
        deletions: Some(0),
    }
}

/// Resolve an untracked regular file without following a symlink in its relative
/// path. Git can report an untracked symlink just like a file; using `metadata` or
/// `read` directly would then expose the target, including a target outside the
/// repository. Every component is inspected with `symlink_metadata` first, and the
/// final canonical containment check is completed before callers read any bytes.
async fn safe_untracked_file(
    root: &Path,
    path: &str,
) -> Result<(PathBuf, std::fs::Metadata), String> {
    match inspect_untracked_path(root, path).await? {
        InspectedUntrackedPath::File(path, metadata) => Ok((path, metadata)),
        InspectedUntrackedPath::Symlink(_, _) => {
            Err("Untracked symlinks do not have a reviewable text patch.".into())
        }
    }
}

async fn inspect_untracked_path(root: &Path, path: &str) -> Result<InspectedUntrackedPath, String> {
    let canonical_root = tokio::fs::canonicalize(root)
        .await
        .map_err(|_| "Repository root is no longer available.".to_string())?;
    let relative = Path::new(path);
    let components: Vec<_> = relative.components().collect();
    if components.is_empty() {
        return Err("Untracked file path is empty.".into());
    }

    let mut full = canonical_root.clone();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(segment) = component else {
            return Err("Untracked file path is outside the repository.".into());
        };
        full.push(segment);
        let metadata = tokio::fs::symlink_metadata(&full)
            .await
            .map_err(|_| "Untracked file is no longer available.".to_string())?;
        if metadata.file_type().is_symlink() {
            return Ok(InspectedUntrackedPath::Symlink(full, metadata));
        }
        if index + 1 < components.len() && !metadata.is_dir() {
            return Err("Untracked file path is no longer available.".into());
        }
    }

    let canonical = tokio::fs::canonicalize(&full)
        .await
        .map_err(|_| "Untracked file is no longer available.".to_string())?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Untracked file path is outside the repository.".into());
    }
    let metadata = tokio::fs::symlink_metadata(&canonical)
        .await
        .map_err(|_| "Untracked file is no longer available.".to_string())?;
    if metadata.file_type().is_symlink() {
        return Ok(InspectedUntrackedPath::Symlink(canonical, metadata));
    }
    Ok(InspectedUntrackedPath::File(canonical, metadata))
}

async fn run_ok(root: &Path, args: Vec<OsString>, cap: usize) -> Result<git::Output, String> {
    let output = git::run(root, &args, GIT_TIMEOUT, cap)
        .await
        .map_err(git_failure)?;
    if output.status.success() {
        return Ok(output);
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() {
        Err("Git command failed.".into())
    } else {
        Err(detail)
    }
}

fn git_failure(failure: git::Failure) -> String {
    match failure {
        git::Failure::Missing => "Git is not installed or is not on PATH.".into(),
        git::Failure::Timeout => "Git did not respond before the review timeout.".into(),
        git::Failure::Failed => "Git could not inspect this workspace.".into(),
    }
}

fn parse_porcelain(output: &[u8]) -> Result<Vec<StatusEntry>, String> {
    let fields: Vec<&[u8]> = output.split(|byte| *byte == 0).collect();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let field = fields[index];
        index += 1;
        if field.is_empty() || field.starts_with(b"# ") || field.starts_with(b"! ") {
            continue;
        }
        match field.first().copied() {
            Some(b'1') => {
                let path = record_path(field, 9)?;
                entries.push(status_entry(field, path, None, false)?);
            }
            Some(b'2') => {
                let path = record_path(field, 10)?;
                let old = fields
                    .get(index)
                    .ok_or("Rename status is missing its original path.")?;
                index += 1;
                entries.push(status_entry(field, path, Some(strict_path(old)?), false)?);
            }
            Some(b'u') => {
                let path = record_path(field, 11)?;
                entries.push(StatusEntry {
                    path,
                    old_path: None,
                    status: GitChangeStatus::Unmerged,
                    index_changed: true,
                    worktree_changed: true,
                    untracked: false,
                });
            }
            Some(b'?') if field.starts_with(b"? ") => entries.push(StatusEntry {
                path: strict_path(&field[2..])?,
                old_path: None,
                status: GitChangeStatus::Added,
                index_changed: false,
                worktree_changed: false,
                untracked: true,
            }),
            _ => {}
        }
    }
    Ok(entries)
}

fn status_entry(
    record: &[u8],
    path: String,
    old_path: Option<String>,
    untracked: bool,
) -> Result<StatusEntry, String> {
    let index_status = *record
        .get(2)
        .ok_or("Git status record is missing X status.")?;
    let worktree_status = *record
        .get(3)
        .ok_or("Git status record is missing Y status.")?;
    Ok(StatusEntry {
        path,
        old_path,
        status: change_status(index_status, worktree_status),
        index_changed: index_status != b'.',
        worktree_changed: worktree_status != b'.',
        untracked,
    })
}

fn change_status(index: u8, worktree: u8) -> GitChangeStatus {
    if index == b'U' || worktree == b'U' {
        return GitChangeStatus::Unmerged;
    }
    if index == b'R' {
        return GitChangeStatus::Renamed;
    }
    if index == b'C' {
        return GitChangeStatus::Copied;
    }
    let status = if worktree != b'.' { worktree } else { index };
    match status {
        b'A' => GitChangeStatus::Added,
        b'D' => GitChangeStatus::Deleted,
        b'R' => GitChangeStatus::Renamed,
        b'C' => GitChangeStatus::Copied,
        _ => GitChangeStatus::Modified,
    }
}

fn record_path(record: &[u8], fields: usize) -> Result<String, String> {
    let path = record
        .splitn(fields, |byte| *byte == b' ')
        .nth(fields - 1)
        .ok_or("Git status record is missing a path.")?;
    strict_path(path)
}

fn parse_name_status(
    output: &[u8],
) -> Result<Vec<(String, Option<String>, GitChangeStatus)>, String> {
    let fields: Vec<&[u8]> = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect();
    let mut changes = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let code = strict_text(fields[index], "Change status")?;
        index += 1;
        let marker = code.as_bytes().first().copied().unwrap_or(b'M');
        if matches!(marker, b'R' | b'C') {
            let old = strict_path(fields.get(index).ok_or("Rename is missing its old path.")?)?;
            let path = strict_path(fields.get(index + 1).ok_or("Rename is missing its path.")?)?;
            index += 2;
            changes.push((
                path,
                Some(old),
                if marker == b'R' {
                    GitChangeStatus::Renamed
                } else {
                    GitChangeStatus::Copied
                },
            ));
        } else {
            let path = strict_path(fields.get(index).ok_or("Change is missing its path.")?)?;
            index += 1;
            changes.push((path, None, change_status(marker, b'.')));
        }
    }
    Ok(changes)
}

fn parse_numstat_z(output: &[u8]) -> Result<BTreeMap<String, Numstat>, String> {
    let fields: Vec<&[u8]> = output.split(|byte| *byte == 0).collect();
    let mut stats = BTreeMap::new();
    let mut index = 0;
    while index < fields.len() {
        let field = fields[index];
        index += 1;
        if field.is_empty() {
            continue;
        }
        let mut parts = field.splitn(3, |byte| *byte == b'\t');
        let additions = parse_stat_count(parts.next().unwrap_or_default());
        let deletions = parse_stat_count(parts.next().unwrap_or_default());
        let inline_path = parts.next().unwrap_or_default();
        let path = if inline_path.is_empty() {
            let _old = fields
                .get(index)
                .ok_or("Rename numstat is missing its old path.")?;
            let new = fields
                .get(index + 1)
                .ok_or("Rename numstat is missing its new path.")?;
            index += 2;
            strict_path(new)?
        } else {
            strict_path(inline_path)?
        };
        stats.insert(
            path,
            Numstat {
                additions,
                deletions,
            },
        );
    }
    Ok(stats)
}

fn parse_stat_count(value: &[u8]) -> Option<u64> {
    if value == b"-" {
        return None;
    }
    std::str::from_utf8(value)
        .ok()?
        .trim_start_matches('\n')
        .parse()
        .ok()
}

fn parse_unified_patch(patch: &str) -> Result<(Vec<GitDiffHunk>, bool), String> {
    let mut hunks = Vec::new();
    let mut current: Option<GitDiffHunk> = None;
    let mut old_line = 0_u64;
    let mut new_line = 0_u64;
    let mut rendered = 0_usize;
    let mut truncated = false;

    for raw in patch.lines() {
        // Combined merge hunks carry one old range per parent (`@@@ ... @@@`).
        // Treating them as metadata would silently return an empty/misaligned
        // review. Ordinary two-way hunks for files containing conflict-marker text
        // still use `@@` and continue through the normal parser below.
        if raw.starts_with("@@@ ") {
            return Err(COMBINED_DIFF_ERROR.into());
        }
        if raw.starts_with("@@ ") {
            if let Some(hunk) = current.take() {
                hunks.push(hunk);
            }
            let Some((old_start, old_lines, new_start, new_lines)) = parse_hunk_header(raw) else {
                continue;
            };
            old_line = old_start;
            new_line = new_start;
            current = Some(GitDiffHunk {
                header: raw.to_string(),
                old_start,
                old_lines,
                new_start,
                new_lines,
                lines: Vec::new(),
            });
            continue;
        }
        let Some(hunk) = current.as_mut() else {
            continue;
        };
        if rendered >= MAX_DIFF_LINES {
            truncated = true;
            continue;
        }
        let (kind, content, old, new) = if let Some(content) = raw.strip_prefix('+') {
            let line = (GitDiffLineKind::Addition, content, None, Some(new_line));
            new_line = new_line.saturating_add(1);
            line
        } else if let Some(content) = raw.strip_prefix('-') {
            let line = (GitDiffLineKind::Deletion, content, Some(old_line), None);
            old_line = old_line.saturating_add(1);
            line
        } else if let Some(content) = raw.strip_prefix(' ') {
            let line = (
                GitDiffLineKind::Context,
                content,
                Some(old_line),
                Some(new_line),
            );
            old_line = old_line.saturating_add(1);
            new_line = new_line.saturating_add(1);
            line
        } else {
            (GitDiffLineKind::Meta, raw, None, None)
        };
        hunk.lines.push(GitDiffLine {
            kind,
            content: content.to_string(),
            old_line: old,
            new_line: new,
        });
        rendered += 1;
    }
    if let Some(hunk) = current {
        hunks.push(hunk);
    }
    Ok((hunks, truncated))
}

fn parse_hunk_header(header: &str) -> Option<(u64, u64, u64, u64)> {
    let body = header.strip_prefix("@@ -")?;
    let (old, remainder) = body.split_once(" +")?;
    let (new, _) = remainder.split_once(" @@")?;
    let (old_start, old_lines) = parse_range(old)?;
    let (new_start, new_lines) = parse_range(new)?;
    Some((old_start, old_lines, new_start, new_lines))
}

fn parse_range(range: &str) -> Option<(u64, u64)> {
    let (start, lines) = range.split_once(',').unwrap_or((range, "1"));
    Some((start.parse().ok()?, lines.parse().ok()?))
}

fn strict_path(path: &[u8]) -> Result<String, String> {
    strict_text(path, "Git path").map(str::to_string)
}

fn parse_review_branches(output: &[u8]) -> Result<Vec<GitReviewBranch>, String> {
    let fields: Vec<&[u8]> = output.split(|byte| *byte == 0).collect();
    let mut branches = Vec::new();
    for record in fields.chunks(3) {
        if record.len() < 3 {
            break;
        }
        let refname = strict_text(record[0], "Git branch")?.trim_start_matches(&['\r', '\n'][..]);
        let head = strict_text(record[1], "Git branch marker")?.trim();
        let symbolic_target = strict_text(record[2], "Git symbolic branch")?.trim();
        if refname.is_empty() || !symbolic_target.is_empty() {
            continue;
        }
        let (name, kind) = if let Some(name) = refname.strip_prefix("refs/heads/") {
            (name, GitReviewBranchKind::Local)
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            (name, GitReviewBranchKind::Remote)
        } else {
            continue;
        };
        if name.is_empty() || name.ends_with("/HEAD") {
            continue;
        }
        branches.push(GitReviewBranch {
            name: name.to_string(),
            revision: refname.to_string(),
            kind,
            current: head == "*",
        });
    }
    branches.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(branches)
}

fn branch_display_name(revision: &str) -> &str {
    revision
        .strip_prefix("refs/heads/")
        .or_else(|| revision.strip_prefix("refs/remotes/"))
        .unwrap_or(revision)
}

fn strict_text<'a>(bytes: &'a [u8], label: &str) -> Result<&'a str, String> {
    std::str::from_utf8(bytes).map_err(|_| format!("{label} is not valid UTF-8."))
}

fn path_to_git(path: &Path) -> Result<String, String> {
    let text = path
        .to_str()
        .ok_or("Workspace path is not valid UTF-8.")?
        .replace('\\', "/");
    Ok(text)
}

fn literal_pathspec(path: &str) -> String {
    format!(":(top,literal){path}")
}

fn merge_count(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    Some(left?.saturating_add(right?))
}

fn short_oid(oid: &str) -> String {
    oid.chars().take(8).collect()
}

fn digest_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use portcode_sync::wire::{TurnChangeCertainty, TurnStatus};

    #[tokio::test]
    async fn capped_binary_entry_hashes_same_size_content_changes() {
        let root = std::env::temp_dir().join(format!(
            "portcode-turn-fingerprint-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("blob.bin");
        let file = GitChangedFile {
            path: "blob.bin".into(),
            old_path: None,
            status: GitChangeStatus::Modified,
            areas: vec![GitChangeArea::Unstaged],
            additions: None,
            deletions: None,
            binary: true,
        };

        std::fs::write(&path, [0, 1, 2, 3]).unwrap();
        let mut first_total = SNAPSHOT_TOTAL_CAP;
        let mut first_hashed = 0;
        let (first, first_content, first_truncated) = turn_entry_identity(
            &root,
            &file,
            None,
            false,
            &mut first_total,
            &mut first_hashed,
        )
        .await;

        std::fs::write(&path, [0, 1, 9, 3]).unwrap();
        let mut second_total = SNAPSHOT_TOTAL_CAP;
        let mut second_hashed = 0;
        let (second, second_content, second_truncated) = turn_entry_identity(
            &root,
            &file,
            None,
            false,
            &mut second_total,
            &mut second_hashed,
        )
        .await;

        assert!(first_truncated && second_truncated);
        assert!(first_content.is_none() && second_content.is_none());
        assert_eq!((first_hashed, second_hashed), (4, 4));
        assert_ne!(first, second, "same-size binary edits must change identity");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn same_byte_rewrite_does_not_change_turn_entry_identity() {
        let root = std::env::temp_dir().join(format!(
            "portcode-turn-noop-fingerprint-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("dirty.txt");
        let file = GitChangedFile {
            path: "dirty.txt".into(),
            old_path: None,
            status: GitChangeStatus::Modified,
            areas: vec![GitChangeArea::Unstaged],
            additions: Some(1),
            deletions: Some(1),
            binary: false,
        };

        std::fs::write(&path, b"same dirty bytes\n").unwrap();
        let mut first_total = 0;
        let mut first_hashed = 0;
        let (first, _, _) = turn_entry_identity(
            &root,
            &file,
            None,
            false,
            &mut first_total,
            &mut first_hashed,
        )
        .await;

        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, b"same dirty bytes\n").unwrap();
        let mut second_total = 0;
        let mut second_hashed = 0;
        let (second, _, _) = turn_entry_identity(
            &root,
            &file,
            None,
            false,
            &mut second_total,
            &mut second_hashed,
        )
        .await;

        assert_eq!(first, second, "mtime-only rewrites are not Git deltas");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn turn_snapshot_git_process_count_is_constant_for_many_dirty_paths() {
        let root = std::env::temp_dir().join(format!(
            "portcode-turn-command-count-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let git_ok = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .status()
                .expect("Git is required for receipt capture tests");
            assert!(status.success(), "git {args:?} failed");
        };
        git_ok(&["init", "--quiet"]);
        for index in 0..200 {
            std::fs::write(root.join(format!("dirty-{index:03}.txt")), b"before\n").unwrap();
        }
        git_ok(&["add", "--all"]);
        git_ok(&[
            "-c",
            "user.name=Portcode Tests",
            "-c",
            "user.email=tests@portcode.invalid",
            "commit",
            "--quiet",
            "-m",
            "fixture",
        ]);
        let clean_path = root.join("dirty-199.txt");
        let clean = capture_turn_workspace_with_paths(&root, &[clean_path])
            .await
            .unwrap();
        assert!(clean.entries.is_empty());
        let clean_digest = digest_hex(b"before\n");
        assert_eq!(
            clean.exact_paths["dirty-199.txt"].digest.as_deref(),
            Some(clean_digest.as_str())
        );
        for index in 0..200 {
            std::fs::write(root.join(format!("dirty-{index:03}.txt")), b"after\n").unwrap();
        }

        let (snapshot, command_count) =
            crate::git::count_test_commands(capture_turn_workspace(&root)).await;
        let snapshot = snapshot.unwrap();
        assert_eq!(snapshot.entries.len(), 200);
        assert!(
            command_count <= 8,
            "capture launched {command_count} Git children for 200 paths"
        );

        let selected = root.join("dirty-199.txt");
        let (scoped, scoped_commands) =
            crate::git::count_test_commands(capture_turn_paths(&root, &[selected])).await;
        let scoped = scoped.unwrap();
        assert_eq!(scoped.entries.len(), 1);
        assert!(scoped.entries.contains_key("dirty-199.txt"));
        assert!(
            scoped_commands <= 3,
            "scoped capture launched {scoped_commands} Git children"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn same_repository_capture_lock_is_exclusive() {
        let root = PathBuf::from("same-repository-capture-lock");
        let first_lock = turn_capture_lock(&root);
        let second_lock = turn_capture_lock(&root);
        assert!(Arc::ptr_eq(&first_lock, &second_lock));
        let first = first_lock.lock().await;
        let waiter = tokio::spawn(async move { second_lock.lock_owned().await });
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!waiter.is_finished(), "same-repository captures overlapped");
        drop(first);
        let second = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("second capture lock wakes")
            .expect("capture lock task");
        drop(second);
    }

    #[tokio::test]
    async fn streaming_hash_stops_at_its_explicit_budget() {
        let path = std::env::temp_dir().join(format!(
            "portcode-turn-hash-budget-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, [0, 1, 2, 3, 4]).unwrap();

        assert!(hash_file(&path, 4).await.unwrap().is_none());

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn bulk_index_parser_preserves_all_stages_and_unusual_paths() {
        let raw = b"100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tplain.txt\0\
100644 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1\tconflict.txt\0\
100644 cccccccccccccccccccccccccccccccccccccccc 2\tconflict.txt\0\
100644 dddddddddddddddddddddddddddddddddddddddd 0\ttab\tand\nnewline.txt\0";
        let identities = parse_turn_index_identities(raw).unwrap();

        assert_eq!(identities.len(), 3);
        assert!(identities["conflict.txt"]
            .windows(2)
            .any(|window| window == b" 1"));
        assert!(identities["conflict.txt"]
            .windows(2)
            .any(|window| window == b" 2"));
        assert!(identities.contains_key("tab\tand\nnewline.txt"));
    }

    #[test]
    fn bulk_index_parser_rejects_truncated_or_malformed_records() {
        assert!(parse_turn_index_identities(
            b"100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tcut-off.txt"
        )
        .is_err());
        assert!(parse_turn_index_identities(b"record-without-tab\0").is_err());
    }

    #[test]
    fn exact_path_filter_deduplicates_targets_and_rejects_escape() {
        let root = std::env::temp_dir().join(format!(
            "portcode-turn-exact-filter-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        let target = root.join("nested").join("file.txt");
        std::fs::write(&target, b"x").unwrap();

        let selected =
            exact_repository_paths(&root, &root, &[target.clone(), target.clone()]).unwrap();
        assert_eq!(selected.len(), 1);
        assert!(selected.contains("nested/file.txt"));

        let outside = root.with_extension("outside.txt");
        std::fs::write(&outside, b"x").unwrap();
        assert!(exact_repository_paths(&root, &root, std::slice::from_ref(&outside)).is_err());

        std::fs::remove_file(outside).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_porcelain_areas_renames_untracked_and_conflicts() {
        let raw = b"# branch.oid abc\0\
1 M. N... 100644 100644 100644 a a src/staged.rs\0\
1 .M N... 100644 100644 100644 a a src/unstaged.rs\0\
2 RM N... 100644 100644 100644 a a R100 src/new name.rs\0src/old name.rs\0\
u UU N... 100644 100644 100644 100644 a a a src/conflict.rs\0\
? src/new.rs\0";
        let entries = parse_porcelain(raw).unwrap();
        assert_eq!(entries.len(), 5);
        assert!(entries[0].index_changed);
        assert!(!entries[0].worktree_changed);
        assert!(entries[1].worktree_changed);
        assert_eq!(entries[2].status, GitChangeStatus::Renamed);
        assert_eq!(entries[2].old_path.as_deref(), Some("src/old name.rs"));
        assert_eq!(entries[3].status, GitChangeStatus::Unmerged);
        assert!(entries[4].untracked);
    }

    #[test]
    fn filters_worktree_entries_into_typed_areas() {
        let both = StatusEntry {
            path: "src/app.ts".into(),
            old_path: None,
            status: GitChangeStatus::Modified,
            index_changed: true,
            worktree_changed: true,
            untracked: false,
        };
        assert_eq!(
            entry_areas(&both, &GitReviewScope::WorkingTree),
            vec![GitChangeArea::Staged, GitChangeArea::Unstaged]
        );
        assert_eq!(
            entry_areas(&both, &GitReviewScope::Staged),
            vec![GitChangeArea::Staged]
        );
    }

    #[test]
    fn parses_numstat_renames_and_binary_markers() {
        let raw = b"12\t4\tsrc/app.ts\0-\t-\tasset.png\x000\t0\t\0old.rs\0new.rs\0";
        let stats = parse_numstat_z(raw).unwrap();
        assert_eq!(stats["src/app.ts"].additions, Some(12));
        assert!(stats["asset.png"].binary());
        assert_eq!(
            stats["new.rs"],
            Numstat {
                additions: Some(0),
                deletions: Some(0)
            }
        );
    }

    #[test]
    fn parses_name_status_with_rename_source() {
        let changes = parse_name_status(b"M\0src/app.ts\0R100\0old.rs\0new.rs\0").unwrap();
        assert_eq!(changes[0].2, GitChangeStatus::Modified);
        assert_eq!(changes[1].0, "new.rs");
        assert_eq!(changes[1].1.as_deref(), Some("old.rs"));
        assert_eq!(changes[1].2, GitChangeStatus::Renamed);
    }

    #[test]
    fn parses_hunks_into_old_and_new_line_anchors() {
        let patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -4,3 +4,4 @@ fn x() {\n same\n-old\n+new\n+extra\n tail\n\\ No newline at end of file\n";
        let (hunks, truncated) = parse_unified_patch(patch).unwrap();
        assert!(!truncated);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].old_start, 4);
        assert_eq!(hunks[0].new_lines, 4);
        assert_eq!(hunks[0].lines[1].old_line, Some(5));
        assert_eq!(hunks[0].lines[1].new_line, None);
        assert_eq!(hunks[0].lines[2].new_line, Some(5));
        assert_eq!(hunks[0].lines[4].old_line, Some(6));
        assert_eq!(hunks[0].lines[5].kind, GitDiffLineKind::Meta);
    }

    #[test]
    fn binary_markers_must_occupy_a_complete_patch_line() {
        assert!(patch_has_binary_marker(
            b"diff --git a/image b/image\nGIT binary patch\nliteral 1\n"
        ));
        assert!(patch_has_binary_marker(
            b"diff --git a/image b/image\r\nBinary files a/image and b/image differ\r\n"
        ));
        assert!(!patch_has_binary_marker(
            b"@@ -1 +1,2 @@\n+GIT binary patch\n+Binary files a/image and b/image differ\n"
        ));
        assert!(!patch_has_binary_marker(
            b"ordinary text mentioning GIT binary patch in a sentence\n"
        ));
    }

    #[test]
    fn synthetic_patch_headers_escape_filename_line_injection() {
        let path = "safe\n+++ b/injected\n@@ -1 +1 @@\r\n\"quote\\tail.rs";
        let headers = synthetic_untracked_patch_headers(path);

        assert_eq!(headers.lines().count(), 4);
        assert!(!headers.contains("\n@@"));
        assert!(!headers.contains("\n+++ b/injected"));
        assert!(headers.contains("\\n"));
        assert!(headers.contains("\\r"));
        assert!(headers.contains("\\\"quote\\\\tail.rs"));
    }

    #[test]
    fn rejects_combined_merge_hunks_instead_of_silently_ignoring_them() {
        let patch = "diff --cc src/app.rs\nindex aaa,bbb..ccc\n--- a/src/app.rs\n+++ b/src/app.rs\n@@@ -1,1 -1,1 +1,1 @@@\n--parent one\n -parent two\n++merged\n";
        assert_eq!(parse_unified_patch(patch).unwrap_err(), COMBINED_DIFF_ERROR);
    }

    #[test]
    fn ordinary_two_way_hunks_can_contain_conflict_marker_text() {
        let patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,5 @@\n+<<<<<<< HEAD\n ours\n+=======\n+theirs\n+>>>>>>> branch\n";
        let (hunks, truncated) = parse_unified_patch(patch).unwrap();
        assert!(!truncated);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].header, "@@ -1,1 +1,5 @@");
        assert_eq!(hunks[0].lines[0].kind, GitDiffLineKind::Addition);
        assert_eq!(hunks[0].lines[0].content, "<<<<<<< HEAD");
        assert_eq!(hunks[0].lines[1].kind, GitDiffLineKind::Context);
        assert_eq!(hunks[0].lines[4].content, ">>>>>>> branch");
    }

    #[test]
    fn final_snapshot_guard_rejects_a_changed_manifest() {
        assert!(ensure_snapshot_current("snapshot-a", "snapshot-a").is_ok());
        assert_eq!(
            ensure_snapshot_current("snapshot-a", "snapshot-b").unwrap_err(),
            STALE_REVIEW_ERROR
        );
    }

    #[test]
    fn snapshot_hash_is_deterministic_and_sensitive_to_content() {
        assert_eq!(digest_hex(b"same"), digest_hex(b"same"));
        assert_ne!(digest_hex(b"same"), digest_hex(b"changed"));
    }

    #[test]
    fn resolved_scope_identity_tracks_branch_and_commit_oids() {
        fn identity(scope: ResolvedScope) -> String {
            let mut material = Vec::new();
            scope.append_snapshot_identity(&mut material);
            digest_hex(&material)
        }

        let branch = identity(ResolvedScope::Branch {
            base_oid: "base-a".into(),
            head_oid: "head-a".into(),
        });
        assert_ne!(
            branch,
            identity(ResolvedScope::Branch {
                base_oid: "base-b".into(),
                head_oid: "head-a".into(),
            })
        );
        assert_ne!(
            branch,
            identity(ResolvedScope::Branch {
                base_oid: "base-a".into(),
                head_oid: "head-b".into(),
            })
        );
        assert_ne!(
            identity(ResolvedScope::Commit {
                oid: "oid-a".into()
            }),
            identity(ResolvedScope::Commit {
                oid: "oid-b".into()
            })
        );
    }

    #[test]
    fn parses_workspace_branches_and_omits_symbolic_remote_heads() {
        let raw = b"refs/heads/main\0*\0\0\nrefs/heads/release\0 \0\0\nrefs/remotes/origin/HEAD\0 \0refs/remotes/origin/main\0\nrefs/remotes/origin/main\0 \0\0\n";
        let branches = parse_review_branches(raw).unwrap();
        assert_eq!(
            branches,
            vec![
                GitReviewBranch {
                    name: "main".into(),
                    revision: "refs/heads/main".into(),
                    kind: GitReviewBranchKind::Local,
                    current: true,
                },
                GitReviewBranch {
                    name: "release".into(),
                    revision: "refs/heads/release".into(),
                    kind: GitReviewBranchKind::Local,
                    current: false,
                },
                GitReviewBranch {
                    name: "origin/main".into(),
                    revision: "refs/remotes/origin/main".into(),
                    kind: GitReviewBranchKind::Remote,
                    current: false,
                },
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn untracked_symlinks_never_read_targets_outside_the_repository() {
        use std::os::unix::fs::symlink;

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sandbox = std::env::temp_dir().join(format!(
            "portcode-git-review-symlink-{}-{nonce}",
            std::process::id()
        ));
        let root = sandbox.join("repo");
        let outside = sandbox.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "must not be read\n").unwrap();

        symlink(outside.join("secret.txt"), root.join("leak.txt")).unwrap();
        let direct_error = untracked_patch(&root, "leak.txt").await.unwrap_err();
        assert!(direct_error.contains("symlink"));
        assert!(untracked_numstat(&root, "leak.txt").await.binary());

        symlink(&outside, root.join("linked-outside")).unwrap();
        let nested_error = untracked_patch(&root, "linked-outside/secret.txt")
            .await
            .unwrap_err();
        assert!(nested_error.contains("symlink"));
        assert!(untracked_numstat(&root, "linked-outside/secret.txt")
            .await
            .binary());

        let files = [GitChangedFile {
            path: "linked-outside/secret.txt".into(),
            old_path: None,
            status: GitChangeStatus::Added,
            areas: vec![GitChangeArea::Untracked],
            additions: None,
            deletions: None,
            binary: true,
        }];
        let mut fingerprint = Vec::new();
        assert!(!append_worktree_fingerprints(&root, &files, &mut fingerprint).await);
        let secret_digest = Sha256::digest(b"must not be read\n");
        assert!(!fingerprint
            .windows(secret_digest.len())
            .any(|window| window == secret_digest.as_slice()));

        std::fs::remove_dir_all(&sandbox).unwrap();
    }

    #[test]
    fn review_scope_serializes_with_the_frontend_tag_shape() {
        let scope = GitReviewScope::Branch {
            base: "origin/main".into(),
        };
        assert_eq!(
            serde_json::to_value(scope).unwrap(),
            serde_json::json!({ "kind": "branch", "base": "origin/main" })
        );
    }

    #[test]
    fn historical_review_rejects_pending_receipt_until_terminal_save() {
        let db = crate::db::Db::open(Path::new(":memory:")).unwrap();
        db.create_session("s", "S", None, None, 1).unwrap();
        let receipt = TurnReceipt {
            turn_id: "pending-review".into(),
            account_profile_id: None,
            status: TurnStatus::Interrupted,
            stop_reason: None,
            started_at: 1,
            completed_at: 1,
            duration_ms: None,
            agent_duration_ms: None,
            changed_files: Vec::new(),
            changed_file_count: 0,
            additions: 0,
            deletions: 0,
            files_truncated: false,
            change_state: None,
            change_certainty: TurnChangeCertainty::Unavailable,
            background_tasks_running: false,
        };
        db.save_pending_turn_receipt("s", "pending-review", &receipt)
            .unwrap();
        assert!(turn_review_manifest(&db, "pending-review".into()).is_err());

        db.save_turn_receipt("s", "pending-review", &receipt, None, None)
            .unwrap();
        assert!(turn_review_manifest(&db, "pending-review".into()).is_ok());
    }
}
