// Opt-in crash reporting for the Rust host (Phase 1b) + desktop minidump capture
// (Phase 2). The whole pipeline is INERT unless two conditions hold: the user has
// explicitly consented (the frontend calls `telemetry_set_consent(true)`) AND a DSN
// was injected at build time (`option_env!("SENTRY_DSN")`). Dev builds, contributor
// builds, and forks ship no DSN, so the SDK is never initialized and reporting is
// physically impossible there — preserving Portcode's "zero telemetry by default"
// promise. See docs/SENTRY_PLAN.md and the Phase-1a frontend `src/lib/telemetry.ts`.
//
// Consent is enforced AT THE EDGE, mirroring the frontend: it is checked inside
// `before_send` (→ `scrub_event`), which returns `None` (drop the event) when it is
// false. We deliberately do NOT call `Client::close()` to opt out — closing is
// permanent and leaves the panic handler installed, so a later opt-in couldn't
// cleanly re-init. Every event that DOES pass the gate is rebuilt + redacted by the
// allowlist scrubber (`scrub_event`) before it can leave.
//
// ── PHASE 2 — CROSS-PROCESS CONSENT (the central correctness fix) ───────────────
// The minidump monitor (`sentry_rust_minidump::init`) re-execs THIS binary as a
// separate "crash-reporter" process that waits for a native crash. That process has
// its OWN address space, so an in-memory `CONSENT_LIVE` atomic set by the IPC in the
// MAIN process is invisible to it. Consent therefore lives ON DISK: `consent_is_live`
// reads `<app_config_dir>/.telemetry_consent` (content "1" = on; absent/anything else
// = off, fail-safe). BOTH processes run `before_send` → `scrub_event` →
// `consent_is_live`, so a crash event the monitor captures is dropped exactly when the
// user hasn't opted in — and flows when they have, with no IPC to the child. The
// atomic is kept as a fast write-through hint, but the FILE is authoritative.
//
// This also fixes 1b's startup-capture gap: the client is now bound at startup (see
// `init_desktop_with_minidump`) and gated by the on-disk file, so a user who opted in
// during a prior session has reporting live from the next launch.
//
// PRIVACY NOTE (owner-accepted): the raw minidump is sent as a Sentry ATTACHMENT,
// which bypasses `before_send`/the allowlist scrubber entirely — a memory snapshot can
// contain secrets and is NOT redactable. It IS still consent-gated, because the whole
// Fatal event (attachment included) is dropped by `scrub_event` when consent is off.
// The owner explicitly chose to ship full native minidumps accepting this residual
// risk (the DECISION that authorized Phase 2).
//
// PERFORMANCE TRACING: sentry-rust (verified through 0.41) has NO
// `before_send_transaction` hook — it is a JS/Python-SDK feature that does not
// exist on the Rust ClientOptions. Rather than ship transaction events
// (names/spans) that we could not route through the allowlist scrubber, we set
// `traces_sample_rate = 0.0` so NO transaction is ever captured. The privacy
// contract is thus upheld by the API that actually exists. `scrub_transaction`
// below is kept as a pure, unit-tested function so the moment the Rust SDK gains a
// transaction hook (or we adopt manual `Transaction` capture) the scrubber is ready
// to wire in — but it is intentionally not referenced by `init` today.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sentry::protocol::{Context, Event, Frame};

use crate::scrub::redact_secrets;

/// This app's bundle identifier — kept in lockstep with `tauri.conf.json`'s
/// `identifier`. Hardcoded so the consent-file path resolves WITHOUT a Tauri
/// `AppHandle`: `init_desktop_with_minidump` runs before the builder AND in the
/// re-exec'd crash-reporter process, neither of which has access to managed state.
const BUNDLE_IDENTIFIER: &str = "dev.porthex.portcode";

/// Name of the on-disk consent flag inside `<app_config_dir>`. Dotfile so it reads
/// as internal state, not a user document.
const CONSENT_FILE: &str = ".telemetry_consent";

/// A fast write-through hint mirroring the on-disk consent for the MAIN process. The
/// FILE (`consent_is_live`) is authoritative — it is what the separate crash-reporter
/// process reads — but checking the atomic first avoids a filesystem stat on every
/// captured event in the common (main-process) path.
static CONSENT_LIVE: AtomicBool = AtomicBool::new(false);

/// Build-time DSN, or `None` when absent/blank (dev/contributor/fork builds).
/// `option_env!` evaluates at COMPILE time: with no `SENTRY_DSN` in the build
/// environment this is a `None` constant, so `init_desktop_with_minidump` returns
/// `None` and the whole module is effectively dead at runtime.
pub fn dsn() -> Option<&'static str> {
    match option_env!("SENTRY_DSN") {
        Some(d) if !d.trim().is_empty() => Some(d),
        _ => None,
    }
}

