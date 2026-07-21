//! Tool system. Each tool declares a JSON schema (sent to the model) and an
//! async `run`. Every tool declares its permission risk explicitly: read-only
//! tools run immediately, while configurable and protected mutations route
//! through the permission gate before executing.

use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use similar::TextDiff;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::tool_names;
use crate::turn_receipt::{ExactWriteOutcome, MutationScope, MutationToken};
use portcode_sync::wire::PermissionRisk;

/// Permission-time evidence carried unchanged to the apply boundary. Most tools
/// only need a display diff; first-class file tools also attach a hashed file
/// precondition so the bytes being changed are the bytes the user approved.
#[derive(Debug, Default)]
pub struct ToolApproval {
    pub diff: Option<String>,
    file_precondition: Option<FilePrecondition>,
}

#[derive(Debug)]
enum FilePrecondition {
    Snapshot {
        path: PathBuf,
        state: FileStateDigest,
    },
    /// The preview could not establish a trustworthy preimage. An approved call
    /// reports this error without attempting a write.
    Unverifiable(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FileStateDigest {
    Missing,
    Present([u8; 32]),
}

#[derive(Debug)]
enum FilePreimage {
    Missing,
    Present(Vec<u8>),
}

pub struct ToolCtx {
    pub workspace: PathBuf,
    /// Cancellation flag for the actor running this tool. Mutators recheck it at
    /// their actual side-effect boundary, after any potentially slow preimage
    /// read or command construction.
    pub cancel: Option<Arc<AtomicBool>>,
    /// Root-turn provenance shared by the top-level agent and every subagent.
    /// Read-only/legacy contexts leave it absent.
    pub receipt: Option<Arc<crate::turn_receipt::TurnReceiptTracker>>,
    /// Launches subagents for the [`Task`] tool. `None` when this run can't spawn
    /// (plan mode, or a subagent already at the nesting cap) — in which case
    /// `delegate_task` isn't in the registry at all, so this is the runtime backstop rather than
    /// the primary guard. Implemented by the agent runtime so tools never depend on
    /// the agent loop internals; they only know this trait.
    pub spawner: Option<Arc<dyn Spawner>>,
    /// Adopts a `run_command` call launched with `background: true`. `None` when
    /// this run can't background — the tool then
    /// reports that background mode is unavailable rather than blocking.
    pub background: Option<Arc<dyn BackgroundRunner>>,
}

impl ToolCtx {
    /// A context with no spawner / background runner — read-only runs and the
    /// default in tests. The interactive run attaches them via field assignment.
    pub fn new(workspace: PathBuf) -> Self {
        Self {
            workspace,
            cancel: None,
            receipt: None,
            spawner: None,
            background: None,
        }
    }
}

fn ensure_mutation_not_cancelled(ctx: &ToolCtx) -> Result<(), String> {
    if ctx
        .cancel
        .as_ref()
        .is_some_and(|cancel| cancel.load(Ordering::Relaxed))
    {
        Err("Cancelled before the tool reached its mutation boundary.".into())
    } else {
        Ok(())
    }
}

async fn wait_for_mutation_cancellation(cancel: Option<Arc<AtomicBool>>) {
    let Some(cancel) = cancel else {
        std::future::pending::<()>().await;
        return;
    };
    loop {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// What `run_command` needs to launch a long-running command in the background,
/// without knowing how a run is wired. Implemented by `agent::BackgroundLauncher`,
/// which owns the process lifecycle: it waits for the child off-thread, reports
/// start/finish via stream events, and lets a session Stop kill it. The tool
/// builds and spawns the child; the runner ADOPTS it.
pub trait BackgroundRunner: Send + Sync {
    /// Adopt an already-spawned background process, returning a short task id. The
    /// runner waits for the child elsewhere and announces completion itself. The
    /// opaque mutation token was opened before spawn and stays alive in that waiter,
    /// so a detached process remains part of the root turn's mutation interval.
    fn launch(
        &self,
        command: String,
        child: tokio::process::Child,
        mutation: Option<MutationToken>,
    ) -> String;
}

/// What the [`Task`] tool needs to launch a subagent, without knowing how a run
/// is actually wired. Implemented by `agent::AgentSpawner` and attached to
/// [`ToolCtx`], so the tool layer stays decoupled from the agent loop.
#[async_trait]
pub trait Spawner: Send + Sync {
    /// Run a subagent to completion and return its final text answer — the
    /// summary the launching agent receives as the tool result. An `Err` is
    /// surfaced to the launching model as a tool error.
    async fn spawn(&self, spec: SubagentSpec) -> Result<String, String>;
}

/// A subagent launch request: a short human label (for telemetry / a future
/// agents panel) and the full, self-contained task prompt the subagent runs.
#[derive(Clone, Debug)]
pub struct SubagentSpec {
    pub description: String,
    pub prompt: String,
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn input_schema(&self) -> Value;

    /// Required classification for the authorization boundary. `None` is an
    /// explicitly reviewed read-only/delegation tool; every other value reaches
    /// the Rust permission gate. There is deliberately no default so a newly
    /// registered tool cannot become ungated by omission.
    fn permission_risk(&self) -> Option<PermissionRisk>;

    /// Mutating tools (write / edit / command) go through the permission gate.
    fn mutating(&self) -> bool {
        false
    }
    /// Receipt barrier required after permission is granted but before this tool
    /// can run. Exact tools share the barrier without Git I/O; opaque tools make
    /// the first caller establish the lazy workspace baseline.
    fn mutation_scope(&self) -> Option<MutationScope> {
        self.mutating().then_some(MutationScope::Exact)
    }

    /// Short human-readable summary of a call, for the permission prompt. Takes
    /// `ctx` so a tool can resolve a path to its real destination (so an "ask"
    /// prompt can't be deceived by a benign-looking relative or symlinked path).
    fn summarize(&self, input: &Value, _ctx: &ToolCtx) -> String {
        for key in ["path", "command", "pattern"] {
            if let Some(s) = input.get(key).and_then(|v| v.as_str()) {
                return s.to_string();
            }
        }
        self.name().to_string()
    }

    /// A pre-apply preview of the change as a unified diff, shown in the
    /// permission prompt BEFORE the tool runs. `None` (the default) means there
    /// is nothing to preview — read-only tools, or a mutating tool whose change
    /// can't be diffed (e.g. `run_command`). A file tool computes the proposed new
    /// content WITHOUT writing it, so the diff shown is exactly what `run` would
    /// apply (they share the same logic — see `compute_edit`).
    async fn preview(&self, _input: &Value, _ctx: &ToolCtx) -> Option<String> {
        None
    }

    /// Build the complete permission artifact in one read. File tools override
    /// this to bind their displayed diff to a concrete preimage; other tools keep
    /// the legacy preview-only behavior.
    async fn approval(&self, input: &Value, ctx: &ToolCtx) -> ToolApproval {
        ToolApproval {
            diff: self.preview(input, ctx).await,
            file_precondition: None,
        }
    }

    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String>;

    /// Apply a permission-approved call. The default is unchanged; file tools
    /// override this to revalidate their permission-time preimage immediately
    /// before opening the mutation interval.
    async fn run_approved(
        &self,
        input: Value,
        ctx: &ToolCtx,
        _approval: ToolApproval,
    ) -> Result<String, String> {
        self.run(input, ctx).await
    }
}

pub struct Registry {
    tools: Vec<Box<dyn Tool>>,
}

impl Registry {
    /// Build a registry from an explicit tool set. [`default_registry`] is the
    /// standard interactive set; a subagent or plan mode builds its own
    /// (restricted or specialized) tool list through this same constructor, so
    /// the agent loop stays registry-agnostic.
    pub fn new(tools: Vec<Box<dyn Tool>>) -> Self {
        Registry { tools }
    }

    pub fn specs(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|t| {
                json!({
                    "name": tool_names::canonical(t.name()),
                    "description": t.description(),
                    "input_schema": t.input_schema(),
                })
            })
            .collect()
    }

    pub fn find(&self, name: &str) -> Option<&dyn Tool> {
        let canonical = tool_names::canonical(name);
        self.tools
            .iter()
            .find(|t| tool_names::canonical(t.name()) == canonical)
            .map(|b| b.as_ref())
    }
}

pub fn default_registry() -> Registry {
    Registry::new(vec![
        Box::new(FsRead),
        Box::new(ListDir),
        Box::new(GlobTool),
        Box::new(GrepTool),
        Box::new(FsWrite),
        Box::new(FsEdit),
        Box::new(Shell),
        Box::new(Task),
    ])
}

/// The tool set handed to a subagent: the full interactive set, plus `delegate_task`
/// tool only when the subagent may still spawn its own children (`can_spawn`).
/// At the maximum nesting depth `can_spawn` is false, so a leaf subagent is never
/// even offered `delegate_task` — the depth cap is enforced by omission here, with the
/// spawner refusing as a backstop.
pub fn subagent_registry(can_spawn: bool) -> Registry {
    let mut tools: Vec<Box<dyn Tool>> = vec![
        Box::new(FsRead),
        Box::new(ListDir),
        Box::new(GlobTool),
        Box::new(GrepTool),
        Box::new(FsWrite),
        Box::new(FsEdit),
        Box::new(Shell),
    ];
    if can_spawn {
        tools.push(Box::new(Task));
    }
    Registry::new(tools)
}

/// The read-only subset of the default registry — no write/edit/command tools.
/// Plan mode hands the agent this set so it can inspect the workspace but never
/// mutate it (defense-in-depth with the permission gate, which also denies every
/// mutating tool in plan mode).
pub fn read_only_registry() -> Registry {
    Registry::new(vec![
        Box::new(FsRead),
        Box::new(ListDir),
        Box::new(GlobTool),
        Box::new(GrepTool),
    ])
}

// ── path helpers ─────────────────────────────────────────────────────────────

fn base_dir(ctx: &ToolCtx) -> Result<PathBuf, String> {
    ctx.workspace
        .canonicalize()
        .map_err(|e| format!("workspace unavailable: {e}"))
}

/// Resolve a path that must already exist, sandboxed to the workspace.
fn resolve_existing(base: &Path, p: &str) -> Result<PathBuf, String> {
    let path = Path::new(p);
    let full = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let canon = full
        .canonicalize()
        .map_err(|e| format!("cannot access '{p}': {e}"))?;
    if !canon.starts_with(base) {
        return Err(format!("path '{p}' is outside the workspace"));
    }
    Ok(canon)
}

/// Resolve a path for writing, sandboxed to the workspace, allowing the final
/// component(s) not to exist yet.
///
/// A purely lexical check (`..`-popping + `starts_with`) is not enough: a symlink
/// or NTFS junction *inside* the workspace can redirect an otherwise-contained
/// path to an arbitrary location outside it (persistence / RCE). So we resolve the
/// real destination through the filesystem and re-assert containment:
///
///  1. Lexically normalize `.`/`..` to get the intended absolute target `out`,
///     and reject an obvious lexical escape early.
///  2. Walk up `out` to the deepest ancestor that actually exists and
///     `canonicalize()` it — this follows every reparse point on the existing
///     prefix to its real location.
///  3. Re-join the remaining (not-yet-existing) tail onto that real ancestor.
///  4. Require the result to stay under the canonical base.
///
/// Because the canonical base contains no reparse points, any junction/symlink in
/// the existing prefix that pointed outside the workspace makes the canonicalized
/// ancestor fall outside `base`, so the final `starts_with` rejects it.
fn resolve_for_write(base: &Path, p: &str) -> Result<PathBuf, String> {
    let path = Path::new(p);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let mut out = PathBuf::new();
    for comp in joined.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c.as_os_str()),
        }
    }
    if !out.starts_with(base) {
        return Err(format!("path '{p}' is outside the workspace"));
    }

