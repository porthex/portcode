//! Tool system. Each tool declares a JSON schema (sent to the model) and an
//! async `run`. Tools flagged `mutating()` route through the permission gate
//! before executing; read-only tools run immediately.

use async_trait::async_trait;
use serde_json::{json, Value};
use similar::TextDiff;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

pub struct ToolCtx {
    pub workspace: PathBuf,
    /// Launches subagents for the [`Task`] tool. `None` when this run can't spawn
    /// (plan mode, or a subagent already at the nesting cap) — in which case `task`
    /// isn't in the registry at all, so this is the runtime backstop rather than
    /// the primary guard. Implemented by the agent runtime so tools never depend on
    /// the agent loop internals; they only know this trait.
    pub spawner: Option<Arc<dyn Spawner>>,
    /// Adopts a `shell` command launched in the background (`shell` with
    /// `background: true`). `None` when this run can't background — the tool then
    /// reports that background mode is unavailable rather than blocking.
    pub background: Option<Arc<dyn BackgroundRunner>>,
}

impl ToolCtx {
    /// A context with no spawner / background runner — read-only runs and the
    /// default in tests. The interactive run attaches them via field assignment.
    pub fn new(workspace: PathBuf) -> Self {
        Self {
            workspace,
            spawner: None,
            background: None,
        }
    }
}

/// What the `shell` tool needs to launch a long-running command in the background,
/// without knowing how a run is wired. Implemented by `agent::BackgroundLauncher`,
/// which owns the process lifecycle: it waits for the child off-thread, reports
/// start/finish via stream events, and lets a session Stop kill it. The tool
/// builds and spawns the child; the runner ADOPTS it.
pub trait BackgroundRunner: Send + Sync {
    /// Adopt an already-spawned background process, returning a short task id. The
    /// runner waits for the child elsewhere and announces completion itself.
    fn launch(&self, command: String, child: tokio::process::Child) -> String;
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

    /// Mutating tools (write / edit / shell) go through the permission gate.
    fn mutating(&self) -> bool {
        false
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
    /// can't be diffed (e.g. shell). A file tool computes the proposed new
    /// content WITHOUT writing it, so the diff shown is exactly what `run` would
    /// apply (they share the same logic — see `compute_edit`).
    async fn preview(&self, _input: &Value, _ctx: &ToolCtx) -> Option<String> {
        None
    }

    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String>;
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
                    "name": t.name(),
                    "description": t.description(),
                    "input_schema": t.input_schema(),
                })
            })
            .collect()
    }

    pub fn find(&self, name: &str) -> Option<&dyn Tool> {
        self.tools
            .iter()
            .find(|t| t.name() == name)
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

/// The tool set handed to a subagent: the full interactive set, plus the `task`
/// tool only when the subagent may still spawn its own children (`can_spawn`).
/// At the maximum nesting depth `can_spawn` is false, so a leaf subagent is never
/// even offered `task` — the depth cap is enforced by omission here, with the
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

/// The read-only subset of the default registry — no `fs_write`/`fs_edit`/`shell`.
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
    // An empty `old_string` is degenerate: `str::matches("")` yields a match at
    // every char boundary, so with `replace_all` it would splice `new` between
    // every character and effectively rewrite the whole file. Reject it up front.
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
        "fs_read"
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
        "list"
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
        "glob"
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
        .map_err(|e| format!("glob task failed: {e}"))?
    }
}

struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &'static str {
        "grep"
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
        .map_err(|e| format!("grep task failed: {e}"))?
    }
}

// ── mutating tools ───────────────────────────────────────────────────────────

struct FsWrite;

