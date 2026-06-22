//! The agent loop: stream a turn, run any requested tools (mutating tools pass
//! through the permission gate), repeat until the model finishes. Conversation
//! state is persisted to SQLite so threads survive restarts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::AppHandle;
use uuid::Uuid;

use crate::db::{self, Db};
use crate::llm::{self, Block, ChatMessage, StreamEvent};
use crate::oauth;
use crate::permissions::{self, Decision, Pending};
use crate::secrets::{self, Credential};
use crate::settings::Settings;
use crate::tools::{self, ToolCtx};

type Cancels = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

/// Refresh an OAuth access token once it is within this many seconds of expiry.
const REFRESH_SKEW_SECS: i64 = 60;

fn emit(app: &AppHandle, channel: &str, ev: StreamEvent) {
    // Canonical chokepoint: delivers to the desktop UI and mirrors to the phone.
    crate::sync::emit_event(app, channel, ev);
}

fn system_prompt(workspace: &Path) -> String {
    format!(
        "You are a coding assistant working inside Portcode, a fast, native AI \
coding app for Windows (part of the Porthex toolset). Portcode is the app you \
operate in, not your identity. If the user asks who or what you are, answer \
truthfully as the underlying model you actually are (for example, Claude); never \
claim to be \"Portcode\" or \"Porthex\". You help the user understand and modify \
code in their workspace.\n\n\
Workspace root: {}\n\
Operating system: Windows.\n\
Shell: the `shell` tool runs PowerShell (Windows PowerShell 5.1) by default, so write commands \
in PowerShell syntax (e.g. $env:VAR, here-strings, cmdlets, `;` to chain). Pass shell=\"cmd\" \
for the legacy command prompt or shell=\"pwsh\" for PowerShell 7+ when a command needs that \
shell's quoting or semantics.\n\n\
Use the provided tools to inspect files before answering questions about the code. \
Prefer reading the relevant files over guessing. When editing, make targeted changes \
and explain what you did. Keep responses concise and technical. When you show code, \
use fenced code blocks with a language tag.",
        workspace.display()
    )
}

fn derive_title(text: &str) -> String {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > 42 {
        let head: String = t.chars().take(42).collect();
        format!("{head}…")
    } else if t.is_empty() {
        "New chat".into()
    } else {
        t
    }
}

/// Classify an OAuth refresh failure. A 4xx from the token endpoint (or an
/// `invalid_grant`) means the refresh token is permanently rejected and the
/// subscription session must be re-established; a network/timeout error is
/// transient and worth retrying. `post_tokens` formats the HTTP status as
/// `(<status>)` in the error string, so we classify on that.
fn is_terminal_auth_error(err: &str) -> bool {
    err.contains("(400")
        || err.contains("(401")
        || err.contains("(403")
        || err.contains("invalid_grant")
}

/// Return the credential to authenticate the next request with, refreshing an
/// OAuth token that is at/near expiry. Refreshes are single-flight: the shared
/// `refresh_lock` serializes concurrent turns, and the stored token is re-read
/// under the lock so a token another turn just refreshed is reused rather than
/// refreshed again.
async fn ensure_fresh(
    http: &reqwest::Client,
    cred: Credential,
    refresh_lock: &tokio::sync::Mutex<()>,
) -> Result<Credential, String> {
    let tokens = match cred {
        Credential::OAuth(t) => t,
        api_key => return Ok(api_key),
    };

    if tokens.expires_at - oauth::now_secs() > REFRESH_SKEW_SECS {
        return Ok(Credential::OAuth(tokens));
    }

    let _guard = refresh_lock.lock().await;
    // Re-check under the lock: another turn may have refreshed already. Prefer
    // the freshest stored token over the one we came in with.
    let current = secrets::get_oauth().unwrap_or(tokens);
    if current.expires_at - oauth::now_secs() > REFRESH_SKEW_SECS {
        return Ok(Credential::OAuth(current));
    }

    let mut refreshed = match oauth::refresh(http, &current.refresh_token).await {
        Ok(r) => r,
        Err(e) => {
            // A terminal auth failure (refresh token rejected) can never recover, and
            // leaving the stale OAuth in place would fail EVERY future turn — even for
            // a user who also has a valid API key, since OAuth shadows it in
            // `load_credential`. Clear it so the API-key path takes over automatically
            // and the user gets a clear "sign in again" instead of a permanent brick.
            if is_terminal_auth_error(&e) {
                let _ = secrets::clear_oauth();
                return Err(
                    "Your Claude subscription session expired. Please sign in again in \
                     Settings (or add an Anthropic API key)."
                        .to_string(),
                );
            }
            // Transient (network / timeout): keep the tokens so a retry can succeed.
            return Err(e);
        }
    };
    // The refresh response carries no profile, so keep the display metadata
    // (email + plan tier) that we captured at sign-in.
    refreshed.email = current.email;
    refreshed.plan = current.plan;
    secrets::set_oauth(&refreshed)?;
    Ok(Credential::OAuth(refreshed))
}

