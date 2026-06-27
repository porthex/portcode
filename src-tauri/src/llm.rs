//! LLM message/event types, the [`LlmProvider`] trait seam, and the Anthropic
//! streaming client.
//!
//! Portcode is Claude-first: `AnthropicProvider` is the only implementation
//! today. The agent loop depends only on the [`LlmProvider`] trait, so other
//! model providers slot in (the "any model" goal) by adding an impl + a
//! [`provider_for`] arm — without touching the loop.
//!
//! `Block`/`ChatMessage` are serialized directly into the Anthropic Messages
//! API request body, so their serde shapes intentionally match that wire format.
//! They are the neutral vocabulary every provider speaks (also the DB + Phone
//! Sync wire types), so a future non-Anthropic provider maps onto them.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;

use async_trait::async_trait;
use futures_util::StreamExt;

use crate::secrets::Credential;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 8192;

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
    }
}

/// A single content block, matching the Anthropic content-block wire format.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: Vec<Block>,
}

/// Events streamed to the frontend. Tagged + camelCased to match `StreamEvent`
/// in `src/types.ts`. `Deserialize` lets Phone Sync decode it on the phone side
/// (it is forwarded verbatim inside `sync::protocol::SyncFrame::Live`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    TurnStart {
        #[serde(rename = "messageId")]
        message_id: String,
    },
    TextDelta {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        output: String,
        #[serde(rename = "isError")]
        is_error: bool,
    },
    PermissionRequest {
        id: String,
        tool: String,
        summary: String,
        input: Value,
        /// A pre-apply unified diff for file tools (fs_write/fs_edit), shown in
        /// the prompt before the change is written. Optional + skipped when None,
        /// so older decoders (and the phone) tolerate its absence.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<String>,
    },
    Usage {
        #[serde(rename = "inputTokens")]
        input_tokens: u32,
        #[serde(rename = "outputTokens")]
        output_tokens: u32,
    },
    TurnEnd {
        #[serde(rename = "stopReason")]
        stop_reason: String,
    },
    Error {
        message: String,
    },
    /// A subagent (the `task` tool) started. Emitted on the SESSION channel so the
    /// live agents panel sees it even though the subagent's own deltas stream on a
    /// private `agent://{session}:{agentId}` channel. `parent_id` is the launching
    /// subagent's id when nested (absent for a top-level launch).
    AgentStarted {
        #[serde(rename = "agentId")]
        agent_id: String,
        description: String,
        #[serde(rename = "parentId", default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
    },
    /// A subagent completed a model turn — a cheap liveness signal for the panel.
    /// `step` is its 1-based turn count.
    AgentProgress {
        #[serde(rename = "agentId")]
        agent_id: String,
        step: u32,
    },
    /// A subagent finished. `status` is `"ok"`, `"cancelled"`, or `"error"`.
    AgentFinished {
        #[serde(rename = "agentId")]
        agent_id: String,
        status: String,
    },
}

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
    fn finish(self) -> Result<TurnResult, String> {
        if self.current.is_some() && self.stop_reason != "cancelled" {
            return Err(
                "The response was cut off before it finished. Please try again.".to_string(),
            );
        }
        Ok(TurnResult {
            content: self.blocks,
            stop_reason: self.stop_reason,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
        })
    }
}

fn emit(app: &AppHandle, channel: &str, ev: StreamEvent) {
    // Canonical chokepoint: delivers to the desktop UI and mirrors to the phone.
    crate::sync::emit_event(app, channel, ev);
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
    app: &AppHandle,
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
                emit(app, channel, ev);
            }
        }
    }

    builder.finish()
}

/// The LLM provider seam. The agent loop depends only on this trait, so adding a
/// model provider means adding an `impl` + a [`provider_for`] arm — the loop
/// itself never changes. `AnthropicProvider` is the only provider today.
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
        system: &str,
        messages: &[ChatMessage],
        tools: &[Value],
        app: &AppHandle,
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
        system: &str,
        messages: &[ChatMessage],
        tools: &[Value],
        app: &AppHandle,
        channel: &str,
        cancel: &Arc<AtomicBool>,
    ) -> Result<TurnResult, String> {
        stream_turn(
            http, cred, model, system, messages, tools, app, channel, cancel,
        )
        .await
    }
}

/// Resolve the provider named by `settings.provider`. An unknown name fails the
/// run with a clear message instead of silently defaulting to Anthropic, so a
/// mis-set provider surfaces immediately rather than producing confusing calls.
pub fn provider_for(name: &str) -> Result<Box<dyn LlmProvider>, String> {
    match name {
        "anthropic" => Ok(Box::new(AnthropicProvider)),
        other => Err(format!(
            "Unknown LLM provider '{other}'. Portcode currently supports: anthropic."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::OAuthTokens;

    fn oauth_cred() -> Credential {
        Credential::OAuth(OAuthTokens {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            expires_at: 0,
            email: None,
            plan: None,
        })
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
    fn provider_for_resolves_anthropic_and_rejects_unknown() {
        // The only implemented provider resolves; anything else fails loudly,
        // and the message names both the bad id and the supported one.
        assert!(provider_for("anthropic").is_ok());
        // Extract the error without `unwrap_err()` — that requires the `Ok` type
        // (`Box<dyn LlmProvider>`) to be `Debug`, which a trait object is not.
        let Err(err) = provider_for("openai") else {
            panic!("an unknown provider must not resolve");
        };
        assert!(
            err.contains("openai"),
            "error should name the bad provider: {err}"
        );
        assert!(
            err.contains("anthropic"),
            "error should name the supported provider: {err}"
        );
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
    fn assembles_tool_use_block_and_emits_tooluse_event_on_stop() {
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
                name: "fs_read".into(),
                input: json!({ "path": "a.txt" }),
            }]
        );
        let result = b.finish().expect("a closed tool turn finalizes");
        assert_eq!(result.stop_reason, "tool_use");
        assert_eq!(result.output_tokens, 3);
        match &result.content[0] {
            Block::ToolUse { id, name, input } => {
                assert_eq!(id, "toolu_1");
                assert_eq!(name, "fs_read");
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
                name: "list".into(),
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
    fn cancelled_turn_with_open_block_finishes_ok() {
        // Cancellation legitimately stops mid-block, so finish() must not treat
        // the still-open block as a truncation.
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
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"fs_read"}}"#,
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
                    name: "fs_read".into(),
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
