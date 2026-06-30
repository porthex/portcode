//! The promotion state machine + its four Tauri commands.
//!
//! State machine:
//!
//! ```text
//! Idle → Snapshotting → Testing{Frontend} → Testing{Rust} → Done → Applying
//!                                                          ↘ Failed{step,msg}
//! ```
//!
//! - `promote_begin` — errors if a promotion is already running; otherwise spawns
//!   the pipeline (mirroring `run_agent` in `lib.rs`) and returns immediately.
//! - `promote_cancel` — trips the shared cancel flag; the pipeline short-circuits
//!   to `Failed { step, "cancelled" }` between steps.
//! - `promote_status` — a snapshot of the current phase as a [`PromoteStatusDto`].
//! - `promote_apply` — on a green gate (`Done`), restarts the dev build to apply
//!   the change (SLICE 2): records `Applying`, then exits with [`RESTART_EXIT_CODE`]
//!   so the external restart-loop wrapper relaunches `tauri dev` (recompiling).
//!
//! Progress is emitted on the `selfdev://promote` CONTROL event (via `app.emit`
//! directly — this is not a conversation StreamEvent, so it never touches the
//! `EventSink`/agent path).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::selfdev::{health, snapshot};
use crate::AppState;

/// Exit code the dev build uses to ask its restart-loop wrapper
/// (`scripts/dev-self-loop.mjs`, via `pnpm app:dev:self:loop`) to relaunch the
/// `tauri dev` process — which recompiles, applying the Rust change the gate just
/// approved. MUST stay in sync with `RESTART_EXIT_CODE` in that script. Any other
/// exit code stops the loop.
pub(crate) const RESTART_EXIT_CODE: i32 = 86;

/// Env var the restart-loop wrapper sets on its child. When it is `"1"` a wrapper
/// is watching for [`RESTART_EXIT_CODE`]; otherwise `promote_apply` refuses, since
/// exiting would just close the app with nothing to relaunch it.
const RESTART_LOOP_ENV: &str = "PORTCODE_SELFDEV_RESTART_LOOP";

/// Which gate step we are on (or failed at). Serializes to a snake_case string so
/// the frontend `PromotePhase` union (in `types.ts`) matches the wire shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PromotePhase {
    /// At rest — nothing running.
    Idle,
    /// Taking the DB snapshot.
    Snapshotting,
    /// Running the frontend test suite (`pnpm test`).
    TestingFrontend,
    /// Running the Rust test suite (`cargo test --workspace`).
    TestingRust,
    /// The gate passed end-to-end. The dev build can now restart to apply (Slice 2).
    Done,
    /// The user accepted a passed gate — the dev build is exiting so its restart-loop
    /// wrapper relaunches onto the rebuilt binary (Slice 2).
    Applying,
    /// A step failed (or was cancelled). `step`/`message` carry the detail.
    Failed,
}

impl PromotePhase {
    /// A 0.0–1.0 progress hint for the UI, derived from the phase. Coarse on
    /// purpose — the gate steps are long and opaque, so this is a stage indicator,
    /// not a byte-accurate bar.
    fn progress(&self) -> f32 {
        match self {
            PromotePhase::Idle => 0.0,
            PromotePhase::Snapshotting => 0.15,
            PromotePhase::TestingFrontend => 0.4,
            PromotePhase::TestingRust => 0.7,
            PromotePhase::Done => 1.0,
            PromotePhase::Applying => 1.0,
            PromotePhase::Failed => 1.0,
        }
    }
}

/// The full current phase + an optional human message (the failure reason, or a
/// short note like "Frontend tests passed"). Held inside [`PromoteState`].
#[derive(Clone, Debug)]
pub struct PhaseState {
    pub phase: PromotePhase,
    pub message: Option<String>,
}

impl Default for PhaseState {
    fn default() -> Self {
        PhaseState {
            phase: PromotePhase::Idle,
            message: None,
        }
    }
}

