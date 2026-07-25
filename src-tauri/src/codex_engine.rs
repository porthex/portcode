//! Portcode's projection layer over the real Codex app-server.
//!
//! Codex owns agent reasoning, context, tools, approvals, compaction, MCP, and
//! multi-agent execution. This module only maps Portcode session ids to Codex
//! thread ids, persists a UI/search read model, and projects the lossless event
//! stream into Portcode's existing chat primitives.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, Mutex, RwLock};

use crate::{
    attachments::PreparedTurn,
    codex_app_server::{CodexAppServer, Incoming},
    db::{self, Db},
    events::EventSink,
    llm::{Block, ChatMessage, StreamEvent},
    settings::Settings,
};

pub const PRIMARY_CODEX_ACCOUNT_ID: &str = "codex-primary";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLoginStart {
    pub login_id: String,
    pub auth_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountView {
    pub signed_in: bool,
    pub auth_mode: Option<String>,
    pub account: Option<String>,
    pub tier: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexServiceTierView {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelView {
    pub id: String,
    pub label: String,
    pub reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: String,
    pub service_tiers: Vec<CodexServiceTierView>,
}

#[derive(Clone, Debug)]
struct ThreadRoute {
    session_id: String,
    root_thread_id: String,
    is_subagent: bool,
}

#[derive(Clone, Debug)]
struct PendingTurnStart {
    generation: u64,
    run_id: String,
    session_id: String,
    thread_id: String,
    text: String,
    started_at_ms: i64,
}

#[derive(Clone, Debug)]
struct ActiveSessionTurn {
    run_id: String,
    generation: Option<u64>,
    turn_id: Option<String>,
}

#[derive(Clone, Debug)]
struct ActiveThreadTurn {
    generation: u64,
    turn_id: String,
}

#[derive(Clone, Debug)]
struct PendingServerRequest {
    generation: u64,
    rpc_id: Value,
    method: String,
    params: Value,
    session_id: String,
}

#[derive(Clone, Debug)]
enum ProjectedItem {
    Text(String),
    Tool {
        id: String,
        name: String,
        input: Value,
        output: Option<(String, bool)>,
    },
}

#[derive(Clone, Debug)]
struct TurnProjection {
    generation: u64,
    session_id: String,
    thread_id: String,
    turn_id: String,
    order: Vec<String>,
    items: HashMap<String, ProjectedItem>,
}

impl TurnProjection {
    fn new(generation: u64, session_id: String, thread_id: String, turn_id: String) -> Self {
        Self {
            generation,
            session_id,
            thread_id,
            turn_id,
            order: Vec::new(),
            items: HashMap::new(),
        }
    }

    fn ensure_ordered(&mut self, item_id: &str) {
        if !self.items.contains_key(item_id) {
            self.order.push(item_id.to_string());
        }
    }

    fn blocks(&self) -> Vec<Block> {
        let mut blocks = Vec::new();
        for id in &self.order {
            match self.items.get(id) {
                Some(ProjectedItem::Text(text)) if !text.is_empty() => {
                    blocks.push(Block::Text { text: text.clone() });
                }
                Some(ProjectedItem::Tool {
                    id,
                    name,
                    input,
                    output,
                }) => {
                    blocks.push(Block::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                    });
                    if let Some((content, is_error)) = output {
                        blocks.push(Block::ToolResult {
                            tool_use_id: id.clone(),
                            content: content.clone(),
                            is_error: *is_error,
                        });
                    }
                }
                _ => {}
            }
        }
        blocks
    }
}

pub struct CodexEngine {
    server: CodexAppServer,
    db: Arc<Db>,
    sink: Arc<dyn EventSink>,
    event_pump: StdMutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    routes: RwLock<HashMap<String, ThreadRoute>>,
    resumed_generation: Mutex<HashMap<String, u64>>,
    pending_starts: Mutex<HashMap<String, PendingTurnStart>>,
    active_by_session: Mutex<HashMap<String, ActiveSessionTurn>>,
    active_by_thread: Mutex<HashMap<String, ActiveThreadTurn>>,
    turns: Mutex<HashMap<String, TurnProjection>>,
    usage_by_turn: Mutex<HashMap<(u64, String, String), (u32, u32)>>,
    pending_requests: Mutex<HashMap<String, PendingServerRequest>>,
    deferred_by_thread: Mutex<HashMap<String, Vec<Incoming>>>,
    login_results: Mutex<HashMap<String, Result<(), String>>>,
}

impl CodexEngine {
    pub fn new(server: CodexAppServer, db: Arc<Db>, sink: Arc<dyn EventSink>) -> Arc<Self> {
        let routes = db
            .codex_thread_routes()
            .unwrap_or_default()
            .into_iter()
            .map(|(thread_id, session_id)| {
                (
                    thread_id.clone(),
                    ThreadRoute {
                        session_id,
                        root_thread_id: thread_id,
                        is_subagent: false,
                    },
                )
            })
            .collect();
        Arc::new(Self {
            server,
            db,
            sink,
            event_pump: StdMutex::new(None),
            routes: RwLock::new(routes),
            resumed_generation: Mutex::new(HashMap::new()),
            pending_starts: Mutex::new(HashMap::new()),
            active_by_session: Mutex::new(HashMap::new()),
            active_by_thread: Mutex::new(HashMap::new()),
            turns: Mutex::new(HashMap::new()),
            usage_by_turn: Mutex::new(HashMap::new()),
            pending_requests: Mutex::new(HashMap::new()),
            deferred_by_thread: Mutex::new(HashMap::new()),
            login_results: Mutex::new(HashMap::new()),
        })
    }

    pub fn start_event_pump(self: &Arc<Self>) {
        let mut incoming = self.server.subscribe();
        let engine = Arc::clone(self);
        let task = tauri::async_runtime::spawn(async move {
            loop {
                match incoming.recv().await {
                    Ok(message) => engine.handle_incoming(message).await,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        engine.emit_bridge_warning(format!(
                            "Codex activity consumer fell behind by {skipped} events; reload the thread to inspect authoritative history."
                        ));
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });

        let previous = self.event_pump.lock().unwrap().replace(task);
        if let Some(previous) = previous {
            previous.abort();
        }
    }

    pub fn server(&self) -> &CodexAppServer {
        &self.server
    }

    pub async fn account(&self, refresh: bool) -> Result<CodexAccountView, String> {
        let value = self
            .server
            .account_read(refresh)
            .await
            .map_err(|error| error.to_string())?;
        Ok(account_view(&value))
    }

    pub async fn start_chatgpt_login(&self) -> Result<CodexLoginStart, String> {
        let value = self
            .server
            .request(
                "account/login/start",
                json!({
                    "type": "chatgpt",
                    "appBrand": "codex",
                    "codexStreamlinedLogin": true,
                    "useHostedLoginSuccessPage": true,
                }),
            )
            .await
            .map_err(|error| error.to_string())?;
        let login_id = string_at(&value, &["loginId"])
            .ok_or_else(|| "Codex did not return a login id.".to_string())?;
        let auth_url = string_at(&value, &["authUrl"])
            .ok_or_else(|| "Codex did not return a browser login URL.".to_string())?;
        Ok(CodexLoginStart { login_id, auth_url })
    }

    pub async fn wait_for_login(&self, login_id: &str) -> Result<CodexAccountView, String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10 * 60);
        loop {
            if let Some(result) = self.login_results.lock().await.remove(login_id) {
                result?;
            }
            let account = self.account(false).await?;
            if account.signed_in {
                return Ok(account);
            }
            if tokio::time::Instant::now() >= deadline {
                let _ = self
                    .server
                    .request("account/login/cancel", json!({ "loginId": login_id }))
                    .await;
                return Err("ChatGPT sign-in timed out. Please try again.".to_string());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    pub async fn login_api_key(&self, api_key: String) -> Result<CodexAccountView, String> {
        if api_key.trim().is_empty() {
            return Err("Enter an OpenAI API key.".to_string());
        }
        self.server
            .request("account/login/start", api_key_login_params(api_key))
            .await
            .map_err(|error| error.to_string())?;
        self.account(false).await
    }

    pub async fn logout(&self) -> Result<(), String> {
        self.server
            .request("account/logout", Value::Null)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub async fn models(&self) -> Result<Vec<CodexModelView>, String> {
        let mut models = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let value = self
                .server
                .model_list(cursor.as_deref(), Some(100), Some(false))
                .await
                .map_err(|error| error.to_string())?;
            let page = value
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| "Codex returned an invalid model catalogue.".to_string())?;
            models.extend(page.iter().filter_map(model_view));
            cursor = value
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        Ok(models)
    }

    pub async fn rate_limits(&self) -> Result<Value, String> {
        self.server
            .request("account/rateLimits/read", Value::Null)
            .await
            .map_err(|error| error.to_string())
    }

    pub(crate) async fn run_turn(
        self: &Arc<Self>,
        session_id: String,
        turn: PreparedTurn,
        settings: Settings,
    ) {
        let run_id = uuid::Uuid::new_v4().to_string();
        if let Err(message) = self
            .run_turn_inner(&run_id, &session_id, &turn, &settings)
            .await
        {
            self.pending_starts
                .lock()
                .await
                .retain(|_, pending| pending.run_id != run_id);
            let owned = {
                let mut active = self.active_by_session.lock().await;
                if active
                    .get(&session_id)
                    .is_some_and(|entry| entry.run_id == run_id)
                {
                    active.remove(&session_id);
                    true
                } else {
                    false
                }
            };
            if owned {
                self.sink.emit(
                    &session_channel(&session_id),
                    StreamEvent::Error {
                        message,
                        receipt: None,
                    },
                );
            }
        }
    }

    async fn run_turn_inner(
        &self,
        run_id: &str,
        session_id: &str,
        prepared_turn: &PreparedTurn,
        settings: &Settings,
    ) -> Result<(), String> {
        {
            let mut active = self.active_by_session.lock().await;
            if active.contains_key(session_id) {
                return Err("This conversation already has a Codex turn running.".to_string());
            }
            active.insert(
                session_id.to_string(),
                ActiveSessionTurn {
                    run_id: run_id.to_string(),
                    generation: None,
                    turn_id: None,
                },
            );
        }

        let account = self.account(false).await?;
        if !account.signed_in {
            return Err(
                "Sign in to ChatGPT or add an OpenAI API key in Settings before sending."
                    .to_string(),
            );
        }

        let session = self
            .db
            .codex_session_config(session_id)
            .map_err(|error| format!("Could not load this conversation: {error}"))?;
        let selected_model = session.model.as_deref().unwrap_or(&settings.model);
        let service_tier = self
            .service_tier_for_speed(selected_model, &settings.response_speed)
            .await?;
        let cwd = session
            .workspace
            .clone()
            .or_else(|| settings.workspace.clone());
        let generation = self
            .server
            .status()
            .await
            .generation
            .ok_or_else(|| "Codex app-server is not running.".to_string())?;
        if let Some(active) = self.active_by_session.lock().await.get_mut(session_id) {
            if active.run_id == run_id {
                active.generation = Some(generation);
            }
        }
        let thread_id = if let Some(thread_id) = session.codex_thread_id {
            self.register_root_route(session_id, &thread_id).await;
            let needs_resume = self
                .resumed_generation
                .lock()
                .await
                .get(&thread_id)
                .copied()
                != Some(generation);
            if needs_resume {
                let mut params = Map::new();
                params.insert("threadId".into(), Value::String(thread_id.clone()));
                insert_optional_string(&mut params, "cwd", cwd.as_deref());
                insert_optional_string(&mut params, "model", session.model.as_deref());
                let (approval, sandbox, reviewer) = codex_permissions(&settings.permission_mode);
                params.insert("approvalPolicy".into(), approval);
                params.insert("sandbox".into(), sandbox);
                if let Some(reviewer) = reviewer {
                    params.insert("approvalsReviewer".into(), Value::String(reviewer.into()));
                }
                let resumed = self
                    .server
                    .request("thread/resume", Value::Object(params))
                    .await
                    .map_err(|error| {
                        format!("Codex could not resume this conversation: {error}")
                    })?;
                self.reconcile_resumed_thread(session_id, &thread_id, &resumed)?;
                let current_generation =
                    self.server.status().await.generation.unwrap_or(generation);
                self.resumed_generation
                    .lock()
                    .await
                    .insert(thread_id.clone(), current_generation);
            }
            thread_id
        } else {
            let mut params = Map::new();
            enable_raw_thread_events(&mut params);
            insert_optional_string(&mut params, "cwd", cwd.as_deref());
            insert_optional_string(&mut params, "model", session.model.as_deref());
            let (approval, sandbox, reviewer) = codex_permissions(&settings.permission_mode);
            params.insert("approvalPolicy".into(), approval);
            params.insert("sandbox".into(), sandbox);
            if let Some(reviewer) = reviewer {
                params.insert("approvalsReviewer".into(), Value::String(reviewer.into()));
            }
            if let Some(service_tier) = service_tier.as_deref() {
                params.insert("serviceTier".into(), Value::String(service_tier.to_owned()));
            }
            let response = self
                .server
                .request("thread/start", Value::Object(params))
                .await
                .map_err(|error| format!("Codex could not start a conversation: {error}"))?;
            let started_thread = string_at(&response, &["thread", "id"])
                .ok_or_else(|| "Codex did not return a thread id.".to_string())?;
            let persisted = self
                .db
                .bind_codex_thread(session_id, &started_thread)
                .map_err(|error| format!("Could not save the Codex conversation id: {error}"))?;
            self.register_root_route(session_id, &persisted).await;
            let current_generation = self.server.status().await.generation.unwrap_or(generation);
            self.resumed_generation
                .lock()
                .await
                .insert(persisted.clone(), current_generation);
            persisted
        };

        let turn_generation =
            self.server.status().await.generation.ok_or_else(|| {
                "Codex app-server stopped before the turn could start.".to_string()
            })?;
        if let Some(active) = self.active_by_session.lock().await.get_mut(session_id) {
            if active.run_id == run_id {
                active.generation = Some(turn_generation);
            }
        }
        self.pending_starts.lock().await.insert(
            thread_id.clone(),
            PendingTurnStart {
                generation: turn_generation,
                run_id: run_id.to_string(),
                session_id: session_id.to_string(),
                thread_id: thread_id.clone(),
                text: prepared_turn.display_text.clone(),
                started_at_ms: db::now_ms(),
            },
        );

        let mut params = Map::new();
        params.insert("threadId".into(), Value::String(thread_id.clone()));
        params.insert("input".into(), Value::Array(prepared_turn.input.clone()));
        insert_optional_string(&mut params, "cwd", cwd.as_deref());
        insert_optional_string(&mut params, "model", session.model.as_deref());
        params.insert(
            "effort".into(),
            Value::String(settings.reasoning_effort.clone()),
        );
        let (approval, _, reviewer) = codex_permissions(&settings.permission_mode);
        params.insert("approvalPolicy".into(), approval);
        params.insert(
            "sandboxPolicy".into(),
            codex_sandbox_policy(&settings.permission_mode),
        );
        if let Some(reviewer) = reviewer {
            params.insert("approvalsReviewer".into(), Value::String(reviewer.into()));
        }
        if let Some(service_tier) = service_tier {
            params.insert("serviceTier".into(), Value::String(service_tier));
        }
        let response = self
            .server
            .request("turn/start", Value::Object(params))
            .await
            .map_err(|error| format!("Codex could not start the turn: {error}"))?;
        let turn_id = string_at(&response, &["turn", "id"])
            .ok_or_else(|| "Codex did not return a turn id.".to_string())?;
        let started_at_ms = response
            .pointer("/turn/startedAt")
            .and_then(Value::as_i64)
            .map(|seconds| seconds.saturating_mul(1000));
        self.activate_pending_turn(turn_generation, &thread_id, &turn_id, started_at_ms)
            .await?;
        Ok(())
    }

    pub async fn interrupt_session(&self, session_id: &str) -> Result<(), String> {
        let turn_id = self
            .active_by_session
            .lock()
            .await
            .get(session_id)
            .and_then(|active| active.turn_id.clone())
            .ok_or_else(|| "This conversation has no active Codex turn.".to_string())?;
        let thread_id = self
            .turns
            .lock()
            .await
            .get(&turn_id)
            .map(|turn| turn.thread_id.clone())
            .ok_or_else(|| "The active Codex turn is no longer available.".to_string())?;
        self.server
            .request(
                "turn/interrupt",
                json!({ "threadId": thread_id, "turnId": turn_id }),
            )
            .await
            .map(|_| ())
            .map_err(|error| format!("Codex could not interrupt the turn: {error}"))
    }

    pub async fn is_session_active(&self, session_id: &str) -> bool {
        self.active_by_session.lock().await.contains_key(session_id)
    }

    async fn service_tier_for_speed(
        &self,
        model_id: &str,
        response_speed: &str,
    ) -> Result<Option<String>, String> {
        if response_speed != "fast" {
            return Ok(None);
        }
        let models = self.models().await.map_err(|error| {
            format!("Codex could not validate Fast mode for {model_id}: {error}")
        })?;
        Ok(fast_service_tier_id(&models, model_id).map(str::to_owned))
    }

    /// Stop and reap the bundled Codex app-server. The transport applies its own
    /// short timeout so application exit and updater relaunch remain bounded.
    pub async fn shutdown(&self) {
        let event_pump = self.event_pump.lock().unwrap().take();
        if let Some(event_pump) = event_pump {
            event_pump.abort();
            let _ = event_pump.await;
        }
        self.server.shutdown().await;
    }

    pub async fn interrupt_agent(&self, agent_thread_id: &str) -> Result<(), String> {
        let turn_id = self
            .active_by_thread
            .lock()
            .await
            .get(agent_thread_id)
            .map(|active| active.turn_id.clone())
            .ok_or_else(|| "That Codex subagent is no longer running.".to_string())?;
        self.server
            .request(
                "turn/interrupt",
                json!({ "threadId": agent_thread_id, "turnId": turn_id }),
            )
            .await
            .map(|_| ())
            .map_err(|error| format!("Codex could not interrupt the subagent: {error}"))
    }

    pub async fn resolve_approval(
        &self,
        id: &str,
        allow: bool,
        for_session: bool,
    ) -> Result<(), String> {
        let request = self
            .pending_requests
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| "This Codex approval is no longer pending.".to_string())?;
        if allow && for_session && !approval_supports_session(&request.method, &request.params) {
            return Err("Codex did not offer a session-scoped decision for this approval.".into());
        }
        let result = match request.method.as_str() {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                let decision = if allow {
                    if for_session {
                        "acceptForSession"
                    } else {
                        "accept"
                    }
                } else {
                    "decline"
                };
                json!({ "decision": decision })
            }
            "item/permissions/requestApproval" => {
                let permissions = if allow {
                    request
                        .params
                        .get("permissions")
                        .cloned()
                        .unwrap_or_else(|| json!({}))
                } else {
                    json!({})
                };
                json!({
                    "permissions": permissions,
                    "scope": if for_session { "session" } else { "turn" },
                })
            }
            _ => return Err("This request is not an allow/deny approval.".to_string()),
        };
        self.server
            .send_response_result(request.generation, request.rpc_id, result)
            .await
            .map_err(|error| error.to_string())?;
        self.pending_requests.lock().await.remove(id);
        Ok(())
    }

    pub async fn resolve_codex_request(&self, id: &str, response: Value) -> Result<(), String> {
        let request = self
            .pending_requests
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| "This Codex request is no longer pending.".to_string())?;
        if !matches!(
            request.method.as_str(),
            "item/tool/requestUserInput" | "mcpServer/elicitation/request"
        ) {
            return Err("This Codex request cannot accept a structured response.".to_string());
        }
        let response = validate_structured_response(&request.method, &request.params, response)?;
        self.server
            .send_response_result(request.generation, request.rpc_id, response)
            .await
            .map_err(|error| error.to_string())?;
        self.pending_requests.lock().await.remove(id);
        Ok(())
    }

    fn reconcile_resumed_thread(
        &self,
        session_id: &str,
        thread_id: &str,
        response: &Value,
    ) -> Result<(), String> {
        let turns = response
            .pointer("/thread/turns")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for turn in turns {
            let Some(turn_id) = turn.get("id").and_then(Value::as_str) else {
                continue;
            };
            if self
                .db
                .turn_has_messages(session_id, turn_id)
                .map_err(|error| format!("Could not inspect resumed history: {error}"))?
            {
                continue;
            }
            let started_at_ms = turn
                .get("startedAt")
                .and_then(Value::as_i64)
                .and_then(|seconds| seconds.checked_mul(1000))
                .unwrap_or_else(db::now_ms);
            let mut user_text = Vec::new();
            let mut assistant_blocks = Vec::new();
            for item in turn
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                match item.get("type").and_then(Value::as_str) {
                    Some("userMessage") => {
                        if let Some(text) = user_message_text(item) {
                            user_text.push(text);
                        }
                    }
                    Some("agentMessage") => {
                        if let Some(text) = item
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|text| !text.is_empty())
                        {
                            assistant_blocks.push(Block::Text {
                                text: text.to_string(),
                            });
                        }
                    }
                    _ => {
                        if let Some((id, name, input)) = tool_use_from_item(item) {
                            let (output, is_error) = tool_result_from_item(item);
                            assistant_blocks.push(Block::ToolUse {
                                id: id.clone(),
                                name,
                                input,
                            });
                            assistant_blocks.push(Block::ToolResult {
                                tool_use_id: id,
                                content: output,
                                is_error,
                            });
                        }
                    }
                }
            }
            if !user_text.is_empty() {
                self.db
                    .try_append_message_for_turn(
                        session_id,
                        Some(turn_id),
                        &ChatMessage {
                            role: "user".to_string(),
                            content: vec![Block::Text {
                                text: user_text.join("\n"),
                            }],
                        },
                        started_at_ms,
                    )
                    .map_err(|error| format!("Could not restore a Codex user message: {error}"))?;
            }
            if !assistant_blocks.is_empty() {
                let completed_at_ms = turn
                    .get("completedAt")
                    .and_then(Value::as_i64)
                    .and_then(|seconds| seconds.checked_mul(1000))
                    .unwrap_or(started_at_ms);
                self.db
                    .try_append_message_for_turn(
                        session_id,
                        Some(turn_id),
                        &ChatMessage {
                            role: "assistant".to_string(),
                            content: assistant_blocks,
                        },
                        completed_at_ms,
                    )
                    .map_err(|error| {
                        format!("Could not restore a Codex assistant message: {error}")
                    })?;
            }
            let _ = self.db.append_codex_activity(
                session_id,
                thread_id,
                Some(turn_id),
                None,
                "thread/resume/history",
                &turn,
                None,
                started_at_ms,
            );
        }
        Ok(())
    }

    async fn register_root_route(&self, session_id: &str, thread_id: &str) {
        self.routes.write().await.insert(
            thread_id.to_string(),
            ThreadRoute {
                session_id: session_id.to_string(),
                root_thread_id: thread_id.to_string(),
                is_subagent: false,
            },
        );
        self.drain_deferred(thread_id).await;
    }

    async fn activate_pending_turn(
        &self,
        generation: u64,
        thread_id: &str,
        turn_id: &str,
        started_at_ms: Option<i64>,
    ) -> Result<(), String> {
        if let Some(existing) = self.turns.lock().await.get(turn_id) {
            return if existing.generation == generation {
                Ok(())
            } else {
                Err("Codex reused a turn id across process generations.".to_string())
            };
        }
        let pending = {
            let mut starts = self.pending_starts.lock().await;
            let Some(pending) = starts.get(thread_id) else {
                return Err("Codex started an unrecognized turn.".to_string());
            };
            if pending.generation != generation {
                // A final frame from an expired process must never consume the
                // replacement generation's pending turn on the same thread.
                return Ok(());
            }
            starts
                .remove(thread_id)
                .expect("pending turn was inspected while holding the same lock")
        };
        let started_at_ms = started_at_ms.unwrap_or(pending.started_at_ms);
        let user = ChatMessage {
            role: "user".into(),
            content: vec![Block::Text {
                text: pending.text.clone(),
            }],
        };
        self.db
            .try_append_message_for_turn(&pending.session_id, Some(turn_id), &user, started_at_ms)
            .map_err(|error| format!("Could not persist the user message: {error}"))?;
        self.db.touch_session(&pending.session_id, started_at_ms);
        self.db
            .set_title_if_blank(&pending.session_id, &derive_title(&pending.text));
        self.turns.lock().await.insert(
            turn_id.to_string(),
            TurnProjection::new(
                generation,
                pending.session_id.clone(),
                pending.thread_id.clone(),
                turn_id.to_string(),
            ),
        );
        if let Some(active) = self
            .active_by_session
            .lock()
            .await
            .get_mut(&pending.session_id)
        {
            if active.run_id == pending.run_id {
                active.generation = Some(generation);
                active.turn_id = Some(turn_id.to_string());
            }
        }
        self.active_by_thread.lock().await.insert(
            thread_id.to_string(),
            ActiveThreadTurn {
                generation,
                turn_id: turn_id.to_string(),
            },
        );
        self.sink.emit(
            &session_channel(&pending.session_id),
            StreamEvent::TurnStart {
                message_id: turn_id.to_string(),
                turn_id: Some(turn_id.to_string()),
                started_at: Some(started_at_ms),
            },
        );
        Ok(())
    }

    async fn handle_incoming(&self, incoming: Incoming) {
        if let Some(thread_id) = incoming_thread_id(&incoming) {
            if !self.routes.read().await.contains_key(&thread_id) {
                if let Incoming::Notification { method, params, .. } = &incoming {
                    if method == "thread/started" {
                        if let Some(parent_id) = string_at(params, &["thread", "parentThreadId"]) {
                            if let Some(parent) = self.routes.read().await.get(&parent_id).cloned()
                            {
                                self.routes.write().await.insert(
                                    thread_id.clone(),
                                    ThreadRoute {
                                        session_id: parent.session_id.clone(),
                                        root_thread_id: parent.root_thread_id,
                                        is_subagent: true,
                                    },
                                );
                                self.sink.emit(
                                    &session_channel(&parent.session_id),
                                    StreamEvent::AgentStarted {
                                        agent_id: thread_id.clone(),
                                        description: "Codex subagent".to_string(),
                                        parent_id: if parent.is_subagent {
                                            Some(parent_id)
                                        } else {
                                            None
                                        },
                                    },
                                );
                            }
                        }
                    }
                }
            }
            if !self.routes.read().await.contains_key(&thread_id) {
                let mut deferred = self.deferred_by_thread.lock().await;
                if deferred.len() < 128 || deferred.contains_key(&thread_id) {
                    let queue = deferred.entry(thread_id).or_default();
                    if queue.len() < 512 {
                        queue.push(incoming);
                    }
                }
                return;
            }
        }
        self.dispatch_incoming(incoming).await;
    }

    async fn dispatch_incoming(&self, incoming: Incoming) {
        match incoming {
            Incoming::Notification {
                generation,
                method,
                params,
                raw,
            } => {
                self.handle_notification(generation, &method, params, raw)
                    .await
            }
            Incoming::ServerRequest {
                generation,
                id,
                method,
                params,
                raw,
            } => {
                self.handle_server_request(generation, id, &method, params, raw)
                    .await
            }
            Incoming::TransportClosed { generation, reason } => {
                self.handle_transport_closed(generation, &reason).await
            }
        }
    }

    async fn drain_deferred(&self, thread_id: &str) {
        let queued = self.deferred_by_thread.lock().await.remove(thread_id);
        for incoming in queued.into_iter().flatten() {
            Box::pin(self.dispatch_incoming(incoming)).await;
        }
    }

    async fn handle_notification(&self, generation: u64, method: &str, params: Value, raw: Value) {
        if method == "account/login/completed" {
            if let Some(login_id) = params.get("loginId").and_then(Value::as_str) {
                let result = if params.get("success").and_then(Value::as_bool) == Some(true) {
                    Ok(())
                } else {
                    Err(params
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("ChatGPT sign-in failed.")
                        .to_string())
                };
                self.login_results
                    .lock()
                    .await
                    .insert(login_id.to_string(), result);
            }
        }
        let thread_id = extract_thread_id(&params);
        let route = match thread_id.as_deref() {
            Some(thread_id) => self.routes.read().await.get(thread_id).cloned(),
            None => None,
        };
        if let Some(route) = route.as_ref() {
            self.record_raw(route, method, &params, None, &raw).await;
        }

        match method {
            "turn/started" => {
                let Some(thread_id) = thread_id else { return };
                let Some(turn_id) = string_at(&params, &["turn", "id"]) else {
                    return;
                };
                self.active_by_thread.lock().await.insert(
                    thread_id.clone(),
                    ActiveThreadTurn {
                        generation,
                        turn_id: turn_id.clone(),
                    },
                );
                if route.as_ref().is_some_and(|route| !route.is_subagent) {
                    let started = params
                        .pointer("/turn/startedAt")
                        .and_then(Value::as_i64)
                        .map(|seconds| seconds.saturating_mul(1000));
                    let _ = self
                        .activate_pending_turn(generation, &thread_id, &turn_id, started)
                        .await;
                }
            }
            "item/agentMessage/delta" => {
                let Some(route) = route.filter(|route| !route.is_subagent) else {
                    return;
                };
                let Some(turn_id) = string_at(&params, &["turnId"]) else {
                    return;
                };
                let Some(item_id) = string_at(&params, &["itemId"]) else {
                    return;
                };
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if delta.is_empty() {
                    return;
                }
                let mut turns = self.turns.lock().await;
                let Some(turn) = turns.get_mut(&turn_id) else {
                    return;
                };
                turn.ensure_ordered(&item_id);
                match turn.items.entry(item_id) {
                    std::collections::hash_map::Entry::Occupied(mut entry) => {
                        if let ProjectedItem::Text(text) = entry.get_mut() {
                            text.push_str(delta);
                        }
                    }
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert(ProjectedItem::Text(delta.to_string()));
                    }
                }
                drop(turns);
                self.sink.emit(
                    &session_channel(&route.session_id),
                    StreamEvent::TextDelta {
                        text: delta.to_string(),
                    },
                );
            }
            "item/started" => {
                if let Some(route) = route {
                    self.project_item_started(&route, &params).await;
                }
            }
            "item/completed" => {
                if let Some(route) = route {
                    self.project_item_completed(&route, &params).await;
                }
            }
            "thread/tokenUsage/updated" => {
                if let Some(route) = route {
                    self.project_usage(generation, &route, &params).await;
                }
            }
            "serverRequest/resolved" => {
                self.clear_resolved_request(&params).await;
            }
            "turn/completed" => {
                if let Some(route) = route {
                    self.complete_turn(generation, &route, &params).await;
                }
            }
            _ => {}
        }
    }

    async fn handle_server_request(
        &self,
        generation: u64,
        rpc_id: Value,
        method: &str,
        params: Value,
        raw: Value,
    ) {
        if method == "currentTime/read" {
            let _ = self
                .server
                .send_response_result(
                    generation,
                    rpc_id,
                    json!({ "currentTimeAt": db::now_ms().div_euclid(1000) }),
                )
                .await;
            return;
        }
        let route = if let Some(thread_id) = extract_thread_id(&params) {
            self.routes.read().await.get(&thread_id).cloned()
        } else {
            None
        };
        let Some(route) = route else {
            let _ = self
                .server
                .send_response_error(generation, rpc_id, -32602, "Unknown Codex thread", None)
                .await;
            return;
        };
        self.record_raw(&route, method, &params, Some(&rpc_id), &raw)
            .await;

        let approval = matches!(
            method,
            "item/commandExecution/requestApproval"
                | "item/fileChange/requestApproval"
                | "item/permissions/requestApproval"
        );
        let structured = matches!(
            method,
            "item/tool/requestUserInput" | "mcpServer/elicitation/request"
        );
        if !approval && !structured {
            let _ = self
                .server
                .send_response_error(
                    generation,
                    rpc_id,
                    -32601,
                    "Portcode does not provide this client capability",
                    None,
                )
                .await;
            return;
        }

        let id = uuid::Uuid::new_v4().to_string();
        self.pending_requests.lock().await.insert(
            id.clone(),
            PendingServerRequest {
                generation,
                rpc_id,
                method: method.to_string(),
                params: params.clone(),
                session_id: route.session_id.clone(),
            },
        );
        if approval {
            let (tool, summary, input, diff) = approval_presentation(method, &params);
            self.sink.emit(
                &session_channel(&route.session_id),
                StreamEvent::PermissionRequest {
                    id,
                    tool,
                    risk: portcode_sync::wire::PermissionRisk::Configurable,
                    summary,
                    input,
                    diff,
                },
            );
        } else {
            self.sink.emit_local(
                &session_channel(&route.session_id),
                StreamEvent::CodexRequest {
                    id,
                    method: method.to_string(),
                    params,
                },
            );
        }
    }

    async fn clear_resolved_request(&self, params: &Value) {
        let Some(rpc_id) = params.get("requestId") else {
            return;
        };
        let resolved = {
            let mut pending = self.pending_requests.lock().await;
            let key = pending
                .iter()
                .find(|(_, request)| &request.rpc_id == rpc_id)
                .map(|(id, _)| id.clone());
            key.and_then(|id| pending.remove(&id).map(|request| (id, request)))
        };
        if let Some((id, request)) = resolved {
            self.sink.emit_local(
                &session_channel(&request.session_id),
                StreamEvent::CodexRequest {
                    id,
                    method: "serverRequest/resolved".to_string(),
                    params: params.clone(),
                },
            );
        }
    }

    async fn record_raw(
        &self,
        route: &ThreadRoute,
        method: &str,
        params: &Value,
        request_id: Option<&Value>,
        _raw: &Value,
    ) {
        let thread_id = extract_thread_id(params).unwrap_or_else(|| route.root_thread_id.clone());
        let turn_id = extract_turn_id(params);
        let item_id = extract_item_id(params);
        let emitted_at_ms = event_timestamp_ms(method, params).unwrap_or_else(db::now_ms);
        let Ok(sequence) = self.db.append_codex_activity(
            &route.session_id,
            &thread_id,
            turn_id.as_deref(),
            item_id.as_deref(),
            method,
            params,
            request_id,
            emitted_at_ms,
        ) else {
            return;
        };
        self.sink.emit_local(
            &session_channel(&route.session_id),
            StreamEvent::CodexEvent {
                sequence,
                method: method.to_string(),
                params: params.clone(),
                request_id: request_id.cloned(),
                thread_id: Some(thread_id),
                turn_id,
                item_id,
                emitted_at_ms,
            },
        );
    }

    async fn project_item_started(&self, route: &ThreadRoute, params: &Value) {
        let Some(turn_id) = string_at(params, &["turnId"]) else {
            return;
        };
        let Some(item) = params.get("item") else {
            return;
        };
        match item.get("type").and_then(Value::as_str) {
            Some("collabAgentToolCall") => self.register_collab_routes(route, item).await,
            Some("subAgentActivity") => self.project_subagent_activity(route, params, item).await,
            _ => {}
        }
        if route.is_subagent {
            return;
        }
        let Some((id, name, input)) = tool_use_from_item(item) else {
            return;
        };
        let mut turns = self.turns.lock().await;
        let Some(turn) = turns.get_mut(&turn_id) else {
            return;
        };
        turn.ensure_ordered(&id);
        if turn.items.contains_key(&id) {
            return;
        }
        turn.items.insert(
            id.clone(),
            ProjectedItem::Tool {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
                output: None,
            },
        );
        drop(turns);
        self.sink.emit(
            &session_channel(&route.session_id),
            StreamEvent::ToolUse { id, name, input },
        );
    }

    async fn project_item_completed(&self, route: &ThreadRoute, params: &Value) {
        let Some(turn_id) = string_at(params, &["turnId"]) else {
            return;
        };
        let Some(item) = params.get("item") else {
            return;
        };
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
        if item_type == "collabAgentToolCall" {
            self.register_collab_routes(route, item).await;
            self.project_collab_status(route, item);
        } else if item_type == "subAgentActivity" {
            self.project_subagent_activity(route, params, item).await;
        }
        if route.is_subagent {
            return;
        }
        let item_id = item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if item_id.is_empty() {
            return;
        }
        if item_type == "agentMessage" {
            let final_text = item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let mut turns = self.turns.lock().await;
            let Some(turn) = turns.get_mut(&turn_id) else {
                return;
            };
            turn.ensure_ordered(&item_id);
            let delta = match turn.items.get(&item_id) {
                Some(ProjectedItem::Text(current)) if final_text.starts_with(current) => {
                    final_text[current.len()..].to_string()
                }
                Some(ProjectedItem::Text(_)) => String::new(),
                _ => final_text.clone(),
            };
            turn.items.insert(item_id, ProjectedItem::Text(final_text));
            drop(turns);
            if !delta.is_empty() {
                self.sink.emit(
                    &session_channel(&route.session_id),
                    StreamEvent::TextDelta { text: delta },
                );
            }
            return;
        }
        let Some((id, name, input)) = tool_use_from_item(item) else {
            return;
        };
        let (output, is_error) = tool_result_from_item(item);
        let mut turns = self.turns.lock().await;
        let Some(turn) = turns.get_mut(&turn_id) else {
            return;
        };
        turn.ensure_ordered(&id);
        let emit_use = !turn.items.contains_key(&id);
        turn.items.insert(
            id.clone(),
            ProjectedItem::Tool {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
                output: Some((output.clone(), is_error)),
            },
        );
        drop(turns);
        if emit_use {
            self.sink.emit(
                &session_channel(&route.session_id),
                StreamEvent::ToolUse {
                    id: id.clone(),
                    name,
                    input,
                },
            );
        }
        self.sink.emit(
            &session_channel(&route.session_id),
            StreamEvent::ToolResult {
                id,
                output,
                is_error,
            },
        );
    }

    async fn register_collab_routes(&self, route: &ThreadRoute, item: &Value) {
        let receivers = item
            .get("receiverThreadIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if receivers.is_empty() {
            return;
        }
        let description = item
            .get("prompt")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("Codex subagent")
            .to_string();
        let parent_id = item
            .get("senderThreadId")
            .and_then(Value::as_str)
            .filter(|sender| *sender != route.root_thread_id)
            .map(str::to_owned);
        let mut routes = self.routes.write().await;
        let mut added = Vec::new();
        for receiver in &receivers {
            let newly_registered = !routes.contains_key(receiver);
            routes.insert(
                receiver.clone(),
                ThreadRoute {
                    session_id: route.session_id.clone(),
                    root_thread_id: route.root_thread_id.clone(),
                    is_subagent: true,
                },
            );
            if newly_registered {
                self.sink.emit(
                    &session_channel(&route.session_id),
                    StreamEvent::AgentStarted {
                        agent_id: receiver.clone(),
                        description: description.clone(),
                        parent_id: parent_id.clone(),
                    },
                );
                added.push(receiver.clone());
            }
        }
        drop(routes);
        for receiver in added {
            self.drain_deferred(&receiver).await;
        }
    }

    async fn project_subagent_activity(&self, route: &ThreadRoute, params: &Value, item: &Value) {
        let Some(agent_id) = item.get("agentThreadId").and_then(Value::as_str) else {
            return;
        };
        let parent_thread_id =
            extract_thread_id(params).filter(|thread_id| thread_id != &route.root_thread_id);
        let newly_registered = {
            let mut routes = self.routes.write().await;
            let is_new = !routes.contains_key(agent_id);
            routes.insert(
                agent_id.to_string(),
                ThreadRoute {
                    session_id: route.session_id.clone(),
                    root_thread_id: route.root_thread_id.clone(),
                    is_subagent: true,
                },
            );
            is_new
        };
        let kind = item
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("interacted");
        match kind {
            "started" => self.sink.emit(
                &session_channel(&route.session_id),
                StreamEvent::AgentStarted {
                    agent_id: agent_id.to_string(),
                    description: item
                        .get("agentPath")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex subagent")
                        .to_string(),
                    parent_id: parent_thread_id,
                },
            ),
            "interrupted" => self.sink.emit(
                &session_channel(&route.session_id),
                StreamEvent::AgentFinished {
                    agent_id: agent_id.to_string(),
                    status: "cancelled".to_string(),
                },
            ),
            _ => self.sink.emit(
                &session_channel(&route.session_id),
                StreamEvent::AgentProgress {
                    agent_id: agent_id.to_string(),
                    step: 1,
                },
            ),
        }
        if newly_registered {
            self.drain_deferred(agent_id).await;
        }
    }

    fn project_collab_status(&self, route: &ThreadRoute, item: &Value) {
        let Some(states) = item.get("agentsStates").and_then(Value::as_object) else {
            return;
        };
        for (agent_id, state) in states {
            let status = state
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("running");
            let terminal = match status {
                "completed" | "shutdown" => Some("ok"),
                "interrupted" => Some("cancelled"),
                "errored" | "notFound" => Some("error"),
                _ => None,
            };
            if let Some(status) = terminal {
                self.sink.emit(
                    &session_channel(&route.session_id),
                    StreamEvent::AgentFinished {
                        agent_id: agent_id.clone(),
                        status: status.to_string(),
                    },
                );
            } else {
                self.sink.emit(
                    &session_channel(&route.session_id),
                    StreamEvent::AgentProgress {
                        agent_id: agent_id.clone(),
                        step: 1,
                    },
                );
            }
        }
    }

    async fn project_usage(&self, generation: u64, route: &ThreadRoute, params: &Value) {
        let Some(turn_id) = string_at(params, &["turnId"]) else {
            return;
        };
        let input = params
            .pointer("/tokenUsage/last/inputTokens")
            .and_then(Value::as_u64)
            .unwrap_or_default()
            .min(u64::from(u32::MAX)) as u32;
        let output = params
            .pointer("/tokenUsage/last/outputTokens")
            .and_then(Value::as_u64)
            .unwrap_or_default()
            .min(u64::from(u32::MAX)) as u32;
        let thread_id = extract_thread_id(params).unwrap_or_else(|| route.root_thread_id.clone());
        let key = (generation, thread_id, turn_id);
        let mut usage = self.usage_by_turn.lock().await;
        let previous = usage.entry(key).or_default();
        let input_delta = input.saturating_sub(previous.0);
        let output_delta = output.saturating_sub(previous.1);
        previous.0 = previous.0.max(input);
        previous.1 = previous.1.max(output);
        drop(usage);
        if input_delta == 0 && output_delta == 0 {
            return;
        }
        let _ = self.db.add_usage(
            &route.session_id,
            i64::from(input_delta),
            i64::from(output_delta),
            db::now_ms(),
        );
        self.sink.emit(
            &session_channel(&route.session_id),
            StreamEvent::Usage {
                input_tokens: input_delta,
                output_tokens: output_delta,
            },
        );
    }

    async fn complete_turn(&self, generation: u64, route: &ThreadRoute, params: &Value) {
        let Some(turn_id) =
            string_at(params, &["turn", "id"]).or_else(|| string_at(params, &["turnId"]))
        else {
            return;
        };
        if let Some(thread_id) = extract_thread_id(params) {
            self.usage_by_turn
                .lock()
                .await
                .remove(&(generation, thread_id, turn_id.clone()));
        }
        let completed_thread_id =
            extract_thread_id(params).unwrap_or_else(|| route.root_thread_id.clone());
        {
            let mut active = self.active_by_thread.lock().await;
            if active
                .get(&completed_thread_id)
                .is_some_and(|entry| entry.generation == generation && entry.turn_id == turn_id)
            {
                active.remove(&completed_thread_id);
            }
        }
        if route.is_subagent {
            let status = params
                .pointer("/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            self.sink.emit(
                &session_channel(&route.session_id),
                StreamEvent::AgentFinished {
                    agent_id: extract_thread_id(params).unwrap_or_default(),
                    status: match status {
                        "interrupted" => "cancelled",
                        "failed" => "error",
                        _ => "ok",
                    }
                    .to_string(),
                },
            );
            return;
        }
        let turn = {
            let mut turns = self.turns.lock().await;
            if turns
                .get(&turn_id)
                .is_none_or(|turn| turn.generation != generation)
            {
                return;
            }
            turns
                .remove(&turn_id)
                .expect("turn generation was checked while holding the same lock")
        };
        {
            let mut active = self.active_by_session.lock().await;
            if active.get(&turn.session_id).is_some_and(|entry| {
                entry.generation == Some(generation)
                    && entry.turn_id.as_deref() == Some(turn.turn_id.as_str())
            }) {
                active.remove(&turn.session_id);
            }
        }
        let status = params
            .pointer("/turn/status")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        let blocks = turn.blocks();
        if !blocks.is_empty() {
            let assistant = ChatMessage {
                role: "assistant".into(),
                content: blocks,
            };
            let _ = self.db.try_append_message_for_turn(
                &turn.session_id,
                Some(&turn.turn_id),
                &assistant,
                db::now_ms(),
            );
        }
        match status {
            "failed" => {
                let message = params
                    .pointer("/turn/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex turn failed.")
                    .to_string();
                self.sink.emit(
                    &session_channel(&turn.session_id),
                    StreamEvent::Error {
                        message,
                        receipt: None,
                    },
                );
            }
            "interrupted" => self.sink.emit(
                &session_channel(&turn.session_id),
                StreamEvent::TurnEnd {
                    stop_reason: "cancelled".into(),
                    receipt: None,
                },
            ),
            _ => self.sink.emit(
                &session_channel(&turn.session_id),
                StreamEvent::TurnEnd {
                    stop_reason: "end_turn".into(),
                    receipt: None,
                },
            ),
        }
    }

    async fn handle_transport_closed(&self, generation: u64, reason: &str) {
        let mut affected_sessions = std::collections::HashSet::new();

        let expired_starts = {
            let mut starts = self.pending_starts.lock().await;
            let keys = starts
                .iter()
                .filter_map(|(thread_id, pending)| {
                    (pending.generation == generation).then_some(thread_id.clone())
                })
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|thread_id| starts.remove(&thread_id))
                .collect::<Vec<_>>()
        };
        affected_sessions.extend(
            expired_starts
                .iter()
                .map(|pending| pending.session_id.clone()),
        );

        let expired_turns = {
            let mut turns = self.turns.lock().await;
            let ids = turns
                .iter()
                .filter_map(|(turn_id, turn)| {
                    (turn.generation == generation).then_some(turn_id.clone())
                })
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|turn_id| turns.remove(&turn_id))
                .collect::<Vec<_>>()
        };
        affected_sessions.extend(expired_turns.iter().map(|turn| turn.session_id.clone()));

        let expired_threads = {
            let mut active = self.active_by_thread.lock().await;
            let ids = active
                .iter()
                .filter_map(|(thread_id, turn)| {
                    (turn.generation == generation).then_some(thread_id.clone())
                })
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|thread_id| active.remove(&thread_id).map(|turn| (thread_id, turn)))
                .collect::<Vec<_>>()
        };

        let expired_requests = {
            let mut requests = self.pending_requests.lock().await;
            let ids = requests
                .iter()
                .filter_map(|(id, request)| {
                    (request.generation == generation).then_some(id.clone())
                })
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| requests.remove(&id).map(|request| (id, request)))
                .collect::<Vec<_>>()
        };
        affected_sessions.extend(
            expired_requests
                .iter()
                .map(|(_, request)| request.session_id.clone()),
        );

        self.resumed_generation
            .lock()
            .await
            .retain(|_, resumed| *resumed != generation);
        self.usage_by_turn
            .lock()
            .await
            .retain(|(event_generation, _, _), _| *event_generation != generation);
        {
            let mut deferred = self.deferred_by_thread.lock().await;
            deferred.retain(|_, queue| {
                queue.retain(|incoming| incoming_generation(incoming) != generation);
                !queue.is_empty()
            });
        }
        let protected_sessions = {
            let mut active = self.active_by_session.lock().await;
            let protected = active
                .iter()
                .filter_map(|(session_id, entry)| {
                    (entry.generation != Some(generation)).then_some(session_id.clone())
                })
                .collect::<std::collections::HashSet<_>>();
            active.retain(|session_id, entry| {
                let keep = entry.generation != Some(generation);
                if !keep {
                    affected_sessions.insert(session_id.clone());
                }
                keep
            });
            protected
        };

        for (id, request) in expired_requests {
            self.sink.emit_local(
                &session_channel(&request.session_id),
                StreamEvent::CodexRequest {
                    id,
                    method: "serverRequest/resolved".to_string(),
                    params: json!({ "reason": "transportClosed" }),
                },
            );
        }

        let routes = self.routes.read().await;
        for (thread_id, _) in expired_threads {
            if let Some(route) = routes.get(&thread_id) {
                affected_sessions.insert(route.session_id.clone());
                if route.is_subagent {
                    self.sink.emit(
                        &session_channel(&route.session_id),
                        StreamEvent::AgentFinished {
                            agent_id: thread_id,
                            status: "error".to_string(),
                        },
                    );
                }
            }
        }
        drop(routes);

        for session_id in affected_sessions {
            if protected_sessions.contains(&session_id) {
                continue;
            }
            self.sink.emit(
                &session_channel(&session_id),
                StreamEvent::Error {
                    message: format!(
                        "The Codex engine stopped unexpectedly ({reason}). A new turn will restart it."
                    ),
                    receipt: None,
                },
            );
        }
    }

    fn emit_bridge_warning(&self, message: String) {
        if let Ok(routes) = self.routes.try_read() {
            let mut seen = std::collections::HashSet::new();
            for route in routes.values() {
                if seen.insert(route.session_id.clone()) {
                    self.sink.emit_local(
                        &session_channel(&route.session_id),
                        StreamEvent::CodexEvent {
                            sequence: -db::now_ms(),
                            method: "portcode/codexBridge/warning".into(),
                            params: json!({ "message": message }),
                            request_id: None,
                            thread_id: Some(route.root_thread_id.clone()),
                            turn_id: None,
                            item_id: None,
                            emitted_at_ms: db::now_ms(),
                        },
                    );
                }
            }
        }
    }
}

