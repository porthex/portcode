//! LLM message/event types, the [`LlmProvider`] trait seam, and the Anthropic
//! streaming client.
//!
//! The agent loop depends only on the [`LlmProvider`] trait. Anthropic Messages
//! and OpenAI Responses map into the same neutral turn vocabulary; additional
//! providers slot in by adding an impl + a
//! [`provider_for`] arm — without touching the loop.
//!
//! `Block`/`ChatMessage` are serialized directly into the Anthropic Messages
//! API request body, so their serde shapes intentionally match that wire format.
//! They are the neutral vocabulary every provider speaks (also the DB + Phone
//! Sync wire types), so a future non-Anthropic provider maps onto them.

use serde::Serialize;
use serde_json::{json, Value};
#[cfg(any(desktop, test))]
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;

use crate::events::EventSink;
use crate::secrets::Credential;
use crate::tool_names;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 8192;
#[cfg(desktop)]
const OPENAI_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
/// Stable classifier for the agent's one-shot OAuth refresh-and-retry path.
pub(crate) const OPENAI_UNAUTHORIZED_ERROR: &str = "OpenAI response authentication failed (401).";

/// Beta header that opts an OAuth (subscription) request into Anthropic's
/// OAuth-authenticated inference path.
const OAUTH_BETA: &str = "oauth-2025-04-20";

/// First system block required on subscription (OAuth) requests. Anthropic's
/// subscription inference path authenticates the caller as Claude Code, so this
/// exact line must lead the system prompt; Portcode's own prompt follows it.
/// (Requirement verified against opencode's `session/system.ts`.)
const CLAUDE_CODE_IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

/// Build the Anthropic `system` field for a turn.
///
/// OAuth (subscription) requests are only accepted when the first system block
/// is exactly the Claude Code identity, so for OAuth we emit a two-element block
/// array: the identity first, then Portcode's real prompt. API-key requests are
/// unchanged — `system` stays a plain string and never carries the identity.
fn build_system(cred: &Credential, system: &str) -> Value {
    match cred {
        Credential::OAuth(_) => json!([
            { "type": "text", "text": CLAUDE_CODE_IDENTITY },
            { "type": "text", "text": system },
        ]),
        Credential::ApiKey(_) => Value::String(system.to_string()),
        Credential::OpenAiOAuth(_) => Value::String(system.to_string()),
    }
}

// `Block`, `ChatMessage`, and `StreamEvent` are the Phone Sync wire DTOs; Phase 1
// of docs/IOS_WEB_CLIENT_PLAN.md (§5.1) moved them into the shared `portcode-sync`
// crate (`portcode_sync::wire`) so the future wasm browser client can decode them
// without linking this desktop crate. They are re-exported here UNCHANGED, so
// every `crate::llm::Block` / `ChatMessage` / `StreamEvent` path — and the serde
// shapes that match `src/types.ts` and the Anthropic content-block format —
// resolve to the SAME types as before.
pub use portcode_sync::wire::{Block, ChatMessage, StreamEvent};

#[derive(Debug)]
pub struct TurnResult {
    pub content: Vec<Block>,
    pub stop_reason: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[derive(Serialize)]
struct Request<'a> {
    model: &'a str,
    max_tokens: u32,
    // Either a plain string (API key) or an array of system blocks (OAuth, with
    // the Claude Code identity line first). Anthropic accepts both shapes.
    system: Value,
    messages: &'a [ChatMessage],
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    tools: &'a [Value],
    stream: bool,
}

enum Building {
    Text(String),
    Tool {
        id: String,
        name: String,
        json: String,
    },
}

/// Incremental assembler for one streamed assistant turn.
///
/// This is the SSE event → state-machine logic that [`stream_turn`]'s read loop
/// drives, lifted out of the live HTTP path so it is pure and synchronous:
/// [`process`](TurnBuilder::process) decodes one SSE `data:` payload, folds it
/// into the in-progress turn, and *returns* the [`StreamEvent`]s to emit (rather
/// than emitting them itself); [`finish`](TurnBuilder::finish) validates that the
/// turn completed and produces the [`TurnResult`]. `stream_turn` keeps all the
/// live I/O (HTTP, cancel, read timeout) and emits whatever `process` hands back,
/// so observable behavior is unchanged — but the parser can now be unit-tested
/// from a scripted sequence of Anthropic SSE lines, with no network or runtime.
struct TurnBuilder {
    blocks: Vec<Block>,
    current: Option<Building>,
    stop_reason: String,
    input_tokens: u32,
    output_tokens: u32,
}

impl TurnBuilder {
    fn new() -> Self {
        Self {
            blocks: Vec::new(),
            current: None,
            // Anthropic omits `stop_reason` until the closing `message_delta`;
            // default to the common terminal value so a stream that ends without
            // one (or is read mid-flight in a test) still reports sensibly.
            stop_reason: String::from("end_turn"),
            input_tokens: 0,
            output_tokens: 0,
        }
    }

