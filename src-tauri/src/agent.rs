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

/// Hard ceiling on model turns (and therefore tool batches) in a single run. A
/// confused model or an indirect prompt injection can otherwise loop forever,
/// burning tokens and mutating the workspace unbounded. When exceeded, the run
/// stops with a clear error instead of looping.
const MAX_AGENT_STEPS: usize = 50;

/// True once the per-run step counter has passed the ceiling. `step` is 1-based
/// (the count of the turn about to run), so step `MAX_AGENT_STEPS` is allowed and
/// `MAX_AGENT_STEPS + 1` is the first one rejected.
fn step_limit_exceeded(step: usize) -> bool {
    step > MAX_AGENT_STEPS
}

/// Whether the remaining tools in a batch should be skipped: either a prior tool
/// in this batch was already cancelled, or the cancel flag is now set. Used both
/// at the top of each block and right before running an allowed tool, so a Stop
/// that lands mid-batch interrupts the rest.
fn batch_cancelled(prev_cancelled: bool, cancel_flag: bool) -> bool {
    prev_cancelled || cancel_flag
}

/// The synthetic tool_result text posted for a ToolUse block that was skipped
/// because the user pressed Stop. Anthropic requires a result for every tool_use,
/// so we post this (as an error) rather than dropping the block.
const CANCELLED_TOOL_RESULT: &str = "Cancelled: the user stopped the turn before this tool ran.";

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

/// Per-run agent configuration: the tool registry and the system prompt the
/// loop runs with.
///
/// Both were hard-wired inside [`run_inner`]; pulling them into a config makes a
/// run parameterizable instead. A subagent brings its own tool set and prompt;
/// plan mode swaps in a read-only registry; the interactive run uses the
/// defaults. The agent loop depends only on this config — never on which
/// tools/prompt a particular run happens to use — which is the seam the
/// subagent runtime and plan mode build on. [`AgentConfig::default_run`]
/// reproduces the previous behavior exactly.
pub(crate) struct AgentConfig {
    /// The tools this run may call.
    registry: tools::Registry,
    /// System-prompt override. `None` derives the default workspace prompt once
    /// the workspace is resolved (see [`resolve_system_prompt`]).
    system_prompt: Option<String>,
    /// An extra steer appended AFTER the resolved system prompt (e.g. the
    /// plan-mode "design only" instruction). Kept separate from the override so a
    /// steer can ride on top of the default workspace prompt — which embeds the
    /// workspace root — rather than replacing it.
    prompt_steer: Option<String>,
}

/// Plan-mode steer appended to the system prompt. Paired with the read-only
/// registry so the model both *can't* mutate (no write/edit/shell tools) and
/// *knows* it shouldn't — it should design and explain instead.
const PLAN_MODE_STEER: &str = "You are in PLAN MODE. Do NOT modify anything in this turn: \
the file-writing, editing, and shell tools are intentionally unavailable. Investigate with the \
read-only tools, then lay out a clear, concrete plan for the change — the files you'd touch and \
what you'd do in each — and explain your approach. Tell the user to approve the plan (exit plan \
mode) when they want you to apply it.";

impl AgentConfig {
    /// The standard interactive run: the default tool registry and the default
    /// (workspace-derived) system prompt.
    pub(crate) fn default_run() -> Self {
        Self {
            registry: tools::default_registry(),
            system_prompt: None,
            prompt_steer: None,
        }
    }

    /// Plan mode: a READ-ONLY tool registry (no write/edit/shell) plus the
    /// plan-mode steer on top of the default workspace prompt. Defense-in-depth
    /// with the permission gate, which also denies every mutating tool when the
    /// permission mode is `Plan`.
    pub(crate) fn plan_run() -> Self {
        Self {
            registry: tools::read_only_registry(),
            system_prompt: None,
            prompt_steer: Some(PLAN_MODE_STEER.to_string()),
        }
    }
}

