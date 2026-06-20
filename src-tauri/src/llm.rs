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

fn emit(app: &AppHandle, channel: &str, ev: StreamEvent) {
    let _ = app.emit(channel, ev);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::OAuthTokens;

    fn oauth_cred() -> Credential {
        Credential::OAuth(OAuthTokens {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            expires_at: 0,
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
}
