//! The agent loop: stream a turn, run any requested tools (mutating tools pass
//! through the permission gate), repeat until the model finishes. Conversation
//! state is persisted to SQLite so threads survive restarts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::stream::StreamExt;
use serde_json::Value;
use tauri::AppHandle;
use uuid::Uuid;

use crate::agents;
use crate::background;
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

/// Maximum subagent nesting depth. The user-facing run is depth 0; a subagent it
/// launches is depth 1, and so on. A confused or injected agent that keeps calling
/// `task` could otherwise fan out without bound, so a subagent at this depth is
/// handed no `task` tool (and the spawner refuses past it as a backstop).
const MAX_SUBAGENT_DEPTH: usize = 3;

/// How many subagents from ONE tool-use batch run concurrently. The model can
/// emit several `task` calls in a turn; they run in parallel up to this cap (the
/// rest queue), so a wide fan-out can't open unbounded simultaneous model streams.
const MAX_PARALLEL_AGENTS: usize = 4;

/// Steer prepended (as a system-prompt addendum) for a subagent run. It tells the
/// model it is an autonomous, single-shot worker whose final message is its entire
/// return value — paired with the subagent tool set in [`tools::subagent_registry`].
const SUBAGENT_STEER: &str = "You are a SUBAGENT launched to carry out one specific, well-scoped task \
on behalf of another agent. Work independently with your tools and finish with a single, self-contained \
summary of what you found or did — that final message is your ENTIRE return value to the agent that \
launched you, so make it stand on its own. You cannot ask the launching agent questions; make reasonable \
assumptions and state any you made.";

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
    agents: agents::Agents,
    background: background::Background,
    oauth_refresh: Arc<tokio::sync::Mutex<()>>,
    session_id: String,
    user_text: String,
    model: Option<String>,
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

    // Serializes the permission PROMPT across this run: the top-level turn and all
    // its (possibly parallel) subagents share one lock, so only one "ask" is ever
    // outstanding at a time and concurrent subagents can't clobber the single UI
    // prompt slot. Created per run, never held across a tool's actual work.
    let ask_lock = Arc::new(tokio::sync::Mutex::new(()));

    let result = run_inner(
        &app,
        &http,
        &settings,
        &db,
        &pending,
        &agents,
        &background,
        &cancel,
        &oauth_refresh,
        &ask_lock,
        &channel,
        &session_id,
        user_text,
        config,
        model,
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
    agents: &agents::Agents,
    background: &background::Background,
    cancel: &Arc<AtomicBool>,
    refresh_lock: &Arc<tokio::sync::Mutex<()>>,
    ask_lock: &Arc<tokio::sync::Mutex<()>>,
    channel: &str,
    session_id: &str,
    user_text: String,
    config: AgentConfig,
    model: Option<String>,
) -> Result<String, String> {
    let snapshot = { settings.lock().unwrap().clone() };

    // Prefer the per-session model threaded from the frontend; fall back to the
    // global settings default when it is absent or empty.
    let active_model = model
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| snapshot.model.clone());

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
    let system = resolve_system_prompt(system_override, prompt_steer, &workspace);

    // Attach a subagent spawner only when this run actually exposes the `task`
    // tool. Plan mode's read-only registry has no `task`, so it gets no spawner and
    // can never launch a (mutating) subagent — defense-in-depth with the gate,
    // which already denies mutating tools in plan mode.
    let spawner: Option<Arc<dyn tools::Spawner>> = if registry.find("task").is_some() {
        Some(Arc::new(AgentSpawner {
            app: app.clone(),
            http: http.clone(),
            settings: settings.clone(),
            pending: pending.clone(),
            agents: agents.clone(),
            cancel: cancel.clone(),
            refresh_lock: refresh_lock.clone(),
            ask_lock: ask_lock.clone(),
            parent_channel: channel.to_string(),
            workspace: workspace.clone(),
            // The top-level run is not itself a registered subagent, so the
            // children it launches have no parent agent id.
            self_id: None,
            depth: 1,
        }))
    } else {
        None
    };
    let mut ctx = ToolCtx::new(workspace);
    ctx.spawner = spawner;
    // Attach a background runner only when this run exposes `shell` (plan mode's
    // read-only registry has none, so it can't background). Subagents don't get one
    // in this version, so their `shell` runs foreground.
    if registry.find("shell").is_some() {
        ctx.background = Some(Arc::new(BackgroundLauncher {
            app: app.clone(),
            background: background.clone(),
            session_channel: channel.to_string(),
            session_id: session_id.to_string(),
        }));
    }

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

    // The interactive run is its own session: agent output, permission prompts,
    // and usage all flow on the same `agent://{session}` channel, and every
    // message persists to the session.
    let outcome = run_loop_core(
        app,
        http,
        provider.as_ref(),
        &snapshot,
        cred,
        refresh_lock,
        ask_lock,
        pending,
        cancel,
        channel,
        channel,
        None,
        &registry,
        &system,
        &ctx,
        messages,
        &Persist::Session { db, session_id },
    )
    .await?;
    Ok(outcome.stop_reason)
}

