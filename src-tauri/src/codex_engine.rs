//! Portcode's projection layer over the real Codex app-server.
//!
//! Codex owns agent reasoning, context, tools, approvals, compaction, MCP, and
//! multi-agent execution. This module only maps Portcode session ids to Codex
//! thread ids, persists a UI/search read model, and projects the lossless event
//! stream into Portcode's existing chat primitives.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex as StdMutex, Weak},
    time::Duration,
};
#[cfg(test)]
use std::{future::Future, pin::Pin};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, Mutex, RwLock};

use crate::{
    attachments::PreparedTurn,
    codex_app_server::{CodexAppServer, Incoming},
    codex_marketplace::{
        self, CodexMarketplaceAddView, CodexMarketplaceCatalogView, CodexMarketplaceRemoveView,
        CodexMarketplaceRoutes, CodexMarketplaceUpgradeView, CodexPluginDetailView,
        CodexPluginInstallView,
    },
    db::{self, Db},
    events::{CodexRealtimeEvent, EventSink},
    llm::{Block, ChatMessage, StreamEvent},
    settings::Settings,
};

pub const PRIMARY_CODEX_ACCOUNT_ID: &str = "codex-primary";

const ACTIVITY_METADATA_KEY: &str = "_portcodeActivity";
const MAX_ACTIVITY_PARAM_BYTES: usize = 64 * 1024;
const MAX_ACTIVITY_METHOD_BYTES: usize = 256;
const MAX_ACTIVITY_DEPTH: usize = 16;
const MAX_ACTIVITY_FIELDS: usize = 256;
const MAX_ACTIVITY_ARRAY_ITEMS: usize = 256;
const MAX_ACTIVITY_STRING_BYTES: usize = 16 * 1024;
const MAX_DEFERRED_THREADS: usize = 128;
const MAX_DEFERRED_EVENTS_PER_THREAD: usize = 512;
const MAX_DEFERRED_BYTES_PER_THREAD: usize = 512 * 1024;
const MAX_DEFERRED_BYTES_TOTAL: usize = 8 * 1024 * 1024;
const MAX_RETAINED_SUBAGENTS_PER_GENERATION: usize = 512;
const MAX_RETAINED_SUBAGENT_TURNS_PER_THREAD: usize = 512;
const MAX_RETAINED_FAILED_ROOT_PROJECTIONS_PER_GENERATION: usize = 16;
const MAX_SUBAGENT_RESULT_BYTES: usize = 16 * 1024;
const MAX_REALTIME_EVENT_SDP_BYTES: usize = 256 * 1024;
const MAX_REALTIME_ERROR_BYTES: usize = 1_024;
const INTERRUPT_WATCHDOG_DELAY: Duration = Duration::from_secs(15);

#[cfg(test)]
type TestResponseFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
#[cfg(test)]
type TestResponseHook = dyn Fn(u64, Value, Value) -> TestResponseFuture + Send + Sync + 'static;

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
    generation: Option<u64>,
    parent_thread_id: Option<String>,
    launch_turn_id: Option<String>,
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
    _attachment_snapshot: Option<Arc<tempfile::TempDir>>,
}

#[derive(Clone, Debug)]
struct ActiveThreadTurn {
    generation: u64,
    turn_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InterruptPhase {
    PendingIdentity,
    Sending,
    Sent,
    Retryable,
}

#[derive(Clone, Debug)]
struct InterruptState {
    generation: u64,
    run_id: Option<String>,
    thread_id: Option<String>,
    turn_id: Option<String>,
    attempt: u32,
    phase: InterruptPhase,
}

#[derive(Debug)]
struct DeferredEvent {
    incoming: Incoming,
    encoded_bytes: usize,
    terminal: bool,
}

#[derive(Debug, Default)]
struct DeferredQueue {
    events: VecDeque<DeferredEvent>,
    encoded_bytes: usize,
}

impl DeferredQueue {
    fn len(&self) -> usize {
        self.events.len()
    }

    fn remove(&mut self, index: usize) -> Option<DeferredEvent> {
        let event = self.events.remove(index)?;
        self.encoded_bytes = self.encoded_bytes.saturating_sub(event.encoded_bytes);
        Some(event)
    }

    fn push_back(&mut self, event: DeferredEvent) {
        self.encoded_bytes = self.encoded_bytes.saturating_add(event.encoded_bytes);
        self.events.push_back(event);
    }