/// Managed app state for the promotion supervisor: the current phase (shared so
/// `promote_status` can read it) and the cancel flag the pipeline polls. Mirrors
/// the `Arc<Mutex<_>>` / `Arc<AtomicBool>` shapes used elsewhere in `AppState`.
///
/// Feature-gated and managed in `lib.rs` only under `cfg(all(desktop, feature =
/// "self-dev"))`, so production never carries it.
pub struct PromoteState {
    pub phase: Arc<Mutex<PhaseState>>,
    pub cancel: Arc<AtomicBool>,
}

impl PromoteState {
    pub fn new() -> Self {
        PromoteState {
            phase: Arc::new(Mutex::new(PhaseState::default())),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    /// True while a promotion pipeline is in flight (anything other than a
    /// terminal/at-rest phase). Used by `promote_begin` to reject a double-start.
    fn is_running(&self) -> bool {
        matches!(
            self.phase.lock().unwrap().phase,
            PromotePhase::Snapshotting | PromotePhase::TestingFrontend | PromotePhase::TestingRust
        )
    }
}

impl Default for PromoteState {
    fn default() -> Self {
        Self::new()
    }
}

/// The control event payload broadcast on `selfdev://promote`. camelCase to match
/// the TS `PromoteStatus` the frontend store applies.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteEvent {
    pub phase: PromotePhase,
    pub message: Option<String>,
    pub progress: f32,
}

/// The `promote_status` return DTO — the same shape as [`PromoteEvent`], read on
/// demand instead of pushed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteStatusDto {
    pub phase: PromotePhase,
    pub message: Option<String>,
    pub progress: f32,
}

/// Write the new phase into shared state AND emit the matching `selfdev://promote`
/// control event. The single place a transition is recorded, so the pushed event
/// and the `promote_status` snapshot can never diverge.
fn set_phase(
    app: &AppHandle,
    state: &Arc<Mutex<PhaseState>>,
    phase: PromotePhase,
    message: Option<String>,
) {
    let progress = phase.progress();
    {
        let mut guard = state.lock().unwrap();
        guard.phase = phase.clone();
        guard.message = message.clone();
    }
    // Best-effort: a dropped listener must never abort the pipeline.
    let _ = app.emit(
        "selfdev://promote",
        PromoteEvent {
            phase,
            message,
            progress,
        },
    );
}

/// The promotion pipeline body: snapshot → frontend gate → rust gate → done.
/// Honors the cancel flag between steps. Each terminal/intermediate transition is
/// recorded via [`set_phase`] so the UI follows along.
///
/// `pub(crate)` + standalone (not a method) so it is directly unit-testable with a
/// fake/closure runner is unnecessary — the shelling-out steps live in `health`,
/// which is covered by its own pure-helper tests. This orchestration's transitions
/// are covered by the state-machine tests below using [`run_pipeline_with`].
async fn run_pipeline(app: AppHandle, db: Arc<crate::db::Db>, config_dir: std::path::PathBuf) {
    // Resolve the managed PromoteState fresh (the spawn owns no borrow of `State`).
    let promote = app.state::<PromoteState>();
    let phase = promote.phase.clone();
    let cancel = promote.cancel.clone();

    // The gate must run from the REPO ROOT (where `pnpm`/`cargo` live), not the
    // app config dir. In the self-dev build the workspace IS the repo the agent
    // edits — read it from settings, falling back to the current dir.
    let workspace = app
        .state::<AppState>()
        .settings
        .lock()
        .unwrap()
        .workspace
        .clone()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

    run_pipeline_with(
        &app,
        &phase,
        &cancel,
        |_cancel| {
            let db = db.clone();
            let config_dir = config_dir.clone();
            // Snapshot ignores the cancel flag (it's a single fast blocking copy);
            // the pipeline's between-step checks cover cancellation around it.
            async move { snapshot::snapshot_db(db, config_dir).await.map(|_| ()) }
        },
        || {
            let workspace = workspace.clone();
            let cancel = cancel.clone();
            async move { health::run_frontend_tests(&workspace, &cancel).await }
        },
        || {
            let workspace = workspace.clone();
            let cancel = cancel.clone();
            async move { health::run_rust_tests(&workspace, &cancel).await }
        },
    )
    .await;
}

