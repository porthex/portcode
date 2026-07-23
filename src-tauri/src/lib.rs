// DESKTOP-ONLY Codex host — excluded from the mobile (phone = pure remote
// CLIENT) binary. `llm` stays SHARED: db/permissions/sync(protocol,mod)
// `use crate::llm::{Block, ChatMessage, StreamEvent}` in production code — those
// are the wire types the phone must decode — so gating `llm` would break mobile.
#[cfg(desktop)]
mod codex_app_server;
#[cfg(desktop)]
mod codex_engine;
// Cross-target crash-reporting consent flag (the on-disk opt-in). NOT cfg-gated: the
// desktop `telemetry` module re-uses it AND the mobile `telemetry_set_consent`
// command writes it (the Android `PortcodeApplication` reads the same flag before it
// ever calls `SentryAndroid.init`). Compiles on every target. See `consent.rs`.
mod consent;
mod db;
// The event-emission seam ([`EventSink`] + the production [`AppEventSink`]). The
// concrete `AppEventSink` is desktop-only (gated inside `events`).
mod events;
#[cfg(desktop)]
mod git;
#[cfg(desktop)]
mod git_review;
mod llm;
mod permissions;
#[cfg(desktop)]
mod plan_usage;
#[cfg(desktop)]
mod process_env;
mod scrub;
mod secrets;
mod settings;
mod sync;
#[cfg(desktop)]
mod telemetry;
mod tool_names;
// Auto-updater command surface (desktop only — the phone is a remote client and
// never self-updates). The whole module is `#![cfg(desktop)]` internally too.
#[cfg(desktop)]
mod update;
#[cfg(desktop)]
mod workspace;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::db::{Db, DraftRow, SearchHit, SessionRow, UiMessage, UiMessagePage, UsageRow};
use crate::settings::Settings;