    // Find the deepest existing ancestor of `out`, canonicalize it (resolving any
    // reparse points), and re-attach the not-yet-existing tail.
    let mut existing = out.as_path();
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let real_ancestor = loop {
        match existing.canonicalize() {
            Ok(real) => break real,
            Err(_) => {
                // This component doesn't exist yet (or can't be resolved); strip it
                // and try its parent. The lexical `out` is already base-contained, so
                // we always reach `base` (which canonicalizes) before running out.
                let Some(name) = existing.file_name() else {
                    // No more components to strip and nothing canonicalized — treat as
                    // outside, rather than silently allowing an unresolved path.
                    return Err(format!("path '{p}' is outside the workspace"));
                };
                tail.push(name);
                let Some(parent) = existing.parent() else {
                    return Err(format!("path '{p}' is outside the workspace"));
                };
                existing = parent;
            }
        }
    };

    let mut real = real_ancestor;
    for name in tail.iter().rev() {
        real.push(name);
    }
    if !real.starts_with(base) {
        return Err(format!("path '{p}' is outside the workspace"));
    }
    Ok(real)
}

fn str_arg<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("missing required argument: '{key}'"))
}

fn truncate_chars(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        return s;
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}\n\n[output truncated at {max} characters]")
}

/// A compact unified diff (3 lines of context) between two file versions.
fn unified_diff(old: &str, new: &str) -> String {
    let diff = TextDiff::from_lines(old, new);
    let mut ud = diff.unified_diff();
    ud.context_radius(3);
    ud.to_string()
}

fn exact_write_outcome(
    existed: bool,
    old_bytes: Option<&[u8]>,
    new_bytes: &[u8],
) -> ExactWriteOutcome {
    if !existed {
        ExactWriteOutcome::Changed
    } else {
        match old_bytes {
            Some(old) if old == new_bytes => ExactWriteOutcome::Unchanged,
            Some(_) => ExactWriteOutcome::Changed,
            None => ExactWriteOutcome::Unknown,
        }
    }
}

fn preimage_digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

async fn read_file_preimage(path: &Path) -> Result<FilePreimage, String> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(FilePreimage::Present(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(FilePreimage::Missing),
        Err(error) => Err(format!("failed to read '{}': {error}", path.display())),
    }
}

fn snapshot_precondition(path: PathBuf, preimage: &FilePreimage) -> FilePrecondition {
    let state = match preimage {
        FilePreimage::Missing => FileStateDigest::Missing,
        FilePreimage::Present(bytes) => FileStateDigest::Present(preimage_digest(bytes)),
    };
    FilePrecondition::Snapshot { path, state }
}

fn validate_file_precondition(
    expected: Option<&FilePrecondition>,
    path: &Path,
    current: &FilePreimage,
) -> Result<(), String> {
    let Some(expected) = expected else {
        // Direct/internal tool calls that did not pass through the permission gate
        // retain their existing behavior.
        return Ok(());
    };
    let (expected_path, expected_state) = match expected {
        FilePrecondition::Snapshot { path, state } => (path, state),
        FilePrecondition::Unverifiable(reason) => {
            return Err(format!(
                "Cannot safely apply the approved change: {reason} Review and retry."
            ));
        }
    };
    let current_state = match current {
        FilePreimage::Missing => FileStateDigest::Missing,
        FilePreimage::Present(bytes) => FileStateDigest::Present(preimage_digest(bytes)),
    };
    if expected_path != path || *expected_state != current_state {
        return Err(format!(
            "'{}' changed after permission was granted. Review the new diff and retry; no write was attempted.",
            path.display()
        ));
    }
    Ok(())
}

fn unverifiable_approval(error: String) -> ToolApproval {
    ToolApproval {
        diff: None,
        file_precondition: Some(FilePrecondition::Unverifiable(error)),
    }
}

/// Apply an `fs_edit` replacement to `content`, returning the updated text and
/// the number of replacements. Shared by `FsEdit::run` and `FsEdit::preview` so
/// the diff shown in the permission prompt can NEVER diverge from what gets
/// written. Errors (string not found, ambiguous without `replace_all`) carry the
/// path `p` for a clear message.
fn compute_edit(
    content: &str,
    old: &str,
    new: &str,
    replace_all: bool,
    p: &str,
) -> Result<(String, usize), String> {
    if old.is_empty() {
        return Err(format!("'old_string' must not be empty when editing {p}"));
    }
    let count = content.matches(old).count();
    if count == 0 {
        return Err(format!("'old_string' not found in {p}"));
    }
    if count > 1 && !replace_all {
        return Err(format!(
            "'old_string' appears {count} times in {p}; pass replace_all=true or provide more context"
        ));
    }
    let updated = if replace_all {
        content.replace(old, new)
    } else {
        content.replacen(old, new, 1)
    };
    Ok((updated, count))
}

// ── read-only tools ──────────────────────────────────────────────────────────

struct FsRead;

#[async_trait]
impl Tool for FsRead {
    fn name(&self) -> &'static str {
        tool_names::READ_FILE
    }
    fn description(&self) -> &'static str {
        "Read a UTF-8 text file from the workspace and return its contents."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path relative to the workspace root." }
            },
            "required": ["path"]
        })
    }
    fn permission_risk(&self) -> Option<PermissionRisk> {
        None
    }
    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String> {
        let base = base_dir(ctx)?;
        let p = str_arg(&input, "path")?;
        let full = resolve_existing(&base, p)?;
        let data = tokio::fs::read_to_string(&full)
            .await
            .map_err(|e| format!("failed to read '{p}': {e}"))?;
        Ok(truncate_chars(data, 200_000))
    }
}

struct ListDir;

#[async_trait]
impl Tool for ListDir {
    fn name(&self) -> &'static str {
        tool_names::LIST_DIRECTORY
    }
    fn description(&self) -> &'static str {
        "List files and directories at a path in the workspace (defaults to root)."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Directory path relative to the workspace root. Defaults to '.'." }
            }
        })
    }
    fn permission_risk(&self) -> Option<PermissionRisk> {
        None
    }
    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String> {
        let base = base_dir(ctx)?;
        let p = input.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let full = resolve_existing(&base, p)?;
        let mut rd = tokio::fs::read_dir(&full)
            .await
            .map_err(|e| format!("failed to list '{p}': {e}"))?;
        let mut entries: Vec<String> = Vec::new();
        while let Some(entry) = rd
            .next_entry()
            .await
            .map_err(|e| format!("failed to list '{p}': {e}"))?
        {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
            entries.push(if is_dir { format!("{name}/") } else { name });
        }
        entries.sort();
        if entries.is_empty() {
            Ok("(empty directory)".into())
        } else {
            Ok(entries.join("\n"))
        }
    }
}

struct GlobTool;

#[async_trait]
impl Tool for GlobTool {
    fn name(&self) -> &'static str {
        tool_names::FIND_FILES
    }
    fn description(&self) -> &'static str {
        "Find files by glob pattern (e.g. '**/*.rs', 'src/**/*.ts'). Returns matching paths, gitignore-aware."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Glob pattern, relative to the workspace root." }
            },
            "required": ["pattern"]
        })
    }
    fn permission_risk(&self) -> Option<PermissionRisk> {
        None
    }
    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String> {
        let base = base_dir(ctx)?;
        let pattern = str_arg(&input, "pattern")?.to_string();
        tokio::task::spawn_blocking(move || {
            let matcher = globset::Glob::new(&pattern)
                .map_err(|e| format!("bad glob '{pattern}': {e}"))?
                .compile_matcher();
            let mut hits: Vec<String> = Vec::new();
            for result in ignore::WalkBuilder::new(&base).build() {
                let Ok(entry) = result else { continue };
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                if let Ok(rel) = entry.path().strip_prefix(&base) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    if matcher.is_match(&rel_str) {
                        hits.push(rel_str);
                        if hits.len() >= 500 {
                            break;
                        }
                    }
                }
            }
            hits.sort();
            if hits.is_empty() {
                Ok("(no matches)".into())
            } else {
                Ok(hits.join("\n"))
            }
        })
        .await
        .map_err(|e| format!("file search failed: {e}"))?
    }
}

struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &'static str {
        tool_names::SEARCH_TEXT
    }
    fn description(&self) -> &'static str {
        "Search file contents with a regular expression. Returns 'path:line: text' matches, gitignore-aware."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Regular expression to search for." },
                "path": { "type": "string", "description": "Optional subdirectory to limit the search to." }
            },
            "required": ["pattern"]
        })
    }
    fn permission_risk(&self) -> Option<PermissionRisk> {
        None
    }
    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String> {
        let base = base_dir(ctx)?;
        let pattern = str_arg(&input, "pattern")?.to_string();
        let sub = input.get("path").and_then(|v| v.as_str()).map(String::from);
        let root = match sub {
            Some(p) => resolve_existing(&base, &p)?,
            None => base.clone(),
        };
        tokio::task::spawn_blocking(move || {
            let re = regex::Regex::new(&pattern).map_err(|e| format!("bad regex: {e}"))?;
            let mut out: Vec<String> = Vec::new();
            'walk: for result in ignore::WalkBuilder::new(&root).build() {
                let Ok(entry) = result else { continue };
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let path = entry.path();
                let Ok(meta) = path.metadata() else { continue };
                if meta.len() > 2_000_000 {
                    continue;
                }
                let Ok(content) = std::fs::read_to_string(path) else {
                    continue; // skip binary / non-utf8
                };
                let rel = path
                    .strip_prefix(&base)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .replace('\\', "/");
                for (i, line) in content.lines().enumerate() {
                    if re.is_match(line) {
                        let trimmed: String = line.chars().take(240).collect();
                        out.push(format!("{rel}:{}: {}", i + 1, trimmed));
                        if out.len() >= 200 {
                            out.push("[truncated at 200 matches]".into());
                            break 'walk;
                        }
                    }
                }
            }
            if out.is_empty() {
                Ok("(no matches)".into())
            } else {
                Ok(out.join("\n"))
            }
        })
        .await
        .map_err(|e| format!("text search failed: {e}"))?
    }
}