/// Resolve the system prompt for a run: the explicit override if one was given,
/// otherwise the default workspace prompt, with an optional steer appended. Kept
/// separate and pure so the prompt seam is unit-testable without standing up a
/// full run.
fn resolve_system_prompt(over: Option<String>, steer: Option<String>, workspace: &Path) -> String {
    let mut prompt = over.unwrap_or_else(|| system_prompt(workspace));
    if let Some(steer) = steer {
        prompt.push_str("\n\n");
        prompt.push_str(&steer);
    }
    prompt
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

    // Plan mode swaps in the read-only registry + plan steer; every other mode
    // uses the default run. Both the desktop `run_agent` command and the phone's
    // Run command funnel through `run`, so this single check covers both paths.
    let config = if settings.lock().unwrap().permission_mode == permissions::PermissionMode::Plan {
        AgentConfig::plan_run()
    } else {
        AgentConfig::default_run()
    };

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
        config,
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
    config: AgentConfig,
) -> Result<String, String> {
    let snapshot = { settings.lock().unwrap().clone() };

    let mut cred = secrets::load_credential().ok_or(
        "No credentials set. Sign in with your Claude subscription or add an Anthropic API key in Settings.",
    )?;

    // Resolve the LLM provider up front, alongside the credential check above:
    // both are pre-flight config validations that fail before any DB write (so an
    // unconfigured run never half-persists). An unknown `provider` value fails
    // here with a clear message instead of silently calling Anthropic. Anthropic
    // is the only provider today; `llm::LlmProvider` is the seam others plug into.
    let provider = llm::provider_for(&snapshot.provider)?;

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

    // The tool set and system prompt come from the per-run config rather than
    // being hard-wired, so a subagent / plan-mode run can supply its own.
    let AgentConfig {
        registry,
        system_prompt: system_override,
        prompt_steer,
    } = config;
    let tool_specs = registry.specs();
    let system = resolve_system_prompt(system_override, prompt_steer, &workspace);
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
    db.try_append_message(session_id, &user_msg, db::now_ms())
        .map_err(|e| format!("Failed to save your message: {e}"))?;
    messages.push(user_msg);
    if is_first {
        db.set_title_if_blank(session_id, &derive_title(&user_text));
    }
    db.touch_session(session_id, db::now_ms());

    let final_stop;
    let mut steps: usize = 0;

    loop {
        if cancel.load(Ordering::Relaxed) {
            final_stop = "cancelled".to_string();
            break;
        }

        // Kill-switch: cap the number of model turns / tool batches per run so a
        // runaway (model confusion or prompt injection) can't loop unboundedly.
        steps += 1;
        if step_limit_exceeded(steps) {
            return Err(format!(
                "Run stopped: exceeded the maximum of {MAX_AGENT_STEPS} steps. \
                 This usually means the model got stuck in a loop. Start a new \
                 message to continue."
            ));
        }

        // Refresh an expiring OAuth token before each turn (no-op for API keys).
        cred = ensure_fresh(http, cred, refresh_lock).await?;

        let turn = provider
            .stream_turn(
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
        db.try_append_message(session_id, &assistant, db::now_ms())
            .map_err(|e| format!("Failed to save the reply: {e}"))?;
        messages.push(assistant);

        if turn.stop_reason == "tool_use" {
            let mut results: Vec<Block> = Vec::new();
            let mut cancelled = false;
            for block in &turn.content {
                if let Block::ToolUse { id, name, input } = block {
                    // Stop must interrupt an in-flight batch: once cancelled, run no
                    // more tools, but still post a synthetic tool_result for every
                    // remaining ToolUse so the persisted history stays well-formed
                    // (Anthropic requires a result for each tool_use, else it 400s).
                    if batch_cancelled(cancelled, cancel.load(Ordering::Relaxed)) {
                        cancelled = true;
                        let output = CANCELLED_TOOL_RESULT.to_string();
                        emit(
                            app,
                            channel,
                            StreamEvent::ToolResult {
                                id: id.clone(),
                                output: output.clone(),
                                is_error: true,
                            },
                        );
                        results.push(Block::ToolResult {
                            tool_use_id: id.clone(),
                            content: output,
                            is_error: true,
                        });
                        continue;
                    }
                    let (output, is_error) = match registry.find(name) {
                        Some(tool) => {
                            let decision = if tool.mutating() {
                                permissions::gate(
                                    app,
                                    channel,
                                    snapshot.permission_mode,
                                    &snapshot.rules,
                                    &snapshot.default_policy,
                                    pending,
                                    cancel,
                                    name,
                                    &tool.summarize(input, &ctx),
                                    input,
                                )
                                .await
                            } else {
                                Decision::Allow
                            };
                            match decision {
                                // Re-check cancel right before running: a Stop that
                                // arrived during the gate (or during a prior tool in
                                // this batch) must not let this tool execute.
                                Decision::Allow if cancel.load(Ordering::Relaxed) => {
                                    cancelled = true;
                                    (CANCELLED_TOOL_RESULT.to_string(), true)
                                }
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
            db.try_append_message(session_id, &tool_msg, db::now_ms())
                .map_err(|e| format!("Failed to save tool results: {e}"))?;
            messages.push(tool_msg);
            // If the batch was cancelled mid-flight, stop here rather than starting
            // another model turn. The tool results above are already persisted, so the
            // history stays well-formed for a later resume.
            if cancelled {
                final_stop = "cancelled".to_string();
                break;
            }
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
    use super::{
        batch_cancelled, derive_title, is_terminal_auth_error, resolve_system_prompt,
        step_limit_exceeded, AgentConfig, MAX_AGENT_STEPS,
    };
    use std::path::Path;

    fn spec_names(cfg: &AgentConfig) -> Vec<String> {
        cfg.registry
            .specs()
            .iter()
            .map(|s| s["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn resolve_system_prompt_prefers_an_explicit_override() {
        // A subagent run supplies its own prompt; the override wins verbatim and
        // the default workspace prompt is not consulted.
        let prompt = resolve_system_prompt(
            Some("CUSTOM SUBAGENT PROMPT".into()),
            None,
            Path::new("/ws"),
        );
        assert_eq!(prompt, "CUSTOM SUBAGENT PROMPT");
    }

    #[test]
    fn resolve_system_prompt_falls_back_to_the_default_workspace_prompt() {
        // No override → the default workspace prompt, which embeds the workspace
        // root so the model knows where it is operating.
        let prompt = resolve_system_prompt(None, None, Path::new("/tmp/some-workspace"));
        assert!(prompt.contains("Workspace root:"));
        assert!(prompt.contains("/tmp/some-workspace"));
    }

    #[test]
    fn resolve_system_prompt_appends_a_steer_after_the_workspace_prompt() {
        // A steer (e.g. plan mode) rides on TOP of the workspace prompt rather
        // than replacing it, so the workspace root is still present.
        let prompt =
            resolve_system_prompt(None, Some("PLAN STEER".into()), Path::new("/tmp/ws-here"));
        assert!(prompt.contains("Workspace root:"));
        assert!(prompt.contains("/tmp/ws-here"));
        assert!(prompt.contains("PLAN STEER"));
        // The steer comes after the base prompt.
        assert!(prompt.find("Workspace root:") < prompt.find("PLAN STEER"));
    }

    #[test]
    fn default_run_config_uses_the_standard_registry_and_no_override_or_steer() {
        // The interactive run is unchanged: the full default tool set and no
        // prompt override / steer (so it derives the workspace prompt).
        let cfg = AgentConfig::default_run();
        assert_eq!(
            spec_names(&cfg),
            ["fs_read", "list", "glob", "grep", "fs_write", "fs_edit", "shell"]
        );
        assert!(cfg.system_prompt.is_none());
        assert!(cfg.prompt_steer.is_none());
    }

    #[test]
    fn plan_run_config_is_read_only_and_carries_the_plan_steer() {
        // Plan mode hands the model only the read-only tools (no write/edit/shell)
        // and a steer that tells it to design rather than mutate.
        let cfg = AgentConfig::plan_run();
        assert_eq!(spec_names(&cfg), ["fs_read", "list", "glob", "grep"]);
        let steer = cfg.prompt_steer.expect("plan mode carries a steer");
        assert!(steer.contains("PLAN MODE"));
    }

    #[test]
    fn step_limit_allows_up_to_the_ceiling_then_rejects() {
        assert!(!step_limit_exceeded(1));
        assert!(!step_limit_exceeded(MAX_AGENT_STEPS));
        // The first step past the ceiling is rejected, breaking the agent loop with
        // an error instead of looping forever.
        assert!(step_limit_exceeded(MAX_AGENT_STEPS + 1));
        assert!(step_limit_exceeded(MAX_AGENT_STEPS + 100));
    }

    #[test]
    fn batch_cancel_short_circuits_once_cancelled_or_flagged() {
        // Not cancelled and flag clear → keep running the batch.
        assert!(!batch_cancelled(false, false));
        // A live cancel flag stops the rest of the batch (a Stop landing mid-batch).
        assert!(batch_cancelled(false, true));
        // Once a prior tool in the batch was cancelled, stay cancelled even if the
        // flag is somehow re-read as clear.
        assert!(batch_cancelled(true, false));
        assert!(batch_cancelled(true, true));
    }

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