fn incoming_thread_id(incoming: &Incoming) -> Option<String> {
    match incoming {
        Incoming::Notification { params, .. } | Incoming::ServerRequest { params, .. } => {
            extract_thread_id(params)
        }
        Incoming::TransportClosed { .. } => None,
    }
}

fn incoming_generation(incoming: &Incoming) -> u64 {
    match incoming {
        Incoming::Notification { generation, .. }
        | Incoming::ServerRequest { generation, .. }
        | Incoming::TransportClosed { generation, .. } => *generation,
    }
}

fn event_timestamp_ms(method: &str, params: &Value) -> Option<i64> {
    for key in ["completedAtMs", "startedAtMs", "updatedAtMs", "createdAtMs"] {
        if let Some(value) = params.get(key).and_then(Value::as_i64) {
            return Some(value);
        }
        if let Some(value) = params
            .get("item")
            .and_then(|item| item.get(key))
            .and_then(Value::as_i64)
        {
            return Some(value);
        }
    }
    let second_keys: &[&str] = if method.starts_with("turn/") {
        &["completedAt", "startedAt"]
    } else if method.starts_with("thread/") {
        &["updatedAt", "createdAt"]
    } else {
        &[]
    };
    for key in second_keys {
        if let Some(value) = params
            .get("turn")
            .or_else(|| params.get("thread"))
            .and_then(|container| container.get(*key))
            .and_then(Value::as_i64)
        {
            return value.checked_mul(1000);
        }
    }
    None
}