// ── mutating tools ───────────────────────────────────────────────────────────

struct FsWrite;

impl FsWrite {
    async fn build_approval(&self, input: &Value, ctx: &ToolCtx) -> Result<ToolApproval, String> {
        let base = base_dir(ctx)?;
        let p = str_arg(input, "path")?;
        let content = str_arg(input, "content")?;
        let full = resolve_for_write(&base, p)?;
        let preimage = read_file_preimage(&full).await?;
        let diff = match &preimage {
            FilePreimage::Missing => Some(unified_diff("", content)),
            FilePreimage::Present(bytes) => std::str::from_utf8(bytes)
                .ok()
                .map(|old| unified_diff(old, content)),
        };
        Ok(ToolApproval {
            diff,
            file_precondition: Some(snapshot_precondition(full, &preimage)),
        })
    }

    async fn run_with_precondition(
        &self,
        input: Value,
        ctx: &ToolCtx,
        precondition: Option<FilePrecondition>,
    ) -> Result<String, String> {
        let base = base_dir(ctx)?;
        let p = str_arg(&input, "path")?;
        let content = str_arg(&input, "content")?;
        let full = resolve_for_write(&base, p)?;
        let preimage = read_file_preimage(&full).await?;
        validate_file_precondition(precondition.as_ref(), &full, &preimage)?;

        let (existed, old_bytes) = match &preimage {
            FilePreimage::Missing => (false, None),
            FilePreimage::Present(bytes) => (true, Some(bytes.as_slice())),
        };
        let write_outcome = exact_write_outcome(existed, old_bytes, content.as_bytes());
        let old = old_bytes
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .unwrap_or_default();

        ensure_mutation_not_cancelled(ctx)?;

        // Identical bytes are a true no-op: do not rewrite the file (which would
        // alter metadata) and do not enter the mutation ledger.
        if write_outcome == ExactWriteOutcome::Unchanged {
            return Ok(format!("Unchanged {p} ({} bytes)", content.len()));
        }

        // Open the exact interval immediately before the first possible side
        // effect. Any error from here on drops the token as may-have-mutated.
        let mutation = ctx.receipt.as_ref().map(|tracker| tracker.begin_exact());
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("failed to create dirs for '{p}': {e}"))?;
        }
        tokio::fs::write(&full, content)
            .await
            .map_err(|e| format!("failed to write '{p}': {e}"))?;
        if let Some(mutation) = mutation {
            mutation.finish_exact(&full, old_bytes, content.as_bytes(), write_outcome);
        }
        if !existed {
            Ok(format!("Created {p} ({} bytes)", content.len()))
        } else {
            match write_outcome {
                ExactWriteOutcome::Changed => Ok(format!(
                    "Updated {p} ({} bytes)\n\n{}",
                    content.len(),
                    truncate_chars(unified_diff(old, content), 8000)
                )),
                // Returned above before the mutation interval was opened.
                ExactWriteOutcome::Unchanged => unreachable!("no-op returned before write"),
                ExactWriteOutcome::Unknown => Ok(format!(
                    "Wrote {p} ({} bytes; previous contents unavailable)",
                    content.len()
                )),
            }
        }
    }
}

#[async_trait]
impl Tool for FsWrite {
    fn name(&self) -> &'static str {
        tool_names::WRITE_FILE
    }
    fn description(&self) -> &'static str {
        "Create or overwrite a file with the given contents. Parent directories are created as needed."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path relative to the workspace root." },
                "content": { "type": "string", "description": "Full file contents to write." }
            },
            "required": ["path", "content"]
        })
    }
    fn permission_risk(&self) -> Option<PermissionRisk> {
        Some(PermissionRisk::Configurable)
    }
    fn mutating(&self) -> bool {
        true
    }
    /// Show the RESOLVED absolute destination in the permission prompt, not the raw
    /// argument, so a benign-looking relative path (or one that traverses a symlink/
    /// junction) can't trick the user into approving a write outside the workspace.
    /// Falls back to the raw path if resolution fails (so the prompt is never empty).
    fn summarize(&self, input: &Value, ctx: &ToolCtx) -> String {
        let raw = input.get("path").and_then(|v| v.as_str());
        match (base_dir(ctx), raw) {
            (Ok(base), Some(p)) => match resolve_for_write(&base, p) {
                Ok(resolved) => resolved.display().to_string(),
                Err(_) => p.to_string(),
            },
            (_, Some(p)) => p.to_string(),
            _ => self.name().to_string(),
        }
    }
    /// Preview the write as a diff of the existing file (or empty) against the
    /// proposed contents, without writing anything. `None` on bad args / a path
    /// that fails the sandbox resolution (the gate surfaces that anyway).
    async fn preview(&self, input: &Value, ctx: &ToolCtx) -> Option<String> {
        self.build_approval(input, ctx).await.ok()?.diff
    }
    async fn approval(&self, input: &Value, ctx: &ToolCtx) -> ToolApproval {
        self.build_approval(input, ctx)
            .await
            .unwrap_or_else(unverifiable_approval)
    }
    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String> {
        self.run_with_precondition(input, ctx, None).await
    }
    async fn run_approved(
        &self,
        input: Value,
        ctx: &ToolCtx,
        approval: ToolApproval,
    ) -> Result<String, String> {
        self.run_with_precondition(input, ctx, approval.file_precondition)
            .await
    }
}

struct FsEdit;

impl FsEdit {
    async fn build_approval(&self, input: &Value, ctx: &ToolCtx) -> Result<ToolApproval, String> {
        let base = base_dir(ctx)?;
        let p = str_arg(input, "path")?;
        let old = str_arg(input, "old_string")?;
        let new = str_arg(input, "new_string")?;
        let replace_all = input
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let full = resolve_existing(&base, p)?;
        let preimage = read_file_preimage(&full).await?;
        let bytes = match &preimage {
            FilePreimage::Present(bytes) => bytes,
            FilePreimage::Missing => return Err(format!("failed to read '{p}': file disappeared")),
        };
        let content = std::str::from_utf8(bytes)
            .map_err(|_| format!("failed to read '{p}': file is not valid UTF-8"))?;
        let (updated, _) = compute_edit(content, old, new, replace_all, p)?;
        Ok(ToolApproval {
            diff: Some(unified_diff(content, &updated)),
            file_precondition: Some(snapshot_precondition(full, &preimage)),
        })
    }

    async fn run_with_precondition(
        &self,
        input: Value,
        ctx: &ToolCtx,
        precondition: Option<FilePrecondition>,
    ) -> Result<String, String> {
        let base = base_dir(ctx)?;
        let p = str_arg(&input, "path")?;
        let old = str_arg(&input, "old_string")?;
        let new = str_arg(&input, "new_string")?;
        let replace_all = input
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let full = resolve_existing(&base, p)?;
        let preimage = read_file_preimage(&full).await?;
        validate_file_precondition(precondition.as_ref(), &full, &preimage)?;
        let bytes = match &preimage {
            FilePreimage::Present(bytes) => bytes,
            FilePreimage::Missing => return Err(format!("failed to read '{p}': file disappeared")),
        };
        let content = std::str::from_utf8(bytes)
            .map_err(|_| format!("failed to read '{p}': file is not valid UTF-8"))?;
        let (updated, count) = compute_edit(content, old, new, replace_all, p)?;
        ensure_mutation_not_cancelled(ctx)?;
        if content == updated {
            return Ok(format!("Unchanged {p} ({count} matching replacement(s))"));
        }

        // Reads, validation, and no-op detection above are side-effect free. Start
        // provenance only at the write boundary.
        let mutation = ctx.receipt.as_ref().map(|tracker| tracker.begin_exact());
        tokio::fs::write(&full, &updated)
            .await
            .map_err(|e| format!("failed to write '{p}': {e}"))?;
        if let Some(mutation) = mutation {
            mutation.finish_exact(
                &full,
                Some(bytes.as_slice()),
                updated.as_bytes(),
                ExactWriteOutcome::Changed,
            );
        }
        Ok(format!(
            "Edited {p} ({count} replacement(s))\n\n{}",
            truncate_chars(unified_diff(content, &updated), 8000)
        ))
    }
}

#[async_trait]
impl Tool for FsEdit {
    fn name(&self) -> &'static str {
        tool_names::EDIT_FILE
    }
    fn description(&self) -> &'static str {
        "Replace an exact string in a file. 'old_string' must appear exactly once unless 'replace_all' is true."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path relative to the workspace root." },
                "old_string": { "type": "string", "description": "Exact text to replace." },
                "new_string": { "type": "string", "description": "Replacement text." },
                "replace_all": { "type": "boolean", "description": "Replace every occurrence (default false)." }
            },
            "required": ["path", "old_string", "new_string"]
        })
    }
    fn permission_risk(&self) -> Option<PermissionRisk> {
        Some(PermissionRisk::Configurable)
    }
    fn mutating(&self) -> bool {
        true
    }
    /// Preview the edit as a diff without writing — exactly the change `run`
    /// would apply (both go through `compute_edit`). Returns `None` if anything
    /// the gate would surface as an error anyway (bad args, file missing,
    /// string not found) so the prompt falls back to the one-line summary.
    async fn preview(&self, input: &Value, ctx: &ToolCtx) -> Option<String> {
        self.build_approval(input, ctx).await.ok()?.diff
    }
    async fn approval(&self, input: &Value, ctx: &ToolCtx) -> ToolApproval {
        self.build_approval(input, ctx)
            .await
            .unwrap_or_else(unverifiable_approval)
    }
    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String> {
        self.run_with_precondition(input, ctx, None).await
    }
    async fn run_approved(
        &self,
        input: Value,
        ctx: &ToolCtx,
        approval: ToolApproval,
    ) -> Result<String, String> {
        self.run_with_precondition(input, ctx, approval.file_precondition)
            .await
    }
}

struct Shell;

/// Maximum retained bytes from each child pipe. The drain continues after this
/// prefix is full so a noisy child cannot deadlock on a full pipe, while memory
/// use stays fixed for foreground and background commands.
const SHELL_PIPE_LIMIT: usize = 50_000;

struct BoundedPipe {
    bytes: Vec<u8>,
    truncated: bool,
}

pub(crate) struct BoundedShellOutput {
    pub(crate) status: std::process::ExitStatus,
    stdout: BoundedPipe,
    stderr: BoundedPipe,
}

async fn read_bounded_pipe(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
) -> std::io::Result<BoundedPipe> {
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let mut truncated = false;
    let mut chunk = [0_u8; 8192];
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        let keep = remaining.min(read);
        bytes.extend_from_slice(&chunk[..keep]);
        truncated |= keep < read;
    }
    Ok(BoundedPipe { bytes, truncated })
}