pub struct AppState {
    pub config_dir: PathBuf,
    pub settings: Arc<Mutex<Settings>>,
    pub db: Arc<Db>,
    /// The real Codex app-server owns every GPT agent turn. Portcode retains
    /// only the session mapping, event projection, and product UI around it.
    #[cfg(desktop)]
    pub codex: Arc<codex_engine::CodexEngine>,
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
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(state: State<AppState>, settings: Value) -> Result<Settings, String> {
    // Serialize the whole disk transaction. Two concurrent partial patches must
    // not clone the same base and silently lose whichever commit finishes first.
    let mut current = state
        .settings
        .lock()
        .map_err(|_| "Settings are temporarily unavailable.".to_string())?;
    let mut candidate = current.clone();
    if let Some(p) = settings.get("provider").and_then(|v| v.as_str()) {
        candidate.provider = p.to_string();
    }
    if let Some(m) = settings.get("model").and_then(|v| v.as_str()) {
        candidate.model = m.to_string();
    }
    if let Some(effort) = settings.get("reasoningEffort").and_then(|v| v.as_str()) {
        candidate.reasoning_effort = effort.to_string();
    }
    if let Some(speed) = settings.get("responseSpeed").and_then(|v| v.as_str()) {
        if matches!(speed, "standard" | "fast") {
            candidate.response_speed = speed.to_string();
        }
    }
    if let Some(p) = settings.get("defaultPolicy").and_then(|v| v.as_str()) {
        candidate.default_policy = p.to_string();
    }
    if settings.get("workspace").is_some() {
        candidate.workspace = settings
            .get("workspace")
            .and_then(|v| v.as_str())
            .map(|x| x.to_string());
    }
    if let Some(t) = settings.get("typingAnimation").and_then(|v| v.as_bool()) {
        candidate.typing_animation = t;
    }
    // Permission mode + rules. Parse defensively: an unknown mode or a
    // malformed rule list is IGNORED (keep the prior, safer value) rather than
    // coerced — a bad save must never silently downgrade the permission gate.
    if let Some(v) = settings.get("permissionMode") {
        if let Ok(mode) = serde_json::from_value::<permissions::PermissionMode>(v.clone()) {
            candidate.permission_mode = mode;
        }
    }
    if let Some(v) = settings.get("rules") {
        if let Ok(rules) = serde_json::from_value::<Vec<permissions::Rule>>(v.clone()) {
            candidate.rules = rules;
        }
    }
    if let Some(b) = settings.get("autoUpdate").and_then(|v| v.as_bool()) {
        candidate.auto_update = b;
    }
    persist_settings_candidate(&mut current, candidate.clone(), &state.config_dir)?;
    drop(current);

    Ok(candidate)
}

fn persist_settings_candidate(
    current: &mut Settings,
    candidate: Settings,
    config_dir: &std::path::Path,
) -> Result<(), String> {
    let save_result = candidate.save(config_dir);
    finish_settings_transaction(current, candidate, save_result)
}

fn finish_settings_transaction(
    current: &mut Settings,
    candidate: Settings,
    save_result: Result<(), settings::SettingsSaveError>,
) -> Result<(), String> {
    match save_result {
        Ok(()) => {
            *current = candidate;
            Ok(())
        }
        Err(error) if error.candidate_is_committed() => {
            // The destination already contains the candidate. Keep runtime and
            // disk policy consistent, but return the coded durability warning so
            // the frontend reconciles and does not present this as a clean save.
            *current = candidate;
            Err(error.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod settings_command_transaction_tests {
    use super::*;

    #[test]
    fn successful_persist_commits_memory_and_disk_together() {
        let dir = tempfile::tempdir().unwrap();
        let mut current = Settings::default();
        let candidate = Settings {
            provider: "openai".into(),
            model: "gpt-5.6-sol".into(),
            response_speed: "fast".into(),
            ..current.clone()
        };

        persist_settings_candidate(&mut current, candidate, dir.path()).unwrap();

        let reloaded = Settings::load(dir.path());
        assert_eq!(current.provider, "openai");
        assert_eq!(current.model, "gpt-5.6-sol");
        assert_eq!(current.response_speed, "fast");
        assert_eq!(reloaded.provider, current.provider);
        assert_eq!(reloaded.model, current.model);
        assert_eq!(reloaded.response_speed, current.response_speed);
    }

    #[test]
    fn failed_persist_leaves_live_memory_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let config_file = root.path().join("not-a-directory");
        std::fs::write(&config_file, b"occupied").unwrap();
        let mut current = Settings {
            model: "committed-model".into(),
            ..Settings::default()
        };
        let candidate = Settings {
            model: "must-not-commit".into(),
            ..current.clone()
        };

        let error = persist_settings_candidate(&mut current, candidate, &config_file)
            .expect_err("an unwritable settings directory must reject the transaction");

        assert!(error.contains("failed to create settings directory"));
        assert_eq!(current.model, "committed-model");
        assert_eq!(std::fs::read(&config_file).unwrap(), b"occupied");
    }

    #[test]
    fn committed_but_unconfirmed_save_updates_memory_and_surfaces_warning() {
        let mut current = Settings {
            model: "old-model".into(),
            ..Settings::default()
        };
        let candidate = Settings {
            model: "candidate-model".into(),
            ..current.clone()
        };

        let error = finish_settings_transaction(
            &mut current,
            candidate,
            Err(settings::SettingsSaveError::CommittedDurabilityUnconfirmed(
                "injected sync failure".into(),
            )),
        )
        .expect_err("durability uncertainty must be surfaced");

        assert!(error.starts_with(settings::COMMITTED_DURABILITY_UNCONFIRMED_PREFIX));
        assert_eq!(current.model, "candidate-model");
    }

    #[test]
    fn unknown_commit_state_keeps_the_running_policy_unchanged() {
        let mut current = Settings {
            model: "old-model".into(),
            ..Settings::default()
        };
        let candidate = Settings {
            model: "candidate-model".into(),
            ..current.clone()
        };

        finish_settings_transaction(
            &mut current,
            candidate,
            Err(settings::SettingsSaveError::StateUnknown(
                "injected verification failure".into(),
            )),
        )
        .expect_err("unknown state must be surfaced");

        assert_eq!(current.model, "old-model");
    }
}

// ── Codex authentication ─────────────────────────────────────────────────────

/// Display-safe authentication state for the frontend. Codex owns the actual
/// ChatGPT or API-key credential; Portcode receives only account metadata.
#[cfg(desktop)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthStatus {
    /// Whether this authentication capability is enabled by the current build
    /// and runtime policy. A disabled provider reports signed_out even if an old
    /// credential remains stored, so UI controls cannot imply it is usable.
    available: bool,
    unavailable_reason: Option<String>,
    signed_in: bool,
    expires_at: Option<i64>,
    account: Option<String>,
    tier: Option<String>,
}

#[cfg(desktop)]
fn openai_tier_label(plan: Option<&str>) -> Option<String> {
    plan.map(|plan| {
        let mut chars = plan.chars();
        let title = chars
            .next()
            .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
            .unwrap_or_default();
        format!("ChatGPT {title}")
    })
}

#[cfg(desktop)]
#[tauri::command]
async fn list_openai_accounts(
    state: State<'_, AppState>,
) -> Result<Vec<CodexAccountSummary>, String> {
    let account = state.codex.account(false).await?;
    Ok(codex_account_summary(&account).into_iter().collect())
}

#[cfg(desktop)]
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexAccountSummary {
    id: String,
    account_label: Option<String>,
    tier: Option<String>,
    expires_at: Option<i64>,
    state: &'static str,
    created_at: i64,
    updated_at: i64,
    last_used_at: Option<i64>,
}

#[cfg(desktop)]
fn codex_account_summary(account: &codex_engine::CodexAccountView) -> Option<CodexAccountSummary> {
    if !account.signed_in {
        return None;
    }
    let now = db::now_ms() / 1000;
    let api_key = account.auth_mode.as_deref() == Some("apiKey");
    Some(CodexAccountSummary {
        id: codex_engine::PRIMARY_CODEX_ACCOUNT_ID.to_string(),
        account_label: account.account.clone().or_else(|| {
            Some(if api_key {
                "OpenAI Platform API key".to_string()
            } else {
                "ChatGPT account".to_string()
            })
        }),
        tier: if api_key {
            Some("OpenAI Platform".to_string())
        } else {
            account
                .tier
                .clone()
                .map(|tier| openai_tier_label(Some(&tier)).unwrap_or(tier))
        },
        expires_at: None,
        state: "connected",
        created_at: now,
        updated_at: now,
        last_used_at: Some(now),
    })
}

#[cfg(desktop)]
#[tauri::command]
async fn start_openai_account_login(
    state: State<'_, AppState>,
) -> Result<CodexAccountSummary, String> {
    let login = state.codex.start_chatgpt_login().await?;
    tauri_plugin_opener::open_url(&login.auth_url, None::<&str>)
        .map_err(|error| format!("Could not open ChatGPT sign-in: {error}"))?;
    let account = state.codex.wait_for_login(&login.login_id).await?;
    codex_account_summary(&account)
        .ok_or_else(|| "Codex did not finish signing in to ChatGPT.".to_string())
}

#[cfg(desktop)]
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
#[allow(dead_code)]
enum OpenAiReconnectOutcome {
    Reconnected { account: CodexAccountSummary },
    IdentityMismatch { message: String },
}

#[cfg(desktop)]
#[tauri::command]
async fn reconnect_openai_account(
    state: State<'_, AppState>,
    account_profile_id: String,
) -> Result<OpenAiReconnectOutcome, String> {
    if account_profile_id != codex_engine::PRIMARY_CODEX_ACCOUNT_ID {
        return Err("ChatGPT account profile was not found.".into());
    }
    let account = start_openai_account_login(state).await?;
    Ok(OpenAiReconnectOutcome::Reconnected { account })
}

#[cfg(desktop)]
#[tauri::command]
async fn remove_openai_account(
    state: State<'_, AppState>,
    account_profile_id: String,
) -> Result<(), String> {
    if account_profile_id != codex_engine::PRIMARY_CODEX_ACCOUNT_ID {
        return Err("ChatGPT account profile was not found.".into());
    }
    state.codex.logout().await
}

#[cfg(desktop)]
#[tauri::command]
async fn openai_oauth_status(state: State<'_, AppState>) -> Result<OAuthStatus, String> {
    let account = state.codex.account(false).await?;
    Ok(oauth_status_from_codex_account(account))
}

#[cfg(desktop)]
#[tauri::command]
async fn codex_login_api_key(
    state: State<'_, AppState>,
    api_key: String,
) -> Result<OAuthStatus, String> {
    let account = state.codex.login_api_key(api_key).await?;
    Ok(oauth_status_from_codex_account(account))
}

#[cfg(desktop)]
fn oauth_status_from_codex_account(account: codex_engine::CodexAccountView) -> OAuthStatus {
    let api_key = account.auth_mode.as_deref() == Some("apiKey");
    OAuthStatus {
        available: true,
        unavailable_reason: None,
        signed_in: account.signed_in,
        expires_at: None,
        account: account
            .account
            .or_else(|| api_key.then(|| "OpenAI Platform API key".to_string())),
        tier: if api_key {
            Some("OpenAI Platform".to_string())
        } else {
            account
                .tier
                .map(|tier| openai_tier_label(Some(&tier)).unwrap_or(tier))
        },
    }
}

#[cfg(all(test, desktop))]
mod codex_account_projection_tests {
    use super::*;

    #[test]
    fn api_key_auth_remains_identifiable_after_status_refresh() {
        let account = codex_engine::CodexAccountView {
            signed_in: true,
            auth_mode: Some("apiKey".into()),
            account: None,
            tier: None,
        };

        let status = oauth_status_from_codex_account(account.clone());
        assert!(status.signed_in);
        assert_eq!(status.account.as_deref(), Some("OpenAI Platform API key"));
        assert_eq!(status.tier.as_deref(), Some("OpenAI Platform"));

        let summary = codex_account_summary(&account).expect("signed-in API key slot");
        assert_eq!(
            summary.account_label.as_deref(),
            Some("OpenAI Platform API key")
        );
        assert_eq!(summary.tier.as_deref(), Some("OpenAI Platform"));
    }

    #[test]
    fn chatgpt_auth_keeps_account_and_plan_labels() {
        let status = oauth_status_from_codex_account(codex_engine::CodexAccountView {
            signed_in: true,
            auth_mode: Some("chatgpt".into()),
            account: Some("person@example.test".into()),
            tier: Some("plus".into()),
        });

        assert_eq!(status.account.as_deref(), Some("person@example.test"));
        assert_eq!(status.tier.as_deref(), Some("ChatGPT Plus"));
    }
}

#[cfg(desktop)]
#[tauri::command]
async fn openai_models(
    state: State<'_, AppState>,
    account_profile_id: String,
) -> Result<Vec<codex_engine::CodexModelView>, String> {
    if account_profile_id != codex_engine::PRIMARY_CODEX_ACCOUNT_ID {
        return Err("ChatGPT account profile was not found.".into());
    }
    state.codex.models().await
}

/// Fetch a display-safe subscription quota snapshot for one signed-in provider.
/// Credentials stay in the native secret store; only percentages, reset windows,
/// plan display metadata, and the snapshot timestamp cross the IPC boundary.
#[cfg(desktop)]
#[tauri::command]
async fn get_plan_usage(
    state: State<'_, AppState>,
    provider: String,
    account_profile_id: Option<String>,
) -> Result<plan_usage::PlanUsageSnapshot, String> {
    if provider != "openai" {
        return Err("Codex usage is available for OpenAI authentication only.".into());
    }
    if account_profile_id.as_deref() != Some(codex_engine::PRIMARY_CODEX_ACCOUNT_ID) {
        return Err("Choose the connected Codex account before loading usage.".into());
    }
    let value = state.codex.rate_limits().await?;
    Ok(plan_usage::from_codex_app_server(
        &value,
        db::now_ms() / 1000,
    ))
}

// The single Codex authentication slot intentionally ends here. ChatGPT login
// and API-key login are two auth modes for the same app-server process.

// ── sessions ─────────────────────────────────────────────────────────────────

/// Best-effort fan-out of the current session list to any connected sync client
/// (web/phone) after a desktop-initiated session change. Without this, a session
/// created/renamed/deleted ON THE DESKTOP would stay invisible to a connected
/// client until its next reconnect/catch-up — the catch-up `SessionList` is sent
/// once, on Hello, and `forward_live` only carries `Live` frames. Mirrors the
/// phone-`CreateSession` fan-out in `sync::server::DesktopCommandHandler`.
///
/// Resolves the `SyncHub` from managed state and publishes; a `list_sessions` read
/// error is logged and swallowed (it must NOT fail the already-committed DB write),
/// and `publish_frame` is itself a cheap no-op when no client is attached.
///
/// DESKTOP-ONLY behavior: only the desktop runs the sync SERVER (and `SyncHub::
/// publish_frame` is `#[cfg(desktop)]`). On mobile — the phone is a pure remote
/// CLIENT and never serves a session list — this is a no-op, so the shared
/// `create/rename/delete_session` commands compile on both targets.
#[cfg(desktop)]
fn push_session_list(app: &AppHandle, db: &Db) {
    if let Some(hub) = app.try_state::<sync::SyncHub>() {
        match db.list_sessions() {
            Ok(sessions) => {
                hub.publish_frame(sync::public::session_list_frame(sessions));
            }
            Err(e) => eprintln!("phone-sync: list_sessions after session change failed: {e}"),
        }
    }
}

/// Mobile no-op counterpart of [`push_session_list`]: the phone never serves sync
/// clients, so there is nothing to fan out. Keeps the session commands target-
/// agnostic without dragging the desktop-only `SyncHub::publish_frame` into the
/// mobile build. `app`/`db` are unused here by design.
#[cfg(mobile)]
fn push_session_list(_app: &AppHandle, _db: &Db) {}

#[tauri::command]
fn list_sessions(state: State<AppState>) -> Vec<SessionRow> {
    state.db.list_sessions().unwrap_or_default()
}

fn settings_snapshot(state: &AppState) -> Result<Settings, String> {
    state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Settings are temporarily unavailable.".to_string())
}

fn effective_session_model(settings: &Settings, requested: Option<&str>) -> Result<String, String> {
    let model = requested.unwrap_or(&settings.model);
    if model.is_empty() || model.trim() != model {
        return Err("Select a valid model before creating the conversation.".into());
    }
    llm::provider_name_for_model(model)?;
    Ok(model.to_string())
}

fn require_session_row(db: &Db, id: &str) -> Result<SessionRow, String> {
    db.list_sessions()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|session| session.id == id)
        .ok_or_else(|| "Session was not found after it was saved.".to_string())
}

#[cfg(desktop)]
fn validate_model_account(
    _state: &AppState,
    model: &str,
    account_profile_id: Option<&str>,
) -> Result<Option<String>, String> {
    if llm::provider_name_for_model(model)? != "openai" {
        return Err("Portcode conversations now run through the Codex engine.".into());
    }
    if let Some(id) = account_profile_id {
        if id != codex_engine::PRIMARY_CODEX_ACCOUNT_ID {
            return Err("The selected Codex account is no longer available.".into());
        }
    }
    Ok(Some(codex_engine::PRIMARY_CODEX_ACCOUNT_ID.to_string()))
}

#[cfg(mobile)]
fn validate_model_account(
    _state: &AppState,
    model: &str,
    account_profile_id: Option<&str>,
) -> Result<(), String> {
    if llm::provider_name_for_model(model)? != "openai" {
        return Err("Portcode conversations now run through the Codex engine.".into());
    }
    if account_profile_id.is_some_and(|id| id != codex_engine::PRIMARY_CODEX_ACCOUNT_ID) {
        return Err("The selected Codex account is no longer available.".into());
    }
    Ok(())
}

#[cfg(test)]
mod session_command_contract_tests {
    use super::*;

    #[test]
    fn effective_model_is_validated_and_freezes_the_current_default() {
        let settings = Settings::default();
        assert_eq!(
            effective_session_model(&settings, None).unwrap(),
            "gpt-5.6-terra"
        );
        assert_eq!(
            effective_session_model(&settings, Some("gpt-5.6-sol")).unwrap(),
            "gpt-5.6-sol"
        );
        assert!(effective_session_model(&settings, Some(" gpt-5.6-sol")).is_err());
        assert!(effective_session_model(&settings, Some("custom-model")).is_err());
    }

    #[cfg(desktop)]
    #[test]
    fn reconnect_identity_mismatch_is_a_typed_display_safe_outcome() {
        let value = serde_json::to_value(OpenAiReconnectOutcome::IdentityMismatch {
            message: "The signed-in ChatGPT account does not match this profile.".to_string(),
        })
        .unwrap();
        assert_eq!(value["status"], "identity_mismatch");
        assert_eq!(
            value["message"],
            "The signed-in ChatGPT account does not match this profile."
        );
        assert_eq!(value.as_object().unwrap().len(), 2);
    }
}

#[tauri::command]
fn create_session(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    title: Option<String>,
    workspace: Option<String>,
    model: Option<String>,
    account_profile_id: Option<String>,
) -> Result<SessionRow, String> {
    let settings = settings_snapshot(&state)?;
    let model = effective_session_model(&settings, model.as_deref())?;
    #[cfg(desktop)]
    let account = validate_model_account(&state, &model, account_profile_id.as_deref())?;
    #[cfg(mobile)]
    validate_model_account(&state, &model, account_profile_id.as_deref())?;
    #[cfg(desktop)]
    let persisted_account_profile_id = account.as_deref();
    #[cfg(mobile)]
    let persisted_account_profile_id: Option<&str> = None;

    state
        .db
        .create_session_with_account(
            &id,
            title.as_deref().unwrap_or("New chat"),
            workspace.as_deref(),
            Some(&model),
            persisted_account_profile_id,
            db::now_ms(),
        )
        .map_err(|e| e.to_string())?;

    let saved = require_session_row(&state.db, &id)?;
    // Notify any connected sync client of the new session (best-effort).
    push_session_list(&app, &state.db);
    Ok(saved)
}

#[cfg(desktop)]
#[tauri::command]
fn pin_session_openai_account(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    account_profile_id: String,
    model: Option<String>,
) -> Result<SessionRow, String> {
    let settings = settings_snapshot(&state)?;
    let run_config = state
        .db
        .session_run_config(&session_id)
        .map_err(|error| format!("Session is unavailable: {error}"))?;
    let effective_model =
        effective_session_model(&settings, model.as_deref().or(run_config.model.as_deref()))?;
    if llm::provider_name_for_model(&effective_model)? != "openai" {
        return Err("Only an OpenAI conversation can be pinned to a ChatGPT account.".into());
    }
    let account = validate_model_account(&state, &effective_model, Some(&account_profile_id))?
        .expect("Codex validation always returns the primary account id");
    match state
        .db
        .select_session_openai_account_if_config(
            &session_id,
            &account,
            &effective_model,
            &run_config,
        )
        .map_err(|error| error.to_string())?
    {
        db::SessionAccountSelection::Selected | db::SessionAccountSelection::AlreadySelected => {}
        db::SessionAccountSelection::Locked { .. } => {
            return Err("This conversation has already started. Continue with another ChatGPT account in a new chat.".into());
        }
        db::SessionAccountSelection::SessionChanged { .. } => {
            return Err(
                "This conversation's model or account changed while the selection was saving. Review it and retry."
                    .into(),
            );
        }
    }
    let persisted = state
        .db
        .session_run_config(&session_id)
        .map_err(|error| format!("Session is unavailable after pinning: {error}"))?;
    let persisted_model = effective_session_model(&settings, persisted.model.as_deref())?;
    if llm::provider_name_for_model(&persisted_model)? != "openai"
        || persisted.account_profile_id.as_deref() != Some(account.as_str())
    {
        return Err("The conversation changed while its ChatGPT account was being saved. Review it before sending.".into());
    }
    let saved = require_session_row(&state.db, &session_id)?;
    push_session_list(&app, &state.db);
    Ok(saved)
}

#[tauri::command]
fn rename_session(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    title: String,
) -> Result<(), String> {
    state
        .db
        .rename_session(&id, &title)
        .map_err(|e| e.to_string())?;
    // Push the updated titles to any connected sync client (best-effort).
    push_session_list(&app, &state.db);
    Ok(())
}

#[tauri::command]
fn update_session_model(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    model: String,
) -> Result<(), String> {
    let run_config = state
        .db
        .session_run_config(&id)
        .map_err(|error| format!("Session is unavailable: {error}"))?;
    #[cfg(desktop)]
    let _account =
        validate_model_account(&state, &model, run_config.account_profile_id.as_deref())?;
    #[cfg(mobile)]
    validate_model_account(&state, &model, run_config.account_profile_id.as_deref())?;
    let updated = state
        .db
        .compare_and_set_session_model(&id, &run_config, &model)
        .map_err(|e| e.to_string())?;
    if !updated {
        return Err(
            "This conversation's model or account changed while the selection was saving. Review it and retry."
                .into(),
        );
    }
    // Keep a connected phone's authoritative session list in sync with the DB.
    push_session_list(&app, &state.db);
    Ok(())
}

#[tauri::command]
async fn delete_session(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    #[cfg(desktop)]
    if state.codex.is_session_active(&id).await {
        return Err("Cannot delete a session while it is running or has background work.".into());
    }
    state.db.delete_session(&id).map_err(|e| e.to_string())?;
    // Push the pruned list to any connected sync client (best-effort).
    push_session_list(&app, &state.db);
    Ok(())
}

#[tauri::command]
async fn get_messages(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<UiMessage>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.try_ui_messages(&session_id))
        .await
        .map_err(|error| format!("history worker failed: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_message_page(
    state: State<'_, AppState>,
    session_id: String,
    cursor: Option<String>,
) -> Result<UiMessagePage, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.try_ui_message_page(&session_id, cursor.as_deref()))
        .await
        .map_err(|error| format!("history worker failed: {error}"))?
        .map_err(|error| error.to_string())
}

/// Newest durable raw Codex activity for the desktop inspector. This command is
/// deliberately absent on mobile: raw app-server payloads are not part of the
/// sanitized Phone Sync contract.
#[cfg(desktop)]
#[tauri::command]
async fn get_codex_activity(
    state: State<'_, AppState>,
    session_id: String,
    limit: Option<u32>,
) -> Result<Vec<db::CodexActivityRow>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.codex_activity(&session_id, limit.unwrap_or(500)))
        .await
        .map_err(|error| format!("Codex activity worker failed: {error}"))?
        .map_err(|error| error.to_string())
}