fn validate_structured_response(
    method: &str,
    request_params: &Value,
    response: Value,
) -> Result<Value, String> {
    match method {
        "item/tool/requestUserInput" => {
            let answers = response
                .get("answers")
                .and_then(Value::as_object)
                .ok_or_else(|| "Codex answers must be keyed by question id.".to_string())?;
            let known = request_params
                .get("questions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|question| question.get("id").and_then(Value::as_str))
                .collect::<std::collections::HashSet<_>>();
            let mut clean = Map::new();
            for (question_id, value) in answers {
                if !known.is_empty() && !known.contains(question_id.as_str()) {
                    return Err("A Codex answer referenced an unknown question.".to_string());
                }
                let values = value
                    .get("answers")
                    .and_then(Value::as_array)
                    .ok_or_else(|| "Each Codex answer must contain a string list.".to_string())?;
                if !values.iter().all(Value::is_string) {
                    return Err("Codex answers must contain only strings.".to_string());
                }
                clean.insert(question_id.clone(), json!({ "answers": values }));
            }
            Ok(json!({ "answers": clean }))
        }
        "mcpServer/elicitation/request" => {
            let action = response
                .get("action")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    "Choose whether to accept, decline, or cancel the MCP request.".to_string()
                })?;
            if !matches!(action, "accept" | "decline" | "cancel") {
                return Err("Unknown MCP elicitation action.".to_string());
            }
            let mut clean = Map::new();
            clean.insert("action".into(), Value::String(action.to_string()));
            if action == "accept" {
                if let Some(content) = response.get("content") {
                    clean.insert("content".into(), content.clone());
                }
            } else {
                clean.insert("content".into(), Value::Null);
            }
            if let Some(meta) = response.get("_meta") {
                clean.insert("_meta".into(), meta.clone());
            }
            Ok(Value::Object(clean))
        }
        _ => Err("This Codex request cannot accept a structured response.".to_string()),
    }
}

