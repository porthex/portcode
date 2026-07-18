#![cfg(desktop)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::{git, AppState};

const GIT_TIMEOUT: Duration = Duration::from_secs(2);
const SUMMARY_OUTPUT_CAP: usize = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    path: String,
    configured: bool,
    git: GitSummary,
}
#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum GitSummary {
    Repository {
        branch: Option<String>,
        detached_head: Option<String>,
        upstream: Option<String>,
        ahead: u64,
        behind: u64,
        changed_files: u64,
        untracked_files: u64,
        additions: u64,
        deletions: u64,
    },
    NotRepository,
    Unavailable {
        reason: GitUnavailableReason,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum GitUnavailableReason {
    Missing,
    Timeout,
    Failed,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct StatusFacts {
    oid: Option<String>,
    branch: Option<String>,
    detached_head: Option<String>,
    upstream: Option<String>,
    ahead: u64,
    behind: u64,
    changed_files: u64,
    untracked_files: u64,
}

#[derive(Clone, Copy)]
enum NumstatScope {
    Head,
    Cached,
    Unstaged,
}

/// Return facts for the same configured workspace (or current-dir fallback)
/// that native agent turns use. The frontend supplies no path, so this command
/// cannot be repurposed as an arbitrary filesystem probe.
#[tauri::command]
pub async fn get_workspace_summary(state: State<'_, AppState>) -> Result<WorkspaceSummary, String> {
    let configured_path = state.settings.lock().unwrap().workspace.clone();
    let configured = configured_path.is_some();
    let path = configured_path
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let git = inspect_git(&path).await;

    Ok(WorkspaceSummary {
        path: path.to_string_lossy().into_owned(),
        configured,
        git,
    })
}

async fn inspect_git(workspace: &Path) -> GitSummary {
    if !workspace.is_dir() {
        return GitSummary::Unavailable {
            reason: GitUnavailableReason::Failed,
        };
    }

    let status = match run_git(
        workspace,
        [
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    )
    .await
    {
        Ok(output) if output.status.success() => output,
        Ok(output) if is_not_repository(&output.stderr) => return GitSummary::NotRepository,
        Ok(_) => {
            return GitSummary::Unavailable {
                reason: GitUnavailableReason::Failed,
            }
        }
        Err(failure) => return unavailable(failure),
    };

    let facts = parse_status(&status.stdout);
    let (additions, deletions) = if facts.oid.as_deref() == Some("(initial)") {
        let cached = successful_numstat(workspace, NumstatScope::Cached).await;
        let unstaged = successful_numstat(workspace, NumstatScope::Unstaged).await;
        (
            cached.0.saturating_add(unstaged.0),
            cached.1.saturating_add(unstaged.1),
        )
    } else {
        successful_numstat(workspace, NumstatScope::Head).await
    };

    GitSummary::Repository {
        branch: facts.branch,
        detached_head: facts.detached_head,
        upstream: facts.upstream,
        ahead: facts.ahead,
        behind: facts.behind,
        changed_files: facts.changed_files,
        untracked_files: facts.untracked_files,
        additions,
        deletions,
    }
}

async fn successful_numstat(workspace: &Path, scope: NumstatScope) -> (u64, u64) {
    match run_git(workspace, numstat_args(scope)).await {
        Ok(output) if output.status.success() => parse_numstat(&output.stdout),
        _ => (0, 0),
    }
}

fn numstat_args(scope: NumstatScope) -> &'static [&'static str] {
    const HEAD: &[&str] = &[
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "HEAD",
        "--",
    ];
    const CACHED: &[&str] = &[
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "--cached",
        "--",
    ];
    const UNSTAGED: &[&str] = &["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--"];

    match scope {
        NumstatScope::Head => HEAD,
        NumstatScope::Cached => CACHED,
        NumstatScope::Unstaged => UNSTAGED,
    }
}

async fn run_git(workspace: &Path, args: &[&str]) -> Result<git::Output, git::Failure> {
    git::run(workspace, args, GIT_TIMEOUT, SUMMARY_OUTPUT_CAP).await
}

fn unavailable(failure: git::Failure) -> GitSummary {
    let reason = match failure {
        git::Failure::Missing => GitUnavailableReason::Missing,
        git::Failure::Timeout => GitUnavailableReason::Timeout,
        git::Failure::Failed => GitUnavailableReason::Failed,
    };
    GitSummary::Unavailable { reason }
}

fn is_not_repository(stderr: &[u8]) -> bool {
    String::from_utf8_lossy(stderr)
        .to_ascii_lowercase()
        .contains("not a git repository")
}

fn parse_status(output: &[u8]) -> StatusFacts {
    let mut facts = StatusFacts::default();

    for field in output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
    {
        if field.starts_with(b"# branch.oid ") {
            facts.oid = Some(String::from_utf8_lossy(&field[13..]).into_owned());
        } else if field.starts_with(b"# branch.head ") {
            let head = String::from_utf8_lossy(&field[14..]).into_owned();
            if head == "(detached)" {
                facts.detached_head = facts
                    .oid
                    .as_deref()
                    .filter(|oid| *oid != "(initial)")
                    .map(|oid| oid.chars().take(8).collect());
            } else {
                facts.branch = Some(head);
            }
        } else if field.starts_with(b"# branch.upstream ") {
            facts.upstream = Some(String::from_utf8_lossy(&field[18..]).into_owned());
        } else if field.starts_with(b"# branch.ab ") {
            let counts = String::from_utf8_lossy(&field[12..]);
            for count in counts.split_whitespace() {
                if let Some(ahead) = count.strip_prefix('+') {
                    facts.ahead = ahead.parse().unwrap_or(0);
                } else if let Some(behind) = count.strip_prefix('-') {
                    facts.behind = behind.parse().unwrap_or(0);
                }
            }
        } else if matches!(field, [b'1' | b'2' | b'u' | b'?', b' ', ..]) {
            facts.changed_files = facts.changed_files.saturating_add(1);
            if field[0] == b'?' {
                facts.untracked_files = facts.untracked_files.saturating_add(1);
            }
        }
    }

    facts
}

fn parse_numstat(output: &[u8]) -> (u64, u64) {
    let mut additions = 0_u64;
    let mut deletions = 0_u64;

    for line in output.split(|byte| *byte == b'\n') {
        let mut fields = line.splitn(3, |byte| *byte == b'\t');
        let added = fields.next().and_then(parse_count).unwrap_or(0);
        let deleted = fields.next().and_then(parse_count).unwrap_or(0);
        additions = additions.saturating_add(added);
        deletions = deletions.saturating_add(deleted);
    }
    (additions, deletions)
}

fn parse_count(field: &[u8]) -> Option<u64> {
    if field == b"-" {
        return Some(0);
    }
    std::str::from_utf8(field).ok()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2_branch_and_change_records() {
        let output = b"# branch.oid 0123456789abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +3 -2\01 .M details file.rs\02 R. details new.rs\0old.rs\0u UU details merge.rs\0? new.txt\0! ignored.txt\0";
        let facts = parse_status(output);

        assert_eq!(facts.branch.as_deref(), Some("main"));
        assert_eq!(facts.upstream.as_deref(), Some("origin/main"));
        assert_eq!(facts.ahead, 3);
        assert_eq!(facts.behind, 2);
        assert_eq!(facts.changed_files, 4);
        assert_eq!(facts.untracked_files, 1);
    }

    #[test]
    fn reports_a_short_detached_head_and_initial_branch() {
        let detached = parse_status(
            b"# branch.oid 0123456789abcdef\0# branch.head (detached)\0# branch.ab +0 -0\0",
        );
        assert_eq!(detached.detached_head.as_deref(), Some("01234567"));
        assert_eq!(detached.branch, None);

        let initial = parse_status(b"# branch.oid (initial)\0# branch.head trunk\0");
        assert_eq!(initial.oid.as_deref(), Some("(initial)"));
        assert_eq!(initial.branch.as_deref(), Some("trunk"));
    }

    #[test]
    fn sums_numstat_and_treats_binary_markers_as_zero() {
        assert_eq!(
            parse_numstat(b"12\t4\tsrc/app.ts\n-\t-\tasset.png\n8\t0\tnew.rs\n"),
            (20, 4)
        );
    }

    #[test]
    fn distinguishes_not_repository_stderr() {
        assert!(is_not_repository(
            b"fatal: not a git repository (or any of the parent directories): .git"
        ));
        assert!(!is_not_repository(b"fatal: detected dubious ownership"));
    }

    #[test]
    fn constructs_hardened_numstat_arguments_for_every_scope() {
        assert_eq!(
            numstat_args(NumstatScope::Head),
            [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--numstat",
                "HEAD",
                "--",
            ]
        );
        assert_eq!(
            numstat_args(NumstatScope::Cached),
            [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--numstat",
                "--cached",
                "--",
            ]
        );
        assert_eq!(
            numstat_args(NumstatScope::Unstaged),
            ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--",]
        );
    }
}