/// Where a run's transcript goes. The interactive run persists every message to
/// its SQLite session; a subagent is **ephemeral** — it keeps the transcript only
/// in memory, so it never pollutes the parent thread or the database.
enum Persist<'a> {
    Session { db: &'a Db, session_id: &'a str },
    Ephemeral,
}

impl Persist<'_> {
    /// Append a freshly produced message to the durable store, if any. `what`
    /// names the message for the error path ("the reply" / "tool results").
    fn append(&self, msg: &ChatMessage, what: &str) -> Result<(), String> {
        match self {
            Persist::Session { db, session_id } => db
                .try_append_message(session_id, msg, db::now_ms())
                .map(|_| ())
                .map_err(|e| format!("Failed to save {what}: {e}")),
            Persist::Ephemeral => Ok(()),
        }
    }

    /// Bump the session's last-activity timestamp (no-op for an ephemeral run).
    fn touch(&self) {
        if let Persist::Session { db, session_id } = self {
            db.touch_session(session_id, db::now_ms());
        }
    }
}

/// The result of running an agent loop to completion.
struct LoopOutcome {
    /// The terminal stop reason ("end_turn", "cancelled", …).
    stop_reason: String,
    /// The text of the final assistant message — a subagent's answer to whoever
    /// launched it. Empty if the run ended before producing any assistant text.
    final_text: String,
}

