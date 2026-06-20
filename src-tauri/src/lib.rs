mod agent;
mod db;
mod llm;
mod oauth;
mod permissions;
mod secrets;
mod settings;
mod sync;
mod tools;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Serializes OAuth token refreshes so concurrent agent turns don't each
    /// hit the token endpoint (single-flight). Guards no data — held only for
    /// the duration of a refresh.
    pub oauth_refresh: Arc<tokio::sync::Mutex<()>>,
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
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthStatus {
    signed_in: bool,
    expires_at: Option<i64>,
    account: Option<String>,
    tier: Option<String>,
}

/// Map a stored plan code (`"max"` / `"pro"`) to a user-facing tier label.
fn tier_label(plan: Option<&str>) -> Option<String> {
    match plan {
        Some("max") => Some("Claude Max".to_string()),
        Some("pro") => Some("Claude Pro".to_string()),
        _ => None,
    }
}

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
#[tauri::command]
async fn start_oauth_login(state: State<'_, AppState>) -> Result<OAuthStatus, String> {
    let http = state.http.clone();
    let tokens = oauth::run_loopback_login(&http).await?;
    secrets::set_oauth(&tokens)?;
    Ok(current_oauth_status())
}

/// Report whether a subscription sign-in is currently stored.
#[tauri::command]
fn oauth_status() -> Result<OAuthStatus, String> {
    Ok(current_oauth_status())
}

/// Forget the stored subscription tokens (sign out). Idempotent.
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

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
            oauth_refresh,
            session_id,
            text,
        )
        .await;
    });
    Ok(())
}

#[tauri::command]
fn cancel_agent(state: State<AppState>, session_id: String) {
    if let Some(flag) = state.cancels.lock().unwrap().get(&session_id) {
        flag.store(true, Ordering::Relaxed);
    }
    permissions::deny_all(&state.pending);
}

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

/// Begin a pairing attempt; returns the QR payload to display.
#[tauri::command]
fn phone_sync_begin_pairing() -> Result<sync::pairing::PairingPayload, String> {
    sync::pairing::begin_pairing()
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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

            let settings = Settings::load(&dir);
            let http = reqwest::Client::builder()
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
                oauth_refresh: Arc::new(tokio::sync::Mutex::new(())),
            });
            // Phone Sync fan-out hub (Phase 0). The agent/llm `emit` helpers look
            // this up via `app.try_state` to mirror events; absent until managed,
            // so this must be registered during setup.
            app.manage(sync::SyncHub::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            resolve_permission,
            phone_sync_status,
            phone_sync_begin_pairing,
            phone_sync_unpair
        ])
        .run(tauri::generate_context!())
        .expect("error while running Portcode");
}