#[allow(clippy::too_many_arguments)]
pub async fn run(
    app: AppHandle,
    http: reqwest::Client,
    settings: Arc<Mutex<Settings>>,
    db: Arc<Db>,
    cancels: Cancels,
    pending: Pending,
    oauth_refresh: Arc<tokio::sync::Mutex<()>>,
    session_id: String,
    user_text: String,
) {
    let channel = format!("agent://{session_id}");

    // Refuse a second concurrent run for the same session. Two runs would collide on
    // the cancel flag (Stop could hit the wrong one), the first run's entry would be
    // evicted, and their DB writes would interleave and corrupt the conversation
    // history. The desktop UI already guards this; this also covers a phone driving
    // the same session over Phone Sync.
    let cancel = Arc::new(AtomicBool::new(false));
    let already_running = {
        use std::collections::hash_map::Entry;
        let mut map = cancels.lock().unwrap();
        match map.entry(session_id.clone()) {
            Entry::Occupied(_) => true,
            Entry::Vacant(slot) => {
                slot.insert(cancel.clone());
                false
            }
        }
    };
    if already_running {
        emit(
            &app,
            &channel,
            StreamEvent::Error {
                message: "A turn is already running for this session.".to_string(),
            },
        );
        return;
    }

    emit(
        &app,
        &channel,
        StreamEvent::TurnStart {
            message_id: Uuid::new_v4().to_string(),
        },
    );

    let result = run_inner(
        &app,
        &http,
        &settings,
        &db,
        &pending,
        &cancel,
        &oauth_refresh,
        &channel,
        &session_id,
        user_text,
    )
    .await;

    {
        let mut map = cancels.lock().unwrap();
        map.remove(&session_id);
    }

    match result {
        Ok(stop_reason) => emit(&app, &channel, StreamEvent::TurnEnd { stop_reason }),
        Err(message) => emit(&app, &channel, StreamEvent::Error { message }),
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_inner(
    app: &AppHandle,
    http: &reqwest::Client,
    settings: &Arc<Mutex<Settings>>,
    db: &Arc<Db>,
    pending: &Pending,
    cancel: &Arc<AtomicBool>,
    refresh_lock: &tokio::sync::Mutex<()>,
    channel: &str,
    session_id: &str,
    user_text: String,
) -> Result<String, String> {
    let snapshot = { settings.lock().unwrap().clone() };

    let mut cred = secrets::load_credential().ok_or(
        "No credentials set. Sign in with your Claude subscription or add an Anthropic API key in Settings.",
    )?;

    // No configured workspace falls back to the process working directory — but
    // never to an empty path (the old `unwrap_or_default()`), which would silently
    // root every file/shell tool at "" and produce confusing errors.
    let workspace = match snapshot.workspace.clone() {
        Some(w) => PathBuf::from(w),
        None => std::env::current_dir().map_err(|e| {
            format!(
                "No workspace is set and the current directory is unavailable ({e}). \
                 Set a workspace in Settings."
            )
        })?,
    };

    let registry = tools::default_registry();
    let tool_specs = registry.specs();
    let system = system_prompt(&workspace);
    let ctx = ToolCtx { workspace };

    // Load prior turns from the DB, then persist the new user message.
    let mut messages = db.load_chat_messages(session_id);
    let is_first = messages.is_empty();

    let user_msg = ChatMessage {
        role: "user".into(),
        content: vec![Block::Text {
            text: user_text.clone(),
        }],
    };
    db.append_message(session_id, &user_msg, db::now_ms());
    messages.push(user_msg);
    if is_first {
        db.set_title_if_blank(session_id, &derive_title(&user_text));
    }
    db.touch_session(session_id, db::now_ms());

    let final_stop;

    loop {
        if cancel.load(Ordering::Relaxed) {
            final_stop = "cancelled".to_string();
            break;
        }

        // Refresh an expiring OAuth token before each turn (no-op for API keys).
        cred = ensure_fresh(http, cred, refresh_lock).await?;

        let turn = llm::stream_turn(
            http,
            &cred,
            &snapshot.model,
            &system,
            &messages,
            &tool_specs,
            app,
            channel,
            cancel,
        )
        .await?;

        emit(
            app,
            channel,
            StreamEvent::Usage {
                input_tokens: turn.input_tokens,
                output_tokens: turn.output_tokens,
            },
        );

        let assistant = ChatMessage {
            role: "assistant".into(),
            content: turn.content.clone(),
        };
        db.append_message(session_id, &assistant, db::now_ms());
        messages.push(assistant);

        if turn.stop_reason == "tool_use" {
            let mut results: Vec<Block> = Vec::new();
            for block in &turn.content {
                if let Block::ToolUse { id, name, input } = block {
                    let (output, is_error) = match registry.find(name) {
                        Some(tool) => {
                            let decision = if tool.mutating() {
                                permissions::gate(
                                    app,
                                    channel,
                                    &snapshot.default_policy,
                                    pending,
                                    cancel,
                                    name,
                                    &tool.summarize(input),
                                    input,
                                )
                                .await
                            } else {
                                Decision::Allow
                            };
                            match decision {
                                Decision::Allow => match tool.run(input.clone(), &ctx).await {
                                    Ok(out) => (out, false),
                                    Err(err) => (err, true),
                                },
                                Decision::Deny => (
                                    "Denied: the user did not approve this action.".to_string(),
                                    true,
                                ),
                            }
                        }
                        None => (format!("Unknown tool: {name}"), true),
                    };
                    emit(
                        app,
                        channel,
                        StreamEvent::ToolResult {
                            id: id.clone(),
                            output: output.clone(),
                            is_error,
                        },
                    );
                    results.push(Block::ToolResult {
                        tool_use_id: id.clone(),
                        content: output,
                        is_error,
                    });
                }
            }
            // A tool_use turn that yields no usable tool result would post an
            // empty-content user message, which Anthropic rejects (400) and which
            // then poisons the persisted history so every later turn also 400s.
            if results.is_empty() {
                return Err("The model asked to use a tool but returned no usable tool \
                            call. Please try again."
                    .to_string());
            }
            let tool_msg = ChatMessage {
                role: "user".into(),
                content: results,
            };
            db.append_message(session_id, &tool_msg, db::now_ms());
            messages.push(tool_msg);
            continue;
        } else {
            final_stop = turn.stop_reason;
            break;
        }
    }

    db.touch_session(session_id, db::now_ms());
    Ok(final_stop)
}

#[cfg(test)]
mod tests {
    use super::{derive_title, is_terminal_auth_error};

    #[test]
    fn classifies_terminal_vs_transient_auth_errors() {
        // 4xx / invalid_grant from the token endpoint → terminal (clear + re-auth).
        assert!(is_terminal_auth_error(
            "OAuth token request failed (401 Unauthorized): invalid_grant"
        ));
        assert!(is_terminal_auth_error(
            "OAuth token request failed (400 Bad Request): bad refresh token"
        ));
        // Network / timeout / 5xx → transient (keep tokens, let the user retry).
        assert!(!is_terminal_auth_error("Token request timed out."));
        assert!(!is_terminal_auth_error(
            "Token request failed: connection refused"
        ));
        assert!(!is_terminal_auth_error(
            "OAuth token request failed (500 Internal Server Error): oops"
        ));
    }

    #[test]
    fn derive_title_truncates_long_input() {
        let long = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
        let title = derive_title(long);
        // 42 chars plus the single-character ellipsis.
        assert!(title.chars().count() <= 43, "title was {title:?}");
        assert!(title.ends_with('…'));
    }

    #[test]
    fn derive_title_collapses_whitespace() {
        assert_eq!(derive_title("  hello   world  "), "hello world");
    }

    #[test]
    fn derive_title_defaults_when_empty() {
        assert_eq!(derive_title("   "), "New chat");
    }
}
