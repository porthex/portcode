// Opt-in crash reporting for the Rust host (Phase 1b). The whole pipeline is INERT
// unless two conditions hold: the user has explicitly consented (the frontend
// calls `telemetry_set_consent(true)`) AND a DSN was injected at build time
// (`option_env!("SENTRY_DSN")`). Dev builds, contributor builds, and forks ship no
// DSN, so the SDK is never initialized and reporting is physically impossible
// there — preserving Portcode's "zero telemetry by default" promise. See
// docs/SENTRY_PLAN.md and the Phase-1a frontend `src/lib/telemetry.ts`.
//
// Consent is enforced AT THE EDGE, mirroring the frontend: a `CONSENT_LIVE` atomic
// is checked inside `before_send`, which returns `None` (drop the event) when it is
// false. We deliberately do NOT call `Client::close()` to opt out — closing is
// permanent and leaves the panic handler installed, so a later opt-in couldn't
// cleanly re-init. The SDK is initialized at most once (its guard kept alive in a
// `OnceLock`); flipping the atomic gates sending. Every event that DOES pass the
// gate is rebuilt + redacted by the allowlist scrubber (`scrub_event`) before it
// can leave.
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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use sentry::protocol::{Context, Event, Frame};

use crate::scrub::redact_secrets;

/// The user's CURRENT consent, checked at send time inside `before_send`. Starts
/// `false` (off by default). Toggled by `set_consent`; the gate is what makes
/// opt-out instant + total and opt-in-again a no-op flag flip.
static CONSENT_LIVE: AtomicBool = AtomicBool::new(false);

/// Holds the live client guard for the lifetime of the process. Its presence is
/// also our "already initialized" flag — `set_consent` only calls `init()` when
/// this is empty, and `init()` itself sets it exactly once.
static GUARD: OnceLock<sentry::ClientInitGuard> = OnceLock::new();

/// Build-time DSN, or `None` when absent/blank (dev/contributor/fork builds).
/// `option_env!` evaluates at COMPILE time: with no `SENTRY_DSN` in the build
/// environment this is a `None` constant, so `set_consent` can never initialize
/// the SDK and the whole module is effectively dead at runtime.
pub fn dsn() -> Option<&'static str> {
    match option_env!("SENTRY_DSN") {
        Some(d) if !d.trim().is_empty() => Some(d),
        _ => None,
    }
}

/// The single entry point the IPC command (`telemetry_set_consent`) calls when the
/// frontend's consent toggle changes.
///
///  * `true`  → arm the gate; lazily `init()` the SDK iff a DSN exists and we have
///    not initialized yet. The first opt-in after launch wires Sentry; later
///    opt-ins just re-arm the flag.
///  * `false` → disarm the gate. We do NOT close the client — the atomic makes
///    `before_send` drop every event (including ones Sentry's own panic hook
///    captures), which is instant, total, and reversible.
pub fn set_consent(enabled: bool) {
    CONSENT_LIVE.store(enabled, Ordering::SeqCst);
    if enabled && GUARD.get().is_none() && dsn().is_some() {
        init();
    }
}

/// Initialize the Sentry SDK once and install the panic-flush hook. Idempotent via
/// the `GUARD` OnceLock: a racing second call whose `set` loses simply drops its
/// (now-redundant) guard, and only the winner installs the panic hook.
fn init() {
    let Some(dsn) = dsn() else { return };

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
        before_send: Some(Arc::new(scrub_event)),
        ..Default::default()
    };

    let guard = sentry::init((dsn, options));

    // Store the guard; if another thread won the race, keep theirs (ours drops here)
    // and do NOT double-install the panic hook.
    if GUARD.set(guard).is_err() {
        return;
    }

    // The `panic` integration installs its OWN capturing hook during `sentry::init`
    // above. We chain AFTER init so that capturing hook is our `prev`: on a panic we
    // first let it run (capture → routed through `before_send` → scrubbed), then
    // flush before the process aborts (`panic = "abort"` in `[profile.release]`).
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        prev(info);
        if let Some(client) = sentry::Hub::current().client() {
            let _ = client.flush(Some(Duration::from_secs(2)));
        }
    }));
}

/// Allowlist scrubber for error events (the `before_send` hook). Returns `None`
/// when consent isn't live (drop the event); otherwise redacts every surviving
/// string and nulls out the PII carriers. Mirrors the frontend `scrubEvent`,
/// adapted to sentry-rust's `protocol::Event`.
fn scrub_event(mut event: Event<'static>) -> Option<Event<'static>> {
    if !CONSENT_LIVE.load(Ordering::SeqCst) {
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
    if !CONSENT_LIVE.load(Ordering::SeqCst) {
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
    if !CONSENT_LIVE.load(Ordering::SeqCst) {
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
    // mirroring `src/lib/scrub.test.ts`. They all share the `CONSENT_LIVE` static,
    // so each one sets + resets it via `with_consent`.
    fn with_consent<T>(enabled: bool, f: impl FnOnce() -> T) -> T {
        CONSENT_LIVE.store(enabled, Ordering::SeqCst);
        let out = f();
        CONSENT_LIVE.store(false, Ordering::SeqCst);
        out
    }

    #[test]
    fn dsn_is_none_in_dev_builds() {
        // No SENTRY_DSN is set in the test build, so the whole pipeline is inert.
        assert!(dsn().is_none());
    }

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
