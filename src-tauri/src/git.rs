#![cfg(desktop)]

use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Missing,
    Timeout,
    Failed,
}

pub struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
}

/// Run Git without a shell, rooted at the native workspace, while draining both
/// output pipes into bounded buffers. Draining after the cap matters: stopping a
/// read at the cap can fill the child pipe and deadlock `wait()` on a large diff.
pub async fn run<S: AsRef<OsStr>>(
    workspace: &Path,
    args: &[S],
    duration: Duration,
    max_stdout: usize,
) -> Result<Output, Failure> {
    let mut command = git_command(workspace, args);
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command.spawn().map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            Failure::Missing
        } else {
            Failure::Failed
        }
    })?;
    let stdout = child.stdout.take().ok_or(Failure::Failed)?;
    let stderr = child.stderr.take().ok_or(Failure::Failed)?;

    let result = timeout(duration, async {
        let (status, stdout, stderr) = tokio::join!(
            child.wait(),
            read_bounded(stdout, max_stdout),
            read_bounded(stderr, 64 * 1024),
        );
        let status = status.map_err(|_| Failure::Failed)?;
        let (stdout, stdout_truncated) = stdout.map_err(|_| Failure::Failed)?;
        let (stderr, stderr_truncated) = stderr.map_err(|_| Failure::Failed)?;
        Ok::<Output, Failure>(Output {
            status,
            stdout,
            stderr,
            truncated: stdout_truncated || stderr_truncated,
        })
    })
    .await;

    match result {
        Ok(output) => output,
        Err(_) => {
            let _ = child.kill().await;
            Err(Failure::Timeout)
        }
    }
}

/// Construct every Git process with repository fsmonitor integration disabled.
/// A configured fsmonitor hook can launch another process even for read-only
/// commands, so override it process-locally before the subcommand is parsed.
fn git_command<S: AsRef<OsStr>>(workspace: &Path, args: &[S]) -> Command {
    let args = hardened_args(args);
    let mut command = Command::new("git");
    command
        .arg("--no-pager")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .args(args)
        .current_dir(workspace);
    command
}

/// Keep repository-configured diff drivers and text conversion from spawning
/// arbitrary helper processes. Callers still spell these flags explicitly, but
/// enforcing them here protects every current and future use of the shared Git
/// runner. Moving existing flags also makes their precedence unambiguous.
fn hardened_args<S: AsRef<OsStr>>(args: &[S]) -> Vec<&OsStr> {
    let mut supplied = args.iter().map(AsRef::as_ref);
    let Some(subcommand) = supplied.next() else {
        return Vec::new();
    };
    if subcommand != OsStr::new("diff") {
        return args.iter().map(AsRef::as_ref).collect();
    }

    let mut hardened = Vec::with_capacity(args.len().saturating_add(2));
    hardened.push(subcommand);
    hardened.push(OsStr::new("--no-ext-diff"));
    hardened.push(OsStr::new("--no-textconv"));
    hardened.extend(
        supplied.filter(|arg| {
            *arg != OsStr::new("--no-ext-diff") && *arg != OsStr::new("--no-textconv")
        }),
    );
    hardened
}

async fn read_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    max: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::with_capacity(max.min(64 * 1024));
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];

    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let remaining = max.saturating_sub(output.len());
        let keep = remaining.min(read);
        output.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
    }

    Ok((output, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bounded_reader_keeps_the_prefix_and_reports_truncation() {
        let input = &b"abcdefgh"[..];
        let (output, truncated) = read_bounded(input, 5).await.unwrap();
        assert_eq!(output, b"abcde");
        assert!(truncated);
    }

    #[tokio::test]
    async fn bounded_reader_accepts_output_below_the_cap() {
        let input = &b"abc"[..];
        let (output, truncated) = read_bounded(input, 5).await.unwrap();
        assert_eq!(output, b"abc");
        assert!(!truncated);
    }

    #[test]
    fn hardens_diff_before_numstat_without_duplicate_flags() {
        let args = [
            "diff",
            "--numstat",
            "--no-textconv",
            "HEAD",
            "--no-ext-diff",
            "--",
        ];
        assert_eq!(
            hardened_args(&args),
            [
                OsStr::new("diff"),
                OsStr::new("--no-ext-diff"),
                OsStr::new("--no-textconv"),
                OsStr::new("--numstat"),
                OsStr::new("HEAD"),
                OsStr::new("--"),
            ]
        );
    }

    #[test]
    fn leaves_non_diff_arguments_unchanged() {
        let args = ["status", "--porcelain=v2", "--branch"];
        assert_eq!(
            hardened_args(&args),
            [
                OsStr::new("status"),
                OsStr::new("--porcelain=v2"),
                OsStr::new("--branch"),
            ]
        );
    }

    #[test]
    fn disables_fsmonitor_before_every_git_subcommand() {
        let command = git_command(Path::new("repo"), &["status", "--porcelain=v2"]);
        assert_eq!(
            command.as_std().get_args().collect::<Vec<_>>(),
            [
                OsStr::new("--no-pager"),
                OsStr::new("-c"),
                OsStr::new("core.fsmonitor=false"),
                OsStr::new("status"),
                OsStr::new("--porcelain=v2"),
            ]
        );
    }
}
