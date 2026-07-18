#![cfg(desktop)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::TextDiff;
use tauri::State;

use crate::{git, AppState};

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const METADATA_CAP: usize = 4 * 1024 * 1024;
const PATCH_CAP: usize = 2 * 1024 * 1024;
const UNTRACKED_TEXT_CAP: u64 = 512 * 1024;
const SNAPSHOT_FILE_CAP: u64 = 8 * 1024 * 1024;
const SNAPSHOT_TOTAL_CAP: u64 = 32 * 1024 * 1024;
const MAX_DIFF_LINES: usize = 4_000;
const STALE_REVIEW_ERROR: &str =
    "The working tree changed. Refresh the review before opening this file.";
const COMBINED_DIFF_ERROR: &str =
    "Combined merge diffs are not supported. Review the merge as a branch diff instead.";

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
                format!("merge-base({base}) · {}", short_oid(base_oid)),
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
    let resolved = resolve_scope(&context.root, &scope).await?;
    let head_oid = optional_oid(&context.root, "HEAD").await?;
    let (mut files, mut metadata, mut metadata_truncated) = match &resolved {
        ResolvedScope::WorkingTree { .. }
        | ResolvedScope::Staged { .. }
        | ResolvedScope::Unstaged { .. } => worktree_files(&context, &scope, &resolved).await?,
        ResolvedScope::Branch { base_oid, head_oid } => {
            committed_files(&context, &[base_oid, head_oid], None).await?
        }
        ResolvedScope::Commit { oid } => committed_files(&context, &[], Some(oid.as_str())).await?,
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

async fn append_worktree_fingerprints(
    root: &Path,
    files: &[GitChangedFile],
    material: &mut Vec<u8>,
) -> bool {
    let mut total = 0_u64;
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
        if !metadata.is_file()
            || metadata.len() > SNAPSHOT_FILE_CAP
            || total.saturating_add(metadata.len()) > SNAPSHOT_TOTAL_CAP
        {
            truncated = true;
            continue;
        }
        match tokio::fs::read(&full).await {
            Ok(bytes) => {
                material.extend_from_slice(&Sha256::digest(&bytes));
                total = total.saturating_add(metadata.len());
            }
            Err(_) => truncated = true,
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
}