/// The shared agent loop: stream a turn, run any requested tools (mutating tools
/// pass through the permission gate), repeat until the model finishes, is
/// cancelled, or hits the step ceiling.
///
/// Lifted out of [`run_inner`] so the interactive run and a subagent share ONE
/// loop and can never drift apart. They differ only in their parameters — in
/// particular the two channels, which split per-agent output from session-level
/// events:
///
///  * `agent_channel` carries THIS agent's private turn output — text/tool deltas
///    and tool results. The interactive run uses `agent://{session}`; a subagent
///    uses its own `agent://{session}:{agentId}` so its work never folds into the
///    parent transcript.
///  * `session_channel` carries events that belong to the owning SESSION rather
///    than the individual agent: permission prompts (so a subagent's prompts reach
///    the existing prompt UI and a paired phone) and token usage (so a subagent's
///    cost rolls up into the session total instead of vanishing on an unwatched
///    channel). A subagent points this at its PARENT channel; the interactive run
///    passes its own `agent://{session}` for both.
///  * `agent_id` is `Some` for a subagent — each completed turn then emits an
///    `AgentProgress` on `session_channel` so the agents panel shows liveness.
///    `None` for the interactive run (which has no panel row).
///  * `persist` is `Session` for the interactive run (writes to the DB) and
///    `Ephemeral` for a subagent (in-memory only).
#[allow(clippy::too_many_arguments)]
async fn run_loop_core(
    app: &AppHandle,
    http: &reqwest::Client,
    provider: &dyn llm::LlmProvider,
    snapshot: &Settings,
    mut cred: Credential,
    refresh_lock: &tokio::sync::Mutex<()>,
    ask_lock: &tokio::sync::Mutex<()>,
    pending: &Pending,
    cancel: &Arc<AtomicBool>,
    agent_channel: &str,
    session_channel: &str,
    agent_id: Option<&str>,
    registry: &tools::Registry,
    system: &str,
    ctx: &ToolCtx,
    mut messages: Vec<ChatMessage>,
    persist: &Persist<'_>,
) -> Result<LoopOutcome, String> {
    let tool_specs = registry.specs();
    let final_stop;
    let mut final_text = String::new();
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
                &active_model,
                system,
                &messages,
                &tool_specs,
                app,
                agent_channel,
                cancel,
            )
            .await?;

        // Usage is a SESSION-level event: route it to `session_channel` so a
        // subagent's token cost rolls up into the parent session's total rather
        // than streaming to an unwatched child channel and being lost. For the
        // interactive run the two channels are identical, so this is unchanged.
        emit(
            app,
            session_channel,
            StreamEvent::Usage {
                input_tokens: turn.input_tokens,
                output_tokens: turn.output_tokens,
            },
        );
        // Persist the cumulative token spend so the running total (and per-session
        // meter) survives a restart. Best-effort: a failed usage write must not abort
        // the turn — the live in-memory counter already reflected this event.
        let _ = db.add_usage(
            session_id,
            i64::from(turn.input_tokens),
            i64::from(turn.output_tokens),
            db::now_ms(),
        );

        // Liveness for the agents panel: a subagent reports each completed turn on
        // the session channel (where the panel listens). `steps` is its 1-based turn
        // count. The interactive run (`agent_id == None`) has no panel row.
        if let Some(id) = agent_id {
            emit(
                app,
                session_channel,
                StreamEvent::AgentProgress {
                    agent_id: id.to_string(),
                    step: steps as u32,
                },
            );
        }

        // Track the latest assistant text so a subagent can return its final
        // answer; the closing (non-tool-use) turn overwrites any earlier text.
        let text = assistant_text(&turn.content);
        if !text.is_empty() {
            final_text = text;
        }

        let assistant = ChatMessage {
            role: "assistant".into(),
            content: turn.content.clone(),
        };
        persist.append(&assistant, "the reply")?;
        messages.push(assistant);

        if turn.stop_reason == "tool_use" {
            // This batch's tool calls, in order. Regular tools run sequentially with
            // the usual gate/cancel semantics; `task` calls (subagents) are deferred
            // and run CONCURRENTLY afterwards, since they are independent and
            // long-running. Results are slotted back in tool_use order regardless.
            let tool_uses: Vec<(&str, &str, &Value)> = turn
                .content
                .iter()
                .filter_map(|b| match b {
                    Block::ToolUse { id, name, input } => Some((id.as_str(), name.as_str(), input)),
                    _ => None,
                })
                .collect();
            let mut cancelled = false;
            // Each finished call records (tool_use index, output, is_error); the batch
            // is reassembled in tool_use order at the end (subagents finish out of order).
            let mut done: Vec<(usize, String, bool)> = Vec::new();
            // Deferred subagent calls; each future yields (tool_use index, output, is_error).
            let mut task_futs = Vec::new();

            for (i, &(id, name, input)) in tool_uses.iter().enumerate() {
                // Stop must interrupt an in-flight batch: once cancelled, run no more
                // tools, but still post a synthetic tool_result for every remaining
                // ToolUse so the persisted history stays well-formed (Anthropic
                // requires a result for each tool_use, else it 400s).
                if batch_cancelled(cancelled, cancel.load(Ordering::Relaxed)) {
                    cancelled = true;
                    let output = CANCELLED_TOOL_RESULT.to_string();
                    emit(app, agent_channel, tool_result_event(id, &output, true));
                    done.push((i, output, true));
                    continue;
                }

                // Subagents run in parallel: defer the (non-mutating, ungated) `task`
                // call to the concurrent phase below. A final cancel re-check first,
                // mirroring the sequential path.
                if name == "task" {
                    if let Some(tool) = registry.find("task") {
                        if cancel.load(Ordering::Relaxed) {
                            cancelled = true;
                            let output = CANCELLED_TOOL_RESULT.to_string();
                            emit(app, agent_channel, tool_result_event(id, &output, true));
                            done.push((i, output, true));
                        } else {
                            let input = input.clone();
                            task_futs.push(async move {
                                match tool.run(input, ctx).await {
                                    Ok(out) => (i, out, false),
                                    Err(err) => (i, err, true),
                                }
                            });
                        }
                        continue;
                    }
                    // No task tool in this registry → fall through to "unknown tool".
                }

                let (output, is_error) = match registry.find(name) {
                    Some(tool) => {
                        gate_and_run(
                            app,
                            session_channel,
                            snapshot,
                            pending,
                            cancel,
                            ask_lock,
                            tool,
                            ctx,
                            name,
                            input,
                            &mut cancelled,
                        )
                        .await
                    }
                    None => (format!("Unknown tool: {name}"), true),
                };
                emit(app, agent_channel, tool_result_event(id, &output, is_error));
                done.push((i, output, is_error));
            }

            // Drive the deferred subagents concurrently, capped at MAX_PARALLEL_AGENTS,
            // recording each result as it finishes. The streamed ToolResult events land
            // in completion order; the persisted batch is reassembled in tool_use order.
            if !task_futs.is_empty() {
                let mut stream =
                    futures_util::stream::iter(task_futs).buffer_unordered(MAX_PARALLEL_AGENTS);
                while let Some((i, output, is_error)) = stream.next().await {
                    emit(
                        app,
                        agent_channel,
                        tool_result_event(tool_uses[i].0, &output, is_error),
                    );
                    done.push((i, output, is_error));
                }
            }

            // One result per call, reassembled in tool_use order from the (possibly
            // out-of-order) completions above.
            let ids: Vec<&str> = tool_uses.iter().map(|&(id, _, _)| id).collect();
            let results = reassemble_results(&ids, done);
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
            persist.append(&tool_msg, "tool results")?;
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

    persist.touch();
    Ok(LoopOutcome {
        stop_reason: final_stop,
        final_text,
    })
}