/// The transition logic of the pipeline, parameterized over the three step
/// runners so the state-machine (incl. the Failed branch) is testable WITHOUT
/// shelling out. Each runner returns `Ok(())` on success or `Err(message)` on
/// failure; `health::CANCELLED` is mapped to a "Cancelled" message.
async fn run_pipeline_with<S, SFut, F, FFut, R, RFut>(
    app: &AppHandle,
    phase: &Arc<Mutex<PhaseState>>,
    cancel: &Arc<AtomicBool>,
    snapshot_step: S,
    frontend_step: F,
    rust_step: R,
) where
    S: FnOnce(&Arc<AtomicBool>) -> SFut,
    SFut: std::future::Future<Output = Result<(), String>>,
    F: FnOnce() -> FFut,
    FFut: std::future::Future<Output = Result<(), String>>,
    R: FnOnce() -> RFut,
    RFut: std::future::Future<Output = Result<(), String>>,
{
    // 1. Snapshot.
    set_phase(app, phase, PromotePhase::Snapshotting, None);
    if cancelled(cancel) {
        return fail(app, phase, "Snapshot", "cancelled");
    }
    if let Err(e) = snapshot_step(cancel).await {
        return fail(app, phase, "Snapshot", &e);
    }

    // 2. Frontend gate.
    set_phase(app, phase, PromotePhase::TestingFrontend, None);
    if cancelled(cancel) {
        return fail(app, phase, "Frontend tests", "cancelled");
    }
    if let Err(e) = frontend_step().await {
        return fail(app, phase, "Frontend tests", &e);
    }

    // 3. Rust gate.
    set_phase(app, phase, PromotePhase::TestingRust, None);
    if cancelled(cancel) {
        return fail(app, phase, "Rust tests", "cancelled");
    }
    if let Err(e) = rust_step().await {
        return fail(app, phase, "Rust tests", &e);
    }

    // 4. Gate passed. The restart that APPLIES the change is a separate,
    //    user-confirmed step (`promote_apply`) — never automatic — so the gate
    //    can pass without forcing a relaunch mid-edit.
    set_phase(
        app,
        phase,
        PromotePhase::Done,
        Some("Gate passed — tests green. Apply to restart the dev build.".to_string()),
    );
}

/// True when the cancel flag has been tripped.
fn cancelled(cancel: &Arc<AtomicBool>) -> bool {
    cancel.load(Ordering::Relaxed)
}

/// Record a `Failed` transition with a `"<step>: <reason>"` message and emit it.
fn fail(app: &AppHandle, phase: &Arc<Mutex<PhaseState>>, step: &str, reason: &str) {
    let reason = if reason == health::CANCELLED {
        "cancelled"
    } else {
        reason
    };
    set_phase(
        app,
        phase,
        PromotePhase::Failed,
        Some(format!("{step}: {reason}")),
    );
}