/// Wait for a piped child while draining stdout and stderr concurrently with a
/// fixed retained prefix. Dropping this future drops the kill-on-drop child.
pub(crate) async fn wait_with_bounded_output(
    mut child: tokio::process::Child,
) -> std::io::Result<BoundedShellOutput> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("child stdout was not piped"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::other("child stderr was not piped"))?;
    let (status, stdout, stderr) = tokio::join!(
        child.wait(),
        read_bounded_pipe(stdout, SHELL_PIPE_LIMIT),
        read_bounded_pipe(stderr, SHELL_PIPE_LIMIT),
    );
    Ok(BoundedShellOutput {
        status: status?,
        stdout: stdout?,
        stderr: stderr?,
    })
}

#[cfg(windows)]
fn default_shell() -> &'static str {
    "powershell"
}

#[cfg(not(windows))]
fn default_shell() -> &'static str {
    "sh"
}

/// Resolve a requested shell to an absolute executable and the leading args that
/// run one command string without user profiles or Windows cmd AutoRun hooks.
#[cfg(windows)]
fn shell_invocation(shell: &str) -> Result<(PathBuf, &'static [&'static str]), String> {
    let system_root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("WINDIR"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "Windows system directory is unavailable".to_string())?;
    match shell {
        "powershell" => Ok((
            system_root
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
            &["-NoProfile", "-NonInteractive", "-Command"],
        )),
        "pwsh" => crate::process_env::resolve_in_sanitized_path(
            std::ffi::OsStr::new("pwsh.exe"),
            crate::process_env::ChildKind::AgentShell,
        )
        .map(|path| {
            (
                path,
                &["-NoProfile", "-NonInteractive", "-Command"] as &'static [&'static str],
            )
        })
        .ok_or_else(|| "PowerShell 7 (pwsh.exe) was not found in the reviewed PATH".to_string()),
        "cmd" => Ok((
            system_root.join("System32").join("cmd.exe"),
            &["/D", "/S", "/C"],
        )),
        other => Err(format!(
            "unknown shell '{other}'; expected one of: powershell, pwsh, cmd"
        )),
    }
}

#[cfg(not(windows))]
fn shell_invocation(shell: &str) -> Result<(PathBuf, &'static [&'static str]), String> {
    match shell {
        "sh" => Ok((PathBuf::from("/bin/sh"), &["-c"])),
        other => Err(format!("unknown shell '{other}'; expected: sh")),
    }
}

/// Build the configured shell command (program + leading args, workspace cwd,
/// piped stdout/stderr, kill-on-drop, and the Windows no-console-window flag),
/// shared by the foreground `shell` run and a background launch so both behave
/// identically.
fn build_shell_command(
    command: &str,
    shell: &str,
    workspace: &Path,
) -> Result<tokio::process::Command, String> {
    let (program, leading_args) = shell_invocation(shell)?;
    let mut cmd =
        crate::process_env::child_command(program, crate::process_env::ChildKind::AgentShell);

    #[cfg(windows)]
    if shell == "cmd" {
        // cmd.exe parses its command line itself instead of using
        // CommandLineToArgvW. Keep AutoRun disabled and pass one quoted command
        // string literally so Rust's generic argument quoting cannot rewrite it.
        cmd.raw_arg(format!("/D /S /C \"{command}\""));
    } else {
        cmd.args(leading_args).arg(command);
    }
    #[cfg(not(windows))]
    cmd.args(leading_args).arg(command);

    cmd.current_dir(workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // The central process boundary suppresses Windows console allocation while
    // preserving the same command setup on other platforms.
    Ok(cmd)
}

#[derive(Debug, PartialEq, Eq)]
enum ForegroundWaitError {
    Cancelled,
    TimedOut,
    Failed(String),
}

impl std::fmt::Display for ForegroundWaitError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("command cancelled"),
            Self::TimedOut => formatter.write_str("command timed out after 120s"),
            Self::Failed(error) => write!(formatter, "command failed: {error}"),
        }
    }
}

/// Ask Windows to terminate a process and every descendant while the root PID
/// still exists. `Child::start_kill` only terminates the direct shell on Windows;
/// a compiler, script, or other child could otherwise keep mutating files after
/// the user pressed Stop.
///
/// `taskkill /T /F` is deliberately launched before the direct-child fallback:
/// after the shell is gone, Windows may no longer be able to discover its tree.
/// The helper is hidden and strictly bounded so a broken system utility cannot
/// make Stop hang.
#[cfg(windows)]
async fn terminate_windows_process_tree(process_id: Option<u32>) {
    const TREE_KILL_TIMEOUT: Duration = Duration::from_secs(2);
    const HELPER_REAP_TIMEOUT: Duration = Duration::from_millis(250);

    let Some(process_id) = process_id else {
        return;
    };
    let Some(system_root) = std::env::var_os("SystemRoot") else {
        return;
    };
    let taskkill = PathBuf::from(system_root)
        .join("System32")
        .join("taskkill.exe");
    if !taskkill.is_file() {
        return;
    }

    let mut command = crate::process_env::hidden_command(taskkill);
    command
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let Ok(mut helper) = command.spawn() else {
        return;
    };
    if tokio::time::timeout(TREE_KILL_TIMEOUT, helper.wait())
        .await
        .is_err()
    {
        let _ = helper.start_kill();
        let _ = tokio::time::timeout(HELPER_REAP_TIMEOUT, helper.wait()).await;
    }
}

#[cfg(not(windows))]
async fn terminate_windows_process_tree(_process_id: Option<u32>) {}

async fn kill_reap_and_abort_readers(
    child: &mut tokio::process::Child,
    process_id: Option<u32>,
    stdout: &mut tokio::task::JoinHandle<std::io::Result<BoundedPipe>>,
    stderr: &mut tokio::task::JoinHandle<std::io::Result<BoundedPipe>>,
) {
    // On Windows this must happen before `start_kill`, while the root PID still
    // identifies its descendants. It is a no-op on other platforms.
    terminate_windows_process_tree(process_id).await;
    // `start_kill` does not consume the child, so `wait` below always reaps it.
    // Abort the pipe readers too: a grandchild may have inherited those handles
    // and otherwise keep cancellation waiting even after the shell itself died.
    let _ = child.start_kill();
    stdout.abort();
    stderr.abort();
    let _ = child.wait().await;
    let _ = stdout.await;
    let _ = stderr.await;
}

/// Wait for a foreground shell while remaining responsive to the run's Stop
/// flag. Output is drained concurrently to avoid pipe backpressure. Cancellation
/// and timeout both kill and reap the direct child before returning.
async fn wait_for_foreground_child(
    mut child: tokio::process::Child,
    cancel: Option<Arc<AtomicBool>>,
    timeout: Duration,
) -> Result<BoundedShellOutput, ForegroundWaitError> {
    let process_id = child.id();
    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| ForegroundWaitError::Failed("child stdout was not piped".into()))?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| ForegroundWaitError::Failed("child stderr was not piped".into()))?;
    let mut stdout = tokio::spawn(read_bounded_pipe(stdout_pipe, SHELL_PIPE_LIMIT));
    let mut stderr = tokio::spawn(read_bounded_pipe(stderr_pipe, SHELL_PIPE_LIMIT));
    let deadline = tokio::time::Instant::now() + timeout;

    let status = tokio::select! {
        biased;
        _ = wait_for_mutation_cancellation(cancel.clone()) => {
            kill_reap_and_abort_readers(&mut child, process_id, &mut stdout, &mut stderr).await;
            return Err(ForegroundWaitError::Cancelled);
        }
        _ = tokio::time::sleep_until(deadline) => {
            kill_reap_and_abort_readers(&mut child, process_id, &mut stdout, &mut stderr).await;
            return Err(ForegroundWaitError::TimedOut);
        }
        result = child.wait() => match result {
            Ok(status) => status,
            Err(error) => {
                kill_reap_and_abort_readers(
                    &mut child,
                    process_id,
                    &mut stdout,
                    &mut stderr,
                )
                .await;
                return Err(ForegroundWaitError::Failed(error.to_string()));
            }
        },
    };

    // A detached descendant can keep inherited stdout/stderr open after the
    // direct shell exits, so the original timeout and cancellation still govern
    // this output-drain phase.
    let (stdout_result, stderr_result) = tokio::select! {
        biased;
        _ = wait_for_mutation_cancellation(cancel) => {
            // The shell may already have exited while a descendant still owns
            // its inherited pipes. Retain and try the original PID before
            // abandoning those readers.
            terminate_windows_process_tree(process_id).await;
            stdout.abort();
            stderr.abort();
            let _ = (&mut stdout).await;
            let _ = (&mut stderr).await;
            return Err(ForegroundWaitError::Cancelled);
        }
        _ = tokio::time::sleep_until(deadline) => {
            terminate_windows_process_tree(process_id).await;
            stdout.abort();
            stderr.abort();
            let _ = (&mut stdout).await;
            let _ = (&mut stderr).await;
            return Err(ForegroundWaitError::TimedOut);
        }
        results = async { tokio::join!(&mut stdout, &mut stderr) } => results,
    };

    let stdout = stdout_result
        .map_err(|error| ForegroundWaitError::Failed(error.to_string()))?
        .map_err(|error| ForegroundWaitError::Failed(error.to_string()))?;
    let stderr = stderr_result
        .map_err(|error| ForegroundWaitError::Failed(error.to_string()))?
        .map_err(|error| ForegroundWaitError::Failed(error.to_string()))?;

    Ok(BoundedShellOutput {
        status,
        stdout,
        stderr,
    })
}

fn format_shell_parts(
    status: std::process::ExitStatus,
    stdout_bytes: &[u8],
    stdout_truncated: bool,
    stderr_bytes: &[u8],
    stderr_truncated: bool,
) -> String {
    let mut buf = String::new();
    let stdout = String::from_utf8_lossy(stdout_bytes);
    let stderr = String::from_utf8_lossy(stderr_bytes);
    if !stdout.trim().is_empty() {
        buf.push_str(&stdout);
    }
    if stdout_truncated {
        if !buf.ends_with('\n') {
            buf.push('\n');
        }
        buf.push_str("[stdout truncated]\n");
    }
    if !stderr.trim().is_empty() {
        if !buf.is_empty() {
            buf.push('\n');
        }
        buf.push_str("[stderr]\n");
        buf.push_str(&stderr);
    }
    if stderr_truncated {
        if !buf.ends_with('\n') {
            buf.push('\n');
        }
        buf.push_str("[stderr truncated]\n");
    }
    let code = status.code().unwrap_or(-1);
    if buf.trim().is_empty() {
        buf = "(no output)".into();
    }
    format!("{}\n\n[exit code {code}]", buf.trim_end())
}

/// Format the fixed-memory capture shared by foreground and background commands.
pub(crate) fn format_bounded_shell_output(out: &BoundedShellOutput) -> String {
    format_shell_parts(
        out.status,
        &out.stdout.bytes,
        out.stdout.truncated,
        &out.stderr.bytes,
        out.stderr.truncated,
    )
}

