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

// On wasm these DTOs also derive `Tsify` (cfg-gated, like the protocol types in
// `protocol.rs`) because `SyncFrame` embeds them — tsify needs every reachable
// type to derive `Tsify` so the generated `.d.ts` references resolve. Nested types
// only need the type declaration (no `into/from_wasm_abi`); only the top-level
// boundary-crossing types in `protocol.rs` carry those. The derive is wasm-only
// ABI glue and never touches the native desktop build. `Value` (the `input` on
// tool blocks) maps to TS `any`, the intended shape.
#[cfg(target_arch = "wasm32")]
use tsify::Tsify;

/// A single content block, matching the Anthropic content-block wire format.
/// (Was `crate::llm::Block`.)
#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
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
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
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
    /// A `shell` command was launched in the background (the `background` mode).
    BackgroundTaskStarted {
        id: String,
        command: String,
    },
    /// A background `shell` command finished. Emitted on the SESSION channel — it
    /// can arrive AFTER the launching turn ended, so it is delivered to a persistent
    /// session listener rather than the per-turn one.
    BackgroundTaskFinished {
        id: String,
        command: String,
        #[serde(rename = "exitCode")]
        exit_code: i32,
        output: String,
    },
}

/// A session header row. (Was `crate::db::SessionRow`.)
#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    /// Current git branch of `workspace`, computed live on each list; None when
    /// no workspace/repo or detached HEAD.
    #[serde(default)]
    pub branch: Option<String>,
    pub workspace: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One persisted message, with its raw append-only `seq` — the flat row Phone
/// Sync replicates (the `MessageDelta` catch-up frame ships these verbatim).
/// `content` is the typed block list (same shape as [`ChatMessage::content`]).
/// (Was `crate::db::MessageRow`.)
#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    pub role: String,
    pub content: Vec<Block>,
    pub created_at: i64,
}
