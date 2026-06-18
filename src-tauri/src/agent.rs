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
use crate::permissions::{self, Decision, Pending};
use crate::secrets;
use crate::settings::Settings;
use crate::tools::{self, ToolCtx};

type Cancels = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

fn emit(app: &AppHandle, channel: &str, ev: StreamEvent) {
    use tauri::Emitter;
    let _ = app.emit(channel, ev);
}

fn system_prompt(workspace: &Path) -> String {
    format!(
        "You are Portcode, a fast, native AI coding agent for Windows, part of the \
Porthex toolset. You help the user understand and modify code in their workspace.\n\n\
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

#[allow(clippy::too_many_arguments)]
pub async fn run(
    app: AppHandle,
    http: reqwest::Client,
    settings: Arc<Mutex<Settings>>,
    db: Arc<Db>,
    cancels: Cancels,
    pending: Pending,
    session_id: String,
    user_text: String,
) {
    let channel = format!("agent://{session_id}");

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = cancels.lock().unwrap();
        map.insert(session_id.clone(), cancel.clone());
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
    channel: &str,
    session_id: &str,
    user_text: String,
) -> Result<String, String> {
    let snapshot = { settings.lock().unwrap().clone() };

    let api_key =
        secrets::get_api_key().ok_or("No API key set. Add your Anthropic API key in Settings.")?;

    let workspace = snapshot
        .workspace
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

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

        let turn = llm::stream_turn(
            http,
            &api_key,
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
    use super::derive_title;

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