#[async_trait]
impl Tool for FsWrite {
    fn name(&self) -> &'static str {
        "fs_write"
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
        let base = base_dir(ctx).ok()?;
        let p = str_arg(input, "path").ok()?;
        let content = str_arg(input, "content").ok()?;
        let full = resolve_for_write(&base, p).ok()?;
        let old = if full.exists() {
            // If the target exists but can't be read (binary / non-UTF-8 / locked),
            // return None rather than diffing against "" — an empty `old` would make
            // an unreadable OVERWRITE look like a brand-new file in the prompt, hiding
            // that real content is being destroyed. No preview ⇒ the gate falls back
            // to the one-line summary, which is honest.
            tokio::fs::read_to_string(&full).await.ok()?
        } else {
            String::new()
        };
        Some(unified_diff(&old, content))
    }
    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String> {
        let base = base_dir(ctx)?;
        let p = str_arg(&input, "path")?;
        let content = str_arg(&input, "content")?;
        let full = resolve_for_write(&base, p)?;
        let existed = full.exists();
        let old = if existed {
            tokio::fs::read_to_string(&full).await.unwrap_or_default()
        } else {
            String::new()
        };
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("failed to create dirs for '{p}': {e}"))?;
        }
        tokio::fs::write(&full, content)
            .await
            .map_err(|e| format!("failed to write '{p}': {e}"))?;
        if existed && old != content {
            Ok(format!(
                "Updated {p} ({} bytes)\n\n{}",
                content.len(),
                truncate_chars(unified_diff(&old, content), 8000)
            ))
        } else {
            Ok(format!("Created {p} ({} bytes)", content.len()))
        }
    }
}

struct FsEdit;

#[async_trait]
impl Tool for FsEdit {
    fn name(&self) -> &'static str {
        "fs_edit"
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
    fn mutating(&self) -> bool {
        true
    }
    /// Preview the edit as a diff without writing — exactly the change `run`
    /// would apply (both go through `compute_edit`). Returns `None` if anything
    /// the gate would surface as an error anyway (bad args, file missing,
    /// string not found) so the prompt falls back to the one-line summary.
    async fn preview(&self, input: &Value, ctx: &ToolCtx) -> Option<String> {
        let base = base_dir(ctx).ok()?;
        let p = str_arg(input, "path").ok()?;
        let old = str_arg(input, "old_string").ok()?;
        let new = str_arg(input, "new_string").ok()?;
        let replace_all = input
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let full = resolve_existing(&base, p).ok()?;
        let content = tokio::fs::read_to_string(&full).await.ok()?;
        let (updated, _) = compute_edit(&content, old, new, replace_all, p).ok()?;
        Some(unified_diff(&content, &updated))
    }
    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String> {
        let base = base_dir(ctx)?;
        let p = str_arg(&input, "path")?;
        let old = str_arg(&input, "old_string")?;
        let new = str_arg(&input, "new_string")?;
        let replace_all = input
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let full = resolve_existing(&base, p)?;
        let content = tokio::fs::read_to_string(&full)
            .await
            .map_err(|e| format!("failed to read '{p}': {e}"))?;

        let (updated, count) = compute_edit(&content, old, new, replace_all, p)?;
        tokio::fs::write(&full, &updated)
            .await
            .map_err(|e| format!("failed to write '{p}': {e}"))?;
        Ok(format!(
            "Edited {p} ({count} replacement(s))\n\n{}",
            truncate_chars(unified_diff(&content, &updated), 8000)
        ))
    }
}

struct Shell;