fn account_view(value: &Value) -> CodexAccountView {
    let account = value.get("account").filter(|value| !value.is_null());
    let auth_mode = account
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    CodexAccountView {
        signed_in: account.is_some(),
        auth_mode,
        account: account
            .and_then(|value| value.get("email"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        tier: account
            .and_then(|value| value.get("planType"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

fn api_key_login_params(api_key: String) -> Value {
    json!({ "type": "apiKey", "apiKey": api_key })
}

fn model_view(value: &Value) -> Option<CodexModelView> {
    let id = value.get("id")?.as_str()?.to_owned();
    let efforts = value
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|effort| effort.get("reasoningEffort").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let service_tiers = value
        .get("serviceTiers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tier| {
            Some(CodexServiceTierView {
                id: tier.get("id")?.as_str()?.to_owned(),
                name: tier.get("name")?.as_str()?.to_owned(),
                description: tier
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            })
        })
        .collect();
    Some(CodexModelView {
        label: value
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_owned(),
        default_reasoning_effort: value
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .unwrap_or("medium")
            .to_owned(),
        id,
        reasoning_efforts: efforts,
        service_tiers,
    })
}

fn fast_service_tier_id<'a>(models: &'a [CodexModelView], model_id: &str) -> Option<&'a str> {
    models
        .iter()
        .find(|model| model.id == model_id)?
        .service_tiers
        .iter()
        .find(|tier| {
            tier.name.eq_ignore_ascii_case("fast") || tier.id.eq_ignore_ascii_case("priority")
        })
        .map(|tier| tier.id.as_str())
}

fn codex_permissions(
    mode: &crate::permissions::PermissionMode,
) -> (Value, Value, Option<&'static str>) {
    use crate::permissions::PermissionMode;
    match mode {
        PermissionMode::Bypass => (json!("never"), json!("danger-full-access"), None),
        PermissionMode::Plan => (json!("never"), json!("read-only"), None),
        PermissionMode::Auto => (
            json!("on-request"),
            json!("workspace-write"),
            Some("auto_review"),
        ),
        PermissionMode::AcceptEdits => (json!("on-request"), json!("workspace-write"), None),
        PermissionMode::Default => (json!("untrusted"), json!("workspace-write"), None),
    }
}

fn codex_sandbox_policy(mode: &crate::permissions::PermissionMode) -> Value {
    use crate::permissions::PermissionMode;
    match mode {
        PermissionMode::Bypass => json!({ "type": "dangerFullAccess" }),
        PermissionMode::Plan => json!({ "type": "readOnly", "networkAccess": false }),
        PermissionMode::Default | PermissionMode::AcceptEdits | PermissionMode::Auto => json!({
            "type": "workspaceWrite",
            "writableRoots": [],
            "networkAccess": false,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false,
        }),
    }
}

fn insert_optional_string(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        map.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn enable_raw_thread_events(params: &mut Map<String, Value>) {
    params.insert("experimentalRawEvents".into(), Value::Bool(true));
}

fn session_channel(session_id: &str) -> String {
    format!("agent://{session_id}")
}

fn derive_title(text: &str) -> String {
    let title = text
        .split_whitespace()
        .take(7)
        .collect::<Vec<_>>()
        .join(" ");
    if title.chars().count() > 64 {
        title.chars().take(61).collect::<String>() + "..."
    } else if title.is_empty() {
        "New chat".into()
    } else {
        title
    }
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut cursor = value;
    for part in path {
        cursor = cursor.get(*part)?;
    }
    cursor.as_str().map(str::to_owned)
}

fn extract_thread_id(params: &Value) -> Option<String> {
    string_at(params, &["threadId"])
        .or_else(|| string_at(params, &["thread", "id"]))
        .or_else(|| string_at(params, &["item", "senderThreadId"]))
}

fn extract_turn_id(params: &Value) -> Option<String> {
    string_at(params, &["turnId"]).or_else(|| string_at(params, &["turn", "id"]))
}

fn extract_item_id(params: &Value) -> Option<String> {
    string_at(params, &["itemId"]).or_else(|| string_at(params, &["item", "id"]))
}

fn tool_use_from_item(item: &Value) -> Option<(String, String, Value)> {
    let id = item.get("id")?.as_str()?.to_owned();
    let item_type = item.get("type")?.as_str()?;
    let name = match item_type {
        "commandExecution" => "run_command".to_string(),
        "fileChange" => "edit_file".to_string(),
        "mcpToolCall" => format!(
            "mcp:{}/{}",
            item.get("server")
                .and_then(Value::as_str)
                .unwrap_or("server"),
            item.get("tool").and_then(Value::as_str).unwrap_or("tool")
        ),
        "dynamicToolCall" => format!(
            "{}{}{}",
            item.get("namespace")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            if item.get("namespace").and_then(Value::as_str).is_some() {
                ":"
            } else {
                ""
            },
            item.get("tool").and_then(Value::as_str).unwrap_or("tool")
        ),
        "collabAgentToolCall" => "delegate_task".to_string(),
        "subAgentActivity" => "subagent_activity".to_string(),
        "webSearch" => "web_search".to_string(),
        "imageView" => "view_image".to_string(),
        "imageGeneration" => "image_generation".to_string(),
        "sleep" => "sleep".to_string(),
        "enteredReviewMode" | "exitedReviewMode" => "review".to_string(),
        "contextCompaction" => "compact_context".to_string(),
        _ => return None,
    };
    Some((id, name, item.clone()))
}

fn tool_result_from_item(item: &Value) -> (String, bool) {
    let status = item
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed");
    let is_error = matches!(status, "failed" | "declined")
        || item.get("success").and_then(Value::as_bool) == Some(false)
        || item.get("error").is_some_and(|value| !value.is_null());
    let output = match item.get("type").and_then(Value::as_str) {
        Some("commandExecution") => item
            .get("aggregatedOutput")
            .and_then(Value::as_str)
            .map(str::to_owned),
        Some("mcpToolCall") => item
            .get("result")
            .filter(|value| !value.is_null())
            .map(compact_json)
            .or_else(|| item.get("error").map(compact_json)),
        Some("dynamicToolCall") => item.get("contentItems").map(compact_json),
        Some("imageGeneration") => item
            .get("savedPath")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                item.get("result")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            }),
        _ => None,
    }
    .unwrap_or_else(|| compact_json(item));
    (output, is_error)
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "Codex item completed.".into())
}

fn user_message_text(item: &Value) -> Option<String> {
    let parts = item
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|input| match input.get("type").and_then(Value::as_str) {
            Some("text") => input.get("text").and_then(Value::as_str).map(str::to_owned),
            Some("image") | Some("localImage") => input
                .get("url")
                .or_else(|| input.get("path"))
                .and_then(Value::as_str)
                .map(|value| format!("[Image: {value}]")),
            Some("mention") | Some("skill") => input
                .get("name")
                .or_else(|| input.get("path"))
                .and_then(Value::as_str)
                .map(|value| format!("[{value}]")),
            _ => None,
        })
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn approval_presentation(method: &str, params: &Value) -> (String, String, Value, Option<String>) {
    match method {
        "item/commandExecution/requestApproval" => {
            let command = params
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("command")
                .to_string();
            (
                "run_command".into(),
                command.clone(),
                json!({
                    "command": command,
                    "cwd": params.get("cwd").cloned().unwrap_or(Value::Null),
                    "reason": params.get("reason").cloned().unwrap_or(Value::Null),
                    "availableDecisions": params
                        .get("availableDecisions")
                        .cloned()
                        .unwrap_or(Value::Null),
                }),
                None,
            )
        }
        "item/fileChange/requestApproval" => (
            "edit_file".into(),
            params
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("proposed file changes")
                .to_string(),
            params.clone(),
            None,
        ),
        _ => (
            "codex_permissions".into(),
            params
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("additional permissions")
                .to_string(),
            params
                .get("permissions")
                .cloned()
                .unwrap_or_else(|| params.clone()),
            None,
        ),
    }
}

fn approval_supports_session(method: &str, params: &Value) -> bool {
    match method {
        "item/commandExecution/requestApproval" => params
            .get("availableDecisions")
            .and_then(Value::as_array)
            .is_some_and(|decisions| {
                decisions
                    .iter()
                    .any(|decision| decision.as_str() == Some("acceptForSession"))
            }),
        "item/fileChange/requestApproval" | "item/permissions/requestApproval" => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RecordingSink {
        events: std::sync::Mutex<Vec<(String, StreamEvent)>>,
    }

    impl EventSink for RecordingSink {
        fn emit(&self, channel: &str, event: StreamEvent) {
            self.events
                .lock()
                .unwrap()
                .push((channel.to_string(), event));
        }
    }

    #[test]
    fn event_pump_uses_tauri_runtime_outside_a_tokio_context() {
        assert!(tokio::runtime::Handle::try_current().is_err());

        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(CodexAppServer::new(Default::default()), db, sink);

        engine.start_event_pump();
        assert!(engine.event_pump.lock().unwrap().is_some());

        tauri::async_runtime::block_on(engine.shutdown());
        assert!(engine.event_pump.lock().unwrap().is_none());
    }

    #[test]
    fn permission_modes_map_to_codex_policy_without_a_second_tool_gate() {
        assert_eq!(
            codex_permissions(&crate::permissions::PermissionMode::Default),
            (json!("untrusted"), json!("workspace-write"), None)
        );
        assert_eq!(
            codex_permissions(&crate::permissions::PermissionMode::Plan),
            (json!("never"), json!("read-only"), None)
        );
        assert_eq!(
            codex_permissions(&crate::permissions::PermissionMode::Bypass),
            (json!("never"), json!("danger-full-access"), None)
        );
        assert_eq!(
            codex_permissions(&crate::permissions::PermissionMode::Auto).2,
            Some("auto_review")
        );
        assert_eq!(
            codex_sandbox_policy(&crate::permissions::PermissionMode::Plan)["type"],
            "readOnly"
        );
        assert_eq!(
            codex_sandbox_policy(&crate::permissions::PermissionMode::Bypass)["type"],
            "dangerFullAccess"
        );
    }

    #[test]
    fn new_threads_request_the_lossless_raw_event_stream() {
        let mut params = Map::new();
        enable_raw_thread_events(&mut params);
        assert_eq!(
            params.get("experimentalRawEvents"),
            Some(&Value::Bool(true))
        );
    }

    #[test]
    fn session_approval_is_limited_to_decisions_codex_offered() {
        assert!(approval_supports_session(
            "item/commandExecution/requestApproval",
            &json!({"availableDecisions":["accept", "acceptForSession", "decline"]}),
        ));
        assert!(!approval_supports_session(
            "item/commandExecution/requestApproval",
            &json!({"availableDecisions":["accept", "decline"]}),
        ));
        assert!(!approval_supports_session(
            "item/commandExecution/requestApproval",
            &json!({}),
        ));
        assert!(approval_supports_session(
            "item/fileChange/requestApproval",
            &json!({}),
        ));
        assert!(approval_supports_session(
            "item/permissions/requestApproval",
            &json!({}),
        ));
    }

    #[tokio::test]
    async fn transport_close_retires_only_the_expired_generation() {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(CodexAppServer::new(Default::default()), db, sink.clone());

        engine.active_by_session.lock().await.insert(
            "old-session".to_string(),
            ActiveSessionTurn {
                run_id: "old-run".to_string(),
                generation: Some(1),
                turn_id: Some("old-turn".to_string()),
            },
        );
        engine.active_by_session.lock().await.insert(
            "shared-session".to_string(),
            ActiveSessionTurn {
                run_id: "replacement-run".to_string(),
                generation: Some(2),
                turn_id: Some("replacement-turn".to_string()),
            },
        );
        engine.pending_starts.lock().await.insert(
            "pending-thread".to_string(),
            PendingTurnStart {
                generation: 1,
                run_id: "pending-run".to_string(),
                session_id: "old-session".to_string(),
                thread_id: "pending-thread".to_string(),
                text: "hello".to_string(),
                started_at_ms: 1,
            },
        );
        engine.turns.lock().await.insert(
            "old-turn".to_string(),
            TurnProjection::new(
                1,
                "old-session".to_string(),
                "old-thread".to_string(),
                "old-turn".to_string(),
            ),
        );
        engine.turns.lock().await.insert(
            "stale-shared-turn".to_string(),
            TurnProjection::new(
                1,
                "shared-session".to_string(),
                "old-shared-thread".to_string(),
                "stale-shared-turn".to_string(),
            ),
        );
        engine.active_by_thread.lock().await.insert(
            "old-agent".to_string(),
            ActiveThreadTurn {
                generation: 1,
                turn_id: "old-agent-turn".to_string(),
            },
        );
        engine.active_by_thread.lock().await.insert(
            "replacement-agent".to_string(),
            ActiveThreadTurn {
                generation: 2,
                turn_id: "replacement-agent-turn".to_string(),
            },
        );
        engine.routes.write().await.insert(
            "old-agent".to_string(),
            ThreadRoute {
                session_id: "old-session".to_string(),
                root_thread_id: "old-thread".to_string(),
                is_subagent: true,
            },
        );
        engine.pending_requests.lock().await.insert(
            "approval-1".to_string(),
            PendingServerRequest {
                generation: 1,
                rpc_id: json!(9),
                method: "item/fileChange/requestApproval".to_string(),
                params: json!({}),
                session_id: "old-session".to_string(),
            },
        );
        engine
            .resumed_generation
            .lock()
            .await
            .insert("old-thread".to_string(), 1);
        engine
            .resumed_generation
            .lock()
            .await
            .insert("replacement-thread".to_string(), 2);

        engine
            .handle_transport_closed(1, "test transport closed")
            .await;

        let sessions = engine.active_by_session.lock().await;
        assert!(!sessions.contains_key("old-session"));
        assert_eq!(
            sessions
                .get("shared-session")
                .and_then(|active| active.turn_id.as_deref()),
            Some("replacement-turn")
        );
        drop(sessions);
        assert!(!engine
            .active_by_thread
            .lock()
            .await
            .contains_key("old-agent"));
        assert!(engine
            .active_by_thread
            .lock()
            .await
            .contains_key("replacement-agent"));
        assert!(engine.pending_starts.lock().await.is_empty());
        assert!(engine.pending_requests.lock().await.is_empty());
        assert_eq!(
            engine
                .resumed_generation
                .lock()
                .await
                .get("replacement-thread"),
            Some(&2)
        );

        let events = sink.events.lock().unwrap();
        assert!(events.iter().any(|(_, event)| matches!(
            event,
            StreamEvent::AgentFinished { agent_id, status }
                if agent_id == "old-agent" && status == "error"
        )));
        assert!(events.iter().any(|(channel, event)| {
            channel == "agent://old-session"
                && matches!(event, StreamEvent::Error { message, .. } if message.contains("test transport closed"))
        }));
        assert!(!events.iter().any(|(channel, event)| {
            channel == "agent://shared-session" && matches!(event, StreamEvent::Error { .. })
        }));
    }

    #[test]
    fn every_codex_tool_item_has_a_forward_compatible_projection() {
        let fixtures = [
            (
                json!({"id":"c","type":"commandExecution","command":"cargo test"}),
                "run_command",
            ),
            (
                json!({"id":"f","type":"fileChange","changes":[]}),
                "edit_file",
            ),
            (
                json!({"id":"m","type":"mcpToolCall","server":"git","tool":"status"}),
                "mcp:git/status",
            ),
            (
                json!({"id":"d","type":"dynamicToolCall","namespace":"app","tool":"open"}),
                "app:open",
            ),
            (
                json!({"id":"a","type":"collabAgentToolCall","tool":"spawnAgent"}),
                "delegate_task",
            ),
            (
                json!({"id":"sa","type":"subAgentActivity","agentThreadId":"t","agentPath":"a","kind":"started"}),
                "subagent_activity",
            ),
            (
                json!({"id":"w","type":"webSearch","query":"Codex"}),
                "web_search",
            ),
            (
                json!({"id":"i","type":"imageView","path":"x.png"}),
                "view_image",
            ),
            (
                json!({"id":"g","type":"imageGeneration","status":"inProgress","result":null}),
                "image_generation",
            ),
            (json!({"id":"s","type":"sleep","durationMs":100}), "sleep"),
            (
                json!({"id":"x","type":"contextCompaction"}),
                "compact_context",
            ),
        ];
        for (item, expected) in fixtures {
            assert_eq!(tool_use_from_item(&item).unwrap().1, expected);
        }
    }

    #[test]
    fn final_item_results_keep_output_and_failure_state() {
        let command = json!({
            "id":"c", "type":"commandExecution", "status":"failed",
            "aggregatedOutput":"compiler error", "exitCode":1
        });
        assert_eq!(
            tool_result_from_item(&command),
            ("compiler error".into(), true)
        );
        let future = json!({"id":"w","type":"webSearch","query":"x","results":[1,2]});
        let (output, failed) = tool_result_from_item(&future);
        assert!(!failed);
        assert!(output.contains("results"));
    }

    #[test]
    fn raw_identity_extractors_cover_notification_shapes() {
        let params = json!({
            "threadId":"thread-1", "turn":{"id":"turn-1"},
            "item":{"id":"item-1","type":"agentMessage"}
        });
        assert_eq!(extract_thread_id(&params).as_deref(), Some("thread-1"));
        assert_eq!(extract_turn_id(&params).as_deref(), Some("turn-1"));
        assert_eq!(extract_item_id(&params).as_deref(), Some("item-1"));
    }

    #[test]
    fn account_and_model_views_support_chatgpt_and_api_key_modes() {
        let chatgpt = account_view(&json!({
            "account": {"type":"chatgpt","email":"person@example.test","planType":"plus"}
        }));
        assert!(chatgpt.signed_in);
        assert_eq!(chatgpt.auth_mode.as_deref(), Some("chatgpt"));
        let api_key = account_view(&json!({"account":{"type":"apiKey"}}));
        assert_eq!(api_key.auth_mode.as_deref(), Some("apiKey"));
        assert_eq!(
            api_key_login_params("sk-test-not-a-real-key".to_string()),
            json!({"type":"apiKey","apiKey":"sk-test-not-a-real-key"})
        );

        let model = model_view(&json!({
            "id":"gpt-new", "displayName":"GPT New",
            "supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"ultra"}],
            "defaultReasoningEffort":"low",
            "serviceTiers":[{
                "id":"priority",
                "name":"Fast",
                "description":"1.5x speed, more usage"
            }]
        }))
        .unwrap();
        assert_eq!(model.reasoning_efforts, ["low", "ultra"]);
        assert_eq!(model.service_tiers.len(), 1);
        assert_eq!(model.service_tiers[0].id, "priority");
        assert_eq!(model.service_tiers[0].name, "Fast");
        assert_eq!(
            fast_service_tier_id(std::slice::from_ref(&model), "gpt-new"),
            Some("priority")
        );

        let standard_only = model_view(&json!({
            "id":"gpt-mini", "displayName":"GPT Mini",
            "supportedReasoningEfforts":[],
            "defaultReasoningEffort":"medium",
            "serviceTiers":[]
        }))
        .unwrap();
        assert_eq!(
            fast_service_tier_id(&[model, standard_only], "gpt-mini"),
            None
        );
    }

    #[test]
    fn structured_request_results_are_exact_and_fail_closed() {
        let request = json!({
            "questions": [
                {"id":"choice","header":"Mode","question":"Pick","options":[]},
                {"id":"note","header":"Note","question":"Explain","options":[]}
            ]
        });
        let response = validate_structured_response(
            "item/tool/requestUserInput",
            &request,
            json!({"answers":{
                "choice":{"answers":["Fast"]},
                "note":{"answers":["Because"]}
            },"ignored":"field"}),
        )
        .unwrap();
        assert_eq!(response["answers"]["choice"]["answers"][0], "Fast");
        assert!(response.get("ignored").is_none());
        assert!(validate_structured_response(
            "item/tool/requestUserInput",
            &request,
            json!({"answers":{"unknown":{"answers":["x"]}}}),
        )
        .is_err());

        let declined = validate_structured_response(
            "mcpServer/elicitation/request",
            &json!({}),
            json!({"action":"decline","content":{"secret":"must be dropped"}}),
        )
        .unwrap();
        assert_eq!(declined, json!({"action":"decline","content":null}));
    }

    #[test]
    fn authoritative_codex_timestamps_are_preferred_over_ingestion_time() {
        assert_eq!(
            event_timestamp_ms("item/completed", &json!({"completedAtMs": 1234})),
            Some(1234)
        );
        assert_eq!(
            event_timestamp_ms("turn/completed", &json!({"turn":{"completedAt": 42}})),
            Some(42_000)
        );
        assert_eq!(
            event_timestamp_ms("thread/started", &json!({"thread":{"createdAt": 7}})),
            Some(7_000)
        );
    }

    #[test]
    fn resumed_user_content_keeps_text_and_attachment_context() {
        let text = user_message_text(&json!({
            "type":"userMessage",
            "content":[
                {"type":"text","text":"Inspect this"},
                {"type":"localImage","path":"C:/work/image.png"}
            ]
        }))
        .unwrap();
        assert!(text.contains("Inspect this"));
        assert!(text.contains("image.png"));
    }
}
