//! The agent loop: stream a turn, run any requested tools (mutating tools pass
//! through the permission gate), repeat until the model finishes. Conversation
//! state is persisted to SQLite so threads survive restarts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures_util::stream::StreamExt;
use portcode_sync::wire::TurnStatus;
use serde_json::Value;
use uuid::Uuid;

use crate::agents;
use crate::background;
use crate::db::{self, Db};
use crate::events::EventSink;
use crate::llm::{self, Block, ChatMessage, StreamEvent};
use crate::oauth;
use crate::openai_accounts::{
    AccountProfileId, OpenAiAccountError, OpenAiAccountRegistry, ProfileRunLease,
};
use crate::permissions::{self, Decision, Pending};
use crate::secrets::{self, Credential};
use crate::settings::Settings;
use crate::tool_names;
use crate::tools::{self, ToolCtx};

type Cancels = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

fn openai_account_error(error: OpenAiAccountError) -> String {
    error.user_message().to_string()
}

/// A synchronous same-session reservation acquired before an async turn is
/// spawned. Its cancel flag remains registered through terminal persistence and
/// emission. Drop removes only this exact flag, preventing an old task from
/// clearing a newer reservation for the same session.
pub struct RunReservation {
    cancels: Cancels,
    session_id: String,
    cancel: Arc<AtomicBool>,
}

impl RunReservation {
    pub fn try_acquire(cancels: Cancels, session_id: &str) -> Result<Self, String> {
        use std::collections::hash_map::Entry;
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut map = cancels.lock().unwrap();
            match map.entry(session_id.to_string()) {
                Entry::Occupied(_) => {
                    return Err("A turn is already running for this session.".into())
                }
                Entry::Vacant(slot) => {
                    slot.insert(cancel.clone());
                }
            }
        }
        Ok(Self {
            cancels,
            session_id: session_id.to_string(),
            cancel,
        })
    }

    fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }
}

impl Drop for RunReservation {
    fn drop(&mut self) {
        let mut map = self.cancels.lock().unwrap();
        if map
            .get(&self.session_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.cancel))
        {
            map.remove(&self.session_id);
        }
    }
}

/// Account-bound authentication captured once when a session run is admitted.
///
/// The local profile id and lifecycle lease never change for the duration of a
/// root run. Subagents clone this context instead of consulting global secrets,
/// so retries, nested agents, and concurrent sessions cannot drift onto another
/// ChatGPT account. Access tokens may rotate, but every rotation is resolved
/// through this exact profile and protected by its credential generation.
#[derive(Clone)]
struct OpenAiRunAuth {
    registry: Arc<OpenAiAccountRegistry>,
    profile_id: AccountProfileId,
    _lease: Arc<ProfileRunLease>,
}

/// Per-run seam for rotating one ChatGPT credential. Production delegates to
/// the reviewed OAuth transport; deterministic integration tests inject a
/// recorder without changing global endpoints or bypassing registry CAS.
#[async_trait::async_trait]
trait OpenAiRefreshTransport: Send + Sync {
    async fn refresh(
        &self,
        http: &reqwest::Client,
        current: &crate::secrets::OpenAiOAuthTokens,
    ) -> Result<crate::secrets::OpenAiOAuthTokens, String>;
}

#[derive(Clone, Copy, Default)]
struct ProductionOpenAiRefreshTransport;

#[async_trait::async_trait]
impl OpenAiRefreshTransport for ProductionOpenAiRefreshTransport {
    async fn refresh(
        &self,
        http: &reqwest::Client,
        current: &crate::secrets::OpenAiOAuthTokens,
    ) -> Result<crate::secrets::OpenAiOAuthTokens, String> {
        crate::openai_oauth::refresh(http, current).await
    }
}

#[derive(Clone)]
pub(crate) struct RunAuthContext {
    model: String,
    credential: Credential,
    openai: Option<OpenAiRunAuth>,
}

impl RunAuthContext {
    fn account_profile_id(&self) -> Option<&str> {
        self.openai.as_ref().map(|auth| auth.profile_id.as_str())
    }

    fn record_last_used_best_effort(&self) {
        if let Some(auth) = &self.openai {
            if auth
                .registry
                .record_last_used(&auth.profile_id, oauth::now_secs())
                .is_err()
            {
                // Attribution is a convenience field. Never fail a credential-
                // resolved run or print a storage error that could contain secret
                // backend details merely because the MRU timestamp could not save.
                eprintln!("openai-accounts: failed to record profile usage");
            }
        }
    }
}

/// A reservation and its immutable session-owned execution identity. Keeping
/// these values together makes it impossible for a caller to reserve one session
/// and then inject a frontend-selected model or credential into that run.
pub(crate) struct RunAdmission {
    reservation: RunReservation,
    auth: RunAuthContext,
}

impl RunAdmission {
    pub(crate) fn is_openai(&self) -> bool {
        self.auth.openai.is_some()
    }
}

/// Resolve the model and account from one authoritative DB read, acquire the
/// profile lifecycle lease, and snapshot the matching credential before any turn
/// task is spawned. Legacy OpenAI sessions must be explicitly pinned first.
pub(crate) fn admit_run(
    cancels: Cancels,
    db: &Db,
    settings: &Settings,
    openai_accounts: Arc<OpenAiAccountRegistry>,
    session_id: &str,
) -> Result<RunAdmission, String> {
    let reservation = RunReservation::try_acquire(cancels, session_id)?;
    let session = db
        .session_run_config(session_id)
        .map_err(|error| format!("Session is unavailable: {error}"))?;
    let model = session
        .model
        .filter(|model| !model.trim().is_empty())
        .unwrap_or_else(|| settings.model.clone());
    let provider_name = llm::provider_name_for_model(&model)?;

    let (credential, openai) = match provider_name {
        "openai" => {
            crate::openai_oauth::ensure_direct_subscription_enabled()?;
            let raw_profile_id = session.account_profile_id.ok_or_else(|| {
                "This legacy OpenAI session is not pinned to a ChatGPT account. Choose an account before sending."
                    .to_string()
            })?;
            let profile_id =
                AccountProfileId::parse(&raw_profile_id).map_err(openai_account_error)?;
            // Acquire before reading the credential. Removal cannot pass this
            // lease boundary, so the snapshot remains usable through the final
            // durable receipt (the lease is held inside the auth context).
            let lease = openai_accounts
                .acquire_run_lease(&profile_id)
                .map_err(openai_account_error)?;
            let profile = openai_accounts
                .load_profile(&profile_id)
                .map_err(openai_account_error)?;
            (
                Credential::OpenAiOAuth(profile.tokens),
                Some(OpenAiRunAuth {
                    registry: openai_accounts,
                    profile_id,
                    _lease: Arc::new(lease),
                }),
            )
        }
        "anthropic" => {
            if session.account_profile_id.is_some() {
                return Err(
                    "This session is pinned to a ChatGPT account and cannot run an Anthropic model. Create a new session instead."
                        .into(),
                );
            }
            let credential = secrets::load_credential_for(provider_name).ok_or_else(|| {
                "No Anthropic credentials set. Sign in with your Claude subscription or add an Anthropic API key in Settings."
                    .to_string()
            })?;
            (credential, None)
        }
        _ => unreachable!("provider_name_for_model returns only supported providers"),
    };

    Ok(RunAdmission {
        reservation,
        auth: RunAuthContext {
            model,
            credential,
            openai,
        },
    })
}

/// Refresh an OAuth access token once it is within this many seconds of expiry.
const REFRESH_SKEW_SECS: i64 = 60;

/// Hard ceiling on model turns (and therefore tool batches) in a single run. A
/// confused model or an indirect prompt injection can otherwise loop forever,
/// burning tokens and mutating the workspace unbounded. When exceeded, the run
/// stops with a clear error instead of looping.
const MAX_AGENT_STEPS: usize = 50;

/// Maximum subagent nesting depth. The user-facing run is depth 0; a subagent it
/// launches is depth 1, and so on. A confused or injected agent that keeps calling
/// `delegate_task` could otherwise fan out without bound, so a subagent at this
/// depth is handed no delegation tool (and the spawner refuses as a backstop).
const MAX_SUBAGENT_DEPTH: usize = 3;

/// How many subagents from ONE tool-use batch run concurrently. The model can
/// emit several `delegate_task` calls in a turn; they run in parallel up to this cap (the
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
Shell: the `run_command` tool runs PowerShell (Windows PowerShell 5.1) by default, so write commands \
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
/// registry so the model both *can't* mutate (no write/edit/command tools) and
/// *knows* it shouldn't — it should design and explain instead.
const PLAN_MODE_STEER: &str = "You are in PLAN MODE. Do NOT modify anything in this turn: \
the file-writing, editing, and command-execution tools are intentionally unavailable. Investigate with the \
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

    /// Plan mode: a READ-ONLY tool registry (no write/edit/command) plus the
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

fn ensure_openai_account_unchanged(
    original_account_id: Option<&str>,
    current_account_id: Option<&str>,
) -> Result<(), String> {
    if original_account_id.is_none() || original_account_id != current_account_id {
        return Err(
            "The signed-in ChatGPT account changed during this turn. Start the turn again.".into(),
        );
    }
    Ok(())
}

