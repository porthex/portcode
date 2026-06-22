//! Tool system. Each tool declares a JSON schema (sent to the model) and an
//! async `run`. Tools flagged `mutating()` route through the permission gate
//! before executing; read-only tools run immediately.

use async_trait::async_trait;
use serde_json::{json, Value};
use similar::TextDiff;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

pub struct ToolCtx {
    pub workspace: PathBuf,
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

    /// Short human-readable summary of a call, for the permission prompt.
    fn summarize(&self, input: &Value) -> String {
        for key in ["path", "command", "pattern"] {
            if let Some(s) = input.get(key).and_then(|v| v.as_str()) {
                return s.to_string();
            }
        }
        self.name().to_string()
    }

    async fn run(&self, input: Value, ctx: &ToolCtx) -> Result<String, String>;
}

pub struct Registry {
    tools: Vec<Box<dyn Tool>>,
}

impl Registry {
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
    Registry {
        tools: vec![
            Box::new(FsRead),
            Box::new(ListDir),
            Box::new(GlobTool),
            Box::new(GrepTool),
            Box::new(FsWrite),
            Box::new(FsEdit),
            Box::new(Shell),
        ],
    }
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

/// Lexically resolve `.`/`..` against the (canonical) base without touching the
/// filesystem, so we can validate paths that don't exist yet (for writes).
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
    Ok(out)
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
         and the exit code."
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
        let (program, leading_args) = shell_invocation(shell)?;

        let mut cmd = tokio::process::Command::new(program);
        cmd.args(leading_args)
            .arg(command)
            .current_dir(&ctx.workspace)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // Windows: stop a console window from flashing open every time the agent runs
        // a shell command. Spawning a console-subsystem exe (powershell/pwsh/cmd) from
        // the GUI app otherwise allocates a new console; CREATE_NO_WINDOW suppresses it.
        // `creation_flags` is tokio's own inherent (safe) Command method — no trait
        // import needed — so this respects `unsafe_code = "deny"` and the cfg-gate
        // compiles to nothing on Linux CI.
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("failed to start {shell}: {e}"))?;

        let out = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output())
            .await
            .map_err(|_| "command timed out after 120s".to_string())?
            .map_err(|e| format!("command failed: {e}"))?;

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
        Ok(format!(
            "{}\n\n[exit code {code}]",
            truncate_chars(buf, 100_000)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> PathBuf {
        // Absolute on Windows + Linux; `resolve_for_write` is lexical, so the dir
        // does not need to exist.
        std::env::temp_dir().join("portcode_sandbox_test_base")
    }

    #[test]
    fn resolve_for_write_accepts_paths_inside_the_workspace() {
        let b = base();
        let p = resolve_for_write(&b, "sub/file.txt").unwrap();
        assert!(p.starts_with(&b));
        assert!(p.ends_with("file.txt"));
    }

    #[test]
    fn resolve_for_write_normalizes_dot_and_dotdot_within_base() {
        let b = base();
        assert_eq!(
            resolve_for_write(&b, "a/../b/./c.txt").unwrap(),
            b.join("b").join("c.txt")
        );
    }

    #[test]
    fn resolve_for_write_rejects_a_parent_escape() {
        let b = base();
        assert!(resolve_for_write(&b, "../escape.txt")
            .unwrap_err()
            .contains("outside the workspace"));
    }

    #[test]
    fn resolve_for_write_rejects_an_absolute_path_outside_base() {
        let b = base();
        let outside = b.parent().unwrap().join("other.txt");
        assert!(resolve_for_write(&b, outside.to_str().unwrap())
            .unwrap_err()
            .contains("outside the workspace"));
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
    fn unified_diff_marks_added_and_removed_lines() {
        let d = unified_diff("a\nb\n", "a\nc\n");
        assert!(d.contains("-b"));
        assert!(d.contains("+c"));
    }

    #[test]
    fn summarize_prefers_path_command_pattern_then_falls_back_to_name() {
        assert_eq!(FsRead.summarize(&json!({ "path": "src/x.rs" })), "src/x.rs");
        assert_eq!(Shell.summarize(&json!({ "command": "ls" })), "ls");
        assert_eq!(GrepTool.summarize(&json!({ "pattern": "foo" })), "foo");
        assert_eq!(FsRead.summarize(&json!({})), "fs_read"); // no recognized key → tool name
    }
}