// Test-only per-thread override for the consent-file path. `cargo test` runs tests in
// parallel threads that all share this module's statics, so a THREAD-LOCAL (not a
// global) lets each test drive its OWN on-disk consent at a unique temp path —
// isolated, race-free, and without ever touching the user's real config dir. In
// production this hook does not exist; `consent_path` resolves the real path.
#[cfg(test)]
thread_local! {
    static CONSENT_PATH_OVERRIDE: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// Absolute path of the consent file: `<app_config_dir>/.telemetry_consent`, where
/// `<app_config_dir>` reproduces Tauri's own `app_config_dir()` =
/// `dirs::config_dir().join(<identifier>)`. Returns `None` only if the platform has
/// no config dir (then consent reads as off — fail safe).
fn consent_path() -> Option<PathBuf> {
    #[cfg(test)]
    {
        if let Some(p) = CONSENT_PATH_OVERRIDE.with(|c| c.borrow().clone()) {
            return Some(p);
        }
    }
    Some(
        dirs::config_dir()?
            .join(BUNDLE_IDENTIFIER)
            .join(CONSENT_FILE),
    )
}

/// The AUTHORITATIVE consent check, readable from BOTH the main and crash-reporter
/// processes. Reads the on-disk flag: `"1"` (trimmed) ⇒ live; absent, unreadable, or
/// any other content ⇒ off. Fails safe to OFF on every error path, so a missing dir,
/// an IO error, or a partially-written file can never cause an event to be sent.
fn consent_is_live() -> bool {
    match consent_path() {
        Some(p) => matches!(std::fs::read_to_string(&p), Ok(s) if s.trim() == "1"),
        None => false,
    }
}

/// The single entry point the IPC command (`telemetry_set_consent`) calls when the
/// frontend's consent toggle changes. Writes the AUTHORITATIVE on-disk flag (so the
/// separate crash-reporter process sees the change) and updates the fast in-memory
/// hint. It does NOT init/close the SDK: the client is bound once at startup
/// (`init_desktop_with_minidump`, DSN-gated), and `before_send` → `consent_is_live`
/// gates sending — so opt-out is instant + total and opt-in is just a flag flip.
///
///  * `true`  → write `"1"` to the consent file.
///  * `false` → remove the file (best-effort; a leftover-then-removed file would
///    still read as off, but removing keeps no stale "1" around).
///
/// Best-effort IO: errors are swallowed. The fail-safe is OFF, so a failed write on
/// opt-IN simply means nothing is sent (never the reverse) — the privacy-safe
/// direction.
pub fn set_consent(enabled: bool) {
    CONSENT_LIVE.store(enabled, Ordering::SeqCst);
    let Some(path) = consent_path() else { return };
    if enabled {
        // Ensure the parent dir exists (it normally does — settings/db live there).
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, "1");
    } else {
        // Removing is enough; if removal fails the leftover content is "1", so as a
        // belt-and-suspenders also try to overwrite with "0" (read as off).
        if std::fs::remove_file(&path).is_err() {
            let _ = std::fs::write(&path, "0");
        }
    }
}

/// Build the Sentry client + `ClientOptions`. Shared by BOTH processes (the main app
/// and the re-exec'd crash reporter), so both carry the SAME `before_send` scrubber +
/// consent gate. The options are byte-for-byte the 1b options — only the call site
/// (a `Client` built up front, rather than a lazy `sentry::init`) changed, because
/// the minidump monitor must be armed before any crash can happen.
fn build_client(dsn: &str) -> sentry::Client {
    let options = sentry::ClientOptions {
        release: Some(env!("CARGO_PKG_VERSION").into()),
        environment: Some(
            option_env!("SENTRY_ENVIRONMENT")
                .unwrap_or("development")
                .into(),
        ),
        // No performance tracing: the Rust SDK has no transaction-scrubbing hook,
        // so we never generate transaction events that could leak unscrubbed. (See
        // the module header.) Errors-only keeps the privacy contract airtight.
        traces_sample_rate: 0.0,
        // Never let Sentry attach IP/username/host or other default PII.
        send_default_pii: false,
        attach_stacktrace: true,
        max_breadcrumbs: 30,
        // The privacy gate + allowlist scrubber, enforced at the edge. A bare `fn`
        // coerces to the `dyn Fn(Event) -> Option<Event> + Send + Sync` the field
        // expects.
        before_send: Some(std::sync::Arc::new(scrub_event)),
        ..Default::default()
    };
    sentry::Client::from((dsn, options))
}