/// Resolve a requested shell to its executable and the leading args that make it
/// run a single command string. PowerShell variants run non-interactively and
/// skip the user profile so output is predictable and they never hang on a prompt.
fn shell_invocation(shell: &str) -> Result<(&'static str, &'static [&'static str]), String> {
    match shell {
        "powershell" => Ok(("powershell", &["-NoProfile", "-NonInteractive", "-Command"])),
        "pwsh" => Ok(("pwsh", &["-NoProfile", "-NonInteractive", "-Command"])),
        "cmd" => Ok(("cmd", &["/C"])),
        other => Err(format!(
            "unknown shell '{other}'; expected one of: powershell, pwsh, cmd"
        )),
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
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(leading_args)
        .arg(command)
        .current_dir(workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Windows: stop a console window from flashing open every time the agent runs a
    // shell command. Spawning a console-subsystem exe (powershell/pwsh/cmd) from the
    // GUI app otherwise allocates a new console; CREATE_NO_WINDOW suppresses it.
    // `creation_flags` is tokio's own inherent (safe) method — no trait import — so
    // this respects `unsafe_code = "deny"` and the cfg-gate compiles to nothing on
    // Linux CI.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

/// Format a finished process's combined stdout/stderr and exit code into the
/// agent-facing result string. Shared by the foreground run and the background
/// waiter so both report identically.
pub(crate) fn format_shell_output(out: &std::process::Output) -> String {
    let mut buf = String::new();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stdout.trim().is_empty() {
        buf.push_str(&stdout);
    }
    if !stderr.trim().is_empty() {
        if !buf.is_empty() {
            buf.push('\n');
        }
        buf.push_str("[stderr]\n");
        buf.push_str(&stderr);
    }
    let code = out.status.code().unwrap_or(-1);
    if buf.trim().is_empty() {
        buf = "(no output)".into();
    }
    format!("{}\n\n[exit code {code}]", truncate_chars(buf, 100_000))
}

#[async_trait]
impl Tool for Shell {
    fn name(&self) -> &'static str {
        "shell"
    }
    fn description(&self) -> &'static str {
        "Run a shell command in the workspace. Defaults to PowerShell (Windows PowerShell 5.1, \
         powershell.exe); set `shell` to \"pwsh\" for PowerShell 7+ or \"cmd\" for the legacy \
         Windows command prompt. PowerShell and cmd differ in quoting, path, and exit-code \
         semantics, so write the command for the shell you select. Returns combined stdout/stderr \
         and the exit code. Set `background: true` for a long-running command (server, build, \
         watcher): it returns immediately with a task id and reports its result when it finishes, \
         instead of blocking."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Command line to execute." },
                "shell": {
                    "type": "string",
                    "enum": ["powershell", "pwsh", "cmd"],
                    "description": "Shell to run the command in. \"powershell\" = Windows PowerShell 5.1 (default), \"pwsh\" = PowerShell 7+, \"cmd\" = legacy command prompt."
                },
                "background": {
                    "type": "boolean",
                    "description": "Run in the background: return immediately with a task id and report the result when the command finishes, rather than blocking (use for servers/builds/watchers). Default false."
                }
            },
            "required": ["command"]
        })
    }
    fn mutating(&self) -> bool {
        true
    }
    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String> {
        let command = str_arg(&input, "command")?;
        let shell = input
            .get("shell")
            .and_then(|v| v.as_str())
            .unwrap_or("powershell");
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
        let child = cmd
            .spawn()
            .map_err(|e| format!("failed to start {shell}: {e}"))?;

        if let Some(runner) = runner {
            // Hand the live child to the runner; it waits and reports completion.
            let id = runner.launch(command.to_string(), child);
            return Ok(format!(
                "Started background task {id}: {command}\nIt runs without blocking; \
                 its result is reported when it finishes."
            ));
        }

        let out = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output())
            .await
            .map_err(|_| "command timed out after 120s".to_string())?
            .map_err(|e| format!("command failed: {e}"))?;
        Ok(format_shell_output(&out))
    }
}

/// Launch an autonomous subagent. The subagent gets its own tools and a fresh
/// context, works through the task on its own, and returns a single final summary
/// — its only output to the launching agent. The launch itself is NOT gated
/// (`mutating()` stays false): every mutating tool the subagent runs still goes
/// through the permission gate, so nothing it does escapes the user's control.
struct Task;

