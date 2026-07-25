//! Phone Sync — Phase 3: the desktop-side command handler.
//!
//! `DesktopCommandHandler` is the production `CommandHandler` the command-intake
//! loop dispatches a phone's `RemoteCommand`s through. It holds owned,
//! `Send + 'static` clones of the `AppState` pieces each command needs and drives
//! them exactly as the equivalent Tauri command does (`run_agent` / `cancel_agent`
//! / `resolve_permission` / `create_session`). Drives the live agent loop, so it
//! is not unit-tested; it is exercised end-to-end by the iroh integration test
//! (via a recording handler) and compiled + clippy-checked here.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tauri::{AppHandle, Manager};

use crate::attachments;
use crate::codex_engine::{CodexEngine, PRIMARY_CODEX_ACCOUNT_ID};
use crate::db::{self, Db};
use crate::settings::Settings;
use crate::sync::protocol::{CommandRejectionCode, RemoteCommand, SyncFrame};
use crate::sync::public;
use crate::sync::session::CommandHandler;
use crate::sync::SyncHub;

/// Owned, `Send + 'static` capture of the `AppState` pieces a phone's remote
/// commands drive. Cloned from `AppState` when the listener starts; the inner
/// `Arc`/`AppHandle`/`reqwest::Client` are cheap-clone + `Send`, so this is safe
/// to move into the spawned per-connection tasks and to share via `Clone`.
#[derive(Clone)]
pub struct DesktopCommandHandler {
    pub app: AppHandle,
    pub settings: Arc<Mutex<Settings>>,
    pub db: Arc<Db>,
    pub codex: Arc<CodexEngine>,
}

/// Upper bound on how many rows a single `FetchMessages` page may request. Clamps
/// a phone-supplied `limit` so one pagination request can't be coerced into
/// serializing a huge page that blows the Noise frame cap (~65 KB) — the same
/// reason catch-up is windowed. Matches the catch-up window order of magnitude.
const MAX_PAGE_LIMIT: i64 = 200;

/// Correlation IDs are generated as UUIDs by current phone clients. Keeping the
/// accepted alphabet and size narrow prevents a hostile paired device from making
/// the desktop reflect control characters or an almost-frame-sized string back at
/// every subscriber. Invalid identifiers receive an uncorrelated, safe rejection.
/// Public command errors are intentionally much smaller than the encrypted frame
/// limit. This is defense in depth around future copy changes: a diagnostic can
/// never turn a command rejection into an oversized-frame transport failure.
const MAX_COMMAND_REJECTION_MESSAGE_BYTES: usize = 240;

/// Remote-created titles are replicated in both `SessionCreated` and the full
/// `SessionList`. Keep one confirmed-but-misbehaving phone from persisting an
/// almost-frame-sized title or control characters into every future catch-up.
const MAX_REMOTE_SESSION_TITLE_BYTES: usize = 256;

/// Noise transport plaintext tops out just below 64 KiB. Leave several KiB for
/// framing/version growth and reject a remote create *before* persistence when
/// the resulting authoritative SessionList would no longer fit in one message.
/// Command loops are per connection, so two phones can create concurrently.
/// Serialize the list-size preflight with the DB write to prevent two remote
/// requests from both observing the same remaining frame budget.
static REMOTE_CREATE_LOCK: Mutex<()> = Mutex::new(());

/// Map a phone-supplied permission decision string to a [`Decision`], validated
/// against an explicit allowlist. Only "allow"/"deny" are meaningful; ANY other
/// value (typo, future variant, hostile input from a confirmed-but-misbehaving
/// device) is treated as Deny (fail-closed) and logged — never coerced into Allow.
fn parse_decision(decision: &str) -> bool {
    match decision {
        "allow" => true,
        "deny" => false,
        _ => {
            // This value is supplied by a paired peer. Keep the audit signal,
            // but never reflect arbitrary command content into local logs.
            eprintln!("phone-sync: unknown permission decision — denying");
            false
        }
    }
}

fn settings_snapshot(settings: &Mutex<Settings>) -> Result<Settings, String> {
    settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Settings are temporarily unavailable.".to_string())
}