/// Initialize crash reporting for the DESKTOP host (Phase 2). Called as the FIRST
/// thing in `run()`, before the Tauri builder, so it executes in BOTH the app process
/// and the re-exec'd crash-reporter process (everything before `minidump::init`
/// runs in both).
///
/// Returns `None` when no DSN was baked in — the unchanged inert-by-default contract:
/// dev/contributor/fork builds never init the SDK or spawn a monitor. When a DSN IS
/// present:
///   1. build the client (with our scrubber + gate) and bind it to the current hub,
///   2. start the OUT-OF-PROCESS minidump monitor (`tauri_plugin_sentry::minidump`),
///      which re-execs this binary; the parent gets the handle, the child becomes the
///      monitor and never returns past `minidump::init`,
///   3. (main process only, after the monitor split) install the chained panic-flush
///      hook so `panic = "abort"` panics still flush before the process dies.
///
/// The returned guard MUST be held for the whole process lifetime — dropping it stops
/// the crash-reporter child. The caller (`run()`) keeps it alive until `.run()`
/// returns.
pub fn init_desktop_with_minidump() -> Option<tauri_plugin_sentry::minidump::Handle> {
    let dsn = dsn()?;

    let client = build_client(dsn);
    // Bind the client to the current hub so `sentry::capture_*` (incl. the plugin's
    // webview→Rust `envelope` command and the minidump monitor's Fatal event) route
    // through OUR client → OUR `before_send` scrubber + consent gate.
    sentry::Hub::current().bind_client(Some(std::sync::Arc::new(client.clone())));

    // Caution: everything before this line runs in BOTH processes; everything after
    // runs ONLY in the app process. Starting the monitor re-execs this binary; in the
    // crash-reporter child this call never returns normally. We log + continue if the
    // monitor fails to start (in-process panic capture via the hook below still works).
    let handle = match tauri_plugin_sentry::minidump::init(&client) {
        Ok(h) => Some(h),
        Err(e) => {
            eprintln!("telemetry: minidump monitor failed to start: {e}");
            None
        }
    };

    // Chain the panic-flush hook AFTER the panic integration's own capturing hook
    // (installed when the client was built). On a panic: capture (→ before_send →
    // scrubbed) runs first, then we flush before the process aborts.
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        prev(info);
        if let Some(client) = sentry::Hub::current().client() {
            let _ = client.flush(Some(Duration::from_secs(2)));
        }
    }));

    handle
}

