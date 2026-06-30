//! The promotion GATE: run the test suites and report pass/fail.
//!
//! Two steps, run in order by [`promote`](super::promote): the frontend suite
//! (`pnpm test`, non-watch) then the Rust suite (`cargo test --workspace`). Each
//! runs as a child process in the workspace root; non-zero exit = `Err(last lines
//! of output)`. Both honor the shared cancel flag — a `promote_cancel` between (or
//! before) steps short-circuits without launching the next process.
//!
//! NB these shell out, so they are NOT exercised by unit tests (we never spawn
//! `pnpm`/`cargo` in tests — see the module's `tests` mod, which covers only the
//! pure helpers).

use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The cancel sentinel returned when the shared flag is set before a step starts.
/// A distinct message so the pipeline can surface "Cancelled" rather than a test
/// failure.
pub const CANCELLED: &str = "cancelled";

/// True when the shared cancel flag has been tripped (`promote_cancel`).
fn is_cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Relaxed)
}

/// Keep only the last `n` non-empty lines of `output` — the tail is where a test
/// runner prints its failure summary, and bounding it keeps the error payload
/// small for the event/DTO. Pure + unit-tested.
fn last_lines(output: &str, n: usize) -> String {
    let lines: Vec<&str> = output.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Run one gate command (`program` + `args`) in `workspace`, honoring `cancel`.
/// Returns `Ok(())` on a zero exit; on a non-zero exit, the last lines of the
/// combined stdout/stderr; on a cancel, [`CANCELLED`]; on a spawn/wait failure, a
/// descriptive error.
///
/// We capture output (piped) rather than streaming to a console — the desktop app
/// has no attached terminal — and fold the tail into the error so the UI can show
/// WHY the gate failed.
async fn run_gate_command(
    program: &str,
    args: &[&str],
    workspace: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    // Honor a cancel requested before we even launch.
    if is_cancelled(cancel) {
        return Err(CANCELLED.to_string());
    }

    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Windows: don't flash a console window when spawning the child. Mirrors the
    // `shell` tool's `CREATE_NO_WINDOW` (tokio's inherent `creation_flags`, so no
    // `unsafe` and it compiles to nothing off-Windows).
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("failed to run `{program}`: {e}"))?;

    // A cancel that landed while the suite was running still short-circuits the
    // result (the process is done, but the user asked to stop).
    if is_cancelled(cancel) {
        return Err(CANCELLED.to_string());
    }

    if out.status.success() {
        Ok(())
    } else {
        let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
        combined.push('\n');
        combined.push_str(&String::from_utf8_lossy(&out.stderr));
        let code = out.status.code().unwrap_or(-1);
        let tail = last_lines(&combined, 20);
        Err(format!("exit code {code}\n{tail}"))
    }
}

/// Run the frontend test suite: `pnpm test` (non-watch). Vitest is non-watch under
/// CI/non-TTY, and `pnpm test` maps to `vitest run` in this repo, so no extra
/// flag is needed — but we pass `--run` is unnecessary; the package script is
/// already one-shot.
pub async fn run_frontend_tests(workspace: &Path, cancel: &Arc<AtomicBool>) -> Result<(), String> {
    // `pnpm` is a `.cmd` shim on Windows; invoke it through `cmd /C` so the PATH
    // shim resolves the same way it does for a normal shell.
    #[cfg(windows)]
    let res = run_gate_command("cmd", &["/C", "pnpm", "test"], workspace, cancel).await;
    #[cfg(not(windows))]
    let res = run_gate_command("pnpm", &["test"], workspace, cancel).await;
    res
}

/// Run the Rust test suite: `cargo test --workspace`. Runs from the repo root (the
/// workspace), so the whole Cargo workspace is exercised.
pub async fn run_rust_tests(workspace: &Path, cancel: &Arc<AtomicBool>) -> Result<(), String> {
    run_gate_command("cargo", &["test", "--workspace"], workspace, cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_lines_keeps_only_the_trailing_nonempty_lines() {
        let out = "a\n\nb\nc\n\nd\n";
        // 2 last non-empty lines.
        assert_eq!(last_lines(out, 2), "c\nd");
        // Asking for more than exist returns them all.
        assert_eq!(last_lines(out, 99), "a\nb\nc\nd");
        // Empty input is empty.
        assert_eq!(last_lines("", 5), "");
    }

    #[test]
    fn is_cancelled_reflects_the_flag() {
        let flag = AtomicBool::new(false);
        assert!(!is_cancelled(&flag));
        flag.store(true, Ordering::Relaxed);
        assert!(is_cancelled(&flag));
    }

    #[tokio::test]
    async fn run_gate_command_short_circuits_when_already_cancelled() {
        // A pre-set cancel flag must return CANCELLED WITHOUT launching anything —
        // so we can pass a program name that doesn't exist and still get CANCELLED
        // (proving no spawn happened).
        let cancel = AtomicBool::new(true);
        let err = run_gate_command(
            "definitely-not-a-real-program",
            &[],
            Path::new("."),
            &cancel,
        )
        .await
        .unwrap_err();
        assert_eq!(err, CANCELLED);
    }
}