/// Concatenate the text blocks of an assistant turn (ignoring tool-use blocks).
fn assistant_text(content: &[Block]) -> String {
    content
        .iter()
        .filter_map(|b| match b {
            Block::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// The streamed `ToolResult` event for one finished tool call.
fn tool_result_event(id: &str, output: &str, is_error: bool) -> StreamEvent {
    StreamEvent::ToolResult {
        id: id.to_string(),
        output: output.to_string(),
        is_error,
    }
}

/// The persisted `ToolResult` content block for one finished tool call.
fn tool_result_block(id: &str, output: String, is_error: bool) -> Block {
    Block::ToolResult {
        tool_use_id: id.to_string(),
        content: output,
        is_error,
    }
}

/// Reassemble one result block per tool call, in tool_use ORDER, from
/// `(index, output, is_error)` completions that may arrive in any order (parallel
/// subagents finish out of order). Each block's `tool_use_id` is the id at its
/// original index, so the persisted batch matches the model's tool_use order
/// regardless of completion order — which is what Anthropic expects.
fn reassemble_results(ids: &[&str], done: Vec<(usize, String, bool)>) -> Vec<Block> {
    let mut slots: Vec<Option<Block>> = vec![None; ids.len()];
    for (i, output, is_error) in done {
        slots[i] = Some(tool_result_block(ids[i], output, is_error));
    }
    slots.into_iter().flatten().collect()
}

/// Given the gate's `decision` and whether a Stop has landed since, decide a tool
/// call's outcome WITHOUT running it: `Some((output, is_error, sets_cancelled))`
/// for a terminal outcome (denied, or cancelled before it could run), or `None`
/// meaning "allowed — run the tool". Keeps the cancel-interrupt and deny semantics
/// in a pure, unit-testable function.
fn precheck_outcome(decision: Decision, cancelled_now: bool) -> Option<(&'static str, bool, bool)> {
    match decision {
        // A Stop that arrived during the gate (or a prior tool in this batch) must
        // not let this tool execute — and it cancels the rest of the batch.
        Decision::Allow if cancelled_now => Some((CANCELLED_TOOL_RESULT, true, true)),
        Decision::Allow => None,
        Decision::Deny => Some(("Denied: the user did not approve this action.", true, false)),
    }
}

/// Gate (if mutating) and run ONE tool call, returning `(output, is_error)`. Sets
/// `*cancelled` if a Stop landed during the gate or right before the tool ran.
///
/// The gate prompt is serialized through `ask_lock`: only one "ask" is outstanding
/// per run at a time, so subagents running in parallel queue their prompts rather
/// than overwriting each other in the single permission slot (the UI shows one at
/// a time). The lock is held only across the gate, never across a tool's work.
#[allow(clippy::too_many_arguments)]
async fn gate_and_run(
    app: &AppHandle,
    session_channel: &str,
    snapshot: &Settings,
    pending: &Pending,
    cancel: &Arc<AtomicBool>,
    ask_lock: &tokio::sync::Mutex<()>,
    tool: &dyn tools::Tool,
    ctx: &ToolCtx,
    name: &str,
    input: &Value,
    cancelled: &mut bool,
) -> (String, bool) {
    let decision = if tool.mutating() {
        // Compute the pre-apply diff (fs_write/fs_edit) so the prompt can show the
        // change BEFORE it's written.
        let diff = tool.preview(input, ctx).await;
        let _prompt = ask_lock.lock().await;
        permissions::gate(
            app,
            session_channel,
            snapshot.permission_mode,
            &snapshot.rules,
            &snapshot.default_policy,
            pending,
            cancel,
            name,
            &tool.summarize(input, ctx),
            input,
            diff,
        )
        .await
    } else {
        Decision::Allow
    };
    // Re-check cancel right before running: a Stop during the gate must not let this
    // tool execute. `precheck_outcome` resolves the terminal cases; `None` means run.
    match precheck_outcome(decision, cancel.load(Ordering::Relaxed)) {
        Some((output, is_error, sets_cancelled)) => {
            if sets_cancelled {
                *cancelled = true;
            }
            (output.to_string(), is_error)
        }
        None => match tool.run(input.clone(), ctx).await {
            Ok(out) => (out, false),
            Err(err) => (err, true),
        },
    }
}

/// Whether a subagent at `depth` may itself spawn children — i.e. is still under
/// the nesting cap. A subagent AT the cap is a leaf: it gets no spawner and no
/// `task` tool.
fn child_can_spawn(depth: usize) -> bool {
    depth < MAX_SUBAGENT_DEPTH
}

/// The string a subagent returns to its launcher: its final assistant text, or a
/// short note (naming the subagent by its `description`) when it produced none, so
/// the launcher always receives something legible rather than an empty tool result.
fn subagent_answer(description: &str, final_text: &str, stop_reason: &str) -> String {
    let trimmed = final_text.trim();
    if trimmed.is_empty() {
        format!(
            "(The subagent \"{description}\" finished without a text summary; \
             stop reason: {stop_reason}.)"
        )
    } else {
        trimmed.to_string()
    }
}

/// The `AgentFinished` status string for a subagent that ran to completion: a
/// cancelled run reports `"cancelled"`, anything else `"ok"`. (A subagent that
/// errored out — `run_loop_core` returned `Err` — reports `"error"`; see
/// [`spawn_status`].)
fn finish_status(stop_reason: &str) -> &'static str {
    if stop_reason == "cancelled" {
        "cancelled"
    } else {
        "ok"
    }
}

/// The terminal `AgentFinished` status for a finished spawn, error case included:
/// an `Err` from the loop reports `"error"`, otherwise the stop reason decides
/// ok/cancelled. Pulled out so the "ALWAYS announce a terminal status, even when
/// the run errored" contract is unit-testable without standing up a live run (the
/// emit + deregister that follow it are plain, inspection-verified control flow).
fn spawn_status(result: &Result<LoopOutcome, String>) -> &'static str {
    match result {
        Ok(outcome) => finish_status(&outcome.stop_reason),
        Err(_) => "error",
    }
}

/// The session id a channel belongs to: `agent://{session}` and a subagent's
/// `agent://{session}:{agentId}` both map to `{session}` (the colon-suffixed agent
/// id is not part of the session). Used to register a subagent under its session.
fn session_of(channel: &str) -> &str {
    channel
        .strip_prefix("agent://")
        .unwrap_or(channel)
        .split(':')
        .next()
        .unwrap_or(channel)
}

/// Launches subagents for the `task` tool. Holds owned clones of everything a
/// child run needs, so it can outlive the call that built it and spawn children on
/// demand. One per parent run; cloned (with `depth + 1`) onto each child it
/// launches, so nesting stays depth-bounded.
#[derive(Clone)]
struct AgentSpawner {
    app: AppHandle,
    http: reqwest::Client,
    settings: Arc<Mutex<Settings>>,
    pending: Pending,
    /// Live-subagent registry: each child registers its OWN cancel flag here so the
    /// agents panel can Stop one without the others, and a session-wide Stop can
    /// flip them all.
    agents: agents::Agents,
    /// The cancel flag of the agent that OWNS this spawner — the top-level run's
    /// flag for the root spawner, or a subagent's own flag for a child spawner.
    /// Only used to race-close: if the owner was cancelled between the parent's
    /// last check and the child's registration, the child starts already-cancelled.
    cancel: Arc<AtomicBool>,
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
    /// Per-run permission-prompt serializer, shared with the parent and all
    /// siblings, so parallel subagents queue their prompts instead of clobbering the
    /// single UI prompt slot.
    ask_lock: Arc<tokio::sync::Mutex<()>>,
    /// The parent's `agent://{session}` channel — where a subagent's permission
    /// prompts and lifecycle/usage events surface, and the base for the child's own
    /// stream channel.
    parent_channel: String,
    workspace: PathBuf,
    /// The id of the subagent that owns this spawner, or `None` for the top-level
    /// run. A launched child records this as its `parent_id` (for cancel cascade and
    /// the panel's structure).
    self_id: Option<String>,
    /// The depth the children THIS spawner launches run at (top-level run → 1).
    depth: usize,
}

#[async_trait::async_trait]
impl tools::Spawner for AgentSpawner {
    async fn spawn(&self, spec: tools::SubagentSpec) -> Result<String, String> {
        // Depth ceiling (a backstop to the registry omission): never launch a child
        // deeper than the cap, so a confused or injected agent can't fork forever.
        if self.depth > MAX_SUBAGENT_DEPTH {
            return Err(format!(
                "Subagent nesting limit reached (maximum depth {MAX_SUBAGENT_DEPTH})."
            ));
        }

        let snapshot = { self.settings.lock().unwrap().clone() };
        let cred = secrets::load_credential().ok_or(
            "No credentials set. Sign in with your Claude subscription or add an Anthropic API key in Settings.",
        )?;
        let provider = llm::provider_for(&snapshot.provider)?;

        let agent_id = Uuid::new_v4().to_string();
        let session_id = session_of(&self.parent_channel).to_string();
        // The child's own stream channel, distinct from the parent's so its deltas
        // never fold into the parent transcript. The agents panel tracks the child
        // via the lifecycle/progress events on the SESSION channel (below), not this
        // private channel, so it still has no desktop listener.
        let child_channel = format!("agent://{session_id}:{agent_id}");

        // Register the child's OWN cancel flag so a per-agent or session-wide Stop
        // can reach it. Race-close: if this spawner's owner was already cancelled
        // (a Stop that landed during the launch), start the child cancelled so it
        // stops on its first loop check rather than running a full turn.
        let child_cancel =
            agents::register(&self.agents, &agent_id, &session_id, self.self_id.clone());
        if self.cancel.load(Ordering::Relaxed) {
            child_cancel.store(true, Ordering::Relaxed);
        }
        emit(
            &self.app,
            &self.parent_channel,
            StreamEvent::AgentStarted {
                agent_id: agent_id.clone(),
                description: spec.description.clone(),
                parent_id: self.self_id.clone(),
            },
        );

        // A child may spawn its own children only while still under the cap; at the
        // last allowed depth it gets no spawner and no `task` tool (a leaf).
        let can_spawn = child_can_spawn(self.depth);
        let registry = tools::subagent_registry(can_spawn);
        let child_spawner: Option<Arc<dyn tools::Spawner>> = if can_spawn {
            Some(Arc::new(AgentSpawner {
                cancel: child_cancel.clone(),
                self_id: Some(agent_id.clone()),
                depth: self.depth + 1,
                ..self.clone()
            }))
        } else {
            None
        };
        let ctx = ToolCtx {
            workspace: self.workspace.clone(),
            spawner: child_spawner,
            // Subagents run `shell` in the foreground (no background runner) in this
            // version, so a subagent can't spawn its own background tasks yet.
            background: None,
        };

        // The subagent runs the default workspace prompt plus the "you are a
        // subagent" steer, with the task as its first (and only seeded) user turn.
        let system = resolve_system_prompt(None, Some(SUBAGENT_STEER.to_string()), &self.workspace);
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: vec![Block::Text {
                text: spec.prompt.clone(),
            }],
        }];

        let result = run_loop_core(
            &self.app,
            &self.http,
            provider.as_ref(),
            &snapshot,
            cred,
            &self.refresh_lock,
            &self.ask_lock,
            &self.pending,
            &child_cancel,
            &child_channel,       // agent_channel: the subagent's private output
            &self.parent_channel, // session_channel: prompts + usage + lifecycle
            Some(&agent_id),
            &registry,
            &system,
            &ctx,
            messages,
            &Persist::Ephemeral,
        )
        .await;

        // ALWAYS announce completion and deregister, on success OR error, so the
        // panel never shows a ghost agent and the registry never leaks a flag.
        let status = spawn_status(&result);
        emit(
            &self.app,
            &self.parent_channel,
            StreamEvent::AgentFinished {
                agent_id: agent_id.clone(),
                status: status.to_string(),
            },
        );
        agents::finish(&self.agents, &agent_id);

        // The subagent's final assistant text IS its answer to the launching agent.
        let outcome = result?;
        Ok(subagent_answer(
            &spec.description,
            &outcome.final_text,
            &outcome.stop_reason,
        ))
    }
}