fn remote_create_model(settings: &Settings) -> Result<String, CommandRejectionCode> {
    let model = crate::effective_session_model(settings, None)
        .map_err(|_| CommandRejectionCode::InvalidDesktopConfiguration)?;
    let provider = crate::llm::provider_name_for_model(&model)
        .map_err(|_| CommandRejectionCode::InvalidDesktopConfiguration)?;
    if settings.provider != provider {
        return Err(CommandRejectionCode::InvalidDesktopConfiguration);
    }
    if provider != "openai" {
        return Err(CommandRejectionCode::InvalidDesktopConfiguration);
    }
    Ok(model)
}

fn valid_remote_request_id(request_id: &str) -> bool {
    public::valid_remote_identifier(request_id)
}

/// Resolve only a syntactically-safe phone id to the exact stored session id.
/// Callers use the returned value for all later lookup/channel/reflection work.
fn authoritative_remote_session_id(db: &Db, candidate: &str) -> Option<String> {
    if !public::valid_remote_identifier(candidate) {
        return None;
    }
    db.require_session(candidate).ok()?;
    Some(candidate.to_string())
}

fn normalize_remote_session_title(title: Option<&str>) -> Result<String, CommandRejectionCode> {
    let title = title.unwrap_or("New chat").trim();
    if title.is_empty()
        || title.len() > MAX_REMOTE_SESSION_TITLE_BYTES
        || title.chars().any(char::is_control)
    {
        return Err(CommandRejectionCode::InvalidRequest);
    }
    Ok(title.to_string())
}

fn session_list_with_candidate_fits(
    db: &Db,
    candidate: &db::SessionRow,
) -> Result<bool, CommandRejectionCode> {
    let mut sessions = db
        .list_sessions()
        .map_err(|_| CommandRejectionCode::DesktopUnavailable)?;
    sessions.insert(0, candidate.clone());
    let expected = sessions.len();
    let frame = public::session_list_frame(sessions);
    let SyncFrame::SessionList { sessions } = frame else {
        unreachable!("session_list_frame always returns SessionList")
    };
    let complete = sessions.len() == expected;
    let frame = SyncFrame::SessionList { sessions };
    Ok(complete && public::frame_fits(&frame, public::PHONE_FRAME_BUDGET))
}

fn rejection_message(code: CommandRejectionCode) -> &'static str {
    match code {
        CommandRejectionCode::OpenAiAccountSelectionRequired => {
            "This desktop now defaults to ChatGPT. Create the conversation on the desktop to choose an account."
        }
        CommandRejectionCode::InvalidDesktopConfiguration => {
            "The desktop default provider and model do not match. Fix Settings on the desktop."
        }
        CommandRejectionCode::DesktopUnavailable => {
            "The desktop could not create the conversation. Please try again."
        }
        CommandRejectionCode::InvalidRequest => {
            "The create request was invalid. Please try again."
        }
        CommandRejectionCode::Unknown => "The desktop rejected the command.",
    }
}

