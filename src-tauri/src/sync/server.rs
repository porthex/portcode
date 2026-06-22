//! Phone Sync — Phase 3: the desktop-side command handler.
//!
//! `DesktopCommandHandler` is the production `CommandHandler` the command-intake
//! loop dispatches a phone's `RemoteCommand`s through. It holds owned,
//! `Send + 'static` clones of the `AppState` pieces each command needs and drives
//! them exactly as the equivalent Tauri command does (`run_agent` / `cancel_agent`
//! / `resolve_permission` / `create_session`). Drives the live agent loop, so it
//! is not unit-tested; it is exercised end-to-end by the iroh integration test
//! (via a recording handler) and compiled + clippy-checked here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tauri::AppHandle;

use crate::agent;
use crate::db::{self, Db};
use crate::permissions::{self, Decision, Pending};
use crate::settings::Settings;
use crate::sync::protocol::RemoteCommand;
use crate::sync::session::CommandHandler;

/// Owned, `Send + 'static` capture of the `AppState` pieces a phone's remote
/// commands drive. Cloned from `AppState` when the listener starts; the inner
/// `Arc`/`AppHandle`/`reqwest::Client` are cheap-clone + `Send`, so this is safe
/// to move into the spawned per-connection tasks and to share via `Clone`.
#[derive(Clone)]
pub struct DesktopCommandHandler {
    pub app: AppHandle,
    pub http: reqwest::Client,
    pub settings: Arc<Mutex<Settings>>,
    pub db: Arc<Db>,
    pub cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub pending: Pending,
    pub oauth_refresh: Arc<tokio::sync::Mutex<()>>,
}

#[async_trait]
impl CommandHandler for DesktopCommandHandler {
    async fn handle(&self, command: RemoteCommand) -> Result<(), String> {
        match command {
            // Mirror `run_agent`: spawn the agent loop so the intake loop is never
            // blocked by a turn. Each arg is an owned clone → the spawned future is
            // `Send + 'static` (nothing borrowed from `&self` escapes).
            RemoteCommand::Run { session_id, text } => {
                let app = self.app.clone();
                let http = self.http.clone();
                let settings = self.settings.clone();
                let db = self.db.clone();
                let cancels = self.cancels.clone();
                let pending = self.pending.clone();
                let oauth_refresh = self.oauth_refresh.clone();
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
                        // The phone's Run command carries no per-session model override,
                        // so use the desktop default — `agent::run` falls back to
                        // settings.model on None, matching the pre-per-session behavior.
                        None,
                    )
                    .await;
                });
                Ok(())
            }
            // Mirror `cancel_agent`: set an EXISTING flag (agent::run inserts it)
            // + deny pending gates. Guard dropped at the `if let` end; no await.
            RemoteCommand::Cancel { session_id } => {
                if let Some(flag) = self.cancels.lock().unwrap().get(&session_id) {
                    flag.store(true, Ordering::Relaxed);
                }
                permissions::deny_all(&self.pending, &session_id);
                Ok(())
            }
            // Mirror `resolve_permission`.
            RemoteCommand::Permission { id, decision } => {
                let d = if decision == "allow" {
                    Decision::Allow
                } else {
                    Decision::Deny
                };
                permissions::resolve(&self.pending, &id, d);
                Ok(())
            }
            // Mirror `create_session`. The phone supplies only a title; the desktop
            // mints the id (the phone learns it from the next catch-up SessionList).
            RemoteCommand::CreateSession { title } => {
                let id = uuid::Uuid::new_v4().to_string();
                self.db
                    .create_session(
                        &id,
                        title.as_deref().unwrap_or("New chat"),
                        None, // workspace
                        None, // model — phone-created sessions use the desktop default
                        db::now_ms(),
                    )
                    .map_err(|e| e.to_string())
            }
        }
    }
}
