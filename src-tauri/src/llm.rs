//! Provider-facing message types and the Anthropic streaming client.
//!
//! `Block`/`ChatMessage` are serialized directly into the Anthropic Messages
//! API request body, so their serde shapes intentionally match that wire format.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use futures_util::StreamExt;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 8192;

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
/// in `src/types.ts`.
#[derive(Serialize, Clone, Debug)]
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
}

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
    system: &'a str,
    messages: &'a [ChatMessage],
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    tools: &'a [Value],
    stream: bool,
}

enum Building {
    Text(String),
    Tool { id: String, name: String, json: String },
}

fn emit(app: &AppHandle, channel: &str, ev: StreamEvent) {
    let _ = app.emit(channel, ev);
}

/// Stream a single assistant turn. Emits text/tool events as they arrive and
/// returns the fully assembled turn so the agent loop can act on tool calls.
#[allow(clippy::too_many_arguments)]
pub async fn stream_turn(
    http: &reqwest::Client,
    api_key: &str,
    model: &str,
    system: &str,
    messages: &[ChatMessage],
    tools: &[Value],
    app: &AppHandle,
    channel: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<TurnResult, String> {
    let body = Request {
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages,
        tools,
        stream: true,
    };

    let resp = http
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
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

    let mut blocks: Vec<Block> = Vec::new();
    let mut current: Option<Building> = None;
    let mut stop_reason = String::from("end_turn");
    let mut input_tokens: u32 = 0;
    let mut output_tokens: u32 = 0;

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            stop_reason = "cancelled".into();
            break;
        }
        let bytes = chunk.map_err(|e| format!("Stream error: {e}"))?;
        buf.extend_from_slice(&bytes);

        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim();
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else {
                continue;
            };

            match v["type"].as_str() {
                Some("message_start") => {
                    if let Some(n) = v["message"]["usage"]["input_tokens"].as_u64() {
                        input_tokens = n as u32;
                    }
                }
                Some("content_block_start") => {
                    let cb = &v["content_block"];
                    current = match cb["type"].as_str() {
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
                                emit(app, channel, StreamEvent::TextDelta { text: t.into() });
                                if let Some(Building::Text(s)) = current.as_mut() {
                                    s.push_str(t);
                                }
                            }
                        }
                        Some("input_json_delta") => {
                            if let Some(pj) = d["partial_json"].as_str() {
                                if let Some(Building::Tool { json, .. }) = current.as_mut() {
                                    json.push_str(pj);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Some("content_block_stop") => match current.take() {
                    Some(Building::Text(s)) => blocks.push(Block::Text { text: s }),
                    Some(Building::Tool { id, name, json }) => {
                        let input: Value = if json.trim().is_empty() {
                            json!({})
                        } else {
                            serde_json::from_str(&json).unwrap_or_else(|_| json!({}))
                        };
                        emit(
                            app,
                            channel,
                            StreamEvent::ToolUse {
                                id: id.clone(),
                                name: name.clone(),
                                input: input.clone(),
                            },
                        );
                        blocks.push(Block::ToolUse { id, name, input });
                    }
                    None => {}
                },
                Some("message_delta") => {
                    if let Some(sr) = v["delta"]["stop_reason"].as_str() {
                        stop_reason = sr.to_string();
                    }
                    if let Some(n) = v["usage"]["output_tokens"].as_u64() {
                        output_tokens = n as u32;
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
        }
    }

    Ok(TurnResult {
        content: blocks,
        stop_reason,
        input_tokens,
        output_tokens,
    })
}