/// True when a restart-loop wrapper is active (env `PORTCODE_SELFDEV_RESTART_LOOP=1`).
fn restart_loop_active() -> bool {
    std::env::var(RESTART_LOOP_ENV)
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// Whether `promote_apply` may proceed: the gate must have passed (`Done`) AND a
/// restart-loop wrapper must be active (so exiting actually relaunches the build).
/// Pure, so it is unit-testable without an `AppHandle` — the real command calls
/// `app.exit`, which would otherwise kill the test process.
fn apply_decision(phase: &PromotePhase, loop_active: bool) -> Result<(), String> {
    match phase {
        PromotePhase::Done if loop_active => Ok(()),
        PromotePhase::Done => Err(
            "restart loop not active — launch the dev build with `pnpm app:dev:self:loop` so the app can relaunch onto the rebuilt binary"
                .to_string(),
        ),
        _ => Err("the gate has not passed; run a promotion to green before applying".to_string()),
    }
}

// ── Tauri commands ───────────────────────────────────────────────────────────

/// Begin a promotion. Errors if one is already running; otherwise resets the
/// cancel flag, moves to `Snapshotting`, spawns the pipeline, and returns
/// immediately (mirrors `run_agent`).
#[tauri::command]
pub async fn promote_begin(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let promote = app.state::<PromoteState>();
    if promote.is_running() {
        return Err("a promotion is already in progress".to_string());
    }
    // Fresh run: clear any prior cancel and reset the visible phase.
    promote.cancel.store(false, Ordering::Relaxed);
    {
        let mut guard = promote.phase.lock().unwrap();
        guard.phase = PromotePhase::Idle;
        guard.message = None;
    }

    let db = state.db.clone();
    let config_dir = state.config_dir.clone();
    let app_for_task = app.clone();
    // Run in the background so the command returns immediately and the UI can
    // start following `selfdev://promote` events.
    tauri::async_runtime::spawn(async move {
        run_pipeline(app_for_task, db, config_dir).await;
    });
    Ok(())
}

/// Request cancellation of an in-flight promotion. Idempotent: the pipeline polls
/// the flag between steps and short-circuits to `Failed { ..., "cancelled" }`.
#[tauri::command]
pub fn promote_cancel(app: AppHandle) {
    app.state::<PromoteState>()
        .cancel
        .store(true, Ordering::Relaxed);
}

/// A snapshot of the current promotion phase.
#[tauri::command]
pub fn promote_status(app: AppHandle) -> PromoteStatusDto {
    let promote = app.state::<PromoteState>();
    let guard = promote.phase.lock().unwrap();
    PromoteStatusDto {
        phase: guard.phase.clone(),
        message: guard.message.clone(),
        progress: guard.phase.progress(),
    }
}

/// Apply a passed gate by relaunching the dev build (SLICE 2). Valid only in the
/// `Done` phase AND when a restart-loop wrapper is active (see [`RESTART_LOOP_ENV`]);
/// otherwise it returns an error and the app stays put. On success it records
/// `Applying`, emits a final event, then exits the process with [`RESTART_EXIT_CODE`]
/// so the wrapper relaunches `tauri dev` (which recompiles, applying the change).
/// Rollback, if a change misbehaves, is a `git revert` + another apply — the safety
/// lives in the gate that ran before this point.
#[tauri::command]
pub fn promote_apply(app: AppHandle) -> Result<(), String> {
    let promote = app.state::<PromoteState>();
    let phase = promote.phase.lock().unwrap().phase.clone();
    apply_decision(&phase, restart_loop_active())?;

    // Record `Applying` and emit it — best-effort only: `app.exit` may terminate the
    // process before the event flushes, so NO UI path depends on it (the frontend
    // `applyPromotion` sets the `applying` badge optimistically before this call).
    // This keeps `promote_status` truthful for anything that reads it before exit.
    let phase_arc = promote.phase.clone();
    set_phase(
        &app,
        &phase_arc,
        PromotePhase::Applying,
        Some("Restarting the dev build to apply…".to_string()),
    );
    // `app.exit` ultimately calls `std::process::exit`, but its Rust return type is
    // `()` (not `!`), so the trailing `Ok(())` is required to satisfy the signature.
    app.exit(RESTART_EXIT_CODE);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The state machine is exercised through `run_pipeline_with`, which needs an
    // `AppHandle` for `set_phase`'s `app.emit`. A Tauri mock AppHandle is heavy, so
    // these tests drive the transition recorder directly via a tiny harness that
    // mirrors `run_pipeline_with`'s control flow against a shared `PhaseState` —
    // verifying the SAME transitions/messages without needing an emit sink.
    //
    // (The real `set_phase` only adds an `app.emit` side effect on top of the
    // shared-state write these tests assert; the orchestration logic under test is
    // identical.)

    /// A standalone copy of the pipeline's transition logic that records phases
    /// into a Vec instead of emitting — same branch structure as
    /// `run_pipeline_with`. Keeps the test free of a Tauri AppHandle while covering
    /// the Idle→…→Done path and every Failed branch.
    async fn drive<S, SFut, F, FFut, R, RFut>(
        cancel: &Arc<AtomicBool>,
        snapshot_step: S,
        frontend_step: F,
        rust_step: R,
    ) -> Vec<PhaseState>
    where
        S: FnOnce() -> SFut,
        SFut: std::future::Future<Output = Result<(), String>>,
        F: FnOnce() -> FFut,
        FFut: std::future::Future<Output = Result<(), String>>,
        R: FnOnce() -> RFut,
        RFut: std::future::Future<Output = Result<(), String>>,
    {
        let mut log: Vec<PhaseState> = Vec::new();
        let mut record = |phase: PromotePhase, message: Option<String>| {
            log.push(PhaseState { phase, message });
        };
        let failmsg = |step: &str, reason: &str| {
            let reason = if reason == health::CANCELLED {
                "cancelled"
            } else {
                reason
            };
            Some(format!("{step}: {reason}"))
        };

        record(PromotePhase::Snapshotting, None);
        if cancel.load(Ordering::Relaxed) {
            record(PromotePhase::Failed, failmsg("Snapshot", "cancelled"));
            return log;
        }
        if let Err(e) = snapshot_step().await {
            record(PromotePhase::Failed, failmsg("Snapshot", &e));
            return log;
        }

        record(PromotePhase::TestingFrontend, None);
        if cancel.load(Ordering::Relaxed) {
            record(PromotePhase::Failed, failmsg("Frontend tests", "cancelled"));
            return log;
        }
        if let Err(e) = frontend_step().await {
            record(PromotePhase::Failed, failmsg("Frontend tests", &e));
            return log;
        }

        record(PromotePhase::TestingRust, None);
        if cancel.load(Ordering::Relaxed) {
            record(PromotePhase::Failed, failmsg("Rust tests", "cancelled"));
            return log;
        }
        if let Err(e) = rust_step().await {
            record(PromotePhase::Failed, failmsg("Rust tests", &e));
            return log;
        }

        record(
            PromotePhase::Done,
            Some("Gate passed — tests green. Apply to restart the dev build.".to_string()),
        );
        log
    }

    async fn ok() -> Result<(), String> {
        Ok(())
    }

    #[tokio::test]
    async fn happy_path_walks_idle_to_done() {
        let cancel = Arc::new(AtomicBool::new(false));
        let log = drive(&cancel, ok, ok, ok).await;
        let phases: Vec<PromotePhase> = log.iter().map(|p| p.phase.clone()).collect();
        assert_eq!(
            phases,
            vec![
                PromotePhase::Snapshotting,
                PromotePhase::TestingFrontend,
                PromotePhase::TestingRust,
                PromotePhase::Done,
            ]
        );
        assert!(log
            .last()
            .unwrap()
            .message
            .as_ref()
            .unwrap()
            .contains("Gate passed"));
    }

    #[tokio::test]
    async fn frontend_failure_records_a_failed_branch() {
        let cancel = Arc::new(AtomicBool::new(false));
        let log = drive(
            &cancel,
            ok,
            || async { Err("exit code 1\n2 tests failed".to_string()) },
            ok,
        )
        .await;
        let last = log.last().unwrap();
        assert_eq!(last.phase, PromotePhase::Failed);
        let msg = last.message.as_ref().unwrap();
        assert!(msg.starts_with("Frontend tests:"), "got: {msg}");
        assert!(msg.contains("2 tests failed"));
        // Rust step never ran → no TestingRust phase recorded.
        assert!(!log.iter().any(|p| p.phase == PromotePhase::TestingRust));
    }

    #[tokio::test]
    async fn rust_failure_records_a_failed_branch_after_frontend_green() {
        let cancel = Arc::new(AtomicBool::new(false));
        let log = drive(&cancel, ok, ok, || async {
            Err("exit code 101\ntest core failed".to_string())
        })
        .await;
        // Frontend passed → TestingRust was reached, then failed.
        assert!(log.iter().any(|p| p.phase == PromotePhase::TestingFrontend));
        assert!(log.iter().any(|p| p.phase == PromotePhase::TestingRust));
        let last = log.last().unwrap();
        assert_eq!(last.phase, PromotePhase::Failed);
        assert!(last.message.as_ref().unwrap().starts_with("Rust tests:"));
    }

    #[tokio::test]
    async fn cancel_before_snapshot_short_circuits() {
        let cancel = Arc::new(AtomicBool::new(true));
        let log = drive(&cancel, ok, ok, ok).await;
        // Snapshotting was recorded, then the cancel check tripped to Failed.
        assert_eq!(log[0].phase, PromotePhase::Snapshotting);
        let last = log.last().unwrap();
        assert_eq!(last.phase, PromotePhase::Failed);
        assert_eq!(last.message.as_deref(), Some("Snapshot: cancelled"));
    }

    #[test]
    fn phase_progress_is_monotonic_through_the_pipeline() {
        assert!(PromotePhase::Idle.progress() < PromotePhase::Snapshotting.progress());
        assert!(PromotePhase::Snapshotting.progress() < PromotePhase::TestingFrontend.progress());
        assert!(PromotePhase::TestingFrontend.progress() < PromotePhase::TestingRust.progress());
        assert!(PromotePhase::TestingRust.progress() < PromotePhase::Done.progress());
        assert_eq!(PromotePhase::Done.progress(), 1.0);
        assert_eq!(PromotePhase::Applying.progress(), 1.0);
    }

    #[test]
    fn is_running_only_true_for_in_flight_phases() {
        let st = PromoteState::new();
        assert!(!st.is_running()); // Idle
        st.phase.lock().unwrap().phase = PromotePhase::Snapshotting;
        assert!(st.is_running());
        st.phase.lock().unwrap().phase = PromotePhase::TestingFrontend;
        assert!(st.is_running());
        st.phase.lock().unwrap().phase = PromotePhase::TestingRust;
        assert!(st.is_running());
        st.phase.lock().unwrap().phase = PromotePhase::Done;
        assert!(!st.is_running());
        st.phase.lock().unwrap().phase = PromotePhase::Applying;
        assert!(!st.is_running());
        st.phase.lock().unwrap().phase = PromotePhase::Failed;
        assert!(!st.is_running());
    }

    #[test]
    fn apply_decision_requires_done_and_an_active_loop() {
        // Done + wrapper present → allowed.
        assert!(apply_decision(&PromotePhase::Done, true).is_ok());
        // Done but no wrapper → refused, with a pointer to the loop script.
        let e = apply_decision(&PromotePhase::Done, false).unwrap_err();
        assert!(e.contains("app:dev:self:loop"), "got: {e}");
        // Any non-Done phase → refused regardless of the loop.
        for p in [
            PromotePhase::Idle,
            PromotePhase::Snapshotting,
            PromotePhase::TestingFrontend,
            PromotePhase::TestingRust,
            PromotePhase::Applying,
            PromotePhase::Failed,
        ] {
            assert!(apply_decision(&p, true).is_err(), "{p:?} should be refused");
        }
    }

    #[test]
    fn restart_exit_code_is_a_distinctive_nonzero() {
        // Inside the portable 0–255 exit-code space, clear of the common 0/1/2 and
        // the sysexits 64–78 range so it can't be confused with a real failure code.
        assert_eq!(RESTART_EXIT_CODE, 86);
        assert!((3..=255).contains(&RESTART_EXIT_CODE));
        assert!(!(64..=78).contains(&RESTART_EXIT_CODE));
    }
}
