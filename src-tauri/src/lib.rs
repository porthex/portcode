// DESKTOP-ONLY executable-capability cluster — excluded from the mobile (phone =
// pure remote CLIENT) binary so no agent loop / shell+fs tools / OAuth loopback
// code ships on the phone. `llm` stays SHARED: db/permissions/sync(protocol,mod)
// `use crate::llm::{Block, ChatMessage, StreamEvent}` in production code — those
// are the wire types the phone must decode — so gating `llm` would break mobile.
#[cfg(desktop)]
mod agent;
#[cfg(desktop)]
mod agents;
#[cfg(desktop)]
mod background;
mod db;
mod llm;
#[cfg(desktop)]
mod oauth;
mod permissions;
mod secrets;
mod settings;
mod sync;
#[cfg(desktop)]
mod tools;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
// `Ordering` is referenced ONLY by `cancel_agent` (desktop-gated); `AtomicBool`
// stays shared as the `AppState.cancels` value type. Split so mobile has no unused
// import. Inert on desktop (both names stay used). NB: list_dir uses the unrelated
// `std::cmp::Ordering` fully-qualified, so it does not keep this import alive.
#[cfg(desktop)]
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::db::{Db, SessionRow, UiMessage};
use crate::settings::Settings;

pub struct AppState {
    pub http: reqwest::Client,
    pub config_dir: PathBuf,
    pub settings: Arc<Mutex<Settings>>,
    pub db: Arc<Db>,
    pub cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub pending: permissions::Pending,
    /// Live subagents (the `task` tool), keyed by agent id, so the agents panel can
    /// Stop one without the rest. DESKTOP-ONLY — only the desktop runs the agent
    /// loop that spawns subagents; the phone is a pure remote client.
    #[cfg(desktop)]
    pub agents: agents::Agents,
    /// Live background `shell` tasks, keyed by task id, so a session Stop can kill
    /// the ones it launched. DESKTOP-ONLY — only the desktop runs the agent loop.
    #[cfg(desktop)]
    pub background: background::Background,
    /// Serializes OAuth token refreshes so concurrent agent turns don't each
    /// hit the token endpoint (single-flight). Guards no data — held only for
    /// the duration of a refresh.
    pub oauth_refresh: Arc<tokio::sync::Mutex<()>>,
    /// The phone's live remote-control session, when connected. Holds the
    /// command-injection sender + the session task handle; `None` when not
    /// connected. The `std::sync::Mutex` guard is only ever held across cheap
    /// synchronous ops (take/replace/send) and never across an await, so the
    /// async commands stay `Send` (see transport.rs:63-68 for the discipline).
    pub phone_client: Arc<Mutex<Option<sync::client::PhoneClientConn>>>,
    /// The live iroh endpoint the desktop SYNC SERVER is listening on, shared so
    /// `phone_sync_begin_pairing` can advertise its FULL current address (relay URL
    /// and direct socket addrs, not just the node id). `None` until `start_listener`
    /// binds it at startup (and on mobile, which never listens). Written once by
    /// `start_listener`; read by the pairing command. The `std::sync::Mutex` guard
    /// is only ever held across cheap synchronous ops (set / clone-out) and never
    /// across an await — same discipline as `phone_client` (see transport.rs:63-68).
    #[cfg_attr(mobile, allow(dead_code))]
    pub listen_endpoint: Arc<Mutex<Option<iroh::Endpoint>>>,
    /// Desktop-side device-trust gate: the bounded pairing window + the pending
    /// new-device confirmations. Shared between the pairing commands, the accept
    /// loop, and `serve_connection`. DESKTOP-ONLY — the phone is a pure client and
    /// never gates an inbound peer.
    #[cfg(desktop)]
    pub pairing_gate: Arc<sync::pairing_gate::PairingGate>,
}

// ── settings & secrets ───────────────────────────────────────────────────────

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    let mut s = state.settings.lock().unwrap().clone();
    s.api_key_set = secrets::has_api_key();
    s
}

#[tauri::command]
fn save_settings(state: State<AppState>, settings: Value) -> Settings {
    {
        let mut s = state.settings.lock().unwrap();
        if let Some(p) = settings.get("provider").and_then(|v| v.as_str()) {
            s.provider = p.to_string();
        }
        if let Some(m) = settings.get("model").and_then(|v| v.as_str()) {
            s.model = m.to_string();
        }
        if let Some(p) = settings.get("defaultPolicy").and_then(|v| v.as_str()) {
            s.default_policy = p.to_string();
        }
        if settings.get("workspace").is_some() {
            s.workspace = settings
                .get("workspace")
                .and_then(|v| v.as_str())
                .map(|x| x.to_string());
        }
        if let Some(t) = settings.get("typingAnimation").and_then(|v| v.as_bool()) {
            s.typing_animation = t;
        }
        // Permission mode + rules. Parse defensively: an unknown mode or a
        // malformed rule list is IGNORED (keep the prior, safer value) rather than
        // coerced — a bad save must never silently downgrade the permission gate.
        if let Some(v) = settings.get("permissionMode") {
            if let Ok(mode) = serde_json::from_value::<permissions::PermissionMode>(v.clone()) {
                s.permission_mode = mode;
            }
        }
        if let Some(v) = settings.get("rules") {
            if let Ok(rules) = serde_json::from_value::<Vec<permissions::Rule>>(v.clone()) {
                s.rules = rules;
            }
        }
        s.save(&state.config_dir);
    }
    get_settings(state)
}

#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
    secrets::set_api_key(&key)
}

// ── subscription OAuth ───────────────────────────────────────────────────────