#[cfg(all(test, unix))]
pub(crate) fn format_shell_output(out: &std::process::Output) -> String {
    format_shell_parts(out.status, &out.stdout, false, &out.stderr, false)
}

#[async_trait]
impl Tool for Shell {
    fn name(&self) -> &'static str {
        tool_names::RUN_COMMAND
    }
    fn description(&self) -> &'static str {
        #[cfg(windows)]
        {
            "Run a shell command in the workspace. Defaults to PowerShell (Windows PowerShell 5.1, \
         powershell.exe); set `shell` to \"pwsh\" for PowerShell 7+ or \"cmd\" for the legacy \
         Windows command prompt. PowerShell and cmd differ in quoting, path, and exit-code \
         semantics, so write the command for the shell you select. Returns combined stdout/stderr \
         and the exit code. Set `background: true` for a long-running command (server, build, \
         watcher): it returns immediately with a task id and reports its result when it finishes, \
         instead of blocking."
        }
        #[cfg(not(windows))]
        {
            "Run a /bin/sh command with the workspace as its current directory. Returns bounded \
             combined stdout/stderr and the exit code. Set `background: true` for a long-running \
             command so it returns immediately and reports its result when it finishes."
        }
    }
    fn input_schema(&self) -> Value {
        #[cfg(windows)]
        let (shells, default_description) = (
            vec!["powershell", "pwsh", "cmd"],
            "Shell to run. powershell is the default; pwsh selects PowerShell 7+; cmd selects the legacy command prompt.",
        );
        #[cfg(not(windows))]
        let (shells, default_description) = (
            vec!["sh"],
            "Shell to run. /bin/sh is the only supported value and the default.",
        );
        json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Command line to execute." },
                "shell": {
                    "type": "string",
                    "enum": shells,
                    "description": default_description
                },
                "background": {
                    "type": "boolean",
                    "description": "Run in the background: return immediately with a task id and report the result when the command finishes, rather than blocking (use for servers/builds/watchers). Default false."
                }
            },
            "required": ["command"]
        })
    }
    fn permission_risk(&self) -> Option<PermissionRisk> {
        Some(PermissionRisk::Shell)
    }
    fn mutating(&self) -> bool {
        true
    }
    fn mutation_scope(&self) -> Option<MutationScope> {
        Some(MutationScope::Opaque)
    }
    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String> {
        let command = str_arg(&input, "command")?;
        let shell = input
            .get("shell")
            .and_then(|v| v.as_str())
            .unwrap_or(default_shell());
        let background = input
            .get("background")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // Resolve the background runner BEFORE spawning, so an unavailable
        // background mode errors without leaving an orphan process.
        let runner = if background {
            Some(
                ctx.background
                    .as_ref()
                    .ok_or_else(|| "Background tasks are not available in this run.".to_string())?,
            )
        } else {
            None
        };
        let mut cmd = build_shell_command(command, shell, &ctx.workspace)?;
        ensure_mutation_not_cancelled(ctx)?;
        // The barrier is already held by `gate_and_run`. Enter the opaque ledger
        // at the last boundary before process creation; a successful spawn may
        // mutate even if waiting later times out or fails.
        let mutation = ctx.receipt.as_ref().map(|tracker| tracker.begin_opaque());
        let child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => {
                if let Some(mutation) = mutation {
                    mutation.finish_no_effect();
                }
                return Err(format!("failed to start {shell}: {error}"));
            }
        };

        if let Some(runner) = runner {
            // Hand the live child to the runner; it waits and reports completion.
            let id = runner.launch(command.to_string(), child, mutation);
            return Ok(format!(
                "Started background task {id}: {command}\nIt runs without blocking; \
                 its result is reported when it finishes."
            ));
        }

        let out = wait_for_foreground_child(child, ctx.cancel.clone(), Duration::from_secs(120))
            .await
            .map_err(|error| error.to_string())?;
        if let Some(mutation) = mutation {
            mutation.finish_observed();
        }
        Ok(format_bounded_shell_output(&out))
    }
}

/// Launch an autonomous subagent. The subagent gets its own tools and a fresh
/// context, works through the task on its own, and returns a single final summary
/// — its only output to the launching agent. The launch itself is NOT gated
/// (`permission_risk()` is `None`): every mutating tool the subagent runs still goes
/// through the permission gate, so nothing it does escapes the user's control.
struct Task;