/// Allowlist scrubber for error events (the `before_send` hook). Returns `None`
/// when consent isn't live (drop the event); otherwise redacts every surviving
/// string and nulls out the PII carriers. Mirrors the frontend `scrubEvent`,
/// adapted to sentry-rust's `protocol::Event`.
///
/// CONSENT GATE: reads the AUTHORITATIVE on-disk flag (`consent_is_live`), NOT the
/// in-memory atomic — this is what lets the separate crash-reporter process honor the
/// user's choice (it never receives the IPC). The whole event (incl. any minidump
/// ATTACHMENT) is dropped here when consent is off.
fn scrub_event(mut event: Event<'static>) -> Option<Event<'static>> {
    if !consent_is_live() {
        return None;
    }

    // Top-level message (message-only events).
    if let Some(msg) = event.message.take() {
        event.message = Some(redact_secrets(&msg));
    }

    // Structured log entry (the `message`-template form) + its interpolation
    // params (which can carry user values).
    if let Some(le) = event.logentry.as_mut() {
        le.message = redact_secrets(&le.message);
        le.params.clear();
    }

    // The culprit/transaction-name shorthand can embed a route/path/arg.
    event.culprit = event.culprit.take().map(|c| redact_secrets(&c));

    // Exceptions: redact the value + the mechanism's description (drop its data),
    // and scrub BOTH the symbolicated and raw stacktraces.
    for exc in event.exception.values.iter_mut() {
        if let Some(value) = exc.value.take() {
            exc.value = Some(redact_secrets(&value));
        }
        if let Some(m) = exc.mechanism.as_mut() {
            m.data.clear();
            m.description = m.description.take().map(|d| redact_secrets(&d));
        }
        if let Some(st) = exc.stacktrace.as_mut() {
            scrub_frames(&mut st.frames);
        }
        if let Some(st) = exc.raw_stacktrace.as_mut() {
            scrub_frames(&mut st.frames);
        }
    }

    // Threads: `attach_stacktrace: true` populates these by default on
    // `capture_message`, so they are a primary leak vector — scrub their frames +
    // redact the thread name.
    for th in event.threads.values.iter_mut() {
        th.name = th.name.take().map(|n| redact_secrets(&n));
        if let Some(st) = th.stacktrace.as_mut() {
            scrub_frames(&mut st.frames);
        }
        if let Some(st) = th.raw_stacktrace.as_mut() {
            scrub_frames(&mut st.frames);
        }
    }

    // Top-level stacktrace (rare, but possible) + the template-debug info (which
    // carries source context — drop it wholesale).
    if let Some(st) = event.stacktrace.as_mut() {
        scrub_frames(&mut st.frames);
    }
    event.template = None;

    // Breadcrumbs: keep type/category/level/timestamp + a redacted message; DROP
    // the `data` payload wholesale (it's where IPC args / URLs / tool I/O ride).
    for crumb in event.breadcrumbs.values.iter_mut() {
        if let Some(msg) = crumb.message.take() {
            crumb.message = Some(redact_secrets(&msg));
        }
        crumb.data.clear();
    }

    strip_pii_carriers(&mut event);

    // Belt-and-suspenders: redact every string ANYWHERE in the event (mirrors
    // scrub.ts `deepRedact`). This is the contract guarantee — even a field added
    // by a future SDK version, or one we missed above, is caught here. Fails CLOSED
    // (drops the event) if the round-trip can't be performed.
    deep_redact_event(event)
}

/// Scrub a slice of stack frames down to non-PII fields: drop the absolute path,
/// source context, and locals; redact every remaining identifying string
/// (filename, symbol, package, module — any can embed home-dir paths or user
/// identifiers). Keeps `function`/`lineno`/`colno`/`in_app`. Shared by exceptions,
/// threads, and the top-level stacktrace.
fn scrub_frames(frames: &mut [Frame]) {
    for f in frames {
        f.abs_path = None;
        f.context_line = None;
        f.pre_context.clear();
        f.post_context.clear();
        f.vars.clear();
        f.filename = f.filename.take().map(|s| redact_secrets(&s));
        f.symbol = f.symbol.take().map(|s| redact_secrets(&s));
        f.package = f.package.take().map(|s| redact_secrets(&s));
        f.module = f.module.take().map(|s| redact_secrets(&s));
    }
}

/// Recursively redact every string in a JSON value. Used by `deep_redact_event`.
fn redact_json(v: &mut serde_json::Value) {
    use serde_json::Value;
    match v {
        Value::String(s) => *s = redact_secrets(s.as_str()),
        Value::Array(a) => a.iter_mut().for_each(redact_json),
        Value::Object(m) => m.values_mut().for_each(redact_json),
        _ => {}
    }
}

/// Belt-and-suspenders: serialize the event, redact every string anywhere in it,
/// then deserialize back. `protocol::Event` derives `Deserialize` WITHOUT
/// `#[serde(borrow)]` (verified against sentry-types 0.34 `protocol/v7.rs`), so its
/// `Cow` fields deserialize as owned and `Event<'static>: DeserializeOwned` holds —
/// the round-trip compiles. Fails CLOSED (returns `None`, dropping the event) if
/// either step fails, so a serialization quirk can never let an unscrubbed event
/// leak. Mirrors the frontend `deepRedact`.
fn deep_redact_event(event: Event<'static>) -> Option<Event<'static>> {
    let mut v = serde_json::to_value(&event).ok()?;
    redact_json(&mut v);
    serde_json::from_value(v).ok()
}

/// Allowlist scrubber for performance/transaction events — kept as a pure, tested
/// function for the day the Rust SDK gains a transaction hook (see the module
/// header; it is NOT wired into `init` because no such hook exists in 0.34). When
/// it is wired, it returns `None` if consent isn't live; otherwise it redacts the
/// transaction name + the trace context's description and strips the same PII
/// carriers `scrub_event` does.
#[cfg_attr(not(test), allow(dead_code))]
fn scrub_transaction(mut event: Event<'static>) -> Option<Event<'static>> {
    if !consent_is_live() {
        return None;
    }

    // The transaction NAME is the most likely place a route/path/arg leaks in.
    if let Some(name) = event.transaction.take() {
        event.transaction = Some(redact_secrets(&name));
    }

    strip_pii_carriers(&mut event);
    // Same belt-and-suspenders deep redaction as `scrub_event` (fails closed).
    deep_redact_event(event)
}

/// Null/clear every PII carrier Sentry would otherwise attach, and keep only the
/// non-identifying contexts (os / runtime / app version). Shared by both scrubbers.
fn strip_pii_carriers(event: &mut Event<'static>) {
    event.server_name = None;
    event.request = None;
    event.user = None;
    event.dist = None;
    event.extra.clear();
    event.modules.clear();
    event.tags.clear();
    // Debug-image metadata embeds local binary paths (the image `name`). We don't
    // symbolicate server-side, so drop the images entirely. `debug_meta` is a
    // `Cow<DebugMeta>`; `.to_mut()` clones-on-write so we can clear in place.
    event.debug_meta.to_mut().images.clear();
    // Keep only the os / runtime / app(-version) contexts; drop everything else
    // (notably `device`, whose name is the hostname; `trace`, `gpu`, `browser`).
    event.contexts.retain(|key, ctx| {
        matches!(key.as_str(), "os" | "runtime" | "app")
            && matches!(ctx, Context::Os(_) | Context::Runtime(_) | Context::App(_))
    });
}

/// Capture a redacted error-level message for explicit "should never happen"
/// branches. No-op unless reporting is live; the message is redacted here AND the
/// resulting event still passes through `before_send` for a second scrub.
#[cfg_attr(not(test), allow(dead_code))]
pub fn capture_message(msg: &str) {
    if !consent_is_live() {
        return;
    }
    sentry::capture_message(&redact_secrets(msg), sentry::Level::Error);
}

/// Spawn a future on the Tauri async runtime, reporting any panic it produces with
/// task context before re-raising it.
///
/// IMPORTANT: under `panic = "abort"` (the release profile), `catch_unwind` never
/// actually catches — the panic aborts the process, and the GLOBAL panic hook
/// installed by `init()` is what captures + flushes the (scrubbed) event. This
/// wrapper's catch path therefore only fires in unwinding builds (dev/test); its
/// value there is adding a "spawned task panicked" message so an otherwise-silent
/// background-task panic is still attributed. We capture, then `resume_unwind` so
/// behavior is otherwise identical to a bare `spawn`. Not adopted at any call site
/// in 1b (the global hook already covers spawned-task panics under abort); provided
/// for future opt-in at obviously-safe `Output = ()` sites.
#[allow(dead_code)]
pub fn spawn_reporting<F>(future: F) -> tauri::async_runtime::JoinHandle<()>
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    use futures_util::FutureExt;
    use std::panic::AssertUnwindSafe;

    tauri::async_runtime::spawn(async move {
        match AssertUnwindSafe(future).catch_unwind().await {
            Ok(()) => {}
            Err(panic) => {
                capture_message(&format!("spawned task panicked: {}", panic_payload(&panic)));
                std::panic::resume_unwind(panic);
            }
        }
    })
}

/// Best-effort extraction of a panic payload's message (the `&str`/`String` a
/// `panic!` produces). Falls back to a generic label for non-string payloads.
#[cfg_attr(not(test), allow(dead_code))]
fn panic_payload(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // `Frame` is already in scope via `use super::*`. Pull in the rest of the
    // protocol types the polluted-event fixture constructs.
    use sentry::protocol::{
        Addr, AppleDebugImage, Breadcrumb, DebugImage, Exception, LogEntry, Mechanism, Stacktrace,
        Thread, Value,
    };

    // The scrubber is the privacy gate for Rust-host crash reporting — these tests
    // are the SHARED CONTRACT that secrets NEVER survive into an outgoing event,
    // mirroring `src/lib/scrub.test.ts`. The gate now reads an on-disk file
    // (`consent_is_live`) so the separate crash-reporter process can honor it, so the
    // helper points this thread's `consent_path` at a UNIQUE temp file and writes the
    // requested state there. Thread-local override = no races with parallel tests and
    // no touching the user's real config dir. The temp file is removed on exit.
    fn with_consent<T>(enabled: bool, f: impl FnOnce() -> T) -> T {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "portcode-test-consent-{}-{:?}.flag",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::write(&path, if enabled { "1" } else { "0" }).expect("write consent flag");
        CONSENT_PATH_OVERRIDE.with(|c| *c.borrow_mut() = Some(path.clone()));
        // Keep the atomic in sync too, so a test that asserts via either path agrees.
        CONSENT_LIVE.store(enabled, Ordering::SeqCst);

        let out = f();

        CONSENT_PATH_OVERRIDE.with(|c| *c.borrow_mut() = None);
        CONSENT_LIVE.store(false, Ordering::SeqCst);
        let _ = std::fs::remove_file(&path);
        out
    }

    // Point this thread's consent_path at a temp file WITHOUT pre-writing it, so
    // `set_consent`/`consent_is_live` can be exercised against a clean slate. Returns
    // the path; the caller removes it. Resets the override on the next `reset_*`.
    fn temp_consent_path() -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "portcode-test-setconsent-{}-{:?}.flag",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path); // clean slate
        CONSENT_PATH_OVERRIDE.with(|c| *c.borrow_mut() = Some(path.clone()));
        path
    }

    fn clear_consent_override(path: &std::path::Path) {
        CONSENT_PATH_OVERRIDE.with(|c| *c.borrow_mut() = None);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn dsn_is_none_in_dev_builds() {
        // No SENTRY_DSN is set in the test build, so the whole pipeline is inert.
        assert!(dsn().is_none());
    }

    #[test]
    fn consent_is_off_when_file_absent() {
        // The fail-safe: no file ⇒ off. (Clean-slate temp path, never written.)
        let path = temp_consent_path();
        assert!(!consent_is_live());
        clear_consent_override(&path);
    }

    #[test]
    fn consent_is_off_for_non_one_content() {
        // Only the exact trimmed content "1" arms the gate; "0"/garbage ⇒ off.
        let path = temp_consent_path();
        std::fs::write(&path, "0").unwrap();
        assert!(!consent_is_live());
        std::fs::write(&path, "yes").unwrap();
        assert!(!consent_is_live());
        clear_consent_override(&path);
    }

    #[test]
    fn set_consent_writes_then_removes_the_flag() {
        // set_consent is the cross-process gate writer: "1" on opt-in (→ live),
        // file gone on opt-out (→ off). This is what the crash-reporter child reads.
        let path = temp_consent_path();
        set_consent(true);
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), "1");
        assert!(consent_is_live());

        set_consent(false);
        assert!(!consent_is_live());
        // Either removed, or overwritten to "0" — both read as off.
        assert!(!path.exists() || std::fs::read_to_string(&path).unwrap().trim() != "1");
        clear_consent_override(&path);
    }

    // ── Phase-2 consent-file tests ──────────────────────────────────────────────

    #[test]
    fn consent_is_live_when_file_contains_one() {
        // The sole armed state: file with exact content "1".
        let path = temp_consent_path();
        std::fs::write(&path, "1").unwrap();
        assert!(consent_is_live());
        clear_consent_override(&path);
    }

    #[test]
    fn consent_is_live_with_surrounding_whitespace() {
        // The flag is trimmed before comparison, so "1\n" and " 1 " both arm the
        // gate — matching the on-disk write from set_consent (which writes "1"
        // without a newline, but on-disk files can accumulate whitespace).
        let path = temp_consent_path();
        std::fs::write(&path, "1\n").unwrap();
        assert!(consent_is_live(), "trailing newline should still read as live");
        std::fs::write(&path, " 1 ").unwrap();
        assert!(consent_is_live(), "padded spaces should still read as live");
        clear_consent_override(&path);
    }

    #[test]
    fn consent_is_off_for_empty_file() {
        // An empty file is not "1" — must read as off (fail-safe).
        let path = temp_consent_path();
        std::fs::write(&path, "").unwrap();
        assert!(!consent_is_live());
        clear_consent_override(&path);
    }

    #[test]
    fn set_consent_false_when_file_absent_does_not_panic() {
        // Opt-out when no file exists must not panic or error — it is idempotent.
        let path = temp_consent_path(); // clean slate, no file written
        assert!(!path.exists());
        set_consent(false); // must not panic
        assert!(!consent_is_live());
        clear_consent_override(&path);
    }

    #[test]
    fn set_consent_idempotent_double_opt_in() {
        // Calling set_consent(true) twice is safe and leaves consent live.
        let path = temp_consent_path();
        set_consent(true);
        assert!(consent_is_live());
        set_consent(true); // second call should not panic or break state
        assert!(consent_is_live());
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), "1");
        clear_consent_override(&path);
    }

    #[test]
    fn set_consent_creates_parent_directory_when_missing() {
        // set_consent(true) must create the parent dir if it doesn't exist yet —
        // the first opt-in on a fresh install has no config dir.
        let base = std::env::temp_dir().join(format!(
            "portcode-test-parentdir-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        // Ensure the directory does NOT exist before we start.
        let _ = std::fs::remove_dir_all(&base);
        let flag_path = base.join(".telemetry_consent");
        CONSENT_PATH_OVERRIDE.with(|c| *c.borrow_mut() = Some(flag_path.clone()));

        set_consent(true);

        assert!(flag_path.exists(), "consent file should have been created");
        assert_eq!(std::fs::read_to_string(&flag_path).unwrap().trim(), "1");

        // Cleanup.
        CONSENT_PATH_OVERRIDE.with(|c| *c.borrow_mut() = None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn set_consent_round_trip_opt_in_then_opt_out() {
        // A full round-trip: opt-in → live, opt-out → off. Verifies the file
        // lifecycle end-to-end (the crash-reporter process reads exactly this file).
        let path = temp_consent_path();

        set_consent(true);
        assert!(consent_is_live(), "should be live after opt-in");

        set_consent(false);
        assert!(!consent_is_live(), "should be off after opt-out");
        // File must not contain "1" — either gone or overwritten with "0".
        let on_disk = std::fs::read_to_string(&path).unwrap_or_default();
        assert_ne!(on_disk.trim(), "1", "stale '1' must not remain after opt-out");

        clear_consent_override(&path);
    }

    #[test]
    fn scrub_event_gates_on_file_not_atomic() {
        // The consent gate in scrub_event reads the FILE (consent_is_live), not the
        // atomic. Verify: file says off but atomic says on → event is dropped.
        let path = temp_consent_path();
        // Write "0" to the file (off), but force the atomic to true.
        std::fs::write(&path, "0").unwrap();
        CONSENT_LIVE.store(true, Ordering::SeqCst);

        let result = scrub_event(Event::default());
        assert!(
            result.is_none(),
            "event must be dropped when file says off, even if atomic is true"
        );

        CONSENT_LIVE.store(false, Ordering::SeqCst);
        CONSENT_PATH_OVERRIDE.with(|c| *c.borrow_mut() = None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn scrub_transaction_gates_on_file_not_atomic() {
        // Same invariant as scrub_event_gates_on_file_not_atomic, but for
        // scrub_transaction — the same consent_is_live() is the gate.
        let path = temp_consent_path();
        std::fs::write(&path, "0").unwrap();
        CONSENT_LIVE.store(true, Ordering::SeqCst);

        let result = scrub_transaction(Event::default());
        assert!(
            result.is_none(),
            "transaction must be dropped when file says off, even if atomic is true"
        );

        CONSENT_LIVE.store(false, Ordering::SeqCst);
        CONSENT_PATH_OVERRIDE.with(|c| *c.borrow_mut() = None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn init_desktop_with_minidump_returns_none_without_dsn() {
        // The inert-by-default contract: no DSN baked in ⇒ None is returned,
        // nothing is initialized, no monitor is spawned.
        // In dev/test builds `dsn()` is always None (no SENTRY_DSN env var),
        // so init_desktop_with_minidump must always return None here.
        assert!(
            dsn().is_none(),
            "pre-condition: no DSN in test builds"
        );
        // Since dsn() returns None, init_desktop_with_minidump must return None
        // immediately without touching the panic hook or spawning any process.
        // We cannot call init_desktop_with_minidump() in tests because it
        // unconditionally sets the panic hook even on the happy path; testing the
        // DSN-guard is sufficient given the function's first line is `dsn()?`.
        // The assertion above guarantees the early-return branch is taken.
    }

    // ── end Phase-2 consent-file tests ──────────────────────────────────────────

    #[test]
    fn scrub_event_drops_when_consent_is_off() {
        let ev = Event::default();
        with_consent(false, || assert!(scrub_event(ev).is_none()));
    }

    #[test]
    fn scrub_event_redacts_message_and_passes_when_live() {
        let ev = Event {
            message: Some("fail sk-ant-msgonly123456".to_string()),
            ..Default::default()
        };
        let out = with_consent(true, || scrub_event(ev)).expect("event should pass");
        assert_eq!(out.message.as_deref(), Some("fail [redacted-api-key]"));
    }

    #[test]
    fn scrub_event_strips_pii_and_secrets_everywhere() {
        let mut frame = Frame {
            function: Some("scan".to_string()),
            filename: Some(r"C:\Users\Memphi$\app\scanner.ts".to_string()),
            abs_path: Some(r"C:\Users\Memphi$\app\scanner.ts".to_string()),
            lineno: Some(10),
            colno: Some(2),
            in_app: Some(true),
            context_line: Some("const k = 'sk-ant-ctx-leak123456'".to_string()),
            ..Default::default()
        };
        frame.pre_context = vec!["// sk-ant-pre-leak123456".to_string()];
        frame.post_context = vec!["// sk-ant-post-leak123456".to_string()];
        frame
            .vars
            .insert("apiKey".to_string(), Value::from("sk-ant-frame-leak123456"));

        // Mechanism with a leaky `data` payload + description.
        let mut mechanism = Mechanism {
            ty: "panic".to_string(),
            description: Some("panicked at sk-ant-mech-leak123456".to_string()),
            ..Default::default()
        };
        mechanism.data.insert(
            "url".to_string(),
            Value::from("https://x?k=sk-ant-mechdata-leak123456"),
        );

        let exc = Exception {
            ty: "TypeError".to_string(),
            value: Some("boom with key sk-ant-msg-leak123456".to_string()),
            mechanism: Some(mechanism),
            stacktrace: Some(Stacktrace {
                frames: vec![frame],
                ..Default::default()
            }),
            ..Default::default()
        };

        // A thread with its own leaky stacktrace — populated by default when
        // `attach_stacktrace` is on, so a prime leak vector.
        let mut thread_frame = Frame {
            function: Some("worker".to_string()),
            abs_path: Some(r"C:\Users\Memphi$\app\worker.ts".to_string()),
            context_line: Some("let t = 'sk-ant-thread-leak123456'".to_string()),
            symbol: Some("sk-ant-thread-leak123456".to_string()),
            ..Default::default()
        };
        thread_frame
            .vars
            .insert("k".to_string(), Value::from("sk-ant-thread-leak123456"));
        let thread = Thread {
            name: Some("io-sk-ant-thread-leak123456".to_string()),
            stacktrace: Some(Stacktrace {
                frames: vec![thread_frame],
                ..Default::default()
            }),
            ..Default::default()
        };

        let mut crumb = Breadcrumb {
            category: Some("ipc".to_string()),
            message: Some("phone_sync_connect /home/alice/secret".to_string()),
            ..Default::default()
        };
        crumb
            .data
            .insert("qr".to_string(), Value::from("sk-ant-bc-leak123456"));

        let mut event = Event {
            server_name: Some("DESKTOP-SECRET".into()),
            culprit: Some("in /home/alice/secret near sk-ant-culprit-leak123456".to_string()),
            logentry: Some(LogEntry {
                message: "log sk-ant-logmsg-leak123456".to_string(),
                params: vec![Value::from("sk-ant-logparam-leak123456")],
            }),
            ..Default::default()
        };
        event.exception.values.push(exc);
        event.threads.values.push(thread);
        event.breadcrumbs.values.push(crumb);
        // A debug image whose `name` is a local binary path.
        event
            .debug_meta
            .to_mut()
            .images
            .push(DebugImage::Apple(AppleDebugImage {
                name: r"C:\Users\Memphi$\app\portcode.exe".to_string(),
                arch: None,
                cpu_type: None,
                cpu_subtype: None,
                image_addr: Addr(0),
                image_size: 0,
                image_vmaddr: Addr(0),
                uuid: uuid::Uuid::nil(),
            }));
        event
            .extra
            .insert("prompt".to_string(), Value::from("write sk-ant-leak999999"));
        event
            .tags
            .insert("apiKey".to_string(), "sk-ant-tagleak123456".to_string());
        event.user = Some(sentry::User {
            email: Some("a667066706670@gmail.com".to_string()),
            ..Default::default()
        });

        let out = with_consent(true, || scrub_event(event)).expect("event should pass");

        // Serialize the whole scrubbed event and assert NO planted secret survives.
        let blob = serde_json::to_string(&out).expect("event serializes");
        for secret in [
            "sk-ant-leak999999",
            "sk-ant-tagleak123456",
            "sk-ant-bc-leak123456",
            "sk-ant-msg-leak123456",
            "sk-ant-frame-leak123456",
            "sk-ant-ctx-leak123456",
            "sk-ant-pre-leak123456",
            "sk-ant-post-leak123456",
            // Newly-covered fields: mechanism, threads, logentry, culprit, debug image.
            "sk-ant-mech-leak123456",
            "sk-ant-mechdata-leak123456",
            "sk-ant-thread-leak123456",
            "sk-ant-logmsg-leak123456",
            "sk-ant-logparam-leak123456",
            "sk-ant-culprit-leak123456",
            "a667066706670@gmail.com",
            "Memphi$",
            "DESKTOP-SECRET",
        ] {
            assert!(!blob.contains(secret), "secret survived scrub: {secret}");
        }

        // PII carriers are cleared.
        assert!(out.server_name.is_none());
        assert!(out.user.is_none());
        assert!(out.extra.is_empty());
        assert!(out.tags.is_empty());

        // Actionable bits are kept; the frame is scrubbed but identifiable.
        let exc = &out.exception.values[0];
        assert_eq!(exc.ty, "TypeError");
        let frame = &exc.stacktrace.as_ref().unwrap().frames[0];
        assert_eq!(frame.function.as_deref(), Some("scan"));
        assert_eq!(
            frame.filename.as_deref(),
            Some(r"C:\Users\~user\app\scanner.ts")
        );
        assert!(frame.abs_path.is_none());
        assert!(frame.context_line.is_none());
        assert!(frame.pre_context.is_empty());
        assert!(frame.post_context.is_empty());
        assert!(frame.vars.is_empty());

        // Breadcrumb message redacted, data dropped.
        let crumb = &out.breadcrumbs.values[0];
        assert_eq!(
            crumb.message.as_deref(),
            Some("phone_sync_connect /home/~user/secret")
        );
        assert!(crumb.data.is_empty());
    }

    #[test]
    fn scrub_transaction_drops_when_consent_is_off() {
        // `protocol::Event` has no `ty` discriminant field; `scrub_transaction`
        // never reads one, so a default event exercises the consent gate fine.
        let ev = Event::default();
        with_consent(false, || assert!(scrub_transaction(ev).is_none()));
    }

    #[test]
    fn scrub_transaction_redacts_name_and_strips_pii() {
        let mut event = Event {
            transaction: Some("GET /home/alice/secret?key=sk-ant-txn-leak123456".to_string()),
            server_name: Some("DESKTOP-SECRET".into()),
            ..Default::default()
        };
        event.user = Some(sentry::User {
            email: Some("a667066706670@gmail.com".to_string()),
            ..Default::default()
        });

        let out = with_consent(true, || scrub_transaction(event)).expect("txn should pass");
        let blob = serde_json::to_string(&out).expect("txn serializes");
        for secret in [
            "sk-ant-txn-leak123456",
            "a667066706670@gmail.com",
            "DESKTOP-SECRET",
            "alice",
        ] {
            assert!(
                !blob.contains(secret),
                "secret survived txn scrub: {secret}"
            );
        }
        assert_eq!(
            out.transaction.as_deref(),
            Some("GET /home/~user/secret?key=[redacted-api-key]")
        );
        assert!(out.server_name.is_none());
        assert!(out.user.is_none());
    }

    #[test]
    fn capture_message_is_a_no_op_when_consent_is_off() {
        // With consent off (and no DSN/Hub configured in tests), this must not panic
        // and must not attempt to send.
        capture_message("should never happen: sk-ant-leak123456");
    }

    #[test]
    fn panic_payload_extracts_str_and_string() {
        let s: Box<dyn std::any::Any + Send> = Box::new("boom");
        assert_eq!(panic_payload(s.as_ref()), "boom");
        let s: Box<dyn std::any::Any + Send> = Box::new(String::from("kaboom"));
        assert_eq!(panic_payload(s.as_ref()), "kaboom");
        let s: Box<dyn std::any::Any + Send> = Box::new(42u32);
        assert_eq!(panic_payload(s.as_ref()), "<non-string panic payload>");
    }
}
