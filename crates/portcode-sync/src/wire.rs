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

/// Bounded, reload-safe diagnostics for a failed root turn. This deliberately
/// contains only operational metadata: never prompts, tool inputs/results,
/// credentials, provider response bodies, or absolute paths.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "camelCase")]
pub struct TurnFailure {
    /// Stable local classification such as `provider_http` or `provider_timeout`.
    pub code: String,
    /// User-safe, secret-scrubbed summary, bounded by the desktop before storage.
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    /// Number and serialized byte size of persisted transcript messages supplied
    /// to the failing root run. These are diagnostics, not token estimates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_messages: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_bytes: Option<u64>,
}

/// Non-terminal lifecycle milestones emitted to the local desktop UI. Phone
/// Sync deliberately does not forward this additive event until a peer has
/// negotiated support, because legacy Rust peers reject unknown enum variants.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "snake_case")]
pub enum TurnPhase {
    ProviderStarted,
    AgentCompleted,
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

/// Whether Git attribution applies and whether a net delta is known. This is
/// orthogonal to [`TurnChangeCertainty`], which only qualifies attribution.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "snake_case")]
pub enum TurnChangeState {
    NotApplicable,
    None,
    Changed,
    Unknown,
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
    /// Opaque local ChatGPT account profile used for this turn. This is never a
    /// remote account identifier and is optional so receipts written by older
    /// Portcode versions remain readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_profile_id: Option<String>,
    pub status: TurnStatus,
    /// Present only for failed turns. Optional for additive compatibility with
    /// receipts written by older desktop and phone builds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<TurnFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    pub started_at: i64,
    pub completed_at: i64,
    /// Monotonic elapsed time for a normally terminalized turn. Omitted when a
    /// pending row is recovered after process restart because the crash instant is
    /// unknowable and fabricating a near-zero duration would be misleading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Agent work duration frozen before optional Git finalization. New clients
    /// prefer this over legacy `duration_ms`; old receipts simply omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_duration_ms: Option<u64>,
    pub changed_files: Vec<TurnChangedFile>,
    pub changed_file_count: u64,
    pub additions: u64,
    pub deletions: u64,
    pub files_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_state: Option<TurnChangeState>,
    pub change_certainty: TurnChangeCertainty,
    pub background_tasks_running: bool,
}

/// Security classification attached to a permission request.
///
/// Missing values are legacy `Configurable` requests. Unknown future values
/// decode as `Unknown`, which callers must handle fail-safe (one-shot approval,
/// never a remembered allow).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "camelCase")]
pub enum PermissionRisk {
    #[default]
    Configurable,
    Shell,
    DependencyInstall,
    HighRiskGit,
    #[serde(other)]
    Unknown,
}

impl PermissionRisk {
    pub fn is_configurable(&self) -> bool {
        *self == Self::Configurable
    }
}

/// Events streamed to the frontend. Tagged + camelCased to match `StreamEvent`
/// in `src/types.ts`. This is the rich internal desktop event; Phone Sync frames
/// embed the separate projected [`PhoneStreamEvent`] type below.
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
    /// Desktop-local lifecycle milestone. The production event sink emits this
    /// without mirroring it to legacy Phone Sync peers; TurnEnd/Error remains the
    /// authoritative, backwards-compatible receipt-ready event.
    TurnPhase {
        #[serde(rename = "turnId")]
        turn_id: String,
        phase: TurnPhase,
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        revision: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<TurnStatus>,
        #[serde(
            rename = "stopReason",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        stop_reason: Option<String>,
        #[serde(
            rename = "agentDurationMs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        agent_duration_ms: Option<u64>,
        #[serde(
            rename = "receiptExpected",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        receipt_expected: Option<bool>,
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
        /// Additive classification. Missing values from older persisted/wire
        /// events retain the historical configurable behavior.
        #[serde(default, skip_serializing_if = "PermissionRisk::is_configurable")]
        risk: PermissionRisk,
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
    /// Lossless desktop-local Codex app-server activity. Existing normalized
    /// variants above keep the chat UX and Phone Sync compatible; this envelope
    /// preserves every current and future notification/request for the full
    /// activity inspector without pretending an unknown method is a known tool.
    CodexEvent {
        sequence: i64,
        method: String,
        params: Value,
        #[serde(rename = "requestId", default, skip_serializing_if = "Option::is_none")]
        request_id: Option<Value>,
        #[serde(rename = "threadId", default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(rename = "turnId", default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(rename = "itemId", default, skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        #[serde(rename = "emittedAtMs")]
        emitted_at_ms: i64,
    },
    /// A structured app-server request that requires richer user input than the
    /// legacy allow/deny permission gate (for example request_user_input or an
    /// MCP elicitation form). `params` remains lossless and method-specific.
    CodexRequest {
        id: String,
        method: String,
        params: Value,
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
    /// Opaque local ChatGPT account profile pinned to this session. Legacy and
    /// non-OpenAI sessions remain unpinned, and older peers can omit the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_profile_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One persisted message, with its raw append-only `seq` — the flat row Phone
/// Sync persistence reads internally. Phone catch-up projects this into the
/// separate [`PhoneMessageRow`] type below.
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

// ---------------------------------------------------------------------------
// Public Phone Sync DTOs
// ---------------------------------------------------------------------------
//
// These deliberately duplicate the legacy JSON shapes instead of wrapping the
// internal DTOs above. The desktop projector is the only intended conversion
// path. Consequently, adding a rich internal field or event cannot make it onto
// the encrypted phone channel through a derived conversion or a raw clone.

/// Public content block replicated to Phone Sync peers. Raw tool payloads are
/// represented by the same legacy fields, but the projector fills `input` with
/// `{}` and uses a static result summary.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PhoneBlock {
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

/// Public changed-file item. Paths are labels projected and bounded by the
/// desktop; this type cannot carry a receipt's local account attribution.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "camelCase")]
pub struct PhoneTurnChangedFile {
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

/// Public terminal turn summary. This preserves the legacy receipt field names
/// while intentionally omitting `accountProfileId`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "camelCase")]
pub struct PhoneTurnReceipt {
    pub turn_id: String,
    pub status: TurnStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    pub started_at: i64,
    pub completed_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub changed_files: Vec<PhoneTurnChangedFile>,
    pub changed_file_count: u64,
    pub additions: u64,
    pub deletions: u64,
    pub files_truncated: bool,
    pub change_certainty: TurnChangeCertainty,
    pub background_tasks_running: bool,
}

/// Public session header. The projector replaces an absolute workspace with a
/// safe label and this schema has no account-profile field at all.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "camelCase")]
pub struct PhoneSessionRow {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub branch: Option<String>,
    pub workspace: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Public persisted message row. Its content and receipt are public DTOs, so a
/// raw reasoning block, tool payload, or account profile cannot be embedded.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(rename_all = "camelCase")]
pub struct PhoneMessageRow {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    pub role: String,
    pub content: Vec<PhoneBlock>,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<PhoneTurnReceipt>,
}

/// Public live event delivered to Phone Sync peers. Required fields and JSON
/// tags match the legacy `StreamEvent` shape; `Unknown` keeps future public
/// event tags from terminating an older receive loop.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PhoneStreamEvent {
    TurnStart {
        #[serde(rename = "messageId")]
        message_id: String,
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
        #[serde(default, skip_serializing_if = "PermissionRisk::is_configurable")]
        risk: PermissionRisk,
        summary: String,
        input: Value,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        receipt: Option<PhoneTurnReceipt>,
    },
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        receipt: Option<PhoneTurnReceipt>,
    },
    AgentStarted {
        #[serde(rename = "agentId")]
        agent_id: String,
        description: String,
        #[serde(rename = "parentId", default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
    },
    AgentProgress {
        #[serde(rename = "agentId")]
        agent_id: String,
        step: u32,
    },
    AgentFinished {
        #[serde(rename = "agentId")]
        agent_id: String,
        status: String,
    },
    BackgroundTaskStarted {
        id: String,
        command: String,
    },
    BackgroundTaskFinished {
        id: String,
        command: String,
        #[serde(rename = "exitCode")]
        exit_code: i32,
        output: String,
    },
    #[serde(other)]
    Unknown,
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
    fn legacy_session_and_receipt_decode_without_account_attribution() {
        let session: SessionRow = serde_json::from_value(json!({
            "id": "s1",
            "title": "Legacy",
            "branch": null,
            "workspace": null,
            "model": "gpt-5.6-sol",
            "createdAt": 1,
            "updatedAt": 2
        }))
        .unwrap();
        assert_eq!(session.account_profile_id, None);

        let receipt: TurnReceipt = serde_json::from_value(json!({
            "turnId": "turn-1",
            "status": "completed",
            "stopReason": "end_turn",
            "startedAt": 1,
            "completedAt": 2,
            "durationMs": 1,
            "changedFiles": [],
            "changedFileCount": 0,
            "additions": 0,
            "deletions": 0,
            "filesTruncated": false,
            "changeCertainty": "exact",
            "backgroundTasksRunning": false
        }))
        .unwrap();
        assert_eq!(receipt.account_profile_id, None);
        assert_eq!(receipt.agent_duration_ms, None);
        assert_eq!(receipt.change_state, None);
        assert!(serde_json::to_value(&receipt)
            .unwrap()
            .get("accountProfileId")
            .is_none());
    }

    #[test]
    fn account_attribution_serializes_as_an_opaque_camel_case_field() {
        let session = SessionRow {
            id: "s1".into(),
            title: "Pinned".into(),
            branch: None,
            workspace: None,
            model: Some("gpt-5.6-sol".into()),
            account_profile_id: Some("profile-a".into()),
            created_at: 1,
            updated_at: 2,
        };
        let encoded = serde_json::to_value(session).unwrap();
        assert_eq!(encoded["accountProfileId"], "profile-a");

        let mut receipt: TurnReceipt = serde_json::from_value(json!({
            "turnId": "turn-1",
            "status": "completed",
            "startedAt": 1,
            "completedAt": 2,
            "changedFiles": [],
            "changedFileCount": 0,
            "additions": 0,
            "deletions": 0,
            "filesTruncated": false,
            "changeCertainty": "exact",
            "backgroundTasksRunning": false
        }))
        .unwrap();
        receipt.account_profile_id = Some("profile-a".into());
        let encoded = serde_json::to_value(receipt).unwrap();
        assert_eq!(encoded["accountProfileId"], "profile-a");
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

    #[test]
    fn codex_event_preserves_unknown_payloads_and_server_request_identity() {
        let event = StreamEvent::CodexEvent {
            sequence: 7,
            method: "item/futureThing/delta".into(),
            params: json!({ "future": { "nested": true } }),
            request_id: Some(json!(99)),
            thread_id: Some("thread-1".into()),
            turn_id: Some("turn-1".into()),
            item_id: Some("item-1".into()),
            emitted_at_ms: 42,
        };
        let encoded = serde_json::to_value(&event).unwrap();
        assert_eq!(encoded["type"], "codex_event");
        assert_eq!(encoded["requestId"], 99);
        assert_eq!(encoded["params"]["future"]["nested"], true);
        assert_eq!(
            serde_json::from_value::<StreamEvent>(encoded).unwrap(),
            event
        );
    }

    #[test]
    fn permission_risk_is_additive_and_unknown_values_fail_safe() {
        let legacy: StreamEvent = serde_json::from_value(json!({
            "type": "permission_request",
            "id": "p1",
            "tool": "write_file",
            "summary": "Write file",
            "input": {}
        }))
        .unwrap();
        assert!(matches!(
            legacy,
            StreamEvent::PermissionRequest {
                risk: PermissionRisk::Configurable,
                ..
            }
        ));

        let future: PhoneStreamEvent = serde_json::from_value(json!({
            "type": "permission_request",
            "id": "p2",
            "tool": "run_command",
            "risk": "futureProtectedRisk",
            "summary": "Run command",
            "input": {}
        }))
        .unwrap();
        assert!(matches!(
            future,
            PhoneStreamEvent::PermissionRequest {
                risk: PermissionRisk::Unknown,
                ..
            }
        ));

        let configurable = PhoneStreamEvent::PermissionRequest {
            id: "p3".into(),
            tool: "write_file".into(),
            risk: PermissionRisk::Configurable,
            summary: "Write file".into(),
            input: json!({}),
            diff: None,
        };
        assert!(serde_json::to_value(configurable)
            .unwrap()
            .get("risk")
            .is_none());
    }

    #[test]
    fn unknown_public_events_decode_to_the_compatibility_sink() {
        let event: PhoneStreamEvent = serde_json::from_value(json!({
            "type": "future_public_event",
            "newField": "ignored"
        }))
        .unwrap();
        assert_eq!(event, PhoneStreamEvent::Unknown);
    }

    #[test]
    fn public_rows_preserve_legacy_fields_without_account_attribution() {
        let row: PhoneSessionRow = serde_json::from_value(json!({
            "id": "s1",
            "title": "Legacy",
            "branch": null,
            "workspace": "project",
            "model": null,
            "accountProfileId": "must-not-survive",
            "createdAt": 1,
            "updatedAt": 2
        }))
        .unwrap();
        let encoded = serde_json::to_value(row).unwrap();
        assert_eq!(encoded["id"], "s1");
        assert!(encoded.get("accountProfileId").is_none());

        // A deployed legacy decoder can still read the required public event
        // fields because the JSON tag/field names did not change.
        let public = PhoneStreamEvent::ToolResult {
            id: "tool-public".into(),
            output: "Tool completed.".into(),
            is_error: false,
        };
        let legacy: StreamEvent = serde_json::from_value(serde_json::to_value(public).unwrap())
            .expect("legacy StreamEvent shape remains decodable");
        assert!(matches!(legacy, StreamEvent::ToolResult { .. }));
    }

    #[test]
    fn local_turn_phase_uses_additive_camel_case_fields() {
        let event = StreamEvent::TurnPhase {
            turn_id: "turn-1".into(),
            phase: TurnPhase::AgentCompleted,
            at: 99,
            revision: Some(2),
            status: Some(TurnStatus::Completed),
            stop_reason: Some("end_turn".into()),
            agent_duration_ms: Some(42),
            receipt_expected: Some(true),
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "type": "turn_phase",
                "turnId": "turn-1",
                "phase": "agent_completed",
                "at": 99,
                "revision": 2,
                "status": "completed",
                "stopReason": "end_turn",
                "agentDurationMs": 42,
                "receiptExpected": true
            })
        );
    }
}
