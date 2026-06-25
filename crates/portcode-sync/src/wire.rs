//! The pure-serde wire DTOs the Phone Sync protocol moves across the channel.
//!
//! These types previously lived in the desktop crate's `llm.rs` (`Block`,
//! `ChatMessage`, `StreamEvent`) and `db.rs` (`SessionRow`, `MessageRow`). They
//! are extracted here UNCHANGED (same field names, same serde attributes) so the
//! shared `protocol.rs`/`session.rs` — and the future wasm client — can encode
//! and decode them without pulling in `rusqlite`/`reqwest`/`tauri`.
//!
//! `src-tauri` re-exports each of these from `llm`/`db` (`pub use
//! portcode_sync::wire::…`), so every existing `crate::llm::StreamEvent` /
//! `crate::db::SessionRow` path in the desktop keeps resolving to the SAME type —
//! the move is source-compatible. The serde shapes are load-bearing (they match
//! `src/types.ts` and the Anthropic content-block format); do not alter them.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A single content block, matching the Anthropic content-block wire format.
/// (Was `crate::llm::Block`.)
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

/// An Anthropic-shaped chat message. (Was `crate::llm::ChatMessage`.)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: Vec<Block>,
}

/// Events streamed to the frontend. Tagged + camelCased to match `StreamEvent`
/// in `src/types.ts`. `Deserialize` lets Phone Sync decode it on the phone side
/// (it is forwarded verbatim inside `protocol::SyncFrame::Live`).
/// (Was `crate::llm::StreamEvent`.)
#[derive(Serialize, Deserialize, Clone, Debug)]
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

/// A session header row. (Was `crate::db::SessionRow`.)
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    pub workspace: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One persisted message, with its raw append-only `seq` — the flat row Phone
/// Sync replicates (the `MessageDelta` catch-up frame ships these verbatim).
/// `content` is the typed block list (same shape as [`ChatMessage::content`]).
/// (Was `crate::db::MessageRow`.)
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    pub role: String,
    pub content: Vec<Block>,
    pub created_at: i64,
}