/// Sign-in state for the frontend. `expires_at` is unix seconds; `account` is the
/// signed-in email and `tier` a display label ("Claude Max" / "Claude Pro") —
/// both best-effort from the OAuth profile, so either may be `None`.
// DESKTOP-ONLY: the subscription-OAuth surface (`oauth.rs` is mobile-excluded).
#[cfg(desktop)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthStatus {
    signed_in: bool,
    expires_at: Option<i64>,
    account: Option<String>,
    tier: Option<String>,
}

/// Map a stored plan code (`"max"` / `"pro"`) to a user-facing tier label.
#[cfg(desktop)]
fn tier_label(plan: Option<&str>) -> Option<String> {
    match plan {
        Some("max") => Some("Claude Max".to_string()),
        Some("pro") => Some("Claude Pro".to_string()),
        _ => None,
    }
}

#[cfg(desktop)]
fn current_oauth_status() -> OAuthStatus {
    match secrets::get_oauth() {
        Some(t) => OAuthStatus {
            signed_in: true,
            expires_at: Some(t.expires_at),
            account: t.email,
            tier: tier_label(t.plan.as_deref()),
        },
        None => OAuthStatus {
            signed_in: false,
            expires_at: None,
            account: None,
            tier: None,
        },
    }
}

/// Run the interactive subscription sign-in (loopback OAuth + PKCE), store the
/// resulting tokens, and return the new status.
#[cfg(desktop)]
#[tauri::command]
async fn start_oauth_login(state: State<'_, AppState>) -> Result<OAuthStatus, String> {
    let http = state.http.clone();
    let tokens = oauth::run_loopback_login(&http).await?;
    secrets::set_oauth(&tokens)?;
    Ok(current_oauth_status())
}

/// Report whether a subscription sign-in is currently stored.
#[cfg(desktop)]
#[tauri::command]
fn oauth_status() -> Result<OAuthStatus, String> {
    Ok(current_oauth_status())
}

/// Forget the stored subscription tokens (sign out). Idempotent.
#[cfg(desktop)]
#[tauri::command]
fn oauth_logout() -> Result<(), String> {
    secrets::clear_oauth()
}

// ── sessions ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn list_sessions(state: State<AppState>) -> Vec<SessionRow> {
    state.db.list_sessions().unwrap_or_default()
}

