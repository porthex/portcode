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
//! `src/types.ts` and provider persistence); alter them only with matching
//! desktop, phone-sync, and frontend compatibility updates.

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
    /// Opaque OpenAI reasoning state required when continuing a Responses turn
    /// after tool calls. It is persisted on desktop but filtered from UI and
    /// Phone Sync payloads.
    Reasoning {
        /// Model that produced this opaque state. Never sent to OpenAI; used to
        /// avoid replaying model-specific reasoning after a model switch.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        encrypted_content: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        summary: Vec<Value>,
    },
}

/// An Anthropic-shaped chat message. (Was `crate::llm::ChatMessage`.)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: Vec<Block>,
}

/// Terminal state of one root agent turn. `Interrupted` is persisted when a
/// process dies after the durable turn row was created but before a terminal
/// event could be emitted.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Completed,
    Cancelled,
    Error,
    Interrupted,
}

/// How confidently a receipt can attribute an observed file delta to the turn.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "snake_case")]
pub enum TurnChangeCertainty {
    Exact,
    Observed,
    Ambiguous,
    Unavailable,
}

/// Git-shaped status used by the immutable, bounded changed-file summary.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "snake_case")]
pub enum TurnFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Unmerged,
}

/// One path whose terminal workspace identity differed from the turn baseline.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "camelCase")]
pub struct TurnChangedFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: TurnFileStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u64>,
    pub binary: bool,
    pub certainty: TurnChangeCertainty,
}

/// Immutable terminal summary attached to the assistant bubble both live and
/// after a database reload. Changed files are deliberately bounded; counts and
/// totals describe the complete observed delta when capture succeeded.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "camelCase")]
pub struct TurnReceipt {
    pub turn_id: String,
    pub status: TurnStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    pub started_at: i64,
    pub completed_at: i64,
    /// Monotonic elapsed time for a normally terminalized turn. Omitted when a
    /// pending row is recovered after process restart because the crash instant is
    /// unknowable and fabricating a near-zero duration would be misleading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub changed_files: Vec<TurnChangedFile>,
    pub changed_file_count: u64,
    pub additions: u64,
    pub deletions: u64,
    pub files_truncated: bool,
    pub change_certainty: TurnChangeCertainty,
    pub background_tasks_running: bool,
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
        /// Stable root-turn identity. Optional only on decode so old Phone Sync
        /// peers that sent `messageId` alone remain readable.
        #[serde(rename = "turnId", default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(rename = "startedAt", default, skip_serializing_if = "Option::is_none")]
        started_at: Option<i64>,
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
        /// New native runs always emit a receipt. `Option` is retained solely so
        /// frames produced by older desktop versions still deserialize.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        receipt: Option<TurnReceipt>,
    },
    Error {
        message: String,
        /// Duplicate-run and early preflight failures may occur before a durable
        /// turn exists; legacy frames also omit this field.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        receipt: Option<TurnReceipt>,
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
    /// The per-session model id (per-session-model feature). Optional + serde-default
    /// so older rows / wire payloads without it still decode; the call site falls back
    /// to the global default model when it is None.
    #[serde(default)]
    pub model: Option<String>,
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
    /// NULL/omitted on legacy rows. New rows use this to rebuild the same single
    /// assistant bubble that live `TurnStart` created.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// Attached to the terminal row of a replicated turn. Desktop `UiMessage`
    /// carries the same receipt directly on the grouped assistant bubble.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<TurnReceipt>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_turn_events_decode_without_receipt_fields() {
        assert_eq!(
            serde_json::from_value::<StreamEvent>(json!({
                "type": "turn_start",
                "messageId": "legacy-message"
            }))
            .unwrap(),
            StreamEvent::TurnStart {
                message_id: "legacy-message".into(),
                turn_id: None,
                started_at: None,
            }
        );
        assert_eq!(
            serde_json::from_value::<StreamEvent>(json!({
                "type": "turn_end",
                "stopReason": "end_turn"
            }))
            .unwrap(),
            StreamEvent::TurnEnd {
                stop_reason: "end_turn".into(),
                receipt: None,
            }
        );
        assert_eq!(
            serde_json::from_value::<StreamEvent>(json!({
                "type": "error",
                "message": "old error"
            }))
            .unwrap(),
            StreamEvent::Error {
                message: "old error".into(),
                receipt: None,
            }
        );
    }

    #[test]
    fn legacy_message_row_decodes_nullable_turn_metadata() {
        let row: MessageRow = serde_json::from_value(json!({
            "id": "m1",
            "sessionId": "s1",
            "seq": 0,
            "role": "user",
            "content": [],
            "createdAt": 1
        }))
        .unwrap();
        assert!(row.turn_id.is_none());
        assert!(row.receipt.is_none());
    }

    #[test]
    fn new_turn_start_uses_one_authoritative_display_id() {
        let event = StreamEvent::TurnStart {
            message_id: "turn-1".into(),
            turn_id: Some("turn-1".into()),
            started_at: Some(42),
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "type": "turn_start",
                "messageId": "turn-1",
                "turnId": "turn-1",
                "startedAt": 42
            })
        );
    }
}