#[async_trait]
impl Tool for Task {
    fn name(&self) -> &'static str {
        "task"
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
    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String> {
        let prompt = str_arg(&input, "prompt")?.to_string();
        let description = input
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("subagent")
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

    #[test]
    fn compute_edit_handles_single_all_and_error_cases() {
        let (out, n) = compute_edit("a b", "a", "X", false, "f").unwrap();
        assert_eq!((out.as_str(), n), ("X b", 1));
        let (out, n) = compute_edit("a a", "a", "X", true, "f").unwrap();
        assert_eq!((out.as_str(), n), ("X X", 2));
        assert!(compute_edit("abc", "z", "X", false, "f").is_err()); // not found
        assert!(compute_edit("a a", "a", "X", false, "f").is_err()); // ambiguous

        // An empty `old_string` is rejected before any matching/replacing, so
        // `replace_all` can't splice `new` between every char and rewrite the file.
        let err = compute_edit("abc", "", "X", true, "f").unwrap_err();
        assert!(err.contains("must not be empty"), "got: {err}");
        // The file content must be reported untouched (no replacement happened).
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
        // An EXISTING target that can't be read as UTF-8 (here: raw non-UTF-8 bytes)
        // must NOT preview a diff against "" — that would make a destructive overwrite
        // look like a new-file create. preview() returns None so the gate falls back
        // to the honest one-line summary.
        let workspace = unique_temp_dir("preview_unreadable");
        let ctx = ToolCtx::new(workspace.clone());
        let file = workspace.join("blob.bin");
        // Invalid UTF-8 (a lone 0xFF byte) — read_to_string fails on this.
        std::fs::write(&file, [0xFF, 0xFE, 0x00, 0x80]).unwrap();

        let preview = FsWrite
            .preview(&json!({ "path": "blob.bin", "content": "new text" }), &ctx)
            .await;
        assert!(
            preview.is_none(),
            "an unreadable existing file must not diff against empty: {preview:?}"
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

    #[test]
    fn shell_invocation_maps_known_shells_and_rejects_unknown() {
        let (prog, args) = shell_invocation("powershell").unwrap();
        assert_eq!(prog, "powershell");
        assert!(args.contains(&"-NonInteractive"));
        assert_eq!(shell_invocation("pwsh").unwrap().0, "pwsh");
        let (cprog, cargs) = shell_invocation("cmd").unwrap();
        assert_eq!(cprog, "cmd");
        assert_eq!(cargs.len(), 1);
        assert_eq!(cargs[0], "/C");
        assert!(shell_invocation("bash")
            .unwrap_err()
            .contains("unknown shell"));
    }

    #[test]
    fn build_shell_command_rejects_an_unknown_shell_and_accepts_known_ones() {
        // Propagates the shell_invocation error (no process is spawned here).
        assert!(build_shell_command("echo hi", "bash", Path::new(".")).is_err());
        assert!(build_shell_command("echo hi", "cmd", Path::new(".")).is_ok());
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
        assert_eq!(FsRead.summarize(&json!({}), &ctx), "fs_read"); // no recognized key → tool name
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
            ["fs_read", "list", "glob", "grep", "fs_write", "fs_edit", "shell", "task"]
        );
    }

    #[test]
    fn subagent_registry_includes_task_only_when_it_may_spawn() {
        // A subagent under the nesting cap gets the full set + `task` so it can fan
        // out further; a leaf subagent (at the cap) is never even offered `task`.
        assert_eq!(
            spec_names(&subagent_registry(true)),
            ["fs_read", "list", "glob", "grep", "fs_write", "fs_edit", "shell", "task"]
        );
        let leaf = subagent_registry(false);
        assert_eq!(
            spec_names(&leaf),
            ["fs_read", "list", "glob", "grep", "fs_write", "fs_edit", "shell"]
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
        assert!(!Task.mutating());
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

    #[test]
    fn read_only_registry_omits_every_mutating_tool() {
        // Plan mode's tool set: the read-only tools only — no fs_write/fs_edit/shell.
        let reg = read_only_registry();
        assert_eq!(spec_names(&reg), ["fs_read", "list", "glob", "grep"]);
        for mutating in ["fs_write", "fs_edit", "shell"] {
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
        assert_eq!(spec_names(&reg), ["fs_read", "list"]);
        assert!(reg.find("fs_read").is_some());
        assert!(
            reg.find("fs_write").is_none(),
            "a restricted registry must not resolve a tool it doesn't contain"
        );
    }
}