    /// Decode one SSE `data:` payload (the text *after* the `data:` prefix) and
    /// fold it into the in-progress turn, returning the events to emit, in order.
    ///
    /// Empty/whitespace payloads and JSON we can't parse or don't model are
    /// ignored (no events, no error) — the Anthropic stream interleaves
    /// keep-alives, `[DONE]`-style markers, and event types we don't act on. A
    /// `type: "error"` event is surfaced as `Err` so the caller aborts the turn.
    fn process(&mut self, data: &str) -> Result<Vec<StreamEvent>, String> {
        let data = data.trim();
        if data.is_empty() {
            return Ok(Vec::new());
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return Ok(Vec::new());
        };

        let mut events = Vec::new();
        match v["type"].as_str() {
            Some("message_start") => {
                if let Some(n) = v["message"]["usage"]["input_tokens"].as_u64() {
                    self.input_tokens = n as u32;
                }
            }
            Some("content_block_start") => {
                let cb = &v["content_block"];
                self.current = match cb["type"].as_str() {
                    Some("text") => Some(Building::Text(String::new())),
                    Some("tool_use") => Some(Building::Tool {
                        id: cb["id"].as_str().unwrap_or_default().to_string(),
                        name: cb["name"].as_str().unwrap_or_default().to_string(),
                        json: String::new(),
                    }),
                    _ => None,
                };
            }
            Some("content_block_delta") => {
                let d = &v["delta"];
                match d["type"].as_str() {
                    Some("text_delta") => {
                        if let Some(t) = d["text"].as_str() {
                            // Only surface text we also accumulate into the current
                            // text block, so the live UI can never show text that the
                            // persisted message ends up missing.
                            if let Some(Building::Text(s)) = self.current.as_mut() {
                                s.push_str(t);
                                events.push(StreamEvent::TextDelta { text: t.into() });
                            }
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(pj) = d["partial_json"].as_str() {
                            if let Some(Building::Tool { json, .. }) = self.current.as_mut() {
                                json.push_str(pj);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => match self.current.take() {
                Some(Building::Text(s)) => self.blocks.push(Block::Text { text: s }),
                Some(Building::Tool { id, name, json }) => {
                    let name = tool_names::canonical(&name).to_string();
                    let input: Value = if json.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str(&json).unwrap_or_else(|_| json!({}))
                    };
                    events.push(StreamEvent::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                    });
                    self.blocks.push(Block::ToolUse { id, name, input });
                }
                None => {}
            },
            Some("message_delta") => {
                if let Some(sr) = v["delta"]["stop_reason"].as_str() {
                    self.stop_reason = sr.to_string();
                }
                if let Some(n) = v["usage"]["output_tokens"].as_u64() {
                    self.output_tokens = n as u32;
                }
            }
            Some("error") => {
                let msg = v["error"]["message"]
                    .as_str()
                    .unwrap_or("unknown streaming error");
                return Err(msg.to_string());
            }
            _ => {}
        }
        Ok(events)
    }

    /// Record that the user cancelled the turn. A cancelled turn legitimately
    /// stops mid-block, so this suppresses the truncation error in [`finish`].
    fn mark_cancelled(&mut self) {
        self.stop_reason = String::from("cancelled");
    }

    /// Finalize the turn into a [`TurnResult`].
    ///
    /// If the stream ended while a content block was still open (no
    /// `content_block_stop`) and the turn was not cancelled, the response was
    /// truncated — surface it instead of silently dropping the block. A
    /// half-built tool call would otherwise just vanish and the turn would look
    /// fine.
    fn finish(mut self) -> Result<TurnResult, String> {
        match self.current.take() {
            // Preserve partial assistant text that was already emitted to the UI.
            Some(Building::Text(text)) if self.stop_reason == "cancelled" => {
                if !text.is_empty() {
                    self.blocks.push(Block::Text { text });
                }
            }
            // A partial tool call has no valid input and must not be emitted.
            Some(_) if self.stop_reason == "cancelled" => {}
            Some(_) => {
                return Err(
                    "The response was cut off before it finished. Please try again.".to_string(),
                );
            }
            None => {}
        }
        Ok(TurnResult {
            content: self.blocks,
            stop_reason: self.stop_reason,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
        })
    }
}

/// Stream a single assistant turn. Emits text/tool events as they arrive and
/// returns the fully assembled turn so the agent loop can act on tool calls.
#[allow(clippy::too_many_arguments)]
pub async fn stream_turn(
    http: &reqwest::Client,
    cred: &Credential,
    model: &str,
    system: &str,
    messages: &[ChatMessage],
    tools: &[Value],
    sink: &dyn EventSink,
    channel: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<TurnResult, String> {
    // OAuth (subscription) requests must lead with the Claude Code identity
    // block; API-key requests send Portcode's prompt verbatim as a plain string.
    let system = build_system(cred, system);

    let body = Request {
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages,
        tools,
        stream: true,
    };

    let req = http
        .post(API_URL)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream");
    // Authentication differs by credential: an API key uses `x-api-key`; an
    // OAuth token uses a bearer `authorization` header plus the OAuth beta flag
    // and deliberately omits `x-api-key`.
    let req = match cred {
        Credential::ApiKey(key) => req.header("x-api-key", key.as_str()),
        Credential::OAuth(tokens) => req
            .header("authorization", format!("Bearer {}", tokens.access_token))
            .header("anthropic-beta", OAUTH_BETA),
        Credential::OpenAiOAuth(_) => {
            return Err("An OpenAI credential cannot authenticate an Anthropic request.".into())
        }
    };

    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or(text);
        return Err(format!("Anthropic API error ({status}): {msg}"));
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut builder = TurnBuilder::new();

    loop {
        if cancel.load(Ordering::Relaxed) {
            builder.mark_cancelled();
            break;
        }
        // Bound each read so a stalled connection can't park the turn forever with no
        // terminal event — that would leave the UI's `streaming` flag stuck true and
        // silently no-op every later message. 120s of total silence = a dead stream.
        // This also makes the cancel check above reachable within <=120s, so Stop
        // takes effect even when the connection is hung mid-read.
        let next = match tokio::time::timeout(Duration::from_secs(120), stream.next()).await {
            Ok(chunk) => chunk,
            Err(_) => {
                return Err(
                    "Stream stalled: no data from Anthropic for 120s. Please try again."
                        .to_string(),
                )
            }
        };
        let Some(chunk) = next else { break };
        let bytes = chunk.map_err(|e| format!("Stream error: {e}"))?;
        buf.extend_from_slice(&bytes);

        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim();
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            // The pure parser folds the event into the turn and tells us what to
            // emit; the live path only owns the side effect of emitting it.
            for ev in builder.process(data)? {
                sink.emit(channel, ev);
            }
        }
    }

    builder.finish()
}

/// The LLM provider seam. The agent loop depends only on this trait, so adding a
/// model provider means adding an `impl` + a [`provider_for`] arm — the loop
/// itself never changes.
#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// Stream one assistant turn — same contract as [`stream_turn`]: emits
    /// text/tool events as they arrive and returns the assembled turn so the
    /// agent loop can act on any tool calls.
    #[allow(clippy::too_many_arguments)]
    async fn stream_turn(
        &self,
        http: &reqwest::Client,
        cred: &Credential,
        model: &str,
        reasoning_effort: &str,
        response_speed: &str,
        system: &str,
        messages: &[ChatMessage],
        tools: &[Value],
        sink: &dyn EventSink,
        channel: &str,
        cancel: &Arc<AtomicBool>,
    ) -> Result<TurnResult, String>;
}

/// Anthropic Messages API provider. A thin adapter over [`stream_turn`] (the
/// Anthropic-specific client above); this is what [`provider_for`] returns for
/// `provider = "anthropic"`. Its credential model (`x-api-key` / OAuth bearer)
/// and the Claude Code identity block are Anthropic-specific — a second provider
/// brings its own impl rather than reusing these.
pub struct AnthropicProvider;

#[async_trait]
impl LlmProvider for AnthropicProvider {
    #[allow(clippy::too_many_arguments)]
    async fn stream_turn(
        &self,
        http: &reqwest::Client,
        cred: &Credential,
        model: &str,
        _reasoning_effort: &str,
        _response_speed: &str,
        system: &str,
        messages: &[ChatMessage],
        tools: &[Value],
        sink: &dyn EventSink,
        channel: &str,
        cancel: &Arc<AtomicBool>,
    ) -> Result<TurnResult, String> {
        stream_turn(
            http, cred, model, system, messages, tools, sink, channel, cancel,
        )
        .await
    }
}

#[cfg(any(desktop, test))]
fn openai_input(messages: &[ChatMessage], model: &str) -> Vec<Value> {
    let mut input = Vec::new();
    for message in messages {
        for block in &message.content {
            match block {
                Block::Text { text } => input.push(json!({
                    "type": "message",
                    "role": message.role,
                    "content": [{
                        "type": if message.role == "assistant" { "output_text" } else { "input_text" },
                        "text": text,
                    }],
                })),
                Block::ToolUse { id, name, input: arguments } => input.push(json!({
                    "type": "function_call",
                    "call_id": id,
                    "name": name,
                    "arguments": serde_json::to_string(arguments).unwrap_or_else(|_| "{}".into()),
                })),
                Block::ToolResult { tool_use_id, content, .. } => input.push(json!({
                    "type": "function_call_output",
                    "call_id": tool_use_id,
                    "output": content,
                })),
                Block::Reasoning {
                    model: source_model,
                    id,
                    encrypted_content,
                    summary,
                } => {
                    if source_model
                        .as_deref()
                        .is_some_and(|source| source != model)
                    {
                        continue;
                    }
                    let mut item = json!({ "type": "reasoning", "summary": summary });
                    if let Some(id) = id {
                        item["id"] = Value::String(id.clone());
                    }
                    if let Some(encrypted) = encrypted_content {
                        item["encrypted_content"] = Value::String(encrypted.clone());
                    }
                    input.push(item);
                }
            }
        }
    }
    input
}

#[cfg(any(desktop, test))]
fn openai_tools(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|tool| {
            let name = tool["name"].as_str()?;
            Some(json!({
                "type": "function",
                "name": name,
                "description": tool["description"].as_str().unwrap_or(""),
                "parameters": tool.get("input_schema").cloned().unwrap_or_else(|| json!({"type":"object"})),
                "strict": false,
            }))
        })
        .collect()
}

#[derive(Default)]
#[cfg(any(desktop, test))]
struct OpenAiFunction {
    name: String,
    arguments: String,
}

#[cfg(any(desktop, test))]
struct OpenAiTurnBuilder {
    model: String,
    blocks: Vec<Block>,
    text: String,
    functions: HashMap<String, OpenAiFunction>,
    emitted_calls: HashSet<String>,
    input_tokens: u32,
    output_tokens: u32,
    completed: bool,
    cancelled: bool,
}

#[cfg(any(desktop, test))]
impl OpenAiTurnBuilder {
    fn new(model: &str) -> Self {
        Self {
            model: model.into(),
            blocks: Vec::new(),
            text: String::new(),
            functions: HashMap::new(),
            emitted_calls: HashSet::new(),
            input_tokens: 0,
            output_tokens: 0,
            completed: false,
            cancelled: false,
        }
    }

    fn flush_text(&mut self) {
        if !self.text.is_empty() {
            self.blocks.push(Block::Text {
                text: std::mem::take(&mut self.text),
            });
        }
    }

    fn finish_function(&mut self, item: &Value) -> Option<StreamEvent> {
        let call_id = item["call_id"].as_str().unwrap_or_default().to_string();
        if call_id.is_empty() || !self.emitted_calls.insert(call_id.clone()) {
            return None;
        }
        let item_id = item["id"].as_str().unwrap_or(&call_id);
        let partial = self.functions.remove(item_id).unwrap_or_default();
        let name = item["name"]
            .as_str()
            .filter(|name| !name.is_empty())
            .unwrap_or(&partial.name)
            .to_string();
        let name = tool_names::canonical(&name).to_string();
        // output_item.done is canonical. Use its complete arguments when present;
        // deltas are only a fallback, so fragments can never be appended twice.
        let arguments = item["arguments"]
            .as_str()
            .filter(|value| !value.is_empty())
            .unwrap_or(&partial.arguments);
        let parsed = serde_json::from_str(arguments).unwrap_or_else(|_| json!({}));
        self.flush_text();
        self.blocks.push(Block::ToolUse {
            id: call_id.clone(),
            name: name.clone(),
            input: parsed.clone(),
        });
        Some(StreamEvent::ToolUse {
            id: call_id,
            name,
            input: parsed,
        })
    }

    fn process(&mut self, data: &str) -> Result<Vec<StreamEvent>, String> {
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return Ok(Vec::new());
        }
        let Ok(event) = serde_json::from_str::<Value>(data) else {
            return Ok(Vec::new());
        };
        let mut emitted = Vec::new();
        match event["type"].as_str() {
            Some("response.output_text.delta") => {
                if let Some(delta) = event["delta"].as_str() {
                    self.text.push_str(delta);
                    emitted.push(StreamEvent::TextDelta { text: delta.into() });
                }
            }
            Some("response.output_item.added") => {
                let item = &event["item"];
                if item["type"].as_str() == Some("function_call") {
                    let key = item["id"]
                        .as_str()
                        .or_else(|| item["call_id"].as_str())
                        .unwrap_or_default()
                        .to_string();
                    self.functions.insert(
                        key,
                        OpenAiFunction {
                            name: item["name"].as_str().unwrap_or_default().into(),
                            arguments: item["arguments"].as_str().unwrap_or_default().into(),
                        },
                    );
                }
            }
            Some("response.function_call_arguments.delta") => {
                if let (Some(item_id), Some(delta)) =
                    (event["item_id"].as_str(), event["delta"].as_str())
                {
                    self.functions
                        .entry(item_id.into())
                        .or_default()
                        .arguments
                        .push_str(delta);
                }
            }
            Some("response.output_item.done") => {
                let item = &event["item"];
                match item["type"].as_str() {
                    Some("function_call") => {
                        if let Some(tool) = self.finish_function(item) {
                            emitted.push(tool);
                        }
                    }
                    Some("reasoning") => {
                        self.flush_text();
                        self.blocks.push(Block::Reasoning {
                            model: Some(self.model.clone()),
                            id: item["id"].as_str().map(str::to_string),
                            encrypted_content: item["encrypted_content"]
                                .as_str()
                                .map(str::to_string),
                            summary: item["summary"].as_array().cloned().unwrap_or_default(),
                        });
                    }
                    _ => {}
                }
            }
            Some("response.completed") => {
                self.completed = true;
                let usage = &event["response"]["usage"];
                self.input_tokens = usage["input_tokens"]
                    .as_u64()
                    .unwrap_or_default()
                    .min(u32::MAX as u64) as u32;
                self.output_tokens = usage["output_tokens"]
                    .as_u64()
                    .unwrap_or_default()
                    .min(u32::MAX as u64) as u32;
            }
            Some("response.failed") => {
                return Err("OpenAI response failed before completion. Please retry.".into());
            }
            Some("response.incomplete") => {
                return Err("OpenAI response was incomplete. Please retry.".into());
            }
            Some("error") => {
                // Provider messages can include remote account or request IDs.
                // Keep every error crossing the event/IPC boundary value-free.
                return Err("OpenAI response stream reported an error. Please retry.".into());
            }
            _ => {}
        }
        Ok(emitted)
    }

    fn finish(mut self) -> Result<TurnResult, String> {
        if !self.completed && !self.cancelled {
            return Err(
                "The OpenAI response stream ended before response.completed. Please try again."
                    .into(),
            );
        }
        self.flush_text();
        let has_tools = self
            .blocks
            .iter()
            .any(|block| matches!(block, Block::ToolUse { .. }));
        Ok(TurnResult {
            content: self.blocks,
            stop_reason: if self.cancelled {
                "cancelled"
            } else if has_tools {
                "tool_use"
            } else {
                "end_turn"
            }
            .into(),
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
        })
    }
}

/// `AtomicBool` has no wake mechanism, so poll it briefly while network I/O is
/// pending. This keeps Stop responsive without changing the shared cancellation
/// type used by the agent loop.
#[cfg(desktop)]
async fn wait_for_cancellation(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// OpenAI Responses transport.
///
/// Production always uses [`OPENAI_RESPONSES_URL`]. Keeping the endpoint on the
/// provider instance gives integration tests a per-run transport seam: they can
/// exercise the real request builder, authentication headers, SSE decoder, and
/// agent retry path against a local server without mutating process-global
/// environment or weakening any authentication checks.
#[derive(Clone)]
#[cfg(desktop)]
pub struct OpenAiProvider {
    responses_url: Arc<str>,
}

#[cfg(desktop)]
impl Default for OpenAiProvider {
    fn default() -> Self {
        Self {
            responses_url: Arc::from(OPENAI_RESPONSES_URL),
        }
    }
}

#[cfg(desktop)]
impl OpenAiProvider {
    #[cfg(test)]
    pub(crate) fn with_responses_url(responses_url: impl Into<Arc<str>>) -> Self {
        Self {
            responses_url: responses_url.into(),
        }
    }
}

#[async_trait]
#[cfg(desktop)]
impl LlmProvider for OpenAiProvider {
    #[allow(clippy::too_many_arguments)]
    async fn stream_turn(
        &self,
        http: &reqwest::Client,
        cred: &Credential,
        model: &str,
        reasoning_effort: &str,
        response_speed: &str,
        system: &str,
        messages: &[ChatMessage],
        tools: &[Value],
        sink: &dyn EventSink,
        channel: &str,
        cancel: &Arc<AtomicBool>,
    ) -> Result<TurnResult, String> {
        let Credential::OpenAiOAuth(tokens) = cred else {
            return Err("OpenAI subscription inference requires ChatGPT sign-in.".into());
        };
        if model.trim().is_empty() {
            return Err("Select an OpenAI model before sending a message.".into());
        }
        let reasoning_effort = if reasoning_effort.trim().is_empty() {
            "medium"
        } else {
            reasoning_effort
        };
        let mut body = json!({
            "model": model,
            "instructions": system,
            "input": openai_input(messages, model),
            "tools": openai_tools(tools),
            "tool_choice": "auto",
            "parallel_tool_calls": true,
            "reasoning": { "effort": reasoning_effort },
            "store": false,
            "stream": true,
            "include": ["reasoning.encrypted_content"],
        });
        apply_openai_response_speed(&mut body, response_speed);
        let request = http
            .post(self.responses_url.as_ref())
            .header("content-type", "application/json")
            .header("accept", "text/event-stream");
        let request = crate::openai_oauth::authenticated_request(request, tokens)?;
        let mut builder = OpenAiTurnBuilder::new(model);
        let response = tokio::select! {
            biased;
            _ = wait_for_cancellation(cancel) => {
                builder.cancelled = true;
                return builder.finish();
            }
            response = tokio::time::timeout(
                Duration::from_secs(30),
                request.json(&body).send(),
            ) => response
                .map_err(|_| "OpenAI request timed out before streaming began.".to_string())?
                .map_err(|e| format!("OpenAI request failed: {e}"))?,
        };
        if !response.status().is_success() {
            let status = response.status();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                return Err(OPENAI_UNAUTHORIZED_ERROR.into());
            }
            // Provider-controlled error bodies are neither displayed nor needed
            // for classification. Do not buffer or parse them: an unbounded or
            // never-ending error response must not allocate indefinitely or park
            // the turn after the status line has already supplied the safe result.
            return Err(format!(
                "OpenAI response was rejected (HTTP {}). Please retry.",
                status.as_u16()
            ));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();
        loop {
            if cancel.load(Ordering::Relaxed) {
                builder.cancelled = true;
                break;
            }
            let next = tokio::select! {
                biased;
                _ = wait_for_cancellation(cancel) => {
                    builder.cancelled = true;
                    break;
                }
                next = tokio::time::timeout(Duration::from_secs(120), stream.next()) => {
                    next.map_err(|_| {
                        "OpenAI stream stalled for 120 seconds. Please try again.".to_string()
                    })?
                }
            };
            let Some(chunk) = next else { break };
            buffer.extend_from_slice(&chunk.map_err(|e| format!("OpenAI stream error: {e}"))?);
            if buffer.len() > 1024 * 1024 {
                return Err(
                    "OpenAI sent an SSE frame larger than 1 MiB; the turn was aborted.".into(),
                );
            }
            while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = buffer.drain(..=end).collect();
                let line = String::from_utf8_lossy(&line);
                if let Some(data) = line.trim().strip_prefix("data:") {
                    for event in builder.process(data)? {
                        sink.emit(channel, event);
                    }
                }
            }
        }
        if !buffer.is_empty() {
            let line = String::from_utf8_lossy(&buffer);
            if let Some(data) = line.trim().strip_prefix("data:") {
                for event in builder.process(data)? {
                    sink.emit(channel, event);
                }
            }
        }
        builder.finish()
    }
}

#[cfg(any(desktop, test))]
fn apply_openai_response_speed(body: &mut Value, response_speed: &str) {
    // Standard intentionally leaves the field absent so the subscription backend
    // keeps its native default. Fast opts into Responses priority processing.
    if response_speed == "fast" {
        body["service_tier"] = json!("priority");
    }
}

/// Resolve the provider named by `settings.provider`. An unknown name fails the
/// run with a clear message instead of silently defaulting to Anthropic, so a
/// mis-set provider surfaces immediately rather than producing confusing calls.
pub fn provider_for(name: &str) -> Result<Box<dyn LlmProvider>, String> {
    match name {
        "anthropic" => Ok(Box::new(AnthropicProvider)),
        "openai" => {
            #[cfg(desktop)]
            {
                Ok(Box::new(OpenAiProvider::default()))
            }
            #[cfg(not(desktop))]
            {
                Err("OpenAI subscription inference is available on desktop builds only.".into())
            }
        }
        other => {
            #[cfg(desktop)]
            let supported = "anthropic, openai";
            #[cfg(not(desktop))]
            let supported = "anthropic";
            Err(format!(
                "Unknown LLM provider '{other}'. Portcode currently supports: {supported}."
            ))
        }
    }
}

/// Infer the provider from the selected model. Unknown model slugs fail closed
/// instead of falling back to a separately configured provider, which could
/// otherwise route a request (and its credentials) to the wrong service.
pub fn provider_name_for_model(model: &str) -> Result<&'static str, String> {
    if model.starts_with("claude-") {
        Ok("anthropic")
    } else if model.starts_with("gpt-")
        || model.starts_with("codex-")
        || model.starts_with("openai-")
        || model
            .strip_prefix('o')
            .and_then(|rest| rest.chars().next())
            .is_some_and(|digit| digit.is_ascii_digit())
    {
        Ok("openai")
    } else {
        Err(format!(
            "Cannot determine the LLM provider for model '{model}'. Select a recognized Claude or OpenAI model."
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::OAuthTokens;

    #[cfg(desktop)]
    struct NoopSink;

    #[cfg(desktop)]
    impl EventSink for NoopSink {
        fn emit(&self, _channel: &str, _event: StreamEvent) {}
    }

    fn oauth_cred() -> Credential {
        Credential::OAuth(OAuthTokens {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            expires_at: 0,
            email: None,
            plan: None,
        })
    }

    #[cfg(desktop)]
    #[tokio::test]
    async fn cancellation_wait_observes_a_later_stop_signal() {
        let cancel = Arc::new(AtomicBool::new(false));
        let trigger = Arc::clone(&cancel);
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            trigger.store(true, Ordering::Relaxed);
        });

        tokio::time::timeout(Duration::from_secs(1), wait_for_cancellation(&cancel))
            .await
            .expect("cancellation polling should release pending OpenAI I/O");
    }

    #[cfg(desktop)]
    #[tokio::test]
    async fn openai_non_success_status_does_not_wait_for_or_buffer_the_body() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut chunk).await.unwrap();
                assert!(read > 0, "client closed before sending request headers");
                request.extend_from_slice(&chunk[..read]);
            }
            stream
                .write_all(
                    b"HTTP/1.1 500 Internal Server Error\r\n\
Content-Type: application/json\r\n\
Content-Length: 1048576\r\n\
Connection: keep-alive\r\n\r\n\
{\"provider_secret\":\"must-not-be-read",
                )
                .await
                .unwrap();
            stream.flush().await.unwrap();
            std::future::pending::<()>().await;
        });

        let credential = Credential::OpenAiOAuth(crate::secrets::OpenAiOAuthTokens {
            access_token: "access-token".into(),
            refresh_token: "refresh-token".into(),
            id_token: None,
            expires_at: i64::MAX,
            account_id: Some("account-id".into()),
            email: None,
            plan: None,
            is_fedramp: false,
        });
        let provider = OpenAiProvider::with_responses_url(format!("http://{address}/responses"));
        let cancel = Arc::new(AtomicBool::new(false));
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            provider.stream_turn(
                &reqwest::Client::new(),
                &credential,
                "gpt-5.6-sol",
                "medium",
                "standard",
                "system",
                &[ChatMessage {
                    role: "user".into(),
                    content: vec![Block::Text {
                        text: "hello".into(),
                    }],
                }],
                &[],
                &NoopSink,
                "test",
                &cancel,
            ),
        )
        .await
        .expect("status-only error handling must not wait for the open body")
        .expect_err("HTTP 500 must fail the turn");
        server.abort();

        assert_eq!(
            result,
            "OpenAI response was rejected (HTTP 500). Please retry."
        );
        assert!(!result.contains("provider_secret"));
    }

    #[test]
    fn oauth_system_prepends_claude_code_identity_block() {
        let system = build_system(&oauth_cred(), "PORTCODE PROMPT");
        let blocks = system
            .as_array()
            .expect("OAuth system must be a block array");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[0]["text"], CLAUDE_CODE_IDENTITY);
        assert_eq!(blocks[1]["text"], "PORTCODE PROMPT");
    }

    #[test]
    fn api_key_system_is_plain_string_without_identity() {
        let system = build_system(&Credential::ApiKey("sk-test".into()), "PORTCODE PROMPT");
        assert_eq!(system, Value::String("PORTCODE PROMPT".into()));
        assert!(
            !system.to_string().contains("Claude Code"),
            "API-key requests must not carry the Claude Code identity"
        );
    }

    #[test]
    fn provider_for_resolves_available_providers_and_rejects_unknown() {
        assert!(provider_for("anthropic").is_ok());
        #[cfg(desktop)]
        assert!(provider_for("openai").is_ok());
        #[cfg(not(desktop))]
        assert_eq!(
            provider_for("openai").err().as_deref(),
            Some("OpenAI subscription inference is available on desktop builds only.")
        );
        // Extract the error without `unwrap_err()` — that requires the `Ok` type
        // (`Box<dyn LlmProvider>`) to be `Debug`, which a trait object is not.
        let Err(err) = provider_for("other") else {
            panic!("an unknown provider must not resolve");
        };
        assert!(
            err.contains("other"),
            "error should name the bad provider: {err}"
        );
        assert!(
            err.contains("anthropic"),
            "error should name the supported provider: {err}"
        );
    }

    #[test]
    fn selected_model_determines_provider() {
        assert_eq!(
            provider_name_for_model("gpt-5.3-codex").expect("GPT models resolve to OpenAI"),
            "openai"
        );
        assert_eq!(
            provider_name_for_model("o3").expect("reasoning models resolve to OpenAI"),
            "openai"
        );
        assert_eq!(
            provider_name_for_model("claude-opus-4-8").expect("Claude models resolve to Anthropic"),
            "anthropic"
        );
    }

    #[test]
    fn unknown_model_provider_fails_closed() {
        let err = provider_name_for_model("custom-model")
            .expect_err("an unknown model must not inherit another provider");
        assert!(
            err.contains("custom-model"),
            "error should name the unrecognized model: {err}"
        );
        assert!(
            err.contains("recognized Claude or OpenAI model"),
            "error should explain how to recover: {err}"
        );
    }

    #[cfg(desktop)]
    #[test]
    fn openai_receives_only_the_registrys_canonical_tool_names() {
        let registry = crate::tools::default_registry();
        let functions = openai_tools(&registry.specs());
        let advertised: Vec<&str> = functions
            .iter()
            .map(|tool| tool["name"].as_str().expect("function name"))
            .collect();

        assert_eq!(advertised, crate::tool_names::CANONICAL_NAMES);
        for (legacy, _) in crate::tool_names::LEGACY_ALIASES {
            assert!(!advertised.contains(&legacy));
        }
    }

    #[test]
    fn openai_request_mapping_preserves_reasoning_and_tool_linkage() {
        let input = openai_input(
            &[
                ChatMessage {
                    role: "assistant".into(),
                    content: vec![
                        Block::Reasoning {
                            model: Some("gpt-5.3-codex".into()),
                            id: Some("r1".into()),
                            encrypted_content: Some("opaque".into()),
                            summary: Vec::new(),
                        },
                        Block::ToolUse {
                            id: "call_1".into(),
                            name: "read_file".into(),
                            input: json!({"path":"a"}),
                        },
                    ],
                },
                ChatMessage {
                    role: "user".into(),
                    content: vec![Block::ToolResult {
                        tool_use_id: "call_1".into(),
                        content: "ok".into(),
                        is_error: false,
                    }],
                },
            ],
            "gpt-5.3-codex",
        );
        assert_eq!(input[0]["type"], "reasoning");
        assert_eq!(input[0]["encrypted_content"], "opaque");
        assert_eq!(input[1]["call_id"], "call_1");
        assert_eq!(input[2]["type"], "function_call_output");
        assert_eq!(input[2]["call_id"], "call_1");

        let switched = openai_input(
            &[ChatMessage {
                role: "assistant".into(),
                content: vec![Block::Reasoning {
                    model: Some("gpt-5.3-codex".into()),
                    id: Some("r1".into()),
                    encrypted_content: Some("opaque".into()),
                    summary: Vec::new(),
                }],
            }],
            "gpt-5.6-sol",
        );
        assert!(
            switched.is_empty(),
            "model-specific reasoning is not replayed after a switch"
        );
    }

    #[test]
    fn openai_fast_speed_requests_priority_processing() {
        let mut standard = json!({ "model": "gpt-5.6-sol" });
        apply_openai_response_speed(&mut standard, "standard");
        assert!(standard.get("service_tier").is_none());

        let mut fast = json!({ "model": "gpt-5.6-sol" });
        apply_openai_response_speed(&mut fast, "fast");
        assert_eq!(fast["service_tier"], "priority");
    }

    #[test]
    fn openai_parser_emits_canonical_tool_once_and_requires_completion() {
        let mut builder = OpenAiTurnBuilder::new("gpt-5.3-codex");
        builder
            .process(r#"{"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"{\"path\":\"a\"}"}"#)
            .unwrap();
        let events = builder
            .process(r#"{"type":"response.output_item.done","item":{"type":"function_call","id":"item_1","call_id":"call_1","name":"fs_read","arguments":"{\"path\":\"a\"}"}}"#)
            .unwrap();
        assert_eq!(
            events,
            [StreamEvent::ToolUse {
                id: "call_1".into(),
                name: "read_file".into(),
                input: json!({ "path": "a" }),
            }]
        );
        assert!(builder
            .process(r#"{"type":"response.output_item.done","item":{"type":"function_call","id":"item_1","call_id":"call_1","name":"fs_read","arguments":"{}"}}"#)
            .unwrap()
            .is_empty());
        builder
            .process(r#"{"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":4}}}"#)
            .unwrap();
        let result = builder.finish().unwrap();
        assert_eq!(result.stop_reason, "tool_use");
        assert_eq!(result.input_tokens, 9);
        assert_eq!(result.output_tokens, 4);
        match &result.content[0] {
            Block::ToolUse { id, name, input } => {
                assert_eq!(id, "call_1");
                assert_eq!(name, "read_file");
                assert_eq!(input, &json!({"path":"a"}));
            }
            other => panic!("expected tool use, got {other:?}"),
        }
    }

    #[test]
    fn openai_parser_rejects_truncated_stream() {
        let mut builder = OpenAiTurnBuilder::new("gpt-5.3-codex");
        builder
            .process(r#"{"type":"response.output_text.delta","delta":"partial"}"#)
            .unwrap();
        assert!(builder
            .finish()
            .expect_err("must reject truncation")
            .contains("response.completed"));
    }

    #[test]
    fn openai_parser_never_echoes_provider_error_values() {
        for (event, expected) in [
            (
                r#"{"type":"response.failed","response":{"error":{"message":"secret-account@example.invalid"}}}"#,
                "OpenAI response failed before completion. Please retry.",
            ),
            (
                r#"{"type":"response.incomplete","response":{"incomplete_details":{"reason":"request_remote_id_123"}}}"#,
                "OpenAI response was incomplete. Please retry.",
            ),
            (
                r#"{"type":"error","message":"remote-account-token"}"#,
                "OpenAI response stream reported an error. Please retry.",
            ),
        ] {
            let mut builder = OpenAiTurnBuilder::new("gpt-5.3-codex");
            let error = builder
                .process(event)
                .expect_err("provider error must abort");
            assert_eq!(error, expected);
            assert!(!error.contains("secret-account"));
            assert!(!error.contains("remote_id"));
            assert!(!error.contains("remote-account"));
        }
    }

    // ---- TurnBuilder: the SSE event → turn state machine ----------------------
    //
    // These drive the *pure* parser with scripted Anthropic SSE `data:` payloads
    // (the JSON after the `data:` prefix), so the streaming assembly logic is
    // covered without a live HTTP stream, a Tauri runtime, or the network.

    /// Run a fresh `TurnBuilder` through a script of SSE payloads, collecting
    /// every emitted event in order. Panics if any payload yields an error event
    /// (assert the error path with `process` directly instead).
    fn drive(lines: &[&str]) -> (TurnBuilder, Vec<StreamEvent>) {
        let mut b = TurnBuilder::new();
        let mut events = Vec::new();
        for line in lines {
            events.extend(b.process(line).expect("no error event in this script"));
        }
        (b, events)
    }

    #[test]
    fn assembles_text_turn_with_usage_and_stop_reason() {
        let (b, events) = drive(&[
            r#"{"type":"message_start","message":{"usage":{"input_tokens":11}}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello, "}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}"#,
        ]);
        // Each text delta is surfaced live, in arrival order.
        assert_eq!(
            events,
            vec![
                StreamEvent::TextDelta {
                    text: "Hello, ".into()
                },
                StreamEvent::TextDelta {
                    text: "world".into()
                },
            ]
        );
        let result = b.finish().expect("a closed text turn finalizes");
        assert_eq!(result.input_tokens, 11);
        assert_eq!(result.output_tokens, 7);
        assert_eq!(result.stop_reason, "end_turn");
        assert_eq!(result.content.len(), 1);
        match &result.content[0] {
            Block::Text { text } => assert_eq!(text, "Hello, world"),
            other => panic!("expected a single text block, got {other:?}"),
        }
    }

    #[test]
    fn canonicalizes_legacy_tool_alias_in_block_and_stream_event() {
        let (b, events) = drive(&[
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"fs_read"}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"a.txt\"}"}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}"#,
        ]);
        // The ToolUse event lands once, at content_block_stop, with the full
        // JSON reassembled from its partial_json fragments.
        assert_eq!(
            events,
            vec![StreamEvent::ToolUse {
                id: "toolu_1".into(),
                name: "read_file".into(),
                input: json!({ "path": "a.txt" }),
            }]
        );
        let result = b.finish().expect("a closed tool turn finalizes");
        assert_eq!(result.stop_reason, "tool_use");
        assert_eq!(result.output_tokens, 3);
        match &result.content[0] {
            Block::ToolUse { id, name, input } => {
                assert_eq!(id, "toolu_1");
                assert_eq!(name, "read_file");
                assert_eq!(input, &json!({ "path": "a.txt" }));
            }
            other => panic!("expected a tool_use block, got {other:?}"),
        }
    }

    #[test]
    fn tool_use_with_no_input_defaults_to_empty_object() {
        let (b, events) = drive(&[
            r#"{"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_x","name":"list"}}"#,
            r#"{"type":"content_block_stop"}"#,
        ]);
        assert_eq!(
            events,
            vec![StreamEvent::ToolUse {
                id: "toolu_x".into(),
                name: "list_directory".into(),
                input: json!({}),
            }]
        );
        match &b.finish().expect("finalizes").content[0] {
            Block::ToolUse { input, .. } => assert_eq!(input, &json!({})),
            other => panic!("expected tool_use, got {other:?}"),
        }
    }

    #[test]
    fn tool_use_with_malformed_json_falls_back_to_empty_object() {
        // A truncated/garbled argument stream must not poison the turn; it
        // degrades to an empty-object input rather than failing to parse.
        let (b, _events) = drive(&[
            r#"{"type":"content_block_start","content_block":{"type":"tool_use","id":"t","name":"n"}}"#,
            r#"{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{not valid"}}"#,
            r#"{"type":"content_block_stop"}"#,
        ]);
        match &b.finish().expect("finalizes").content[0] {
            Block::ToolUse { input, .. } => assert_eq!(input, &json!({})),
            other => panic!("expected tool_use, got {other:?}"),
        }
    }

    #[test]
    fn error_event_is_surfaced_as_err() {
        let mut b = TurnBuilder::new();
        let err = b
            .process(r#"{"type":"error","error":{"message":"overloaded_error"}}"#)
            .expect_err("an error event must abort the turn");
        assert!(err.contains("overloaded_error"), "got: {err}");
    }

    #[test]
    fn error_event_without_message_uses_fallback() {
        let mut b = TurnBuilder::new();
        let err = b
            .process(r#"{"type":"error","error":{}}"#)
            .expect_err("still an error");
        assert_eq!(err, "unknown streaming error");
    }

    #[test]
    fn unclosed_block_finishes_as_truncation_error() {
        // A block is opened but never closed (the stream was cut off): the turn
        // must surface a truncation error rather than drop the partial block.
        let (b, _events) = drive(&[
            r#"{"type":"content_block_start","content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}"#,
        ]);
        let err = b
            .finish()
            .expect_err("an open block at end is a truncation");
        assert!(err.contains("cut off"), "got: {err}");
    }

    #[test]
    fn cancelled_turn_with_open_text_block_keeps_partial_text() {
        let mut b = TurnBuilder::new();
        b.process(r#"{"type":"content_block_start","content_block":{"type":"text","text":""}}"#)
            .unwrap();
        b.process(r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}"#)
            .unwrap();
        b.mark_cancelled();
        let result = b
            .finish()
            .expect("a cancelled turn is not a truncation error");
        assert_eq!(result.stop_reason, "cancelled");
        assert!(matches!(
            result.content.as_slice(),
            [Block::Text { text }] if text == "hi"
        ));
    }

    #[test]
    fn cancelled_turn_with_empty_open_text_block_keeps_nothing() {
        let mut b = TurnBuilder::new();
        b.process(r#"{"type":"content_block_start","content_block":{"type":"text","text":""}}"#)
            .unwrap();
        b.mark_cancelled();

        let result = b.finish().expect("a cancelled turn finalizes");
        assert_eq!(result.stop_reason, "cancelled");
        assert!(result.content.is_empty());
    }

    #[test]
    fn cancelled_turn_with_open_tool_block_drops_partial_call() {
        let mut b = TurnBuilder::new();
        b.process(
            r#"{"type":"content_block_start","content_block":{"type":"tool_use","id":"t","name":"read_file"}}"#,
        )
        .unwrap();
        b.process(
            r#"{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"pa"}}"#,
        )
        .unwrap();
        b.mark_cancelled();

        let result = b.finish().expect("a cancelled turn finalizes");
        assert_eq!(result.stop_reason, "cancelled");
        assert!(result.content.is_empty());
    }

    #[test]
    fn empty_and_unparseable_payloads_are_ignored() {
        let mut b = TurnBuilder::new();
        assert!(b.process("").unwrap().is_empty());
        assert!(b.process("   ").unwrap().is_empty());
        assert!(b.process("not json at all").unwrap().is_empty());
        assert!(b.process(r#"{"type":"ping"}"#).unwrap().is_empty());
        // None of that moved the cursor or produced content.
        let result = b.finish().expect("finalizes");
        assert!(result.content.is_empty());
        assert_eq!(result.stop_reason, "end_turn");
    }

    #[test]
    fn text_delta_without_open_text_block_is_dropped() {
        // A stray text delta with no current block must not panic or emit.
        let mut b = TurnBuilder::new();
        let events = b
            .process(r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}"#)
            .unwrap();
        assert!(events.is_empty());
        assert!(b.finish().unwrap().content.is_empty());
    }

    #[test]
    fn input_json_delta_without_open_tool_block_is_dropped() {
        // The tool-arg counterpart: a stray input_json_delta with no current
        // block must also be silently dropped, leaving the turn empty.
        let mut b = TurnBuilder::new();
        let events = b
            .process(
                r#"{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"x\":1}"}}"#,
            )
            .unwrap();
        assert!(events.is_empty());
        assert!(b.finish().unwrap().content.is_empty());
    }

    #[test]
    fn fresh_builder_finishes_with_default_stop_reason() {
        assert_eq!(TurnBuilder::new().finish().unwrap().stop_reason, "end_turn");
    }

    #[test]
    fn assembles_mixed_text_then_tool_turn_in_order() {
        let (b, events) = drive(&[
            r#"{"type":"message_start","message":{"usage":{"input_tokens":20}}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me read it."}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"read_file"}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"x\"}"}}"#,
            r#"{"type":"content_block_stop","index":1}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}"#,
        ]);
        assert_eq!(
            events,
            vec![
                StreamEvent::TextDelta {
                    text: "Let me read it.".into()
                },
                StreamEvent::ToolUse {
                    id: "toolu_2".into(),
                    name: "read_file".into(),
                    input: json!({ "path": "x" }),
                },
            ]
        );
        let result = b.finish().unwrap();
        assert_eq!(result.content.len(), 2);
        assert_eq!(result.input_tokens, 20);
        assert_eq!(result.output_tokens, 15);
        assert!(matches!(result.content[0], Block::Text { .. }));
        assert!(matches!(result.content[1], Block::ToolUse { .. }));
    }
}
