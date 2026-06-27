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
use tauri::{AppHandle, Manager};

use crate::agent;
use crate::agents;
use crate::background;
use crate::db::{self, Db};
use crate::permissions::{self, Decision, Pending};
use crate::settings::Settings;
use crate::sync::protocol::{RemoteCommand, SyncFrame};
use crate::sync::session::CommandHandler;
use crate::sync::SyncHub;

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
    pub agents: agents::Agents,
    pub background: background::Background,
    pub oauth_refresh: Arc<tokio::sync::Mutex<()>>,
}

/// Map a phone-supplied permission decision string to a [`Decision`], validated
/// against an explicit allowlist. Only "allow"/"deny" are meaningful; ANY other
/// value (typo, future variant, hostile input from a confirmed-but-misbehaving
/// device) is treated as Deny (fail-closed) and logged — never coerced into Allow.
fn parse_decision(decision: &str) -> Decision {
    match decision {
        "allow" => Decision::Allow,
        "deny" => Decision::Deny,
        other => {
            eprintln!("phone-sync: unknown permission decision {other:?} — denying");
            Decision::Deny
        }
    }
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
                let agents = self.agents.clone();
                let background = self.background.clone();
                let oauth_refresh = self.oauth_refresh.clone();
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
                        // The phone's Run command carries no per-session model override,
                        // so use the desktop default — `agent::run` falls back to
                        // settings.model on None, matching the pre-per-session behavior.
                        None,
                    )
                    .await;
                });
                Ok(())
            }
            // Mirror `cancel_agent`: set an EXISTING flag (agent::run inserts it),
            // cascade to the session's subagents, and deny pending gates. Guard
            // dropped at the `if let` end; no await.
            RemoteCommand::Cancel { session_id } => {
                if let Some(flag) = self.cancels.lock().unwrap().get(&session_id) {
                    flag.store(true, Ordering::Relaxed);
                }
                agents::cancel_session(&self.agents, &session_id);
                background::cancel_session(&self.background, &session_id);
                permissions::deny_all(&self.pending, &session_id);
                Ok(())
            }
            // Mirror `cancel_agent_by_id`: stop ONE subagent (and its descendants),
            // leaving the rest of the session running.
            RemoteCommand::CancelAgent { agent_id } => {
                agents::cancel_one(&self.agents, &agent_id);
                Ok(())
            }
            // Mirror `resolve_permission`, but validate the decision string against
            // an explicit allowlist: only "allow"/"deny" are meaningful, and
            // anything else is treated as Deny (fail-closed) and logged. The
            // device-trust gate (see `serve_connection`) now prevents an untrusted
            // peer from reaching this command at all, so a malformed decision here
            // can only come from a confirmed device, but we still refuse to coerce
            // an unknown value into Allow.
            RemoteCommand::Permission { id, decision } => {
                permissions::resolve(&self.pending, &id, parse_decision(&decision));
                Ok(())
            }
            // Mirror `create_session`. The phone supplies only a title; the desktop
            // mints the id. AFTER creating, re-push a fresh `SessionList` onto the
            // SyncHub so the new session appears on the phone immediately — without
            // it the created session would be invisible until the next
            // reconnect/catch-up (the catch-up `SessionList` is sent once, on Hello,
            // and `forward_live` only ever carried `Live` frames before this).
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
                    .map_err(|e| e.to_string())?;
                // Best-effort fan-out of the updated list. A `list_sessions` read
                // error here must not fail the (already-committed) create, so log +
                // continue; the phone still picks the session up on next catch-up.
                if let Some(hub) = self.app.try_state::<SyncHub>() {
                    match self.db.list_sessions() {
                        Ok(sessions) => {
                            hub.publish_frame(SyncFrame::SessionList { sessions });
                        }
                        Err(e) => {
                            eprintln!("phone-sync: list_sessions after create failed: {e}");
                        }
                    }
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_decision_only_allows_the_literal_allow() {
        assert_eq!(parse_decision("allow"), Decision::Allow);
        assert_eq!(parse_decision("deny"), Decision::Deny);
        // Everything else is fail-closed to Deny — never coerced into Allow.
        for bad in [
            "", "ALLOW", "Allow", "yes", "true", "1", "allow ", " allow", "grant",
        ] {
            assert_eq!(
                parse_decision(bad),
                Decision::Deny,
                "unknown decision {bad:?} must map to Deny"
            );
        }
    }
}