/// Return the credential to authenticate the next request with, refreshing an
/// OAuth token that is at/near expiry. Refreshes are single-flight: the shared
/// `refresh_lock` serializes concurrent turns, and the stored token is re-read
/// under the lock so a token another turn just refreshed is reused rather than
/// refreshed again.
pub(crate) async fn ensure_fresh(
    http: &reqwest::Client,
    cred: Credential,
    refresh_lock: &tokio::sync::Mutex<()>,
) -> Result<Credential, String> {
    let tokens =
        match cred {
            Credential::OAuth(t) => t,
            Credential::OpenAiOAuth(_) => return Err(
                "ChatGPT credentials require an account-bound run context. Start the turn again."
                    .into(),
            ),
            Credential::ApiKey(key) => return Ok(Credential::ApiKey(key)),
        };

    if tokens.expires_at - oauth::now_secs() > REFRESH_SKEW_SECS {
        return Ok(Credential::OAuth(tokens));
    }

    let _guard = refresh_lock.lock().await;
    // Re-check under the lock: another turn may have refreshed already. Prefer
    // the freshest stored token over the one we came in with.
    // Requiring the stored credential prevents a refresh that was queued before
    // logout from recreating the cleared Claude session.
    let current = secrets::get_oauth()
        .ok_or("Your Claude subscription session was removed. Sign in again.")?;
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

fn refreshed_or_latest_profile(
    auth: &OpenAiRunAuth,
    expected_generation: u64,
    refreshed: crate::secrets::OpenAiOAuthTokens,
) -> Result<Credential, String> {
    match auth.registry.store_refreshed_profile(
        &auth.profile_id,
        expected_generation,
        refreshed,
        oauth::now_secs(),
    ) {
        Ok(profile) => Ok(Credential::OpenAiOAuth(profile.tokens)),
        Err(OpenAiAccountError::CredentialConflict) => auth
            .registry
            .load_profile(&auth.profile_id)
            .map(|profile| Credential::OpenAiOAuth(profile.tokens))
            .map_err(openai_account_error),
        Err(error) => Err(openai_account_error(error)),
    }
}

fn quarantine_or_use_newer_profile(
    auth: &OpenAiRunAuth,
    expected_generation: u64,
) -> Result<Credential, String> {
    match auth.registry.mark_reconnect_required(
        &auth.profile_id,
        expected_generation,
        oauth::now_secs(),
    ) {
        Ok(()) => {
            Err("This ChatGPT account session expired. Reconnect that account in Settings.".into())
        }
        Err(OpenAiAccountError::CredentialConflict) => auth
            .registry
            .load_profile(&auth.profile_id)
            .map(|profile| Credential::OpenAiOAuth(profile.tokens))
            .map_err(openai_account_error),
        Err(error) => Err(openai_account_error(error)),
    }
}

/// Refresh one exact ChatGPT profile. The per-profile lock gives concurrent runs
/// single-flight refresh, while the credential-generation CAS prevents an older
/// network response (success or terminal failure) from overwriting a reconnect.
async fn ensure_fresh_openai(
    http: &reqwest::Client,
    cred: Credential,
    auth: &OpenAiRunAuth,
    refresh_transport: &dyn OpenAiRefreshTransport,
) -> Result<Credential, String> {
    crate::openai_oauth::ensure_direct_subscription_enabled()?;
    let Credential::OpenAiOAuth(tokens) = cred else {
        return Err("ChatGPT refresh received the wrong credential type.".into());
    };
    if tokens.expires_at - oauth::now_secs() > REFRESH_SKEW_SECS {
        return Ok(Credential::OpenAiOAuth(tokens));
    }

    let _guard = auth
        .registry
        .lock_refresh(&auth.profile_id)
        .await
        .map_err(openai_account_error)?;
    let current = auth
        .registry
        .load_profile(&auth.profile_id)
        .map_err(openai_account_error)?;
    ensure_openai_account_unchanged(
        tokens.account_id.as_deref(),
        current.tokens.account_id.as_deref(),
    )?;
    if current.tokens.expires_at - oauth::now_secs() > REFRESH_SKEW_SECS {
        return Ok(Credential::OpenAiOAuth(current.tokens));
    }

    match refresh_transport.refresh(http, &current.tokens).await {
        Ok(refreshed) => {
            refreshed_or_latest_profile(auth, current.credential_generation, refreshed)
        }
        Err(error) if crate::openai_oauth::refresh_failure_requires_reconnect(&error) => {
            quarantine_or_use_newer_profile(auth, current.credential_generation)
        }
        Err(error) => Err(error),
    }
}

async fn ensure_fresh_for_run(
    http: &reqwest::Client,
    cred: Credential,
    refresh_lock: &tokio::sync::Mutex<()>,
    auth: &RunAuthContext,
    openai_refresh: &dyn OpenAiRefreshTransport,
) -> Result<Credential, String> {
    match &auth.openai {
        Some(openai) => ensure_fresh_openai(http, cred, openai, openai_refresh).await,
        None => ensure_fresh(http, cred, refresh_lock).await,
    }
}

/// Recover one OpenAI 401 without retry loops. This runs before any tool result
/// can be executed: the provider reports the HTTP status before consuming SSE.
async fn recover_openai_unauthorized(
    http: &reqwest::Client,
    failed_credential: &Credential,
    auth: &OpenAiRunAuth,
    refresh_transport: &dyn OpenAiRefreshTransport,
) -> Result<Credential, String> {
    crate::openai_oauth::ensure_direct_subscription_enabled()?;
    let Credential::OpenAiOAuth(failed) = failed_credential else {
        return Err("OpenAI authentication recovery received the wrong credential type.".into());
    };
    let _guard = auth
        .registry
        .lock_refresh(&auth.profile_id)
        .await
        .map_err(openai_account_error)?;
    let current = auth
        .registry
        .load_profile(&auth.profile_id)
        .map_err(openai_account_error)?;
    ensure_openai_account_unchanged(
        failed.account_id.as_deref(),
        current.tokens.account_id.as_deref(),
    )?;
    // Another turn may already have recovered and persisted a rotated token.
    if current.tokens.access_token != failed.access_token {
        return Ok(Credential::OpenAiOAuth(current.tokens));
    }
    match refresh_transport.refresh(http, &current.tokens).await {
        Ok(refreshed) => {
            refreshed_or_latest_profile(auth, current.credential_generation, refreshed)
        }
        Err(error) if crate::openai_oauth::refresh_failure_requires_reconnect(&error) => {
            quarantine_or_use_newer_profile(auth, current.credential_generation)
        }
        Err(error) => Err(error),
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn run(
    sink: Arc<dyn EventSink>,
    http: reqwest::Client,
    settings: Arc<Mutex<Settings>>,
    db: Arc<Db>,
    admission: RunAdmission,
    pending: Pending,
    agents: agents::Agents,
    background: background::Background,
    oauth_refresh: Arc<tokio::sync::Mutex<()>>,
    session_id: String,
    user_text: String,
) {
    let RunAdmission { reservation, auth } = admission;
    let channel = format!("agent://{session_id}");
    let cancel = reservation.cancel_flag();

    let turn_id = Uuid::new_v4().to_string();
    let started_at = db::now_ms();
    let started = Instant::now();
    let account_profile_id = auth.account_profile_id().map(str::to_owned);
    let initial_receipt = crate::turn_receipt::unavailable_interrupted_receipt_with_account(
        &turn_id,
        started_at,
        account_profile_id.clone(),
    );
    if let Err(error) = db.save_pending_turn_receipt(&session_id, &turn_id, &initial_receipt) {
        sink.emit(
            &channel,
            StreamEvent::Error {
                message: format!("Failed to start a durable turn: {error}"),
                receipt: None,
            },
        );
        return;
    }
    auth.record_last_used_best_effort();
    // The UI only learns about a turn after its interrupted fallback is durable.
    sink.emit(
        &channel,
        StreamEvent::TurnStart {
            message_id: turn_id.clone(),
            turn_id: Some(turn_id.clone()),
            started_at: Some(started_at),
        },
    );

    let workspace = settings
        .lock()
        .unwrap()
        .workspace
        .clone()
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_default();
    let receipt_tracker = crate::turn_receipt::TurnReceiptTracker::new_with_account(
        turn_id.clone(),
        started_at,
        started,
        workspace,
        account_profile_id,
    )
    .await;
    let placeholder = receipt_tracker.interrupted_placeholder();
    if let Err(error) = db.save_pending_turn_receipt(&session_id, &turn_id, &placeholder) {
        // The pre-capture unavailable row is already durable; retain it rather than
        // aborting an otherwise safe turn because the richer placeholder lost a race.
        eprintln!("turn-receipt: failed to update captured placeholder: {error}");
    }

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
        &sink,
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
        &turn_id,
        receipt_tracker.clone(),
        user_text,
        config,
        auth.clone(),
    )
    .await;

    let (status, stop_reason) = match &result {
        Ok(reason) if reason == "cancelled" => (TurnStatus::Cancelled, Some(reason.clone())),
        Ok(reason) => (TurnStatus::Completed, Some(reason.clone())),
        Err(_) => (TurnStatus::Error, None),
    };
    let completed = receipt_tracker.complete(status, stop_reason).await;
    if let Err(error) = db.save_turn_receipt(
        &session_id,
        &turn_id,
        &completed.receipt,
        completed.repository_root.as_deref(),
        completed.terminal_snapshot_id.as_deref(),
    ) {
        eprintln!("turn-receipt: failed to persist terminal receipt: {error}");
    }

    match result {
        Ok(stop_reason) => sink.emit(
            &channel,
            StreamEvent::TurnEnd {
                stop_reason,
                receipt: Some(completed.receipt),
            },
        ),
        Err(message) => sink.emit(
            &channel,
            StreamEvent::Error {
                message,
                receipt: Some(completed.receipt),
            },
        ),
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_inner(
    sink: &Arc<dyn EventSink>,
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
    turn_id: &str,
    receipt_tracker: Arc<crate::turn_receipt::TurnReceiptTracker>,
    user_text: String,
    config: AgentConfig,
    auth: RunAuthContext,
) -> Result<String, String> {
    let mut snapshot = { settings.lock().unwrap().clone() };
    snapshot.model = auth.model.clone();

    // Resolve only from the selected model so an unknown slug cannot inherit a
    // different configured provider and send a request to the wrong service.
    let provider_name = llm::provider_name_for_model(&snapshot.model)?;
    if provider_name == "openai" {
        // Fail before persisting the user's message when a release build or
        // runtime policy has disabled the direct subscription transport.
        crate::openai_oauth::ensure_direct_subscription_enabled()?;
    }
    let cred = auth.credential.clone();

    // Resolve the LLM provider up front, alongside the credential check above:
    // both are pre-flight config validations that fail before any DB write (so an
    // unconfigured run never half-persists). An unknown `provider` value fails
    // here with a clear message instead of silently calling a different service.
    let provider: Arc<dyn llm::LlmProvider> = Arc::from(llm::provider_for(provider_name)?);
    let openai_refresh: Arc<dyn OpenAiRefreshTransport> =
        Arc::new(ProductionOpenAiRefreshTransport);

    // No configured workspace falls back to the process working directory — but
    // never to an empty path (the old `unwrap_or_default()`), which would silently
    // root every file/command tool at "" and produce confusing errors.
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

    // Attach a subagent spawner only when this run exposes `delegate_task`.
    // Plan mode's read-only registry has no delegation tool, so it gets no spawner and
    // can never launch a (mutating) subagent — defense-in-depth with the gate,
    // which already denies mutating tools in plan mode.
    let spawner: Option<Arc<dyn tools::Spawner>> =
        if registry.find(tool_names::DELEGATE_TASK).is_some() {
            Some(Arc::new(AgentSpawner {
                sink: sink.clone(),
                http: http.clone(),
                provider: provider.clone(),
                openai_refresh: openai_refresh.clone(),
                // Freeze the resolved per-session model/provider/effort so children
                // inherit this run, not a possibly different global default.
                run_settings: snapshot.clone(),
                auth: auth.clone(),
                pending: pending.clone(),
                agents: agents.clone(),
                cancel: cancel.clone(),
                refresh_lock: refresh_lock.clone(),
                ask_lock: ask_lock.clone(),
                receipt_tracker: receipt_tracker.clone(),
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
    ctx.receipt = Some(receipt_tracker.clone());
    ctx.spawner = spawner;
    // Attach a background runner only when this run exposes `run_command` (plan mode's
    // read-only registry has none, so it can't background). Subagents don't get one
    // in this version, so their `run_command` calls run foreground.
    if registry.find(tool_names::RUN_COMMAND).is_some() {
        ctx.background = Some(Arc::new(BackgroundLauncher {
            sink: sink.clone(),
            background: background.clone(),
            session_channel: channel.to_string(),
            session_id: session_id.to_string(),
            receipt_tracker: receipt_tracker.clone(),
        }));
    }

    // Load prior turns from the DB, then persist the new user message.
    let mut messages = db.load_chat_messages(session_id);
    // Older rows store the original Portcode tool names. Normalize only this
    // in-memory provider transcript so every historical tool call matches the new
    // canonical specs; the DB and UI history remain byte-for-byte untouched.
    canonicalize_tool_history(&mut messages);
    let is_first = messages.is_empty();

    let user_msg = ChatMessage {
        role: "user".into(),
        content: vec![Block::Text {
            text: user_text.clone(),
        }],
    };
    db.try_append_message_for_turn(session_id, Some(turn_id), &user_msg, db::now_ms())
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
        sink.as_ref(),
        http,
        provider.as_ref(),
        &snapshot,
        cred,
        refresh_lock,
        openai_refresh.as_ref(),
        &auth,
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
        &Persist::Session {
            db,
            session_id,
            turn_id,
        },
    )
    .await?;
    Ok(outcome.stop_reason)
}

/// Where a run's transcript goes. The interactive run persists every message to
/// its SQLite session; a subagent is **ephemeral** — it keeps the transcript only
/// in memory, so it never pollutes the parent thread or the database.
enum Persist<'a> {
    Session {
        db: &'a Db,
        session_id: &'a str,
        turn_id: &'a str,
    },
    Ephemeral,
}

impl Persist<'_> {
    /// Append a freshly produced message to the durable store, if any. `what`
    /// names the message for the error path ("the reply" / "tool results").
    fn append(&self, msg: &ChatMessage, what: &str) -> Result<(), String> {
        match self {
            Persist::Session {
                db,
                session_id,
                turn_id,
            } => db
                .try_append_message_for_turn(session_id, Some(turn_id), msg, db::now_ms())
                .map(|_| ())
                .map_err(|e| format!("Failed to save {what}: {e}")),
            Persist::Ephemeral => Ok(()),
        }
    }

    /// Bump the session's last-activity timestamp (no-op for an ephemeral run).
    fn touch(&self) {
        if let Persist::Session { db, session_id, .. } = self {
            db.touch_session(session_id, db::now_ms());
        }
    }

    /// Persist this turn's token usage into the session's cumulative total. No-op for
    /// an ephemeral subagent run — its cost already rolls up to the parent session
    /// via the `Usage` event emitted on the session channel.
    fn add_usage(&self, input_tokens: u32, output_tokens: u32) {
        if let Persist::Session { db, session_id, .. } = self {
            // Best-effort: a failed usage write must not abort the turn — the live
            // in-memory counter already reflected this event.
            let _ = db.add_usage(
                session_id,
                i64::from(input_tokens),
                i64::from(output_tokens),
                db::now_ms(),
            );
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
    sink: &dyn EventSink,
    http: &reqwest::Client,
    provider: &dyn llm::LlmProvider,
    snapshot: &Settings,
    mut cred: Credential,
    refresh_lock: &tokio::sync::Mutex<()>,
    openai_refresh: &dyn OpenAiRefreshTransport,
    auth: &RunAuthContext,
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
        cred = ensure_fresh_for_run(http, cred, refresh_lock, auth, openai_refresh).await?;

        // Keep the kill switch adjacent to the actual Responses request as well
        // as in preflight/refresh, so a runtime disable takes effect between
        // agent steps without waiting for token expiry.
        if matches!(&cred, Credential::OpenAiOAuth(_)) {
            crate::openai_oauth::ensure_direct_subscription_enabled()?;
        }

        let first_attempt = provider
            .stream_turn(
                http,
                &cred,
                &snapshot.model,
                &snapshot.reasoning_effort,
                &snapshot.response_speed,
                system,
                &messages,
                &tool_specs,
                sink,
                agent_channel,
                cancel,
            )
            .await;
        let mut turn = match first_attempt {
            Err(error)
                if error == crate::llm::OPENAI_UNAUTHORIZED_ERROR
                    && matches!(&cred, Credential::OpenAiOAuth(_)) =>
            {
                let openai = auth.openai.as_ref().ok_or(
                    "OpenAI authentication recovery is missing its account-bound context.",
                )?;
                cred = recover_openai_unauthorized(http, &cred, openai, openai_refresh).await?;
                crate::openai_oauth::ensure_direct_subscription_enabled()?;
                // Exactly one retry. A second 401 is returned as-is and never
                // triggers another refresh/retry cycle.
                provider
                    .stream_turn(
                        http,
                        &cred,
                        &snapshot.model,
                        &snapshot.reasoning_effort,
                        &snapshot.response_speed,
                        system,
                        &messages,
                        &tool_specs,
                        sink,
                        agent_channel,
                        cancel,
                    )
                    .await?
            }
            Ok(turn) => turn,
            Err(error) => return Err(error),
        };
        // Providers currently canonicalize their streamed tool-use events too;
        // keep this provider-agnostic backstop so a future provider cannot write
        // a newly returned legacy alias into the DB or bypass canonical gating.
        canonicalize_tool_blocks(&mut turn.content);

        // Usage is a SESSION-level event: route it to `session_channel` so a
        // subagent's token cost rolls up into the parent session's total rather
        // than streaming to an unwatched child channel and being lost. For the
        // interactive run the two channels are identical, so this is unchanged.
        sink.emit(
            session_channel,
            StreamEvent::Usage {
                input_tokens: turn.input_tokens,
                output_tokens: turn.output_tokens,
            },
        );
        // Persist the cumulative token spend so the running total (and per-session
        // meter) survives a restart, via the Persist abstraction (Session writes;
        // an ephemeral subagent no-ops — its cost rolls up through the Usage event
        // on the session channel above).
        persist.add_usage(turn.input_tokens, turn.output_tokens);

        // Liveness for the agents panel: a subagent reports each completed turn on
        // the session channel (where the panel listens). `steps` is its 1-based turn
        // count. The interactive run (`agent_id == None`) has no panel row.
        if let Some(id) = agent_id {
            sink.emit(
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
            // the usual gate/cancel semantics; `delegate_task` calls are deferred
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
                    sink.emit(agent_channel, tool_result_event(id, &output, true));
                    done.push((i, output, true));
                    continue;
                }

                // Subagents run in parallel: defer the non-mutating delegation
                // call to the concurrent phase below. A final cancel re-check first,
                // mirroring the sequential path.
                if tool_names::canonical(name) == tool_names::DELEGATE_TASK {
                    if let Some(tool) = registry.find(tool_names::DELEGATE_TASK) {
                        if cancel.load(Ordering::Relaxed) {
                            cancelled = true;
                            let output = CANCELLED_TOOL_RESULT.to_string();
                            sink.emit(agent_channel, tool_result_event(id, &output, true));
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
                    // No delegation tool in this registry → fall through to "unknown tool".
                }

                let (output, is_error) = match registry.find(name) {
                    Some(tool) => {
                        gate_and_run(
                            sink,
                            session_channel,
                            snapshot,
                            pending,
                            cancel,
                            ask_lock,
                            tool,
                            ctx,
                            input,
                            &mut cancelled,
                        )
                        .await
                    }
                    None => (format!("Unknown tool: {name}"), true),
                };
                sink.emit(agent_channel, tool_result_event(id, &output, is_error));
                done.push((i, output, is_error));
            }

            // Drive the deferred subagents concurrently, capped at MAX_PARALLEL_AGENTS,
            // recording each result as it finishes. The streamed ToolResult events land
            // in completion order; the persisted batch is reassembled in tool_use order.
            if !task_futs.is_empty() {
                let mut stream =
                    futures_util::stream::iter(task_futs).buffer_unordered(MAX_PARALLEL_AGENTS);
                while let Some((i, output, is_error)) = stream.next().await {
                    sink.emit(
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

/// Normalize legacy tool-use names in a provider-bound transcript without
/// touching tool ids, inputs, results, or the persisted/UI copy in the database.
fn canonicalize_tool_history(messages: &mut [ChatMessage]) {
    for message in messages {
        canonicalize_tool_blocks(&mut message.content);
    }
}

fn canonicalize_tool_blocks(content: &mut [Block]) {
    for block in content {
        if let Block::ToolUse { name, .. } = block {
            let canonical = tool_names::canonical(name).to_string();
            if canonical != *name {
                *name = canonical;
            }
        }
    }
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

/// Gate (when explicitly classified as mutating/protected) and run ONE tool call,
/// returning `(output, is_error)`. Sets
/// `*cancelled` if a Stop landed during the gate or right before the tool ran.
///
/// The gate prompt is serialized through `ask_lock`: only one "ask" is outstanding
/// per run at a time, so subagents running in parallel queue their prompts rather
/// than overwriting each other in the single permission slot (the UI shows one at
/// a time). The lock is held only across the gate, never across a tool's work.
#[allow(clippy::too_many_arguments)]
async fn gate_and_run(
    sink: &dyn EventSink,
    session_channel: &str,
    snapshot: &Settings,
    pending: &Pending,
    cancel: &Arc<AtomicBool>,
    ask_lock: &tokio::sync::Mutex<()>,
    tool: &dyn tools::Tool,
    ctx: &ToolCtx,
    input: &Value,
    cancelled: &mut bool,
) -> (String, bool) {
    let decision = if let Some(risk) = tool.permission_risk() {
        // Compute the pre-apply diff (write_file/edit_file) so the prompt can show the
        // change BEFORE it's written.
        let diff = tool.preview(input, ctx).await;
        let _prompt = ask_lock.lock().await;
        permissions::gate(
            sink,
            session_channel,
            snapshot.permission_mode,
            &snapshot.rules,
            &snapshot.default_policy,
            pending,
            cancel,
            tool.name(),
            risk,
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
/// `delegate_task` tool.
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

/// Derive a meaningful label for a sub-agent from the tool input.
///
/// Priority:
/// 1. Use `description` as-is when it is non-empty, not the generic placeholder
///    `"subagent"` (case-insensitive), and at least 3 characters long.
/// 2. Otherwise derive a label from the first non-empty line of `prompt`: trim
///    it, collapse internal whitespace, strip a leading Markdown bullet or
///    heading marker, and truncate to ~60 characters on a word boundary
///    (appending `"…"` when truncated).
/// 3. If both are blank fall back to `"subagent"`.
fn subagent_label(description: &str, prompt: &str) -> String {
    let d = description.trim();
    if d.len() >= 3 && !d.eq_ignore_ascii_case("subagent") {
        return d.to_string();
    }

    // Derive from the first non-empty line of the prompt.
    let first = prompt
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if first.is_empty() {
        return "subagent".to_string();
    }

    // Strip a leading Markdown bullet or heading marker (e.g. "- ", "# ", "## ").
    let stripped = first.trim_start_matches(['#', '-', '*', '>']).trim_start();
    let text = if stripped.is_empty() { first } else { stripped };

    // Collapse internal whitespace into single spaces.
    let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");

    const MAX: usize = 60;
    if collapsed.len() <= MAX {
        return collapsed;
    }

    // Truncate on a word boundary (never slice through a multibyte character).
    // Walk char indices; keep the last boundary position that still fits in MAX.
    let mut boundary = 0usize;
    let mut prev_was_space = false;
    for (idx, ch) in collapsed.char_indices() {
        if idx > MAX {
            break;
        }
        if ch == ' ' {
            if !prev_was_space {
                boundary = idx;
            }
            prev_was_space = true;
        } else {
            prev_was_space = false;
        }
    }
    // If no word boundary found at all (one giant token), cut at the last safe
    // char boundary ≤ MAX.
    if boundary == 0 {
        boundary = collapsed
            .char_indices()
            .take_while(|&(i, c)| i + c.len_utf8() <= MAX)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(collapsed.len());
    }
    format!("{}…", collapsed[..boundary].trim_end())
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

/// Launches subagents for `delegate_task`. Holds owned clones of everything a
/// child run needs, so it can outlive the call that built it and spawn children on
/// demand. One per parent run; cloned (with `depth + 1`) onto each child it
/// launches, so nesting stays depth-bounded.
#[derive(Clone)]
struct AgentSpawner {
    sink: Arc<dyn EventSink>,
    http: reqwest::Client,
    /// One provider instance is selected by the root run and inherited by every
    /// child. Production gets the normal provider; tests can bind a local
    /// Responses endpoint without any process-global override.
    provider: Arc<dyn llm::LlmProvider>,
    openai_refresh: Arc<dyn OpenAiRefreshTransport>,
    run_settings: Settings,
    /// Immutable model/profile selection inherited from the owning root run.
    /// Children never reload a process-global OpenAI credential.
    auth: RunAuthContext,
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
    receipt_tracker: Arc<crate::turn_receipt::TurnReceiptTracker>,
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

        let snapshot = self.run_settings.clone();
        let provider_name = llm::provider_name_for_model(&snapshot.model)?;
        if provider_name == "openai" {
            crate::openai_oauth::ensure_direct_subscription_enabled()?;
        }
        let cred = self.auth.credential.clone();

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
        let label = subagent_label(&spec.description, &spec.prompt);
        self.sink.emit(
            &self.parent_channel,
            StreamEvent::AgentStarted {
                agent_id: agent_id.clone(),
                description: label,
                parent_id: self.self_id.clone(),
            },
        );

        // A child may spawn its own children only while still under the cap; at the
        // last allowed depth it gets no spawner and no `delegate_task` tool (a leaf).
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
            receipt: Some(self.receipt_tracker.clone()),
            spawner: child_spawner,
            // Subagents run `run_command` in the foreground (no background runner) in this
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
            self.sink.as_ref(),
            &self.http,
            self.provider.as_ref(),
            &snapshot,
            cred,
            &self.refresh_lock,
            self.openai_refresh.as_ref(),
            &self.auth,
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
        self.sink.emit(
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

/// Launches and tracks background `run_command` calls. Owns the process lifecycle:
/// it announces the launch, waits for the child
/// off-thread, reports completion on the session channel, and registers the
/// waiter's abort handle so a session Stop can kill it.
#[derive(Clone)]
struct BackgroundLauncher {
    sink: Arc<dyn EventSink>,
    background: background::Background,
    /// The session's `agent://{session}` channel — where start/finish events go.
    /// (Lifecycle events ride the session channel because a finish can land after
    /// the launching turn ended.)
    session_channel: String,
    session_id: String,
    receipt_tracker: Arc<crate::turn_receipt::TurnReceiptTracker>,
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
        self.receipt_tracker.background_started();
        // Announce the launch right away so the UI can show it as running.
        self.sink.emit(
            &self.session_channel,
            StreamEvent::BackgroundTaskStarted {
                id: id.clone(),
                command: command.clone(),
            },
        );

        let sink = self.sink.clone();
        let bg = self.background.clone();
        let channel = self.session_channel.clone();
        let task_id = id.clone();
        let task_command = command.clone();
        let receipt_tracker = self.receipt_tracker.clone();
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
                let (exit_code, output) = match tools::wait_with_bounded_output(child).await {
                    Ok(out) => (
                        out.status.code().unwrap_or(-1),
                        tools::format_bounded_shell_output(&out),
                    ),
                    Err(e) => (-1, format!("background command failed: {e}")),
                };
                sink.emit(
                    &channel,
                    StreamEvent::BackgroundTaskFinished {
                        id: task_id.clone(),
                        command: task_command,
                        exit_code,
                        output,
                    },
                );
                receipt_tracker.background_finished();
                background::finish(&bg, &task_id);
            },
        );
        id
    }
}

#[cfg(test)]
mod tests {
    use super::{
        admit_run, assistant_text, background, batch_cancelled, canonicalize_tool_history,
        child_can_spawn, derive_title, ensure_openai_account_unchanged, finish_status,
        is_terminal_auth_error, precheck_outcome, reassemble_results, resolve_system_prompt,
        run_loop_core, session_of, spawn_background_task, spawn_status, step_limit_exceeded,
        subagent_answer, subagent_label, tool_result_block, tool_result_event, AgentConfig,
        AgentSpawner, Block, Cancels, ChatMessage, Db, Decision, LoopOutcome,
        OpenAiRefreshTransport, OpenAiRunAuth, Persist, RunAuthContext, RunReservation,
        StreamEvent, CANCELLED_TOOL_RESULT, MAX_AGENT_STEPS, MAX_PARALLEL_AGENTS,
        MAX_SUBAGENT_DEPTH, SUBAGENT_STEER,
    };
    use crate::events::EventSink;
    use crate::llm::{LlmProvider, OpenAiProvider};
    use crate::openai_accounts::{
        AccountProfileId, OpenAiAccountError, OpenAiAccountRegistry, OpenAiAccountState,
    };
    use crate::secrets::{Credential, OpenAiOAuthTokens, SecretStore, SecretStoreError};
    use crate::settings::Settings;
    use crate::tool_names;
    use crate::tools::ToolCtx;
    use serde_json::Value;
    use std::collections::{BTreeMap, HashMap};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

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

    #[derive(Default)]
    struct IsolationSecretStore {
        values: Mutex<BTreeMap<String, String>>,
    }

    impl SecretStore for IsolationSecretStore {
        fn get(&self, account: &str) -> Result<String, SecretStoreError> {
            self.values
                .lock()
                .unwrap()
                .get(account)
                .cloned()
                .ok_or(SecretStoreError::Absent)
        }

        fn set(&self, account: &str, value: &str) -> Result<(), SecretStoreError> {
            self.values
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_string());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), SecretStoreError> {
            self.values.lock().unwrap().remove(account);
            Ok(())
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct RecordedTransportRequest {
        prompt: String,
        authorization: String,
        account_id: String,
        has_tool_output: bool,
    }

    struct IsolationTransportState {
        requests: Mutex<Vec<RecordedTransportRequest>>,
        failures: Mutex<Vec<String>>,
        b_seen: AtomicBool,
        b_seen_notify: tokio::sync::Notify,
        first_a_root_unauthorized: AtomicBool,
        parallel_arrivals: AtomicUsize,
        parallel_barrier: tokio::sync::Barrier,
    }

    impl IsolationTransportState {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                requests: Mutex::new(Vec::new()),
                failures: Mutex::new(Vec::new()),
                b_seen: AtomicBool::new(false),
                b_seen_notify: tokio::sync::Notify::new(),
                first_a_root_unauthorized: AtomicBool::new(false),
                parallel_arrivals: AtomicUsize::new(0),
                parallel_barrier: tokio::sync::Barrier::new(2),
            })
        }

        async fn wait_until_b_is_on_the_wire(&self) {
            while !self.b_seen.load(Ordering::SeqCst) {
                self.b_seen_notify.notified().await;
            }
        }
    }

    struct RecordingRefreshTransport {
        state: Arc<IsolationTransportState>,
        calls: Mutex<Vec<(String, String)>>,
        a_refreshes: AtomicUsize,
    }

    impl RecordingRefreshTransport {
        fn new(state: Arc<IsolationTransportState>) -> Arc<Self> {
            Arc::new(Self {
                state,
                calls: Mutex::new(Vec::new()),
                a_refreshes: AtomicUsize::new(0),
            })
        }
    }

    #[async_trait::async_trait]
    impl OpenAiRefreshTransport for RecordingRefreshTransport {
        async fn refresh(
            &self,
            _http: &reqwest::Client,
            current: &OpenAiOAuthTokens,
        ) -> Result<OpenAiOAuthTokens, String> {
            let account_id = current
                .account_id
                .clone()
                .ok_or_else(|| "mock refresh received no account identity".to_string())?;
            self.calls
                .lock()
                .unwrap()
                .push((account_id.clone(), current.access_token.clone()));
            if account_id != "account-a" {
                return Err(format!(
                    "mock refresh must never be invoked for {account_id}"
                ));
            }

            let refresh_number = self.a_refreshes.fetch_add(1, Ordering::SeqCst) + 1;
            // Hold A's expired-token refresh open until B has sent a real
            // authenticated Responses request. This makes the account overlap a
            // deterministic property of the proof rather than scheduler luck.
            if refresh_number == 1 {
                tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    self.state.wait_until_b_is_on_the_wire(),
                )
                .await
                .map_err(|_| "B never reached the transport while A refreshed".to_string())?;
            }

            let mut refreshed = current.clone();
            refreshed.access_token = match refresh_number {
                1 => "access-a-preflight",
                2 => "access-a-retry",
                other => return Err(format!("unexpected A refresh number {other}")),
            }
            .into();
            refreshed.expires_at = crate::oauth::now_secs() + 3_600;
            Ok(refreshed)
        }
    }

    struct RejectingRefreshTransport {
        error: String,
        calls: Mutex<Vec<String>>,
    }

    impl RejectingRefreshTransport {
        fn new(error: impl Into<String>) -> Arc<Self> {
            Arc::new(Self {
                error: error.into(),
                calls: Mutex::new(Vec::new()),
            })
        }
    }

    #[async_trait::async_trait]
    impl OpenAiRefreshTransport for RejectingRefreshTransport {
        async fn refresh(
            &self,
            _http: &reqwest::Client,
            current: &OpenAiOAuthTokens,
        ) -> Result<OpenAiOAuthTokens, String> {
            self.calls.lock().unwrap().push(
                current
                    .account_id
                    .clone()
                    .unwrap_or_else(|| "<missing>".into()),
            );
            Err(self.error.clone())
        }
    }

    #[derive(Default)]
    struct IsolationSink;

    impl EventSink for IsolationSink {
        fn emit(&self, _channel: &str, _event: StreamEvent) {}
    }

    fn request_prompt(body: &Value) -> Option<String> {
        body["input"].as_array()?.iter().find_map(|item| {
            if item["type"].as_str() != Some("message") {
                return None;
            }
            item["content"].as_array()?.iter().find_map(|content| {
                (content["type"].as_str() == Some("input_text"))
                    .then(|| content["text"].as_str().map(str::to_string))
                    .flatten()
            })
        })
    }

    fn has_tool_output(body: &Value) -> bool {
        body["input"].as_array().is_some_and(|input| {
            input
                .iter()
                .any(|item| item["type"].as_str() == Some("function_call_output"))
        })
    }

    fn completed_event() -> Value {
        serde_json::json!({
            "type": "response.completed",
            "response": { "usage": { "input_tokens": 7, "output_tokens": 3 } }
        })
    }

    fn sse_response(events: Vec<Value>) -> Vec<u8> {
        let mut body = String::new();
        for event in events {
            body.push_str("data: ");
            body.push_str(&serde_json::to_string(&event).unwrap());
            body.push_str("\n\n");
        }
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .into_bytes()
    }

    fn final_text_response(text: &str) -> Vec<u8> {
        sse_response(vec![
            serde_json::json!({ "type": "response.output_text.delta", "delta": text }),
            completed_event(),
        ])
    }

    fn delegate_response(calls: &[(&str, &str)]) -> Vec<u8> {
        let mut events = Vec::with_capacity(calls.len() + 1);
        for (index, (description, prompt)) in calls.iter().enumerate() {
            events.push(serde_json::json!({
                "type": "response.output_item.done",
                "item": {
                    "type": "function_call",
                    "id": format!("item-{index}-{prompt}"),
                    "call_id": format!("call-{index}-{prompt}"),
                    "name": "delegate_task",
                    "arguments": serde_json::json!({
                        "description": description,
                        "prompt": prompt,
                    }).to_string(),
                }
            }));
        }
        events.push(completed_event());
        sse_response(events)
    }

    async fn read_http_request(socket: &mut TcpStream) -> Result<(String, Value), String> {
        let mut bytes = Vec::new();
        let (header_end, content_length) = loop {
            let mut chunk = [0_u8; 4096];
            let read = socket
                .read(&mut chunk)
                .await
                .map_err(|error| format!("mock server read failed: {error}"))?;
            if read == 0 {
                return Err("mock client closed before sending a complete request".into());
            }
            bytes.extend_from_slice(&chunk[..read]);
            if bytes.len() > 2 * 1024 * 1024 {
                return Err("mock request exceeded 2 MiB".into());
            }
            if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                let header_end = end + 4;
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .ok_or_else(|| "mock request omitted content-length".to_string())?;
                break (header_end, content_length);
            }
        };
        while bytes.len() < header_end + content_length {
            let mut chunk = [0_u8; 4096];
            let read = socket
                .read(&mut chunk)
                .await
                .map_err(|error| format!("mock server body read failed: {error}"))?;
            if read == 0 {
                return Err("mock client closed mid-body".into());
            }
            bytes.extend_from_slice(&chunk[..read]);
        }

        let header_text = String::from_utf8(bytes[..header_end - 4].to_vec())
            .map_err(|_| "mock request headers were not UTF-8".to_string())?;
        let mut lines = header_text.lines();
        let request_line = lines.next().unwrap_or_default();
        if !request_line.starts_with("POST /responses HTTP/1.1") {
            return Err(format!("unexpected mock request line: {request_line}"));
        }
        let mut headers = HashMap::new();
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
            }
        }
        let body = serde_json::from_slice::<Value>(&bytes[header_end..header_end + content_length])
            .map_err(|error| format!("mock request JSON was invalid: {error}"))?;
        Ok((
            format!(
                "{}\n{}",
                headers.get("authorization").cloned().unwrap_or_default(),
                headers
                    .get("chatgpt-account-id")
                    .cloned()
                    .unwrap_or_default()
            ),
            body,
        ))
    }

    async fn handle_isolation_request(
        mut socket: TcpStream,
        state: Arc<IsolationTransportState>,
    ) -> Result<(), String> {
        let (auth_headers, body) = read_http_request(&mut socket).await?;
        let (authorization, account_id) = auth_headers
            .split_once('\n')
            .ok_or_else(|| "mock request header framing failed".to_string())?;
        let prompt = request_prompt(&body)
            .ok_or_else(|| "mock request did not contain an initial user prompt".to_string())?;
        let tool_output = has_tool_output(&body);
        state
            .requests
            .lock()
            .unwrap()
            .push(RecordedTransportRequest {
                prompt: prompt.clone(),
                authorization: authorization.to_string(),
                account_id: account_id.to_string(),
                has_tool_output: tool_output,
            });

        if account_id == "account-b" {
            state.b_seen.store(true, Ordering::SeqCst);
            state.b_seen_notify.notify_waiters();
        }

        let response = match (prompt.as_str(), tool_output) {
            ("root-a", false)
                if authorization == "Bearer access-a-preflight"
                    && !state.first_a_root_unauthorized.swap(true, Ordering::SeqCst) =>
            {
                b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    .to_vec()
            }
            ("root-a", false) => delegate_response(&[
                ("parallel child", "parallel-child"),
                ("nested parent", "nested-parent"),
            ]),
            ("root-a", true) => final_text_response("root-a-finished"),
            ("parallel-child", false) => {
                state.parallel_arrivals.fetch_add(1, Ordering::SeqCst);
                tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    state.parallel_barrier.wait(),
                )
                .await
                .map_err(|_| "parallel child requests did not overlap".to_string())?;
                final_text_response("parallel-child-finished")
            }
            ("nested-parent", false) => {
                state.parallel_arrivals.fetch_add(1, Ordering::SeqCst);
                tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    state.parallel_barrier.wait(),
                )
                .await
                .map_err(|_| "nested parent did not overlap its sibling".to_string())?;
                delegate_response(&[("nested leaf", "nested-leaf")])
            }
            ("nested-parent", true) => final_text_response("nested-parent-finished"),
            ("nested-leaf", false) => final_text_response("nested-leaf-finished"),
            ("root-b", false) => final_text_response("root-b-finished"),
            ("quota-a", false) => b"HTTP/1.1 429 Too Many Requests\r\n\
                content-length: 0\r\nconnection: close\r\n\r\n"
                .to_vec(),
            _ => {
                return Err(format!(
                    "unexpected mock request state: {prompt}/{tool_output}"
                ))
            }
        };
        socket
            .write_all(&response)
            .await
            .map_err(|error| format!("mock response write failed: {error}"))?;
        socket
            .shutdown()
            .await
            .map_err(|error| format!("mock response shutdown failed: {error}"))
    }

    async fn start_isolation_server(
        state: Arc<IsolationTransportState>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    break;
                };
                let request_state = state.clone();
                tokio::spawn(async move {
                    if let Err(error) =
                        handle_isolation_request(socket, request_state.clone()).await
                    {
                        request_state.failures.lock().unwrap().push(error);
                    }
                });
            }
        });
        (format!("http://{address}/responses"), handle)
    }

    fn openai_tokens(account_id: &str, access_token: &str, expires_at: i64) -> OpenAiOAuthTokens {
        OpenAiOAuthTokens {
            access_token: access_token.into(),
            refresh_token: format!("refresh-{account_id}"),
            id_token: None,
            expires_at,
            account_id: Some(account_id.into()),
            email: Some(format!("{account_id}@example.test")),
            plan: Some("plus".into()),
            is_fedramp: false,
        }
    }

    fn account_run_auth(
        registry: Arc<OpenAiAccountRegistry>,
        id: &AccountProfileId,
        model: &str,
    ) -> RunAuthContext {
        let lease = registry.acquire_run_lease(id).unwrap();
        let profile = registry.load_profile(id).unwrap();
        RunAuthContext {
            model: model.into(),
            credential: Credential::OpenAiOAuth(profile.tokens),
            openai: Some(OpenAiRunAuth {
                registry,
                profile_id: id.clone(),
                _lease: Arc::new(lease),
            }),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_isolation_root(
        sink: Arc<dyn EventSink>,
        http: reqwest::Client,
        provider: Arc<dyn LlmProvider>,
        openai_refresh: Arc<dyn OpenAiRefreshTransport>,
        settings: Settings,
        auth: RunAuthContext,
        prompt: &str,
        channel: &str,
        workspace: PathBuf,
        delegates: bool,
    ) -> Result<LoopOutcome, String> {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let agents = crate::agents::new();
        let cancel = Arc::new(AtomicBool::new(false));
        let refresh_lock = Arc::new(tokio::sync::Mutex::new(()));
        let ask_lock = Arc::new(tokio::sync::Mutex::new(()));
        let receipt_tracker = crate::turn_receipt::TurnReceiptTracker::new_with_account(
            format!("receipt-{prompt}"),
            crate::db::now_ms(),
            Instant::now(),
            workspace.clone(),
            auth.account_profile_id().map(str::to_string),
        )
        .await;
        let registry = if delegates {
            crate::tools::default_registry()
        } else {
            crate::tools::read_only_registry()
        };
        let mut ctx = ToolCtx::new(workspace.clone());
        ctx.receipt = Some(receipt_tracker.clone());
        if delegates {
            ctx.spawner = Some(Arc::new(AgentSpawner {
                sink: sink.clone(),
                http: http.clone(),
                provider: provider.clone(),
                openai_refresh: openai_refresh.clone(),
                run_settings: settings.clone(),
                auth: auth.clone(),
                pending: pending.clone(),
                agents,
                cancel: cancel.clone(),
                refresh_lock: refresh_lock.clone(),
                ask_lock: ask_lock.clone(),
                receipt_tracker,
                parent_channel: channel.into(),
                workspace,
                self_id: None,
                depth: 1,
            }));
        }
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: vec![text_block(prompt)],
        }];
        run_loop_core(
            sink.as_ref(),
            &http,
            provider.as_ref(),
            &settings,
            auth.credential.clone(),
            refresh_lock.as_ref(),
            openai_refresh.as_ref(),
            &auth,
            ask_lock.as_ref(),
            &pending,
            &cancel,
            channel,
            channel,
            None,
            &registry,
            "isolation transport system prompt",
            &ctx,
            messages,
            &Persist::Ephemeral,
        )
        .await
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_chatgpt_accounts_keep_transport_refresh_and_subagents_isolated() {
        let state = IsolationTransportState::new();
        let (responses_url, server) = start_isolation_server(state.clone()).await;
        let provider: Arc<dyn LlmProvider> =
            Arc::new(OpenAiProvider::with_responses_url(responses_url));
        let refresh = RecordingRefreshTransport::new(state.clone());
        let refresh_trait: Arc<dyn OpenAiRefreshTransport> = refresh.clone();
        let registry = Arc::new(OpenAiAccountRegistry::with_store(Arc::new(
            IsolationSecretStore::default(),
        )));
        let now = crate::oauth::now_secs();
        let account_a = registry
            .register_account(openai_tokens("account-a", "access-a-expired", 0), now)
            .unwrap();
        let account_b = registry
            .register_account(
                openai_tokens("account-b", "access-b-stable", now + 3_600),
                now + 1,
            )
            .unwrap();
        let initial_a = registry.load_profile(&account_a.id).unwrap();
        let initial_b = registry.load_profile(&account_b.id).unwrap();
        let auth_a = account_run_auth(registry.clone(), &account_a.id, "gpt-5.3-codex");
        let auth_b = account_run_auth(registry.clone(), &account_b.id, "gpt-5.3-codex");
        let settings = Settings {
            provider: "openai".into(),
            model: "gpt-5.3-codex".into(),
            ..Settings::default()
        };
        let workspace = std::env::temp_dir().join(format!(
            "portcode-two-account-transport-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&workspace).unwrap();
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let sink: Arc<dyn EventSink> = Arc::new(IsolationSink);

        let a_run = run_isolation_root(
            sink.clone(),
            http.clone(),
            provider.clone(),
            refresh_trait.clone(),
            settings.clone(),
            auth_a,
            "root-a",
            "agent://session-a",
            workspace.clone(),
            true,
        );
        let b_run = run_isolation_root(
            sink,
            http,
            provider,
            refresh_trait,
            settings,
            auth_b,
            "root-b",
            "agent://session-b",
            workspace.clone(),
            false,
        );
        let (a_outcome, b_outcome) =
            tokio::time::timeout(std::time::Duration::from_secs(15), async {
                tokio::join!(a_run, b_run)
            })
            .await
            .expect("isolation scenario must not hang");
        let a_outcome = a_outcome.expect("account A root should finish");
        let b_outcome = b_outcome.expect("account B root should finish");
        server.abort();

        assert_eq!(a_outcome.final_text, "root-a-finished");
        assert_eq!(b_outcome.final_text, "root-b-finished");
        assert!(state.first_a_root_unauthorized.load(Ordering::SeqCst));
        assert_eq!(
            state.parallel_arrivals.load(Ordering::SeqCst),
            2,
            "the two first-level A subagents must reach the server together"
        );
        assert!(
            state.failures.lock().unwrap().is_empty(),
            "mock transport failures: {:?}",
            *state.failures.lock().unwrap()
        );

        let requests = state.requests.lock().unwrap().clone();
        assert!(
            requests.iter().any(|request| request.prompt == "root-a"
                && request.authorization == "Bearer access-a-preflight"),
            "A's expired credential must be refreshed before its first request"
        );
        assert!(
            requests.iter().any(|request| request.prompt == "root-a"
                && request.authorization == "Bearer access-a-retry"),
            "A's 401 must rotate and retry exactly its own credential"
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.prompt == "root-b")
                .count(),
            1,
            "B must complete without A's 401 causing a retry"
        );
        for request in &requests {
            let expected_account = if request.prompt == "root-b" {
                "account-b"
            } else {
                "account-a"
            };
            assert_eq!(
                request.account_id, expected_account,
                "a run changed its immutable account identity: {request:?}"
            );
            match request.account_id.as_str() {
                "account-a" => assert!(
                    ["Bearer access-a-preflight", "Bearer access-a-retry"]
                        .contains(&request.authorization.as_str()),
                    "A request crossed credentials: {request:?}"
                ),
                "account-b" => assert_eq!(
                    request.authorization, "Bearer access-b-stable",
                    "B request crossed credentials: {request:?}"
                ),
                other => panic!("unexpected ChatGPT-Account-ID header {other:?}"),
            }
        }
        for prompt in ["parallel-child", "nested-parent", "nested-leaf"] {
            let inherited: Vec<_> = requests
                .iter()
                .filter(|request| request.prompt == prompt)
                .collect();
            assert!(!inherited.is_empty(), "missing {prompt} transport request");
            assert!(inherited.iter().all(|request| {
                request.account_id == "account-a"
                    && request.authorization == "Bearer access-a-retry"
            }));
        }
        assert!(requests
            .iter()
            .any(|request| { request.prompt == "nested-parent" && request.has_tool_output }));
        assert!(requests
            .iter()
            .all(|request| request.authorization != "Bearer access-a-expired"));

        assert_eq!(
            *refresh.calls.lock().unwrap(),
            vec![
                ("account-a".into(), "access-a-expired".into()),
                ("account-a".into(), "access-a-preflight".into()),
            ],
            "only A may enter preflight/401 refresh"
        );
        let final_a = registry.load_profile(&account_a.id).unwrap();
        let final_b = registry.load_profile(&account_b.id).unwrap();
        assert_eq!(final_a.tokens.access_token, "access-a-retry");
        assert_eq!(
            final_a.credential_generation,
            initial_a.credential_generation + 2
        );
        assert_eq!(final_b.tokens.access_token, "access-b-stable");
        assert_eq!(
            final_b.credential_generation, initial_b.credential_generation,
            "A refresh must not advance B's registry generation"
        );

        std::fs::remove_dir_all(workspace).ok();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn account_a_quota_rejection_never_falls_back_to_account_b() {
        let state = IsolationTransportState::new();
        let (responses_url, server) = start_isolation_server(state.clone()).await;
        let provider: Arc<dyn LlmProvider> =
            Arc::new(OpenAiProvider::with_responses_url(responses_url));
        let refresh = RejectingRefreshTransport::new("refresh must not run for fresh tokens");
        let refresh_trait: Arc<dyn OpenAiRefreshTransport> = refresh.clone();
        let registry = Arc::new(OpenAiAccountRegistry::with_store(Arc::new(
            IsolationSecretStore::default(),
        )));
        let now = crate::oauth::now_secs();
        let account_a = registry
            .register_account(
                openai_tokens("account-a", "access-a-stable", now + 3_600),
                now,
            )
            .unwrap();
        let account_b = registry
            .register_account(
                openai_tokens("account-b", "access-b-stable", now + 3_600),
                now + 1,
            )
            .unwrap();
        let initial_b = registry.load_profile(&account_b.id).unwrap();
        let auth_a = account_run_auth(registry.clone(), &account_a.id, "gpt-5.3-codex");
        let settings = Settings {
            provider: "openai".into(),
            model: "gpt-5.3-codex".into(),
            ..Settings::default()
        };
        let workspace = std::env::temp_dir().join(format!(
            "portcode-account-quota-isolation-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&workspace).unwrap();

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run_isolation_root(
                Arc::new(IsolationSink),
                reqwest::Client::builder().no_proxy().build().unwrap(),
                provider,
                refresh_trait,
                settings,
                auth_a,
                "quota-a",
                "agent://quota-a",
                workspace.clone(),
                false,
            ),
        )
        .await
        .expect("the quota response must not hang");
        let Err(error) = result else {
            panic!("Account A's 429 must fail the run");
        };
        server.abort();

        assert_eq!(
            error,
            "OpenAI response was rejected (HTTP 429). Please retry."
        );
        assert!(refresh.calls.lock().unwrap().is_empty());
        assert!(
            state.failures.lock().unwrap().is_empty(),
            "mock transport failures: {:?}",
            *state.failures.lock().unwrap()
        );
        let requests = state.requests.lock().unwrap().clone();
        assert_eq!(
            requests.len(),
            1,
            "a 429 must not trigger a fallback request"
        );
        assert_eq!(requests[0].prompt, "quota-a");
        assert_eq!(requests[0].account_id, "account-a");
        assert_eq!(requests[0].authorization, "Bearer access-a-stable");
        assert!(requests
            .iter()
            .all(|request| request.account_id != "account-b"));

        let final_b = registry.load_profile(&account_b.id).unwrap();
        assert_eq!(final_b.tokens.access_token, "access-b-stable");
        assert_eq!(
            final_b.credential_generation, initial_b.credential_generation,
            "A's provider failure must not mutate B"
        );
        std::fs::remove_dir_all(workspace).ok();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn invalid_refresh_identity_quarantines_only_a_before_inference_and_b_still_runs() {
        for refresh_error in [
            "OpenAI token refresh did not assert a ChatGPT account. Reconnect this account in Settings.",
            "OpenAI returned an invalid ChatGPT account identity.",
        ] {
            let state = IsolationTransportState::new();
            let (responses_url, server) = start_isolation_server(state.clone()).await;
            let provider: Arc<dyn LlmProvider> =
                Arc::new(OpenAiProvider::with_responses_url(responses_url));
            let refresh = RejectingRefreshTransport::new(refresh_error);
            let refresh_trait: Arc<dyn OpenAiRefreshTransport> = refresh.clone();
            let registry = Arc::new(OpenAiAccountRegistry::with_store(Arc::new(
                IsolationSecretStore::default(),
            )));
            let now = crate::oauth::now_secs();
            let account_a = registry
                .register_account(openai_tokens("account-a", "access-a-expired", 0), now)
                .unwrap();
            let account_b = registry
                .register_account(
                    openai_tokens("account-b", "access-b-stable", now + 3_600),
                    now + 1,
                )
                .unwrap();
            let settings = Settings {
                provider: "openai".into(),
                model: "gpt-5.3-codex".into(),
                ..Settings::default()
            };
            let workspace = std::env::temp_dir().join(format!(
                "portcode-refresh-identity-isolation-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&workspace).unwrap();

            let a_result = run_isolation_root(
                Arc::new(IsolationSink),
                reqwest::Client::builder().no_proxy().build().unwrap(),
                provider.clone(),
                refresh_trait.clone(),
                settings.clone(),
                account_run_auth(registry.clone(), &account_a.id, "gpt-5.3-codex"),
                "root-a-never-sent",
                "agent://identity-a",
                workspace.clone(),
                false,
            )
            .await;
            let Err(a_error) = a_result else {
                panic!("an unsafe refresh identity must stop Account A");
            };
            assert_eq!(
                a_error,
                "This ChatGPT account session expired. Reconnect that account in Settings."
            );
            assert!(
                state.requests.lock().unwrap().is_empty(),
                "Account A must be quarantined before any inference request"
            );

            let summaries = registry.list_accounts().unwrap();
            assert_eq!(
                summaries
                    .iter()
                    .find(|summary| summary.id == account_a.id)
                    .unwrap()
                    .state,
                OpenAiAccountState::ReconnectRequired
            );
            assert_eq!(
                summaries
                    .iter()
                    .find(|summary| summary.id == account_b.id)
                    .unwrap()
                    .state,
                OpenAiAccountState::Connected
            );

            let b_outcome = run_isolation_root(
                Arc::new(IsolationSink),
                reqwest::Client::builder().no_proxy().build().unwrap(),
                provider,
                refresh_trait,
                settings,
                account_run_auth(registry.clone(), &account_b.id, "gpt-5.3-codex"),
                "root-b",
                "agent://identity-b",
                workspace.clone(),
                false,
            )
            .await
            .expect("Account B must remain usable after A is quarantined");
            server.abort();

            assert_eq!(b_outcome.final_text, "root-b-finished");
            assert_eq!(*refresh.calls.lock().unwrap(), vec!["account-a"]);
            assert!(
                state.failures.lock().unwrap().is_empty(),
                "mock transport failures: {:?}",
                *state.failures.lock().unwrap()
            );
            let requests = state.requests.lock().unwrap().clone();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].prompt, "root-b");
            assert_eq!(requests[0].account_id, "account-b");
            assert_eq!(requests[0].authorization, "Bearer access-b-stable");
            std::fs::remove_dir_all(workspace).ok();
        }
    }

    #[test]
    fn removing_a_preserves_serialized_session_history_usage_and_account_b() {
        let registry = Arc::new(OpenAiAccountRegistry::with_store(Arc::new(
            IsolationSecretStore::default(),
        )));
        let now = crate::oauth::now_secs();
        let account_a = registry
            .register_account(
                openai_tokens("account-a", "access-a-stable", now + 3_600),
                now,
            )
            .unwrap();
        let account_b = registry
            .register_account(
                openai_tokens("account-b", "access-b-stable", now + 3_600),
                now + 1,
            )
            .unwrap();
        let initial_b = registry.load_profile(&account_b.id).unwrap();
        let db = Db::open(Path::new(":memory:")).expect("in-memory db");
        db.create_session_with_account(
            "session-a",
            "Account A history",
            None,
            Some("gpt-5.3-codex"),
            Some(account_a.id.as_str()),
            10,
        )
        .unwrap();
        db.create_session_with_account(
            "session-b",
            "Account B history",
            None,
            Some("gpt-5.3-codex"),
            Some(account_b.id.as_str()),
            11,
        )
        .unwrap();
        db.append_message(
            "session-a",
            &ChatMessage {
                role: "user".into(),
                content: vec![text_block("durable question for A")],
            },
            12,
        );
        db.append_message(
            "session-a",
            &ChatMessage {
                role: "assistant".into(),
                content: vec![text_block("durable answer from A")],
            },
            13,
        );
        db.append_message(
            "session-b",
            &ChatMessage {
                role: "assistant".into(),
                content: vec![text_block("B remains here")],
            },
            14,
        );
        db.add_usage("session-a", 17, 23, 15).unwrap();

        // SessionRow, MessageRow, and UsageRow are the serialized IPC/sync
        // surfaces used by history views and export consumers. Capture them
        // byte-for-value before removal so the assertion covers more than a row
        // count or a provider-facing transcript reload.
        let sessions_before = serde_json::to_value(db.list_sessions().unwrap()).unwrap();
        let a_history_before = serde_json::to_value(db.messages_since("session-a", -1)).unwrap();
        let b_history_before = serde_json::to_value(db.messages_since("session-b", -1)).unwrap();
        let usage_before = serde_json::to_value(db.get_usage("session-a")).unwrap();

        registry.remove_account(&account_a.id, now + 2).unwrap();

        assert_eq!(
            serde_json::to_value(db.list_sessions().unwrap()).unwrap(),
            sessions_before
        );
        assert_eq!(
            serde_json::to_value(db.messages_since("session-a", -1)).unwrap(),
            a_history_before
        );
        assert_eq!(
            serde_json::to_value(db.messages_since("session-b", -1)).unwrap(),
            b_history_before
        );
        assert_eq!(
            serde_json::to_value(db.get_usage("session-a")).unwrap(),
            usage_before
        );
        let loaded_a = db.load_chat_messages("session-a");
        assert_eq!(loaded_a.len(), 2);
        assert_eq!(
            assistant_text(&loaded_a[1].content),
            "durable answer from A"
        );
        assert!(matches!(
            registry.load_profile(&account_a.id),
            Err(OpenAiAccountError::ProfileRemoved)
        ));
        let final_b = registry.load_profile(&account_b.id).unwrap();
        assert_eq!(final_b.tokens.access_token, "access-b-stable");
        assert_eq!(
            final_b.credential_generation,
            initial_b.credential_generation
        );
    }

    #[test]
    fn run_and_account_read_admissions_hold_the_removal_boundary_until_all_drop() {
        let registry = Arc::new(OpenAiAccountRegistry::with_store(Arc::new(
            IsolationSecretStore::default(),
        )));
        let now = crate::oauth::now_secs();
        let account_a = registry
            .register_account(
                openai_tokens("account-a", "access-a-stable", now + 3_600),
                now,
            )
            .unwrap();
        let account_b = registry
            .register_account(
                openai_tokens("account-b", "access-b-stable", now + 3_600),
                now + 1,
            )
            .unwrap();
        let db = Db::open(Path::new(":memory:")).expect("in-memory db");
        db.create_session_with_account(
            "session-a",
            "Account A",
            None,
            Some("gpt-5.3-codex"),
            Some(account_a.id.as_str()),
            10,
        )
        .unwrap();
        let settings = Settings {
            provider: "openai".into(),
            model: "gpt-5.3-codex".into(),
            ..Settings::default()
        };
        let admission = admit_run(
            Arc::new(Mutex::new(HashMap::new())),
            &db,
            &settings,
            registry.clone(),
            "session-a",
        )
        .expect("the account-bound run should be admitted");
        // Model-catalog and usage commands acquire this same lifecycle lease in
        // lib.rs before loading credentials or issuing network requests. Hold one
        // lease for each command shape to prove removal cannot win any interleaving.
        let model_catalog_admission = registry.acquire_run_lease(&account_a.id).unwrap();
        let usage_admission = registry.acquire_run_lease(&account_a.id).unwrap();

        assert!(matches!(
            registry.remove_account(&account_a.id, now + 2),
            Err(OpenAiAccountError::ActiveRuns)
        ));
        drop(admission);
        assert!(matches!(
            registry.remove_account(&account_a.id, now + 3),
            Err(OpenAiAccountError::ActiveRuns)
        ));
        drop(model_catalog_admission);
        assert!(matches!(
            registry.remove_account(&account_a.id, now + 4),
            Err(OpenAiAccountError::ActiveRuns)
        ));
        drop(usage_admission);
        registry.remove_account(&account_a.id, now + 5).unwrap();

        // The lifecycle map intentionally does not duplicate durable profile
        // state. A post-removal caller can enter the lease boundary, but the
        // authoritative profile load still fails closed before any credential or
        // network work can begin.
        let post_removal_lease = registry.acquire_run_lease(&account_a.id).unwrap();
        assert!(matches!(
            registry.load_profile(&account_a.id),
            Err(OpenAiAccountError::ProfileRemoved)
        ));
        drop(post_removal_lease);
        assert_eq!(
            registry
                .load_profile(&account_b.id)
                .unwrap()
                .tokens
                .access_token,
            "access-b-stable"
        );
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
                name: "read_file".into(),
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
                name: "run_command".into(),
                input: serde_json::json!({}),
            }]),
            ""
        );
        assert_eq!(assistant_text(&[]), "");
    }

    #[test]
    fn provider_history_normalizes_legacy_tool_names_without_changing_other_blocks() {
        let mut messages = vec![ChatMessage {
            role: "assistant".into(),
            content: tool_names::LEGACY_ALIASES
                .iter()
                .enumerate()
                .map(|(index, (legacy, _))| Block::ToolUse {
                    id: format!("call-{index}"),
                    name: (*legacy).into(),
                    input: serde_json::json!({ "index": index }),
                })
                .chain(std::iter::once(text_block("unchanged")))
                .collect(),
        }];

        canonicalize_tool_history(&mut messages);

        for (index, expected_name) in tool_names::CANONICAL_NAMES.iter().enumerate() {
            match &messages[0].content[index] {
                Block::ToolUse { id, name, input } => {
                    assert_eq!(id, &format!("call-{index}"));
                    assert_eq!(name, *expected_name);
                    assert_eq!(input, &serde_json::json!({ "index": index }));
                }
                other => panic!("expected tool use, got {other:?}"),
            }
        }
        match messages[0].content.last() {
            Some(Block::Text { text }) => assert_eq!(text, "unchanged"),
            other => panic!("expected unchanged text block, got {other:?}"),
        }
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
    fn subagent_label_passes_through_a_good_description() {
        // A real, non-generic description of at least 3 chars is used as-is.
        assert_eq!(
            subagent_label("audit deps", "find vulnerable crates"),
            "audit deps"
        );
        assert_eq!(
            subagent_label("Fix auth bug", "irrelevant prompt"),
            "Fix auth bug"
        );
    }

    #[test]
    fn subagent_label_falls_back_to_prompt_when_description_is_generic_or_short() {
        // The literal placeholder "subagent" (any case) and short/empty strings
        // trigger a derivation from the prompt's first line.
        assert_eq!(
            subagent_label("subagent", "Search for vulnerable crates in Cargo.toml"),
            "Search for vulnerable crates in Cargo.toml"
        );
        assert_eq!(
            subagent_label("SUBAGENT", "Analyse the login flow"),
            "Analyse the login flow"
        );
        assert_eq!(
            subagent_label("", "Run the test suite"),
            "Run the test suite"
        );
        assert_eq!(
            subagent_label("  ", "Run the test suite"),
            "Run the test suite"
        );
        // A two-char description is too short and falls back to the prompt.
        assert_eq!(
            subagent_label("ab", "Do something useful"),
            "Do something useful"
        );
    }

    #[test]
    fn subagent_label_uses_first_nonempty_prompt_line() {
        let prompt = "\n\n  \nActual task line\nSecond line of prompt";
        assert_eq!(subagent_label("subagent", prompt), "Actual task line");
    }

    #[test]
    fn subagent_label_strips_markdown_prefix() {
        assert_eq!(
            subagent_label("", "- List all open PRs"),
            "List all open PRs"
        );
        assert_eq!(subagent_label("", "## Review security"), "Review security");
        assert_eq!(subagent_label("", "# Heading task"), "Heading task");
        assert_eq!(subagent_label("", "* Bullet task"), "Bullet task");
        assert_eq!(subagent_label("", "> Quoted task"), "Quoted task");
    }

    #[test]
    fn subagent_label_truncates_long_prompts_on_word_boundary() {
        // 70 'a's followed by a space and "overflow" — must truncate before 60 chars.
        let long = format!("{} overflow", "a".repeat(70));
        let label = subagent_label("", &long);
        // Result must end with '…' and must be at most 61 bytes (60 + the 3-byte
        // UTF-8 ellipsis '…').
        assert!(label.ends_with('…'), "expected ellipsis, got: {label:?}");
        assert!(
            label.len() <= 63,
            "label too long ({} bytes): {label:?}",
            label.len()
        );
    }

    #[test]
    fn subagent_label_truncates_safely_on_multibyte_input() {
        // 30 two-byte characters (é, U+00E9) gives 60 bytes exactly at position 30 —
        // truncating at byte 60 would land on a char boundary here, but the test also
        // exercises the path through `char_indices` safely.
        let repeated = "é".repeat(30); // 60 bytes, each char 2 bytes
        let prompt = format!("{repeated} and more text");
        let label = subagent_label("subagent", &prompt);
        // The label must be valid UTF-8 (no panic) and at most 63 bytes.
        assert!(label.len() <= 63, "label too long: {}", label.len());
        // Emoji prompt — each emoji is 4 bytes.
        let emoji_prompt = "🚀".repeat(20); // 80 bytes total
        let emoji_label = subagent_label("", &emoji_prompt);
        assert!(!emoji_label.is_empty());
        // Must be valid UTF-8 — collecting chars proves there's no half-cut codepoint.
        let _chars: Vec<char> = emoji_label.chars().collect();
    }

    #[test]
    fn subagent_label_both_empty_returns_fallback() {
        assert_eq!(subagent_label("", ""), "subagent");
        assert_eq!(subagent_label("subagent", ""), "subagent");
        assert_eq!(subagent_label("subagent", "  \n  "), "subagent");
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
        db.create_session("s1", "T", None, None, 1).unwrap();
        let p = Persist::Session {
            db: &db,
            session_id: "s1",
            turn_id: "turn-1",
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
    fn admission_requires_an_explicit_profile_for_legacy_openai_sessions() {
        let db = Db::open(Path::new(":memory:")).expect("in-memory db");
        db.create_session("legacy", "Legacy", None, Some("gpt-5.6-sol"), 1)
            .unwrap();
        let cancels: Cancels = Arc::new(Mutex::new(HashMap::new()));
        let error = admit_run(
            cancels.clone(),
            &db,
            &Settings::default(),
            Arc::new(OpenAiAccountRegistry::system()),
            "legacy",
        )
        .err()
        .expect("legacy OpenAI sessions must not guess an account");
        assert!(error.contains("not pinned"), "unexpected error: {error}");
        assert!(
            RunReservation::try_acquire(cancels, "legacy").is_ok(),
            "failed admission must release the synchronous reservation"
        );
    }

    #[test]
    fn admission_rejects_an_openai_profile_on_an_anthropic_session() {
        let db = Db::open(Path::new(":memory:")).expect("in-memory db");
        db.create_session_with_account(
            "cross-provider",
            "Cross provider",
            None,
            Some("claude-opus-4-8"),
            Some("00000000-0000-4000-8000-000000000001"),
            1,
        )
        .unwrap();
        let error = admit_run(
            Arc::new(Mutex::new(HashMap::new())),
            &db,
            &Settings::default(),
            Arc::new(OpenAiAccountRegistry::system()),
            "cross-provider",
        )
        .err()
        .expect("provider/account crossing must fail before credential lookup");
        assert!(error.contains("pinned to a ChatGPT account"));
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
            [
                "read_file",
                "list_directory",
                "find_files",
                "search_text",
                "write_file",
                "edit_file",
                "run_command",
                "delegate_task"
            ]
        );
        assert!(cfg.system_prompt.is_none());
        assert!(cfg.prompt_steer.is_none());
    }

    #[test]
    fn plan_run_config_is_read_only_and_carries_the_plan_steer() {
        // Plan mode hands the model only the read-only tools (no write/edit/shell)
        // and a steer that tells it to design rather than mutate.
        let cfg = AgentConfig::plan_run();
        assert_eq!(
            spec_names(&cfg),
            ["read_file", "list_directory", "find_files", "search_text"]
        );
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
    fn rejects_an_openai_account_change_during_a_turn() {
        assert_eq!(
            ensure_openai_account_unchanged(Some("account-a"), Some("account-b")).unwrap_err(),
            "The signed-in ChatGPT account changed during this turn. Start the turn again."
        );
        assert!(ensure_openai_account_unchanged(Some("account-a"), Some("account-a")).is_ok());
        assert!(ensure_openai_account_unchanged(None, Some("account-a")).is_err());
        assert!(ensure_openai_account_unchanged(Some("account-a"), None).is_err());
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

    #[test]
    fn run_reservation_rejects_only_the_same_session_and_drops_safely() {
        let cancels: Cancels = Arc::new(Mutex::new(HashMap::new()));
        let first = RunReservation::try_acquire(cancels.clone(), "a").unwrap();
        assert!(RunReservation::try_acquire(cancels.clone(), "a").is_err());
        let other = RunReservation::try_acquire(cancels.clone(), "b").unwrap();
        assert!(cancels.lock().unwrap().contains_key("a"));
        assert!(cancels.lock().unwrap().contains_key("b"));
        drop(first);
        assert!(!cancels.lock().unwrap().contains_key("a"));
        assert!(cancels.lock().unwrap().contains_key("b"));
        drop(other);
        assert!(cancels.lock().unwrap().is_empty());
    }
}