/// Launches and tracks background `shell` tasks for the `shell` tool's background
/// mode. Owns the process lifecycle: it announces the launch, waits for the child
/// off-thread, reports completion on the session channel, and registers the
/// waiter's abort handle so a session Stop can kill it.
#[derive(Clone)]
struct BackgroundLauncher {
    app: AppHandle,
    background: background::Background,
    /// The session's `agent://{session}` channel — where start/finish events go.
    /// (Lifecycle events ride the session channel because a finish can land after
    /// the launching turn ended.)
    session_channel: String,
    session_id: String,
}

/// Spawn a background task's off-thread waiter and register it (so a session-wide
/// Stop can abort it) such that the registry entry is inserted BEFORE the waiter's
/// `body` is allowed to run. Without this ordering a body that finishes instantly
/// (a fast command) could call `background::finish` — a map remove — before the
/// matching `background::register` insert lands, leaving a stale entry that nothing
/// ever removes (the waiter has already exited). `body` performs the work — wait
/// for the child, report completion — and MUST end by calling
/// `background::finish(bg, id)`.
fn spawn_background_task<F>(
    bg: &background::Background,
    id: &str,
    session_id: &str,
    command: &str,
    body: F,
) where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    // A one-shot gate: the waiter blocks at `notified()` until we release it AFTER
    // registering. `notify_one()` stores a permit even when it runs before the
    // waiter reaches `notified()`, so the gate is race-free regardless of which
    // side (caller vs. spawned waiter) gets there first.
    let registered = Arc::new(tokio::sync::Notify::new());
    let gate = registered.clone();
    let handle = tokio::spawn(async move {
        gate.notified().await;
        body.await;
    });
    background::register(bg, id, session_id, command, handle.abort_handle());
    registered.notify_one();
}