// ── drafts (composer open-loop persistence) ──────────────────────────────────

/// Persist (or clear, when blank) one session's unsent composer draft. Debounced
/// from the store so keystrokes don't hammer SQLite.
#[tauri::command]
fn save_draft(state: State<AppState>, session_id: String, text: String) -> Result<(), String> {
    state
        .db
        .save_draft(&session_id, &text, db::now_ms())
        .map_err(|e| e.to_string())
}

/// The stored draft for a session, or `null` when there is none.
#[tauri::command]
fn get_draft(state: State<AppState>, session_id: String) -> Option<String> {
    state.db.get_draft(&session_id)
}

/// Every stored draft — the init-bundle hydration for the frontend's per-session
/// draft map (authoritative over the optimistic localStorage mirror).
#[tauri::command]
fn get_drafts(state: State<AppState>) -> Vec<DraftRow> {
    state.db.all_drafts()
}

// ── usage (cumulative per-session token spend) ───────────────────────────────

/// Cumulative token usage for one session (zeros when none recorded).
#[tauri::command]
fn get_usage(state: State<AppState>, session_id: String) -> UsageRow {
    state.db.get_usage(&session_id)
}

/// Every session's cumulative usage — restores the per-session token meters and
/// the workspace-total spend in the status HUD across a restart.
#[tauri::command]
fn get_all_usage(state: State<AppState>) -> Vec<UsageRow> {
    state.db.all_usage()
}