    fn enqueue(&mut self, event: DeferredEvent) -> bool {
        if event.encoded_bytes > MAX_DEFERRED_BYTES_PER_THREAD {
            return false;
        }
        while self.events.len() >= MAX_DEFERRED_EVENTS_PER_THREAD
            || self.encoded_bytes.saturating_add(event.encoded_bytes)
                > MAX_DEFERRED_BYTES_PER_THREAD
        {
            let replace = self.events.iter().position(|queued| !queued.terminal);
            let Some(index) = replace.or_else(|| event.terminal.then_some(0)) else {
                return false;
            };
            self.remove(index);
        }
        self.push_back(event);
        true
    }
}

#[derive(Clone, Debug)]
struct SubagentTerminalState {
    authoritative: bool,
}

#[derive(Clone, Debug)]
struct PendingServerRequest {
    generation: u64,
    rpc_id: Value,
    acceptance_key: String,
    claimed: bool,
    method: String,
    params: Value,
    session_id: String,
    thread_id: String,
    turn_id: String,
}

impl PendingServerRequest {
    fn has_same_acceptance(&self, other: &Self) -> bool {
        self.acceptance_key == other.acceptance_key
            && self.generation == other.generation
            && self.rpc_id == other.rpc_id
            && self.thread_id == other.thread_id
            && self.turn_id == other.turn_id
    }
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
    pending_assistant_snapshot: Option<Vec<Block>>,
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
            pending_assistant_snapshot: None,
        }
    }

    fn ensure_ordered(&mut self, item_id: &str) {
        if !self.items.contains_key(item_id) {
            self.order.push(item_id.to_string());
        }
    }

    fn is_owned_by(
        &self,
        generation: u64,
        route: &ThreadRoute,
        thread_id: &str,
        turn_id: &str,
    ) -> bool {
        self.generation == generation
            && self.session_id == route.session_id
            && self.thread_id == thread_id
            && self.turn_id == turn_id
            && route.generation == Some(generation)
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

#[derive(Clone, Debug, Eq, PartialEq)]
struct RealtimeSessionOwner {
    session_id: String,
    thread_id: String,
    generation: u64,
}

pub struct CodexEngine {
    self_weak: Weak<CodexEngine>,
    server: CodexAppServer,
    db: Arc<Db>,
    sink: Arc<dyn EventSink>,
    event_pump: StdMutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    shutdown_gate: RwLock<bool>,
    routes: RwLock<HashMap<String, ThreadRoute>>,
    marketplace_routes: RwLock<CodexMarketplaceRoutes>,
    resumed_generation: Mutex<HashMap<String, u64>>,
    pending_starts: Mutex<HashMap<String, PendingTurnStart>>,
    active_by_session: Mutex<HashMap<String, ActiveSessionTurn>>,
    turn_voice_admission: Mutex<()>,
    active_realtime_session: Mutex<Option<RealtimeSessionOwner>>,
    realtime_quarantine: Mutex<HashMap<String, RealtimeSessionOwner>>,
    active_by_thread: Mutex<HashMap<String, ActiveThreadTurn>>,
    turns: Mutex<HashMap<String, TurnProjection>>,
    failed_root_retention_order: Mutex<VecDeque<(u64, String, String, String)>>,
    usage_by_turn: Mutex<HashMap<(u64, String, String), (u32, u32)>>,
    subagent_turns: Mutex<HashMap<(u64, String), (String, u32)>>,
    subagent_results: Mutex<HashMap<(u64, String, String), String>>,
    announced_agents: Mutex<HashSet<(u64, String)>>,
    subagent_terminals: Mutex<HashMap<(u64, String, String), SubagentTerminalState>>,
    subagent_retention_order: Mutex<VecDeque<(u64, String)>>,
    subagent_turn_retention_order: Mutex<VecDeque<(u64, String, String)>>,
    pending_requests: Mutex<HashMap<String, PendingServerRequest>>,
    request_lifecycle: Mutex<()>,
    deferred_by_thread: Mutex<HashMap<String, DeferredQueue>>,
    session_interrupts: Mutex<HashMap<String, InterruptState>>,
    agent_interrupts: Mutex<HashMap<String, InterruptState>>,
    #[cfg(test)]
    interrupt_requests: Mutex<Vec<(String, String)>>,
    #[cfg(test)]
    response_hook: StdMutex<Option<Arc<TestResponseHook>>>,
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
                        generation: None,
                        parent_thread_id: None,
                        launch_turn_id: None,
                    },
                )
            })
            .collect();
        Arc::new_cyclic(|self_weak| Self {
            self_weak: self_weak.clone(),
            server,
            db,
            sink,
            event_pump: StdMutex::new(None),
            shutdown_gate: RwLock::new(false),
            routes: RwLock::new(routes),
            marketplace_routes: RwLock::new(CodexMarketplaceRoutes::default()),
            resumed_generation: Mutex::new(HashMap::new()),
            pending_starts: Mutex::new(HashMap::new()),
            active_by_session: Mutex::new(HashMap::new()),
            turn_voice_admission: Mutex::new(()),
            active_realtime_session: Mutex::new(None),
            realtime_quarantine: Mutex::new(HashMap::new()),
            active_by_thread: Mutex::new(HashMap::new()),
            turns: Mutex::new(HashMap::new()),
            failed_root_retention_order: Mutex::new(VecDeque::new()),
            usage_by_turn: Mutex::new(HashMap::new()),
            subagent_turns: Mutex::new(HashMap::new()),
            subagent_results: Mutex::new(HashMap::new()),
            announced_agents: Mutex::new(HashSet::new()),
            subagent_terminals: Mutex::new(HashMap::new()),
            subagent_retention_order: Mutex::new(VecDeque::new()),
            subagent_turn_retention_order: Mutex::new(VecDeque::new()),
            pending_requests: Mutex::new(HashMap::new()),
            request_lifecycle: Mutex::new(()),
            deferred_by_thread: Mutex::new(HashMap::new()),
            session_interrupts: Mutex::new(HashMap::new()),
            agent_interrupts: Mutex::new(HashMap::new()),
            #[cfg(test)]
            interrupt_requests: Mutex::new(Vec::new()),
            #[cfg(test)]
            response_hook: StdMutex::new(None),
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

    async fn claim_realtime_session(
        &self,
        session_id: &str,
        thread_id: &str,
        generation: u64,
    ) -> Result<(), String> {
        let _admission = self.turn_voice_admission.lock().await;
        if self.active_by_session.lock().await.contains_key(session_id) {
            return Err(
                "Wait for the current Codex turn to finish before starting voice.".to_owned(),
            );
        }
        if self
            .realtime_quarantine
            .lock()
            .await
            .get(session_id)
            .is_some_and(|owner| owner.thread_id == thread_id && owner.generation == generation)
        {
            return Err(
                "Voice cannot restart on this conversation until Codex reconnects.".to_owned(),
            );
        }
        let mut active = self.active_realtime_session.lock().await;
        let claimed = match active.as_ref() {
            None => {
                *active = Some(RealtimeSessionOwner {
                    session_id: session_id.to_owned(),
                    thread_id: thread_id.to_owned(),
                    generation,
                });
                Ok(())
            }
            Some(owner) if owner.session_id == session_id => {
                Err("Voice is already active for this conversation.".to_owned())
            }
            Some(_) => Err("End the active voice conversation before starting another.".to_owned()),
        };
        drop(active);
        if claimed.is_ok() {
            self.realtime_quarantine.lock().await.insert(
                session_id.to_owned(),
                RealtimeSessionOwner {
                    session_id: session_id.to_owned(),
                    thread_id: thread_id.to_owned(),
                    generation,
                },
            );
        }
        claimed
    }

    async fn claim_turn_session(
        &self,
        run_id: &str,
        session_id: &str,
        attachment_snapshot: Option<Arc<tempfile::TempDir>>,
    ) -> Result<(), String> {
        let _admission = self.turn_voice_admission.lock().await;
        if self
            .active_realtime_session
            .lock()
            .await
            .as_ref()
            .is_some_and(|owner| owner.session_id == session_id)
        {
            return Err(
                "End voice before sending another message in this conversation.".to_owned(),
            );
        }
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
                _attachment_snapshot: attachment_snapshot,
            },
        );
        Ok(())
    }

    async fn clear_stale_realtime_quarantine(&self, session_id: &str, generation: u64) {
        let mut quarantine = self.realtime_quarantine.lock().await;
        if quarantine
            .get(session_id)
            .is_some_and(|owner| owner.generation != generation)
        {
            quarantine.remove(session_id);
        }
    }

    async fn release_realtime_session(
        &self,
        session_id: &str,
        thread_id: &str,
        generation: u64,
    ) -> bool {
        let mut active = self.active_realtime_session.lock().await;
        let matches_owner = active.as_ref().is_some_and(|owner| {
            owner.session_id == session_id
                && owner.thread_id == thread_id
                && owner.generation == generation
        });
        if !matches_owner {
            return false;
        }
        *active = None;
        true
    }

    async fn rebind_realtime_generation(
        &self,
        session_id: &str,
        thread_id: &str,
        previous_generation: u64,
        next_generation: u64,
    ) -> bool {
        let mut active = self.active_realtime_session.lock().await;
        let Some(owner) = active.as_mut() else {
            return false;
        };
        if owner.session_id != session_id
            || owner.thread_id != thread_id
            || owner.generation != previous_generation
        {
            return false;
        }
        owner.generation = next_generation;
        drop(active);
        if let Some(quarantine) = self.realtime_quarantine.lock().await.get_mut(session_id) {
            if quarantine.thread_id == thread_id && quarantine.generation == previous_generation {
                quarantine.generation = next_generation;
            }
        }
        true
    }

    async fn adopt_restarted_realtime_generation(
        &self,
        session_id: &str,
        thread_id: &str,
        previous_generation: u64,
        next_generation: u64,
    ) -> bool {
        if self
            .rebind_realtime_generation(session_id, thread_id, previous_generation, next_generation)
            .await
        {
            return true;
        }
        self.claim_realtime_session(session_id, thread_id, next_generation)
            .await
            .is_ok()
    }

    async fn owns_realtime_session(
        &self,
        session_id: &str,
        thread_id: &str,
        generation: u64,
    ) -> bool {
        self.active_realtime_session
            .lock()
            .await
            .as_ref()
            .is_some_and(|owner| {
                owner.session_id == session_id
                    && owner.thread_id == thread_id
                    && owner.generation == generation
            })
    }

    async fn wait_for_realtime_release(
        &self,
        session_id: &str,
        thread_id: &str,
        generation: u64,
    ) -> Result<(), String> {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self
                .owns_realtime_session(session_id, thread_id, generation)
                .await
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| "Codex voice did not confirm that it stopped.".to_owned())
    }

    pub async fn realtime_start_webrtc(&self, session_id: &str, sdp: &str) -> Result<(), String> {
        if self.active_by_session.lock().await.contains_key(session_id) {
            return Err(
                "Wait for the current Codex turn to finish before starting voice.".to_owned(),
            );
        }
        let account = self.account(false).await?;
        if !account.signed_in {
            return Err("Sign in to ChatGPT before starting voice.".to_owned());
        }
        let thread_id = realtime_thread_id(&self.db, session_id)?;
        let generation = self
            .server
            .status()
            .await
            .generation
            .ok_or_else(|| "Codex app-server is not running.".to_owned())?;
        self.claim_realtime_session(session_id, &thread_id, generation)
            .await?;
        let mut owner_generation = generation;
        let result = async {
            if self.active_by_session.lock().await.contains_key(session_id) {
                return Err(
                    "Wait for the current Codex turn to finish before starting voice.".to_owned(),
                );
            }
            self.register_root_route(session_id, &thread_id, generation)
                .await;
            if self
                .resumed_generation
                .lock()
                .await
                .get(&thread_id)
                .copied()
                != Some(generation)
            {
                let mut resume_params = Map::new();
                resume_params.insert("threadId".into(), Value::String(thread_id.clone()));
                enable_realtime_thread_feature(&mut resume_params);
                let resumed = self
                    .server
                    .request("thread/resume", Value::Object(resume_params))
                    .await
                    .map_err(|_| "Codex could not resume this conversation.".to_owned())?;
                self.reconcile_resumed_thread(session_id, &thread_id, &resumed)?;
                let current_generation =
                    self.server.status().await.generation.unwrap_or(generation);
                if current_generation != owner_generation {
                    if !self
                        .rebind_realtime_generation(
                            session_id,
                            &thread_id,
                            owner_generation,
                            current_generation,
                        )
                        .await
                    {
                        return Err("Codex voice ownership changed during startup.".to_owned());
                    }
                    owner_generation = current_generation;
                }
                self.register_root_route(session_id, &thread_id, current_generation)
                    .await;
                self.resumed_generation
                    .lock()
                    .await
                    .insert(thread_id.clone(), current_generation);
            }
            if !self
                .owns_realtime_session(session_id, &thread_id, owner_generation)
                .await
            {
                return Err("Codex voice startup was cancelled.".to_owned());
            }
            self.server
                .realtime_start_webrtc(&thread_id, sdp)
                .await
                .map_err(|_| "Codex could not start voice.".to_owned())?;
            let started_generation = self
                .server
                .status()
                .await
                .generation
                .ok_or_else(|| "Codex voice transport stopped during startup.".to_owned())?;
            if started_generation != owner_generation {
                if !self
                    .adopt_restarted_realtime_generation(
                        session_id,
                        &thread_id,
                        owner_generation,
                        started_generation,
                    )
                    .await
                {
                    self.server.shutdown().await;
                    return Err("Codex voice transport changed during startup.".to_owned());
                }
                owner_generation = started_generation;
                self.register_root_route(session_id, &thread_id, started_generation)
                    .await;
                self.resumed_generation
                    .lock()
                    .await
                    .insert(thread_id.clone(), started_generation);
                if self.server.realtime_stop(&thread_id).await.is_err()
                    || self
                        .wait_for_realtime_release(session_id, &thread_id, started_generation)
                        .await
                        .is_err()
                {
                    self.server.shutdown().await;
                }
                return Err(
                    "Codex voice transport restarted. Retry the voice connection.".to_owned(),
                );
            }
            Ok(())
        }
        .await;
        if result.is_err() {
            self.release_realtime_session(session_id, &thread_id, owner_generation)
                .await;
        }
        result
    }

    pub async fn realtime_stop(&self, session_id: &str) -> Result<(), String> {
        let owner = self
            .active_realtime_session
            .lock()
            .await
            .as_ref()
            .filter(|owner| owner.session_id == session_id)
            .cloned();
        let Some(owner) = owner else {
            return Ok(());
        };
        self.server
            .realtime_stop(&owner.thread_id)
            .await
            .map_err(|_| "Codex could not stop voice.".to_owned())?;
        self.wait_for_realtime_release(&owner.session_id, &owner.thread_id, owner.generation)
            .await
    }

    pub async fn marketplace_catalog(&self) -> Result<CodexMarketplaceCatalogView, String> {
        let response = self
            .server
            .plugin_list()
            .await
            .map_err(|_| "Codex could not load the plugin catalog.".to_owned())?;
        let (catalog, routes) = codex_marketplace::project_catalog(&response)?;
        *self.marketplace_routes.write().await = routes;
        Ok(catalog)
    }

    pub async fn marketplace_plugin_detail(
        &self,
        marketplace: &str,
        plugin: &str,
    ) -> Result<CodexPluginDetailView, String> {
        self.marketplace_catalog().await?;
        let params = self
            .marketplace_routes
            .read()
            .await
            .read_params(marketplace, plugin)?;
        let response = self
            .server
            .plugin_read(params)
            .await
            .map_err(|_| "Codex could not load this plugin.".to_owned())?;
        codex_marketplace::project_plugin_detail(&response)
    }

    pub async fn marketplace_plugin_install(
        &self,
        marketplace: &str,
        plugin: &str,
        disclosure_confirmed: bool,
    ) -> Result<CodexPluginInstallView, String> {
        self.marketplace_catalog().await?;
        let params = self.marketplace_routes.read().await.install_params(
            marketplace,
            plugin,
            disclosure_confirmed,
        )?;
        let response = self
            .server
            .plugin_install(params)
            .await
            .map_err(|_| "Codex could not install this plugin.".to_owned())?;
        codex_marketplace::project_plugin_install(&response)
    }

    pub async fn marketplace_plugin_uninstall(
        &self,
        plugin_id: &str,
        removal_confirmed: bool,
    ) -> Result<(), String> {
        let params = codex_marketplace::uninstall_params(plugin_id, removal_confirmed)?;
        self.server
            .plugin_uninstall(params)
            .await
            .map_err(|_| "Codex could not remove this plugin.".to_owned())?;
        Ok(())
    }

    pub async fn marketplace_add(
        &self,
        source: &str,
        ref_name: Option<&str>,
    ) -> Result<CodexMarketplaceAddView, String> {
        let params = codex_marketplace::add_params(source, ref_name)?;
        let response = self
            .server
            .marketplace_add(params)
            .await
            .map_err(|_| "Codex could not add this marketplace.".to_owned())?;
        codex_marketplace::project_marketplace_add(&response)
    }

    pub async fn marketplace_remove(
        &self,
        marketplace_name: &str,
    ) -> Result<CodexMarketplaceRemoveView, String> {
        let params = codex_marketplace::remove_params(marketplace_name)?;
        let response = self
            .server
            .marketplace_remove(params)
            .await
            .map_err(|_| "Codex could not remove this marketplace.".to_owned())?;
        codex_marketplace::project_marketplace_remove(&response)
    }

    pub async fn marketplace_refresh(
        &self,
        marketplace_name: Option<&str>,
    ) -> Result<CodexMarketplaceUpgradeView, String> {
        let params = codex_marketplace::upgrade_params(marketplace_name)?;
        let response = self
            .server
            .marketplace_upgrade(params)
            .await
            .map_err(|_| "Codex could not refresh the marketplace snapshot.".to_owned())?;
        codex_marketplace::project_marketplace_upgrade(&response)
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
        let shutdown_gate = self.shutdown_gate.read().await;
        if *shutdown_gate {
            self.sink.emit(
                &session_channel(&session_id),
                StreamEvent::Error {
                    message: "The Codex engine is shutting down. Retry after Portcode restarts."
                        .to_string(),
                    receipt: None,
                },
            );
            return;
        }
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
                self.session_interrupts.lock().await.remove(&session_id);
                self.sink.emit(
                    &session_channel(&session_id),
                    StreamEvent::Error {
                        message,
                        receipt: None,
                    },
                );
            }
        }
        // Keep admission owned through every awaited dispatch/cleanup path.
        drop(shutdown_gate);
    }

    async fn run_turn_inner(
        &self,
        run_id: &str,
        session_id: &str,
        prepared_turn: &PreparedTurn,
        settings: &Settings,
    ) -> Result<(), String> {
        self.claim_turn_session(run_id, session_id, prepared_turn.attachment_snapshot())
            .await?;

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
            self.register_root_route(session_id, &thread_id, generation)
                .await;
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
                enable_realtime_thread_feature(&mut params);
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
            enable_realtime_thread_feature(&mut params);
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
            let current_generation = self.server.status().await.generation.unwrap_or(generation);
            self.register_root_route(session_id, &persisted, current_generation)
                .await;
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
        self.clear_stale_realtime_quarantine(session_id, turn_generation)
            .await;
        let started_at_ms = response
            .pointer("/turn/startedAt")
            .and_then(Value::as_i64)
            .map(|seconds| seconds.saturating_mul(1000));
        self.activate_pending_turn(turn_generation, &thread_id, &turn_id, started_at_ms)
            .await?;
        Ok(())
    }

    #[cfg(test)]
    async fn send_interrupt_request(&self, thread_id: &str, turn_id: &str) -> Result<(), String> {
        self.interrupt_requests
            .lock()
            .await
            .push((thread_id.to_string(), turn_id.to_string()));
        Ok(())
    }

    #[cfg(not(test))]
    async fn send_interrupt_request(&self, thread_id: &str, turn_id: &str) -> Result<(), String> {
        self.server
            .request(
                "turn/interrupt",
                json!({ "threadId": thread_id, "turnId": turn_id }),
            )
            .await
            .map(|_| ())
            .map_err(|error| format!("Codex could not interrupt the turn: {error}"))
    }

    async fn send_session_interrupt(
        &self,
        session_id: &str,
        generation: u64,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<(), String> {
        let run_id = self
            .active_by_session
            .lock()
            .await
            .get(session_id)
            .filter(|active| {
                active.generation == Some(generation) && active.turn_id.as_deref() == Some(turn_id)
            })
            .map(|active| active.run_id.clone())
            .ok_or_else(|| "The Codex turn is no longer the active session turn.".to_string())?;
        let attempt = {
            let mut interrupts = self.session_interrupts.lock().await;
            if interrupts.get(session_id).is_some_and(|state| {
                state.generation == generation
                    && state.run_id.as_deref() == Some(run_id.as_str())
                    && state.turn_id.as_deref() == Some(turn_id)
                    && matches!(state.phase, InterruptPhase::Sending | InterruptPhase::Sent)
            }) {
                return Ok(());
            }
            let attempt = interrupts
                .get(session_id)
                .filter(|state| {
                    state.generation == generation
                        && state.run_id.as_deref() == Some(run_id.as_str())
                        && state.turn_id.as_deref() == Some(turn_id)
                })
                .map_or(1, |state| state.attempt.saturating_add(1));
            interrupts.insert(
                session_id.to_string(),
                InterruptState {
                    generation,
                    run_id: Some(run_id),
                    thread_id: Some(thread_id.to_string()),
                    turn_id: Some(turn_id.to_string()),
                    attempt,
                    phase: InterruptPhase::Sending,
                },
            );
            attempt
        };
        if let Err(error) = self.send_interrupt_request(thread_id, turn_id).await {
            if let Some(state) = self.session_interrupts.lock().await.get_mut(session_id) {
                if state.generation == generation
                    && state.turn_id.as_deref() == Some(turn_id)
                    && state.attempt == attempt
                {
                    state.phase = InterruptPhase::Retryable;
                }
            }
            return Err(error);
        }
        if let Some(state) = self.session_interrupts.lock().await.get_mut(session_id) {
            if state.generation == generation
                && state.turn_id.as_deref() == Some(turn_id)
                && state.attempt == attempt
            {
                state.phase = InterruptPhase::Sent;
            }
        }
        let weak = self.self_weak.clone();
        let session_id = session_id.to_string();
        let turn_id = turn_id.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(INTERRUPT_WATCHDOG_DELAY).await;
            if let Some(engine) = weak.upgrade() {
                engine
                    .handle_interrupt_watchdog(&session_id, generation, &turn_id, attempt)
                    .await;
            }
        });
        Ok(())
    }

    async fn handle_interrupt_watchdog(
        &self,
        session_id: &str,
        generation: u64,
        turn_id: &str,
        attempt: u32,
    ) {
        let (run_id, thread_id) = {
            let interrupts = self.session_interrupts.lock().await;
            let Some(state) = interrupts.get(session_id) else {
                return;
            };
            if state.generation != generation
                || state.turn_id.as_deref() != Some(turn_id)
                || state.attempt != attempt
                || state.phase != InterruptPhase::Sent
            {
                return;
            }
            let Some(run_id) = state.run_id.clone() else {
                return;
            };
            let Some(thread_id) = state.thread_id.clone() else {
                return;
            };
            (run_id, thread_id)
        };
        let recovered_turn = {
            let turns = self.turns.lock().await;
            turns
                .get(turn_id)
                .filter(|turn| {
                    turn.generation == generation
                        && turn.session_id == session_id
                        && turn.thread_id == thread_id
                        && turn.turn_id == turn_id
                })
                .cloned()
        };
        let params = sanitize_activity_params(
            "portcode/codexBridge/interruptWatchdog",
            &json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "recoverable": false,
                "state": "interruptedUnknownDuration",
                "durationKnown": false,
                "authoritativeTerminalObserved": false,
                "attempt": attempt,
            }),
        );
        let emitted_at_ms = db::now_ms();
        let blocks = recovered_turn
            .as_ref()
            .map(TurnProjection::blocks)
            .unwrap_or_default();
        let messages = if blocks.is_empty() {
            Vec::new()
        } else {
            vec![(
                ChatMessage {
                    role: "assistant".to_string(),
                    content: blocks,
                },
                emitted_at_ms,
            )]
        };
        let lifecycle = self.request_lifecycle.lock().await;
        let exact_interrupt = self
            .session_interrupts
            .lock()
            .await
            .get(session_id)
            .is_some_and(|state| {
                state.generation == generation
                    && state.run_id.as_deref() == Some(run_id.as_str())
                    && state.thread_id.as_deref() == Some(thread_id.as_str())
                    && state.turn_id.as_deref() == Some(turn_id)
                    && state.attempt == attempt
                    && state.phase == InterruptPhase::Sent
            });
        let exact_session = self
            .active_by_session
            .lock()
            .await
            .get(session_id)
            .is_some_and(|entry| {
                entry.run_id == run_id
                    && entry.generation == Some(generation)
                    && entry.turn_id.as_deref() == Some(turn_id)
            });
        let exact_thread = self
            .active_by_thread
            .lock()
            .await
            .get(&thread_id)
            .is_some_and(|entry| entry.generation == generation && entry.turn_id == turn_id);
        if !exact_interrupt || !exact_session || !exact_thread {
            if !exact_session {
                let mut interrupts = self.session_interrupts.lock().await;
                if interrupts.get(session_id).is_some_and(|state| {
                    state.generation == generation
                        && state.run_id.as_deref() == Some(run_id.as_str())
                        && state.turn_id.as_deref() == Some(turn_id)
                        && state.attempt == attempt
                }) {
                    interrupts.remove(session_id);
                }
            }
            return;
        }
        let sequence = match self.db.append_codex_activity_with_messages(
            session_id,
            &thread_id,
            Some(turn_id),
            None,
            "portcode/codexBridge/interruptWatchdog",
            &params,
            None,
            emitted_at_ms,
            &messages,
        ) {
            Ok(sequence) => sequence,
            Err(_) => {
                if let Some(state) = self.session_interrupts.lock().await.get_mut(session_id) {
                    if state.generation == generation
                        && state.run_id.as_deref() == Some(run_id.as_str())
                        && state.turn_id.as_deref() == Some(turn_id)
                        && state.attempt == attempt
                    {
                        state.phase = InterruptPhase::Retryable;
                    }
                }
                return;
            }
        };
        self.retire_exact_turn_requests_locked(generation, session_id, &thread_id, turn_id)
            .await;
        {
            let mut active = self.active_by_session.lock().await;
            if active.get(session_id).is_some_and(|entry| {
                entry.generation == Some(generation)
                    && entry.run_id == run_id
                    && entry.turn_id.as_deref() == Some(turn_id)
            }) {
                active.remove(session_id);
            }
        }
        {
            let mut turns = self.turns.lock().await;
            if turns.get(turn_id).is_some_and(|turn| {
                turn.generation == generation
                    && turn.session_id == session_id
                    && turn.thread_id == thread_id
            }) {
                turns.remove(turn_id);
            }
        }
        {
            let mut active = self.active_by_thread.lock().await;
            if active
                .get(&thread_id)
                .is_some_and(|entry| entry.generation == generation && entry.turn_id == turn_id)
            {
                active.remove(&thread_id);
            }
        }
        {
            let mut interrupts = self.session_interrupts.lock().await;
            if interrupts.get(session_id).is_some_and(|state| {
                state.generation == generation
                    && state.run_id.as_deref() == Some(run_id.as_str())
                    && state.turn_id.as_deref() == Some(turn_id)
                    && state.attempt == attempt
            }) {
                interrupts.remove(session_id);
            }
        }
        drop(lifecycle);
        self.sink.emit_local(
            &session_channel(session_id),
            StreamEvent::CodexEvent {
                sequence,
                method: "portcode/codexBridge/interruptWatchdog".to_string(),
                params,
                request_id: None,
                thread_id: Some(thread_id),
                turn_id: Some(turn_id.to_string()),
                item_id: None,
                emitted_at_ms,
            },
        );
        self.sink.emit(
            &session_channel(session_id),
            StreamEvent::TurnEnd {
                stop_reason: "cancelled".to_string(),
                receipt: None,
            },
        );
    }

    pub async fn interrupt_session(&self, session_id: &str) -> Result<(), String> {
        let active = self
            .active_by_session
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "This conversation has no active Codex turn.".to_string())?;
        let generation = active.generation.unwrap_or_default();
        let Some(turn_id) = active.turn_id else {
            let mut interrupts = self.session_interrupts.lock().await;
            interrupts
                .entry(session_id.to_string())
                .or_insert(InterruptState {
                    generation,
                    run_id: Some(active.run_id),
                    thread_id: None,
                    turn_id: None,
                    attempt: 0,
                    phase: InterruptPhase::PendingIdentity,
                });
            return Ok(());
        };
        let turn = self
            .turns
            .lock()
            .await
            .get(&turn_id)
            .cloned()
            .filter(|turn| {
                turn.generation == generation
                    && turn.session_id == session_id
                    && turn.turn_id == turn_id
            })
            .ok_or_else(|| "The active Codex turn is no longer available.".to_string())?;
        let thread_id = turn.thread_id.clone();
        let route = self.routes.read().await.get(&thread_id).cloned();
        if route
            .as_ref()
            .is_none_or(|route| !turn.is_owned_by(generation, route, &thread_id, &turn_id))
        {
            return Err(
                "The active Codex turn ownership no longer matches its session.".to_string(),
            );
        }
        self.send_session_interrupt(session_id, generation, &thread_id, &turn_id)
            .await
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
        // Close the transport centrally first: this rejects every request source and
        // wakes any admitted run_turn blocked on a response. Then acquire exclusive
        // turn admission so all PreparedTurn owners have drained before snapshots do.
        self.server.shutdown().await;
        let mut shutdown_gate = self.shutdown_gate.write().await;
        *shutdown_gate = true;
        let event_pump = self.event_pump.lock().unwrap().take();
        if let Some(event_pump) = event_pump {
            event_pump.abort();
            let _ = event_pump.await;
        }
        self.pending_starts.lock().await.clear();
        self.active_by_thread.lock().await.clear();
        self.turns.lock().await.clear();
        self.usage_by_turn.lock().await.clear();
        self.pending_requests.lock().await.clear();
        self.deferred_by_thread.lock().await.clear();
        self.active_realtime_session.lock().await.take();
        // Clear this last: it owns native attachment snapshots, which must remain
        // readable until active work has stopped but must not outlive shutdown.
        self.active_by_session.lock().await.clear();
    }

    pub async fn interrupt_agent(&self, agent_thread_id: &str) -> Result<(), String> {
        let active = self
            .active_by_thread
            .lock()
            .await
            .get(agent_thread_id)
            .cloned()
            .ok_or_else(|| "That Codex subagent is no longer running.".to_string())?;
        let attempt = {
            let mut interrupts = self.agent_interrupts.lock().await;
            if interrupts.get(agent_thread_id).is_some_and(|state| {
                state.generation == active.generation
                    && state.turn_id.as_deref() == Some(&active.turn_id)
                    && matches!(state.phase, InterruptPhase::Sending | InterruptPhase::Sent)
            }) {
                return Ok(());
            }
            let attempt = interrupts
                .get(agent_thread_id)
                .filter(|state| {
                    state.generation == active.generation
                        && state.turn_id.as_deref() == Some(&active.turn_id)
                })
                .map_or(1, |state| state.attempt.saturating_add(1));
            interrupts.insert(
                agent_thread_id.to_string(),
                InterruptState {
                    generation: active.generation,
                    run_id: None,
                    thread_id: Some(agent_thread_id.to_string()),
                    turn_id: Some(active.turn_id.clone()),
                    attempt,
                    phase: InterruptPhase::Sending,
                },
            );
            attempt
        };
        if let Err(error) = self
            .send_interrupt_request(agent_thread_id, &active.turn_id)
            .await
        {
            if let Some(state) = self.agent_interrupts.lock().await.get_mut(agent_thread_id) {
                if state.attempt == attempt {
                    state.phase = InterruptPhase::Retryable;
                }
            }
            return Err(error);
        }
        if let Some(state) = self.agent_interrupts.lock().await.get_mut(agent_thread_id) {
            if state.attempt == attempt {
                state.phase = InterruptPhase::Sent;
            }
        }
        let weak = self.self_weak.clone();
        let agent_thread_id = agent_thread_id.to_string();
        let turn_id = active.turn_id.clone();
        let generation = active.generation;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(INTERRUPT_WATCHDOG_DELAY).await;
            if let Some(engine) = weak.upgrade() {
                engine
                    .handle_agent_interrupt_watchdog(
                        &agent_thread_id,
                        generation,
                        &turn_id,
                        attempt,
                    )
                    .await;
            }
        });
        Ok(())
    }

    async fn handle_agent_interrupt_watchdog(
        &self,
        agent_thread_id: &str,
        generation: u64,
        turn_id: &str,
        attempt: u32,
    ) {
        let Some(route) = self
            .routes
            .read()
            .await
            .get(agent_thread_id)
            .filter(|route| route.is_subagent && route.generation == Some(generation))
            .cloned()
        else {
            return;
        };
        let key = (generation, agent_thread_id.to_string(), turn_id.to_string());
        let params = sanitize_activity_params(
            "portcode/codexBridge/interruptWatchdog",
            &json!({
                "threadId": agent_thread_id,
                "turnId": turn_id,
                "recoverable": false,
                "state": "interruptedUnknownDuration",
                "durationKnown": false,
                "authoritativeTerminalObserved": false,
                "attempt": attempt,
            }),
        );
        let emitted_at_ms = db::now_ms();
        let lifecycle = self.request_lifecycle.lock().await;
        let exact_interrupt = self
            .agent_interrupts
            .lock()
            .await
            .get(agent_thread_id)
            .is_some_and(|state| {
                state.generation == generation
                    && state.turn_id.as_deref() == Some(turn_id)
                    && state.attempt == attempt
                    && state.phase == InterruptPhase::Sent
            });
        let exact_active = self
            .active_by_thread
            .lock()
            .await
            .get(agent_thread_id)
            .is_some_and(|entry| entry.generation == generation && entry.turn_id == turn_id);
        let already_terminal = self.subagent_terminals.lock().await.contains_key(&key);
        if !exact_interrupt || !exact_active || already_terminal {
            return;
        }
        let sequence = match self.db.append_codex_activity(
            &route.session_id,
            agent_thread_id,
            Some(turn_id),
            None,
            "portcode/codexBridge/interruptWatchdog",
            &params,
            None,
            emitted_at_ms,
        ) {
            Ok(sequence) => sequence,
            Err(_) => {
                if let Some(state) = self.agent_interrupts.lock().await.get_mut(agent_thread_id) {
                    if state.generation == generation
                        && state.turn_id.as_deref() == Some(turn_id)
                        && state.attempt == attempt
                    {
                        state.phase = InterruptPhase::Retryable;
                    }
                }
                return;
            }
        };
        self.retire_exact_turn_requests_locked(
            generation,
            &route.session_id,
            agent_thread_id,
            turn_id,
        )
        .await;
        {
            let mut interrupts = self.agent_interrupts.lock().await;
            if interrupts.get(agent_thread_id).is_some_and(|state| {
                state.generation == generation
                    && state.turn_id.as_deref() == Some(turn_id)
                    && state.attempt == attempt
            }) {
                interrupts.remove(agent_thread_id);
            }
        }
        {
            let mut active = self.active_by_thread.lock().await;
            if active
                .get(agent_thread_id)
                .is_some_and(|entry| entry.generation == generation && entry.turn_id == turn_id)
            {
                active.remove(agent_thread_id);
            }
        }
        self.subagent_terminals.lock().await.insert(
            key,
            SubagentTerminalState {
                authoritative: false,
            },
        );
        self.prune_subagent_turn_state(generation, agent_thread_id, turn_id)
            .await;
        let turn_count = self
            .subagent_turns
            .lock()
            .await
            .get(&(generation, agent_thread_id.to_string()))
            .map(|(_, count)| *count);
        drop(lifecycle);
        self.sink.emit_local(
            &session_channel(&route.session_id),
            StreamEvent::CodexEvent {
                sequence,
                method: "portcode/codexBridge/interruptWatchdog".to_string(),
                params,
                request_id: None,
                thread_id: Some(agent_thread_id.to_string()),
                turn_id: Some(turn_id.to_string()),
                item_id: None,
                emitted_at_ms,
            },
        );
        self.sink.emit(
            &session_channel(&route.session_id),
            StreamEvent::AgentFinished {
                agent_id: agent_thread_id.to_string(),
                status: "cancelled".to_string(),
                result: None,
                provider_status: Some("interruptedUnknownDuration".to_string()),
                parent_thread_id: route.parent_thread_id,
                launch_turn_id: route.launch_turn_id,
                current_turn_id: Some(turn_id.to_string()),
                turn_count,
                activity: Some("interruptWatchdog".to_string()),
            },
        );
    }

    pub async fn resolve_approval(
        &self,
        id: &str,
        allow: bool,
        for_session: bool,
    ) -> Result<(), String> {
        let (request, result) = {
            let mut pending = self.pending_requests.lock().await;
            let request = pending
                .get_mut(id)
                .ok_or_else(|| "This Codex approval is no longer pending.".to_string())?;
            if request.claimed {
                return Err("This Codex approval response is already being sent.".to_string());
            }
            if allow && for_session && !approval_supports_session(&request.method, &request.params)
            {
                return Err(
                    "Codex did not offer a session-scoped decision for this approval.".into(),
                );
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
            request.claimed = true;
            (request.clone(), result)
        };
        let _lifecycle = self.request_lifecycle.lock().await;
        if !self
            .pending_requests
            .lock()
            .await
            .get(id)
            .is_some_and(|current| current.claimed && current.has_same_acceptance(&request))
        {
            return Err("This Codex approval is no longer pending.".to_string());
        }
        match self
            .transmit_response_result(request.generation, request.rpc_id.clone(), result)
            .await
        {
            Ok(()) => {
                self.finish_request_claim(id, &request).await;
                Ok(())
            }
            Err(error) => {
                self.restore_request_claim(id, &request).await;
                Err(error)
            }
        }
    }

    pub async fn resolve_codex_request(&self, id: &str, response: Value) -> Result<(), String> {
        let (request, response) = {
            let mut pending = self.pending_requests.lock().await;
            let request = pending
                .get_mut(id)
                .ok_or_else(|| "This Codex request is no longer pending.".to_string())?;
            if request.claimed {
                return Err("This Codex request response is already being sent.".to_string());
            }
            if !matches!(
                request.method.as_str(),
                "item/tool/requestUserInput" | "mcpServer/elicitation/request"
            ) {
                return Err("This Codex request cannot accept a structured response.".to_string());
            }
            let response =
                validate_structured_response(&request.method, &request.params, response)?;
            request.claimed = true;
            (request.clone(), response)
        };
        let _lifecycle = self.request_lifecycle.lock().await;
        if !self
            .pending_requests
            .lock()
            .await
            .get(id)
            .is_some_and(|current| current.claimed && current.has_same_acceptance(&request))
        {
            return Err("This Codex request is no longer pending.".to_string());
        }
        match self
            .transmit_response_result(request.generation, request.rpc_id.clone(), response)
            .await
        {
            Ok(()) => {
                self.finish_request_claim(id, &request).await;
                Ok(())
            }
            Err(error) => {
                self.restore_request_claim(id, &request).await;
                Err(error)
            }
        }
    }

    async fn transmit_response_result(
        &self,
        generation: u64,
        rpc_id: Value,
        response: Value,
    ) -> Result<(), String> {
        #[cfg(test)]
        {
            let hook = self.response_hook.lock().unwrap().clone();
            if let Some(hook) = hook {
                return hook(generation, rpc_id, response).await;
            }
        }
        self.server
            .send_response_result(generation, rpc_id, response)
            .await
            .map_err(|error| error.to_string())
    }

    async fn finish_request_claim(&self, id: &str, request: &PendingServerRequest) {
        let mut pending = self.pending_requests.lock().await;
        if pending
            .get(id)
            .is_some_and(|current| current.claimed && current.has_same_acceptance(request))
        {
            pending.remove(id);
        }
    }

    async fn restore_request_claim(&self, id: &str, request: &PendingServerRequest) {
        let mut pending = self.pending_requests.lock().await;
        if let Some(current) = pending
            .get_mut(id)
            .filter(|current| current.claimed && current.has_same_acceptance(request))
        {
            current.claimed = false;
        }
    }

    async fn exact_request_owner_is_active(
        &self,
        generation: u64,
        route: &ThreadRoute,
        thread_id: &str,
        turn_id: &str,
    ) -> bool {
        if route.generation != Some(generation)
            || !self
                .active_by_thread
                .lock()
                .await
                .get(thread_id)
                .is_some_and(|active| active.generation == generation && active.turn_id == turn_id)
        {
            return false;
        }
        if route.is_subagent {
            return true;
        }
        let projected = self
            .turns
            .lock()
            .await
            .get(turn_id)
            .is_some_and(|turn| turn.is_owned_by(generation, route, thread_id, turn_id));
        if !projected {
            return false;
        }
        self.active_by_session
            .lock()
            .await
            .get(&route.session_id)
            .is_some_and(|active| {
                active.generation == Some(generation) && active.turn_id.as_deref() == Some(turn_id)
            })
    }

    async fn normal_root_for_route_is_active(
        &self,
        generation: u64,
        route: &ThreadRoute,
    ) -> Option<String> {
        if route.generation != Some(generation) {
            return None;
        }
        let active_root_turn = self
            .active_by_thread
            .lock()
            .await
            .get(&route.root_thread_id)
            .filter(|active| active.generation == generation)
            .map(|active| active.turn_id.clone())?;
        self.active_by_session
            .lock()
            .await
            .get(&route.session_id)
            .is_some_and(|active| {
                active.generation == Some(generation)
                    && active.turn_id.as_deref() == Some(active_root_turn.as_str())
            })
            .then_some(active_root_turn)
    }

    async fn normal_child_route_is_active(&self, generation: u64, route: &ThreadRoute) -> bool {
        if !route.is_subagent {
            return false;
        }
        let Some(parent_thread_id) = route.parent_thread_id.as_deref() else {
            return false;
        };
        let Some(launch_turn_id) = route.launch_turn_id.as_deref() else {
            return false;
        };
        if !self
            .active_by_thread
            .lock()
            .await
            .get(parent_thread_id)
            .is_some_and(|active| {
                active.generation == generation && active.turn_id == launch_turn_id
            })
        {
            return false;
        }
        self.normal_root_for_route_is_active(generation, route)
            .await
            .is_some()
    }

    async fn retire_exact_turn_requests_locked(
        &self,
        generation: u64,
        session_id: &str,
        thread_id: &str,
        turn_id: &str,
    ) {
        self.pending_requests.lock().await.retain(|_, request| {
            request.generation != generation
                || request.session_id != session_id
                || request.thread_id != thread_id
                || request.turn_id != turn_id
        });
    }

    fn reconcile_resumed_thread(
        &self,
        session_id: &str,
        thread_id: &str,
        response: &Value,
    ) -> Result<(), String> {
        let Some(turns) = response.pointer("/thread/turns").and_then(Value::as_array) else {
            return Ok(());
        };
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
            let mut messages = Vec::new();
            if !user_text.is_empty() {
                messages.push((
                    ChatMessage {
                        role: "user".to_string(),
                        content: vec![Block::Text {
                            text: user_text.join("\n"),
                        }],
                    },
                    started_at_ms,
                ));
            }
            if !assistant_blocks.is_empty() {
                let completed_at_ms = turn
                    .get("completedAt")
                    .and_then(Value::as_i64)
                    .and_then(|seconds| seconds.checked_mul(1000))
                    .unwrap_or(started_at_ms);
                messages.push((
                    ChatMessage {
                        role: "assistant".to_string(),
                        content: assistant_blocks,
                    },
                    completed_at_ms,
                ));
            }
            let sanitized_turn = sanitize_activity_params("thread/resume/history", turn);
            self.db
                .append_codex_activity_with_messages(
                    session_id,
                    thread_id,
                    Some(turn_id),
                    None,
                    "thread/resume/history",
                    &sanitized_turn,
                    None,
                    started_at_ms,
                    &messages,
                )
                .map_err(|error| format!("Could not atomically restore Codex history: {error}"))?;
        }
        Ok(())
    }

    async fn register_root_route(&self, session_id: &str, thread_id: &str, generation: u64) {
        self.routes.write().await.insert(
            thread_id.to_string(),
            ThreadRoute {
                session_id: session_id.to_string(),
                root_thread_id: thread_id.to_string(),
                is_subagent: false,
                generation: Some(generation),
                parent_thread_id: None,
                launch_turn_id: None,
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
        let route = self
            .routes
            .read()
            .await
            .get(thread_id)
            .cloned()
            .ok_or_else(|| "Codex started a turn without a registered thread owner.".to_string())?;
        let existing = self.turns.lock().await.get(turn_id).cloned();
        if let Some(existing) = existing {
            return if existing.is_owned_by(generation, &route, thread_id, turn_id) {
                Ok(())
            } else {
                Err("Codex reused a turn id outside its stored owner.".to_string())
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
        if route.is_subagent
            || route.generation != Some(generation)
            || route.session_id != pending.session_id
            || pending.thread_id != thread_id
        {
            self.pending_starts
                .lock()
                .await
                .insert(thread_id.to_string(), pending);
            return Err("Codex turn ownership did not match the pending session.".to_string());
        }
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
        let pending_interrupt = self
            .session_interrupts
            .lock()
            .await
            .get(&pending.session_id)
            .is_some_and(|state| {
                (state.generation == 0 || state.generation == generation)
                    && state.phase == InterruptPhase::PendingIdentity
            });
        if pending_interrupt {
            if let Err(error) = self
                .send_session_interrupt(&pending.session_id, generation, thread_id, turn_id)
                .await
            {
                self.emit_bridge_warning(error);
            }
        }
        Ok(())
    }

    async fn make_room_for_completed_subagent(&self, generation: u64) {
        let retained = self
            .routes
            .read()
            .await
            .values()
            .filter(|route| route.is_subagent && route.generation == Some(generation))
            .count();
        if retained < MAX_RETAINED_SUBAGENTS_PER_GENERATION {
            return;
        }
        let candidate = {
            let mut order = self.subagent_retention_order.lock().await;
            let Some(index) = order
                .iter()
                .position(|(entry_generation, _)| *entry_generation == generation)
            else {
                return;
            };
            order.remove(index).map(|(_, thread_id)| thread_id)
        };
        let Some(thread_id) = candidate else {
            return;
        };
        if self.active_by_thread.lock().await.contains_key(&thread_id) {
            self.subagent_retention_order
                .lock()
                .await
                .push_back((generation, thread_id));
            return;
        }
        self.routes.write().await.remove(&thread_id);
        self.announced_agents
            .lock()
            .await
            .remove(&(generation, thread_id.clone()));
        self.subagent_turns
            .lock()
            .await
            .remove(&(generation, thread_id.clone()));
        self.subagent_results
            .lock()
            .await
            .retain(|(entry_generation, entry_thread, _), _| {
                *entry_generation != generation || entry_thread != &thread_id
            });
        self.subagent_terminals
            .lock()
            .await
            .retain(|(entry_generation, entry_thread, _), _| {
                *entry_generation != generation || entry_thread != &thread_id
            });
        self.subagent_turn_retention_order.lock().await.retain(
            |(entry_generation, entry_thread, _)| {
                *entry_generation != generation || entry_thread != &thread_id
            },
        );
        self.agent_interrupts.lock().await.remove(&thread_id);
    }

    async fn establish_child_route(
        &self,
        child_thread_id: &str,
        parent_thread_id: &str,
        generation: u64,
        launch_turn_id: Option<&str>,
    ) -> bool {
        if child_thread_id == parent_thread_id {
            return false;
        }
        if !self.routes.read().await.contains_key(child_thread_id) {
            self.make_room_for_completed_subagent(generation).await;
        }
        let mut routes = self.routes.write().await;
        let Some(parent) = routes.get(parent_thread_id).cloned() else {
            return false;
        };
        if parent.generation.is_some_and(|value| value != generation) {
            return false;
        }
        let mut ancestor = Some(parent_thread_id.to_string());
        let mut seen = HashSet::new();
        while let Some(thread_id) = ancestor {
            if thread_id == child_thread_id || !seen.insert(thread_id.clone()) {
                return false;
            }
            ancestor = routes
                .get(&thread_id)
                .and_then(|route| route.parent_thread_id.clone());
        }
        if let Some(existing) = routes.get_mut(child_thread_id) {
            if !existing.is_subagent
                || existing.session_id != parent.session_id
                || existing.root_thread_id != parent.root_thread_id
                || existing.generation != Some(generation)
            {
                return false;
            }
            if existing.parent_thread_id.is_none() {
                existing.parent_thread_id = Some(parent_thread_id.to_string());
            } else if existing.parent_thread_id.as_deref() != Some(parent_thread_id) {
                return false;
            }
            if existing.launch_turn_id.is_none() {
                existing.launch_turn_id = launch_turn_id.map(str::to_owned);
            }
            return true;
        }
        let retained = routes
            .values()
            .filter(|route| route.is_subagent && route.generation == Some(generation))
            .count();
        if retained >= MAX_RETAINED_SUBAGENTS_PER_GENERATION {
            let session_id = parent.session_id.clone();
            let root_thread_id = parent.root_thread_id.clone();
            drop(routes);
            self.sink.emit_local(
                &session_channel(&session_id),
                StreamEvent::CodexEvent {
                    sequence: 0,
                    method: "portcode/codexBridge/subagentAdmissionRejected".to_string(),
                    params: sanitize_activity_params(
                        "portcode/codexBridge/subagentAdmissionRejected",
                        &json!({
                            "threadId": parent_thread_id,
                            "rootThreadId": root_thread_id,
                            "launchTurnId": launch_turn_id,
                            "capacity": MAX_RETAINED_SUBAGENTS_PER_GENERATION,
                            "retained": retained,
                            "recoverable": false,
                            "state": "boundedAdmissionRejected",
                        }),
                    ),
                    request_id: None,
                    thread_id: Some(parent_thread_id.to_string()),
                    turn_id: launch_turn_id.map(str::to_owned),
                    item_id: None,
                    emitted_at_ms: db::now_ms(),
                },
            );
            return false;
        }
        routes.insert(
            child_thread_id.to_string(),
            ThreadRoute {
                session_id: parent.session_id,
                root_thread_id: parent.root_thread_id,
                is_subagent: true,
                generation: Some(generation),
                parent_thread_id: Some(parent_thread_id.to_string()),
                launch_turn_id: launch_turn_id.map(str::to_owned),
            },
        );
        true
    }

    async fn handle_incoming(&self, incoming: Incoming) {
        self.handle_bounded_incoming(sanitize_incoming(incoming))
            .await;
    }

    async fn handle_bounded_incoming(&self, incoming: Incoming) {
        if let Some(thread_id) = incoming_thread_id(&incoming) {
            let generation = incoming_generation(&incoming);
            let existing = self.routes.read().await.get(&thread_id).cloned();
            if existing
                .as_ref()
                .and_then(|route| route.generation)
                .is_some_and(|route_generation| route_generation != generation)
            {
                return;
            }

            let mut route_recovered = false;
            if let Incoming::Notification { method, params, .. } = &incoming {
                if method == "thread/started" {
                    if let Some(parent_id) = string_at(params, &["thread", "parentThreadId"]) {
                        let parent_route = self.routes.read().await.get(&parent_id).cloned();
                        if parent_route
                            .as_ref()
                            .and_then(|parent| parent.generation)
                            .is_some_and(|parent_generation| parent_generation != generation)
                        {
                            return;
                        }
                        let parent_is_quarantined =
                            match parent_route.as_ref() {
                                Some(parent) => self.realtime_quarantine.lock().await.values().any(
                                    |quarantine| quarantine.thread_id == parent.root_thread_id,
                                ),
                                None => false,
                            };
                        if parent_is_quarantined {
                            let normal_root_active = match parent_route.as_ref() {
                                Some(parent) => self
                                    .normal_root_for_route_is_active(generation, parent)
                                    .await
                                    .is_some(),
                                None => false,
                            };
                            if !normal_root_active {
                                return;
                            }
                        } else {
                            route_recovered = self
                                .establish_child_route(&thread_id, &parent_id, generation, None)
                                .await;
                        }
                    }
                }
            }
            if route_recovered {
                self.drain_deferred(&thread_id).await;
            }

            if !self.routes.read().await.contains_key(&thread_id) {
                let event = bounded_deferred_incoming(incoming);
                let event_is_terminal = event.terminal;
                let event_encoded_bytes = event.encoded_bytes;
                let mut deferred = self.deferred_by_thread.lock().await;
                let mut overflowed = false;
                if !deferred.contains_key(&thread_id) && deferred.len() >= MAX_DEFERRED_THREADS {
                    if event_is_terminal {
                        overflowed = evict_deferred_thread_for_terminal(&mut deferred);
                    } else {
                        overflowed = true;
                    }
                }
                if deferred.len() < MAX_DEFERRED_THREADS || deferred.contains_key(&thread_id) {
                    let queue = deferred.entry(thread_id).or_default();
                    let saturated = queue.len() >= MAX_DEFERRED_EVENTS_PER_THREAD
                        || queue.encoded_bytes.saturating_add(event_encoded_bytes)
                            > MAX_DEFERRED_BYTES_PER_THREAD;
                    let inserted = queue.enqueue(event);
                    overflowed |= saturated || !inserted;
                    while deferred_total_bytes(&deferred) > MAX_DEFERRED_BYTES_TOTAL {
                        if evict_deferred_diagnostic(&mut deferred) {
                            overflowed = true;
                            continue;
                        }
                        let Some(evicted) = deferred.keys().next().cloned() else {
                            break;
                        };
                        deferred.remove(&evicted);
                        overflowed = true;
                    }
                }
                drop(deferred);
                if overflowed {
                    self.emit_bridge_warning(
                        "Some child-agent diagnostic activity was truncated so terminal routing truth could remain within the deferred queue safety limits."
                            .to_string(),
                    );
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
        if let Some(queue) = queued {
            for event in queue.events {
                Box::pin(self.handle_bounded_incoming(event.incoming)).await;
            }
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
        let realtime_owner = self
            .active_realtime_session
            .lock()
            .await
            .as_ref()
            .filter(|owner| {
                owner.generation == generation
                    && thread_id.as_deref() == Some(owner.thread_id.as_str())
            })
            .cloned();
        let realtime_quarantined =
            self.realtime_quarantine
                .lock()
                .await
                .values()
                .any(|quarantine| {
                    thread_id.as_deref() == Some(quarantine.thread_id.as_str())
                        || route
                            .as_ref()
                            .is_some_and(|route| route.root_thread_id == quarantine.thread_id)
                });
        let exact_normal_root_turn = if realtime_quarantined {
            match (
                route.as_ref().filter(|route| !route.is_subagent),
                thread_id.as_deref(),
                extract_turn_id(&params),
            ) {
                (Some(_), Some(thread_id), Some(turn_id)) => self
                    .active_by_thread
                    .lock()
                    .await
                    .get(thread_id)
                    .is_some_and(|active| {
                        active.generation == generation && active.turn_id == turn_id
                    }),
                _ => false,
            }
        } else {
            false
        };
        let exact_normal_child_turn = if realtime_quarantined {
            match route.as_ref() {
                Some(route) => self.normal_child_route_is_active(generation, route).await,
                None => false,
            }
        } else {
            false
        };
        if method.starts_with("thread/realtime/") {
            if let Some(owner) = realtime_owner.as_ref() {
                self.project_realtime(generation, owner, method, &params)
                    .await;
            }
            return;
        }
        if realtime_owner.is_some()
            || (realtime_quarantined && !exact_normal_root_turn && !exact_normal_child_turn)
        {
            // Realtime V3 can fan out ordinary turn/item notifications for
            // transcript-derived delegations. They are not Portcode turns and
            // must not cross the ephemeral voice persistence boundary.
            return;
        }
        if let Some(route) = route.as_ref() {
            if let (Some(thread_id), Some(turn_id)) =
                (thread_id.as_deref(), extract_turn_id(&params))
            {
                let stored = self.turns.lock().await.get(&turn_id).cloned();
                if stored
                    .is_some_and(|turn| !turn.is_owned_by(generation, route, thread_id, &turn_id))
                {
                    if method == "turn/completed" {
                        let _lifecycle = self.request_lifecycle.lock().await;
                        self.retire_exact_turn_requests_locked(
                            generation,
                            &route.session_id,
                            thread_id,
                            &turn_id,
                        )
                        .await;
                    }
                    return;
                }
                if !route.is_subagent {
                    let terminal_sensitive = matches!(
                        method,
                        "turn/plan/updated" | "turn/diff/updated" | "turn/completed"
                    );
                    if terminal_sensitive
                        && self
                            .db
                            .codex_turn_completed(&route.session_id, thread_id, &turn_id)
                            .unwrap_or(true)
                    {
                        return;
                    }
                    let failed_terminal = self.failed_root_retention_order.lock().await.iter().any(
                        |(entry_generation, entry_session, entry_thread, entry_turn)| {
                            *entry_generation == generation
                                && entry_session == &route.session_id
                                && entry_thread == thread_id
                                && entry_turn == &turn_id
                        },
                    );
                    if failed_terminal
                        && matches!(method, "turn/plan/updated" | "turn/diff/updated")
                    {
                        return;
                    }
                }
            }
            let root_completion_commits_with_message =
                method == "turn/completed" && !route.is_subagent;
            if !root_completion_commits_with_message
                && !self.record_raw(route, method, &params, None, &raw).await
            {
                return;
            }
        }

        match method {
            "turn/started" => {
                let Some(thread_id) = thread_id else { return };
                let Some(turn_id) = string_at(&params, &["turn", "id"]) else {
                    return;
                };
                if route.as_ref().is_some_and(|route| route.is_subagent)
                    && self.subagent_terminals.lock().await.contains_key(&(
                        generation,
                        thread_id.clone(),
                        turn_id.clone(),
                    ))
                {
                    return;
                }
                self.active_by_thread.lock().await.insert(
                    thread_id.clone(),
                    ActiveThreadTurn {
                        generation,
                        turn_id: turn_id.clone(),
                    },
                );
                if let Some(route) = route.as_ref().filter(|route| route.is_subagent) {
                    let count = {
                        let mut turns = self.subagent_turns.lock().await;
                        let entry = turns
                            .entry((generation, thread_id.clone()))
                            .or_insert_with(|| (String::new(), 0));
                        if entry.0 == turn_id {
                            None
                        } else {
                            entry.0 = turn_id.clone();
                            entry.1 = entry.1.saturating_add(1);
                            Some(entry.1)
                        }
                    };
                    if let Some(turn_count) = count {
                        self.sink.emit(
                            &session_channel(&route.session_id),
                            StreamEvent::AgentProgress {
                                agent_id: thread_id.clone(),
                                step: turn_count,
                                parent_thread_id: route.parent_thread_id.clone(),
                                launch_turn_id: route.launch_turn_id.clone(),
                                current_turn_id: Some(turn_id.clone()),
                                turn_count: Some(turn_count),
                            },
                        );
                    }
                }
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
                let Some(thread_id) = thread_id.as_deref() else {
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
                if !turn.is_owned_by(generation, &route, thread_id, &turn_id) {
                    return;
                }
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
                    self.project_item_started(generation, &route, &params).await;
                }
            }
            "item/completed" => {
                if let Some(route) = route {
                    self.project_item_completed(generation, &route, &params)
                        .await;
                }
            }
            "thread/tokenUsage/updated" => {
                if let Some(route) = route {
                    self.project_usage(generation, &route, &params).await;
                }
            }
            "serverRequest/resolved" => {
                self.clear_resolved_request(generation, &params).await;
            }
            "turn/completed" => {
                if let Some(route) = route {
                    self.complete_turn(generation, &route, &params).await;
                }
            }
            _ => {}
        }
    }

    async fn project_realtime(
        &self,
        generation: u64,
        owner: &RealtimeSessionOwner,
        method: &str,
        params: &Value,
    ) {
        let event = match method {
            "thread/realtime/sdp" => {
                let Some(sdp) = params.get("sdp").and_then(Value::as_str) else {
                    return;
                };
                if sdp.len() > MAX_REALTIME_EVENT_SDP_BYTES || !sdp.trim_start().starts_with("v=0")
                {
                    return;
                }
                CodexRealtimeEvent::Sdp {
                    sdp: sdp.to_owned(),
                }
            }
            "thread/realtime/started" => CodexRealtimeEvent::Started,
            "thread/realtime/closed" => {
                if !params
                    .get("reason")
                    .is_some_and(|reason| reason.is_string() || reason.is_null())
                {
                    return;
                }
                CodexRealtimeEvent::Closed
            }
            "thread/realtime/error" => {
                let message = params
                    .get("message")
                    .and_then(Value::as_str)
                    .or_else(|| params.pointer("/error/message").and_then(Value::as_str))
                    .unwrap_or("Realtime voice session failed.");
                CodexRealtimeEvent::Error {
                    message: truncate_utf8(message, MAX_REALTIME_ERROR_BYTES),
                }
            }
            _ => return,
        };
        if matches!(event, CodexRealtimeEvent::Closed) {
            self.release_realtime_session(&owner.session_id, &owner.thread_id, generation)
                .await;
        }
        self.sink
            .emit_realtime(&format!("codex-realtime://{}", owner.session_id), event);
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
        let Some(thread_id) = extract_thread_id(&params) else {
            let _ = self
                .server
                .send_response_error(generation, rpc_id, -32602, "Missing Codex thread", None)
                .await;
            return;
        };
        let Some(turn_id) = extract_turn_id(&params) else {
            let _ = self
                .server
                .send_response_error(generation, rpc_id, -32602, "Missing Codex turn", None)
                .await;
            return;
        };
        let route = self.routes.read().await.get(&thread_id).cloned();
        let Some(route) = route else {
            let _ = self
                .server
                .send_response_error(generation, rpc_id, -32602, "Unknown Codex thread", None)
                .await;
            return;
        };
        let realtime_quarantined =
            self.realtime_quarantine
                .lock()
                .await
                .values()
                .any(|quarantine| {
                    thread_id == quarantine.thread_id
                        || route.root_thread_id == quarantine.thread_id
                });
        let exact_normal_root_turn = realtime_quarantined
            && !route.is_subagent
            && self
                .exact_request_owner_is_active(generation, &route, &thread_id, &turn_id)
                .await;
        let exact_normal_child_turn = realtime_quarantined
            && self.normal_child_route_is_active(generation, &route).await
            && self
                .exact_request_owner_is_active(generation, &route, &thread_id, &turn_id)
                .await;
        if realtime_quarantined && !exact_normal_root_turn && !exact_normal_child_turn {
            let _ = self
                .server
                .send_response_error(
                    generation,
                    rpc_id,
                    -32602,
                    "Voice-derived client requests are unavailable",
                    None,
                )
                .await;
            return;
        }
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
            if !self
                .record_raw(&route, method, &params, Some(&rpc_id), &raw)
                .await
            {
                return;
            }
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

        let lifecycle = self.request_lifecycle.lock().await;
        if !self
            .exact_request_owner_is_active(generation, &route, &thread_id, &turn_id)
            .await
        {
            drop(lifecycle);
            let _ = self
                .server
                .send_response_error(
                    generation,
                    rpc_id,
                    -32602,
                    "The exact Codex turn is no longer active",
                    None,
                )
                .await;
            return;
        }
        if !self
            .record_raw(&route, method, &params, Some(&rpc_id), &raw)
            .await
        {
            return;
        }
        let sanitized_params = already_sanitized_activity(method, &params);
        let id = uuid::Uuid::new_v4().to_string();
        let acceptance_key = format!("{generation}:{thread_id}:{turn_id}:{id}");
        let mut pending = self.pending_requests.lock().await;
        if pending
            .values()
            .any(|request| request.generation == generation && request.rpc_id == rpc_id)
        {
            return;
        }
        pending.insert(
            id.clone(),
            PendingServerRequest {
                generation,
                rpc_id,
                acceptance_key,
                claimed: false,
                method: method.to_string(),
                params: sanitized_params.clone(),
                session_id: route.session_id.clone(),
                thread_id,
                turn_id,
            },
        );
        drop(pending);
        if approval {
            let (tool, summary, input, diff) = approval_presentation(method, &sanitized_params);
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
                    params: sanitized_params,
                },
            );
        }
        drop(lifecycle);
    }

    async fn clear_resolved_request(&self, generation: u64, params: &Value) {
        let Some(rpc_id) = params.get("requestId") else {
            return;
        };
        let _lifecycle = self.request_lifecycle.lock().await;
        let resolved = {
            let mut pending = self.pending_requests.lock().await;
            let key = pending
                .iter()
                .find(|(_, request)| request.generation == generation && &request.rpc_id == rpc_id)
                .map(|(id, _)| id.clone());
            key.and_then(|id| pending.remove(&id).map(|request| (id, request)))
        };
        if let Some((id, request)) = resolved {
            self.sink.emit_local(
                &session_channel(&request.session_id),
                StreamEvent::CodexRequest {
                    id,
                    method: "serverRequest/resolved".to_string(),
                    params: already_sanitized_activity("serverRequest/resolved", params),
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
    ) -> bool {
        let thread_id = extract_thread_id(params).unwrap_or_else(|| route.root_thread_id.clone());
        let turn_id = extract_turn_id(params);
        let item_id = extract_item_id(params);
        let emitted_at_ms = event_timestamp_ms(method, params).unwrap_or_else(db::now_ms);
        let sanitized_params = already_sanitized_activity(method, params);
        let sanitized_request_id = sanitize_request_id(request_id);
        let Ok(sequence) = self.db.append_codex_activity(
            &route.session_id,
            &thread_id,
            turn_id.as_deref(),
            item_id.as_deref(),
            method,
            &sanitized_params,
            sanitized_request_id.as_ref(),
            emitted_at_ms,
        ) else {
            return false;
        };
        self.sink.emit_local(
            &session_channel(&route.session_id),
            StreamEvent::CodexEvent {
                sequence,
                method: method.to_string(),
                params: sanitized_params,
                request_id: sanitized_request_id,
                thread_id: Some(thread_id),
                turn_id,
                item_id,
                emitted_at_ms,
            },
        );
        true
    }

    async fn project_item_started(&self, generation: u64, route: &ThreadRoute, params: &Value) {
        let Some(turn_id) = string_at(params, &["turnId"]) else {
            return;
        };
        let Some(thread_id) = extract_thread_id(params) else {
            return;
        };
        let Some(item) = params.get("item") else {
            return;
        };
        match item.get("type").and_then(Value::as_str) {
            Some("collabAgentToolCall") => self.register_collab_routes(route, &turn_id, item).await,
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
        if !turn.is_owned_by(generation, route, &thread_id, &turn_id) {
            return;
        }
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

    async fn project_item_completed(&self, generation: u64, route: &ThreadRoute, params: &Value) {
        let Some(turn_id) = string_at(params, &["turnId"]) else {
            return;
        };
        let Some(thread_id) = extract_thread_id(params) else {
            return;
        };
        let Some(item) = params.get("item") else {
            return;
        };
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
        if item_type == "collabAgentToolCall" {
            self.register_collab_routes(route, &turn_id, item).await;
            self.project_collab_status(route, item).await;
        } else if item_type == "subAgentActivity" {
            self.project_subagent_activity(route, params, item).await;
        }
        if route.is_subagent {
            if item_type == "agentMessage" {
                if let Some(text) = item
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    self.subagent_results.lock().await.insert(
                        (
                            route.generation.unwrap_or_default(),
                            extract_thread_id(params).unwrap_or_default(),
                            turn_id.clone(),
                        ),
                        truncate_utf8(text, MAX_SUBAGENT_RESULT_BYTES),
                    );
                    self.prune_subagent_turn_state(generation, &thread_id, &turn_id)
                        .await;
                }
            }
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
            if !turn.is_owned_by(generation, route, &thread_id, &turn_id) {
                return;
            }
            turn.ensure_ordered(&item_id);
            turn.items.insert(item_id, ProjectedItem::Text(final_text));
            turn.pending_assistant_snapshot = Some(turn.blocks());
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
        if !turn.is_owned_by(generation, route, &thread_id, &turn_id) {
            return;
        }
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

    async fn register_collab_routes(
        &self,
        route: &ThreadRoute,
        launch_turn_id: &str,
        item: &Value,
    ) {
        if item.get("tool").and_then(Value::as_str) != Some("spawnAgent") {
            return;
        }
        let Some(parent_thread_id) = item.get("senderThreadId").and_then(Value::as_str) else {
            return;
        };
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
        let model = item.get("model").and_then(Value::as_str).map(str::to_owned);
        let reasoning_effort = item
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let generation = route.generation.unwrap_or_default();
        let mut routed = Vec::new();
        for receiver in receivers {
            if self
                .establish_child_route(
                    &receiver,
                    parent_thread_id,
                    generation,
                    Some(launch_turn_id),
                )
                .await
            {
                routed.push(receiver);
            }
        }
        let parent_id =
            (parent_thread_id != route.root_thread_id).then(|| parent_thread_id.to_string());
        let mut announced = self.announced_agents.lock().await;
        for receiver in &routed {
            if announced.insert((generation, receiver.clone())) {
                self.sink.emit(
                    &session_channel(&route.session_id),
                    StreamEvent::AgentStarted {
                        agent_id: receiver.clone(),
                        description: description.clone(),
                        parent_id: parent_id.clone(),
                        parent_thread_id: Some(parent_thread_id.to_string()),
                        launch_turn_id: Some(launch_turn_id.to_string()),
                        model: model.clone(),
                        reasoning_effort: reasoning_effort.clone(),
                        activity: Some("spawnAgent".to_string()),
                    },
                );
            }
        }
        drop(announced);
        for receiver in routed {
            self.drain_deferred(&receiver).await;
        }
    }

    async fn project_subagent_activity(&self, route: &ThreadRoute, params: &Value, item: &Value) {
        let Some(agent_id) = item.get("agentThreadId").and_then(Value::as_str) else {
            return;
        };
        let Some(parent_thread_id) = extract_thread_id(params) else {
            return;
        };
        let generation = route.generation.unwrap_or_default();
        let existed = self.routes.read().await.contains_key(agent_id);
        if !self
            .establish_child_route(
                agent_id,
                &parent_thread_id,
                generation,
                extract_turn_id(params).as_deref(),
            )
            .await
        {
            return;
        }
        let Some(authoritative_route) = self.routes.read().await.get(agent_id).cloned() else {
            return;
        };
        let kind = item
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("interacted");
        match kind {
            "started" => {
                let current_turn_id = self
                    .subagent_turns
                    .lock()
                    .await
                    .get(&(generation, agent_id.to_string()))
                    .map(|(turn_id, _)| turn_id.clone());
                let already_terminal = if let Some(turn_id) = current_turn_id.as_ref() {
                    self.subagent_terminals.lock().await.contains_key(&(
                        generation,
                        agent_id.to_string(),
                        turn_id.clone(),
                    ))
                } else {
                    false
                };
                if !already_terminal
                    && self
                        .announced_agents
                        .lock()
                        .await
                        .insert((generation, agent_id.to_string()))
                {
                    self.sink.emit(
                        &session_channel(&route.session_id),
                        StreamEvent::AgentStarted {
                            agent_id: agent_id.to_string(),
                            description: item
                                .get("agentPath")
                                .and_then(Value::as_str)
                                .unwrap_or("Codex subagent")
                                .to_string(),
                            parent_id: authoritative_route
                                .parent_thread_id
                                .clone()
                                .filter(|parent| parent != &route.root_thread_id),
                            parent_thread_id: authoritative_route.parent_thread_id.clone(),
                            launch_turn_id: authoritative_route.launch_turn_id.clone(),
                            model: None,
                            reasoning_effort: None,
                            activity: Some("started".to_string()),
                        },
                    );
                }
            }
            "interrupted" => {
                let turn = self
                    .subagent_turns
                    .lock()
                    .await
                    .get(&(generation, agent_id.to_string()))
                    .cloned();
                let terminal_turn_id = turn
                    .as_ref()
                    .map(|(turn_id, _)| turn_id.clone())
                    .unwrap_or_else(|| {
                        format!(
                            "activity:{}",
                            item.get("id").and_then(Value::as_str).unwrap_or("unknown")
                        )
                    });
                let first_terminal = {
                    let mut terminals = self.subagent_terminals.lock().await;
                    match terminals.entry((
                        generation,
                        agent_id.to_string(),
                        terminal_turn_id.clone(),
                    )) {
                        std::collections::hash_map::Entry::Vacant(entry) => {
                            entry.insert(SubagentTerminalState {
                                authoritative: true,
                            });
                            true
                        }
                        std::collections::hash_map::Entry::Occupied(mut entry)
                            if !entry.get().authoritative =>
                        {
                            entry.insert(SubagentTerminalState {
                                authoritative: true,
                            });
                            true
                        }
                        std::collections::hash_map::Entry::Occupied(_) => false,
                    }
                };
                let mut active = self.active_by_thread.lock().await;
                if active.get(agent_id).is_some_and(|active| {
                    active.generation == generation && active.turn_id == terminal_turn_id
                }) {
                    active.remove(agent_id);
                }
                drop(active);
                if first_terminal {
                    self.sink.emit(
                        &session_channel(&route.session_id),
                        StreamEvent::AgentFinished {
                            agent_id: agent_id.to_string(),
                            status: "cancelled".to_string(),
                            result: None,
                            provider_status: Some("interrupted".to_string()),
                            parent_thread_id: authoritative_route.parent_thread_id.clone(),
                            launch_turn_id: authoritative_route.launch_turn_id.clone(),
                            current_turn_id: Some(terminal_turn_id.clone()),
                            turn_count: turn.as_ref().map(|(_, count)| *count),
                            activity: Some("interrupted".to_string()),
                        },
                    );
                    self.prune_subagent_turn_state(generation, agent_id, &terminal_turn_id)
                        .await;
                    self.prune_subagent_state(generation, agent_id).await;
                }
            }
            _ => {}
        }
        if !existed {
            self.drain_deferred(agent_id).await;
        }
    }

    async fn project_collab_status(&self, route: &ThreadRoute, item: &Value) {
        if item.get("tool").and_then(Value::as_str) != Some("spawnAgent") {
            return;
        }
        let Some(states) = item.get("agentsStates").and_then(Value::as_object) else {
            return;
        };
        let generation = route.generation.unwrap_or_default();
        for (agent_id, state) in states {
            let provider_status = state.get("status").and_then(Value::as_str);
            let projected_status = match provider_status {
                Some("completed" | "shutdown") => "ok",
                Some("interrupted") => "cancelled",
                Some("errored" | "notFound") => "error",
                _ => continue,
            };
            let child_route = self.routes.read().await.get(agent_id).cloned();
            let turn = self
                .subagent_turns
                .lock()
                .await
                .get(&(generation, agent_id.clone()))
                .cloned();
            let terminal_turn_id = turn
                .as_ref()
                .map(|(turn_id, _)| turn_id.clone())
                .unwrap_or_else(|| {
                    format!(
                        "collab:{}",
                        item.get("id").and_then(Value::as_str).unwrap_or("unknown")
                    )
                });
            let first_terminal = {
                let mut terminals = self.subagent_terminals.lock().await;
                match terminals.entry((generation, agent_id.clone(), terminal_turn_id.clone())) {
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert(SubagentTerminalState {
                            authoritative: true,
                        });
                        true
                    }
                    std::collections::hash_map::Entry::Occupied(mut entry)
                        if !entry.get().authoritative =>
                    {
                        entry.insert(SubagentTerminalState {
                            authoritative: true,
                        });
                        true
                    }
                    std::collections::hash_map::Entry::Occupied(_) => false,
                }
            };
            if !first_terminal {
                continue;
            }
            let mut active = self.active_by_thread.lock().await;
            if active.get(agent_id).is_some_and(|active| {
                active.generation == generation && active.turn_id == terminal_turn_id
            }) {
                active.remove(agent_id);
            }
            drop(active);
            let result = state
                .get("message")
                .and_then(Value::as_str)
                .map(|message| truncate_utf8(message, MAX_SUBAGENT_RESULT_BYTES));
            if let Some(result) = result.as_ref() {
                self.subagent_results.lock().await.insert(
                    (generation, agent_id.clone(), terminal_turn_id.clone()),
                    result.clone(),
                );
            }
            self.sink.emit(
                &session_channel(&route.session_id),
                StreamEvent::AgentFinished {
                    agent_id: agent_id.clone(),
                    status: projected_status.to_string(),
                    result,
                    provider_status: Some(provider_status.unwrap_or("unknown").to_string()),
                    parent_thread_id: child_route
                        .as_ref()
                        .and_then(|child| child.parent_thread_id.clone()),
                    launch_turn_id: child_route
                        .as_ref()
                        .and_then(|child| child.launch_turn_id.clone()),
                    current_turn_id: Some(terminal_turn_id.clone()),
                    turn_count: turn.as_ref().map(|(_, count)| *count),
                    activity: Some("agentsStates".to_string()),
                },
            );
            self.prune_subagent_turn_state(generation, agent_id, &terminal_turn_id)
                .await;
            self.prune_subagent_state(generation, agent_id).await;
        }
    }

    async fn project_usage(&self, generation: u64, route: &ThreadRoute, params: &Value) {
        let Some(turn_id) = string_at(params, &["turnId"]) else {
            return;
        };
        let thread_id = extract_thread_id(params).unwrap_or_else(|| route.root_thread_id.clone());
        if !route.is_subagent
            && self
                .turns
                .lock()
                .await
                .get(&turn_id)
                .is_none_or(|turn| !turn.is_owned_by(generation, route, &thread_id, &turn_id))
        {
            return;
        }
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
        let completed_thread_id =
            extract_thread_id(params).unwrap_or_else(|| route.root_thread_id.clone());
        let lifecycle = self.request_lifecycle.lock().await;
        self.retire_exact_turn_requests_locked(
            generation,
            &route.session_id,
            &completed_thread_id,
            &turn_id,
        )
        .await;
        if extract_thread_id(params).is_some() {
            self.usage_by_turn.lock().await.remove(&(
                generation,
                completed_thread_id.clone(),
                turn_id.clone(),
            ));
        }
        if route.is_subagent {
            {
                let mut active = self.active_by_thread.lock().await;
                if active
                    .get(&completed_thread_id)
                    .is_some_and(|entry| entry.generation == generation && entry.turn_id == turn_id)
                {
                    active.remove(&completed_thread_id);
                }
            }
            drop(lifecycle);
            let provider_status = params
                .pointer("/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let projected_status = match provider_status {
                "interrupted" => "cancelled",
                "failed" | "errored" | "notFound" => "error",
                "completed" | "shutdown" => "ok",
                _ => "unknown",
            };
            let first_terminal = {
                let mut terminals = self.subagent_terminals.lock().await;
                match terminals.entry((generation, completed_thread_id.clone(), turn_id.clone())) {
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert(SubagentTerminalState {
                            authoritative: true,
                        });
                        true
                    }
                    std::collections::hash_map::Entry::Occupied(mut entry)
                        if !entry.get().authoritative =>
                    {
                        entry.insert(SubagentTerminalState {
                            authoritative: true,
                        });
                        true
                    }
                    std::collections::hash_map::Entry::Occupied(_) => false,
                }
            };
            if !first_terminal {
                return;
            }
            let result = {
                let mut results = self.subagent_results.lock().await;
                results
                    .get_mut(&(generation, completed_thread_id.clone(), turn_id.clone()))
                    .map(|result| {
                        *result = truncate_utf8(result, MAX_SUBAGENT_RESULT_BYTES);
                        result.clone()
                    })
            };
            let turn = self
                .subagent_turns
                .lock()
                .await
                .get(&(generation, completed_thread_id.clone()))
                .cloned();
            self.agent_interrupts
                .lock()
                .await
                .remove(&completed_thread_id);
            self.sink.emit(
                &session_channel(&route.session_id),
                StreamEvent::AgentFinished {
                    agent_id: completed_thread_id.clone(),
                    status: projected_status.to_string(),
                    result,
                    provider_status: Some(provider_status.to_string()),
                    parent_thread_id: route.parent_thread_id.clone(),
                    launch_turn_id: route.launch_turn_id.clone(),
                    current_turn_id: Some(turn_id.clone()),
                    turn_count: turn.as_ref().map(|(_, count)| *count),
                    activity: Some("turnCompleted".to_string()),
                },
            );
            self.prune_subagent_turn_state(generation, &completed_thread_id, &turn_id)
                .await;
            self.prune_subagent_state(generation, &completed_thread_id)
                .await;
            return;
        }

        let exact_thread_active = self
            .active_by_thread
            .lock()
            .await
            .get(&completed_thread_id)
            .is_some_and(|entry| entry.generation == generation && entry.turn_id == turn_id);
        let exact_session_active = self
            .active_by_session
            .lock()
            .await
            .get(&route.session_id)
            .is_some_and(|entry| {
                entry.generation == Some(generation)
                    && entry.turn_id.as_deref() == Some(turn_id.as_str())
            });
        let exact_active = exact_thread_active && exact_session_active;
        let root_turn = self
            .turns
            .lock()
            .await
            .get(&turn_id)
            .filter(|turn| turn.is_owned_by(generation, route, &completed_thread_id, &turn_id))
            .cloned();
        let blocks = root_turn
            .as_ref()
            .map(TurnProjection::blocks)
            .unwrap_or_default();
        let assistant_snapshot = root_turn
            .as_ref()
            .and_then(|turn| turn.pending_assistant_snapshot.clone());
        let emitted_at_ms = event_timestamp_ms("turn/completed", params).unwrap_or_else(db::now_ms);
        let sanitized_params = already_sanitized_activity("turn/completed", params);
        let messages = if blocks.is_empty() {
            Vec::new()
        } else {
            vec![(
                ChatMessage {
                    role: "assistant".into(),
                    content: blocks,
                },
                emitted_at_ms,
            )]
        };
        let (activity_method, activity_params, sequence, persistence_failed) =
            match self.db.append_codex_activity_with_messages(
                &route.session_id,
                &completed_thread_id,
                Some(&turn_id),
                None,
                "turn/completed",
                &sanitized_params,
                None,
                emitted_at_ms,
                &messages,
            ) {
                Ok(sequence) => (
                    "turn/completed".to_string(),
                    sanitized_params,
                    sequence,
                    false,
                ),
                Err(_) => {
                    let method = "portcode/codexBridge/terminalPersistenceFailed";
                    let failure_params = sanitize_activity_params(
                        method,
                        &json!({
                            "threadId": completed_thread_id,
                            "turnId": turn_id,
                            "state": "authoritativeMessagePersistenceFailed",
                            "recoverable": true,
                            "authoritativeTerminalObserved": true,
                        }),
                    );
                    let Ok(sequence) = self.db.append_codex_activity(
                        &route.session_id,
                        &completed_thread_id,
                        Some(&turn_id),
                        None,
                        method,
                        &failure_params,
                        None,
                        emitted_at_ms,
                    ) else {
                        return;
                    };
                    (method.to_string(), failure_params, sequence, true)
                }
            };
        self.sink.emit_local(
            &session_channel(&route.session_id),
            StreamEvent::CodexEvent {
                sequence,
                method: activity_method,
                params: activity_params,
                request_id: None,
                thread_id: Some(completed_thread_id.clone()),
                turn_id: Some(turn_id.clone()),
                item_id: None,
                emitted_at_ms,
            },
        );
        if !persistence_failed {
            if let Some(blocks) = assistant_snapshot {
                self.sink.emit(
                    &session_channel(&route.session_id),
                    StreamEvent::AssistantMessageSnapshot {
                        turn_id: turn_id.clone(),
                        blocks,
                    },
                );
            }
        }

        if root_turn.is_some() && !persistence_failed {
            let mut turns = self.turns.lock().await;
            if turns.get(&turn_id).is_some_and(|turn| {
                turn.is_owned_by(generation, route, &completed_thread_id, &turn_id)
            }) {
                turns.remove(&turn_id);
            }
            drop(turns);
            self.failed_root_retention_order.lock().await.retain(
                |(entry_generation, entry_session, entry_thread, entry_turn)| {
                    *entry_generation != generation
                        || entry_session != &route.session_id
                        || entry_thread != &completed_thread_id
                        || entry_turn != &turn_id
                },
            );
        } else if root_turn.is_some() && persistence_failed {
            self.retain_failed_root_projection(
                generation,
                &route.session_id,
                &completed_thread_id,
                &turn_id,
            )
            .await;
        }
        if !exact_active {
            drop(lifecycle);
            return;
        }
        {
            let mut active = self.active_by_session.lock().await;
            if active.get(&route.session_id).is_some_and(|entry| {
                entry.generation == Some(generation)
                    && entry.turn_id.as_deref() == Some(turn_id.as_str())
            }) {
                active.remove(&route.session_id);
            }
        }
        {
            let mut active = self.active_by_thread.lock().await;
            if active
                .get(&completed_thread_id)
                .is_some_and(|entry| entry.generation == generation && entry.turn_id == turn_id)
            {
                active.remove(&completed_thread_id);
            }
        }
        {
            let mut interrupts = self.session_interrupts.lock().await;
            if interrupts.get(&route.session_id).is_some_and(|state| {
                state.generation == generation && state.turn_id.as_deref() == Some(turn_id.as_str())
            }) {
                interrupts.remove(&route.session_id);
            }
        }
        drop(lifecycle);
        if persistence_failed {
            self.sink.emit(
                &session_channel(&route.session_id),
                StreamEvent::Error {
                    message: "Codex completed with an authoritative final response, but Portcode could not persist that response. The turn was closed as a recoverable persistence failure."
                        .to_string(),
                    receipt: None,
                },
            );
            return;
        }
        let status = params
            .pointer("/turn/status")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        match status {
            "failed" => {
                let message = params
                    .pointer("/turn/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex turn failed.")
                    .to_string();
                self.sink.emit(
                    &session_channel(&route.session_id),
                    StreamEvent::Error {
                        message,
                        receipt: None,
                    },
                );
            }
            "interrupted" => self.sink.emit(
                &session_channel(&route.session_id),
                StreamEvent::TurnEnd {
                    stop_reason: "cancelled".into(),
                    receipt: None,
                },
            ),
            _ => self.sink.emit(
                &session_channel(&route.session_id),
                StreamEvent::TurnEnd {
                    stop_reason: "end_turn".into(),
                    receipt: None,
                },
            ),
        }
    }

    async fn retain_failed_root_projection(
        &self,
        generation: u64,
        session_id: &str,
        thread_id: &str,
        turn_id: &str,
    ) {
        let key = (
            generation,
            session_id.to_string(),
            thread_id.to_string(),
            turn_id.to_string(),
        );
        let evicted = {
            let mut order = self.failed_root_retention_order.lock().await;
            if !order.contains(&key) {
                order.push_back(key);
            }
            let mut evicted = Vec::new();
            while order
                .iter()
                .filter(|(entry_generation, _, _, _)| *entry_generation == generation)
                .count()
                > MAX_RETAINED_FAILED_ROOT_PROJECTIONS_PER_GENERATION
            {
                let Some(index) = order
                    .iter()
                    .position(|(entry_generation, _, _, _)| *entry_generation == generation)
                else {
                    break;
                };
                if let Some(entry) = order.remove(index) {
                    evicted.push(entry);
                }
            }
            evicted
        };

        for (entry_generation, entry_session, entry_thread, entry_turn) in evicted {
            let active_session = self
                .active_by_session
                .lock()
                .await
                .get(&entry_session)
                .is_some_and(|active| {
                    active.generation == Some(entry_generation)
                        && active.turn_id.as_deref() == Some(entry_turn.as_str())
                });
            let active_thread = self
                .active_by_thread
                .lock()
                .await
                .get(&entry_thread)
                .is_some_and(|active| {
                    active.generation == entry_generation && active.turn_id == entry_turn
                });
            if active_session || active_thread {
                continue;
            }
            let mut turns = self.turns.lock().await;
            if turns.get(&entry_turn).is_some_and(|turn| {
                turn.generation == entry_generation
                    && turn.session_id == entry_session
                    && turn.thread_id == entry_thread
                    && turn.turn_id == entry_turn
            }) {
                turns.remove(&entry_turn);
            }
        }
    }

    async fn prune_subagent_turn_state(&self, generation: u64, thread_id: &str, turn_id: &str) {
        let key = (generation, thread_id.to_string(), turn_id.to_string());
        let evicted = {
            let mut order = self.subagent_turn_retention_order.lock().await;
            order.retain(|entry| entry != &key);
            order.push_back(key);
            let mut evicted = Vec::new();
            while order
                .iter()
                .filter(|(entry_generation, entry_thread, _)| {
                    *entry_generation == generation && entry_thread == thread_id
                })
                .count()
                > MAX_RETAINED_SUBAGENT_TURNS_PER_THREAD
            {
                let Some(index) = order
                    .iter()
                    .position(|(entry_generation, entry_thread, _)| {
                        *entry_generation == generation && entry_thread == thread_id
                    })
                else {
                    break;
                };
                if let Some(entry) = order.remove(index) {
                    evicted.push(entry);
                }
            }
            evicted
        };
        if evicted.is_empty() {
            return;
        }
        let evicted = evicted.into_iter().collect::<HashSet<_>>();
        self.subagent_results
            .lock()
            .await
            .retain(|entry, _| !evicted.contains(entry));
        self.subagent_terminals
            .lock()
            .await
            .retain(|entry, _| !evicted.contains(entry));
    }

    async fn prune_subagent_state(&self, generation: u64, thread_id: &str) {
        let evicted = {
            let mut order = self.subagent_retention_order.lock().await;
            order.retain(|key| key != &(generation, thread_id.to_string()));
            order.push_back((generation, thread_id.to_string()));
            let mut evicted = Vec::new();
            while order
                .iter()
                .filter(|(entry_generation, _)| *entry_generation == generation)
                .count()
                > MAX_RETAINED_SUBAGENTS_PER_GENERATION
            {
                let Some(index) = order
                    .iter()
                    .position(|(entry_generation, _)| *entry_generation == generation)
                else {
                    break;
                };
                if let Some((_, evicted_thread)) = order.remove(index) {
                    evicted.push(evicted_thread);
                }
            }
            evicted
        };
        for evicted_thread in evicted {
            if self
                .active_by_thread
                .lock()
                .await
                .contains_key(&evicted_thread)
            {
                continue;
            }
            self.routes.write().await.remove(&evicted_thread);
            self.announced_agents
                .lock()
                .await
                .remove(&(generation, evicted_thread.clone()));
            self.subagent_turns
                .lock()
                .await
                .remove(&(generation, evicted_thread.clone()));
            self.subagent_results
                .lock()
                .await
                .retain(|(entry_generation, entry_thread, _), _| {
                    *entry_generation != generation || entry_thread != &evicted_thread
                });
            self.subagent_terminals.lock().await.retain(
                |(entry_generation, entry_thread, _), _| {
                    *entry_generation != generation || entry_thread != &evicted_thread
                },
            );
            self.subagent_turn_retention_order.lock().await.retain(
                |(entry_generation, entry_thread, _)| {
                    *entry_generation != generation || entry_thread != &evicted_thread
                },
            );
            self.agent_interrupts.lock().await.remove(&evicted_thread);
        }
    }

    async fn handle_transport_closed(&self, generation: u64, reason: &str) {
        let _lifecycle = self.request_lifecycle.lock().await;
        let mut affected_sessions = std::collections::HashSet::new();

        let realtime_owner = {
            let mut active = self.active_realtime_session.lock().await;
            if active
                .as_ref()
                .is_some_and(|owner| owner.generation == generation)
            {
                active.take()
            } else {
                None
            }
        };
        if let Some(owner) = realtime_owner {
            self.sink.emit_realtime(
                &format!("codex-realtime://{}", owner.session_id),
                CodexRealtimeEvent::Error {
                    message: truncate_utf8(
                        &format!("Codex voice transport closed ({reason})."),
                        MAX_REALTIME_ERROR_BYTES,
                    ),
                },
            );
        }

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

        let expired_routes = {
            let mut routes = self.routes.write().await;
            let ids = routes
                .iter()
                .filter_map(|(thread_id, route)| {
                    (route.generation == Some(generation)).then_some(thread_id.clone())
                })
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|thread_id| routes.remove(&thread_id).map(|route| (thread_id, route)))
                .collect::<HashMap<_, _>>()
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
        self.subagent_turns
            .lock()
            .await
            .retain(|(event_generation, _), _| *event_generation != generation);
        self.subagent_results
            .lock()
            .await
            .retain(|(event_generation, _, _), _| *event_generation != generation);
        self.announced_agents
            .lock()
            .await
            .retain(|(event_generation, _)| *event_generation != generation);
        self.subagent_terminals
            .lock()
            .await
            .retain(|(event_generation, _, _), _| *event_generation != generation);
        self.subagent_retention_order
            .lock()
            .await
            .retain(|(event_generation, _)| *event_generation != generation);
        self.subagent_turn_retention_order
            .lock()
            .await
            .retain(|(event_generation, _, _)| *event_generation != generation);
        self.failed_root_retention_order
            .lock()
            .await
            .retain(|(event_generation, _, _, _)| *event_generation != generation);
        self.session_interrupts
            .lock()
            .await
            .retain(|_, state| state.generation != generation);
        self.agent_interrupts
            .lock()
            .await
            .retain(|_, state| state.generation != generation);
        {
            let mut deferred = self.deferred_by_thread.lock().await;
            deferred.retain(|_, queue| {
                queue
                    .events
                    .retain(|event| incoming_generation(&event.incoming) != generation);
                queue.encoded_bytes = queue.events.iter().map(|event| event.encoded_bytes).sum();
                !queue.events.is_empty()
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
                    params: sanitize_activity_params(
                        "serverRequest/resolved",
                        &json!({ "reason": "transportClosed" }),
                    ),
                },
            );
        }

        for (thread_id, _) in expired_threads {
            if let Some(route) = expired_routes.get(&thread_id) {
                affected_sessions.insert(route.session_id.clone());
                if route.is_subagent {
                    self.sink.emit(
                        &session_channel(&route.session_id),
                        StreamEvent::AgentFinished {
                            agent_id: thread_id,
                            status: "error".to_string(),
                            result: None,
                            provider_status: Some("transportClosed".to_string()),
                            parent_thread_id: route.parent_thread_id.clone(),
                            launch_turn_id: route.launch_turn_id.clone(),
                            current_turn_id: None,
                            turn_count: None,
                            activity: Some("transportClosed".to_string()),
                        },
                    );
                }
            }
        }

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
                            params: sanitize_activity_params(
                                "portcode/codexBridge/warning",
                                &json!({ "message": message }),
                            ),
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

fn sanitize_method_and_params(method: String, params: Value) -> (String, Value) {
    let original_method_bytes = method.len();
    let method = truncate_utf8(&method, MAX_ACTIVITY_METHOD_BYTES);
    let mut params = sanitize_activity_params(&method, &params);
    if original_method_bytes > MAX_ACTIVITY_METHOD_BYTES {
        if let Some(metadata) = params
            .get_mut(ACTIVITY_METADATA_KEY)
            .and_then(Value::as_object_mut)
        {
            metadata.insert("truncated".to_string(), Value::Bool(true));
            metadata.insert(
                "originalMethodBytes".to_string(),
                json!(original_method_bytes),
            );
            let reasons = metadata
                .entry("truncationReasons".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Some(reasons) = reasons.as_array_mut() {
                reasons.push(Value::String("maxMethodBytes".to_string()));
            }
        }
    }
    (method, params)
}

fn sanitize_incoming(incoming: Incoming) -> Incoming {
    match incoming {
        Incoming::Notification {
            generation,
            method,
            params,
            ..
        } => {
            let (method, params) = sanitize_method_and_params(method, params);
            Incoming::Notification {
                generation,
                method,
                params,
                raw: Value::Null,
            }
        }
        Incoming::ServerRequest {
            generation,
            id,
            method,
            params,
            ..
        } => {
            let (method, params) = sanitize_method_and_params(method, params);
            Incoming::ServerRequest {
                generation,
                id,
                method,
                params,
                raw: Value::Null,
            }
        }
        closed @ Incoming::TransportClosed { .. } => closed,
    }
}

fn already_sanitized_activity(method: &str, params: &Value) -> Value {
    if params
        .get(ACTIVITY_METADATA_KEY)
        .and_then(Value::as_object)
        .is_some()
        && encoded_json_len(params) <= MAX_ACTIVITY_PARAM_BYTES
    {
        params.clone()
    } else {
        sanitize_activity_params(method, params)
    }
}

fn is_terminal_lifecycle_method(method: &str) -> bool {
    matches!(
        method,
        "turn/completed" | "item/completed" | "thread/closed" | "serverRequest/resolved"
    )
}

fn bounded_deferred_incoming(incoming: Incoming) -> DeferredEvent {
    let (incoming, terminal) = match incoming {
        Incoming::Notification {
            generation,
            method,
            params,
            ..
        } => {
            let terminal = is_terminal_lifecycle_method(&method);
            (
                Incoming::Notification {
                    generation,
                    params,
                    method,
                    raw: Value::Null,
                },
                terminal,
            )
        }
        Incoming::ServerRequest {
            generation,
            id,
            method,
            params,
            ..
        } => (
            Incoming::ServerRequest {
                generation,
                id,
                params,
                method,
                raw: Value::Null,
            },
            false,
        ),
        closed @ Incoming::TransportClosed { .. } => (closed, true),
    };
    let encoded_bytes = match &incoming {
        Incoming::Notification {
            generation,
            method,
            params,
            ..
        } => serde_json::to_vec(&json!({
            "generation": generation,
            "method": method,
            "params": params,
        }))
        .expect("bounded JSON activity is serializable")
        .len(),
        Incoming::ServerRequest {
            generation,
            id,
            method,
            params,
            ..
        } => serde_json::to_vec(&json!({
            "generation": generation,
            "id": id,
            "method": method,
            "params": params,
        }))
        .expect("bounded JSON activity is serializable")
        .len(),
        Incoming::TransportClosed { generation, reason } => serde_json::to_vec(&json!({
            "generation": generation,
            "reason": reason,
        }))
        .expect("bounded JSON activity is serializable")
        .len(),
    };
    DeferredEvent {
        incoming,
        encoded_bytes,
        terminal,
    }
}

fn deferred_total_bytes(deferred: &HashMap<String, DeferredQueue>) -> usize {
    deferred.values().fold(0usize, |total, queue| {
        total.saturating_add(queue.encoded_bytes)
    })
}

fn evict_deferred_thread_for_terminal(deferred: &mut HashMap<String, DeferredQueue>) -> bool {
    let candidate = deferred
        .iter()
        .find(|(_, queue)| queue.events.iter().all(|event| !event.terminal))
        .map(|(thread_id, _)| thread_id.clone())
        .or_else(|| {
            deferred
                .iter()
                .min_by_key(|(_, queue)| queue.events.iter().filter(|event| event.terminal).count())
                .map(|(thread_id, _)| thread_id.clone())
        });
    candidate
        .and_then(|thread_id| deferred.remove(&thread_id))
        .is_some()
}

fn evict_deferred_diagnostic(deferred: &mut HashMap<String, DeferredQueue>) -> bool {
    let candidate = deferred.iter().find_map(|(thread_id, queue)| {
        queue
            .events
            .iter()
            .position(|event| !event.terminal)
            .map(|index| (thread_id.clone(), index))
    });
    let Some((thread_id, index)) = candidate else {
        return false;
    };
    if let Some(queue) = deferred.get_mut(&thread_id) {
        queue.remove(index);
        if queue.events.is_empty() {
            deferred.remove(&thread_id);
        }
    }
    true
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

#[derive(Default)]
struct ActivitySanitization {
    redacted: bool,
    truncated: bool,
    redaction_reasons: HashSet<&'static str>,
    truncation_reasons: HashSet<&'static str>,
    fields: usize,
}

fn is_raw_reasoning_method(method: &str) -> bool {
    let normalized = normalize_reasoning_label(method);
    matches!(
        normalized.as_str(),
        "reasoningtext"
            | "reasoningtextdelta"
            | "itemreasoningtextdelta"
            | "chainofthoughttext"
            | "chainofthoughttextdelta"
            | "internalreasoningtext"
            | "internalreasoningtextdelta"
            | "modelreasoningtext"
            | "modelreasoningtextdelta"
            | "rawreasoningtext"
            | "rawreasoningtextdelta"
    ) || normalized.starts_with("rawresponse")
        || normalized.starts_with("rawresponseitem")
}

fn is_reasoning_key(key: &str) -> bool {
    matches!(
        normalize_reasoning_label(key).as_str(),
        "reasoning"
            | "reasoningtext"
            | "rawreasoning"
            | "rawreasoningtext"
            | "chainofthought"
            | "chainofthoughttext"
            | "internalreasoning"
            | "internalreasoningtext"
            | "modelreasoning"
            | "modelreasoningtext"
    )
}

fn is_known_secret_key(key: &str) -> bool {
    matches!(
        normalize_reasoning_label(key).as_str(),
        "apikey"
            | "xapikey"
            | "password"
            | "passwd"
            | "passphrase"
            | "authorization"
            | "proxyauthorization"
            | "credential"
            | "credentials"
            | "secret"
            | "clientsecret"
            | "apisecret"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "token"
            | "authtoken"
            | "bearertoken"
            | "sessiontoken"
            | "privatekey"
            | "cookie"
            | "setcookie"
            | "bearer"
            | "auth"
            | "authentication"
    )
}

fn normalize_reasoning_label(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

fn object_is_reasoning(object: &Map<String, Value>) -> bool {
    object.iter().any(|(key, value)| {
        matches!(normalize_reasoning_label(key).as_str(), "type" | "kind")
            && value.as_str().is_some_and(|value| {
                matches!(
                    normalize_reasoning_label(value).as_str(),
                    "reasoning"
                        | "reasoningtext"
                        | "rawreasoning"
                        | "rawreasoningtext"
                        | "chainofthought"
                        | "chainofthoughttext"
                        | "internalreasoning"
                        | "internalreasoningtext"
                        | "modelreasoning"
                        | "modelreasoningtext"
                )
            })
    })
}

fn is_safe_reasoning_metadata_key(key: &str) -> bool {
    matches!(
        normalize_reasoning_label(key).as_str(),
        "id" | "type"
            | "kind"
            | "status"
            | "summary"
            | "threadid"
            | "turnid"
            | "itemid"
            | "requestid"
            | "contentindex"
            | "startedat"
            | "startedatms"
            | "completedat"
            | "completedatms"
            | "durationms"
    )
}

fn explicit_activity_marker(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    if object.get("redacted").and_then(Value::as_bool) == Some(true) {
        return Some(json!({ "redacted": true, "reason": "upstream" }));
    }
    if object.get("truncated").and_then(Value::as_bool) == Some(true) {
        return Some(json!({ "truncated": true, "reason": "upstream" }));
    }
    None
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes.min(value.len());
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    value[..end].to_string()
}

fn redaction_marker(reason: &'static str) -> Value {
    json!({ "redacted": true, "reason": reason })
}

fn truncation_marker(reason: &'static str) -> Value {
    json!({ "truncated": true, "reason": reason })
}

fn sanitize_activity_node(
    value: &Value,
    depth: usize,
    stats: &mut ActivitySanitization,
    reasoning_item: bool,
) -> Value {
    if depth >= MAX_ACTIVITY_DEPTH {
        stats.truncated = true;
        stats.truncation_reasons.insert("maxDepth");
        return truncation_marker("maxDepth");
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(value) => {
            if value.len() <= MAX_ACTIVITY_STRING_BYTES {
                Value::String(value.clone())
            } else {
                stats.truncated = true;
                stats.truncation_reasons.insert("maxStringBytes");
                Value::String(truncate_utf8(value, MAX_ACTIVITY_STRING_BYTES))
            }
        }
        Value::Array(values) => {
            let retained = values.len().min(MAX_ACTIVITY_ARRAY_ITEMS);
            if retained != values.len() {
                stats.truncated = true;
                stats.truncation_reasons.insert("maxArrayItems");
            }
            values
                .iter()
                .take(retained)
                .map(|value| sanitize_activity_node(value, depth + 1, stats, false))
                .collect()
        }
        Value::Object(object) => {
            if let Some(marker) = explicit_activity_marker(value) {
                return marker;
            }
            let item_is_reasoning = reasoning_item || object_is_reasoning(object);
            let mut sanitized = Map::new();
            for (key, value) in object {
                if stats.fields >= MAX_ACTIVITY_FIELDS {
                    stats.truncated = true;
                    stats.truncation_reasons.insert("maxFields");
                    break;
                }
                stats.fields += 1;
                if is_known_secret_key(key) {
                    stats.redacted = true;
                    stats.redaction_reasons.insert("knownSecret");
                    sanitized.insert(key.clone(), redaction_marker("knownSecret"));
                    continue;
                }
                if let Some(marker) = explicit_activity_marker(value) {
                    sanitized.insert(key.clone(), marker);
                    continue;
                }
                if is_reasoning_key(key)
                    || (item_is_reasoning && !is_safe_reasoning_metadata_key(key))
                {
                    stats.redacted = true;
                    stats.redaction_reasons.insert("rawReasoning");
                    sanitized.insert(key.clone(), redaction_marker("rawReasoning"));
                    continue;
                }
                sanitized.insert(
                    key.clone(),
                    sanitize_activity_node(value, depth + 1, stats, false),
                );
            }
            Value::Object(sanitized)
        }
    }
}

fn correlation_only_params(params: &Value) -> Map<String, Value> {
    let mut retained = Map::new();
    for key in [
        "threadId",
        "turnId",
        "itemId",
        "requestId",
        "contentIndex",
        "startedAtMs",
        "completedAtMs",
        "id",
        "type",
        "status",
    ] {
        if let Some(value) = params.get(key) {
            let value = match value {
                Value::String(value) => Value::String(truncate_utf8(value, 256)),
                Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
                _ => continue,
            };
            retained.insert(key.to_string(), value);
        }
    }
    if let Some(item) = params.get("item") {
        let mut identity = Map::new();
        for key in ["id", "type", "status", "startedAtMs", "completedAtMs"] {
            if let Some(value) = item.get(key) {
                let value = match value {
                    Value::String(value) => Value::String(truncate_utf8(value, 256)),
                    Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
                    _ => continue,
                };
                identity.insert(key.to_string(), value);
            }
        }
        if !identity.is_empty() {
            retained.insert("item".to_string(), Value::Object(identity));
        }
    }
    retained
}

#[derive(Default)]
struct JsonByteCounter {
    bytes: usize,
}

impl std::io::Write for JsonByteCounter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.bytes = self.bytes.saturating_add(buffer.len());
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encoded_json_len(value: &Value) -> usize {
    let mut counter = JsonByteCounter::default();
    serde_json::to_writer(&mut counter, value).map_or(usize::MAX, |()| counter.bytes)
}

fn set_activity_metadata(
    params: &mut Map<String, Value>,
    stats: &ActivitySanitization,
    original_bytes: usize,
) {
    let mut redaction_reasons = stats.redaction_reasons.iter().copied().collect::<Vec<_>>();
    redaction_reasons.sort_unstable();
    let mut truncation_reasons = stats.truncation_reasons.iter().copied().collect::<Vec<_>>();
    truncation_reasons.sort_unstable();
    params.insert(
        ACTIVITY_METADATA_KEY.to_string(),
        json!({
            "redacted": stats.redacted,
            "truncated": stats.truncated,
            "redactionReasons": redaction_reasons,
            "truncationReasons": truncation_reasons,
            "originalBytes": original_bytes,
        }),
    );
}

fn sanitize_activity_params(method: &str, params: &Value) -> Value {
    let original_bytes = encoded_json_len(params);
    let mut stats = ActivitySanitization::default();
    let mut sanitized = if is_raw_reasoning_method(method) {
        stats.redacted = true;
        stats.redaction_reasons.insert("rawReasoning");
        Value::Object(correlation_only_params(params))
    } else {
        sanitize_activity_node(params, 0, &mut stats, false)
    };
    if !sanitized.is_object() {
        sanitized = json!({ "value": sanitized });
    }
    set_activity_metadata(
        sanitized
            .as_object_mut()
            .expect("activity parameters are normalized to an object"),
        &stats,
        original_bytes,
    );
    if encoded_json_len(&sanitized) > MAX_ACTIVITY_PARAM_BYTES {
        stats.truncated = true;
        stats.truncation_reasons.insert("maxEncodedBytes");
        let mut bounded = correlation_only_params(params);
        set_activity_metadata(&mut bounded, &stats, original_bytes);
        sanitized = Value::Object(bounded);
    }
    let retained_bytes = encoded_json_len(&sanitized);
    if let Some(metadata) = sanitized
        .get_mut(ACTIVITY_METADATA_KEY)
        .and_then(Value::as_object_mut)
    {
        metadata.insert("retainedBytes".to_string(), json!(retained_bytes));
    }
    if encoded_json_len(&sanitized) > MAX_ACTIVITY_PARAM_BYTES {
        stats.truncated = true;
        stats.truncation_reasons.insert("maxEncodedBytes");
        let mut bounded = correlation_only_params(params);
        set_activity_metadata(&mut bounded, &stats, original_bytes);
        sanitized = Value::Object(bounded);
    }
    sanitized
}

fn sanitize_request_id(request_id: Option<&Value>) -> Option<Value> {
    request_id.map(|value| match value {
        Value::String(value) => Value::String(truncate_utf8(value, 256)),
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        _ => redaction_marker("nonScalarRequestId"),
    })
}

fn enable_raw_thread_events(_params: &mut Map<String, Value>) {}

fn enable_realtime_thread_feature(params: &mut Map<String, Value>) {
    params.insert(
        "config".into(),
        json!({ "features.realtime_conversation": true }),
    );
}

fn realtime_thread_id(db: &Db, session_id: &str) -> Result<String, String> {
    let session = db
        .codex_session_config(session_id)
        .map_err(|_| "This conversation is unavailable.".to_owned())?;
    session.codex_thread_id.ok_or_else(|| {
        "Send one message in this conversation before starting experimental voice.".to_owned()
    })
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
        realtime_events: std::sync::Mutex<Vec<(String, CodexRealtimeEvent)>>,
    }

    impl EventSink for RecordingSink {
        fn emit(&self, channel: &str, event: StreamEvent) {
            self.events
                .lock()
                .unwrap()
                .push((channel.to_string(), event));
        }

        fn emit_realtime(&self, channel: &str, event: CodexRealtimeEvent) {
            self.realtime_events
                .lock()
                .unwrap()
                .push((channel.to_string(), event));
        }
    }

    fn canonical_turn(id: &str, status: &str) -> Value {
        let terminal = status != "inProgress";
        json!({
            "id": id,
            "items": [],
            "itemsView": "full",
            "status": status,
            "error": (status == "failed").then(|| json!({
                "message": "turn failed",
                "codexErrorInfo": null,
                "additionalDetails": null
            })),
            "startedAt": 1,
            "completedAt": terminal.then_some(2),
            "durationMs": terminal.then_some(1_000)
        })
    }

    fn canonical_thread(id: &str, parent_thread_id: Option<&str>) -> Value {
        json!({
            "id": id,
            "sessionId": "codex-session-tree",
            "forkedFromId": null,
            "parentThreadId": parent_thread_id,
            "preview": "schema-valid thread",
            "ephemeral": false,
            "modelProvider": "openai",
            "createdAt": 1,
            "updatedAt": 1,
            "recencyAt": 1,
            "status": {"type": "idle"},
            "path": null,
            "cwd": "C:\\work",
            "cliVersion": "0.145.0",
            "source": "appServer",
            "threadSource": "user",
            "agentNickname": null,
            "agentRole": null,
            "gitInfo": null,
            "name": null,
            "turns": []
        })
    }

    fn canonical_collab_item(
        id: &str,
        tool: &str,
        status: &str,
        sender_thread_id: &str,
        receiver_thread_ids: &[&str],
    ) -> Value {
        json!({
            "id": id,
            "type": "collabAgentToolCall",
            "tool": tool,
            "status": status,
            "senderThreadId": sender_thread_id,
            "receiverThreadIds": receiver_thread_ids,
            "prompt": "Audit dependencies",
            "model": "gpt-5.6-terra",
            "reasoningEffort": "high",
            "agentsStates": {}
        })
    }

    fn canonical_item_started(thread_id: &str, turn_id: &str, item: Value) -> Value {
        json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "item": item,
            "startedAtMs": 1_000
        })
    }

    fn canonical_turn_params(thread_id: &str, turn_id: &str, status: &str) -> Value {
        json!({
            "threadId": thread_id,
            "turn": canonical_turn(turn_id, status)
        })
    }

    async fn routed_test_engine() -> (Arc<CodexEngine>, Arc<Db>, Arc<RecordingSink>) {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("portcode.db");
        let db = Arc::new(Db::open(&database_path).unwrap());
        db.create_session("session-1", "Codex chat", None, None, 1)
            .unwrap();
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(
            CodexAppServer::new(Default::default()),
            db.clone(),
            sink.clone(),
        );
        engine.routes.write().await.insert(
            "root-thread".to_string(),
            ThreadRoute {
                session_id: "session-1".to_string(),
                root_thread_id: "root-thread".to_string(),
                is_subagent: false,
                generation: Some(1),
                parent_thread_id: None,
                launch_turn_id: None,
            },
        );
        // Db owns the connection, so dropping the TempDir handle does not affect
        // the open test database on Windows.
        (engine, db, sink)
    }

    #[tokio::test]
    async fn realtime_sdp_is_desktop_only_ephemeral_and_generation_owned() {
        let (engine, db, sink) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "thread/realtime/sdp".to_owned(),
                params: json!({"threadId": "root-thread", "sdp": "v=0\r\nanswer"}),
                raw: json!({
                    "method": "thread/realtime/sdp",
                    "params": {"threadId": "root-thread", "sdp": "v=0\r\nanswer"}
                }),
            })
            .await;

        assert_eq!(
            sink.realtime_events.lock().unwrap().as_slice(),
            [(
                "codex-realtime://session-1".to_owned(),
                CodexRealtimeEvent::Sdp {
                    sdp: "v=0\r\nanswer".to_owned()
                }
            )]
        );
        assert!(sink.events.lock().unwrap().is_empty());
        assert!(db.codex_activity("session-1", 100).unwrap().is_empty());

        engine
            .handle_incoming(Incoming::Notification {
                generation: 2,
                method: "thread/realtime/sdp".to_owned(),
                params: json!({"threadId": "root-thread", "sdp": "v=0\r\nstale"}),
                raw: json!({}),
            })
            .await;
        assert_eq!(sink.realtime_events.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn realtime_audio_payloads_are_dropped_without_persistence() {
        let (engine, db, sink) = routed_test_engine().await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "thread/realtime/outputAudio/delta".to_owned(),
                params: json!({"threadId": "root-thread", "audio": "base64-secret"}),
                raw: json!({"secret": "base64-secret"}),
            })
            .await;

        assert!(sink.realtime_events.lock().unwrap().is_empty());
        assert!(sink.events.lock().unwrap().is_empty());
        assert!(db.codex_activity("session-1", 100).unwrap().is_empty());
    }

    #[tokio::test]
    async fn realtime_owner_drops_transcript_derived_activity_across_its_lineage() {
        let (engine, db, sink) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();
        assert!(
            engine
                .establish_child_route("voice-child", "root-thread", 1, None)
                .await
        );
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "thread/realtime/closed".to_owned(),
                params: json!({"threadId": "voice-child", "reason": "child finished"}),
                raw: json!({}),
            })
            .await;
        assert!(
            engine
                .owns_realtime_session("session-1", "root-thread", 1)
                .await
        );
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "thread/realtime/closed".to_owned(),
                params: json!({"threadId": "root-thread", "reason": "finished"}),
                raw: json!({"transcript": "must-not-persist"}),
            })
            .await;

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/plan/updated".to_owned(),
                params: json!({
                    "threadId": "voice-child",
                    "turnId": "realtime-derived-turn",
                    "explanation": "must-not-persist",
                    "plan": []
                }),
                raw: json!({"transcript": "must-not-persist"}),
            })
            .await;
        engine
            .handle_incoming(Incoming::ServerRequest {
                generation: 1,
                id: json!(7),
                method: "future/privateRequest".to_owned(),
                params: json!({
                    "threadId": "voice-child",
                    "turnId": "realtime-derived-turn",
                    "transcript": "must-not-persist"
                }),
                raw: json!({"transcript": "must-not-persist"}),
            })
            .await;

        assert!(sink.events.lock().unwrap().is_empty());
        assert!(db.codex_activity("session-1", 100).unwrap().is_empty());
        assert!(engine
            .realtime_quarantine
            .lock()
            .await
            .contains_key("session-1"));
        engine
            .claim_turn_session("run-after-voice", "session-1", None)
            .await
            .unwrap();
        assert!(engine
            .realtime_quarantine
            .lock()
            .await
            .contains_key("session-1"));
        activate_test_root_turn(&engine, 1, "normal-turn").await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/plan/updated".to_owned(),
                params: json!({
                    "threadId": "root-thread",
                    "turnId": "normal-turn",
                    "explanation": "safe normal turn",
                    "plan": []
                }),
                raw: json!({"safe": true}),
            })
            .await;
        assert!(!db.codex_activity("session-1", 100).unwrap().is_empty());
        engine.clear_stale_realtime_quarantine("session-1", 2).await;
        assert!(!engine
            .realtime_quarantine
            .lock()
            .await
            .contains_key("session-1"));
    }

    #[tokio::test]
    async fn realtime_lease_has_one_exact_session_owner() {
        let (engine, _, _) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();
        assert!(engine
            .claim_realtime_session("session-2", "other-thread", 1)
            .await
            .is_err());
        assert!(
            !engine
                .release_realtime_session("session-2", "other-thread", 1)
                .await
        );
        assert!(
            engine
                .release_realtime_session("session-1", "root-thread", 1)
                .await
        );
        engine
            .claim_realtime_session("session-2", "other-thread", 2)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn realtime_lease_rebinds_only_its_exact_owner_after_transport_restart() {
        let (engine, _, _) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();
        assert!(
            engine
                .owns_realtime_session("session-1", "root-thread", 1)
                .await
        );

        assert!(
            !engine
                .rebind_realtime_generation("session-2", "root-thread", 1, 2)
                .await
        );
        assert!(
            !engine
                .rebind_realtime_generation("session-1", "root-thread", 2, 3)
                .await
        );
        assert!(
            engine
                .rebind_realtime_generation("session-1", "root-thread", 1, 2)
                .await
        );
        assert!(
            !engine
                .owns_realtime_session("session-1", "root-thread", 1)
                .await
        );
        assert!(
            engine
                .owns_realtime_session("session-1", "root-thread", 2)
                .await
        );
        assert!(
            !engine
                .release_realtime_session("session-1", "root-thread", 1)
                .await
        );
        assert!(
            engine
                .release_realtime_session("session-1", "root-thread", 2)
                .await
        );
        assert!(
            !engine
                .owns_realtime_session("session-1", "root-thread", 2)
                .await
        );
    }

    #[tokio::test]
    async fn realtime_generation_adoption_reclaims_an_owner_released_by_transport_loss() {
        let (engine, _, _) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();
        assert!(
            engine
                .release_realtime_session("session-1", "root-thread", 1)
                .await
        );

        assert!(
            engine
                .adopt_restarted_realtime_generation("session-1", "root-thread", 1, 2)
                .await
        );
        assert!(
            engine
                .owns_realtime_session("session-1", "root-thread", 2)
                .await
        );
        assert_eq!(
            engine
                .realtime_quarantine
                .lock()
                .await
                .get("session-1")
                .map(|owner| owner.generation),
            Some(2)
        );
    }

    #[test]
    fn thread_capabilities_enable_realtime_without_internal_raw_response_events() {
        let mut params = Map::new();
        enable_raw_thread_events(&mut params);
        enable_realtime_thread_feature(&mut params);

        assert!(params.get("experimentalRawEvents").is_none());
        assert_eq!(
            params,
            Map::from_iter([(
                "config".to_owned(),
                json!({ "features.realtime_conversation": true }),
            )])
        );
    }

    #[tokio::test]
    async fn realtime_owner_blocks_only_its_session_from_normal_turn_admission() {
        let (engine, _, _) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();

        assert!(engine
            .claim_turn_session("run-1", "session-1", None)
            .await
            .is_err());
        engine
            .claim_turn_session("run-2", "session-2", None)
            .await
            .unwrap();
        assert!(engine
            .active_by_session
            .lock()
            .await
            .contains_key("session-2"));
    }

    #[tokio::test]
    async fn realtime_error_retains_its_owner_until_exact_close() {
        let (engine, db, sink) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();

        engine
            .handle_incoming(Incoming::Notification {
                generation: 2,
                method: "thread/realtime/closed".to_owned(),
                params: json!({"threadId": "root-thread", "reason": "stale"}),
                raw: json!({"secret": "must-not-persist"}),
            })
            .await;
        assert!(engine
            .claim_realtime_session("session-2", "other-thread", 2)
            .await
            .is_err());

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "thread/realtime/error".to_owned(),
                params: json!({"threadId": "root-thread", "message": "voice failed"}),
                raw: json!({"secret": "must-not-persist"}),
            })
            .await;
        assert!(engine
            .claim_realtime_session("session-2", "other-thread", 2)
            .await
            .is_err());
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "thread/realtime/closed".to_owned(),
                params: json!({"threadId": "root-thread", "reason": "failed"}),
                raw: json!({"secret": "must-not-persist"}),
            })
            .await;
        engine
            .claim_realtime_session("session-2", "other-thread", 2)
            .await
            .unwrap();

        assert_eq!(
            sink.realtime_events.lock().unwrap().as_slice(),
            [
                (
                    "codex-realtime://session-1".to_owned(),
                    CodexRealtimeEvent::Error {
                        message: "voice failed".to_owned()
                    }
                ),
                (
                    "codex-realtime://session-1".to_owned(),
                    CodexRealtimeEvent::Closed
                )
            ]
        );
        assert!(sink.events.lock().unwrap().is_empty());
        assert!(db.codex_activity("session-1", 100).unwrap().is_empty());
    }

    #[tokio::test]
    async fn realtime_closed_releases_its_owner_without_persistence() {
        let (engine, db, sink) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "thread/realtime/closed".to_owned(),
                params: json!({"threadId": "root-thread", "reason": "finished"}),
                raw: json!({"transcript": "must-not-persist"}),
            })
            .await;
        engine
            .claim_realtime_session("session-2", "other-thread", 2)
            .await
            .unwrap();

        assert_eq!(
            sink.realtime_events.lock().unwrap().as_slice(),
            [(
                "codex-realtime://session-1".to_owned(),
                CodexRealtimeEvent::Closed
            )]
        );
        assert!(sink.events.lock().unwrap().is_empty());
        assert!(db.codex_activity("session-1", 100).unwrap().is_empty());
    }

    #[tokio::test]
    async fn malformed_realtime_closed_does_not_release_or_emit_for_the_owner() {
        let (engine, db, sink) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();

        for params in [
            json!({"threadId": "root-thread"}),
            json!({"threadId": "root-thread", "reason": false}),
        ] {
            engine
                .handle_incoming(Incoming::Notification {
                    generation: 1,
                    method: "thread/realtime/closed".to_owned(),
                    params,
                    raw: json!({"transcript": "must-not-persist"}),
                })
                .await;
        }

        assert!(
            engine
                .owns_realtime_session("session-1", "root-thread", 1)
                .await
        );
        assert!(sink.realtime_events.lock().unwrap().is_empty());
        assert!(sink.events.lock().unwrap().is_empty());
        assert!(db.codex_activity("session-1", 100).unwrap().is_empty());
    }

    #[tokio::test]
    async fn realtime_quarantine_rejects_same_generation_restart_after_close() {
        let (engine, _, _) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();
        assert!(
            engine
                .release_realtime_session("session-1", "root-thread", 1)
                .await
        );

        assert!(engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .is_err());
        engine.clear_stale_realtime_quarantine("session-1", 2).await;
        engine
            .claim_realtime_session("session-1", "root-thread", 2)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn realtime_quarantine_allows_children_launched_by_the_exact_normal_turn() {
        let (engine, _, sink) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();
        assert!(
            engine
                .release_realtime_session("session-1", "root-thread", 1)
                .await
        );
        engine
            .claim_turn_session("run-normal", "session-1", None)
            .await
            .unwrap();
        activate_test_root_turn(&engine, 1, "normal-turn").await;
        assert!(
            engine
                .establish_child_route("normal-child", "root-thread", 1, Some("normal-turn"),)
                .await
        );

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/started".to_owned(),
                params: json!({
                    "threadId": "normal-child",
                    "turn": {"id": "normal-child-turn"}
                }),
                raw: json!({}),
            })
            .await;

        assert!(sink.events.lock().unwrap().iter().any(|(_, event)| {
            matches!(
                event,
                StreamEvent::AgentProgress {
                    agent_id,
                    current_turn_id: Some(turn_id),
                    ..
                } if agent_id == "normal-child" && turn_id == "normal-child-turn"
            )
        }));
    }

    #[tokio::test]
    async fn realtime_quarantine_defers_child_startup_until_the_normal_launch_is_owned() {
        let (engine, _, sink) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();
        assert!(
            engine
                .release_realtime_session("session-1", "root-thread", 1)
                .await
        );
        engine
            .claim_turn_session("run-normal", "session-1", None)
            .await
            .unwrap();
        activate_test_root_turn(&engine, 1, "normal-turn").await;

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/started".to_owned(),
                params: json!({
                    "threadId": "normal-child",
                    "turn": {"id": "normal-child-turn"}
                }),
                raw: json!({}),
            })
            .await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "thread/started".to_owned(),
                params: json!({
                    "thread": {
                        "id": "normal-child",
                        "parentThreadId": "root-thread"
                    }
                }),
                raw: json!({}),
            })
            .await;
        assert!(sink.events.lock().unwrap().is_empty());

        assert!(
            engine
                .establish_child_route("normal-child", "root-thread", 1, Some("normal-turn"),)
                .await
        );
        engine.drain_deferred("normal-child").await;

        assert!(sink.events.lock().unwrap().iter().any(|(_, event)| {
            matches!(
                event,
                StreamEvent::AgentProgress {
                    agent_id,
                    current_turn_id: Some(turn_id),
                    ..
                } if agent_id == "normal-child" && turn_id == "normal-child-turn"
            )
        }));
    }

    #[tokio::test]
    async fn realtime_quarantine_allows_nested_children_owned_by_the_normal_lineage() {
        let (engine, _, sink) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();
        assert!(
            engine
                .release_realtime_session("session-1", "root-thread", 1)
                .await
        );
        engine
            .claim_turn_session("run-normal", "session-1", None)
            .await
            .unwrap();
        activate_test_root_turn(&engine, 1, "normal-turn").await;
        assert!(
            engine
                .establish_child_route("normal-child", "root-thread", 1, Some("normal-turn"),)
                .await
        );
        engine.active_by_thread.lock().await.insert(
            "normal-child".to_owned(),
            ActiveThreadTurn {
                generation: 1,
                turn_id: "normal-child-turn".to_owned(),
            },
        );
        assert!(
            engine
                .establish_child_route(
                    "normal-grandchild",
                    "normal-child",
                    1,
                    Some("normal-child-turn"),
                )
                .await
        );

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/started".to_owned(),
                params: json!({
                    "threadId": "normal-grandchild",
                    "turn": {"id": "normal-grandchild-turn"}
                }),
                raw: json!({}),
            })
            .await;

        assert!(sink.events.lock().unwrap().iter().any(|(_, event)| {
            matches!(
                event,
                StreamEvent::AgentProgress {
                    agent_id,
                    current_turn_id: Some(turn_id),
                    ..
                } if agent_id == "normal-grandchild" && turn_id == "normal-grandchild-turn"
            )
        }));
    }

    #[tokio::test]
    async fn transport_close_releases_only_realtime_owner_from_that_generation() {
        let (engine, _, sink) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();

        engine.handle_transport_closed(2, "stale transport").await;
        assert!(engine
            .claim_realtime_session("session-2", "other-thread", 2)
            .await
            .is_err());

        engine
            .handle_transport_closed(1, "voice transport lost")
            .await;
        engine
            .claim_realtime_session("session-2", "other-thread", 2)
            .await
            .unwrap();
        assert!(sink.realtime_events.lock().unwrap().iter().any(|(channel, event)| {
            channel == "codex-realtime://session-1"
                && matches!(event, CodexRealtimeEvent::Error { message } if message.contains("voice transport lost"))
        }));
    }

    #[tokio::test]
    async fn shutdown_releases_the_realtime_owner_even_without_a_transport_event() {
        let (engine, _, _) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();

        engine.shutdown().await;

        engine
            .claim_realtime_session("session-2", "other-thread", 2)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn explicit_stop_retains_its_owner_until_the_terminal_event() {
        let (engine, db, _) = routed_test_engine().await;
        engine
            .claim_realtime_session("deleted-session", "root-thread", 1)
            .await
            .unwrap();

        let _ = engine.realtime_stop("deleted-session").await;
        assert!(engine
            .claim_realtime_session("session-2", "other-thread", 2)
            .await
            .is_err());
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "thread/realtime/closed".to_owned(),
                params: json!({"threadId": "root-thread", "reason": "stopped"}),
                raw: json!({"transcript": "must-not-persist"}),
            })
            .await;
        engine
            .claim_realtime_session("session-2", "other-thread", 2)
            .await
            .unwrap();
        assert!(db
            .codex_activity("deleted-session", 100)
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn stop_wait_completes_only_after_the_exact_owner_is_released() {
        let (engine, _, _) = routed_test_engine().await;
        engine
            .claim_realtime_session("session-1", "root-thread", 1)
            .await
            .unwrap();

        let (waited, released) = tokio::join!(
            engine.wait_for_realtime_release("session-1", "root-thread", 1),
            async {
                tokio::task::yield_now().await;
                engine
                    .release_realtime_session("session-1", "root-thread", 1)
                    .await
            }
        );

        assert!(released);
        assert!(waited.is_ok());
    }

    #[test]
    fn realtime_thread_identity_comes_only_from_the_session_binding() {
        let directory = tempfile::tempdir().unwrap();
        let db = Db::open(&directory.path().join("portcode.db")).unwrap();
        db.create_session("session-1", "Voice", None, None, 1)
            .unwrap();
        assert!(realtime_thread_id(&db, "session-1").is_err());
        db.bind_codex_thread("session-1", "owned-thread").unwrap();
        assert_eq!(
            realtime_thread_id(&db, "session-1").unwrap(),
            "owned-thread"
        );
        assert!(realtime_thread_id(&db, "unknown-session").is_err());
    }

    async fn activate_test_root_turn(engine: &CodexEngine, generation: u64, turn_id: &str) {
        engine.active_by_session.lock().await.insert(
            "session-1".to_string(),
            ActiveSessionTurn {
                run_id: format!("run-{turn_id}"),
                generation: Some(generation),
                turn_id: Some(turn_id.to_string()),
                _attachment_snapshot: None,
            },
        );
        engine.active_by_thread.lock().await.insert(
            "root-thread".to_string(),
            ActiveThreadTurn {
                generation,
                turn_id: turn_id.to_string(),
            },
        );
        engine.turns.lock().await.insert(
            turn_id.to_string(),
            TurnProjection::new(
                generation,
                "session-1".to_string(),
                "root-thread".to_string(),
                turn_id.to_string(),
            ),
        );
    }

    fn install_response_gate(
        engine: &CodexEngine,
        outcome: Result<(), String>,
    ) -> (
        tokio::sync::mpsc::UnboundedReceiver<(u64, Value, Value)>,
        Arc<tokio::sync::Semaphore>,
    ) {
        let (calls_tx, calls_rx) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let hook_release = Arc::clone(&release);
        let hook = Arc::new(move |generation, rpc_id, response| {
            let calls_tx = calls_tx.clone();
            let release = Arc::clone(&hook_release);
            let outcome = outcome.clone();
            Box::pin(async move {
                calls_tx
                    .send((generation, rpc_id, response))
                    .expect("response observer remains alive");
                let permit = release.acquire().await.expect("response gate remains open");
                permit.forget();
                outcome
            }) as TestResponseFuture
        });
        *engine.response_hook.lock().unwrap() = Some(hook);
        (calls_rx, release)
    }

    fn latest_native_request_id(sink: &RecordingSink) -> String {
        sink.events
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find_map(|(_, event)| match event {
                StreamEvent::PermissionRequest { id, .. }
                | StreamEvent::CodexRequest { id, .. } => Some(id.clone()),
                _ => None,
            })
            .expect("request UI event was emitted")
    }

    fn canonical_agent_message(id: &str, text: &str) -> Value {
        json!({
            "id": id,
            "type": "agentMessage",
            "text": text,
            "phase": "final_answer",
            "memoryCitation": null
        })
    }

    #[test]
    fn event_pump_shutdown_releases_active_attachment_snapshots() {
        assert!(tokio::runtime::Handle::try_current().is_err());

        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(CodexAppServer::new(Default::default()), db, sink);

        engine.start_event_pump();
        assert!(engine.event_pump.lock().unwrap().is_some());

        let snapshot = Arc::new(tempfile::tempdir().unwrap());
        let snapshot_path = snapshot.path().join("image-0.png");
        std::fs::write(&snapshot_path, b"snapshot").unwrap();
        let weak_snapshot = Arc::downgrade(&snapshot);
        tauri::async_runtime::block_on(async {
            engine.active_by_session.lock().await.insert(
                "active-session".to_string(),
                ActiveSessionTurn {
                    run_id: "active-run".to_string(),
                    generation: Some(1),
                    turn_id: Some("active-turn".to_string()),
                    _attachment_snapshot: Some(snapshot),
                },
            );
            engine.shutdown().await;
        });

        assert!(engine.event_pump.lock().unwrap().is_none());
        assert!(weak_snapshot.upgrade().is_none());
        assert!(!snapshot_path.exists());
        assert!(tauri::async_runtime::block_on(engine.active_by_session.lock()).is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_waits_for_admitted_turns_before_releasing_snapshots() {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = Arc::new(CodexEngine::new(
            CodexAppServer::new(Default::default()),
            db,
            sink,
        ));

        let snapshot = Arc::new(tempfile::tempdir().unwrap());
        let snapshot_path = snapshot.path().join("image-0.png");
        std::fs::write(&snapshot_path, b"snapshot").unwrap();
        let weak_snapshot = Arc::downgrade(&snapshot);
        engine.active_by_session.lock().await.insert(
            "active-session".to_string(),
            ActiveSessionTurn {
                run_id: "active-run".to_string(),
                generation: Some(1),
                turn_id: Some("active-turn".to_string()),
                _attachment_snapshot: Some(snapshot),
            },
        );

        // This shared guard represents a run_turn that passed admission but has not
        // yet finished dispatching its PreparedTurn into active native state.
        let admitted_turn = engine.shutdown_gate.read().await;
        let shutdown_engine = engine.clone();
        let shutdown = tokio::spawn(async move { shutdown_engine.shutdown().await });
        tokio::task::yield_now().await;

        assert!(!shutdown.is_finished());
        assert!(snapshot_path.exists());
        assert!(weak_snapshot.upgrade().is_some());

        drop(admitted_turn);
        tokio::time::timeout(Duration::from_secs(3), shutdown)
            .await
            .expect("shutdown should finish after admitted dispatches drain")
            .unwrap();

        assert!(*engine.shutdown_gate.read().await);
        assert!(engine.active_by_session.lock().await.is_empty());
        assert!(weak_snapshot.upgrade().is_none());
        assert!(!snapshot_path.exists());
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
    async fn unknown_subagent_turn_status_never_projects_success() {
        for turn in [
            json!({"id":"child-turn-missing"}),
            json!({"id":"child-turn-future","status":"pausedByProvider"}),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
            let sink = Arc::new(RecordingSink::default());
            let engine =
                CodexEngine::new(CodexAppServer::new(Default::default()), db, sink.clone());
            engine.routes.write().await.insert(
                "child-thread".to_string(),
                ThreadRoute {
                    session_id: "session-1".to_string(),
                    root_thread_id: "root-thread".to_string(),
                    is_subagent: true,
                    generation: Some(1),
                    parent_thread_id: Some("root-thread".to_string()),
                    launch_turn_id: Some("root-turn".to_string()),
                },
            );

            engine
                .dispatch_incoming(Incoming::Notification {
                    generation: 1,
                    method: "turn/completed".to_string(),
                    params: json!({"threadId":"child-thread","turn":turn}),
                    raw: json!({}),
                })
                .await;

            assert!(sink
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|(_, event)| matches!(
                    event,
                    StreamEvent::AgentFinished { agent_id, status, .. }
                        if agent_id == "child-thread" && status == "unknown"
                )));
        }
    }

    #[tokio::test]
    async fn child_turn_started_emits_real_correlated_progress() {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(CodexAppServer::new(Default::default()), db, sink.clone());
        engine.routes.write().await.insert(
            "root-thread".to_string(),
            ThreadRoute {
                session_id: "session-1".to_string(),
                root_thread_id: "root-thread".to_string(),
                is_subagent: false,
                generation: Some(1),
                parent_thread_id: None,
                launch_turn_id: None,
            },
        );

        engine
            .dispatch_incoming(Incoming::Notification {
                generation: 1,
                method: "item/started".to_string(),
                params: canonical_item_started(
                    "root-thread",
                    "root-turn",
                    canonical_collab_item(
                        "collab-1",
                        "spawnAgent",
                        "inProgress",
                        "root-thread",
                        &["child-thread"],
                    ),
                ),
                raw: json!({}),
            })
            .await;

        for child_turn_id in ["child-turn-1", "child-turn-2"] {
            engine
                .dispatch_incoming(Incoming::Notification {
                    generation: 1,
                    method: "turn/started".to_string(),
                    params: json!({
                        "threadId":"child-thread",
                        "turn":{"id":child_turn_id,"status":"inProgress","items":[]}
                    }),
                    raw: json!({}),
                })
                .await;
        }

        let progress = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(_, event)| {
                let value = serde_json::to_value(event).unwrap();
                (value["type"] == "agent_progress").then_some(value)
            })
            .collect::<Vec<_>>();
        assert_eq!(progress.len(), 2);
        assert_eq!(progress[0]["agentId"], "child-thread");
        assert_eq!(progress[0]["parentThreadId"], "root-thread");
        assert_eq!(progress[0]["launchTurnId"], "root-turn");
        assert_eq!(progress[0]["currentTurnId"], "child-turn-1");
        assert_eq!(progress[0]["turnCount"], 1);
        assert_eq!(progress[1]["currentTurnId"], "child-turn-2");
        assert_eq!(progress[1]["turnCount"], 2);
    }

    #[tokio::test]
    async fn child_terminal_result_uses_final_agent_message() {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(CodexAppServer::new(Default::default()), db, sink.clone());
        engine.routes.write().await.insert(
            "root-thread".to_string(),
            ThreadRoute {
                session_id: "session-1".to_string(),
                root_thread_id: "root-thread".to_string(),
                is_subagent: false,
                generation: Some(1),
                parent_thread_id: None,
                launch_turn_id: None,
            },
        );
        engine
            .dispatch_incoming(Incoming::Notification {
                generation: 1,
                method: "item/started".to_string(),
                params: json!({
                    "threadId":"root-thread",
                    "turnId":"root-turn",
                    "item":{
                        "id":"collab-1",
                        "type":"collabAgentToolCall",
                        "tool":"spawnAgent",
                        "status":"inProgress",
                        "senderThreadId":"root-thread",
                        "receiverThreadIds":["child-thread"],
                        "prompt":"Audit dependencies",
                        "model":null,
                        "reasoningEffort":null,
                        "agentsStates":{}
                    }
                }),
                raw: json!({}),
            })
            .await;
        engine
            .dispatch_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/started".to_string(),
                params: json!({
                    "threadId":"child-thread",
                    "turn":{"id":"child-turn-1","status":"inProgress","items":[]}
                }),
                raw: json!({}),
            })
            .await;
        engine
            .dispatch_incoming(Incoming::Notification {
                generation: 1,
                method: "item/completed".to_string(),
                params: json!({
                    "threadId":"child-thread",
                    "turnId":"child-turn-1",
                    "item":{
                        "id":"message-1",
                        "type":"agentMessage",
                        "text":"audit complete",
                        "phase":"final_answer"
                    }
                }),
                raw: json!({}),
            })
            .await;
        engine
            .dispatch_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/completed".to_string(),
                params: json!({
                    "threadId":"child-thread",
                    "turn":{"id":"child-turn-1","status":"completed","items":[]}
                }),
                raw: json!({}),
            })
            .await;

        let finished = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(_, event)| {
                let value = serde_json::to_value(event).unwrap();
                (value["type"] == "agent_finished").then_some(value)
            })
            .next_back()
            .unwrap();
        assert_eq!(finished["agentId"], "child-thread");
        assert_eq!(finished["result"], "audit complete");
        assert!(!sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::TextDelta { text } if text.contains("audit complete")
            )));
    }

    #[tokio::test]
    async fn collab_state_message_is_preserved_as_terminal_result() {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(CodexAppServer::new(Default::default()), db, sink.clone());
        engine.routes.write().await.insert(
            "root-thread".to_string(),
            ThreadRoute {
                session_id: "session-1".to_string(),
                root_thread_id: "root-thread".to_string(),
                is_subagent: false,
                generation: Some(1),
                parent_thread_id: None,
                launch_turn_id: None,
            },
        );

        engine
            .dispatch_incoming(Incoming::Notification {
                generation: 1,
                method: "item/completed".to_string(),
                params: json!({
                    "threadId":"root-thread",
                    "turnId":"root-turn",
                    "item":{
                        "id":"collab-1",
                        "type":"collabAgentToolCall",
                        "tool":"spawnAgent",
                        "status":"completed",
                        "senderThreadId":"root-thread",
                        "receiverThreadIds":["child-thread"],
                        "prompt":"Audit dependencies",
                        "model":null,
                        "reasoningEffort":null,
                        "agentsStates":{
                            "child-thread":{
                                "status":"completed",
                                "message":"Found 3 issues"
                            }
                        }
                    }
                }),
                raw: json!({}),
            })
            .await;

        let finished = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(_, event)| {
                let value = serde_json::to_value(event).unwrap();
                (value["type"] == "agent_finished").then_some(value)
            })
            .next_back()
            .unwrap();
        assert_eq!(finished["agentId"], "child-thread");
        assert_eq!(finished["status"], "ok");
        assert_eq!(finished["result"], "Found 3 issues");
    }

    #[tokio::test]
    async fn thread_started_recovery_preserves_parent_and_launch_turn() {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(CodexAppServer::new(Default::default()), db, sink.clone());
        engine.routes.write().await.insert(
            "root-thread".to_string(),
            ThreadRoute {
                session_id: "session-1".to_string(),
                root_thread_id: "root-thread".to_string(),
                is_subagent: false,
                generation: Some(1),
                parent_thread_id: None,
                launch_turn_id: None,
            },
        );

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "thread/started".to_string(),
                params: json!({
                    "thread": canonical_thread("child-thread", Some("root-thread"))
                }),
                raw: json!({}),
            })
            .await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "item/started".to_string(),
                params: json!({
                    "threadId":"root-thread",
                    "turnId":"root-turn",
                    "item":{
                        "id":"collab-1",
                        "type":"collabAgentToolCall",
                        "tool":"spawnAgent",
                        "status":"inProgress",
                        "senderThreadId":"root-thread",
                        "receiverThreadIds":["child-thread"],
                        "prompt":"Audit dependencies",
                        "model":"gpt-5.6-terra",
                        "reasoningEffort":"high",
                        "agentsStates":{}
                    }
                }),
                raw: json!({}),
            })
            .await;

        let starts = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(_, event)| {
                let value = serde_json::to_value(event).unwrap();
                (value["type"] == "agent_started" && value["agentId"] == "child-thread")
                    .then_some(value)
            })
            .collect::<Vec<_>>();
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0]["parentThreadId"], "root-thread");
        assert_eq!(starts[0]["launchTurnId"], "root-turn");
        assert_eq!(starts[0]["model"], "gpt-5.6-terra");
        assert_eq!(starts[0]["reasoningEffort"], "high");
    }

    #[tokio::test]
    async fn stale_generation_cannot_mutate_or_fill_child_routes() {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(CodexAppServer::new(Default::default()), db, sink.clone());
        engine.routes.write().await.insert(
            "root-thread".to_string(),
            ThreadRoute {
                session_id: "session-1".to_string(),
                root_thread_id: "root-thread".to_string(),
                is_subagent: false,
                generation: Some(2),
                parent_thread_id: None,
                launch_turn_id: None,
            },
        );
        engine.routes.write().await.insert(
            "current-child".to_string(),
            ThreadRoute {
                session_id: "session-1".to_string(),
                root_thread_id: "root-thread".to_string(),
                is_subagent: true,
                generation: Some(2),
                parent_thread_id: Some("root-thread".to_string()),
                launch_turn_id: Some("root-turn-2".to_string()),
            },
        );

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/started".to_string(),
                params: json!({
                    "threadId":"current-child",
                    "turn":{"id":"stale-child-turn","status":"inProgress","items":[]}
                }),
                raw: json!({}),
            })
            .await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "thread/started".to_string(),
                params: json!({
                    "thread":{"id":"stale-child","parentThreadId":"root-thread"}
                }),
                raw: json!({}),
            })
            .await;

        assert!(!engine
            .active_by_thread
            .lock()
            .await
            .contains_key("current-child"));
        assert!(!engine.routes.read().await.contains_key("stale-child"));
        assert!(!engine
            .deferred_by_thread
            .lock()
            .await
            .contains_key("stale-child"));
        assert!(!sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::AgentProgress { agent_id, .. } if agent_id == "current-child"
            )));
    }

    #[tokio::test]
    async fn stale_pre_route_child_events_are_rechecked_when_route_arrives() {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(CodexAppServer::new(Default::default()), db, sink.clone());

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/started".to_string(),
                params: json!({
                    "threadId":"deferred-child",
                    "turn":{"id":"stale-child-turn","status":"inProgress","items":[]}
                }),
                raw: json!({}),
            })
            .await;
        engine.routes.write().await.insert(
            "root-thread".to_string(),
            ThreadRoute {
                session_id: "session-1".to_string(),
                root_thread_id: "root-thread".to_string(),
                is_subagent: false,
                generation: Some(2),
                parent_thread_id: None,
                launch_turn_id: None,
            },
        );
        engine
            .handle_incoming(Incoming::Notification {
                generation: 2,
                method: "item/started".to_string(),
                params: json!({
                    "threadId":"root-thread",
                    "turnId":"root-turn",
                    "item":{
                        "id":"collab-1",
                        "type":"collabAgentToolCall",
                        "tool":"spawnAgent",
                        "status":"inProgress",
                        "senderThreadId":"root-thread",
                        "receiverThreadIds":["deferred-child"],
                        "prompt":"Audit dependencies",
                        "model":null,
                        "reasoningEffort":null,
                        "agentsStates":{}
                    }
                }),
                raw: json!({}),
            })
            .await;

        assert!(!engine
            .active_by_thread
            .lock()
            .await
            .contains_key("deferred-child"));
        assert!(!sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::AgentProgress { agent_id, .. } if agent_id == "deferred-child"
            )));
    }

    #[tokio::test]
    async fn deferred_child_queue_overflow_emits_an_honest_warning() {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(CodexAppServer::new(Default::default()), db, sink.clone());
        engine.routes.write().await.insert(
            "root-thread".to_string(),
            ThreadRoute {
                session_id: "session-1".to_string(),
                root_thread_id: "root-thread".to_string(),
                is_subagent: false,
                generation: Some(1),
                parent_thread_id: None,
                launch_turn_id: None,
            },
        );

        for index in 0..513 {
            engine
                .handle_incoming(Incoming::Notification {
                    generation: 1,
                    method: "turn/started".to_string(),
                    params: json!({
                        "threadId":"unrouted-child",
                        "turn":{"id":format!("child-turn-{index}"),"status":"inProgress","items":[]}
                    }),
                    raw: json!({}),
                })
                .await;
        }

        assert_eq!(
            engine.deferred_by_thread.lock().await["unrouted-child"].len(),
            512
        );
        assert!(sink.events.lock().unwrap().iter().any(|(_, event)| {
            let value = serde_json::to_value(event).unwrap();
            value["type"] == "codex_event" && value["method"] == "portcode/codexBridge/warning"
        }));
    }

    #[tokio::test]
    async fn collab_routing_cannot_capture_self_or_cross_session_threads() {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(CodexAppServer::new(Default::default()), db, sink.clone());
        for (thread_id, session_id) in [("root-a", "session-a"), ("root-b", "session-b")] {
            engine.routes.write().await.insert(
                thread_id.to_string(),
                ThreadRoute {
                    session_id: session_id.to_string(),
                    root_thread_id: thread_id.to_string(),
                    is_subagent: false,
                    generation: Some(1),
                    parent_thread_id: None,
                    launch_turn_id: None,
                },
            );
        }

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "item/started".to_string(),
                params: json!({
                    "threadId":"root-a",
                    "turnId":"turn-a",
                    "item":{
                        "id":"collab-1",
                        "type":"collabAgentToolCall",
                        "tool":"spawnAgent",
                        "status":"inProgress",
                        "senderThreadId":"root-a",
                        "receiverThreadIds":["root-a","root-b","valid-child"],
                        "prompt":"Audit dependencies",
                        "model":null,
                        "reasoningEffort":null,
                        "agentsStates":{}
                    }
                }),
                raw: json!({}),
            })
            .await;

        let routes = engine.routes.read().await;
        assert_eq!(routes["root-a"].session_id, "session-a");
        assert!(!routes["root-a"].is_subagent);
        assert_eq!(routes["root-b"].session_id, "session-b");
        assert!(!routes["root-b"].is_subagent);
        assert_eq!(routes["valid-child"].session_id, "session-a");
        drop(routes);
        let starts = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, event)| matches!(event, StreamEvent::AgentStarted { .. }))
            .count();
        assert_eq!(starts, 1);
    }

    #[tokio::test]
    async fn subagent_activity_cannot_capture_a_cross_session_thread() {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(CodexAppServer::new(Default::default()), db, sink.clone());
        for (thread_id, session_id) in [("root-a", "session-a"), ("root-b", "session-b")] {
            engine.routes.write().await.insert(
                thread_id.to_string(),
                ThreadRoute {
                    session_id: session_id.to_string(),
                    root_thread_id: thread_id.to_string(),
                    is_subagent: false,
                    generation: Some(1),
                    parent_thread_id: None,
                    launch_turn_id: None,
                },
            );
        }

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "item/started".to_string(),
                params: json!({
                    "threadId":"root-a",
                    "turnId":"turn-a",
                    "item":{
                        "id":"activity-1",
                        "type":"subAgentActivity",
                        "kind":"started",
                        "agentThreadId":"root-b",
                        "agentPath":"audit"
                    }
                }),
                raw: json!({}),
            })
            .await;

        let routes = engine.routes.read().await;
        assert_eq!(routes["root-b"].session_id, "session-b");
        assert!(!routes["root-b"].is_subagent);
        drop(routes);
        assert!(!sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::AgentStarted { agent_id, .. } if agent_id == "root-b"
            )));
    }

    #[tokio::test]
    async fn subagent_activity_does_not_invent_child_turn_progress() {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(CodexAppServer::new(Default::default()), db, sink.clone());
        engine.routes.write().await.insert(
            "root-thread".to_string(),
            ThreadRoute {
                session_id: "session-1".to_string(),
                root_thread_id: "root-thread".to_string(),
                is_subagent: false,
                generation: Some(1),
                parent_thread_id: None,
                launch_turn_id: None,
            },
        );

        engine
            .dispatch_incoming(Incoming::Notification {
                generation: 1,
                method: "item/started".to_string(),
                params: json!({
                    "threadId":"root-thread",
                    "turnId":"root-turn",
                    "item":{
                        "id":"activity-1",
                        "type":"subAgentActivity",
                        "kind":"interacted",
                        "agentThreadId":"child-thread",
                        "agentPath":"audit"
                    }
                }),
                raw: json!({}),
            })
            .await;
        engine
            .dispatch_incoming(Incoming::Notification {
                generation: 1,
                method: "item/completed".to_string(),
                params: json!({
                    "threadId":"root-thread",
                    "turnId":"root-turn",
                    "item":{
                        "id":"collab-1",
                        "type":"collabAgentToolCall",
                        "tool":"spawnAgent",
                        "status":"completed",
                        "senderThreadId":"root-thread",
                        "receiverThreadIds":["child-thread"],
                        "prompt":"Audit dependencies",
                        "model":null,
                        "reasoningEffort":null,
                        "agentsStates":{"child-thread":{"status":"running","message":null}}
                    }
                }),
                raw: json!({}),
            })
            .await;

        assert!(!sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::AgentProgress { agent_id, .. } if agent_id == "child-thread"
            )));
    }

    #[tokio::test]
    async fn agents_states_preserve_exact_provider_terminal_statuses() {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(&directory.path().join("portcode.db")).unwrap());
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(CodexAppServer::new(Default::default()), db, sink.clone());
        engine.routes.write().await.insert(
            "root-thread".to_string(),
            ThreadRoute {
                session_id: "session-1".to_string(),
                root_thread_id: "root-thread".to_string(),
                is_subagent: false,
                generation: Some(1),
                parent_thread_id: None,
                launch_turn_id: None,
            },
        );
        engine
            .dispatch_incoming(Incoming::Notification {
                generation: 1,
                method: "item/completed".to_string(),
                params: json!({
                    "threadId":"root-thread",
                    "turnId":"root-turn",
                    "item":{
                        "id":"collab-1",
                        "type":"collabAgentToolCall",
                        "tool":"spawnAgent",
                        "status":"completed",
                        "senderThreadId":"root-thread",
                        "receiverThreadIds":["child-a","child-b"],
                        "prompt":"Audit dependencies",
                        "model":null,
                        "reasoningEffort":null,
                        "agentsStates":{
                            "child-a":{"status":"shutdown","message":null},
                            "child-b":{"status":"notFound","message":null}
                        }
                    }
                }),
                raw: json!({}),
            })
            .await;

        let finished = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(_, event)| {
                let value = serde_json::to_value(event).unwrap();
                let agent_id = value.get("agentId")?.as_str()?.to_string();
                (value["type"] == "agent_finished").then_some((agent_id, value))
            })
            .collect::<HashMap<_, _>>();
        assert_eq!(finished.len(), 2);
        assert_eq!(finished["child-a"]["status"], "ok");
        assert_eq!(finished["child-a"]["providerStatus"], "shutdown");
        assert_eq!(finished["child-b"]["status"], "error");
        assert_eq!(finished["child-b"]["providerStatus"], "notFound");
    }

    #[tokio::test]
    async fn terminal_monotonicity_is_scoped_to_the_canonical_child_turn() {
        let (engine, _, sink) = routed_test_engine().await;
        engine.routes.write().await.insert(
            "child-thread".to_string(),
            ThreadRoute {
                session_id: "session-1".to_string(),
                root_thread_id: "root-thread".to_string(),
                is_subagent: true,
                generation: Some(1),
                parent_thread_id: Some("root-thread".to_string()),
                launch_turn_id: Some("root-turn".to_string()),
            },
        );
        for (method, turn_id, status) in [
            ("turn/started", "child-turn-1", "inProgress"),
            ("turn/completed", "child-turn-1", "completed"),
            ("turn/started", "child-turn-1", "inProgress"),
            ("turn/started", "child-turn-2", "inProgress"),
        ] {
            engine
                .dispatch_incoming(Incoming::Notification {
                    generation: 1,
                    method: method.to_string(),
                    params: canonical_turn_params("child-thread", turn_id, status),
                    raw: Value::Null,
                })
                .await;
        }

        assert_eq!(
            engine.active_by_thread.lock().await["child-thread"].turn_id,
            "child-turn-2"
        );
        let child_turn_1_progress = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, event)| {
                matches!(
                    event,
                    StreamEvent::AgentProgress { current_turn_id, .. }
                        if current_turn_id.as_deref() == Some("child-turn-1")
                )
            })
            .count();
        assert_eq!(child_turn_1_progress, 1);
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
                _attachment_snapshot: None,
            },
        );
        engine.active_by_session.lock().await.insert(
            "shared-session".to_string(),
            ActiveSessionTurn {
                run_id: "replacement-run".to_string(),
                generation: Some(2),
                turn_id: Some("replacement-turn".to_string()),
                _attachment_snapshot: None,
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
        engine.failed_root_retention_order.lock().await.extend([
            (
                1,
                "old-session".to_string(),
                "old-thread".to_string(),
                "old-turn".to_string(),
            ),
            (
                2,
                "shared-session".to_string(),
                "replacement-thread".to_string(),
                "replacement-turn".to_string(),
            ),
        ]);
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
                generation: Some(1),
                parent_thread_id: Some("old-thread".to_string()),
                launch_turn_id: Some("old-turn".to_string()),
            },
        );
        engine.pending_requests.lock().await.insert(
            "approval-1".to_string(),
            PendingServerRequest {
                generation: 1,
                rpc_id: json!(9),
                acceptance_key: "approval-1".to_string(),
                claimed: false,
                method: "item/fileChange/requestApproval".to_string(),
                params: json!({}),
                session_id: "old-session".to_string(),
                thread_id: "old-thread".to_string(),
                turn_id: "old-turn".to_string(),
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
        assert_eq!(
            engine
                .failed_root_retention_order
                .lock()
                .await
                .iter()
                .map(|(generation, _, _, turn_id)| (*generation, turn_id.as_str()))
                .collect::<Vec<_>>(),
            vec![(2, "replacement-turn")]
        );

        let events = sink.events.lock().unwrap();
        assert!(events.iter().any(|(_, event)| matches!(
            event,
            StreamEvent::AgentFinished { agent_id, status, .. }
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

    #[tokio::test]
    async fn generation_close_retires_child_routes_and_allows_same_child_reuse() {
        let (engine, _, sink) = routed_test_engine().await;
        let root_route = engine.routes.read().await["root-thread"].clone();
        engine
            .register_collab_routes(
                &root_route,
                "root-turn-1",
                &canonical_collab_item(
                    "spawn-generation-1",
                    "spawnAgent",
                    "inProgress",
                    "root-thread",
                    &["reused-child"],
                ),
            )
            .await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/started".to_string(),
                params: canonical_turn_params(
                    "deferred-generation-1",
                    "deferred-turn",
                    "inProgress",
                ),
                raw: Value::Null,
            })
            .await;
        assert_eq!(
            engine.routes.read().await["reused-child"].generation,
            Some(1)
        );
        assert!(engine
            .deferred_by_thread
            .lock()
            .await
            .contains_key("deferred-generation-1"));

        engine
            .handle_transport_closed(1, "generation replaced")
            .await;
        assert!(!engine.routes.read().await.contains_key("reused-child"));
        assert!(!engine
            .deferred_by_thread
            .lock()
            .await
            .contains_key("deferred-generation-1"));

        engine
            .register_root_route("session-1", "root-thread", 2)
            .await;
        let replacement_root = engine.routes.read().await["root-thread"].clone();
        engine
            .register_collab_routes(
                &replacement_root,
                "root-turn-2",
                &canonical_collab_item(
                    "spawn-generation-2",
                    "spawnAgent",
                    "inProgress",
                    "root-thread",
                    &["reused-child"],
                ),
            )
            .await;

        let routes = engine.routes.read().await;
        assert_eq!(routes["reused-child"].generation, Some(2));
        assert_eq!(
            routes["reused-child"].parent_thread_id.as_deref(),
            Some("root-thread")
        );
        drop(routes);
        assert_eq!(
            sink.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, event)| matches!(
                    event,
                    StreamEvent::AgentStarted { agent_id, .. } if agent_id == "reused-child"
                ))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn reused_turn_id_cannot_cross_session_or_thread_ownership() {
        let (engine, db, sink) = routed_test_engine().await;
        db.create_session("session-2", "Second Codex chat", None, None, 2)
            .unwrap();
        engine.routes.write().await.insert(
            "thread-b".to_string(),
            ThreadRoute {
                session_id: "session-2".to_string(),
                root_thread_id: "thread-b".to_string(),
                is_subagent: false,
                generation: Some(1),
                parent_thread_id: None,
                launch_turn_id: None,
            },
        );
        engine.turns.lock().await.insert(
            "reused-turn".to_string(),
            TurnProjection::new(
                1,
                "session-1".to_string(),
                "root-thread".to_string(),
                "reused-turn".to_string(),
            ),
        );

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "item/agentMessage/delta".to_string(),
                params: json!({
                    "threadId": "thread-b",
                    "turnId": "reused-turn",
                    "itemId": "message-b",
                    "delta": "CROSS_SESSION_DELTA_SENTINEL"
                }),
                raw: Value::Null,
            })
            .await;

        assert!(engine.turns.lock().await["reused-turn"].items.is_empty());
        assert!(!sink.events.lock().unwrap().iter().any(|(channel, event)| {
            channel == "agent://session-2"
                && matches!(
                    event,
                    StreamEvent::TextDelta { text }
                        if text.contains("CROSS_SESSION_DELTA_SENTINEL")
                )
        }));
        assert!(!serde_json::to_string(&sink.events.lock().unwrap().clone())
            .unwrap()
            .contains("CROSS_SESSION_DELTA_SENTINEL"));
        assert!(
            !serde_json::to_string(&db.codex_activity("session-2", 100).unwrap())
                .unwrap()
                .contains("CROSS_SESSION_DELTA_SENTINEL")
        );
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
                canonical_collab_item(
                    "a",
                    "spawnAgent",
                    "inProgress",
                    "root-thread",
                    &["child-thread"],
                ),
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

    #[tokio::test]
    async fn approvals_and_structured_requests_require_an_exact_active_owner() {
        let (engine, _, sink) = routed_test_engine().await;
        for (rpc_id, method) in [
            (31, "item/commandExecution/requestApproval"),
            (32, "item/tool/requestUserInput"),
        ] {
            engine
                .handle_server_request(
                    1,
                    json!(rpc_id),
                    method,
                    json!({
                        "threadId": "root-thread",
                        "turnId": "route-only-turn",
                        "itemId": format!("request-{rpc_id}"),
                        "availableDecisions": ["accept", "decline"],
                        "questions": []
                    }),
                    Value::Null,
                )
                .await;
        }

        assert!(engine.pending_requests.lock().await.is_empty());
        assert!(!sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::PermissionRequest { .. } | StreamEvent::CodexRequest { .. }
            )));
    }

    #[tokio::test]
    async fn projection_absent_completion_retires_only_the_exact_turn_request() {
        let (engine, _, _) = routed_test_engine().await;
        activate_test_root_turn(&engine, 1, "projection-absent-turn").await;
        engine
            .handle_server_request(
                1,
                json!(33),
                "item/commandExecution/requestApproval",
                json!({
                    "threadId": "root-thread",
                    "turnId": "projection-absent-turn",
                    "itemId": "request-projection-absent",
                    "availableDecisions": ["accept", "decline"]
                }),
                Value::Null,
            )
            .await;
        let owned_request_id = engine
            .pending_requests
            .lock()
            .await
            .keys()
            .next()
            .cloned()
            .expect("exact request was accepted while its owner was active");
        engine.pending_requests.lock().await.insert(
            "newer-request".to_string(),
            PendingServerRequest {
                generation: 1,
                rpc_id: json!(34),
                acceptance_key: "newer-request-key".to_string(),
                claimed: false,
                method: "item/commandExecution/requestApproval".to_string(),
                params: json!({"turnId":"newer-turn"}),
                session_id: "session-1".to_string(),
                thread_id: "root-thread".to_string(),
                turn_id: "newer-turn".to_string(),
            },
        );
        engine.turns.lock().await.remove("projection-absent-turn");

        let route = engine.routes.read().await["root-thread"].clone();
        engine
            .complete_turn(
                1,
                &route,
                &canonical_turn_params("root-thread", "projection-absent-turn", "completed"),
            )
            .await;

        let pending = engine.pending_requests.lock().await;
        assert!(!pending.contains_key(&owned_request_id));
        assert!(pending.contains_key("newer-request"));
        drop(pending);
        let (mut calls, _release) = install_response_gate(&engine, Ok(()));
        assert!(engine
            .resolve_approval(&owned_request_id, true, false)
            .await
            .is_err());
        assert!(calls.try_recv().is_err());
    }

    #[tokio::test]
    async fn transport_terminal_waits_for_the_request_lifecycle_owner() {
        let (engine, _, _) = routed_test_engine().await;
        activate_test_root_turn(&engine, 1, "transport-turn").await;
        engine
            .handle_server_request(
                1,
                json!(35),
                "item/commandExecution/requestApproval",
                json!({
                    "threadId": "root-thread",
                    "turnId": "transport-turn",
                    "itemId": "transport-request",
                    "availableDecisions": ["accept", "decline"]
                }),
                Value::Null,
            )
            .await;
        let request_id = engine
            .pending_requests
            .lock()
            .await
            .keys()
            .next()
            .cloned()
            .unwrap();
        let (mut calls, release) = install_response_gate(&engine, Ok(()));
        let resolving_engine = Arc::clone(&engine);
        let resolving = tokio::spawn(async move {
            resolving_engine
                .resolve_approval(&request_id, true, false)
                .await
        });
        calls
            .recv()
            .await
            .expect("response owns the lifecycle lock");

        let closing_engine = Arc::clone(&engine);
        let mut closing = tokio::spawn(async move {
            closing_engine
                .handle_transport_closed(1, "deterministic transport close")
                .await;
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(25), &mut closing)
                .await
                .is_err()
        );

        release.add_permits(1);
        assert!(resolving.await.unwrap().is_ok());
        closing.await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_allow_and_deny_claim_one_native_approval() {
        let (engine, _, sink) = routed_test_engine().await;
        activate_test_root_turn(&engine, 1, "root-turn").await;
        engine
            .handle_server_request(
                1,
                json!(41),
                "item/commandExecution/requestApproval",
                json!({
                    "threadId": "root-thread",
                    "turnId": "root-turn",
                    "itemId": "command-1",
                    "command": "cargo test --workspace",
                    "cwd": "C:\\work",
                    "reason": "Run the verified workspace suite",
                    "availableDecisions": ["accept", "decline"]
                }),
                Value::Null,
            )
            .await;
        let request_id = latest_native_request_id(&sink);
        let (mut calls, release) = install_response_gate(&engine, Ok(()));

        let first_engine = Arc::clone(&engine);
        let first_id = request_id.clone();
        let first =
            tokio::spawn(
                async move { first_engine.resolve_approval(&first_id, true, false).await },
            );
        let first_call = calls
            .recv()
            .await
            .expect("first response reached transport");
        assert_eq!(first_call.0, 1);
        assert_eq!(first_call.1, json!(41));

        let second_engine = Arc::clone(&engine);
        let second_id = request_id.clone();
        let mut second = tokio::spawn(async move {
            second_engine
                .resolve_approval(&second_id, false, false)
                .await
        });
        let mut second_result = None;
        let second_reached_transport = tokio::select! {
            call = calls.recv() => {
                assert_eq!(call.expect("second transport call").1, json!(41));
                true
            }
            joined = &mut second => {
                second_result = Some(joined.expect("second resolver task completed"));
                false
            }
        };
        release.add_permits(2);
        let first_result = first.await.expect("first resolver task completed");
        let second_result = match second_result {
            Some(result) => result,
            None => second.await.expect("second resolver task completed"),
        };

        assert!(!second_reached_transport);
        assert_eq!(
            usize::from(first_result.is_ok()) + usize::from(second_result.is_ok()),
            1
        );
        assert!(calls.try_recv().is_err());
    }

    #[tokio::test]
    async fn concurrent_structured_submits_claim_one_native_request() {
        let (engine, _, sink) = routed_test_engine().await;
        activate_test_root_turn(&engine, 1, "root-turn").await;
        engine
            .handle_server_request(
                1,
                json!(42),
                "item/tool/requestUserInput",
                json!({
                    "threadId": "root-thread",
                    "turnId": "root-turn",
                    "itemId": "question-1",
                    "questions": [{
                        "id": "choice",
                        "header": "Mode",
                        "question": "Pick a mode",
                        "options": [
                            {"label": "Fast", "description": "Use fast mode"},
                            {"label": "Standard", "description": "Use standard mode"}
                        ]
                    }]
                }),
                Value::Null,
            )
            .await;
        let request_id = latest_native_request_id(&sink);
        let (mut calls, release) = install_response_gate(&engine, Ok(()));

        let first_engine = Arc::clone(&engine);
        let first_id = request_id.clone();
        let first = tokio::spawn(async move {
            first_engine
                .resolve_codex_request(
                    &first_id,
                    json!({"answers":{"choice":{"answers":["Fast"]}}}),
                )
                .await
        });
        assert_eq!(
            calls
                .recv()
                .await
                .expect("first response reached transport")
                .1,
            json!(42)
        );

        let second_engine = Arc::clone(&engine);
        let second_id = request_id.clone();
        let mut second = tokio::spawn(async move {
            second_engine
                .resolve_codex_request(
                    &second_id,
                    json!({"answers":{"choice":{"answers":["Standard"]}}}),
                )
                .await
        });
        let mut second_result = None;
        let second_reached_transport = tokio::select! {
            call = calls.recv() => {
                assert_eq!(call.expect("second transport call").1, json!(42));
                true
            }
            joined = &mut second => {
                second_result = Some(joined.expect("second resolver task completed"));
                false
            }
        };
        release.add_permits(2);
        let first_result = first.await.expect("first resolver task completed");
        let second_result = match second_result {
            Some(result) => result,
            None => second.await.expect("second resolver task completed"),
        };

        assert!(!second_reached_transport);
        assert_eq!(
            usize::from(first_result.is_ok()) + usize::from(second_result.is_ok()),
            1
        );
        assert!(calls.try_recv().is_err());
    }

    #[tokio::test]
    async fn response_send_failure_restores_only_the_same_request_acceptance() {
        let (engine, _, sink) = routed_test_engine().await;
        activate_test_root_turn(&engine, 1, "root-turn").await;
        engine
            .handle_server_request(
                1,
                json!(43),
                "item/fileChange/requestApproval",
                json!({
                    "threadId": "root-thread",
                    "turnId": "root-turn",
                    "itemId": "patch-1",
                    "reason": "Apply the reviewed patch",
                    "grantRoot": "C:\\work"
                }),
                Value::Null,
            )
            .await;
        let request_id = latest_native_request_id(&sink);
        let (mut calls, release) =
            install_response_gate(&engine, Err("synthetic send failure".to_string()));
        let resolving_engine = Arc::clone(&engine);
        let resolving_id = request_id.clone();
        let resolving = tokio::spawn(async move {
            resolving_engine
                .resolve_approval(&resolving_id, true, false)
                .await
        });
        assert_eq!(
            calls.recv().await.expect("response reached transport").1,
            json!(43)
        );
        release.add_permits(1);
        assert!(resolving.await.unwrap().is_err());
        assert!(engine
            .pending_requests
            .lock()
            .await
            .contains_key(&request_id));

        let (mut calls, release) =
            install_response_gate(&engine, Err("synthetic replacement race".to_string()));
        let resolving_engine = Arc::clone(&engine);
        let resolving_id = request_id.clone();
        let resolving = tokio::spawn(async move {
            resolving_engine
                .resolve_approval(&resolving_id, false, false)
                .await
        });
        calls.recv().await.expect("retry reached transport");
        engine.pending_requests.lock().await.insert(
            request_id.clone(),
            PendingServerRequest {
                generation: 2,
                rpc_id: json!(43),
                acceptance_key: "newer-replacement".to_string(),
                claimed: false,
                method: "item/fileChange/requestApproval".to_string(),
                params: json!({"reason":"newer replacement"}),
                session_id: "session-1".to_string(),
                thread_id: "root-thread".to_string(),
                turn_id: "root-turn".to_string(),
            },
        );
        release.add_permits(1);
        assert!(resolving.await.unwrap().is_err());
        let pending = engine.pending_requests.lock().await;
        assert_eq!(pending[&request_id].generation, 2);
        assert_eq!(pending[&request_id].params["reason"], "newer replacement");
    }

    #[tokio::test]
    async fn stale_generation_resolved_with_reused_rpc_id_cannot_clear_newer_request() {
        let (engine, _, sink) = routed_test_engine().await;
        engine
            .routes
            .write()
            .await
            .get_mut("root-thread")
            .unwrap()
            .generation = Some(2);
        activate_test_root_turn(&engine, 2, "turn-new").await;
        engine
            .handle_server_request(
                2,
                json!(7),
                "mcpServer/elicitation/request",
                json!({
                    "threadId": "root-thread",
                    "turnId": "turn-new",
                    "itemId": "elicitation-new",
                    "message": "Provide a value",
                    "requestedSchema": {"type":"object"}
                }),
                Value::Null,
            )
            .await;
        let request_id = latest_native_request_id(&sink);

        engine
            .handle_notification(
                1,
                "serverRequest/resolved",
                json!({"requestId": 7}),
                Value::Null,
            )
            .await;

        assert!(engine
            .pending_requests
            .lock()
            .await
            .contains_key(&request_id));
        assert!(!sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::CodexRequest { id, method, .. }
                    if id == &request_id && method == "serverRequest/resolved"
            )));
    }

    #[tokio::test]
    async fn terminal_event_replaces_progress_when_deferred_queue_is_saturated() {
        let (engine, db, sink) = routed_test_engine().await;
        for index in 0..512 {
            engine
                .handle_incoming(Incoming::Notification {
                    generation: 1,
                    method: "turn/started".to_string(),
                    params: canonical_turn_params(
                        "saturated-child",
                        &format!("progress-turn-{index}"),
                        "inProgress",
                    ),
                    raw: Value::Null,
                })
                .await;
        }
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/completed".to_string(),
                params: canonical_turn_params("saturated-child", "terminal-turn", "completed"),
                raw: Value::Null,
            })
            .await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "item/started".to_string(),
                params: canonical_item_started(
                    "root-thread",
                    "root-turn",
                    canonical_collab_item(
                        "spawn-saturated",
                        "spawnAgent",
                        "inProgress",
                        "root-thread",
                        &["saturated-child"],
                    ),
                ),
                raw: Value::Null,
            })
            .await;

        let rows = db.codex_activity("session-1", 2_000).unwrap();
        assert!(rows.iter().any(|row| {
            row.thread_id == "saturated-child"
                && row.method == "turn/completed"
                && row.turn_id.as_deref() == Some("terminal-turn")
        }));
        assert!(sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::AgentFinished { agent_id, current_turn_id, .. }
                    if agent_id == "saturated-child"
                        && current_turn_id.as_deref() == Some("terminal-turn")
            )));
    }

    #[tokio::test]
    async fn canonical_thread_started_immediately_drains_deferred_child_events() {
        let (engine, _, sink) = routed_test_engine().await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/started".to_string(),
                params: canonical_turn_params("child-thread", "child-turn", "inProgress"),
                raw: Value::Null,
            })
            .await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "thread/started".to_string(),
                params: json!({"thread": canonical_thread("child-thread", Some("root-thread"))}),
                raw: Value::Null,
            })
            .await;

        assert!(!engine
            .deferred_by_thread
            .lock()
            .await
            .contains_key("child-thread"));
        assert_eq!(
            engine.active_by_thread.lock().await["child-thread"].turn_id,
            "child-turn"
        );
        assert_eq!(
            sink.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, event)| matches!(
                    event,
                    StreamEvent::AgentProgress { current_turn_id, .. }
                        if current_turn_id.as_deref() == Some("child-turn")
                ))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn reverse_nested_route_registration_drains_each_event_once() {
        let (engine, db, sink) = routed_test_engine().await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/started".to_string(),
                params: canonical_turn_params("grandchild-thread", "grandchild-turn", "inProgress"),
                raw: Value::Null,
            })
            .await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "item/started".to_string(),
                params: canonical_item_started(
                    "child-thread",
                    "child-turn",
                    canonical_collab_item(
                        "spawn-grandchild",
                        "spawnAgent",
                        "inProgress",
                        "child-thread",
                        &["grandchild-thread"],
                    ),
                ),
                raw: Value::Null,
            })
            .await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/started".to_string(),
                params: canonical_turn_params("child-thread", "child-turn", "inProgress"),
                raw: Value::Null,
            })
            .await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "item/started".to_string(),
                params: canonical_item_started(
                    "root-thread",
                    "root-turn",
                    canonical_collab_item(
                        "spawn-child",
                        "spawnAgent",
                        "inProgress",
                        "root-thread",
                        &["child-thread"],
                    ),
                ),
                raw: Value::Null,
            })
            .await;

        let routes = engine.routes.read().await;
        assert_eq!(
            routes["child-thread"].parent_thread_id.as_deref(),
            Some("root-thread")
        );
        assert_eq!(
            routes["grandchild-thread"].parent_thread_id.as_deref(),
            Some("child-thread")
        );
        drop(routes);
        assert!(engine.deferred_by_thread.lock().await.is_empty());
        let rows = db.codex_activity("session-1", 100).unwrap();
        assert_eq!(
            rows.iter()
                .filter(|row| row.thread_id == "grandchild-thread" && row.method == "turn/started")
                .count(),
            1
        );
        assert_eq!(
            sink.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, event)| matches!(
                    event,
                    StreamEvent::AgentProgress { current_turn_id, .. }
                        if current_turn_id.as_deref() == Some("grandchild-turn")
                ))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn stop_intent_is_retained_before_turn_start_returns() {
        let (engine, _, _) = routed_test_engine().await;
        engine.active_by_session.lock().await.insert(
            "session-1".to_string(),
            ActiveSessionTurn {
                run_id: "run-in-flight".to_string(),
                generation: Some(1),
                turn_id: None,
                _attachment_snapshot: None,
            },
        );

        assert!(engine.interrupt_session("session-1").await.is_ok());
        assert!(engine
            .active_by_session
            .lock()
            .await
            .contains_key("session-1"));
    }

    #[tokio::test]
    async fn lost_terminal_watchdog_recovers_and_late_terminal_cannot_report_success() {
        let (engine, db, sink) = routed_test_engine().await;
        engine.active_by_session.lock().await.insert(
            "session-1".to_string(),
            ActiveSessionTurn {
                run_id: "run-in-flight".to_string(),
                generation: None,
                turn_id: None,
                _attachment_snapshot: None,
            },
        );
        engine.pending_starts.lock().await.insert(
            "root-thread".to_string(),
            PendingTurnStart {
                generation: 1,
                run_id: "run-in-flight".to_string(),
                session_id: "session-1".to_string(),
                thread_id: "root-thread".to_string(),
                text: "stop this turn".to_string(),
                started_at_ms: 1_000,
            },
        );

        engine.interrupt_session("session-1").await.unwrap();
        engine
            .activate_pending_turn(1, "root-thread", "turn-after-intent", Some(1_000))
            .await
            .unwrap();
        assert_eq!(
            engine.interrupt_requests.lock().await.as_slice(),
            &[("root-thread".to_string(), "turn-after-intent".to_string())]
        );
        assert!(engine.is_session_active("session-1").await);

        engine
            .handle_interrupt_watchdog("session-1", 1, "turn-after-intent", 1)
            .await;
        assert!(!engine.is_session_active("session-1").await);
        assert!(!engine.turns.lock().await.contains_key("turn-after-intent"));
        assert!(!engine
            .active_by_thread
            .lock()
            .await
            .contains_key("root-thread"));
        assert!(sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::CodexEvent { method, params, .. }
                    if method == "portcode/codexBridge/interruptWatchdog"
                        && params["recoverable"] == false
                        && params["state"] == "interruptedUnknownDuration"
                        && params["durationKnown"] == false
            )));
        assert_eq!(
            sink.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, event)| matches!(
                    event,
                    StreamEvent::TurnEnd { stop_reason, .. } if stop_reason == "cancelled"
                ))
                .count(),
            1
        );

        assert!(engine.interrupt_session("session-1").await.is_err());
        assert_eq!(engine.interrupt_requests.lock().await.len(), 1);

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/completed".to_string(),
                params: canonical_turn_params("root-thread", "turn-after-intent", "completed"),
                raw: Value::Null,
            })
            .await;
        assert!(db
            .codex_activity("session-1", 100)
            .unwrap()
            .iter()
            .any(|row| {
                row.method == "turn/completed"
                    && row.turn_id.as_deref() == Some("turn-after-intent")
            }));
        assert_eq!(
            sink.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, event)| matches!(event, StreamEvent::TurnEnd { .. }))
                .count(),
            1
        );
        assert!(!sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::TurnEnd { stop_reason, .. } if stop_reason == "end_turn"
            )));

        engine.active_by_session.lock().await.insert(
            "session-1".to_string(),
            ActiveSessionTurn {
                run_id: "newer-run".to_string(),
                generation: Some(1),
                turn_id: Some("newer-turn".to_string()),
                _attachment_snapshot: None,
            },
        );
        engine.active_by_thread.lock().await.insert(
            "root-thread".to_string(),
            ActiveThreadTurn {
                generation: 1,
                turn_id: "newer-turn".to_string(),
            },
        );
        engine.turns.lock().await.insert(
            "newer-turn".to_string(),
            TurnProjection::new(
                1,
                "session-1".to_string(),
                "root-thread".to_string(),
                "newer-turn".to_string(),
            ),
        );
        engine.session_interrupts.lock().await.insert(
            "session-1".to_string(),
            InterruptState {
                generation: 1,
                run_id: Some("run-in-flight".to_string()),
                thread_id: Some("root-thread".to_string()),
                turn_id: Some("turn-after-intent".to_string()),
                attempt: 2,
                phase: InterruptPhase::Sent,
            },
        );
        engine
            .handle_interrupt_watchdog("session-1", 1, "turn-after-intent", 2)
            .await;
        assert_eq!(
            engine.active_by_session.lock().await["session-1"]
                .turn_id
                .as_deref(),
            Some("newer-turn")
        );
        assert!(engine.turns.lock().await.contains_key("newer-turn"));
    }

    #[tokio::test]
    async fn child_lost_terminal_watchdog_retires_only_its_provenance_and_reconciles_late_truth() {
        let (engine, _, sink) = routed_test_engine().await;
        let root_route = engine.routes.read().await["root-thread"].clone();
        engine
            .register_collab_routes(
                &root_route,
                "root-turn",
                &canonical_collab_item(
                    "spawn-watchdog-child",
                    "spawnAgent",
                    "inProgress",
                    "root-thread",
                    &["watchdog-child"],
                ),
            )
            .await;
        engine.active_by_thread.lock().await.insert(
            "watchdog-child".to_string(),
            ActiveThreadTurn {
                generation: 1,
                turn_id: "child-turn".to_string(),
            },
        );
        engine.subagent_turns.lock().await.insert(
            (1, "watchdog-child".to_string()),
            ("child-turn".to_string(), 1),
        );
        engine.agent_interrupts.lock().await.insert(
            "watchdog-child".to_string(),
            InterruptState {
                generation: 1,
                run_id: None,
                thread_id: Some("watchdog-child".to_string()),
                turn_id: Some("child-turn".to_string()),
                attempt: 7,
                phase: InterruptPhase::Sent,
            },
        );

        engine
            .handle_agent_interrupt_watchdog("watchdog-child", 1, "child-turn", 7)
            .await;

        assert!(!engine
            .active_by_thread
            .lock()
            .await
            .contains_key("watchdog-child"));
        assert!(!engine
            .agent_interrupts
            .lock()
            .await
            .contains_key("watchdog-child"));
        assert!(engine.interrupt_agent("watchdog-child").await.is_err());
        assert!(sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::CodexEvent { method, params, .. }
                    if method == "portcode/codexBridge/interruptWatchdog"
                        && params["recoverable"] == false
                        && params["state"] == "interruptedUnknownDuration"
                        && params["durationKnown"] == false
            )));
        assert_eq!(
            sink.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, event)| matches!(
                    event,
                    StreamEvent::AgentFinished {
                        agent_id,
                        status,
                        provider_status,
                        current_turn_id,
                        ..
                    } if agent_id == "watchdog-child"
                        && status == "cancelled"
                        && provider_status.as_deref() == Some("interruptedUnknownDuration")
                        && current_turn_id.as_deref() == Some("child-turn")
                ))
                .count(),
            1
        );

        engine
            .complete_turn(
                1,
                &engine.routes.read().await["watchdog-child"].clone(),
                &json!({"threadId":"watchdog-child","turn":{"id":"child-turn"}}),
            )
            .await;
        assert_eq!(
            sink.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, event)| matches!(
                    event,
                    StreamEvent::AgentFinished {
                        agent_id,
                        status,
                        provider_status,
                        current_turn_id,
                        ..
                    } if agent_id == "watchdog-child"
                        && status == "unknown"
                        && provider_status.as_deref() == Some("unknown")
                        && current_turn_id.as_deref() == Some("child-turn")
                ))
                .count(),
            1
        );

        engine.active_by_thread.lock().await.insert(
            "watchdog-child".to_string(),
            ActiveThreadTurn {
                generation: 1,
                turn_id: "newer-child-turn".to_string(),
            },
        );
        engine.agent_interrupts.lock().await.insert(
            "watchdog-child".to_string(),
            InterruptState {
                generation: 1,
                run_id: None,
                thread_id: Some("watchdog-child".to_string()),
                turn_id: Some("child-turn".to_string()),
                attempt: 8,
                phase: InterruptPhase::Sent,
            },
        );
        engine
            .handle_agent_interrupt_watchdog("watchdog-child", 1, "child-turn", 8)
            .await;
        assert_eq!(
            engine.active_by_thread.lock().await["watchdog-child"].turn_id,
            "newer-child-turn"
        );
    }

    #[tokio::test]
    async fn root_watchdog_durably_retires_its_exact_request_before_terminal_emission() {
        let (engine, db, sink) = routed_test_engine().await;
        activate_test_root_turn(&engine, 1, "watchdog-root-turn").await;
        engine.session_interrupts.lock().await.insert(
            "session-1".to_string(),
            InterruptState {
                generation: 1,
                run_id: Some("run-watchdog-root-turn".to_string()),
                thread_id: Some("root-thread".to_string()),
                turn_id: Some("watchdog-root-turn".to_string()),
                attempt: 3,
                phase: InterruptPhase::Sent,
            },
        );
        engine
            .handle_server_request(
                1,
                json!(71),
                "item/commandExecution/requestApproval",
                json!({
                    "threadId": "root-thread",
                    "turnId": "watchdog-root-turn",
                    "itemId": "watchdog-root-request",
                    "availableDecisions": ["accept", "decline"]
                }),
                Value::Null,
            )
            .await;
        let request_id = engine
            .pending_requests
            .lock()
            .await
            .keys()
            .next()
            .cloned()
            .unwrap();

        engine
            .handle_interrupt_watchdog("session-1", 1, "watchdog-root-turn", 3)
            .await;

        assert!(engine.pending_requests.lock().await.is_empty());
        let row = db
            .codex_activity("session-1", 100)
            .unwrap()
            .into_iter()
            .find(|row| row.method == "portcode/codexBridge/interruptWatchdog")
            .expect("root watchdog has durable provenance");
        assert!(row.sequence > 0);
        assert!(sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::CodexEvent { sequence, method, .. }
                    if *sequence == row.sequence
                        && method == "portcode/codexBridge/interruptWatchdog"
            )));
        let (mut calls, _release) = install_response_gate(&engine, Ok(()));
        assert!(engine
            .resolve_approval(&request_id, true, false)
            .await
            .is_err());
        assert!(calls.try_recv().is_err());
    }

    #[tokio::test]
    async fn child_watchdog_durably_retires_its_exact_request_before_terminal_emission() {
        let (engine, db, sink) = routed_test_engine().await;
        assert!(
            engine
                .establish_child_route(
                    "watchdog-request-child",
                    "root-thread",
                    1,
                    Some("root-turn"),
                )
                .await
        );
        engine.active_by_thread.lock().await.insert(
            "watchdog-request-child".to_string(),
            ActiveThreadTurn {
                generation: 1,
                turn_id: "watchdog-child-turn".to_string(),
            },
        );
        engine.agent_interrupts.lock().await.insert(
            "watchdog-request-child".to_string(),
            InterruptState {
                generation: 1,
                run_id: None,
                thread_id: Some("watchdog-request-child".to_string()),
                turn_id: Some("watchdog-child-turn".to_string()),
                attempt: 4,
                phase: InterruptPhase::Sent,
            },
        );
        engine
            .handle_server_request(
                1,
                json!(72),
                "item/tool/requestUserInput",
                json!({
                    "threadId": "watchdog-request-child",
                    "turnId": "watchdog-child-turn",
                    "itemId": "watchdog-child-request",
                    "questions": []
                }),
                Value::Null,
            )
            .await;
        let request_id = engine
            .pending_requests
            .lock()
            .await
            .keys()
            .next()
            .cloned()
            .unwrap();

        engine
            .handle_agent_interrupt_watchdog("watchdog-request-child", 1, "watchdog-child-turn", 4)
            .await;

        assert!(engine.pending_requests.lock().await.is_empty());
        let row = db
            .codex_activity("session-1", 100)
            .unwrap()
            .into_iter()
            .find(|row| row.method == "portcode/codexBridge/interruptWatchdog")
            .expect("child watchdog has durable provenance");
        assert!(row.sequence > 0);
        assert!(sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::CodexEvent { sequence, method, .. }
                    if *sequence == row.sequence
                        && method == "portcode/codexBridge/interruptWatchdog"
            )));
        let (mut calls, _release) = install_response_gate(&engine, Ok(()));
        assert!(engine
            .resolve_codex_request(&request_id, json!({"answers":{}}))
            .await
            .is_err());
        assert!(calls.try_recv().is_err());
    }

    #[tokio::test]
    async fn root_watchdog_activity_failure_leaves_exact_state_retryable_without_semantics() {
        let (engine, db, sink) = routed_test_engine().await;
        activate_test_root_turn(&engine, 1, "watchdog-root-failure").await;
        engine.session_interrupts.lock().await.insert(
            "session-1".to_string(),
            InterruptState {
                generation: 1,
                run_id: Some("run-watchdog-root-failure".to_string()),
                thread_id: Some("root-thread".to_string()),
                turn_id: Some("watchdog-root-failure".to_string()),
                attempt: 5,
                phase: InterruptPhase::Sent,
            },
        );
        db.install_codex_activity_insert_failure_fixture();

        engine
            .handle_interrupt_watchdog("session-1", 1, "watchdog-root-failure", 5)
            .await;

        assert!(engine
            .active_by_session
            .lock()
            .await
            .contains_key("session-1"));
        assert!(engine
            .turns
            .lock()
            .await
            .contains_key("watchdog-root-failure"));
        assert_eq!(
            engine.session_interrupts.lock().await["session-1"].phase,
            InterruptPhase::Retryable
        );
        assert!(!sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::CodexEvent { method, .. }
                    if method == "portcode/codexBridge/interruptWatchdog"
            ) || matches!(event, StreamEvent::TurnEnd { .. })));
    }

    #[tokio::test]
    async fn child_watchdog_activity_failure_leaves_exact_state_retryable_without_semantics() {
        let (engine, db, sink) = routed_test_engine().await;
        assert!(
            engine
                .establish_child_route(
                    "watchdog-failure-child",
                    "root-thread",
                    1,
                    Some("root-turn"),
                )
                .await
        );
        engine.active_by_thread.lock().await.insert(
            "watchdog-failure-child".to_string(),
            ActiveThreadTurn {
                generation: 1,
                turn_id: "watchdog-child-failure".to_string(),
            },
        );
        engine.agent_interrupts.lock().await.insert(
            "watchdog-failure-child".to_string(),
            InterruptState {
                generation: 1,
                run_id: None,
                thread_id: Some("watchdog-failure-child".to_string()),
                turn_id: Some("watchdog-child-failure".to_string()),
                attempt: 6,
                phase: InterruptPhase::Sent,
            },
        );
        db.install_codex_activity_insert_failure_fixture();

        engine
            .handle_agent_interrupt_watchdog(
                "watchdog-failure-child",
                1,
                "watchdog-child-failure",
                6,
            )
            .await;

        assert!(engine
            .active_by_thread
            .lock()
            .await
            .contains_key("watchdog-failure-child"));
        assert_eq!(
            engine.agent_interrupts.lock().await["watchdog-failure-child"].phase,
            InterruptPhase::Retryable
        );
        assert!(engine.subagent_terminals.lock().await.is_empty());
        assert!(!sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::CodexEvent { method, .. }
                    if method == "portcode/codexBridge/interruptWatchdog"
            ) || matches!(event, StreamEvent::AgentFinished { .. })));
    }

    #[tokio::test]
    async fn watchdog_child_turn_retention_is_bounded_and_keeps_latest_evidence() {
        let (engine, _, _) = routed_test_engine().await;
        assert!(
            engine
                .establish_child_route(
                    "bounded-watchdog-child",
                    "root-thread",
                    1,
                    Some("root-turn"),
                )
                .await
        );
        for index in 0..520 {
            let turn_id = format!("watchdog-turn-{index:03}");
            engine.active_by_thread.lock().await.insert(
                "bounded-watchdog-child".to_string(),
                ActiveThreadTurn {
                    generation: 1,
                    turn_id: turn_id.clone(),
                },
            );
            engine.agent_interrupts.lock().await.insert(
                "bounded-watchdog-child".to_string(),
                InterruptState {
                    generation: 1,
                    run_id: None,
                    thread_id: Some("bounded-watchdog-child".to_string()),
                    turn_id: Some(turn_id.clone()),
                    attempt: index + 1,
                    phase: InterruptPhase::Sent,
                },
            );
            engine
                .handle_agent_interrupt_watchdog("bounded-watchdog-child", 1, &turn_id, index + 1)
                .await;
        }

        let terminals = engine.subagent_terminals.lock().await;
        assert!(terminals.len() <= MAX_RETAINED_SUBAGENT_TURNS_PER_THREAD);
        assert!(terminals.contains_key(&(
            1,
            "bounded-watchdog-child".to_string(),
            "watchdog-turn-519".to_string(),
        )));
    }

    #[tokio::test]
    async fn unfinished_child_admission_is_honestly_bounded() {
        let (engine, _, sink) = routed_test_engine().await;
        let root_route = engine.routes.read().await["root-thread"].clone();
        for index in 0..640 {
            let child = format!("unfinished-child-{index}");
            engine
                .register_collab_routes(
                    &root_route,
                    "root-turn",
                    &canonical_collab_item(
                        &format!("spawn-unfinished-{index}"),
                        "spawnAgent",
                        "inProgress",
                        "root-thread",
                        &[&child],
                    ),
                )
                .await;
        }

        assert!(
            engine
                .routes
                .read()
                .await
                .values()
                .filter(|route| route.is_subagent && route.generation == Some(1))
                .count()
                <= MAX_RETAINED_SUBAGENTS_PER_GENERATION
        );
        assert!(
            engine.announced_agents.lock().await.len() <= MAX_RETAINED_SUBAGENTS_PER_GENERATION
        );
        assert!(sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, event)| matches!(
                event,
                StreamEvent::CodexEvent { method, params, .. }
                    if method == "portcode/codexBridge/subagentAdmissionRejected"
                        && params["capacity"] == MAX_RETAINED_SUBAGENTS_PER_GENERATION
                        && params["recoverable"] == false
            )));
    }

    #[tokio::test]
    async fn terminal_turn_retires_only_its_owned_pending_requests() {
        let (engine, _, _) = routed_test_engine().await;
        activate_test_root_turn(&engine, 1, "owner-turn").await;
        engine
            .handle_server_request(
                1,
                json!(101),
                "item/commandExecution/requestApproval",
                json!({
                    "threadId": "root-thread",
                    "turnId": "owner-turn",
                    "itemId": "approval-101",
                    "availableDecisions": ["accept", "decline"]
                }),
                Value::Null,
            )
            .await;
        engine.pending_requests.lock().await.insert(
            "unrelated-native-request".to_string(),
            PendingServerRequest {
                generation: 1,
                rpc_id: json!(102),
                acceptance_key: "unrelated-exact-acceptance".to_string(),
                claimed: false,
                method: "item/commandExecution/requestApproval".to_string(),
                params: json!({
                    "threadId": "root-thread",
                    "turnId": "unrelated-turn",
                    "itemId": "approval-102",
                    "availableDecisions": ["accept", "decline"]
                }),
                session_id: "session-1".to_string(),
                thread_id: "root-thread".to_string(),
                turn_id: "unrelated-turn".to_string(),
            },
        );
        let (owner_request_id, unrelated_request_id) = {
            let pending = engine.pending_requests.lock().await;
            assert_eq!(pending.len(), 2);
            let owner = pending
                .iter()
                .find(|(_, request)| request.turn_id == "owner-turn")
                .map(|(id, _)| id.clone())
                .unwrap();
            let unrelated = pending
                .iter()
                .find(|(_, request)| request.turn_id == "unrelated-turn")
                .map(|(id, _)| id.clone())
                .unwrap();
            (owner, unrelated)
        };

        let route = engine.routes.read().await["root-thread"].clone();
        engine
            .complete_turn(
                1,
                &route,
                &canonical_turn_params("root-thread", "owner-turn", "completed"),
            )
            .await;

        {
            let pending = engine.pending_requests.lock().await;
            assert_eq!(pending.len(), 1);
            assert_eq!(
                pending.values().next().unwrap().params["turnId"],
                "unrelated-turn"
            );
        }

        let (mut calls, release) = install_response_gate(&engine, Ok(()));
        assert!(engine
            .resolve_approval(&owner_request_id, false, false)
            .await
            .is_err());
        assert!(calls.try_recv().is_err());

        let resolving_engine = Arc::clone(&engine);
        let unrelated = tokio::spawn(async move {
            resolving_engine
                .resolve_approval(&unrelated_request_id, false, false)
                .await
        });
        assert_eq!(calls.recv().await.unwrap().1, json!(102));
        release.add_permits(1);
        assert!(unrelated.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn activity_append_failure_blocks_all_semantic_projection() {
        let (engine, db, sink) = routed_test_engine().await;
        engine.turns.lock().await.insert(
            "turn-fail-closed".to_string(),
            TurnProjection::new(
                1,
                "session-1".to_string(),
                "root-thread".to_string(),
                "turn-fail-closed".to_string(),
            ),
        );
        db.install_codex_activity_insert_failure_fixture();

        engine
            .handle_notification(
                1,
                "item/agentMessage/delta",
                json!({
                    "threadId": "root-thread",
                    "turnId": "turn-fail-closed",
                    "itemId": "message-fail-closed",
                    "delta": "MUST_NOT_PROJECT"
                }),
                Value::Null,
            )
            .await;

        assert!(sink.events.lock().unwrap().is_empty());
        assert!(engine.turns.lock().await["turn-fail-closed"]
            .blocks()
            .is_empty());
    }

    #[tokio::test]
    async fn completed_composite_turn_reloads_once_without_cross_thread_or_provisional_state() {
        let (engine, db, sink) = routed_test_engine().await;
        activate_test_root_turn(&engine, 1, "root-turn").await;

        let notifications = vec![
            (
                "turn/started",
                canonical_turn_params("root-thread", "root-turn", "inProgress"),
            ),
            (
                "turn/plan/updated",
                json!({
                    "threadId": "root-thread",
                    "turnId": "root-turn",
                    "explanation": "Composite fixture plan",
                    "plan": [
                        {"step": "Inspect durable state", "status": "completed"},
                        {"step": "Reload exactly once", "status": "inProgress"}
                    ]
                }),
            ),
            (
                "item/started",
                canonical_item_started(
                    "root-thread",
                    "root-turn",
                    json!({
                        "id": "command-1",
                        "type": "commandExecution",
                        "command": "cargo test composite",
                        "cwd": "C:\\work",
                        "processId": null,
                        "source": "agent",
                        "status": "inProgress",
                        "commandActions": [{
                            "type": "unknown",
                            "command": "cargo test composite"
                        }],
                        "aggregatedOutput": null,
                        "exitCode": null,
                        "durationMs": null
                    }),
                ),
            ),
            (
                "item/completed",
                json!({
                    "threadId": "root-thread",
                    "turnId": "root-turn",
                    "item": {
                        "id": "command-1",
                        "type": "commandExecution",
                        "command": "cargo test composite",
                        "cwd": "C:\\work",
                        "processId": null,
                        "source": "agent",
                        "status": "completed",
                        "commandActions": [{
                            "type": "unknown",
                            "command": "cargo test composite"
                        }],
                        "aggregatedOutput": "composite command complete",
                        "exitCode": 0,
                        "durationMs": 12
                    },
                    "completedAtMs": 1_012
                }),
            ),
            (
                "item/started",
                canonical_item_started(
                    "root-thread",
                    "root-turn",
                    canonical_collab_item(
                        "spawn-child",
                        "spawnAgent",
                        "inProgress",
                        "root-thread",
                        &["child-thread"],
                    ),
                ),
            ),
            (
                "thread/started",
                json!({"thread": canonical_thread("child-thread", Some("root-thread"))}),
            ),
            (
                "turn/started",
                canonical_turn_params("child-thread", "child-turn", "inProgress"),
            ),
            (
                "turn/completed",
                canonical_turn_params("child-thread", "child-turn", "completed"),
            ),
            (
                "future/rootComposite",
                json!({
                    "threadId": "root-thread",
                    "turnId": "root-turn",
                    "safe": "root unknown survives"
                }),
            ),
            (
                "future/childComposite",
                json!({
                    "threadId": "child-thread",
                    "turnId": "child-turn",
                    "safe": "child unknown remains child-owned"
                }),
            ),
            (
                "item/completed",
                json!({
                    "threadId": "root-thread",
                    "turnId": "root-turn",
                    "item": canonical_agent_message(
                        "message-final",
                        "AUTHORITATIVE FINAL COMPOSITE"
                    ),
                    "completedAtMs": 1_100
                }),
            ),
            (
                "turn/diff/updated",
                json!({
                    "threadId": "root-thread",
                    "turnId": "root-turn",
                    "diff": "+durable composite diff"
                }),
            ),
            (
                "turn/completed",
                canonical_turn_params("root-thread", "root-turn", "completed"),
            ),
        ];

        for (method, params) in notifications {
            engine
                .dispatch_incoming(Incoming::Notification {
                    generation: 1,
                    method: method.to_string(),
                    params,
                    raw: Value::Null,
                })
                .await;
        }

        let rows = db.codex_activity("session-1", 100).unwrap();
        let sequences = rows.iter().map(|row| row.sequence).collect::<Vec<_>>();
        assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(
            sequences.iter().copied().collect::<HashSet<_>>().len(),
            sequences.len()
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row.method == "turn/completed" && row.thread_id == "root-thread")
                .count(),
            1
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row.method == "future/rootComposite")
                .count(),
            1
        );
        assert_eq!(
            rows.iter()
                .filter(|row| {
                    row.method == "future/childComposite" && row.thread_id == "child-thread"
                })
                .count(),
            1
        );

        let messages = db.try_ui_messages("session-1").unwrap();
        assert_eq!(messages.len(), 1);
        let reloaded = serde_json::to_value(&messages[0]).unwrap();
        assert_eq!(reloaded["turnId"], "root-turn");
        assert_eq!(
            reloaded["blocks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|block| block["kind"] == "text"
                    && block["text"] == "AUTHORITATIVE FINAL COMPOSITE")
                .count(),
            1
        );
        let encoded = serde_json::to_string(&messages).unwrap();
        assert!(!encoded.contains("Composite fixture plan"));
        assert!(!encoded.contains("root unknown survives"));
        assert!(!encoded.contains("child unknown remains child-owned"));
        assert!(!encoded.contains("child-turn"));

        let events = sink.events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|(_, event)| matches!(
                    event,
                    StreamEvent::AssistantMessageSnapshot { turn_id, blocks }
                        if turn_id == "root-turn"
                            && blocks.iter().filter(|block| matches!(
                                block,
                                Block::Text { text } if text == "AUTHORITATIVE FINAL COMPOSITE"
                            )).count() == 1
                ))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|(_, event)| matches!(
                    event,
                    StreamEvent::TurnEnd { stop_reason, .. } if stop_reason == "end_turn"
                ))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn contradictory_final_assistant_text_is_replaced_live_without_duplication() {
        let (engine, _, sink) = routed_test_engine().await;
        engine.turns.lock().await.insert(
            "turn-final-snapshot".to_string(),
            TurnProjection::new(
                1,
                "session-1".to_string(),
                "root-thread".to_string(),
                "turn-final-snapshot".to_string(),
            ),
        );
        engine
            .handle_notification(
                1,
                "item/agentMessage/delta",
                json!({
                    "threadId": "root-thread",
                    "turnId": "turn-final-snapshot",
                    "itemId": "message-final-snapshot",
                    "delta": "draft answer"
                }),
                Value::Null,
            )
            .await;
        engine
            .handle_notification(
                1,
                "item/completed",
                json!({
                    "threadId": "root-thread",
                    "turnId": "turn-final-snapshot",
                    "item": canonical_agent_message(
                        "message-final-snapshot",
                        "authoritative final answer"
                    )
                }),
                Value::Null,
            )
            .await;
        engine
            .handle_notification(
                1,
                "turn/completed",
                canonical_turn_params("root-thread", "turn-final-snapshot", "completed"),
                Value::Null,
            )
            .await;

        let events = sink.events.lock().unwrap();
        let snapshots = events
            .iter()
            .filter_map(|(_, event)| match event {
                StreamEvent::AssistantMessageSnapshot { turn_id, blocks }
                    if turn_id == "turn-final-snapshot" =>
                {
                    Some(blocks)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(snapshots.len(), 1);
        assert!(matches!(
            snapshots[0].as_slice(),
            [Block::Text { text }] if text == "authoritative final answer"
        ));
        let deltas = events
            .iter()
            .filter_map(|(_, event)| match event {
                StreamEvent::TextDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(deltas, vec!["draft answer"]);
    }

    #[tokio::test]
    async fn successful_root_terminal_rejects_late_diff_and_conflicting_duplicate_durably() {
        let (engine, db, sink) = routed_test_engine().await;
        activate_test_root_turn(&engine, 1, "terminal-monotonic-turn").await;

        engine
            .handle_notification(
                1,
                "turn/diff/updated",
                json!({
                    "threadId": "root-thread",
                    "turnId": "terminal-monotonic-turn",
                    "diff": "PRE"
                }),
                Value::Null,
            )
            .await;
        engine
            .handle_notification(
                1,
                "turn/completed",
                canonical_turn_params("root-thread", "terminal-monotonic-turn", "completed"),
                Value::Null,
            )
            .await;

        let reloaded = CodexEngine::new(
            CodexAppServer::new(Default::default()),
            db.clone(),
            sink.clone(),
        );
        reloaded
            .register_root_route("session-1", "root-thread", 1)
            .await;
        reloaded
            .handle_notification(
                1,
                "turn/diff/updated",
                json!({
                    "threadId": "root-thread",
                    "turnId": "terminal-monotonic-turn",
                    "diff": "LATE"
                }),
                Value::Null,
            )
            .await;
        reloaded
            .handle_notification(
                1,
                "turn/completed",
                canonical_turn_params("root-thread", "terminal-monotonic-turn", "failed"),
                Value::Null,
            )
            .await;

        let rows = db.codex_activity("session-1", 100).unwrap();
        let owned = rows
            .iter()
            .filter(|row| row.turn_id.as_deref() == Some("terminal-monotonic-turn"))
            .collect::<Vec<_>>();
        assert_eq!(
            owned
                .iter()
                .filter(|row| row.method == "turn/diff/updated")
                .count(),
            1
        );
        assert_eq!(
            owned
                .iter()
                .filter(|row| row.method == "turn/completed")
                .count(),
            1
        );
        assert_eq!(owned[0].params["diff"], "PRE");
        assert_eq!(owned[1].params["turn"]["status"], "completed");

        let events = sink.events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|(_, event)| matches!(
                    event,
                    StreamEvent::CodexEvent { method, turn_id, .. }
                        if method == "turn/diff/updated"
                            && turn_id.as_deref() == Some("terminal-monotonic-turn")
                ))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|(_, event)| matches!(
                    event,
                    StreamEvent::CodexEvent { method, turn_id, .. }
                        if method == "turn/completed"
                            && turn_id.as_deref() == Some("terminal-monotonic-turn")
                ))
                .count(),
            1
        );
        assert!(!events
            .iter()
            .any(|(_, event)| matches!(event, StreamEvent::Error { .. })));
    }

    #[tokio::test]
    async fn authoritative_completion_message_failure_never_emits_success_and_reloads_honestly() {
        let (engine, db, sink) = routed_test_engine().await;
        activate_test_root_turn(&engine, 1, "turn-final-persist-failure").await;
        engine
            .handle_notification(
                1,
                "item/agentMessage/delta",
                json!({
                    "threadId": "root-thread",
                    "turnId": "turn-final-persist-failure",
                    "itemId": "message-final-persist-failure",
                    "delta": "contradictory draft"
                }),
                Value::Null,
            )
            .await;
        engine
            .handle_notification(
                1,
                "item/completed",
                json!({
                    "threadId": "root-thread",
                    "turnId": "turn-final-persist-failure",
                    "item": canonical_agent_message(
                        "message-final-persist-failure",
                        "authoritative final snapshot"
                    )
                }),
                Value::Null,
            )
            .await;
        db.install_assistant_message_insert_failure_fixture();
        let completed =
            canonical_turn_params("root-thread", "turn-final-persist-failure", "completed");

        engine
            .handle_notification(1, "turn/completed", completed.clone(), Value::Null)
            .await;
        engine
            .handle_notification(1, "turn/completed", completed, Value::Null)
            .await;

        let events = sink.events.lock().unwrap().clone();
        assert!(!events.iter().any(|(_, event)| matches!(
            event,
            StreamEvent::CodexEvent { method, turn_id, .. }
                if method == "turn/completed"
                    && turn_id.as_deref() == Some("turn-final-persist-failure")
        )));
        assert!(!events.iter().any(|(_, event)| matches!(
            event,
            StreamEvent::AssistantMessageSnapshot { turn_id, .. }
                if turn_id == "turn-final-persist-failure"
        )));
        assert!(!events.iter().any(|(_, event)| matches!(
            event,
            StreamEvent::TurnEnd { stop_reason, .. } if stop_reason == "end_turn"
        )));
        assert!(events.iter().any(|(_, event)| matches!(
            event,
            StreamEvent::Error { message, .. }
                if message.contains("persist") && message.contains("authoritative")
        )));
        assert!(db.try_ui_messages("session-1").unwrap().is_empty());
        let activity = db.codex_activity("session-1", 100).unwrap();
        assert!(!activity.iter().any(|row| {
            row.method == "turn/completed"
                && row.turn_id.as_deref() == Some("turn-final-persist-failure")
        }));
        assert!(activity.iter().any(|row| {
            row.method == "portcode/codexBridge/terminalPersistenceFailed"
                && row.turn_id.as_deref() == Some("turn-final-persist-failure")
        }));
    }

    #[tokio::test]
    async fn failed_root_terminal_projections_are_bounded_without_disturbing_newer_ownership() {
        const EXPECTED_FAILED_ROOT_PROJECTION_BOUND: usize = 16;
        assert_eq!(
            MAX_RETAINED_FAILED_ROOT_PROJECTIONS_PER_GENERATION,
            EXPECTED_FAILED_ROOT_PROJECTION_BOUND
        );

        let (engine, db, _) = routed_test_engine().await;
        let route = engine.routes.read().await["root-thread"].clone();
        db.install_assistant_message_insert_failure_fixture();

        for label in 'A'..='P' {
            let turn_id = format!("failed-root-turn-{label}");
            activate_test_root_turn(&engine, 1, &turn_id).await;
            engine
                .project_item_completed(
                    1,
                    &route,
                    &json!({
                        "threadId": "root-thread",
                        "turnId": turn_id,
                        "item": canonical_agent_message(
                            &format!("failed-root-message-{label}"),
                            &format!("canonical failed answer {label}")
                        )
                    }),
                )
                .await;
            engine
                .complete_turn(
                    1,
                    &route,
                    &canonical_turn_params("root-thread", &turn_id, "completed"),
                )
                .await;
        }

        let retained_before_retry = engine
            .failed_root_retention_order
            .lock()
            .await
            .iter()
            .map(|(_, _, _, turn_id)| turn_id.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            retained_before_retry,
            ('A'..='P')
                .map(|label| format!("failed-root-turn-{label}"))
                .collect::<Vec<_>>()
        );

        engine
            .complete_turn(
                1,
                &route,
                &canonical_turn_params("root-thread", "failed-root-turn-A", "completed"),
            )
            .await;
        let retained_after_retry = engine
            .failed_root_retention_order
            .lock()
            .await
            .iter()
            .map(|(_, _, _, turn_id)| turn_id.clone())
            .collect::<Vec<_>>();
        assert_eq!(retained_after_retry, retained_before_retry);

        activate_test_root_turn(&engine, 1, "failed-root-turn-Q").await;
        engine
            .project_item_completed(
                1,
                &route,
                &json!({
                    "threadId": "root-thread",
                    "turnId": "failed-root-turn-Q",
                    "item": canonical_agent_message(
                        "failed-root-message-Q",
                        "canonical failed answer Q"
                    )
                }),
            )
            .await;
        engine
            .complete_turn(
                1,
                &route,
                &canonical_turn_params("root-thread", "failed-root-turn-Q", "completed"),
            )
            .await;

        let turns = engine.turns.lock().await;
        assert_eq!(turns.len(), EXPECTED_FAILED_ROOT_PROJECTION_BOUND);
        assert!(!turns.contains_key("failed-root-turn-A"));
        for label in 'B'..='Q' {
            assert!(turns.contains_key(&format!("failed-root-turn-{label}")));
        }
        let latest_blocks = turns["failed-root-turn-Q"].blocks();
        assert!(matches!(
            latest_blocks.as_slice(),
            [Block::Text { text }] if text == "canonical failed answer Q"
        ));
        drop(turns);

        activate_test_root_turn(&engine, 1, "newer-active-turn").await;
        engine
            .complete_turn(
                1,
                &route,
                &canonical_turn_params("root-thread", "failed-root-turn-Q", "completed"),
            )
            .await;
        assert!(engine.turns.lock().await.contains_key("failed-root-turn-Q"));
        assert!(engine.turns.lock().await.contains_key("newer-active-turn"));
        assert_eq!(
            engine.active_by_thread.lock().await["root-thread"].turn_id,
            "newer-active-turn"
        );
        assert_eq!(
            engine.active_by_session.lock().await["session-1"]
                .turn_id
                .as_deref(),
            Some("newer-active-turn")
        );
    }

    #[tokio::test]
    async fn failed_root_terminal_projection_exact_retry_converges_once_and_is_removed() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("portcode.db");
        let db = Arc::new(Db::open(&database_path).unwrap());
        db.create_session("session-1", "Codex chat", None, None, 1)
            .unwrap();
        let admin = rusqlite::Connection::open(&database_path).unwrap();
        admin
            .execute_batch(
                "CREATE TRIGGER fail_retry_assistant_message_insert
                 BEFORE INSERT ON messages
                 WHEN NEW.role = 'assistant' AND NEW.turn_id = 'retry-root-turn'
                 BEGIN
                   SELECT RAISE(FAIL, 'deterministic transient assistant insert failure');
                 END;",
            )
            .unwrap();
        let sink = Arc::new(RecordingSink::default());
        let engine = CodexEngine::new(
            CodexAppServer::new(Default::default()),
            db.clone(),
            sink.clone(),
        );
        engine
            .register_root_route("session-1", "root-thread", 1)
            .await;
        activate_test_root_turn(&engine, 1, "retry-root-turn").await;
        let route = engine.routes.read().await["root-thread"].clone();
        engine
            .project_item_completed(
                1,
                &route,
                &json!({
                    "threadId": "root-thread",
                    "turnId": "retry-root-turn",
                    "item": canonical_agent_message(
                        "retry-root-message",
                        "canonical retry answer"
                    )
                }),
            )
            .await;
        let completed = canonical_turn_params("root-thread", "retry-root-turn", "completed");

        engine
            .handle_notification(1, "turn/completed", completed.clone(), Value::Null)
            .await;
        assert!(engine.turns.lock().await.contains_key("retry-root-turn"));
        assert!(db.try_ui_messages("session-1").unwrap().is_empty());

        admin
            .execute_batch("DROP TRIGGER fail_retry_assistant_message_insert;")
            .unwrap();
        engine
            .handle_notification(1, "turn/completed", completed, Value::Null)
            .await;

        assert!(!engine.turns.lock().await.contains_key("retry-root-turn"));
        let messages = db.try_ui_messages("session-1").unwrap();
        assert_eq!(messages.len(), 1);
        let message = serde_json::to_value(&messages[0]).unwrap();
        assert_eq!(message["role"], "assistant");
        assert_eq!(message["turnId"], "retry-root-turn");
        assert_eq!(message["blocks"][0]["kind"], "text");
        assert_eq!(message["blocks"][0]["text"], "canonical retry answer");
        let terminal_activity = db
            .codex_activity("session-1", 100)
            .unwrap()
            .into_iter()
            .filter(|row| {
                row.method == "turn/completed" && row.turn_id.as_deref() == Some("retry-root-turn")
            })
            .count();
        assert_eq!(terminal_activity, 1);
        let events = sink.events.lock().unwrap();
        let snapshots = events
            .iter()
            .filter(|(_, event)| matches!(
                event,
                StreamEvent::AssistantMessageSnapshot { turn_id, blocks }
                    if turn_id == "retry-root-turn"
                        && matches!(blocks.as_slice(), [Block::Text { text }] if text == "canonical retry answer")
            ))
            .count();
        assert_eq!(snapshots, 1);
        let terminals = events
            .iter()
            .filter(|(_, event)| {
                matches!(
                    event,
                    StreamEvent::CodexEvent { method, turn_id, .. }
                        if method == "turn/completed"
                            && turn_id.as_deref() == Some("retry-root-turn")
                )
            })
            .count();
        assert_eq!(terminals, 1);
    }

    #[tokio::test]
    async fn long_lived_generation_prunes_terminal_subagent_state() {
        let (engine, _, _) = routed_test_engine().await;
        let root_route = engine.routes.read().await["root-thread"].clone();
        for index in 0..640 {
            let child = format!("bounded-child-{index}");
            engine
                .register_collab_routes(
                    &root_route,
                    "root-turn",
                    &canonical_collab_item(
                        &format!("spawn-{index}"),
                        "spawnAgent",
                        "inProgress",
                        "root-thread",
                        &[&child],
                    ),
                )
                .await;
            engine
                .subagent_turns
                .lock()
                .await
                .insert((1, child.clone()), (format!("child-turn-{index}"), 1));
            engine.subagent_results.lock().await.insert(
                (1, child.clone(), format!("child-turn-{index}")),
                if index == 0 {
                    "result".repeat(20_000)
                } else {
                    "result".to_string()
                },
            );
            let child_route = engine.routes.read().await[&child].clone();
            engine
                .complete_turn(
                    1,
                    &child_route,
                    &canonical_turn_params(&child, &format!("child-turn-{index}"), "completed"),
                )
                .await;
        }

        assert!(engine.subagent_turns.lock().await.len() <= 512);
        assert!(engine.subagent_results.lock().await.len() <= 512);
        assert!(engine.announced_agents.lock().await.len() <= 512);
        assert!(engine.subagent_terminals.lock().await.len() <= 512);
        assert!(
            engine
                .routes
                .read()
                .await
                .values()
                .filter(|route| route.is_subagent && route.generation == Some(1))
                .count()
                <= 512
        );
        assert!(engine
            .subagent_results
            .lock()
            .await
            .values()
            .all(|result| result.len() <= 16 * 1024));
    }

    #[tokio::test]
    async fn retained_child_prunes_more_than_512_turns_but_keeps_latest_result() {
        let (engine, db, _) = routed_test_engine().await;
        let root_route = engine.routes.read().await["root-thread"].clone();
        engine
            .register_collab_routes(
                &root_route,
                "root-turn",
                &canonical_collab_item(
                    "spawn-retained-child",
                    "spawnAgent",
                    "inProgress",
                    "root-thread",
                    &["retained-child"],
                ),
            )
            .await;

        let latest_result = "LATEST_PROVIDER_RESULT".repeat(2_000);
        for index in 0..520 {
            let turn_id = format!("retained-turn-{index:03}");
            engine
                .handle_incoming(Incoming::Notification {
                    generation: 1,
                    method: "turn/started".to_string(),
                    params: canonical_turn_params("retained-child", &turn_id, "inProgress"),
                    raw: Value::Null,
                })
                .await;
            let result = if index == 519 {
                latest_result.clone()
            } else {
                format!("provider-result-{index:03}")
            };
            engine
                .handle_incoming(Incoming::Notification {
                    generation: 1,
                    method: "item/completed".to_string(),
                    params: json!({
                        "threadId": "retained-child",
                        "turnId": turn_id,
                        "item": canonical_agent_message(&format!("message-{index:03}"), &result),
                        "completedAtMs": 2_000 + index
                    }),
                    raw: Value::Null,
                })
                .await;
            engine
                .handle_incoming(Incoming::Notification {
                    generation: 1,
                    method: "turn/completed".to_string(),
                    params: canonical_turn_params("retained-child", &turn_id, "completed"),
                    raw: Value::Null,
                })
                .await;
        }

        let latest_key = (
            1,
            "retained-child".to_string(),
            "retained-turn-519".to_string(),
        );
        let terminals = engine.subagent_terminals.lock().await;
        assert!(terminals.len() <= MAX_RETAINED_SUBAGENTS_PER_GENERATION);
        assert!(terminals.contains_key(&latest_key));
        drop(terminals);
        let results = engine.subagent_results.lock().await;
        assert!(results.len() <= MAX_RETAINED_SUBAGENTS_PER_GENERATION);
        let retained_latest = results
            .get(&latest_key)
            .expect("latest result remains retained");
        assert!(retained_latest.starts_with("LATEST_PROVIDER_RESULT"));
        assert!(retained_latest.len() <= MAX_SUBAGENT_RESULT_BYTES);
        drop(results);

        let rows = db.codex_activity("session-1", 2_000).unwrap();
        assert!(rows.iter().any(|row| {
            row.thread_id == "retained-child"
                && row.turn_id.as_deref() == Some("retained-turn-000")
                && row.method == "turn/started"
        }));
        assert!(rows.iter().any(|row| {
            row.thread_id == "retained-child"
                && row.turn_id.as_deref() == Some("retained-turn-519")
                && row.method == "turn/completed"
        }));
    }

    #[tokio::test]
    async fn raw_reasoning_is_redacted_before_persistence_and_emission() {
        const CANONICAL_SENTINEL: &str = "RAW_REASONING_CANONICAL_SENTINEL";
        const NESTED_SENTINEL: &str = "RAW_REASONING_NESTED_SENTINEL";
        let (engine, db, sink) = routed_test_engine().await;

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "item/reasoning/textDelta".to_string(),
                params: json!({
                    "threadId": "root-thread",
                    "turnId": "turn-1",
                    "itemId": "reasoning-1",
                    "delta": CANONICAL_SENTINEL,
                    "contentIndex": 0
                }),
                raw: json!({"method":"item/reasoning/textDelta"}),
            })
            .await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "future/diagnostic".to_string(),
                params: json!({
                    "threadId": "root-thread",
                    "turnId": "turn-1",
                    "itemId": "future-1",
                    "label": "benign metadata survives",
                    "payload": {"reasoning": {"text": NESTED_SENTINEL}},
                    "equivalents": [
                        {"reasoning_text": NESTED_SENTINEL},
                        {"Chain.Of-Thought Text": NESTED_SENTINEL},
                        {"INTERNAL_reasoning-text": NESTED_SENTINEL}
                    ]
                }),
                raw: json!({"method":"future/diagnostic"}),
            })
            .await;

        let rows = db.codex_activity("session-1", 100).unwrap();
        assert_eq!(rows.len(), 2);
        let persisted = serde_json::to_string(&rows).unwrap();
        let emitted = serde_json::to_string(&sink.events.lock().unwrap().clone()).unwrap();
        assert!(!persisted.contains(CANONICAL_SENTINEL));
        assert!(!persisted.contains(NESTED_SENTINEL));
        assert!(!emitted.contains(CANONICAL_SENTINEL));
        assert!(!emitted.contains(NESTED_SENTINEL));
        assert!(persisted.contains("benign metadata survives"));
        assert!(persisted.contains("rawReasoning"));
        assert!(persisted.contains("redacted"));
    }

    #[test]
    fn normalized_known_secret_key_matrix_is_redacted_without_losing_safe_metadata() {
        const SENTINELS: [&str; 17] = [
            "API_KEY_NATIVE_SENTINEL",
            "PASSWORD_NATIVE_SENTINEL",
            "PASSPHRASE_NATIVE_SENTINEL",
            "AUTHORIZATION_NATIVE_SENTINEL",
            "PROXY_AUTHORIZATION_NATIVE_SENTINEL",
            "CREDENTIAL_NATIVE_SENTINEL",
            "SECRET_NATIVE_SENTINEL",
            "CLIENT_SECRET_NATIVE_SENTINEL",
            "ACCESS_TOKEN_NATIVE_SENTINEL",
            "REFRESH_TOKEN_NATIVE_SENTINEL",
            "ID_TOKEN_NATIVE_SENTINEL",
            "TOKEN_NATIVE_SENTINEL",
            "PRIVATE_KEY_NATIVE_SENTINEL",
            "COOKIE_NATIVE_SENTINEL",
            "SET_COOKIE_NATIVE_SENTINEL",
            "BEARER_NATIVE_SENTINEL",
            "NESTED_CREDENTIAL_NATIVE_SENTINEL",
        ];
        let sanitized = sanitize_activity_params(
            "future/knownSecretMatrix",
            &json!({
                "threadId": "root-thread",
                "turnId": "turn-secret-matrix",
                "itemId": "item-secret-matrix",
                "apiKey": SENTINELS[0],
                "Pass-Word": SENTINELS[1],
                "PASSPHRASE": SENTINELS[2],
                "authorization": SENTINELS[3],
                "Proxy.Authorization": SENTINELS[4],
                "credentials": SENTINELS[5],
                "secret": SENTINELS[6],
                "Client_Secret": SENTINELS[7],
                "access-token": SENTINELS[8],
                "refreshToken": SENTINELS[9],
                "ID TOKEN": SENTINELS[10],
                "token": SENTINELS[11],
                "private.key": SENTINELS[12],
                "cookie": SENTINELS[13],
                "Set-Cookie": SENTINELS[14],
                "BEARER": SENTINELS[15],
                "nested": [{"cre.den_tial": SENTINELS[16]}],
                "status": "completed",
                "summary": "Safe summary survives",
                "correlationId": "safe-correlation",
                "benignUnknownMetadata": {"provider": "future-codex", "count": 3}
            }),
        );
        let encoded = serde_json::to_string(&sanitized).unwrap();

        for sentinel in SENTINELS {
            assert!(!encoded.contains(sentinel), "leaked {sentinel}: {encoded}");
        }
        assert_eq!(sanitized["status"], "completed");
        assert_eq!(sanitized["summary"], "Safe summary survives");
        assert_eq!(sanitized["correlationId"], "safe-correlation");
        assert_eq!(
            sanitized["benignUnknownMetadata"],
            json!({"provider": "future-codex", "count": 3})
        );
        assert_eq!(sanitized[ACTIVITY_METADATA_KEY]["redacted"], true);
        assert_eq!(
            sanitized[ACTIVITY_METADATA_KEY]["redactionReasons"],
            json!(["knownSecret"])
        );
    }

    #[tokio::test]
    async fn known_secret_sentinels_never_reach_persistence_or_codex_event_emission() {
        const SENTINELS: [&str; 4] = [
            "PERSISTED_API_KEY_SENTINEL",
            "PERSISTED_PASSWORD_SENTINEL",
            "PERSISTED_AUTHORIZATION_SENTINEL",
            "PERSISTED_NESTED_CREDENTIAL_SENTINEL",
        ];
        let (engine, db, sink) = routed_test_engine().await;

        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "future/knownSecretPersistence".to_string(),
                params: json!({
                    "threadId": "root-thread",
                    "turnId": "turn-secret-persistence",
                    "itemId": "item-secret-persistence",
                    "api_key": SENTINELS[0],
                    "Pass.Word": SENTINELS[1],
                    "Proxy Authorization": SENTINELS[2],
                    "nested": [{"CREDENTIALS": SENTINELS[3]}],
                    "status": "completed",
                    "summary": "Safe persisted summary"
                }),
                raw: json!({"method": "future/knownSecretPersistence"}),
            })
            .await;

        let rows = db.codex_activity("session-1", 100).unwrap();
        assert_eq!(rows.len(), 1);
        let persisted = serde_json::to_string(&rows).unwrap();
        let emitted = serde_json::to_string(&sink.events.lock().unwrap().clone()).unwrap();
        for sentinel in SENTINELS {
            assert!(
                !persisted.contains(sentinel),
                "persisted {sentinel}: {persisted}"
            );
            assert!(!emitted.contains(sentinel), "emitted {sentinel}: {emitted}");
        }
        assert!(persisted.contains("Safe persisted summary"));
        assert!(emitted.contains("Safe persisted summary"));
        assert!(persisted.contains("knownSecret"));
        assert!(emitted.contains("knownSecret"));
    }

    #[test]
    fn nested_and_type_tagged_reasoning_variants_are_conservatively_redacted() {
        const SENTINEL: &str = "RAW_REASONING_SANITIZER_MATRIX_SENTINEL";
        let sanitized = sanitize_activity_params(
            "future/diagnostic",
            &json!({
                "threadId": "root-thread",
                "turnId": "turn-matrix",
                "benignUnknownMetadata": {
                    "provider": "future-codex",
                    "count": 3,
                    "enabled": true
                },
                "payloads": [
                    {"raw_reasoning": SENTINEL},
                    {"RAW-Reasoning": {"nested": SENTINEL}},
                    {"chain_of_thought": [SENTINEL]},
                    {"Chain Of Thought": {"deep": [{"value": SENTINEL}]}},
                    {
                        "type": "reasoning",
                        "summary": ["Safe provider summary"],
                        "text": SENTINEL,
                        "alreadyRedacted": {"redacted": true, "reason": "upstream"},
                        "alreadyTruncated": {"truncated": true, "reason": "upstreamLimit"}
                    },
                    {
                        "TyPe": "ReAsOn_InG",
                        "summary": ["Another safe summary"],
                        "nested": [{"maps": {"TEXT": SENTINEL}}]
                    },
                    {
                        "kind": "chain_of_thought",
                        "summary": ["Kind-safe summary"],
                        "content": [{"RAW.reasoning": SENTINEL}]
                    },
                    {
                        "K-I-N-D": "RAW Reasoning",
                        "summary": ["Normalized-kind summary"],
                        "payload": {"text": SENTINEL}
                    },
                    {"reasoning_text": SENTINEL},
                    {"Chain.Of-Thought Text": [SENTINEL]},
                    {"INTERNAL_reasoning-text": {"deep": SENTINEL}},
                    {
                        "type": "Reasoning Text",
                        "summary": ["Reasoning-text safe summary"],
                        "content": SENTINEL
                    },
                    {
                        "kind": "CHAIN_OF_THOUGHT_TEXT",
                        "summary": ["Chain-text safe summary"],
                        "payload": [{"text": SENTINEL}]
                    },
                    {
                        "TyPe": "Internal.Reasoning-Text",
                        "summary": ["Internal-text safe summary"],
                        "details": {"value": SENTINEL}
                    }
                ]
            }),
        );
        let encoded = serde_json::to_string(&sanitized).unwrap();

        assert!(!encoded.contains(SENTINEL));
        assert_eq!(
            sanitized["benignUnknownMetadata"]["provider"],
            "future-codex"
        );
        assert_eq!(
            sanitized["payloads"][4]["summary"][0],
            "Safe provider summary"
        );
        assert_eq!(
            sanitized["payloads"][5]["summary"][0],
            "Another safe summary"
        );
        assert_eq!(sanitized["payloads"][6]["summary"][0], "Kind-safe summary");
        assert_eq!(
            sanitized["payloads"][7]["summary"][0],
            "Normalized-kind summary"
        );
        assert_eq!(
            sanitized["payloads"][11]["summary"][0],
            "Reasoning-text safe summary"
        );
        assert_eq!(
            sanitized["payloads"][12]["summary"][0],
            "Chain-text safe summary"
        );
        assert_eq!(
            sanitized["payloads"][13]["summary"][0],
            "Internal-text safe summary"
        );
        assert_eq!(
            sanitized["payloads"][4]["alreadyRedacted"]["redacted"],
            true
        );
        assert_eq!(
            sanitized["payloads"][4]["alreadyTruncated"]["truncated"],
            true
        );
        assert_eq!(sanitized[ACTIVITY_METADATA_KEY]["redacted"], true);
        assert!(sanitized[ACTIVITY_METADATA_KEY]["redactionReasons"]
            .as_array()
            .unwrap()
            .contains(&json!("rawReasoning")));
    }

    #[tokio::test]
    async fn resumed_history_sanitizes_canonical_reasoning_and_hostile_bounds() {
        const SENTINEL: &str = "RAW_REASONING_RESUME_SENTINEL";
        let (engine, db, _) = routed_test_engine().await;

        let mut reasoning_turn = canonical_turn("resume-reasoning-turn", "completed");
        reasoning_turn["items"] = json!([{
            "id": "reasoning-1",
            "type": "reasoning",
            "summary": ["Safe resume summary"],
            "content": [SENTINEL]
        }]);

        let mut deep = json!({"leaf": "safe"});
        for index in 0..40 {
            deep = json!({format!("level-{index}"): deep});
        }
        let mut many_fields = Map::new();
        for index in 0..400 {
            many_fields.insert(
                format!("field-{index:03}"),
                Value::String("bounded field value ".repeat(20)),
            );
        }
        let mut hostile_turn = canonical_turn("resume-hostile-turn", "completed");
        hostile_turn["items"] = json!([{
            "id": "future-item-1",
            "type": "futureProviderItem",
            "aOversizedString": "界".repeat(20_000),
            "bArray": (0..600).collect::<Vec<_>>(),
            "cDeep": deep,
            "zFields": many_fields
        }]);

        let mut thread = canonical_thread("root-thread", None);
        thread["turns"] = json!([reasoning_turn, hostile_turn]);
        engine
            .reconcile_resumed_thread("session-1", "root-thread", &json!({"thread": thread}))
            .unwrap();

        let rows = db.codex_activity("session-1", 100).unwrap();
        let reasoning = rows
            .iter()
            .find(|row| row.turn_id.as_deref() == Some("resume-reasoning-turn"))
            .expect("canonical reasoning history was retained");
        let hostile = rows
            .iter()
            .find(|row| row.turn_id.as_deref() == Some("resume-hostile-turn"))
            .expect("hostile history was retained in bounded form");
        let persisted = serde_json::to_string(&rows).unwrap();

        assert!(!persisted.contains(SENTINEL));
        assert_eq!(
            reasoning.params["items"][0]["summary"][0],
            "Safe resume summary"
        );
        assert_eq!(reasoning.params["items"][0]["content"]["redacted"], true);
        assert!(serde_json::to_vec(&hostile.params).unwrap().len() <= MAX_ACTIVITY_PARAM_BYTES);
        let metadata = &hostile.params[ACTIVITY_METADATA_KEY];
        assert_eq!(metadata["truncated"], true);
        let reasons = metadata["truncationReasons"].as_array().unwrap();
        for reason in [
            "maxEncodedBytes",
            "maxDepth",
            "maxFields",
            "maxArrayItems",
            "maxStringBytes",
        ] {
            assert!(
                reasons.contains(&json!(reason)),
                "missing {reason}: {reasons:?}"
            );
        }
        assert!(metadata["originalBytes"].as_u64().unwrap() > 64 * 1024);
        assert!(metadata["retainedBytes"].as_u64().unwrap() <= 64 * 1024);
    }

    #[tokio::test]
    async fn resumed_history_activity_failure_rolls_back_transcript_semantics() {
        let (engine, db, _) = routed_test_engine().await;
        let mut resumed_turn = canonical_turn("resume-atomic-failure", "completed");
        resumed_turn["items"] = json!([
            {
                "id": "resume-user",
                "type": "userMessage",
                "content": [{"type":"text","text":"resume user sentinel"}]
            },
            canonical_agent_message("resume-assistant", "resume assistant sentinel")
        ]);
        let mut thread = canonical_thread("root-thread", None);
        thread["turns"] = json!([resumed_turn]);
        db.install_codex_activity_insert_failure_fixture();

        assert!(engine
            .reconcile_resumed_thread("session-1", "root-thread", &json!({"thread": thread}))
            .is_err());

        assert!(db.load_chat_messages("session-1").is_empty());
        assert!(db.try_ui_messages("session-1").unwrap().is_empty());
        assert!(db.codex_activity("session-1", 100).unwrap().is_empty());
        assert!(!db
            .turn_has_messages("session-1", "resume-atomic-failure")
            .unwrap());
    }

    #[tokio::test]
    async fn hostile_unknown_payload_is_bounded_before_a_terminal_event() {
        let (engine, db, _) = routed_test_engine().await;
        let mut deep = json!({"leaf": "深".repeat(20_000)});
        for index in 0..40 {
            deep = json!({format!("level-{index}"): deep});
        }
        let mut fields = Map::new();
        for index in 0..400 {
            fields.insert(format!("field-{index}"), Value::String("🙂".repeat(100)));
        }
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "future/hostile".to_string(),
                params: json!({
                    "threadId": "root-thread",
                    "turnId": "turn-hostile",
                    "itemId": "item-hostile",
                    "deep": deep,
                    "fields": fields,
                    "array": (0..600).collect::<Vec<_>>()
                }),
                raw: Value::Null,
            })
            .await;
        engine
            .handle_incoming(Incoming::Notification {
                generation: 1,
                method: "turn/completed".to_string(),
                params: canonical_turn_params("root-thread", "turn-hostile", "completed"),
                raw: Value::Null,
            })
            .await;

        let rows = db.codex_activity("session-1", 100).unwrap();
        let hostile = rows
            .iter()
            .find(|row| row.method == "future/hostile")
            .unwrap();
        assert!(serde_json::to_vec(&hostile.params).unwrap().len() <= 64 * 1024);
        assert!(serde_json::to_string(&hostile.params)
            .unwrap()
            .contains("truncated"));
        assert_eq!(rows.last().unwrap().method, "turn/completed");
    }

    #[tokio::test]
    async fn completed_child_accepts_distinct_send_input_and_resume_turns() {
        let (engine, _, sink) = routed_test_engine().await;
        engine
            .dispatch_incoming(Incoming::Notification {
                generation: 1,
                method: "item/started".to_string(),
                params: canonical_item_started(
                    "root-thread",
                    "root-turn",
                    canonical_collab_item(
                        "spawn-1",
                        "spawnAgent",
                        "inProgress",
                        "root-thread",
                        &["child-thread"],
                    ),
                ),
                raw: Value::Null,
            })
            .await;

        for (tool, turn_id) in [
            ("spawnAgent", "child-turn-1"),
            ("sendInput", "child-turn-2"),
            ("resumeAgent", "child-turn-3"),
        ] {
            if tool != "spawnAgent" {
                engine
                    .dispatch_incoming(Incoming::Notification {
                        generation: 1,
                        method: "item/started".to_string(),
                        params: canonical_item_started(
                            "root-thread",
                            "root-turn",
                            canonical_collab_item(
                                &format!("{tool}-{turn_id}"),
                                tool,
                                "inProgress",
                                "root-thread",
                                &["child-thread"],
                            ),
                        ),
                        raw: Value::Null,
                    })
                    .await;
            }
            engine
                .dispatch_incoming(Incoming::Notification {
                    generation: 1,
                    method: "turn/started".to_string(),
                    params: canonical_turn_params("child-thread", turn_id, "inProgress"),
                    raw: Value::Null,
                })
                .await;
            if turn_id != "child-turn-3" {
                engine
                    .dispatch_incoming(Incoming::Notification {
                        generation: 1,
                        method: "turn/completed".to_string(),
                        params: canonical_turn_params("child-thread", turn_id, "completed"),
                        raw: Value::Null,
                    })
                    .await;
            }
        }

        assert_eq!(
            engine.active_by_thread.lock().await["child-thread"].turn_id,
            "child-turn-3"
        );
        assert_eq!(
            engine.routes.read().await["child-thread"]
                .parent_thread_id
                .as_deref(),
            Some("root-thread")
        );
        let events = sink.events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|(_, event)| matches!(event, StreamEvent::AgentStarted { agent_id, .. } if agent_id == "child-thread"))
                .count(),
            1
        );
        assert!(events.iter().any(|(_, event)| matches!(
            event,
            StreamEvent::AgentProgress { current_turn_id, .. }
                if current_turn_id.as_deref() == Some("child-turn-3")
        )));
    }

    #[tokio::test]
    async fn send_input_and_subagent_activity_cannot_reparent_existing_routes() {
        let (engine, _, _) = routed_test_engine().await;
        engine.routes.write().await.insert(
            "sibling-thread".to_string(),
            ThreadRoute {
                session_id: "session-1".to_string(),
                root_thread_id: "root-thread".to_string(),
                is_subagent: true,
                generation: Some(1),
                parent_thread_id: Some("root-thread".to_string()),
                launch_turn_id: Some("root-turn".to_string()),
            },
        );
        let root_route = engine.routes.read().await["root-thread"].clone();
        for child in ["collab-child", "activity-child"] {
            engine
                .register_collab_routes(
                    &root_route,
                    "root-turn",
                    &canonical_collab_item(
                        &format!("spawn-{child}"),
                        "spawnAgent",
                        "inProgress",
                        "root-thread",
                        &[child],
                    ),
                )
                .await;
        }

        let sibling_route = engine.routes.read().await["sibling-thread"].clone();
        engine
            .register_collab_routes(
                &sibling_route,
                "sibling-turn",
                &canonical_collab_item(
                    "send-to-child",
                    "sendInput",
                    "inProgress",
                    "sibling-thread",
                    &["collab-child"],
                ),
            )
            .await;
        engine
            .project_subagent_activity(
                &sibling_route,
                &canonical_item_started(
                    "sibling-thread",
                    "sibling-turn",
                    json!({
                        "id": "activity-1",
                        "type": "subAgentActivity",
                        "kind": "interacted",
                        "agentThreadId": "activity-child",
                        "agentPath": "audit"
                    }),
                ),
                &json!({
                    "id": "activity-1",
                    "type": "subAgentActivity",
                    "kind": "interacted",
                    "agentThreadId": "activity-child",
                    "agentPath": "audit"
                }),
            )
            .await;

        let routes = engine.routes.read().await;
        assert_eq!(
            routes["collab-child"].parent_thread_id.as_deref(),
            Some("root-thread")
        );
        assert_eq!(
            routes["activity-child"].parent_thread_id.as_deref(),
            Some("root-thread")
        );
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