impl tools::BackgroundRunner for BackgroundLauncher {
    fn launch(&self, command: String, child: tokio::process::Child) -> String {
        let id = Uuid::new_v4().to_string();
        // Announce the launch right away so the UI can show it as running.
        emit(
            &self.app,
            &self.session_channel,
            StreamEvent::BackgroundTaskStarted {
                id: id.clone(),
                command: command.clone(),
            },
        );

        let app = self.app.clone();
        let bg = self.background.clone();
        let channel = self.session_channel.clone();
        let task_id = id.clone();
        let task_command = command.clone();
        // The waiter owns the child (kill_on_drop), so aborting this task kills the
        // process — which is exactly what `background::cancel_session` does on Stop.
        // `spawn_background_task` registers the entry BEFORE this body can run, so a
        // command that finishes instantly can't remove its entry before the matching
        // insert lands (which would otherwise leak a stale registry entry).
        spawn_background_task(
            &self.background,
            &id,
            &self.session_id,
            &command,
            async move {
                let (exit_code, output) = match child.wait_with_output().await {
                    Ok(out) => (
                        out.status.code().unwrap_or(-1),
                        tools::format_shell_output(&out),
                    ),
                    Err(e) => (-1, format!("background command failed: {e}")),
                };
                emit(
                    &app,
                    &channel,
                    StreamEvent::BackgroundTaskFinished {
                        id: task_id.clone(),
                        command: task_command,
                        exit_code,
                        output,
                    },
                );
                background::finish(&bg, &task_id);
            },
        );
        id
    }
}

#[cfg(test)]
mod tests {
    use super::{
        assistant_text, background, batch_cancelled, child_can_spawn, derive_title, finish_status,
        is_terminal_auth_error, precheck_outcome, reassemble_results, resolve_system_prompt,
        session_of, spawn_background_task, spawn_status, step_limit_exceeded, subagent_answer,
        tool_result_block, tool_result_event, AgentConfig, Block, ChatMessage, Db, Decision,
        LoopOutcome, Persist, StreamEvent, CANCELLED_TOOL_RESULT, MAX_AGENT_STEPS,
        MAX_PARALLEL_AGENTS, MAX_SUBAGENT_DEPTH, SUBAGENT_STEER,
    };
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn spec_names(cfg: &AgentConfig) -> Vec<String> {
        cfg.registry
            .specs()
            .iter()
            .map(|s| s["name"].as_str().unwrap().to_string())
            .collect()
    }