#[async_trait]
impl Tool for Task {
    fn name(&self) -> &'static str {
        tool_names::DELEGATE_TASK
    }
    fn description(&self) -> &'static str {
        "Launch a subagent to handle a complex, well-scoped task autonomously. The \
         subagent has its own tools and a fresh context, works through the task on its \
         own, and returns a single final summary — its only output back to you. Use it \
         to offload focused research or a self-contained multi-step change so it does \
         not consume this conversation's context. The subagent CANNOT ask you \
         questions, so put everything it needs in `prompt`."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "description": { "type": "string", "description": "A short (3-5 word) label for the task." },
                "prompt": { "type": "string", "description": "The full, self-contained task for the subagent to carry out autonomously." }
            },
            "required": ["description", "prompt"]
        })
    }
    fn permission_risk(&self) -> Option<PermissionRisk> {
        None
    }
    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String> {
        let prompt = str_arg(&input, "prompt")?.to_string();
        let description = input
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let spawner = ctx.spawner.as_ref().ok_or_else(|| {
            "Subagents are not available in this run (nested too deep, or this run is \
             read-only)."
                .to_string()
        })?;
        spawner
            .spawn(SubagentSpec {
                description,
                prompt,
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A real, canonicalized workspace dir. `resolve_for_write` now resolves through
    /// the filesystem (to defeat reparse-point escapes), so the base must exist and
    /// be canonical — mirroring production, where the base is `base_dir(ctx)`.
    fn base() -> PathBuf {
        unique_temp_dir("base")
    }

    #[test]
    fn resolve_for_write_accepts_paths_inside_the_workspace() {
        let b = base();
        let p = resolve_for_write(&b, "sub/file.txt").unwrap();
        assert!(p.starts_with(&b));
        assert!(p.ends_with("file.txt"));
        std::fs::remove_dir_all(&b).ok();
    }

    #[test]
    fn resolve_for_write_normalizes_dot_and_dotdot_within_base() {
        let b = base();
        // `b` is canonical and the existing ancestor, so the not-yet-existing tail is
        // appended verbatim onto it.
        assert_eq!(
            resolve_for_write(&b, "a/../b/./c.txt").unwrap(),
            b.join("b").join("c.txt")
        );
        std::fs::remove_dir_all(&b).ok();
    }

    #[test]
    fn resolve_for_write_rejects_a_parent_escape() {
        let b = base();
        assert!(resolve_for_write(&b, "../escape.txt")
            .unwrap_err()
            .contains("outside the workspace"));
        std::fs::remove_dir_all(&b).ok();
    }

    #[test]
    fn resolve_for_write_rejects_an_absolute_path_outside_base() {
        let b = base();
        let outside = b.parent().unwrap().join("other.txt");
        assert!(resolve_for_write(&b, outside.to_str().unwrap())
            .unwrap_err()
            .contains("outside the workspace"));
        std::fs::remove_dir_all(&b).ok();
    }

    // ── sandbox-escape via reparse points (junction / symlink) ────────────────
    //
    // These build a REAL temp tree so the canonicalizing containment check is
    // actually exercised, not just the lexical pop. Each uses a unique workspace
    // dir so the tests are independent and parallel-safe.

    fn unique_temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "portcode_resolve_test_{tag}_{}_{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // Canonicalize so the base matches what `base_dir(ctx)` produces in
        // production (and so containment comparisons are apples-to-apples).
        dir.canonicalize().unwrap()
    }

    /// Create a directory junction/symlink at `link` pointing to `target`. Returns
    /// false if the OS refused (e.g. symlink privilege missing on CI) so the caller
    /// can skip gracefully.
    #[cfg(windows)]
    fn make_dir_reparse(link: &Path, target: &Path) -> bool {
        // Prefer a junction (no privilege required, unlike a symlink on most CI).
        std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &link.to_string_lossy(),
                &target.to_string_lossy(),
            ])
            .status()
            .is_ok_and(|s| s.success())
    }

    #[cfg(unix)]
    fn make_dir_reparse(link: &Path, target: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    #[cfg(not(any(windows, unix)))]
    fn make_dir_reparse(_link: &Path, _target: &Path) -> bool {
        false
    }

    #[tokio::test]
    async fn fs_write_through_an_inside_junction_to_outside_is_rejected() {
        let root = unique_temp_dir("escape");
        let workspace = root.join("workspace");
        let outside = root.join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        // A reparse point that lives INSIDE the workspace but points OUTSIDE it.
        let link = workspace.join("escape");
        if !make_dir_reparse(&link, &outside) {
            // Couldn't create a reparse point (privilege). Don't fail CI; the
            // resolver is still covered by the lexical-escape tests.
            std::fs::remove_dir_all(&root).ok();
            return;
        }

        let ctx = ToolCtx::new(workspace.clone());
        let err = FsWrite
            .run(json!({ "path": "escape/pwned.txt", "content": "x" }), &ctx)
            .await
            .unwrap_err();
        assert!(
            err.contains("outside the workspace"),
            "expected sandbox rejection, got: {err}"
        );
        // The write must NOT have landed in the real outside dir.
        assert!(!outside.join("pwned.txt").exists());

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn fs_edit_through_an_inside_junction_to_outside_is_rejected() {
        let root = unique_temp_dir("escape_edit");
        let workspace = root.join("workspace");
        let outside = root.join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        // A real file outside, reachable only through the junction.
        std::fs::write(outside.join("secret.txt"), "original").unwrap();

        let link = workspace.join("escape");
        if !make_dir_reparse(&link, &outside) {
            std::fs::remove_dir_all(&root).ok();
            return;
        }

        let ctx = ToolCtx::new(workspace.clone());
        let err = FsEdit
            .run(
                json!({
                    "path": "escape/secret.txt",
                    "old_string": "original",
                    "new_string": "tampered"
                }),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(
            err.contains("outside the workspace"),
            "expected sandbox rejection, got: {err}"
        );
        // The outside file must be untouched.
        assert_eq!(
            std::fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "original"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn fs_write_creates_a_missing_parent_inside_the_workspace() {
        let workspace = unique_temp_dir("normal_write");
        let ctx = ToolCtx::new(workspace.clone());
        let out = FsWrite
            .run(
                json!({ "path": "nested/dir/file.txt", "content": "hello" }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(out.contains("Created"));
        let written = workspace.join("nested").join("dir").join("file.txt");
        assert_eq!(std::fs::read_to_string(&written).unwrap(), "hello");

        std::fs::remove_dir_all(&workspace).ok();
    }

    #[tokio::test]
    async fn fs_write_same_bytes_reports_unchanged() {
        let workspace = unique_temp_dir("noop_write");
        let tracker = crate::turn_receipt::TurnReceiptTracker::new_with_account(
            "noop-write".into(),
            crate::db::now_ms(),
            std::time::Instant::now(),
            workspace.clone(),
            None,
        );
        let mut ctx = ToolCtx::new(workspace.clone());
        ctx.receipt = Some(tracker.clone());
        let file = workspace.join("file.txt");
        std::fs::write(&file, "same\n").unwrap();

        let out = FsWrite
            .run(json!({ "path": "file.txt", "content": "same\n" }), &ctx)
            .await
            .unwrap();

        assert_eq!(out, "Unchanged file.txt (5 bytes)");
        assert_eq!(std::fs::read_to_string(file).unwrap(), "same\n");
        assert!(
            !tracker.receipt_expected(),
            "identical bytes must not enter the mutation ledger"
        );
        std::fs::remove_dir_all(&workspace).ok();
    }

    #[tokio::test]
    async fn fs_edit_same_replacement_is_a_no_effect_turn() {
        let workspace = unique_temp_dir("noop_edit");
        let tracker = crate::turn_receipt::TurnReceiptTracker::new_with_account(
            "noop-edit".into(),
            crate::db::now_ms(),
            std::time::Instant::now(),
            workspace.clone(),
            None,
        );
        let mut ctx = ToolCtx::new(workspace.clone());
        ctx.receipt = Some(tracker.clone());
        let file = workspace.join("file.txt");
        std::fs::write(&file, "same\n").unwrap();

        let out = FsEdit
            .run(
                json!({
                    "path": "file.txt",
                    "old_string": "same",
                    "new_string": "same"
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert_eq!(out, "Unchanged file.txt (1 matching replacement(s))");
        assert_eq!(std::fs::read_to_string(file).unwrap(), "same\n");
        assert!(
            !tracker.receipt_expected(),
            "a semantic edit no-op must not enter the mutation ledger"
        );
        std::fs::remove_dir_all(&workspace).ok();
    }

    #[tokio::test]
    async fn fs_write_rejects_a_preimage_changed_after_approval() {
        let workspace = unique_temp_dir("write_approval_toctou");
        let tracker = crate::turn_receipt::TurnReceiptTracker::new_with_account(
            "write-approval-toctou".into(),
            crate::db::now_ms(),
            std::time::Instant::now(),
            workspace.clone(),
            None,
        );
        let mut ctx = ToolCtx::new(workspace.clone());
        ctx.receipt = Some(tracker.clone());
        let file = workspace.join("file.txt");
        std::fs::write(&file, "approved preimage\n").unwrap();
        let input = json!({ "path": "file.txt", "content": "agent result\n" });
        let approval = FsWrite.approval(&input, &ctx).await;

        // Simulate an editor or another agent changing the file while the user is
        // reading the permission prompt.
        std::fs::write(&file, "external change\n").unwrap();
        let error = FsWrite
            .run_approved(input, &ctx, approval)
            .await
            .unwrap_err();

        assert!(error.contains("changed after permission"), "got: {error}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "external change\n");
        assert!(
            !tracker.receipt_expected(),
            "stale permission must abort before the mutation ledger"
        );
        std::fs::remove_dir_all(&workspace).ok();
    }

    #[tokio::test]
    async fn fs_edit_rejects_a_preimage_changed_after_approval() {
        let workspace = unique_temp_dir("edit_approval_toctou");
        let tracker = crate::turn_receipt::TurnReceiptTracker::new_with_account(
            "edit-approval-toctou".into(),
            crate::db::now_ms(),
            std::time::Instant::now(),
            workspace.clone(),
            None,
        );
        let mut ctx = ToolCtx::new(workspace.clone());
        ctx.receipt = Some(tracker.clone());
        let file = workspace.join("file.txt");
        std::fs::write(&file, "value = 1\n").unwrap();
        let input = json!({
            "path": "file.txt",
            "old_string": "1",
            "new_string": "2"
        });
        let approval = FsEdit.approval(&input, &ctx).await;

        std::fs::write(&file, "value = 10\n").unwrap();
        let error = FsEdit
            .run_approved(input, &ctx, approval)
            .await
            .unwrap_err();

        assert!(error.contains("changed after permission"), "got: {error}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "value = 10\n");
        assert!(
            !tracker.receipt_expected(),
            "stale permission must abort before the mutation ledger"
        );
        std::fs::remove_dir_all(&workspace).ok();
    }

    #[tokio::test]
    async fn cancellation_after_approval_wins_at_the_write_boundary() {
        let workspace = unique_temp_dir("write_approval_cancel");
        let tracker = crate::turn_receipt::TurnReceiptTracker::new_with_account(
            "write-approval-cancel".into(),
            crate::db::now_ms(),
            std::time::Instant::now(),
            workspace.clone(),
            None,
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let mut ctx = ToolCtx::new(workspace.clone());
        ctx.cancel = Some(cancel.clone());
        ctx.receipt = Some(tracker.clone());
        let file = workspace.join("file.txt");
        std::fs::write(&file, "before\n").unwrap();
        let input = json!({ "path": "file.txt", "content": "after\n" });
        let approval = FsWrite.approval(&input, &ctx).await;

        cancel.store(true, Ordering::Relaxed);
        let error = FsWrite
            .run_approved(input, &ctx, approval)
            .await
            .unwrap_err();

        assert!(error.contains("Cancelled"), "got: {error}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "before\n");
        assert!(
            !tracker.receipt_expected(),
            "pre-mutation cancellation must not enter the ledger"
        );
        std::fs::remove_dir_all(&workspace).ok();
    }

    #[tokio::test]
    async fn exact_execution_permit_prevents_parallel_revalidate_then_clobber() {
        let workspace = unique_temp_dir("parallel_exact_gate");
        let tracker = crate::turn_receipt::TurnReceiptTracker::new_with_account(
            "parallel-exact-gate".into(),
            crate::db::now_ms(),
            std::time::Instant::now(),
            workspace.clone(),
            None,
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let file = workspace.join("file.txt");
        std::fs::write(&file, "shared preimage\n").unwrap();

        let first_input = json!({ "path": "file.txt", "content": "first writer\n" });
        let second_input = json!({ "path": "file.txt", "content": "second writer\n" });
        let mut first_ctx = ToolCtx::new(workspace.clone());
        first_ctx.cancel = Some(cancel.clone());
        first_ctx.receipt = Some(tracker.clone());
        let mut second_ctx = ToolCtx::new(workspace.clone());
        second_ctx.cancel = Some(cancel.clone());
        second_ctx.receipt = Some(tracker.clone());
        let first_approval = FsWrite.approval(&first_input, &first_ctx).await;
        let second_approval = FsWrite.approval(&second_input, &second_ctx).await;

        // Production `gate_and_run` holds this permit across `run_approved`.
        let first_permit = tracker
            .prepare_mutation(MutationScope::Exact, cancel.as_ref())
            .await
            .unwrap();
        let second_tracker = tracker.clone();
        let second_cancel = cancel.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (acquired_tx, mut acquired_rx) = tokio::sync::oneshot::channel();
        let second = tokio::spawn(async move {
            let _ = started_tx.send(());
            let _permit = second_tracker
                .prepare_mutation(MutationScope::Exact, second_cancel.as_ref())
                .await
                .unwrap();
            let _ = acquired_tx.send(());
            FsWrite
                .run_approved(second_input, &second_ctx, second_approval)
                .await
        });
        started_rx.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut acquired_rx)
                .await
                .is_err(),
            "a second exact operation acquired while revalidate/write was active"
        );

        FsWrite
            .run_approved(first_input, &first_ctx, first_approval)
            .await
            .unwrap();
        drop(first_permit);
        tokio::time::timeout(Duration::from_secs(2), &mut acquired_rx)
            .await
            .expect("queued exact operation acquires after release")
            .unwrap();
        let second_error = second.await.unwrap().unwrap_err();

        assert!(
            second_error.contains("changed after permission"),
            "got: {second_error}"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "first writer\n");

        // The same execution gate also orders exact operations against opaque
        // foreground work, not only against another first-class write.
        let exact_permit = tracker
            .prepare_mutation(MutationScope::Exact, cancel.as_ref())
            .await
            .unwrap();
        let opaque_tracker = tracker.clone();
        let opaque_cancel = cancel.clone();
        let (opaque_started_tx, opaque_started_rx) = tokio::sync::oneshot::channel();
        let opaque = tokio::spawn(async move {
            let _ = opaque_started_tx.send(());
            opaque_tracker
                .prepare_mutation(MutationScope::Opaque, opaque_cancel.as_ref())
                .await
                .unwrap()
        });
        tokio::pin!(opaque);
        opaque_started_rx.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut opaque)
                .await
                .is_err(),
            "opaque operation acquired while exact execution was active"
        );
        drop(exact_permit);
        tokio::time::timeout(Duration::from_secs(5), &mut opaque)
            .await
            .expect("queued opaque operation acquires after release")
            .unwrap();

        std::fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn exact_write_outcome_requires_readable_old_bytes_for_positive_evidence() {
        assert_eq!(
            exact_write_outcome(false, None, b"new"),
            ExactWriteOutcome::Changed
        );
        assert_eq!(
            exact_write_outcome(true, Some(b"old"), b"new"),
            ExactWriteOutcome::Changed
        );
        assert_eq!(
            exact_write_outcome(true, Some(b"same"), b"same"),
            ExactWriteOutcome::Unchanged
        );
        assert_eq!(
            exact_write_outcome(true, None, b"possibly-same"),
            ExactWriteOutcome::Unknown
        );
    }

    #[test]
    fn compute_edit_handles_single_all_and_error_cases() {
        let (out, n) = compute_edit("a b", "a", "X", false, "f").unwrap();
        assert_eq!((out.as_str(), n), ("X b", 1));
        let (out, n) = compute_edit("a a", "a", "X", true, "f").unwrap();
        assert_eq!((out.as_str(), n), ("X X", 2));
        assert!(compute_edit("abc", "z", "X", false, "f").is_err()); // not found
        assert!(compute_edit("a a", "a", "X", false, "f").is_err()); // ambiguous
        let err = compute_edit("abc", "", "X", true, "f").unwrap_err();
        assert!(err.contains("must not be empty"), "got: {err}");
        assert!(compute_edit("abc", "", "X", false, "f").is_err());
    }

    #[tokio::test]
    async fn fs_write_preview_shows_a_diff_without_writing() {
        let workspace = unique_temp_dir("preview_write");
        let ctx = ToolCtx::new(workspace.clone());
        let file = workspace.join("f.txt");
        std::fs::write(&file, "old line\n").unwrap();

        let diff = FsWrite
            .preview(&json!({ "path": "f.txt", "content": "new line\n" }), &ctx)
            .await
            .expect("a write to an existing file previews a diff");
        assert!(diff.contains("-old line"));
        assert!(diff.contains("+new line"));
        // The preview must NOT touch the file.
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "old line\n");

        std::fs::remove_dir_all(&workspace).ok();
    }

    #[tokio::test]
    async fn fs_write_preview_returns_none_for_an_unreadable_existing_file() {
        let workspace = unique_temp_dir("preview_unreadable");
        let ctx = ToolCtx::new(workspace.clone());
        std::fs::write(workspace.join("blob.bin"), [0xFF, 0xFE, 0x00, 0x80]).unwrap();

        let preview = FsWrite
            .preview(&json!({ "path": "blob.bin", "content": "new text" }), &ctx)
            .await;
        assert!(
            preview.is_none(),
            "an unreadable existing file must not preview as empty: {preview:?}"
        );

        std::fs::remove_dir_all(&workspace).ok();
    }

    #[tokio::test]
    async fn fs_edit_preview_matches_what_run_writes() {
        let workspace = unique_temp_dir("preview_edit");
        let ctx = ToolCtx::new(workspace.clone());
        let file = workspace.join("f.txt");
        std::fs::write(&file, "let x = 1;\n").unwrap();

        let input = json!({ "path": "f.txt", "old_string": "1", "new_string": "2" });
        let preview = FsEdit.preview(&input, &ctx).await.expect("previews a diff");
        assert!(preview.contains("-let x = 1;"));
        assert!(preview.contains("+let x = 2;"));
        // Preview leaves the file untouched...
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "let x = 1;\n");

        // ...and run() applies exactly the previewed change (shared compute_edit).
        let out = FsEdit.run(input, &ctx).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "let x = 2;\n");
        assert!(out.contains("-let x = 1;"));
        assert!(out.contains("+let x = 2;"));

        std::fs::remove_dir_all(&workspace).ok();
    }

    #[tokio::test]
    async fn fs_write_summarize_shows_the_resolved_destination() {
        let workspace = unique_temp_dir("summarize");
        let ctx = ToolCtx::new(workspace.clone());
        let summary = FsWrite.summarize(&json!({ "path": "sub/f.txt" }), &ctx);
        // Resolved to an absolute path under the (canonicalized) workspace, not the
        // raw "sub/f.txt".
        assert!(summary.ends_with("f.txt"));
        assert!(
            Path::new(&summary).is_absolute(),
            "summary should be absolute, got: {summary}"
        );
        let canon_ws = workspace.canonicalize().unwrap();
        assert!(
            Path::new(&summary).starts_with(&canon_ws),
            "summary {summary} should be under {}",
            canon_ws.display()
        );

        std::fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn str_arg_extracts_a_string_or_reports_missing_and_wrong_type() {
        let v = json!({ "path": "x", "n": 3 });
        assert_eq!(str_arg(&v, "path").unwrap(), "x");
        assert!(str_arg(&v, "absent")
            .unwrap_err()
            .contains("missing required argument"));
        assert!(str_arg(&v, "n").is_err()); // present but not a string
    }

    #[test]
    fn truncate_chars_passes_short_input_and_caps_long_input() {
        assert_eq!(truncate_chars("hello".into(), 10), "hello");
        let out = truncate_chars("x".repeat(20), 5);
        assert!(out.starts_with("xxxxx"));
        assert!(out.contains("[output truncated at 5 characters]"));
    }

    #[tokio::test]
    async fn bounded_pipe_retains_only_the_limit_but_drains_to_eof() {
        use tokio::io::AsyncWriteExt;

        let (mut writer, reader) = tokio::io::duplex(32);
        let producer = tokio::spawn(async move {
            writer.write_all(&vec![b'x'; 10_000]).await.unwrap();
            writer.shutdown().await.unwrap();
        });
        let captured = read_bounded_pipe(reader, 37).await.unwrap();
        producer.await.unwrap();

        assert_eq!(captured.bytes, vec![b'x'; 37]);
        assert!(captured.truncated);
    }

    #[cfg(windows)]
    #[test]
    fn shell_invocation_maps_windows_shells_to_reviewed_executables() {
        let (prog, args) = shell_invocation("powershell").unwrap();
        assert!(prog.is_absolute());
        assert!(prog.ends_with("WindowsPowerShell/v1.0/powershell.exe"));
        assert!(args.contains(&"-NonInteractive"));
        let (cprog, cargs) = shell_invocation("cmd").unwrap();
        assert!(cprog.is_absolute());
        assert!(cprog.ends_with("System32/cmd.exe"));
        assert_eq!(cargs, &["/D", "/S", "/C"]);
        assert!(shell_invocation("bash")
            .unwrap_err()
            .contains("unknown shell"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cmd_shell_uses_its_native_command_line_parser() {
        let workspace = std::env::current_dir().unwrap();
        let output = build_shell_command(
            r#"echo "PORTCODE CMD QUOTED"&echo PORTCODE_CMD_CHAINED"#,
            "cmd",
            &workspace,
        )
        .unwrap()
        .output()
        .await
        .unwrap();

        assert!(
            output.status.success(),
            "cmd failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert_eq!(
            stdout.lines().collect::<Vec<_>>(),
            [r#""PORTCODE CMD QUOTED""#, "PORTCODE_CMD_CHAINED"]
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn shell_invocation_uses_absolute_bin_sh_and_rejects_other_shells() {
        let (program, args) = shell_invocation("sh").unwrap();
        assert_eq!(program, PathBuf::from("/bin/sh"));
        assert_eq!(args, &["-c"]);
        assert!(shell_invocation("bash")
            .unwrap_err()
            .contains("unknown shell"));
    }

    #[test]
    fn receipt_scope_distinguishes_exact_opaque_and_read_only_tools() {
        assert_eq!(FsWrite.mutation_scope(), Some(MutationScope::Exact));
        assert_eq!(FsEdit.mutation_scope(), Some(MutationScope::Exact));
        assert_eq!(Shell.mutation_scope(), Some(MutationScope::Opaque));
        assert_eq!(FsRead.mutation_scope(), None);
    }

    #[test]
    fn build_shell_command_rejects_an_unknown_shell_and_accepts_known_ones() {
        // Propagates the shell_invocation error (no process is spawned here).
        assert!(build_shell_command("echo hi", "bash", Path::new(".")).is_err());
        assert!(build_shell_command("echo hi", default_shell(), Path::new(".")).is_ok());
    }

    #[tokio::test]
    async fn shell_background_without_a_runner_reports_unavailable_without_spawning() {
        // background=true on a ctx with no BackgroundRunner must fail closed BEFORE
        // building/spawning anything (so it's safe to assert cross-platform — no
        // PowerShell needed on Linux CI).
        let ctx = ToolCtx::new(base());
        let err = Shell
            .run(json!({ "command": "echo hi", "background": true }), &ctx)
            .await
            .unwrap_err();
        assert!(err.contains("not available"), "got: {err}");
    }

    #[tokio::test]
    async fn shell_spawn_failure_closes_opaque_guard_as_no_effect() {
        let workspace = unique_temp_dir("spawn_failure");
        let tracker = crate::turn_receipt::TurnReceiptTracker::new_with_account(
            "spawn-failure".into(),
            crate::db::now_ms(),
            std::time::Instant::now(),
            workspace.clone(),
            None,
        );
        // A missing current directory makes process creation fail consistently
        // after resolving the platform's default shell.
        std::fs::remove_dir_all(&workspace).unwrap();
        let mut ctx = ToolCtx::new(workspace);
        ctx.receipt = Some(tracker.clone());

        let err = Shell
            .run(json!({ "command": "echo hi" }), &ctx)
            .await
            .unwrap_err();

        assert!(err.contains("failed to start"), "got: {err}");
        assert!(
            !tracker.receipt_expected(),
            "a process that never spawned cannot be mutation evidence"
        );
    }

    #[cfg(any(windows, unix))]
    #[tokio::test]
    async fn foreground_child_is_killed_and_reaped_promptly_on_cancel() {
        let workspace = unique_temp_dir("foreground_cancel");
        #[cfg(windows)]
        let mut command = {
            let mut command = tokio::process::Command::new("ping");
            command.args(["-n", "30", "127.0.0.1"]);
            command
        };
        #[cfg(unix)]
        let mut command = { tokio::process::Command::new("sleep") };
        #[cfg(unix)]
        command.arg("30");
        command
            .current_dir(&workspace)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = command.spawn().expect("long-running test child starts");
        let cancel = Arc::new(AtomicBool::new(false));
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(75)).await;
            trigger.store(true, Ordering::Relaxed);
        });

        let started = std::time::Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            wait_for_foreground_child(child, Some(cancel), Duration::from_secs(60)),
        )
        .await
        .expect("cancellation must not wait for the command timeout");

        assert!(matches!(result, Err(ForegroundWaitError::Cancelled)));
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "cancelled foreground process was not reaped promptly"
        );
        std::fs::remove_dir_all(workspace).ok();
    }

    /// PowerShell's `-EncodedCommand` consumes UTF-16LE. Encoding the test
    /// scripts avoids nested quote/space behavior changing what process tree is
    /// actually launched on different Windows installations.
    #[cfg(windows)]
    fn encoded_powershell_command(script: &str) -> String {
        use base64::Engine as _;

        let bytes = script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn foreground_cancel_kills_descendant_before_it_can_write() {
        let workspace = unique_temp_dir("foreground_descendant_cancel");
        let ready = workspace.join("descendant-ready.txt");
        let sentinel = workspace.join("descendant-survived.txt");
        let ready_path = ready.to_string_lossy().replace('\'', "''");
        let sentinel_path = sentinel.to_string_lossy().replace('\'', "''");

        // The child waits long enough that cancellation deterministically lands
        // first, then attempts a file write. The root shell publishes `ready`
        // only after Start-Process returned a real descendant PID and remains
        // alive in Wait-Process, preserving the process-tree relationship.
        let child_script = format!(
            "Start-Sleep -Milliseconds 1200; [IO.File]::WriteAllText('{sentinel_path}', 'survived')"
        );
        let child_script = encoded_powershell_command(&child_script);
        let root_script = format!(
            "$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','{child_script}') -WindowStyle Hidden -PassThru; \
             [IO.File]::WriteAllText('{ready_path}', [string]$child.Id); \
             Wait-Process -Id $child.Id"
        );
        let root_script = encoded_powershell_command(&root_script);

        let mut command = crate::process_env::hidden_command("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &root_script,
            ])
            .current_dir(&workspace)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = command.spawn().expect("root PowerShell starts");

        let cancel = Arc::new(AtomicBool::new(false));
        let trigger = cancel.clone();
        let ready_for_trigger = ready.clone();
        let cancellation = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(5), async {
                while !ready_for_trigger.is_file() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("descendant did not publish readiness");
            trigger.store(true, Ordering::Relaxed);
        });

        let result = tokio::time::timeout(
            Duration::from_secs(5),
            wait_for_foreground_child(child, Some(cancel), Duration::from_secs(60)),
        )
        .await
        .expect("tree cancellation must stay bounded");
        cancellation.await.expect("cancellation trigger completed");
        assert!(matches!(result, Err(ForegroundWaitError::Cancelled)));

        // Wait beyond the descendant's scheduled write. If only the direct
        // PowerShell was killed, the orphan creates this file and the assertion
        // fails deterministically.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert!(
            !sentinel.exists(),
            "a foreground descendant survived Stop and wrote after cancellation"
        );
        std::fs::remove_dir_all(workspace).ok();
    }

    // `std::process::Output` can only be hand-built with a raw exit status on Unix,
    // and CI's coverage run is Linux, so gate this to unix. The formatting logic
    // itself is platform-agnostic.
    #[cfg(unix)]
    #[test]
    fn format_shell_output_combines_streams_marks_stderr_and_shows_exit_code() {
        use std::os::unix::process::ExitStatusExt;
        let ok = std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: b"hello\n".to_vec(),
            stderr: Vec::new(),
        };
        let s = format_shell_output(&ok);
        assert!(s.contains("hello"));
        assert!(s.contains("[exit code 0]"));
        assert!(!s.contains("[stderr]")); // no stderr → no label

        let with_err = std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: Vec::new(),
            stderr: b"boom\n".to_vec(),
        };
        let s2 = format_shell_output(&with_err);
        assert!(s2.contains("[stderr]"));
        assert!(s2.contains("boom"));

        let empty = std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        assert!(format_shell_output(&empty).contains("(no output)"));
    }

    #[test]
    fn unified_diff_marks_added_and_removed_lines() {
        let d = unified_diff("a\nb\n", "a\nc\n");
        assert!(d.contains("-b"));
        assert!(d.contains("+c"));
    }

    #[test]
    fn summarize_prefers_path_command_pattern_then_falls_back_to_name() {
        let ctx = ToolCtx::new(base());
        assert_eq!(
            FsRead.summarize(&json!({ "path": "src/x.rs" }), &ctx),
            "src/x.rs"
        );
        assert_eq!(Shell.summarize(&json!({ "command": "ls" }), &ctx), "ls");
        assert_eq!(
            GrepTool.summarize(&json!({ "pattern": "foo" }), &ctx),
            "foo"
        );
        assert_eq!(FsRead.summarize(&json!({}), &ctx), "read_file"); // no recognized key → tool name
    }

    /// The tool names a registry advertises to the model, in order — read off
    /// the same `specs()` the agent loop sends, so the test sees exactly what
    /// the model would.
    fn spec_names(reg: &Registry) -> Vec<String> {
        reg.specs()
            .iter()
            .map(|s| s["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn default_registry_exposes_the_standard_tool_set_in_order() {
        assert_eq!(
            spec_names(&default_registry()),
            [
                "read_file",
                "list_directory",
                "find_files",
                "search_text",
                "write_file",
                "edit_file",
                "run_command",
                "delegate_task"
            ]
        );
    }

    #[test]
    fn every_default_tool_has_the_reviewed_permission_classification() {
        let registry = default_registry();
        let actual: Vec<(&str, Option<PermissionRisk>)> = registry
            .tools
            .iter()
            .map(|tool| (tool.name(), tool.permission_risk()))
            .collect();
        assert_eq!(
            actual,
            [
                (tool_names::READ_FILE, None),
                (tool_names::LIST_DIRECTORY, None),
                (tool_names::FIND_FILES, None),
                (tool_names::SEARCH_TEXT, None),
                (tool_names::WRITE_FILE, Some(PermissionRisk::Configurable)),
                (tool_names::EDIT_FILE, Some(PermissionRisk::Configurable)),
                (tool_names::RUN_COMMAND, Some(PermissionRisk::Shell)),
                (tool_names::DELEGATE_TASK, None),
            ]
        );
    }

    #[test]
    fn legacy_names_dispatch_to_their_canonical_tools_without_being_advertised() {
        let registry = default_registry();
        let advertised = spec_names(&registry);

        for (legacy, canonical) in tool_names::LEGACY_ALIASES {
            let resolved = registry
                .find(legacy)
                .unwrap_or_else(|| panic!("legacy alias {legacy} must still resolve"));
            assert_eq!(resolved.name(), canonical);
            assert!(registry.find(canonical).is_some());
            assert!(
                !advertised.iter().any(|name| name == legacy),
                "legacy alias {legacy} leaked into the model-facing specs"
            );
        }
    }

    #[tokio::test]
    async fn legacy_alias_dispatch_executes_the_canonical_implementation() {
        let workspace = unique_temp_dir("legacy_alias_dispatch");
        std::fs::write(workspace.join("hello.txt"), "hello from the alias").unwrap();
        let ctx = ToolCtx::new(workspace.clone());
        let registry = default_registry();

        let output = registry
            .find("fs_read")
            .expect("the legacy read alias resolves")
            .run(json!({ "path": "hello.txt" }), &ctx)
            .await
            .expect("the resolved canonical tool runs");

        assert_eq!(output, "hello from the alias");
        std::fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn subagent_registry_includes_task_only_when_it_may_spawn() {
        // A subagent under the nesting cap gets the full set + `task` so it can fan
        // out further; a leaf subagent (at the cap) is never even offered `task`.
        assert_eq!(
            spec_names(&subagent_registry(true)),
            [
                "read_file",
                "list_directory",
                "find_files",
                "search_text",
                "write_file",
                "edit_file",
                "run_command",
                "delegate_task"
            ]
        );
        let leaf = subagent_registry(false);
        assert_eq!(
            spec_names(&leaf),
            [
                "read_file",
                "list_directory",
                "find_files",
                "search_text",
                "write_file",
                "edit_file",
                "run_command"
            ]
        );
        assert!(
            leaf.find("task").is_none(),
            "a leaf subagent must not resolve the task tool"
        );
    }

    #[test]
    fn tool_ctx_new_has_no_spawner() {
        // The no-subagent default (tests, read-only runs): `task` has nothing to
        // call, so it must fail closed rather than panic.
        let ctx = ToolCtx::new(base());
        assert!(ctx.spawner.is_none());
    }

    #[tokio::test]
    async fn task_tool_without_a_spawner_fails_closed() {
        // `task` is in a registry but the run attached no spawner (e.g. nested too
        // deep): it must return a clear error, never panic or silently no-op.
        let ctx = ToolCtx::new(base());
        let err = Task
            .run(
                json!({ "description": "x", "prompt": "do the thing" }),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(err.contains("not available"), "got: {err}");
        // `task` is never gated: the subagent's own tools carry the permission.
        assert_eq!(Task.permission_risk(), None);
    }

    #[tokio::test]
    async fn task_tool_forwards_the_spec_and_returns_the_subagent_answer() {
        use std::sync::Mutex;
        // A stand-in spawner records the spec it was handed and returns a canned
        // answer, proving the tool wires `description`/`prompt` through and surfaces
        // the subagent's result verbatim as the tool output.
        struct RecordingSpawner {
            seen: Arc<Mutex<Option<SubagentSpec>>>,
        }
        #[async_trait]
        impl Spawner for RecordingSpawner {
            async fn spawn(&self, spec: SubagentSpec) -> Result<String, String> {
                *self.seen.lock().unwrap() = Some(spec.clone());
                Ok(format!("did: {}", spec.description))
            }
        }
        let seen = Arc::new(Mutex::new(None));
        let ctx = ToolCtx {
            workspace: base(),
            cancel: None,
            receipt: None,
            spawner: Some(Arc::new(RecordingSpawner { seen: seen.clone() })),
            background: None,
        };
        let out = Task
            .run(
                json!({ "description": "audit deps", "prompt": "find vulnerable crates" }),
                &ctx,
            )
            .await
            .unwrap();
        assert_eq!(out, "did: audit deps");
        let spec = seen.lock().unwrap().clone().expect("spawner was invoked");
        assert_eq!(spec.description, "audit deps");
        assert_eq!(spec.prompt, "find vulnerable crates");
    }

    #[tokio::test]
    async fn task_tool_absent_description_produces_empty_spec_description() {
        use std::sync::Mutex;
        // When the model omits `description`, the tool must forward an EMPTY string
        // (not the old "subagent" literal) to the spawner. The real label derivation
        // now happens centrally in `AgentSpawner::spawn` via `subagent_label`, so
        // forwarding an empty string keeps the wire format clean and lets the spawn
        // site derive a meaningful label from the prompt.
        struct RecordingSpawner {
            seen: Arc<Mutex<Option<SubagentSpec>>>,
        }
        #[async_trait]
        impl Spawner for RecordingSpawner {
            async fn spawn(&self, spec: SubagentSpec) -> Result<String, String> {
                *self.seen.lock().unwrap() = Some(spec.clone());
                Ok("ok".to_string())
            }
        }
        let seen = Arc::new(Mutex::new(None));
        let ctx = ToolCtx {
            workspace: base(),
            cancel: None,
            receipt: None,
            spawner: Some(Arc::new(RecordingSpawner { seen: seen.clone() })),
            background: None,
        };
        // No "description" key at all.
        Task.run(
            json!({ "prompt": "analyse all open PRs for merge conflicts" }),
            &ctx,
        )
        .await
        .unwrap();
        let spec = seen.lock().unwrap().clone().expect("spawner was invoked");
        assert_eq!(
            spec.description, "",
            "absent description must arrive at the spawner as an empty string, \
             not the old \"subagent\" placeholder"
        );
        assert_eq!(spec.prompt, "analyse all open PRs for merge conflicts");
    }

    #[test]
    fn read_only_registry_omits_every_mutating_tool() {
        // Plan mode's tool set: the read-only tools only — no fs_write/fs_edit/shell.
        let reg = read_only_registry();
        assert_eq!(
            spec_names(&reg),
            ["read_file", "list_directory", "find_files", "search_text"]
        );
        for mutating in [
            "write_file",
            "edit_file",
            "run_command",
            "fs_write",
            "fs_edit",
            "shell",
        ] {
            assert!(
                reg.find(mutating).is_none(),
                "{mutating} must not be in the read-only registry"
            );
        }
    }

    #[test]
    fn registry_new_builds_a_custom_restricted_tool_set() {
        // The shape a constrained subagent / plan mode would use: a read-only
        // registry that exposes only the non-mutating tools and omits the
        // mutating ones entirely. The agent loop never changes — only the set
        // of tools it is handed does.
        let reg = Registry::new(vec![Box::new(FsRead), Box::new(ListDir)]);
        assert_eq!(spec_names(&reg), ["read_file", "list_directory"]);
        assert!(reg.find("fs_read").is_some());
        assert!(
            reg.find("fs_write").is_none(),
            "a restricted registry must not resolve a tool it doesn't contain"
        );
    }
}