/// Redact secrets/identifying paths, strip control characters, and truncate on a
/// UTF-8 boundary. Create rejections pass only whitelisted public copy; remote-run
/// admission also uses this boundary so an unexpected lower-level diagnostic can
/// never leak or grow into an oversized live frame.
fn bounded_public_message(message: &str) -> String {
    public::bounded_public_text(message, MAX_COMMAND_REJECTION_MESSAGE_BYTES)
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn command_rejection_frame(request_id: &str, mut code: CommandRejectionCode) -> SyncFrame {
    let request_id = if valid_remote_request_id(request_id) {
        Some(request_id.to_string())
    } else {
        code = CommandRejectionCode::InvalidRequest;
        None
    };
    SyncFrame::CommandRejected {
        request_id,
        code,
        message: bounded_public_message(rejection_message(code)),
    }
}

fn create_remote_session(
    db: &Db,
    settings: &Settings,
    request_id: &str,
    title: Option<&str>,
) -> Result<db::SessionRow, CommandRejectionCode> {
    if !valid_remote_request_id(request_id) {
        return Err(CommandRejectionCode::InvalidRequest);
    }
    let model = remote_create_model(settings)?;
    let title = normalize_remote_session_title(title)?;
    let _create_guard = REMOTE_CREATE_LOCK
        .lock()
        .map_err(|_| CommandRejectionCode::DesktopUnavailable)?;
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = db::now_ms();
    let candidate = db::SessionRow {
        id: id.clone(),
        title: title.clone(),
        branch: None,
        workspace: None,
        model: Some(model.clone()),
        account_profile_id: Some(PRIMARY_CODEX_ACCOUNT_ID.to_string()),
        created_at,
        updated_at: created_at,
    };
    if !session_list_with_candidate_fits(db, &candidate)? {
        return Err(CommandRejectionCode::DesktopUnavailable);
    }
    db.create_session_with_account(
        &id,
        &title,
        None, // workspace
        Some(&model),
        Some(PRIMARY_CODEX_ACCOUNT_ID),
        created_at,
    )
    .map_err(|_| CommandRejectionCode::DesktopUnavailable)?;
    Ok(candidate)
}

#[async_trait]
impl CommandHandler for DesktopCommandHandler {
    async fn handle(&self, command: RemoteCommand) -> Result<(), String> {
        match command {
            // Mirror `run_agent`: spawn the agent loop so the intake loop is never
            // blocked by a turn. Each arg is an owned clone → the spawned future is
            // `Send + 'static` (nothing borrowed from `&self` escapes).
            RemoteCommand::Run { session_id, text } => {
                let Some(session_id) = authoritative_remote_session_id(&self.db, &session_id)
                else {
                    return Ok(());
                };
                if text.is_empty() || text.len() > public::MAX_REMOTE_RUN_TEXT_BYTES {
                    return Ok(());
                }
                let settings = match settings_snapshot(&self.settings) {
                    Ok(settings) => settings,
                    Err(_) => return Ok(()),
                };
                let codex = self.codex.clone();
                let Ok(prepared_turn) = attachments::prepare_turn(&text, &[]) else {
                    return Ok(());
                };
                tauri::async_runtime::spawn(async move {
                    codex.run_turn(session_id, prepared_turn, settings).await;
                });
                Ok(())
            }
            // Mirror `cancel_agent`: set an EXISTING flag (agent::run inserts it),
            // cascade to the session's subagents, and deny pending gates. Guard
            // dropped at the `if let` end; no await.
            RemoteCommand::Cancel { session_id } => {
                let Some(session_id) = authoritative_remote_session_id(&self.db, &session_id)
                else {
                    return Ok(());
                };
                let _ = self.codex.interrupt_session(&session_id).await;
                Ok(())
            }
            // Mirror `cancel_agent_by_id`: stop ONE subagent (and its descendants),
            // leaving the rest of the session running.
            RemoteCommand::CancelAgent { agent_id } => {
                if !public::valid_remote_identifier(&agent_id) {
                    return Ok(());
                }
                let _ = self.codex.interrupt_agent(&agent_id).await;
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
                if !public::valid_remote_identifier(&id) {
                    return Ok(());
                }
                let _ = self
                    .codex
                    .resolve_approval(&id, parse_decision(&decision), false)
                    .await;
                Ok(())
            }
            // Mirror `create_session`. The phone supplies only a title; the desktop
            // mints the id. AFTER creating, re-push a fresh `SessionList` onto the
            // SyncHub so the new session appears on the phone immediately — without
            // it the created session would be invisible until the next
            // reconnect/catch-up (the catch-up `SessionList` is sent once, on Hello,
            // and `forward_live` only ever carried `Live` frames before this).
            RemoteCommand::CreateSession { request_id, title } => {
                // This protocol carries neither a local profile UUID nor a
                // capability/version acknowledgement. Fail closed for OpenAI
                // instead of guessing an account or inheriting a desktop choice.
                // Every application failure becomes a correlated, bounded result
                // frame and returns Ok so command intake remains healthy.
                let created = settings_snapshot(&self.settings)
                    .map_err(|_| CommandRejectionCode::DesktopUnavailable)
                    .and_then(|settings| {
                        create_remote_session(&self.db, &settings, &request_id, title.as_deref())
                    });
                let session = match created {
                    Ok(session) => session,
                    Err(code) => {
                        if let Some(hub) = self.app.try_state::<SyncHub>() {
                            hub.publish_frame(command_rejection_frame(&request_id, code));
                        }
                        return Ok(());
                    }
                };
                // Best-effort fan-out of the updated list. A `list_sessions` read
                // error here must not fail the (already-committed) create, so log +
                // continue; the phone still picks the session up on next catch-up.
                if let Some(hub) = self.app.try_state::<SyncHub>() {
                    hub.publish_frame(public::session_created_frame(request_id, &session));
                    match self.db.list_sessions() {
                        Ok(sessions) => {
                            hub.publish_frame(public::session_list_frame(sessions));
                        }
                        Err(e) => {
                            eprintln!("phone-sync: list_sessions after create failed: {e}");
                        }
                    }
                }
                Ok(())
            }
            // Push delivery is not wired yet, but the web client already sends its
            // subscription over this channel. Accept the command without logging
            // its endpoint or encryption keys, which are sensitive credentials.
            RemoteCommand::RegisterPush { .. } => {
                eprintln!("phone-sync: register_push received (push send not yet wired)");
                Ok(())
            }
            // Scroll-up pagination: fetch an OLDER page of a session's history and
            // publish it back as a `MessagePage`. The initial catch-up ships only the
            // recent window (`messages_tail`), so a client scrolling up past it asks
            // for the rows before its smallest held seq. `limit` is clamped to
            // `MAX_PAGE_LIMIT` so a request can't force an over-sized frame. Best-
            // effort fan-out like `CreateSession` (a no-op when no client is attached).
            RemoteCommand::FetchMessages {
                session_id,
                before_seq,
                limit,
            } => {
                let Some(session_id) = authoritative_remote_session_id(&self.db, &session_id)
                else {
                    return Ok(());
                };
                let limit = (limit as i64).clamp(1, MAX_PAGE_LIMIT);
                let (messages, has_more) = self.db.messages_page(&session_id, before_seq, limit);
                if let Some(hub) = self.app.try_state::<SyncHub>() {
                    hub.publish_frame(public::message_page_frame(&session_id, messages, has_more));
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parse_decision_only_allows_the_literal_allow() {
        assert!(parse_decision("allow"));
        assert!(!parse_decision("deny"));
        // Everything else is fail-closed to Deny — never coerced into Allow.
        for bad in [
            "", "ALLOW", "Allow", "yes", "true", "1", "allow ", " allow", "grant",
        ] {
            assert!(!parse_decision(bad), "unknown decision {bad:?} must deny");
        }
    }

    #[test]
    fn remote_create_freezes_the_codex_default() {
        let settings = Settings::default();
        assert_eq!(remote_create_model(&settings).unwrap(), "gpt-5.6-terra");
    }

    #[test]
    fn remote_create_rejects_provider_model_mismatch() {
        let settings = Settings {
            provider: "anthropic".into(),
            ..Settings::default()
        };
        assert_eq!(
            remote_create_model(&settings).expect_err("mismatch must fail closed"),
            CommandRejectionCode::InvalidDesktopConfiguration
        );
    }

    #[test]
    fn remote_create_pins_the_single_codex_account() {
        let db = Db::open(Path::new(":memory:")).unwrap();
        let created = create_remote_session(
            &db,
            &Settings::default(),
            "create-codex",
            Some("Still connected"),
        )
        .expect("Codex session creation must work over Phone Sync");
        assert_eq!(created.title, "Still connected");
        assert_eq!(created.model.as_deref(), Some("gpt-5.6-terra"));
        assert_eq!(
            created.account_profile_id.as_deref(),
            Some(PRIMARY_CODEX_ACCOUNT_ID)
        );
        assert_eq!(db.list_sessions().unwrap().len(), 1);
    }

    #[test]
    fn remote_create_rejects_unsafe_titles_without_persisting_them() {
        let db = Db::open(Path::new(":memory:")).unwrap();
        for (index, title) in [
            "   ".to_string(),
            "line\nbreak".to_string(),
            "x".repeat(MAX_REMOTE_SESSION_TITLE_BYTES + 1),
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(
                create_remote_session(
                    &db,
                    &Settings::default(),
                    &format!("unsafe-title-{index}"),
                    Some(&title),
                )
                .unwrap_err(),
                CommandRejectionCode::InvalidRequest
            );
        }
        assert!(db.list_sessions().unwrap().is_empty());

        let trimmed = create_remote_session(
            &db,
            &Settings::default(),
            "trimmed-title",
            Some("  Safe title  "),
        )
        .unwrap();
        assert_eq!(trimmed.title, "Safe title");
    }

    #[test]
    fn remote_create_cannot_persist_a_session_list_beyond_the_noise_budget() {
        let db = Db::open(Path::new(":memory:")).unwrap();
        let title = "t".repeat(MAX_REMOTE_SESSION_TITLE_BYTES);
        let mut successful = 0;
        for index in 0..1_000 {
            match create_remote_session(
                &db,
                &Settings::default(),
                &format!("capacity-{index}"),
                Some(&title),
            ) {
                Ok(_) => successful += 1,
                Err(CommandRejectionCode::DesktopUnavailable) => break,
                Err(other) => panic!("unexpected capacity result: {other:?}"),
            }
        }
        assert!(
            successful > 1,
            "fixture should admit ordinary remote creates"
        );
        let sessions = db.list_sessions().unwrap();
        assert_eq!(sessions.len(), successful);
        let frame = public::session_list_frame(sessions);
        let encoded = serde_json::to_vec(&frame).unwrap();
        assert!(encoded.len() <= public::PHONE_FRAME_BUDGET);
        assert_eq!(
            create_remote_session(&db, &Settings::default(), "capacity-final", Some(&title),)
                .unwrap_err(),
            CommandRejectionCode::DesktopUnavailable
        );
        assert_eq!(db.list_sessions().unwrap().len(), successful);
    }

    #[test]
    fn command_rejection_is_correlated_and_uses_only_bounded_public_copy() {
        let frame = command_rejection_frame(
            "create-42",
            CommandRejectionCode::OpenAiAccountSelectionRequired,
        );
        assert!(matches!(
            frame,
            SyncFrame::CommandRejected {
                request_id: Some(request_id),
                code: CommandRejectionCode::OpenAiAccountSelectionRequired,
                message,
            } if request_id == "create-42"
                && message.len() <= MAX_COMMAND_REJECTION_MESSAGE_BYTES
                && !message.chars().any(char::is_control)
                && message.contains("desktop")
        ));

        let hostile = format!("{}\nsecret\0{}", "x".repeat(400), "y".repeat(400));
        let sanitized = bounded_public_message(&hostile);
        assert!(sanitized.len() <= MAX_COMMAND_REJECTION_MESSAGE_BYTES);
        assert!(!sanitized.chars().any(char::is_control));
        assert!(!sanitized.contains(&"x".repeat(40)));
        assert!(sanitized.contains("[redacted-key]"));

        let redacted = bounded_public_message(
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 at C:\\Users\\Alice\\db",
        );
        assert!(!redacted.contains("abcdefghijklmnopqrstuvwxyz"));
        assert!(!redacted.contains("Alice"));
        assert!(redacted.contains("[redacted"));
    }

    #[test]
    fn unsafe_request_id_is_not_reflected_to_the_phone() {
        let oversized = "r".repeat(public::MAX_REMOTE_IDENTIFIER_BYTES + 1);
        for request_id in ["", "line\nbreak", "session:agent", oversized.as_str()] {
            assert!(matches!(
                command_rejection_frame(
                    request_id,
                    CommandRejectionCode::OpenAiAccountSelectionRequired,
                ),
                SyncFrame::CommandRejected {
                    request_id: None,
                    code: CommandRejectionCode::InvalidRequest,
                    ..
                }
            ));
        }
    }

    #[test]
    fn remote_session_ids_are_validated_before_authoritative_lookup() {
        let db = Db::open(Path::new(":memory:")).unwrap();
        db.create_session("stored-session", "Stored", None, None, 1)
            .unwrap();

        assert_eq!(
            authoritative_remote_session_id(&db, "stored-session").as_deref(),
            Some("stored-session")
        );
        for rejected in [
            "unknown-session",
            "stored-session:agent",
            "stored-session\nreflected",
            "",
        ] {
            assert_eq!(authoritative_remote_session_id(&db, rejected), None);
        }
        assert_eq!(db.list_sessions().unwrap().len(), 1);
    }
}