// ── message search (⌘K jump to a past turn) ──────────────────────────────────

/// Search message text across every session, newest first. Capped server-side so
/// a broad query can't return an unbounded result set.
#[tauri::command]
fn search_messages(state: State<AppState>, query: String) -> Vec<SearchHit> {
    state.db.search_messages(&query, 50)
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

// DESKTOP-ONLY: drives the supervised Codex app-server process, which is
// mobile-excluded. The phone issues turns over the encrypted sync channel to a
// paired desktop; it never launches Codex locally.
#[cfg(desktop)]
#[tauri::command]
async fn run_agent(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    state
        .db
        .require_session(&session_id)
        .map_err(|error| error.to_string())?;
    if text.trim().is_empty() {
        return Err("Enter a message before sending.".to_string());
    }
    let settings = settings_snapshot(&state)?;
    let codex = state.codex.clone();

    // The shared engine owns app-server supervision and event projection. Keep
    // this command non-blocking while the turn streams through its EventSink.
    tauri::async_runtime::spawn(async move {
        codex.run_turn(session_id, text, settings).await;
    });
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
async fn cancel_agent(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.codex.interrupt_session(&session_id).await
}

/// Stop ONE subagent (and its descendants) from the agents panel, leaving the rest
/// of the session — including the top-level turn — running.
#[cfg(desktop)]
#[tauri::command]
async fn cancel_agent_by_id(state: State<'_, AppState>, agent_id: String) -> Result<(), String> {
    state.codex.interrupt_agent(&agent_id).await
}

#[cfg(desktop)]
fn parse_approval_decision(
    decision: &str,
    for_session: Option<bool>,
) -> Result<(bool, bool), String> {
    match decision {
        "allow" => Ok((true, for_session.unwrap_or(false))),
        "deny" => Ok((false, false)),
        _ => Err("Approval decision must be either allow or deny.".to_string()),
    }
}

#[cfg(desktop)]
#[tauri::command]
async fn resolve_permission(
    state: State<'_, AppState>,
    id: String,
    decision: String,
    for_session: Option<bool>,
) -> Result<(), String> {
    let (allow, for_session) = parse_approval_decision(&decision, for_session)?;
    state.codex.resolve_approval(&id, allow, for_session).await
}

#[cfg(all(test, desktop))]
mod approval_command_contract_tests {
    use super::parse_approval_decision;

    #[test]
    fn approval_decisions_are_exact_and_session_scope_is_allow_only() {
        assert_eq!(
            parse_approval_decision("allow", Some(true)).unwrap(),
            (true, true)
        );
        assert_eq!(
            parse_approval_decision("deny", Some(true)).unwrap(),
            (false, false)
        );
        assert!(parse_approval_decision("unexpected", None).is_err());
    }
}

#[cfg(desktop)]
#[tauri::command]
async fn resolve_codex_request(
    state: State<'_, AppState>,
    id: String,
    response: Value,
) -> Result<(), String> {
    state.codex.resolve_codex_request(&id, response).await
}

// ── Opt-in crash reporting (Phase 1b desktop / Phase 3 Android) ──────────────

#[cfg(any(mobile, test))]
fn require_app_config_dir<E: std::fmt::Display>(
    resolved: Result<PathBuf, E>,
) -> Result<PathBuf, String> {
    resolved.map_err(|e| format!("failed to resolve app config directory: {e}"))
}

/// Mirror the frontend's crash-reporting consent into the native host, on BOTH
/// desktop and mobile. The frontend calls `ipc.setTelemetryConsent` on every Tauri
/// build, so this command is now registered on both targets (Phase 3).
///
/// It only ever WRITES the on-disk consent flag — it never inits/closes any SDK:
///  * DESKTOP — `telemetry::set_consent` writes `<app_config_dir>/.telemetry_consent`
///    (the flag the main process AND the re-exec'd crash-reporter child both read in
///    `before_send`). Inert without a build-time `SENTRY_DSN`.
///  * ANDROID — resolves the app-private config dir from the `AppHandle`
///    (`app_config_dir()`, inside the OS sandbox — the same dir `secrets::init_dir`
///    uses) and writes the SAME flag via `consent::set_consent_in`. The Kotlin
///    `PortcodeApplication` reads it on next launch and refuses to init the Sentry
///    SDK unless it is `"1"` (AND a DSN was baked in). Writing the flag NEVER arms
///    anything by itself — the SDK is only ever initialized at process start, behind
///    both the DSN gate and this flag, so opting in mid-session takes effect on the
///    next launch (matching the desktop startup-bind model).
///
/// The whole pipeline stays inert by default: no DSN ⇒ the SDK is never initialized
/// on either platform, so this command is a pure flag write with no telemetry effect.
/// On mobile, failure to resolve the authoritative app-config directory is returned
/// to the caller instead of writing to a fallback path that Android never reads.
#[tauri::command]
fn telemetry_set_consent(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let _ = &app; // desktop resolves the path without an AppHandle
        telemetry::set_consent(enabled);
        Ok(())
    }
    #[cfg(mobile)]
    {
        // On Android `dirs::config_dir()` does NOT reliably point at the app sandbox,
        // so resolve the app-private config dir from Tauri (it IS inside the sandbox)
        // and write the flag there. A fallback path would not be read by Kotlin and
        // could falsely report that an opt-out succeeded, so resolution fails closed.
        let dir = require_app_config_dir(app.path().app_config_dir())?;
        consent::set_consent_in(&dir, enabled);
        Ok(())
    }
}

#[cfg(test)]
mod telemetry_consent_command_tests {
    use super::*;

    #[test]
    fn app_config_resolution_failure_is_not_replaced_with_a_fallback() {
        let err = require_app_config_dir(Err::<PathBuf, _>("unavailable"))
            .expect_err("an unresolved authoritative path must fail closed");
        assert!(err.contains("unavailable"));

        let expected = PathBuf::from("authoritative-config");
        assert_eq!(
            require_app_config_dir(Ok::<_, &str>(expected.clone())).unwrap(),
            expected
        );
    }
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
    use rand::Rng as _;

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
    rand::rng().fill_bytes(&mut nonce);

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
        state.settings.clone(),
        state.db.clone(),
        state.codex.clone(),
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
                        Ok(_) => {
                            // The peer is not trusted yet. Never reflect the
                            // frame's Debug representation into local logs: it
                            // may contain arbitrary prompts, titles, or push
                            // credentials supplied before SAS confirmation.
                            eprintln!(
                                "phone-sync: unexpected frame before pairing confirmed — \
                                 dropping connection"
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
// The AppState pieces the accept loop needs as owned clones, plus the
// shared `listen_endpoint` and `pairing_gate`) are already the `AppState` fields,
// threaded through once; bundling them again would not simplify ownership here.
fn start_listener(
    app: AppHandle,
    settings: Arc<Mutex<Settings>>,
    db: Arc<Db>,
    codex: Arc<codex_engine::CodexEngine>,
    listen_endpoint: Arc<Mutex<Option<iroh::Endpoint>>>,
    pairing_gate: Arc<sync::pairing_gate::PairingGate>,
) -> Result<(), String> {
    // App-layer (Noise) pairing identity — the key phones pin.
    let device = sync::pairing::device_identity()?;
    // Transport (iroh node) identity — persisted so the node id is stable.
    let secret_key = secrets::get_or_create_iroh_key()?;

    let handler = sync::server::DesktopCommandHandler {
        app: app.clone(),
        settings,
        db: db.clone(),
        codex,
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

#[cfg(desktop)]
fn shutdown_codex_on_app_exit(app: &AppHandle) {
    let Some(codex) = app.try_state::<AppState>().map(|state| state.codex.clone()) else {
        return;
    };

    // `RunEvent::Exit` is the last reliable lifecycle hook before Tauri cleans up
    // or restarts the process. Block that hook only for a short outer bound; the
    // transport also has its own child-reap timeout, so exit cannot hang forever.
    tauri::async_runtime::block_on(async move {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), codex.shutdown()).await;
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Phase 2 — arm desktop crash reporting FIRST: the out-of-process minidump monitor
    // + the Rust Sentry client whose `before_send` scrubs and consent-gates every event.
    // This MUST be the first statement in run(): it executes in BOTH this process and
    // the re-exec'd crash-reporter child (everything before `minidump::init` runs in
    // both), and the monitor must be live before any crash. Inert (returns None) when no
    // `SENTRY_DSN` was baked in — dev/contributor/fork builds never report. The returned
    // guard is held for the whole process lifetime; dropping it stops the reporter child.
    #[cfg(desktop)]
    let _sentry_guard = telemetry::init_desktop_with_minidump();

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
            let db = Arc::new(Db::open(&dir.join("portcode.db")).expect("failed to open database"));
            #[cfg(desktop)]
            let codex = {
                let options = codex_app_server::CodexAppServerOptions {
                    resource_dir: app.path().resource_dir().ok(),
                    broadcast_capacity: 8_192,
                    ..Default::default()
                };
                let server = codex_app_server::CodexAppServer::new(options);
                let sink: Arc<dyn events::EventSink> =
                    Arc::new(events::AppEventSink(app.handle().clone()));
                let engine = codex_engine::CodexEngine::new(server, db.clone(), sink);
                engine.start_event_pump();
                engine
            };
            app.manage(AppState {
                config_dir: dir,
                settings: Arc::new(Mutex::new(settings)),
                db,
                #[cfg(desktop)]
                codex,
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
                    state.settings.clone(),
                    state.db.clone(),
                    state.codex.clone(),
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
    // DESKTOP — settings/sessions + Codex authentication and execution +
    // workspace file-tree + the sync server.
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_settings,
        save_settings,
        openai_oauth_status,
        codex_login_api_key,
        list_openai_accounts,
        start_openai_account_login,
        reconnect_openai_account,
        remove_openai_account,
        openai_models,
        get_plan_usage,
        list_sessions,
        create_session,
        pin_session_openai_account,
        rename_session,
        update_session_model,
        delete_session,
        get_messages,
        get_message_page,
        get_codex_activity,
        save_draft,
        get_draft,
        get_drafts,
        get_usage,
        get_all_usage,
        search_messages,
        workspace::get_workspace_summary,
        workspace::get_session_archive_warning,
        git_review::get_git_review_branches,
        git_review::get_git_review_manifest,
        git_review::get_git_review_file,
        git_review::get_turn_review_manifest,
        git_review::get_turn_review_file,
        list_dir,
        run_agent,
        cancel_agent,
        cancel_agent_by_id,
        resolve_permission,
        resolve_codex_request,
        telemetry_set_consent,
        phone_sync_status,
        phone_sync_begin_pairing,
        phone_sync_unpair,
        phone_sync_listen,
        phone_sync_connect,
        phone_sync_send_command,
        phone_sync_disconnect,
        confirm_pairing,
        reject_pairing,
        // Auto-updater surface (desktop-only; phone never self-updates).
        update::update_check,
        update::update_download_and_install,
        update::update_relaunch,
        update::update_channel
    ]);

    // MOBILE — the remote-client subset. Shared settings/sessions +
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
        list_sessions,
        create_session,
        rename_session,
        update_session_model,
        delete_session,
        get_messages,
        get_message_page,
        save_draft,
        get_draft,
        get_drafts,
        get_usage,
        get_all_usage,
        search_messages,
        telemetry_set_consent,
        phone_sync_status,
        phone_sync_unpair,
        phone_sync_connect,
        phone_sync_send_command,
        phone_sync_disconnect
    ]);

    #[cfg(desktop)]
    {
        let app = builder
            .build(tauri::generate_context!())
            .expect("error while building Portcode");
        app.run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                shutdown_codex_on_app_exit(app);
            }
        });
    }

    #[cfg(mobile)]
    builder
        .run(tauri::generate_context!())
        .expect("error while running Portcode");
}