#[tauri::command]
fn create_session(
    state: State<AppState>,
    id: String,
    title: Option<String>,
    workspace: Option<String>,
) -> Result<(), String> {
    state
        .db
        .create_session(
            &id,
            title.as_deref().unwrap_or("New chat"),
            workspace.as_deref(),
            db::now_ms(),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_session(state: State<AppState>, id: String, title: String) -> Result<(), String> {
    state
        .db
        .rename_session(&id, &title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_session(state: State<AppState>, id: String) -> Result<(), String> {
    state.db.delete_session(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_messages(state: State<AppState>, session_id: String) -> Vec<UiMessage> {
    state.db.ui_messages(&session_id)
}

// ── workspace file tree ──────────────────────────────────────────────────────

// DESKTOP-ONLY: the workspace file-tree capability must not exist on the phone
// (no filesystem browsing of the desktop's workspace from a remote client).
#[cfg(desktop)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[cfg(desktop)]
const IGNORED: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".DS_Store",
    "Thumbs.db",
];

/// List immediate children of a workspace-relative directory (lazy tree).
#[cfg(desktop)]
#[tauri::command]
fn list_dir(state: State<AppState>, sub: Option<String>) -> Result<Vec<DirEntry>, String> {
    let ws = state.settings.lock().unwrap().workspace.clone();
    let base = ws
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let base = base
        .canonicalize()
        .map_err(|e| format!("workspace unavailable: {e}"))?;

    let target = match &sub {
        Some(s) if !s.is_empty() => base.join(s),
        _ => base.clone(),
    };
    let target = target
        .canonicalize()
        .map_err(|e| format!("cannot access: {e}"))?;
    if !target.starts_with(&base) {
        return Err("path is outside the workspace".into());
    }

    let rd = std::fs::read_dir(&target).map_err(|e| e.to_string())?;
    let mut entries: Vec<DirEntry> = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if IGNORED.contains(&name.as_str()) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let rel = entry
            .path()
            .strip_prefix(&base)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());
        entries.push(DirEntry {
            name,
            path: rel,
            is_dir,
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

// ── agent ────────────────────────────────────────────────────────────────────

// DESKTOP-ONLY: drives `agent::run` (the agent loop + shell/fs tools), which is
// mobile-excluded. The phone issues turns via `phone_sync_send_command` over the
// encrypted channel to a paired desktop; it never runs the agent locally.
#[cfg(desktop)]
#[tauri::command]
async fn run_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    let http = state.http.clone();
    let settings = state.settings.clone();
    let db = state.db.clone();
    let cancels = state.cancels.clone();
    let pending = state.pending.clone();
    let agents = state.agents.clone();
    let background = state.background.clone();
    let oauth_refresh = state.oauth_refresh.clone();

    // Run in the background so the command returns immediately and the frontend
    // can register its cancel handle before the run finishes.
    tauri::async_runtime::spawn(async move {
        agent::run(
            app,
            http,
            settings,
            db,
            cancels,
            pending,
            agents,
            background,
            oauth_refresh,
            session_id,
            text,
        )
        .await;
    });
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn cancel_agent(state: State<AppState>, session_id: String) {
    if let Some(flag) = state.cancels.lock().unwrap().get(&session_id) {
        flag.store(true, Ordering::Relaxed);
    }
    // A session-wide Stop also cancels every subagent the run launched...
    agents::cancel_session(&state.agents, &session_id);
    // ...and kills its background tasks.
    background::cancel_session(&state.background, &session_id);
    permissions::deny_all(&state.pending, &session_id);
}

/// Stop ONE subagent (and its descendants) from the agents panel, leaving the rest
/// of the session — including the top-level turn — running.
#[cfg(desktop)]
#[tauri::command]
fn cancel_agent_by_id(state: State<AppState>, agent_id: String) {
    agents::cancel_one(&state.agents, &agent_id);
}

#[cfg(desktop)]
#[tauri::command]
fn resolve_permission(state: State<AppState>, id: String, decision: String) {
    let d = if decision == "allow" {
        permissions::Decision::Allow
    } else {
        permissions::Decision::Deny
    };
    permissions::resolve(&state.pending, &id, d);
}

// ── Phone Sync (Phase 1b: identity + pairing surface) ────────────────────────

/// Pairing/identity snapshot for the frontend.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PhoneSyncStatus {
    /// base64 of this desktop's long-term Noise static public key.
    device_public_key: String,
    paired: Vec<db::PairedDevice>,
}

/// Report this device's identity (creating it on first call) plus paired devices.
#[tauri::command]
fn phone_sync_status(state: State<AppState>) -> Result<PhoneSyncStatus, String> {
    use base64::Engine as _;
    let identity = sync::pairing::device_identity()?;
    Ok(PhoneSyncStatus {
        device_public_key: base64::engine::general_purpose::STANDARD.encode(&identity.public),
        paired: state.db.list_paired_devices(),
    })
}

/// Begin a pairing attempt; returns the QR payload to display. When the SYNC
/// SERVER is already listening (the normal case — startup binds it), the QR carries
/// the endpoint's FULL CURRENT address (node id + relay URL + discovered direct
/// socket addrs), read fresh on each call, so a phone dials immediately, including
/// from outside the home network. Falls back to the identity-only address (n0 DNS
/// discovery) if pairing is requested before the listener has bound.
// DESKTOP-ONLY: only the desktop advertises a QR. The phone SCANS it
// (`phone_sync_connect`); it never begins pairing, so this is omitted from the
// mobile handler.
#[cfg(desktop)]
#[tauri::command]
fn phone_sync_begin_pairing(
    state: State<AppState>,
) -> Result<sync::pairing::PairingPayload, String> {
    use rand::RngCore as _;

    // Snapshot the live address under the lock, then DROP the guard before building
    // the payload — keep the critical section to a synchronous `ep.addr()` call.
    // `Endpoint::addr()` returns the CURRENT full EndpointAddr (sync — see
    // transport.rs:304).
    let live_addr: Option<iroh::EndpointAddr> = {
        let slot = state
            .listen_endpoint
            .lock()
            .map_err(|_| "listen_endpoint lock poisoned".to_string())?;
        slot.as_ref().map(|ep| ep.addr())
    };

    // Build the payload AND open the device-trust pairing window with the SAME
    // nonce: only while this bounded window is open does the accept loop entertain
    // a NEW (untrusted) peer, and the nonce is bound into the handshake prologue so
    // a phone that scanned a different/stale QR fails the handshake. Generating the
    // nonce here lets us register it on the gate.
    let identity = sync::pairing::device_identity()?;
    let mut nonce = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut nonce);

    let payload = match live_addr {
        // Same identity + this nonce, but the node_addr is the live full address
        // instead of identity-only.
        Some(addr) => sync::pairing::PairingPayload::new(&identity.public, &nonce, addr),
        // Listener not bound yet (e.g. bind still in flight) → identity-only QR
        // (still dialable via n0 discovery).
        None => sync::pairing::PairingPayload::new(
            &identity.public,
            &nonce,
            sync::pairing::iroh_node_addr()?,
        ),
    };

    // Arm the bounded pairing window with this nonce. A phone must scan + complete
    // the handshake within the window TTL (and the desktop user must confirm its
    // SAS) before any command surface is served.
    state.pairing_gate.open_window(nonce.to_vec());

    Ok(payload)
}

/// Forget a paired device by its base64 public key. Idempotent. (The device list
/// itself comes from `phone_sync_status` — no separate list command.)
#[tauri::command]
fn phone_sync_unpair(state: State<AppState>, public_key: String) -> Result<(), String> {
    state
        .db
        .remove_paired_device(&public_key)
        .map_err(|e| e.to_string())
}

/// Confirm a pending new-device pairing the desktop UI surfaced (the user
/// compared the SAS shown in the `phone-sync://pairing-request` event and
/// accepted). Persists the peer's static key as CONFIRMED-trusted, then releases
/// the awaiting `serve_connection` so it serves the device. Idempotent: an
/// unknown/expired request id is a no-op (the connection already timed out).
// DESKTOP-ONLY: the device-trust gate lives on the SYNC SERVER. The phone never
// confirms an inbound peer.
#[cfg(desktop)]
#[tauri::command]
fn confirm_pairing(state: State<AppState>, request_id: String) -> Result<(), String> {
    // `resolve_pending(true)` removes the pending entry, returns the peer key, and
    // signals the awaiting `serve_connection` (which then serves THIS connection
    // because the user accepted — it does not re-read the DB). We persist the key as
    // confirmed here so the NEXT reconnect is auto-served without re-confirmation;
    // persisting in this command (rather than in serve_connection) also keeps the
    // confirm durable even if the connection raced away after we signalled it.
    if let Some(peer_key_b64) = state.pairing_gate.resolve_pending(&request_id, true) {
        state
            .db
            .confirm_paired_device(&peer_key_b64, "Phone", db::now_ms())
            .map_err(|e| e.to_string())?;
        // Single-use: a successful confirm consumes the pairing window so a stale QR
        // can't admit a second unsolicited device.
        state.pairing_gate.close_window();
    }
    Ok(())
}

/// Reject a pending new-device pairing (the SAS did not match, or the user
/// declined). Drops the connection without serving it. Idempotent.
// DESKTOP-ONLY: see `confirm_pairing`.
#[cfg(desktop)]
#[tauri::command]
fn reject_pairing(state: State<AppState>, request_id: String) {
    state.pairing_gate.resolve_pending(&request_id, false);
}

/// Start the Phone Sync listener: bind an iroh endpoint under this device's
/// persisted node identity and accept inbound phone connections, pairing +
/// serving each. Returns immediately; the accept loop runs in the background for
/// the life of the app.
///
/// Startup already starts the listener (see `start_listener` in `setup`), so this
/// command is now an idempotent backstop — it no-ops if the endpoint is already
/// bound, so a stray frontend `invoke("phone_sync_listen")` never double-binds the
/// socket.
// DESKTOP-ONLY: this is the always-on SYNC SERVER (accept loop). It builds
// `sync::server::DesktopCommandHandler` (mobile-excluded with `agent`). The phone
// is the CLIENT (`phone_sync_connect`), so it never listens/serves.
#[cfg(desktop)]
#[tauri::command]
fn phone_sync_listen(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    // Already listening? No-op. Check the slot WITHOUT holding the guard across the
    // start_listener call (lock-read-drop); the guard is released at the `}`.
    {
        if state
            .listen_endpoint
            .lock()
            .map_err(|_| "listen_endpoint lock poisoned".to_string())?
            .is_some()
        {
            return Ok(());
        }
    }
    start_listener(
        app.clone(),
        state.http.clone(),
        state.settings.clone(),
        state.db.clone(),
        state.cancels.clone(),
        state.pending.clone(),
        state.agents.clone(),
        state.background.clone(),
        state.oauth_refresh.clone(),
        state.listen_endpoint.clone(),
        state.pairing_gate.clone(),
    )
}

/// Serve one paired phone: persist it, run catch-up over the full-duplex channel,
/// then split and run live-forward + command-intake concurrently until either ends.
// DESKTOP-ONLY: not a command — the per-connection task body for `phone_sync_listen`
// (its only caller). References `sync::server::DesktopCommandHandler`, so it is
// gated together with the server.
#[cfg(desktop)]
async fn serve_connection(
    app: AppHandle,
    db: Arc<Db>,
    handler: sync::server::DesktopCommandHandler,
    pairing_gate: Arc<sync::pairing_gate::PairingGate>,
    mut paired: sync::transport::Paired,
) {
    use base64::Engine as _;
    use sync::pairing_gate::ServeDecision;
    use sync::protocol::{Cursor, SyncFrame};
    use tauri::Emitter as _;

    // On the first-pairing (`Prompt`) path the desktop reads the phone's early
    // `Hello` itself while watching for a `PairingReject` (see below), so by the
    // time catch-up runs the `Hello` is already consumed. Stash its cursors here so
    // catch-up answers them via `serve_catch_up_with_cursors` instead of re-reading
    // a `Hello` that will never come again. `None` on the already-trusted `Serve`
    // path, where `serve_catch_up` reads the `Hello` normally.
    let mut prefetched_cursors: Option<Vec<Cursor>> = None;

    // ── DEVICE-TRUST GATE ────────────────────────────────────────────────────
    // Completing the keyless XX handshake does NOT authorize a peer. Identify the
    // peer by its pinned Noise static key; an absent key (malformed handshake) is
    // never served.
    let Some(peer) = paired.peer_static.clone() else {
        eprintln!("phone-sync: connection had no pinned static key — refusing");
        return;
    };
    let pk = base64::engine::general_purpose::STANDARD.encode(&peer);

    match sync::pairing_gate::serve_decision(
        db.is_device_confirmed(&pk),
        pairing_gate.window_is_open(),
    ) {
        // Already-trusted device: refresh its row (confirmed stays set) and serve.
        ServeDecision::Serve => {
            let _ = db.add_paired_device(&pk, "Phone", db::now_ms());
        }
        // Untrusted peer, no pairing window open → drop before any dispatch. Emit
        // nothing (no spurious prompt for a random off-LAN dialer).
        ServeDecision::Drop => {
            eprintln!("phone-sync: untrusted device connected outside a pairing window — dropping");
            return;
        }
        // Untrusted peer inside an open window → register a pending request, surface
        // the SAS to the desktop UI, and await the user's decision (bounded). On
        // confirm the command persists the key as confirmed; on reject/timeout we
        // drop without serving (no catch-up, no command loop).
        ServeDecision::Prompt => {
            let request_id = uuid::Uuid::new_v4().to_string();
            let rx = match pairing_gate.register_pending(request_id.clone(), pk.clone()) {
                Ok(rx) => rx,
                Err(e) => {
                    eprintln!("phone-sync: could not register pending pairing: {e}");
                    return;
                }
            };
            let _ = app.emit(
                "phone-sync://pairing-request",
                serde_json::json!({
                    "requestId": request_id,
                    "sas": paired.sas.clone(),
                    "peerKeyHex": pk,
                }),
            );

            // Await the desktop user's decision, but ALSO watch the channel: the
            // phone sends its catch-up `Hello` as soon as the handshake completes
            // (before either side confirms the SAS), and the phone user can decline
            // — sending a `PairingReject` — while we're parked on this prompt. So we
            // loop, selecting the decision against an inbound frame:
            //   * `Hello`         → stash its cursors and keep waiting (this is the
            //                       catch-up kickoff, consumed here so catch-up uses
            //                       `serve_catch_up_with_cursors` afterward);
            //   * `PairingReject` → the phone declined: stop waiting, drop promptly
            //                       (no 60s park), no outbound reject (phone knows);
            //   * any other frame / error / close → protocol violation or a dead
            //                       connection: stop waiting and drop.
            // `desktop_rejected` records whether WE (the desktop user) declined, so
            // we can tell the phone afterward.
            let decision_fut =
                tokio::time::timeout(sync::pairing_gate::PAIRING_CONFIRM_TIMEOUT, rx);
            tokio::pin!(decision_fut);
            let mut desktop_rejected = false;
            let confirmed = loop {
                tokio::select! {
                    decision = &mut decision_fut => break match decision {
                        // The user confirmed: `confirm_pairing` already persisted the
                        // key as confirmed before resolving this oneshot.
                        Ok(Ok(true)) => true,
                        // The user rejected — note it so we send the phone a reject.
                        Ok(Ok(false)) => {
                            desktop_rejected = true;
                            false
                        }
                        // The sender was dropped (forgotten) — do not serve.
                        Ok(Err(_)) => false,
                        // Timed out — clean up the pending entry and do not serve.
                        Err(_) => {
                            pairing_gate.forget_pending(&request_id);
                            false
                        }
                    },
                    inbound = paired.channel.recv_frame() => match inbound {
                        // The phone's early catch-up kickoff: keep its cursors and
                        // keep waiting for the desktop user's decision.
                        Ok(SyncFrame::Hello { cursors, .. }) => {
                            prefetched_cursors = Some(cursors);
                        }
                        // The phone declined: drop now instead of parking 60s. No
                        // outbound reject — the phone already knows + is tearing down.
                        Ok(SyncFrame::PairingReject { .. }) => {
                            eprintln!("phone-sync: phone rejected pairing — dropping connection");
                            pairing_gate.forget_pending(&request_id);
                            break false;
                        }
                        Ok(other) => {
                            eprintln!(
                                "phone-sync: unexpected frame before pairing confirmed: \
                                 {other:?} — dropping connection"
                            );
                            pairing_gate.forget_pending(&request_id);
                            break false;
                        }
                        Err(e) => {
                            eprintln!(
                                "phone-sync: connection ended while awaiting pairing: {e} \
                                 — dropping connection"
                            );
                            pairing_gate.forget_pending(&request_id);
                            break false;
                        }
                    },
                }
            };
            if !confirmed {
                // If WE declined, tell the phone before dropping so it surfaces the
                // decline instead of a bare disconnect. Best-effort: a send failure
                // (channel already gone) is logged, not fatal — we drop either way.
                if desktop_rejected {
                    if let Err(e) = paired
                        .channel
                        .send_frame(&SyncFrame::PairingReject {
                            reason: Some("declined".into()),
                        })
                        .await
                    {
                        eprintln!("phone-sync: failed to send reject to phone: {e}");
                    }
                }
                eprintln!("phone-sync: pairing not confirmed — dropping connection");
                return;
            }
        }
    }

    // Subscribe BEFORE catch-up so no live event emitted during the catch-up
    // window is lost. The broadcast ring (capacity 1024) buffers any frames
    // published while catch-up is in progress; `forward_live` drains them after
    // the full-duplex channel is split. Frames that are both in the catch-up
    // delta AND in the live buffer are harmless duplicates (phone reconciles by
    // seq). Resolve the hub from `app` here so no State borrow escapes this fn.
    let mut hub_rx = match app.try_state::<sync::SyncHub>() {
        Some(hub) => hub.subscribe(),
        None => {
            eprintln!("phone-sync: SyncHub missing from managed state");
            return;
        }
    };

    // Catch-up runs on the full-duplex channel (SecureChannel: FrameChannel). If the
    // first-pairing path already consumed the phone's `Hello` (while watching for a
    // reject), answer the stashed cursors directly; otherwise read the `Hello` here
    // (the already-trusted reconnect path).
    let catch_up = match prefetched_cursors {
        Some(cursors) => {
            sync::session::serve_catch_up_with_cursors(&mut paired.channel, &db, cursors).await
        }
        None => sync::session::serve_catch_up(&mut paired.channel, &db).await,
    };
    if let Err(e) = catch_up {
        eprintln!("phone-sync: catch-up failed: {e}");
        return;
    }

    let (mut sender, mut receiver) = paired.channel.split();

    let mut live = tauri::async_runtime::spawn(async move {
        let _ = sync::session::forward_live(&mut hub_rx, &mut sender).await;
    });
    // `handler` and `receiver` MUST share one task: handle_commands borrows `&handler`.
    let mut cmds = tauri::async_runtime::spawn(async move {
        let _ = sync::session::handle_commands(&mut receiver, &handler).await;
    });

    // Run both halves until EITHER ends, then cancel the other. `handle_commands`
    // reliably returns when the phone disconnects (its recv stream errors), but
    // `forward_live` can be parked on `hub.recv()` with no traffic to reveal the
    // dead connection — so `tokio::join!`-ing both would hang forever on an idle
    // disconnect, leaking the live task and the QUIC connection it pins. Cancelling
    // the survivor on the first completion frees the connection promptly.
    tokio::select! {
        _ = &mut live => { cmds.abort(); }
        _ = &mut cmds => { live.abort(); }
    }
}

/// Bind the iroh endpoint under this device's persisted node identity, publish the
/// live endpoint into `AppState.listen_endpoint` (so the pairing QR can advertise
/// its full address), and run the accept loop, serving each paired phone. Spawns a
/// detached background task and returns immediately.
// DESKTOP-ONLY: the always-on SYNC SERVER. Builds `sync::server::DesktopCommandHandler`
// (mobile-excluded). Takes OWNED clones — `State<'_>` is borrow-scoped and must not
// cross into the spawn. Called once from `setup` (startup) and from the idempotent
// `phone_sync_listen` backstop.
#[cfg(desktop)]
// 9 params (the AppState pieces the accept loop needs as owned clones, plus the
// shared `listen_endpoint` and `pairing_gate`) > clippy's 7-arg threshold; same
// pattern + allow as `agent::run`. Bundling them into a struct buys nothing here —
// they are already the `AppState` fields, threaded through once.
#[allow(clippy::too_many_arguments)]
fn start_listener(
    app: AppHandle,
    http: reqwest::Client,
    settings: Arc<Mutex<Settings>>,
    db: Arc<Db>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pending: permissions::Pending,
    agents: agents::Agents,
    background: background::Background,
    oauth_refresh: Arc<tokio::sync::Mutex<()>>,
    listen_endpoint: Arc<Mutex<Option<iroh::Endpoint>>>,
    pairing_gate: Arc<sync::pairing_gate::PairingGate>,
) -> Result<(), String> {
    // App-layer (Noise) pairing identity — the key phones pin.
    let device = sync::pairing::device_identity()?;
    // Transport (iroh node) identity — persisted so the node id is stable.
    let secret_key = secrets::get_or_create_iroh_key()?;

    let handler = sync::server::DesktopCommandHandler {
        app: app.clone(),
        http,
        settings,
        db: db.clone(),
        cancels,
        pending,
        agents,
        background,
        oauth_refresh,
    };
    let app_for_loop = app.clone();

    // `device` (the long-term Noise identity) is MOVED into the task below (by the
    // `async move`) and its private key is BORROWED at each `accept_and_pair` call —
    // we never take a `.to_vec()` heap copy of the secret (which would linger
    // un-zeroized in freed heap until reuse). `StaticKeypair` zeroizes its private
    // half on drop, so the only copy lives for the task's lifetime and is wiped on
    // exit.
    tauri::async_runtime::spawn(async move {
        // Build the endpoint INSIDE the task so it is owned here and outlives every
        // `accept_and_pair(&endpoint, …)` borrow below. RelayMode::Default = relay +
        // hole-punch, so a phone can reach us from outside the home network.
        let endpoint =
            match sync::transport::build_endpoint(secret_key, iroh::RelayMode::Default).await {
                Ok(ep) => ep,
                Err(e) => {
                    eprintln!("phone-sync: failed to bind endpoint: {e}");
                    return;
                }
            };

        // Publish the live endpoint for the pairing command. Clone first (Endpoint
        // is Arc-backed), store the CLONE, keep the ORIGINAL owned by this task for
        // the accept loop. The guard lives in a `{}` with NO await inside and none
        // touching it after, so the std-mutex guard never crosses an await (keeps
        // this future Send).
        {
            match listen_endpoint.lock() {
                Ok(mut slot) => *slot = Some(endpoint.clone()),
                Err(_) => {
                    eprintln!("phone-sync: listen_endpoint mutex poisoned");
                    return;
                }
            }
        }

        loop {
            // Prologue policy (must mirror the phone's in `phone_sync_connect`):
            // bind the OPEN pairing window's nonce when one is open (a first pairing),
            // else an empty prologue (a confirmed device reconnecting outside any
            // window). A peer whose prologue doesn't match fails the handshake — so a
            // stale/forged QR can't even complete it during an open window. The nonce
            // is read by the closure only AFTER a phone has actually connected (inside
            // `accept_and_pair`, post-`accept`), so it captures the window open at
            // connect time — not a stale snapshot from while the loop was parked idle.
            let gate_for_nonce = pairing_gate.clone();
            let paired =
                match sync::transport::accept_and_pair(&endpoint, device.private_key(), || {
                    gate_for_nonce.active_nonce().unwrap_or_default()
                })
                .await
                {
                    Ok(p) => p,
                    Err(e) => {
                        if e == "endpoint closed" {
                            return; // socket gone → stop listening
                        }
                        eprintln!("phone-sync: pairing failed: {e}");
                        continue; // a transient/rejected pairing must not kill the loop
                    }
                };

            // Hand off to a per-connection task so the accept loop is free to take
            // the next phone. `handler.clone()` is cheap (all Arc/AppHandle).
            let handler = handler.clone();
            let db = db.clone();
            let app = app_for_loop.clone();
            let gate = pairing_gate.clone();
            tauri::async_runtime::spawn(async move {
                serve_connection(app, db, handler, gate, paired).await;
            });
        }
    });

    Ok(())
}

// ── Phone Sync (mobile CLIENT: connect + drive a paired desktop) ─────────────
//
// These are the phone's side of the protocol — the dual of the desktop listener
// above. They are SHARED (registered on both targets): the desktop can also act
// as a client, and they are exactly the commands the mobile app drives. Every
// path they touch (sync::client/pairing/transport/protocol + secrets/db) compiles
// on both targets, so they carry no `cfg` — only the handler list selects them.

/// Result of a successful client connect: the SAS to compare out-of-band and the
/// desktop's pinned public key the phone connected to.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectInfo {
    sas: String,
    peer_public_key: String,
}

/// Phone side: scan a desktop's pairing QR, dial + run the XX handshake, pin the
/// desktop's static key, and spawn the live session (relay inbound frames to the
/// UI via `phone-sync://frame`, forward UI commands to the desktop). Returns the
/// SAS + pinned key so the UI can show the out-of-band comparison string.
///
/// `reconnect` selects the handshake prologue, which must match the desktop
/// responder's:
///   * FIRST pairing (`reconnect = false`): bind the QR's nonce as the prologue.
///     The desktop has an OPEN pairing window carrying the same nonce, so the
///     handshake completes; a phone that scanned a different/stale QR fails.
///   * RECONNECT (`reconnect = true`): bind an EMPTY prologue. A confirmed device
///     reconnects when no pairing window is open, and the desktop responder uses an
///     empty prologue then — so the two match and the (already-trusted) device is
///     served without a fresh confirmation.
#[tauri::command]
async fn phone_sync_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    qr: String,
    reconnect: Option<bool>,
) -> Result<ConnectInfo, String> {
    use base64::Engine as _;
    // Clone the Arc slot BEFORE any await: `State<'_>` must not be held across an
    // await, and the spawned task needs an owned 'static handle to self-clear.
    let slot = state.phone_client.clone();

    // 1. Parse the QR payload (camelCase on the wire — serde handles it).
    let payload: sync::pairing::PairingPayload =
        serde_json::from_str(&qr).map_err(|e| e.to_string())?;
    // 2. Identities: iroh node key (transport) + Noise static (app-layer pin).
    let iroh_key = secrets::get_or_create_iroh_key()?;
    let identity = sync::pairing::device_identity()?;
    // 3. Bind a client endpoint (RelayMode::Default for hole-punch + relay).
    let endpoint = sync::transport::build_endpoint(iroh_key, iroh::RelayMode::Default).await?;
    // 4. Dial + run the XX initiator handshake. Prologue = the QR nonce for a first
    //    pairing (matches the desktop's open window), or empty on reconnect (matches
    //    the desktop's closed-window empty prologue). See the doc comment above.
    let prologue: Vec<u8> = if reconnect.unwrap_or(false) {
        Vec::new()
    } else {
        base64::engine::general_purpose::STANDARD
            .decode(&payload.nonce)
            .map_err(|e| e.to_string())?
    };
    let paired = sync::transport::connect_and_pair(
        &endpoint,
        payload.node_addr.clone(),
        identity.private_key(),
        &prologue,
    )
    .await?;
    // 5. PIN CHECK: the paired peer's Noise static must equal the QR's key.
    let expected = base64::engine::general_purpose::STANDARD
        .decode(&payload.public_key)
        .map_err(|e| e.to_string())?;
    match &paired.peer_static {
        Some(got) if *got == expected => {}
        _ => return Err("key mismatch".to_string()),
    }
    let info = ConnectInfo {
        sas: paired.sas.clone(),
        peer_public_key: payload.public_key.clone(),
    };
    // 6. Spawn the live session, but GATE it on installation: the task waits for
    //    `ready_rx` before doing any work, so it can never reach its self-clear tail
    //    before step 7 installs it (closing the spawn↔install race that would
    //    otherwise leave a dead connection installed = a permanent phantom
    //    "connected"). The task owns paired.channel (→ via split the
    //    Endpoint/Connection keep-alives) + app + rx + the slot Arc for self-clear.
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    // Identity token so the session task self-clears the slot only while it is
    // still the installed connection (guards the reconnect race).
    let token = Arc::new(());
    let task = tauri::async_runtime::spawn(sync::client::run_client_session(
        paired.channel,
        app.clone(),
        rx,
        slot.clone(),
        token.clone(),
        ready_rx,
    ));
    // 7. Install the new connection, tearing down any prior one. The lock scope is
    //    a `{ }` block with no await inside, and there is no await after it, so the
    //    std-mutex guard never crosses an await.
    {
        let mut guard = slot
            .lock()
            .map_err(|_| "phone client lock poisoned".to_string())?;
        if let Some(old) = guard.take() {
            old.task.abort();
        }
        *guard = Some(sync::client::PhoneClientConn {
            commands: tx,
            task,
            token,
        });
    }
    // 8. Release the gated session task now that it is installed — the self-clear
    //    can now only ever run against a slot that holds our token. A send error
    //    means a concurrent disconnect/reconnect already took the slot and aborted
    //    the task, which is harmless.
    let _ = ready_tx.send(());
    Ok(info)
    // `endpoint` drops here; harmless — the channel's Endpoint clone (now in the
    // task's ChannelSender) keeps the socket alive for the session.
}

/// Phone side: push one `RemoteCommand` to the live desktop session. Errors
/// "not connected" when there is no active session.
#[tauri::command]
fn phone_sync_send_command(
    state: State<AppState>,
    command: sync::protocol::RemoteCommand,
) -> Result<(), String> {
    let guard = state
        .phone_client
        .lock()
        .map_err(|_| "phone client lock poisoned".to_string())?;
    match guard.as_ref() {
        Some(conn) => conn
            .commands
            .send(command)
            .map_err(|_| "not connected".to_string()),
        None => Err("not connected".to_string()),
    }
}

/// Phone side: tear down the live desktop session. Dropping the command sender
/// ends the send loop → drops the `ChannelSender` → the QUIC connection closes →
/// the recv loop ends. Aborting the task is a backstop. Idempotent.
#[tauri::command]
fn phone_sync_disconnect(state: State<AppState>) -> Result<(), String> {
    let taken = {
        let mut guard = state
            .phone_client
            .lock()
            .map_err(|_| "phone client lock poisoned".to_string())?;
        guard.take()
    };
    if let Some(conn) = taken {
        drop(conn.commands); // ends send loop → drops ChannelSender → QUIC down
        conn.task.abort(); // belt-and-suspenders: ensure the task is gone
    }
    Ok(()) // no-op when nothing was connected
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Auto-updater (Phase 2 #1). Update checks are pull-only and verify the
        // Ed25519 signature in `latest.json` against `plugins.updater.pubkey`.
        // No update is fetched until application code explicitly calls the plugin,
        // so a placeholder pubkey is inert until the owner provisions a real key.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let _ = std::fs::create_dir_all(&dir);
            // Point the per-target secret store at the app-private config dir before
            // any AppState command can touch secrets. Inert no-op on Windows (keyring
            // is used); on Android/Linux the file backend writes secrets.json here.
            secrets::init_dir(dir.clone());

            let settings = Settings::load(&dir);
            // Bound connection establishment (DNS + TCP + TLS) so a turn or a token
            // refresh can't hang indefinitely before any byte arrives. We deliberately
            // do NOT set a blanket request `.timeout()` — that would kill long but
            // healthy streaming turns; the per-read idle timeout in `llm::stream_turn`
            // handles a stream that connects and then stalls.
            let http = reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("failed to build HTTP client");
            let db = Db::open(&dir.join("portcode.db")).expect("failed to open database");

            app.manage(AppState {
                http,
                config_dir: dir,
                settings: Arc::new(Mutex::new(settings)),
                db: Arc::new(db),
                cancels: Arc::new(Mutex::new(HashMap::new())),
                pending: Arc::new(Mutex::new(HashMap::new())),
                #[cfg(desktop)]
                agents: agents::new(),
                #[cfg(desktop)]
                background: background::new(),
                oauth_refresh: Arc::new(tokio::sync::Mutex::new(())),
                phone_client: Arc::new(Mutex::new(None)),
                listen_endpoint: Arc::new(Mutex::new(None)),
                #[cfg(desktop)]
                pairing_gate: Arc::new(sync::pairing_gate::PairingGate::new()),
            });
            // Phone Sync fan-out hub (Phase 0). The agent/llm `emit` helpers look
            // this up via `app.try_state` to mirror events; absent until managed,
            // so this must be registered during setup.
            app.manage(sync::SyncHub::new());

            // BUG 1 FIX: the desktop is the SYNC SERVER — auto-start the accept loop
            // at launch so a paired phone has something to connect to. (Previously
            // `phone_sync_listen` existed but was never invoked.) Desktop-only: the
            // phone is the CLIENT and never listens. Must run AFTER both `manage`
            // calls above — `serve_connection` resolves `SyncHub` via `app.try_state`.
            #[cfg(desktop)]
            {
                let state = app.state::<AppState>();
                if let Err(e) = start_listener(
                    app.handle().clone(),
                    state.http.clone(),
                    state.settings.clone(),
                    state.db.clone(),
                    state.cancels.clone(),
                    state.pending.clone(),
                    state.agents.clone(),
                    state.background.clone(),
                    state.oauth_refresh.clone(),
                    state.listen_endpoint.clone(),
                    state.pairing_gate.clone(),
                ) {
                    eprintln!("phone-sync: listener failed to start: {e}");
                }
            }
            Ok(())
        });

    // Native QR scanner for the phone's pairing screen (mobile only). Mirrors the
    // dialog/opener plugins above; the crate is gated to mobile in Cargo.toml
    // because the desktop advertises the pairing QR rather than scanning one.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    // The command surface differs by target, and `generate_handler!` cannot carry
    // per-item `cfg`, so shadow-rebind `builder` per target: EXACTLY ONE arm
    // compiles (tauri-build sets exactly one of `cfg(desktop)`/`cfg(mobile)`).
    //
    // DESKTOP — the full surface (byte-identical to the pre-split list): all
    // settings/sessions + OAuth + workspace file-tree + agent + the sync SERVER.
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_settings,
        save_settings,
        set_api_key,
        start_oauth_login,
        oauth_status,
        oauth_logout,
        list_sessions,
        create_session,
        rename_session,
        delete_session,
        get_messages,
        list_dir,
        run_agent,
        cancel_agent,
        cancel_agent_by_id,
        resolve_permission,
        phone_sync_status,
        phone_sync_begin_pairing,
        phone_sync_unpair,
        phone_sync_listen,
        phone_sync_connect,
        phone_sync_send_command,
        phone_sync_disconnect,
        confirm_pairing,
        reject_pairing
    ]);

    // MOBILE — the remote-CLIENT subset. Shared settings/secrets/sessions +
    // pairing-status/unpair + the phone CLIENT trio. OMITS the desktop-only
    // commands (the OAuth trio, list_dir, run_agent, cancel_agent,
    // resolve_permission, phone_sync_listen, phone_sync_begin_pairing) — none are
    // compiled on mobile, so naming them here would be an unresolved-name error.
    // (The phone SCANS a QR via `phone_sync_connect`; it never advertises one, so
    // `phone_sync_begin_pairing` is desktop-only.)
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_settings,
        save_settings,
        set_api_key,
        list_sessions,
        create_session,
        rename_session,
        delete_session,
        get_messages,
        phone_sync_status,
        phone_sync_unpair,
        phone_sync_connect,
        phone_sync_send_command,
        phone_sync_disconnect
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running Portcode");
}