    fn text_block(t: &str) -> Block {
        Block::Text { text: t.into() }
    }

    // The background-task waiter is gated so its `finish` (a map remove) can never
    // outrun the matching `register` (the insert). Drive `spawn_background_task` with
    // a body that finishes INSTANTLY — the fast-command case that, before the gate,
    // could remove its entry before registration and leak a stale one. The body
    // records whether its entry was already present when it ran, then removes it.
    // On a multi-thread runtime the waiter runs on another worker, so without the
    // gate the body would observe `false` and leave a leaked entry behind; the gate
    // makes both observations deterministic.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawn_background_task_registers_before_the_body_runs_and_cleans_up() {
        let bg = background::new();
        let seen_registered = Arc::new(AtomicBool::new(false));
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();

        let bg_body = bg.clone();
        let seen_body = seen_registered.clone();
        let id = "task-1".to_string();
        let id_body = id.clone();
        spawn_background_task(&bg, &id, "sess-1", "echo hi", async move {
            // The gate guarantees the entry is registered before we get here — even
            // though this body does no real awaiting before finishing.
            seen_body.store(
                bg_body.lock().unwrap().contains_key(&id_body),
                Ordering::SeqCst,
            );
            background::finish(&bg_body, &id_body);
            let _ = tx.send(());
        });

        rx.await.unwrap();
        assert!(
            seen_registered.load(Ordering::SeqCst),
            "the entry must be registered before the waiter body runs"
        );
        assert!(
            bg.lock().unwrap().is_empty(),
            "no stale entry may leak after the body finishes"
        );
    }

    #[test]
    fn assistant_text_concatenates_text_and_ignores_tool_blocks() {
        // The subagent's answer is its text only; tool-use blocks (and their ids)
        // never bleed into the returned summary.
        let content = vec![
            text_block("First. "),
            Block::ToolUse {
                id: "t1".into(),
                name: "fs_read".into(),
                input: serde_json::json!({ "path": "x" }),
            },
            text_block("Second."),
        ];
        assert_eq!(assistant_text(&content), "First. Second.");
        // A turn with no text (pure tool-use) yields the empty string, which the
        // caller treats as "no answer yet".
        assert_eq!(
            assistant_text(&[Block::ToolUse {
                id: "t".into(),
                name: "shell".into(),
                input: serde_json::json!({}),
            }]),
            ""
        );
        assert_eq!(assistant_text(&[]), "");
    }

    #[test]
    fn child_can_spawn_is_true_below_the_cap_and_false_at_or_above_it() {
        // A subagent under the nesting cap may fan out; one AT the cap is a leaf.
        assert!(child_can_spawn(1));
        assert!(child_can_spawn(MAX_SUBAGENT_DEPTH - 1));
        assert!(!child_can_spawn(MAX_SUBAGENT_DEPTH));
        assert!(!child_can_spawn(MAX_SUBAGENT_DEPTH + 1));
    }

    #[test]
    fn subagent_answer_returns_trimmed_text_or_a_note_when_empty() {
        assert_eq!(subagent_answer("audit", "  done.\n", "end_turn"), "done.");
        // No text → a legible note naming the subagent and carrying the stop reason,
        // never an empty result.
        let note = subagent_answer("audit deps", "   ", "cancelled");
        assert!(note.contains("without a text summary"));
        assert!(note.contains("audit deps"));
        assert!(note.contains("cancelled"));
    }

    #[test]
    fn finish_status_maps_cancelled_vs_done() {
        // A subagent that ran to completion reports "ok"; a Stop reports "cancelled".
        // (The error case — run_loop_core returned Err — is set at the call site.)
        assert_eq!(finish_status("end_turn"), "ok");
        assert_eq!(finish_status("max_tokens"), "ok");
        assert_eq!(finish_status("cancelled"), "cancelled");
    }

    #[test]
    fn spawn_status_reports_a_terminal_state_for_every_outcome_including_error() {
        // The panel's AgentFinished is emitted for ALL three exits — a clean finish,
        // a Stop, and a hard error (the loop returned Err) — so a subagent never
        // hangs in the panel as "running" and the registry never leaks its flag.
        let ok = Ok(LoopOutcome {
            stop_reason: "end_turn".into(),
            final_text: "done".into(),
        });
        let cancelled = Ok(LoopOutcome {
            stop_reason: "cancelled".into(),
            final_text: String::new(),
        });
        let errored: Result<LoopOutcome, String> = Err("boom".into());
        assert_eq!(spawn_status(&ok), "ok");
        assert_eq!(spawn_status(&cancelled), "cancelled");
        assert_eq!(spawn_status(&errored), "error");
    }

    #[test]
    fn tool_result_helpers_build_the_event_and_block() {
        // The streamed event and the persisted block carry the same id/output/error
        // for one finished tool call; both the sequential and parallel paths use them.
        match tool_result_event("t1", "out", true) {
            StreamEvent::ToolResult {
                id,
                output,
                is_error,
            } => assert_eq!(
                (id.as_str(), output.as_str(), is_error),
                ("t1", "out", true)
            ),
            other => panic!("expected a ToolResult event, got {other:?}"),
        }
        match tool_result_block("t1", "out".into(), false) {
            Block::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => assert_eq!(
                (tool_use_id.as_str(), content.as_str(), is_error),
                ("t1", "out", false)
            ),
            other => panic!("expected a ToolResult block, got {other:?}"),
        }
    }

    #[test]
    fn reassemble_results_orders_by_tool_use_index_under_scrambled_completion() {
        // The production reassembly: subagents finish out of order, but each result
        // is placed by the index its future returned, and paired to the id at THAT
        // index — so the persisted batch is in tool_use order with correct id pairing
        // (Anthropic pairs tool_result to tool_use; order is the safe default).
        let ids = ["a", "b", "c"];
        // Completions arrive scrambled: c, then a, then b; with mixed is_error.
        let done = vec![
            (2usize, "C".to_string(), false),
            (0, "A".to_string(), true),
            (1, "B".to_string(), false),
        ];
        let results = reassemble_results(&ids, done);
        let got: Vec<(&str, &str, bool)> = results
            .iter()
            .map(|b| match b {
                Block::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => (tool_use_id.as_str(), content.as_str(), *is_error),
                _ => ("?", "?", false),
            })
            .collect::<Vec<_>>();
        // In tool_use order; each result carries the id at its ORIGINAL index, not its
        // completion position; is_error is preserved per result.
        assert_eq!(
            got,
            [("a", "A", true), ("b", "B", false), ("c", "C", false)]
        );
    }

    #[test]
    fn precheck_outcome_runs_on_allow_denies_on_deny_and_cancels_on_a_late_stop() {
        // Allowed and no Stop landed → run the tool.
        assert_eq!(precheck_outcome(Decision::Allow, false), None);
        // Allowed, but a Stop arrived during the gate → don't run; cancel the batch.
        assert_eq!(
            precheck_outcome(Decision::Allow, true),
            Some((CANCELLED_TOOL_RESULT, true, true))
        );
        // Denied → a terminal error result that does NOT cancel the rest of the
        // batch, whether or not a Stop also landed.
        for stop in [false, true] {
            let (output, is_error, sets_cancelled) =
                precheck_outcome(Decision::Deny, stop).expect("deny is terminal");
            assert!(output.contains("Denied"));
            assert!(is_error);
            assert!(!sets_cancelled);
        }
    }

    #[test]
    fn parallel_agent_cap_is_a_sane_concurrency_bound() {
        // At least 2 (so a batch of `task` calls actually overlaps) and bounded (so a
        // wide fan-out can't open unlimited simultaneous model streams).
        assert!((2..=16).contains(&MAX_PARALLEL_AGENTS));
    }

    #[test]
    fn session_of_recovers_the_session_from_a_channel() {
        // The top-level channel is the session id verbatim; a subagent's
        // colon-suffixed channel still resolves to the same session.
        assert_eq!(session_of("agent://sess-1"), "sess-1");
        assert_eq!(session_of("agent://sess-1:agent-abc"), "sess-1");
        // Defensive: a bare/unexpected channel passes through rather than panicking.
        assert_eq!(session_of("sess-1"), "sess-1");
    }

    #[test]
    fn subagent_steer_marks_the_run_as_a_subagent() {
        // The steer must tell the model its final message is the entire return value
        // (so it writes a self-contained summary rather than chatting).
        assert!(SUBAGENT_STEER.contains("SUBAGENT"));
        assert!(SUBAGENT_STEER.contains("return value"));
    }

    #[test]
    fn persist_ephemeral_appends_nothing_and_touch_is_a_noop() {
        // A subagent keeps its transcript only in memory: append/touch must succeed
        // without any backing store (there is none) and never error.
        let p = Persist::Ephemeral;
        assert!(p
            .append(
                &ChatMessage {
                    role: "assistant".into(),
                    content: vec![text_block("hi")]
                },
                "the reply"
            )
            .is_ok());
        p.touch(); // must not panic
    }

    #[test]
    fn persist_session_writes_through_to_the_database() {
        // The interactive run persists every message; Persist::Session delegates to
        // the DB so a later reload sees exactly what the loop produced.
        let db = Db::open(Path::new(":memory:")).expect("in-memory db");
        db.create_session("s1", "T", None, 1).unwrap();
        let p = Persist::Session {
            db: &db,
            session_id: "s1",
        };
        p.append(
            &ChatMessage {
                role: "assistant".into(),
                content: vec![text_block("hello from the loop")],
            },
            "the reply",
        )
        .unwrap();
        p.touch();
        let loaded = db.load_chat_messages("s1");
        assert_eq!(loaded.len(), 1);
        assert_eq!(assistant_text(&loaded[0].content), "hello from the loop");
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
            ["fs_read", "list", "glob", "grep", "fs_write", "fs_edit", "shell", "task"]
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
