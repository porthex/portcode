//! Public Phone Sync projection boundary.
//!
//! Desktop events and database rows are intentionally richer than the values a
//! paired phone needs. Every outbound live/history value is rebuilt here into a
//! separate public DTO. Projection is fail-closed: raw values are never used as
//! a fallback.

use std::collections::HashMap;

use portcode_sync::protocol::SyncFrame;
use portcode_sync::wire::{
    Block, MessageRow, PhoneBlock, PhoneCodexActivityPayload, PhoneCodexPlanStep, PhoneMessageRow,
    PhoneSessionRow, PhoneStreamEvent, PhoneTurnChangedFile, PhoneTurnReceipt, SessionRow,
    StreamEvent, TurnReceipt,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Noise accepts at most 65,519 plaintext bytes. Public live frames stay far
/// below that hard limit to leave room for protocol evolution.
pub const PHONE_LIVE_FRAME_BUDGET: usize = 16 * 1_024;
/// Catch-up/page frames are larger but still retain more than 16 KiB of margin
/// below Noise's plaintext ceiling.
pub const PHONE_FRAME_BUDGET: usize = 48 * 1_024;
pub const MAX_REMOTE_IDENTIFIER_BYTES: usize = 128;
pub const MAX_REMOTE_RUN_TEXT_BYTES: usize = 32 * 1_024;

const MAX_LIVE_TEXT_BYTES: usize = 8 * 1_024;
const MAX_MESSAGE_TEXT_BYTES: usize = 4 * 1_024;
const MAX_MESSAGE_CONTENT_BYTES: usize = 20 * 1_024;
const MAX_MESSAGE_BLOCKS: usize = 64;
const MAX_MESSAGE_SOURCE_BLOCKS: usize = 256;
const MAX_CHANGED_FILES: usize = 24;
const MAX_PENDING_SESSIONS: usize = 32;
const TEXT_EMIT_TARGET_BYTES: usize = 2 * 1_024;
const TEXT_RAW_HOLDBACK_BYTES: usize = 1_024;
const TEXT_APPEND_CHUNK_BYTES: usize = 4 * 1_024;
const MAX_LIVE_FRAMES_PER_EVENT: usize = 32;
const MAX_PENDING_TEXT_BYTES: usize = 64 * 1_024;
const OMITTED_TEXT: &str = "[content omitted]";

/// Validate an identifier supplied by a paired peer before lookup or reflection.
/// Colons and controls are rejected so a peer cannot forge a subagent channel.
pub fn valid_remote_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REMOTE_IDENTIFIER_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// Redact the complete input first, then normalize controls and enforce an exact
/// UTF-8 byte limit. Secret matching therefore cannot be bypassed at a truncation
/// boundary and a multibyte scalar is never split.
pub fn bounded_public_text(value: &str, max_bytes: usize) -> String {
    let redacted = crate::scrub::redact_secrets_bounded(value, max_bytes);
    let mut output = String::with_capacity(redacted.len().min(max_bytes));
    let mut characters = redacted.chars().peekable();
    while let Some(character) = characters.next() {
        let character = match character {
            '\r' => {
                if characters.peek() == Some(&'\n') {
                    characters.next();
                }
                '\n'
            }
            '\n' | '\t' => character,
            character if character.is_control() => ' ',
            character => character,
        };
        if output.len() + character.len_utf8() > max_bytes {
            break;
        }
        output.push(character);
    }
    output
}

fn public_identifier(value: &str) -> String {
    if valid_remote_identifier(value)
        && crate::scrub::redact_secrets_bounded(value, MAX_REMOTE_IDENTIFIER_BYTES) == value
    {
        return value.to_string();
    }

    // Provider-generated tool ids are opaque and may themselves contain data.
    // A short deterministic digest preserves ToolUse/ToolResult correlation
    // without exposing the original value.
    let digest = Sha256::digest(value.as_bytes());
    let mut encoded = String::with_capacity(35);
    encoded.push_str("id-");
    for byte in &digest[..16] {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded
}

fn public_codex_method(value: &str) -> String {
    let bounded = bounded_public_text(value, 128);
    if bounded == value
        && !bounded.is_empty()
        && bounded.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '/' | '.' | '_' | '-')
        })
    {
        bounded
    } else {
        let digest = Sha256::digest(value.as_bytes());
        let mut encoded = String::with_capacity(39);
        encoded.push_str("redacted-method-");
        for byte in &digest[..12] {
            encoded.push_str(&format!("{byte:02x}"));
        }
        encoded
    }
}

fn public_codex_request_id(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(public_identifier(value)),
        Value::Number(value) => Some(public_identifier(&value.to_string())),
        _ => None,
    }
}

#[derive(Default)]
struct PublicCodexActivityMetadata {
    redacted: bool,
    truncated: bool,
    redaction_reasons: Vec<String>,
    truncation_reasons: Vec<String>,
    original_bytes: Option<u64>,
    retained_bytes: Option<u64>,
}

fn public_activity_reasons(metadata: Option<&Value>, key: &str) -> Vec<String> {
    metadata
        .and_then(|value| value.get(key))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|reason| {
            matches!(
                *reason,
                "rawReasoning"
                    | "knownSecret"
                    | "nonScalarRequestId"
                    | "maxDepth"
                    | "maxFields"
                    | "maxArrayItems"
                    | "maxStringBytes"
                    | "maxEncodedBytes"
                    | "maxMethodBytes"
            )
        })
        .map(str::to_owned)
        .collect()
}

fn codex_activity_metadata(params: &Value) -> PublicCodexActivityMetadata {
    let metadata = params.get("_portcodeActivity");
    PublicCodexActivityMetadata {
        redacted: metadata
            .and_then(|value| value.get("redacted"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        truncated: metadata
            .and_then(|value| value.get("truncated"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        redaction_reasons: public_activity_reasons(metadata, "redactionReasons"),
        truncation_reasons: public_activity_reasons(metadata, "truncationReasons"),
        original_bytes: metadata
            .and_then(|value| value.get("originalBytes"))
            .and_then(Value::as_u64),
        retained_bytes: metadata
            .and_then(|value| value.get("retainedBytes"))
            .and_then(Value::as_u64),
    }
}
fn public_codex_status(value: Option<&str>) -> String {
    match value {
        Some("pending") => "pending",
        Some("inProgress") => "inProgress",
        Some("completed") => "completed",
        Some("failed" | "errored" | "notFound") => "failed",
        Some("interrupted" | "cancelled" | "canceled" | "declined") => "interrupted",
        _ => "unknown",
    }
    .to_string()
}

fn public_codex_activity_payload(
    method: &str,
    params: &Value,
) -> Option<PhoneCodexActivityPayload> {
    match method {
        "turn/plan/updated" => {
            let steps = params
                .get("plan")
                .and_then(Value::as_array)?
                .iter()
                .take(64)
                .map(|step| PhoneCodexPlanStep {
                    status: public_codex_status(step.get("status").and_then(Value::as_str)),
                })
                .collect();
            Some(PhoneCodexActivityPayload::Plan { steps })
        }
        "turn/diff/updated" => {
            let diff = params.get("diff").and_then(Value::as_str)?;
            let mut additions = 0_u32;
            let mut deletions = 0_u32;
            let mut files = 0_u32;
            for line in diff.lines().take(100_000) {
                if line.starts_with("diff --git ") {
                    files = files.saturating_add(1);
                } else if line.starts_with('+') && !line.starts_with("+++") {
                    additions = additions.saturating_add(1);
                } else if line.starts_with('-') && !line.starts_with("---") {
                    deletions = deletions.saturating_add(1);
                }
            }
            Some(PhoneCodexActivityPayload::Diff {
                additions,
                deletions,
                files,
            })
        }
        "item/started" | "item/completed" => {
            let item = params.get("item")?;
            let item_type = match item.get("type").and_then(Value::as_str) {
                Some(
                    value @ ("commandExecution"
                    | "fileChange"
                    | "mcpToolCall"
                    | "contextCompaction"
                    | "plan"
                    | "collabAgentToolCall"
                    | "subAgentActivity"),
                ) => value.to_string(),
                _ => "unknown".to_string(),
            };
            let status = public_codex_status(item.get("status").and_then(Value::as_str));
            let terminal = method == "item/completed"
                || matches!(status.as_str(), "completed" | "failed" | "interrupted");
            Some(PhoneCodexActivityPayload::Tool {
                item_type,
                status,
                terminal,
            })
        }
        "turn/completed" => Some(PhoneCodexActivityPayload::Terminal {
            status: public_codex_status(
                params
                    .get("turn")
                    .and_then(|turn| turn.get("status"))
                    .and_then(Value::as_str),
            ),
        }),
        _ => None,
    }
}

fn public_tool_id(value: &str) -> String {
    // Hash even syntactically-safe provider ids: they are not an application
    // identifier and have no public meaning beyond correlation.
    let digest = Sha256::digest(value.as_bytes());
    let mut encoded = String::with_capacity(37);
    encoded.push_str("tool-");
    for byte in &digest[..16] {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded
}

fn public_tool_name(value: &str) -> &'static str {
    match crate::tool_names::canonical(value) {
        crate::tool_names::READ_FILE => crate::tool_names::READ_FILE,
        crate::tool_names::LIST_DIRECTORY => crate::tool_names::LIST_DIRECTORY,
        crate::tool_names::FIND_FILES => crate::tool_names::FIND_FILES,
        crate::tool_names::SEARCH_TEXT => crate::tool_names::SEARCH_TEXT,
        crate::tool_names::WRITE_FILE => crate::tool_names::WRITE_FILE,
        crate::tool_names::EDIT_FILE => crate::tool_names::EDIT_FILE,
        crate::tool_names::RUN_COMMAND => crate::tool_names::RUN_COMMAND,
        crate::tool_names::DELEGATE_TASK => crate::tool_names::DELEGATE_TASK,
        _ => "unknown_tool",
    }
}

fn empty_input() -> Value {
    Value::Object(Default::default())
}

fn safe_label(value: &str, fallback: &str, max_bytes: usize) -> String {
    let leaf = value
        .split(['/', '\\'])
        .rev()
        .find(|component| !component.is_empty())
        .unwrap_or(fallback);
    let leaf = if matches!(leaf, "." | "..") || leaf.contains(':') {
        fallback
    } else {
        leaf
    };
    let label = bounded_public_text(leaf, max_bytes);
    if label.trim().is_empty() {
        fallback.to_string()
    } else {
        label
    }
}

fn public_stop_reason(value: &str) -> String {
    match value {
        "end_turn" | "tool_use" | "max_tokens" | "cancelled" | "error" | "interrupted" => {
            value.to_string()
        }
        _ => "unknown".to_string(),
    }
}

fn public_agent_status(value: &str) -> String {
    match value {
        "ok" | "cancelled" | "error" => value.to_string(),
        _ => "unknown".to_string(),
    }
}

fn public_agent_provider_status(value: &str) -> String {
    match value {
        "pendingInit" | "running" | "interrupted" | "completed" | "errored" | "shutdown"
        | "notFound" | "failed" => value.to_string(),
        _ => "unknown".to_string(),
    }
}

fn static_tool_result(is_error: bool) -> String {
    if is_error {
        "Tool failed.".to_string()
    } else {
        "Tool completed.".to_string()
    }
}

/// Project a receipt without local account attribution or absolute paths.
pub fn project_receipt(receipt: &TurnReceipt) -> PhoneTurnReceipt {
    let changed_files = receipt
        .changed_files
        .iter()
        .take(MAX_CHANGED_FILES)
        .map(|file| PhoneTurnChangedFile {
            path: safe_label(&file.path, "file", 192),
            old_path: file
                .old_path
                .as_deref()
                .map(|path| safe_label(path, "file", 192)),
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            binary: file.binary,
            certainty: file.certainty,
        })
        .collect();

    PhoneTurnReceipt {
        turn_id: public_identifier(&receipt.turn_id),
        status: receipt.status,
        stop_reason: receipt.stop_reason.as_deref().map(public_stop_reason),
        started_at: receipt.started_at,
        completed_at: receipt.completed_at,
        duration_ms: receipt.duration_ms,
        changed_files,
        changed_file_count: receipt.changed_file_count,
        additions: receipt.additions,
        deletions: receipt.deletions,
        files_truncated: receipt.files_truncated || receipt.changed_files.len() > MAX_CHANGED_FILES,
        change_certainty: receipt.change_certainty,
        background_tasks_running: receipt.background_tasks_running,
    }
}

/// Project one internal event. The match is deliberately exhaustive: adding an
/// internal event is a compile error until its public behavior is reviewed.
pub fn project_event(event: &StreamEvent) -> PhoneStreamEvent {
    match event {
        StreamEvent::TurnStart {
            message_id,
            turn_id,
            started_at,
        } => PhoneStreamEvent::TurnStart {
            message_id: public_identifier(message_id),
            turn_id: turn_id.as_deref().map(public_identifier),
            started_at: *started_at,
        },
        // TurnPhase is currently a desktop-local additive event. It must never
        // be projected as a legacy phone event until capability negotiation is
        // implemented; fail closed if this boundary is called directly.
        StreamEvent::TurnPhase { .. } => PhoneStreamEvent::Unknown,
        StreamEvent::TextDelta { text } => PhoneStreamEvent::TextDelta {
            text: bounded_public_text(text, MAX_LIVE_TEXT_BYTES),
        },
        StreamEvent::AssistantMessageSnapshot { turn_id, blocks } => {
            PhoneStreamEvent::AssistantMessageSnapshot {
                turn_id: public_identifier(turn_id),
                blocks: blocks
                    .iter()
                    .take(MAX_MESSAGE_BLOCKS)
                    .filter_map(|block| project_block(block, MAX_MESSAGE_TEXT_BYTES))
                    .collect(),
            }
        }
        StreamEvent::ToolUse { id, name, .. } => PhoneStreamEvent::ToolUse {
            id: public_tool_id(id),
            name: public_tool_name(name).to_string(),
            input: empty_input(),
        },
        StreamEvent::ToolResult { id, is_error, .. } => PhoneStreamEvent::ToolResult {
            id: public_tool_id(id),
            output: static_tool_result(*is_error),
            is_error: *is_error,
        },
        StreamEvent::PermissionRequest {
            id,
            tool,
            risk,
            summary,
            ..
        } => PhoneStreamEvent::PermissionRequest {
            id: public_identifier(id),
            tool: public_tool_name(tool).to_string(),
            risk: *risk,
            summary: bounded_public_text(summary, 512),
            input: empty_input(),
            diff: None,
        },
        StreamEvent::Usage {
            input_tokens,
            output_tokens,
        } => PhoneStreamEvent::Usage {
            input_tokens: *input_tokens,
            output_tokens: *output_tokens,
        },
        StreamEvent::TurnEnd {
            stop_reason,
            receipt,
        } => PhoneStreamEvent::TurnEnd {
            stop_reason: public_stop_reason(stop_reason),
            receipt: receipt.as_ref().map(project_receipt),
        },
        StreamEvent::Error { message, receipt } => PhoneStreamEvent::Error {
            message: bounded_public_text(message, 512),
            receipt: receipt.as_ref().map(project_receipt),
        },
        StreamEvent::AgentStarted {
            agent_id,
            description: _,
            parent_id,
            parent_thread_id,
            launch_turn_id,
            model,
            reasoning_effort,
            activity,
        } => PhoneStreamEvent::AgentStarted {
            agent_id: public_identifier(agent_id),
            // Native descriptions may originate from a child prompt or agentPath.
            // Keep the additive wire field for legacy decoders, but never copy
            // opaque desktop-local task content across the public boundary.
            description: "Codex subagent".to_string(),
            parent_id: parent_id.as_deref().map(public_identifier),
            parent_thread_id: parent_thread_id.as_deref().map(public_identifier),
            launch_turn_id: launch_turn_id.as_deref().map(public_identifier),
            model: model
                .as_deref()
                .map(|value| bounded_public_text(value, 128)),
            reasoning_effort: reasoning_effort
                .as_deref()
                .map(|value| bounded_public_text(value, 32)),
            activity: activity
                .as_deref()
                .map(|value| bounded_public_text(value, 64)),
        },
        StreamEvent::AgentProgress {
            agent_id,
            step,
            parent_thread_id,
            launch_turn_id,
            current_turn_id,
            turn_count,
        } => PhoneStreamEvent::AgentProgress {
            agent_id: public_identifier(agent_id),
            step: *step,
            parent_thread_id: parent_thread_id.as_deref().map(public_identifier),
            launch_turn_id: launch_turn_id.as_deref().map(public_identifier),
            current_turn_id: current_turn_id.as_deref().map(public_identifier),
            turn_count: *turn_count,
        },
        StreamEvent::AgentFinished {
            agent_id,
            status,
            provider_status,
            parent_thread_id,
            launch_turn_id,
            current_turn_id,
            turn_count,
            activity,
            ..
        } => PhoneStreamEvent::AgentFinished {
            agent_id: public_identifier(agent_id),
            status: public_agent_status(status),
            result: None,
            provider_status: provider_status.as_deref().map(public_agent_provider_status),
            parent_thread_id: parent_thread_id.as_deref().map(public_identifier),
            launch_turn_id: launch_turn_id.as_deref().map(public_identifier),
            current_turn_id: current_turn_id.as_deref().map(public_identifier),
            turn_count: *turn_count,
            activity: activity
                .as_deref()
                .map(|value| bounded_public_text(value, 64)),
        },
        StreamEvent::BackgroundTaskStarted { id, .. } => PhoneStreamEvent::BackgroundTaskStarted {
            id: public_identifier(id),
            command: "Background command".to_string(),
        },
        StreamEvent::BackgroundTaskFinished { id, exit_code, .. } => {
            PhoneStreamEvent::BackgroundTaskFinished {
                id: public_identifier(id),
                command: "Background command".to_string(),
                exit_code: *exit_code,
                output: if *exit_code == 0 {
                    "Command completed.".to_string()
                } else {
                    "Command failed.".to_string()
                },
            }
        }
        StreamEvent::CodexEvent {
            sequence,
            method,
            params,
            request_id,
            thread_id,
            turn_id,
            item_id,
            emitted_at_ms,
        } => {
            let metadata = codex_activity_metadata(params);
            PhoneStreamEvent::CodexActivity {
                kind: "event".to_string(),
                method: public_codex_method(method),
                request_id: request_id.as_ref().and_then(public_codex_request_id),
                thread_id: thread_id.as_deref().map(public_identifier),
                turn_id: turn_id.as_deref().map(public_identifier),
                item_id: item_id.as_deref().map(public_identifier),
                sequence: Some(*sequence),
                emitted_at_ms: Some(*emitted_at_ms),
                redacted: metadata.redacted,
                truncated: metadata.truncated,
                redaction_reasons: metadata.redaction_reasons,
                truncation_reasons: metadata.truncation_reasons,
                original_bytes: metadata.original_bytes,
                retained_bytes: metadata.retained_bytes,
                payload: public_codex_activity_payload(method, params),
            }
        }
        StreamEvent::CodexRequest { id, method, params } => {
            let metadata = codex_activity_metadata(params);
            PhoneStreamEvent::CodexActivity {
                kind: "request".to_string(),
                method: public_codex_method(method),
                request_id: Some(public_identifier(id)),
                thread_id: params
                    .get("threadId")
                    .and_then(Value::as_str)
                    .map(public_identifier),
                turn_id: params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(public_identifier),
                item_id: params
                    .get("itemId")
                    .and_then(Value::as_str)
                    .map(public_identifier),
                sequence: None,
                emitted_at_ms: None,
                redacted: metadata.redacted,
                truncated: metadata.truncated,
                redaction_reasons: metadata.redaction_reasons,
                truncation_reasons: metadata.truncation_reasons,
                original_bytes: metadata.original_bytes,
                retained_bytes: metadata.retained_bytes,
                payload: None,
            }
        }
    }
}

/// Project a session row. `workspace` becomes only its final path component and
/// account attribution is absent from the public type.
pub fn project_session(session: &SessionRow) -> PhoneSessionRow {
    PhoneSessionRow {
        id: public_identifier(&session.id),
        title: bounded_public_text(&session.title, 256),
        branch: session
            .branch
            .as_deref()
            .map(|branch| bounded_public_text(branch, 128)),
        workspace: session
            .workspace
            .as_deref()
            .map(|workspace| safe_label(workspace, "workspace", 128)),
        model: session
            .model
            .as_deref()
            .map(|model| bounded_public_text(model, 128)),
        created_at: session.created_at,
        updated_at: session.updated_at,
    }
}

fn project_block(block: &Block, remaining_text_bytes: usize) -> Option<PhoneBlock> {
    match block {
        Block::Text { text } => Some(PhoneBlock::Text {
            text: bounded_public_text(text, remaining_text_bytes.min(MAX_MESSAGE_TEXT_BYTES)),
        }),
        Block::ToolUse { id, name, .. } => Some(PhoneBlock::ToolUse {
            id: public_tool_id(id),
            name: public_tool_name(name).to_string(),
            input: empty_input(),
        }),
        Block::ToolResult {
            tool_use_id,
            is_error,
            ..
        } => Some(PhoneBlock::ToolResult {
            tool_use_id: public_tool_id(tool_use_id),
            content: static_tool_result(*is_error),
            is_error: *is_error,
        }),
        Block::Reasoning { .. } => None,
    }
}

/// Project one persisted message using the same tool/text policy as live events.
pub fn project_message(message: &MessageRow) -> PhoneMessageRow {
    let mut content = Vec::new();
    let mut text_bytes = 0usize;
    let mut omitted = false;
    for (source_index, block) in message.content.iter().enumerate() {
        if source_index >= MAX_MESSAGE_SOURCE_BLOCKS {
            omitted = true;
            break;
        }
        if content.len() >= MAX_MESSAGE_BLOCKS || text_bytes >= MAX_MESSAGE_CONTENT_BYTES {
            omitted = true;
            break;
        }
        let remaining = MAX_MESSAGE_CONTENT_BYTES - text_bytes;
        if let Some(projected) = project_block(block, remaining) {
            if let PhoneBlock::Text { text } = &projected {
                text_bytes += text.len();
            }
            content.push(projected);
        }
    }
    if omitted && content.len() < MAX_MESSAGE_BLOCKS {
        content.push(PhoneBlock::Text {
            text: OMITTED_TEXT.to_string(),
        });
    }

    PhoneMessageRow {
        id: public_identifier(&message.id),
        session_id: public_identifier(&message.session_id),
        seq: message.seq,
        role: match message.role.as_str() {
            "user" | "assistant" => message.role.clone(),
            _ => "unknown".to_string(),
        },
        content,
        created_at: message.created_at,
        turn_id: message.turn_id.as_deref().map(public_identifier),
        receipt: message.receipt.as_ref().map(project_receipt),
    }
}

fn frame_len(frame: &SyncFrame) -> Option<usize> {
    serde_json::to_vec(frame).ok().map(|bytes| bytes.len())
}

pub fn frame_fits(frame: &SyncFrame, budget: usize) -> bool {
    frame_len(frame).is_some_and(|length| length <= budget)
}

/// Build a bounded projected session-list frame. Rows retain DB order.
pub fn session_list_frame(sessions: Vec<SessionRow>) -> SyncFrame {
    let mut public = Vec::new();
    for session in sessions {
        public.push(project_session(&session));
        let candidate = SyncFrame::SessionList {
            sessions: public.clone(),
        };
        if !frame_fits(&candidate, PHONE_FRAME_BUDGET) {
            public.pop();
            break;
        }
    }
    SyncFrame::SessionList { sessions: public }
}

pub fn session_created_frame(request_id: String, session: &SessionRow) -> SyncFrame {
    let frame = SyncFrame::SessionCreated {
        request_id: public_identifier(&request_id),
        session: project_session(session),
    };
    debug_assert!(frame_fits(&frame, PHONE_FRAME_BUDGET));
    frame
}

/// Build a bounded append-only delta. A prefix is retained so a reconnect can
/// advance its cursor without creating a hole; remaining rows arrive next time.
pub fn message_delta_frame(session_id: &str, messages: Vec<MessageRow>) -> SyncFrame {
    let session_id = public_identifier(session_id);
    let mut public = Vec::new();
    for message in messages {
        public.push(project_message(&message));
        let candidate = SyncFrame::MessageDelta {
            session_id: session_id.clone(),
            messages: public.clone(),
        };
        if !frame_fits(&candidate, PHONE_FRAME_BUDGET) {
            public.pop();
            break;
        }
    }
    SyncFrame::MessageDelta {
        session_id,
        messages: public,
    }
}

/// Build a bounded older-history page. The suffix nearest the requested cursor
/// is retained, preserving gap-free scroll-up pagination; dropping any row forces
/// `has_more` so the phone can request the remainder.
pub fn message_page_frame(
    session_id: &str,
    messages: Vec<MessageRow>,
    has_more: bool,
) -> SyncFrame {
    let session_id = public_identifier(session_id);
    let mut public = Vec::new();
    let mut dropped = false;
    for message in messages.into_iter().rev() {
        public.insert(0, project_message(&message));
        let candidate = SyncFrame::MessagePage {
            session_id: session_id.clone(),
            messages: public.clone(),
            has_more: has_more || dropped,
        };
        if !frame_fits(&candidate, PHONE_FRAME_BUDGET) {
            public.remove(0);
            dropped = true;
            break;
        }
    }
    SyncFrame::MessagePage {
        session_id,
        messages: public,
        has_more: has_more || dropped,
    }
}

#[derive(Default)]
struct PendingText {
    raw: String,
    suppressed: bool,
}

/// Stateful live projector. Adjacent deltas for each session are held together
/// before redaction so a credential divided between transport chunks cannot
/// evade a regex that needs the complete token.
#[derive(Default)]
pub struct PhoneEventProjector {
    pending: HashMap<String, PendingText>,
}

impl PhoneEventProjector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drop every held delta tail. Called when the last subscriber has gone so a
    /// future phone cannot receive text buffered for an earlier connection.
    pub fn clear(&mut self) {
        self.pending.clear();
    }

    fn flush_pending(&mut self, session_id: &str) -> Option<PhoneStreamEvent> {
        let pending = self.pending.remove(session_id)?;
        let text = if pending.suppressed {
            OMITTED_TEXT.to_string()
        } else {
            bounded_public_text(&pending.raw, MAX_LIVE_TEXT_BYTES)
        };
        if text.is_empty() {
            None
        } else {
            Some(PhoneStreamEvent::TextDelta { text })
        }
    }

    fn sensitive_prefix_before_space(prefix: &str) -> bool {
        let tail = prefix.trim_end().to_ascii_lowercase();
        if tail.ends_with("bearer") {
            return true;
        }
        for name in [
            "authorization",
            "x-api-key",
            "api-key",
            "api_key",
            "apikey",
            "chatgpt-account-id",
        ] {
            let Some(position) = tail.rfind(name) else {
                continue;
            };
            let suffix = tail[position + name.len()..].trim_matches(|character: char| {
                character.is_ascii_whitespace() || matches!(character, ':' | '=' | '\'' | '"')
            });
            if suffix.is_empty() {
                return true;
            }
        }
        false
    }

    /// Find a boundary that cannot divide an ASCII credential token. We prefer a
    /// whitespace terminator and keep at least 1 KiB of raw tail. Whitespace right
    /// after `Bearer` or a credential header is not safe, because its value begins
    /// on the other side. Non-ASCII scalars are also safe token terminators for all
    /// credential grammars handled by the scrubber.
    fn stream_boundary(raw: &str) -> Option<usize> {
        if raw.len() <= TEXT_EMIT_TARGET_BYTES + TEXT_RAW_HOLDBACK_BYTES {
            return None;
        }
        let mut max_end = TEXT_EMIT_TARGET_BYTES.min(raw.len() - TEXT_RAW_HOLDBACK_BYTES);
        while !raw.is_char_boundary(max_end) {
            max_end -= 1;
        }

        let mut boundary = None;
        for (index, character) in raw.char_indices() {
            let end = index + character.len_utf8();
            if end > max_end {
                break;
            }
            if !character.is_ascii()
                || (character.is_whitespace()
                    && !(character == '\r' && raw.as_bytes().get(end) == Some(&b'\n'))
                    && !Self::sensitive_prefix_before_space(&raw[..index]))
            {
                boundary = Some(end);
            }
        }
        boundary
    }

    fn drain_ready_text(pending: &mut PendingText) -> Vec<PhoneStreamEvent> {
        let mut events = Vec::new();
        while let Some(boundary) = Self::stream_boundary(&pending.raw) {
            let remainder = pending.raw.split_off(boundary);
            let chunk = std::mem::replace(&mut pending.raw, remainder);
            let text = bounded_public_text(&chunk, MAX_LIVE_TEXT_BYTES);
            if !text.is_empty() {
                events.push(PhoneStreamEvent::TextDelta { text });
            }
        }
        events
    }

    fn suppress_pending(pending: &mut PendingText) {
        pending.raw.clear();
        pending.suppressed = true;
    }

    /// Incrementally append one raw delta without ever cloning the whole value
    /// into the holdback. Both the retained raw tail and the number of immediate
    /// public frames are bounded, including for a hostile single huge delta.
    fn append_text(pending: &mut PendingText, mut text: &str) -> Vec<PhoneStreamEvent> {
        let mut events = Vec::new();
        while !text.is_empty() && !pending.suppressed {
            if events.len() >= MAX_LIVE_FRAMES_PER_EVENT {
                Self::suppress_pending(pending);
                break;
            }

            let room = MAX_PENDING_TEXT_BYTES.saturating_sub(pending.raw.len());
            if room == 0 {
                Self::suppress_pending(pending);
                break;
            }
            let mut take = text.len().min(room).min(TEXT_APPEND_CHUNK_BYTES);
            while take > 0 && !text.is_char_boundary(take) {
                take -= 1;
            }
            if take == 0 {
                Self::suppress_pending(pending);
                break;
            }

            pending.raw.push_str(&text[..take]);
            text = &text[take..];
            for event in Self::drain_ready_text(pending) {
                if events.len() == MAX_LIVE_FRAMES_PER_EVENT {
                    Self::suppress_pending(pending);
                    break;
                }
                events.push(event);
            }
            if pending.raw.len() >= MAX_PENDING_TEXT_BYTES {
                Self::suppress_pending(pending);
            }
        }
        events
    }

    fn frame(session_id: &str, event: PhoneStreamEvent) -> Option<SyncFrame> {
        let frame = SyncFrame::Live {
            session_id: session_id.to_string(),
            event,
        };
        frame_fits(&frame, PHONE_LIVE_FRAME_BUDGET).then_some(frame)
    }

    /// Consume one internal event and return zero or more public frames. Text may
    /// yield zero until the next non-text event closes the adjacent delta run.
    pub fn project_frames(&mut self, session_id: &str, event: &StreamEvent) -> Vec<SyncFrame> {
        let session_id = public_identifier(session_id);
        if let StreamEvent::TextDelta { text } = event {
            if !self.pending.contains_key(&session_id) && self.pending.len() >= MAX_PENDING_SESSIONS
            {
                return Self::frame(
                    &session_id,
                    PhoneStreamEvent::TextDelta {
                        text: OMITTED_TEXT.to_string(),
                    },
                )
                .into_iter()
                .collect();
            }
            let pending = self.pending.entry(session_id.clone()).or_default();
            if pending.suppressed {
                return Vec::new();
            }
            let ready = Self::append_text(pending, text);
            return ready
                .into_iter()
                .filter_map(|event| Self::frame(&session_id, event))
                .collect();
        }

        let mut frames = Vec::with_capacity(2);
        if let Some(text) = self.flush_pending(&session_id) {
            if let Some(frame) = Self::frame(&session_id, text) {
                frames.push(frame);
            }
        }
        if let Some(frame) = Self::frame(&session_id, project_event(event)) {
            frames.push(frame);
        }
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portcode_sync::wire::{
        PermissionRisk, TurnChangeCertainty, TurnChangeState, TurnChangedFile, TurnFileStatus,
        TurnPhase, TurnStatus,
    };
    use serde_json::json;

    const SECRET: &str = "sk-ant-api03-projector-secret123456";

    fn receipt() -> TurnReceipt {
        TurnReceipt {
            turn_id: "turn-1".into(),
            account_profile_id: Some("profile-private".into()),
            status: TurnStatus::Completed,
            failure: None,
            stop_reason: Some("end_turn".into()),
            started_at: 1,
            completed_at: 2,
            duration_ms: Some(1),
            agent_duration_ms: Some(1),
            changed_files: vec![TurnChangedFile {
                path: format!("C:/Users/private/work/{SECRET}/file.rs"),
                old_path: Some("/home/private/old.rs".into()),
                status: TurnFileStatus::Modified,
                additions: Some(1),
                deletions: Some(2),
                binary: false,
                certainty: TurnChangeCertainty::Exact,
            }],
            changed_file_count: 1,
            additions: 1,
            deletions: 2,
            files_truncated: false,
            change_state: Some(TurnChangeState::Changed),
            change_certainty: TurnChangeCertainty::Exact,
            background_tasks_running: false,
        }
    }

    #[test]
    fn every_internal_event_projects_without_raw_credentials_or_tool_payloads() {
        let receipt = receipt();
        let events = vec![
            StreamEvent::TurnStart {
                message_id: format!("message-{SECRET}"),
                turn_id: Some(format!("turn-{SECRET}")),
                started_at: Some(1),
            },
            StreamEvent::TurnPhase {
                turn_id: format!("turn-{SECRET}"),
                phase: TurnPhase::AgentCompleted,
                at: 2,
                revision: Some(1),
                status: Some(TurnStatus::Completed),
                stop_reason: Some(format!("future-{SECRET}")),
                agent_duration_ms: Some(1),
                receipt_expected: Some(false),
            },
            StreamEvent::TextDelta {
                text: format!("hello {SECRET}"),
            },
            StreamEvent::ToolUse {
                id: format!("tool-{SECRET}"),
                name: "future_tool".into(),
                input: json!({"raw": SECRET}),
            },
            StreamEvent::ToolResult {
                id: format!("tool-{SECRET}"),
                output: format!("raw output {SECRET}"),
                is_error: false,
            },
            StreamEvent::PermissionRequest {
                id: "permission-1".into(),
                tool: "shell".into(),
                risk: PermissionRisk::Shell,
                summary: format!("run {SECRET}"),
                input: json!({"command": SECRET}),
                diff: Some(format!("diff {SECRET}")),
            },
            StreamEvent::Usage {
                input_tokens: u32::MAX,
                output_tokens: u32::MAX,
            },
            StreamEvent::TurnEnd {
                stop_reason: format!("future-{SECRET}"),
                receipt: Some(receipt.clone()),
            },
            StreamEvent::Error {
                message: format!("error {SECRET}"),
                receipt: Some(receipt),
            },
            StreamEvent::AgentStarted {
                agent_id: format!("agent-{SECRET}"),
                description: format!("task {SECRET}"),
                parent_id: Some(format!("parent-{SECRET}")),
                parent_thread_id: Some(format!("parent-thread-{SECRET}")),
                launch_turn_id: Some(format!("launch-{SECRET}")),
                model: Some(format!("model-{SECRET}")),
                reasoning_effort: Some(format!("effort-{SECRET}")),
                activity: Some(format!("activity-{SECRET}")),
            },
            StreamEvent::AgentProgress {
                agent_id: format!("agent-{SECRET}"),
                step: u32::MAX,
                parent_thread_id: Some(format!("parent-{SECRET}")),
                launch_turn_id: Some(format!("launch-{SECRET}")),
                current_turn_id: Some(format!("turn-{SECRET}")),
                turn_count: Some(u32::MAX),
            },
            StreamEvent::AgentFinished {
                agent_id: format!("agent-{SECRET}"),
                status: format!("future-{SECRET}"),
                result: Some(format!("private result {SECRET}")),
                provider_status: Some(format!("future-{SECRET}")),
                parent_thread_id: Some(format!("parent-{SECRET}")),
                launch_turn_id: Some(format!("launch-{SECRET}")),
                current_turn_id: Some(format!("turn-{SECRET}")),
                turn_count: Some(u32::MAX),
                activity: Some(format!("activity-{SECRET}")),
            },
            StreamEvent::BackgroundTaskStarted {
                id: "background-1".into(),
                command: format!("run {SECRET}"),
            },
            StreamEvent::BackgroundTaskFinished {
                id: "background-1".into(),
                command: format!("run {SECRET}"),
                exit_code: 1,
                output: format!("output {SECRET}"),
            },
        ];

        for event in events {
            let encoded = serde_json::to_string(&project_event(&event)).unwrap();
            assert!(!encoded.contains(SECRET), "secret survived: {encoded}");
            assert!(!encoded.contains("profile-private"), "{encoded}");
            assert!(!encoded.contains("raw output"), "{encoded}");
            assert!(!encoded.contains("\"command\":\"sk-ant"), "{encoded}");
            assert!(!encoded.contains("diff sk-ant"), "{encoded}");
        }
    }

    #[test]
    fn child_descriptions_never_forward_benign_sensitive_prompts_or_paths() {
        const PROMPT: &str = "Review the quiet merger terms for Project Birch";
        const AGENT_PATH: &str = "C:\\Users\\Acer\\clients\\birch\\private-notes.md";

        for description in [PROMPT, AGENT_PATH] {
            let projected = project_event(&StreamEvent::AgentStarted {
                agent_id: "child-thread".into(),
                description: description.into(),
                parent_id: Some("parent-agent".into()),
                parent_thread_id: Some("root-thread".into()),
                launch_turn_id: Some("root-turn".into()),
                model: Some("gpt-5.6".into()),
                reasoning_effort: Some("high".into()),
                activity: Some("spawnAgent".into()),
            });
            let wire = serde_json::to_string(&projected).unwrap();

            assert!(!wire.contains(PROMPT), "prompt reached phone wire: {wire}");
            assert!(
                !wire.contains(AGENT_PATH),
                "path reached phone wire: {wire}"
            );
            assert_eq!(
                serde_json::to_value(projected).unwrap()["description"],
                "Codex subagent"
            );
        }
    }

    #[test]
    fn codex_activity_projects_only_additive_wire_safe_convergence_payloads() {
        const RAW_SENTINEL: &str = "RAW_SENTINEL_PUBLIC_CODEX_ACTIVITY";
        let fixtures = [
            (
                StreamEvent::CodexEvent {
                    sequence: 21,
                    method: "turn/plan/updated".into(),
                    params: json!({
                        "plan": [
                            {"step": RAW_SENTINEL, "status": "completed"},
                            {"step": "C:\\private\\secret", "status": "inProgress"}
                        ],
                        "credential": RAW_SENTINEL,
                        "kind": "chain_of_thought",
                        "content": RAW_SENTINEL
                    }),
                    request_id: None,
                    thread_id: Some("thread-1".into()),
                    turn_id: Some("turn-1".into()),
                    item_id: None,
                    emitted_at_ms: 210,
                },
                "plan",
            ),
            (
                StreamEvent::CodexEvent {
                    sequence: 22,
                    method: "turn/diff/updated".into(),
                    params: json!({"diff":"diff --git a/private b/private\n+secret\n-old"}),
                    request_id: None,
                    thread_id: Some("thread-1".into()),
                    turn_id: Some("turn-1".into()),
                    item_id: None,
                    emitted_at_ms: 220,
                },
                "diff",
            ),
            (
                StreamEvent::CodexEvent {
                    sequence: 23,
                    method: "item/completed".into(),
                    params: json!({
                        "item": {
                            "id": "item-1",
                            "type": "commandExecution",
                            "status": "completed",
                            "command": RAW_SENTINEL,
                            "cwd": "C:\\private",
                            "aggregatedOutput": RAW_SENTINEL
                        }
                    }),
                    request_id: None,
                    thread_id: Some("thread-1".into()),
                    turn_id: Some("turn-1".into()),
                    item_id: Some("item-1".into()),
                    emitted_at_ms: 230,
                },
                "tool",
            ),
            (
                StreamEvent::CodexEvent {
                    sequence: 24,
                    method: "turn/completed".into(),
                    params: json!({"turn":{"id":"turn-1","status":"completed","items":[RAW_SENTINEL]}}),
                    request_id: None,
                    thread_id: Some("thread-1".into()),
                    turn_id: Some("turn-1".into()),
                    item_id: None,
                    emitted_at_ms: 240,
                },
                "terminal",
            ),
        ];

        for (event, payload_type) in fixtures {
            let projected = serde_json::to_value(project_event(&event)).unwrap();
            let encoded = serde_json::to_string(&projected).unwrap();
            assert_eq!(projected["payload"]["type"], payload_type);
            assert!(!encoded.contains(RAW_SENTINEL), "{encoded}");
            assert!(!encoded.contains("C:\\\\private"), "{encoded}");
            assert!(!encoded.contains("\"command\":"), "{encoded}");
            assert!(!encoded.contains("aggregatedOutput"), "{encoded}");
        }
    }

    #[test]
    fn sanitized_codex_events_and_requests_remain_distinguishable_remotely() {
        let first = project_event(&StreamEvent::CodexEvent {
            sequence: 7,
            method: "future/alpha".into(),
            params: json!({
                "threadId": "private-thread",
                "turnId": "private-turn",
                "secret": SECRET,
                "_portcodeActivity": {
                    "redacted": true,
                    "truncated": false,
                    "redactionReasons": ["knownSecret", "rawReasoning", "private-reason"],
                    "originalBytes": 900,
                    "retainedBytes": 90
                }
            }),
            request_id: None,
            thread_id: Some("private-thread".into()),
            turn_id: Some("private-turn".into()),
            item_id: Some("private-item".into()),
            emitted_at_ms: 123,
        });
        let second = project_event(&StreamEvent::CodexEvent {
            sequence: 8,
            method: "future/beta".into(),
            params: json!({
                "threadId": "private-thread",
                "payload": SECRET,
                "_portcodeActivity": {"redacted": false, "truncated": true}
            }),
            request_id: Some(json!(SECRET)),
            thread_id: Some("private-thread".into()),
            turn_id: None,
            item_id: None,
            emitted_at_ms: 124,
        });
        let request = project_event(&StreamEvent::CodexRequest {
            id: format!("request-{SECRET}"),
            method: "future/request".into(),
            params: json!({
                "threadId": "private-thread",
                "turnId": "private-turn",
                "credential": SECRET,
                "_portcodeActivity": {"redacted": true, "truncated": true}
            }),
        });

        let first = serde_json::to_value(first).unwrap();
        let second = serde_json::to_value(second).unwrap();
        let request = serde_json::to_value(request).unwrap();
        assert_ne!(first, second);
        assert_eq!(first["method"], "future/alpha");
        assert_eq!(second["method"], "future/beta");
        assert_eq!(request["method"], "future/request");
        assert_eq!(first["kind"], "event");
        assert_eq!(request["kind"], "request");
        assert_eq!(first["redacted"], true);
        assert_eq!(
            first["redactionReasons"],
            json!(["knownSecret", "rawReasoning"])
        );
        assert_eq!(first["originalBytes"], 900);
        assert_eq!(first["retainedBytes"], 90);
        assert_eq!(second["truncated"], true);
        assert!(first.get("threadId").is_some());
        assert!(request.get("turnId").is_some());
        let encoded = serde_json::to_string(&(first, second, request)).unwrap();
        assert!(!encoded.contains(SECRET));
        assert!(!encoded.contains("credential"));
        assert!(!encoded.contains("payload"));
        assert!(!encoded.contains("private-reason"));
    }

    #[test]
    fn future_agent_status_projects_as_unknown_without_forwarding_result_content() {
        let projected = project_event(&StreamEvent::AgentFinished {
            agent_id: "child-private".into(),
            status: "future-provider-state".into(),
            result: Some("provider-authored private result".into()),
            provider_status: Some("future-provider-state".into()),
            parent_thread_id: Some("parent-private".into()),
            launch_turn_id: Some("launch-private".into()),
            current_turn_id: Some("turn-private".into()),
            turn_count: Some(2),
            activity: Some("completed".into()),
        });
        assert!(matches!(
            projected,
            PhoneStreamEvent::AgentFinished {
                status,
                result: None,
                provider_status: Some(provider_status),
                turn_count: Some(2),
                ..
            } if status == "unknown" && provider_status == "unknown"
        ));
    }

    #[test]
    fn adjacent_text_deltas_are_redacted_as_one_value_before_release() {
        let mut projector = PhoneEventProjector::new();
        let prefix = "ordinary words ".repeat(300);
        let first = projector.project_frames(
            "session-1",
            &StreamEvent::TextDelta {
                text: format!("{prefix}credential sk-ant-api03-split"),
            },
        );
        assert!(
            !first.is_empty(),
            "ordinary prefix should stream immediately"
        );
        let first_encoded = serde_json::to_string(&first).unwrap();
        assert!(!first_encoded.contains("sk-ant-api03-split"));
        assert!(projector
            .project_frames(
                "session-1",
                &StreamEvent::TextDelta {
                    text: "secret123456 more".into(),
                },
            )
            .is_empty());
        let mut frames = first;
        frames.extend(projector.project_frames(
            "session-1",
            &StreamEvent::Usage {
                input_tokens: 1,
                output_tokens: 2,
            },
        ));
        assert!(frames.len() >= 3);
        let encoded = serde_json::to_string(&frames).unwrap();
        assert!(!encoded.contains("sk-ant-api03-splitsecret123456"));
        assert!(encoded.contains("redacted-api-key"));
    }

    #[test]
    fn ordinary_large_text_streams_in_order_across_multiple_bounded_frames() {
        let original = "ordinary live response words ".repeat(1_500);
        assert!(original.len() > 32 * 1_024);
        let mut projector = PhoneEventProjector::new();
        let mut frames = projector.project_frames(
            "session-1",
            &StreamEvent::TextDelta {
                text: original.clone(),
            },
        );
        assert!(frames.len() > 1, "large text must stream before turn end");
        frames.extend(projector.project_frames(
            "session-1",
            &StreamEvent::Usage {
                input_tokens: 1,
                output_tokens: 1,
            },
        ));

        let mut reconstructed = String::new();
        let mut text_frames = 0;
        for frame in &frames {
            assert!(frame_fits(frame, PHONE_LIVE_FRAME_BUDGET));
            if let SyncFrame::Live {
                event: PhoneStreamEvent::TextDelta { text },
                ..
            } = frame
            {
                text_frames += 1;
                reconstructed.push_str(text);
            }
        }
        assert!(text_frames > 1);
        assert_eq!(reconstructed, original);
    }

    #[test]
    fn one_huge_no_boundary_delta_keeps_holdback_and_output_bounded() {
        let mut projector = PhoneEventProjector::new();
        let huge = "!".repeat(MAX_PENDING_TEXT_BYTES * 4);
        let immediate =
            projector.project_frames("session-1", &StreamEvent::TextDelta { text: huge });
        assert!(immediate.len() <= MAX_LIVE_FRAMES_PER_EVENT);

        let pending = projector.pending.get("session-1").unwrap();
        assert!(pending.suppressed);
        assert!(pending.raw.is_empty());
        assert!(
            pending.raw.capacity() <= MAX_PENDING_TEXT_BYTES * 2,
            "holdback allocation grew without a fixed bound: {}",
            pending.raw.capacity()
        );

        let terminal = projector.project_frames(
            "session-1",
            &StreamEvent::Usage {
                input_tokens: 1,
                output_tokens: 1,
            },
        );
        assert_eq!(terminal.len(), 2);
        assert!(terminal.iter().all(|frame| {
            frame_fits(frame, PHONE_LIVE_FRAME_BUDGET)
                && !serde_json::to_string(frame).unwrap().contains("!!!!")
        }));
        assert!(matches!(
            &terminal[0],
            SyncFrame::Live {
                event: PhoneStreamEvent::TextDelta { text },
                ..
            } if text == OMITTED_TEXT
        ));
    }

    #[test]
    fn history_projection_removes_reasoning_raw_tools_accounts_and_absolute_paths() {
        let row = MessageRow {
            id: "message-1".into(),
            session_id: "session-1".into(),
            seq: 1,
            role: "assistant".into(),
            content: vec![
                Block::Text {
                    text: format!("hello {SECRET}"),
                },
                Block::ToolUse {
                    id: "provider-id".into(),
                    name: "shell".into(),
                    input: json!({"command": SECRET}),
                },
                Block::ToolResult {
                    tool_use_id: "provider-id".into(),
                    content: format!("raw {SECRET}"),
                    is_error: false,
                },
                Block::Reasoning {
                    model: Some("private-model".into()),
                    id: Some("reasoning-id".into()),
                    encrypted_content: Some(SECRET.into()),
                    summary: vec![json!(SECRET)],
                },
            ],
            created_at: 1,
            turn_id: Some("turn-1".into()),
            receipt: Some(receipt()),
        };
        let encoded = serde_json::to_string(&project_message(&row)).unwrap();
        for forbidden in [
            SECRET,
            "profile-private",
            "private-model",
            "reasoning-id",
            "encrypted_content",
            "C:/Users/private",
            "/home/private",
            "\"command\"",
            "raw sk-ant",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "{forbidden} survived: {encoded}"
            );
        }
        assert!(encoded.contains("\"input\":{}"), "{encoded}");
        assert!(encoded.contains("Tool completed."), "{encoded}");
    }

    #[test]
    fn history_text_uses_its_field_budget_instead_of_the_telemetry_cap() {
        let row = MessageRow {
            id: "message-1".into(),
            session_id: "session-1".into(),
            seq: 1,
            role: "assistant".into(),
            content: vec![Block::Text {
                text: "ordinary history words ".repeat(400),
            }],
            created_at: 1,
            turn_id: None,
            receipt: None,
        };
        let projected = project_message(&row);
        let PhoneBlock::Text { text } = &projected.content[0] else {
            panic!("expected text block")
        };
        assert!(text.len() > 2_048, "history was telemetry-truncated");
        assert!(text.len() <= MAX_MESSAGE_TEXT_BYTES);
    }

    #[test]
    fn public_frames_are_utf8_safe_and_below_both_budgets() {
        let messages: Vec<_> = (0..100)
            .map(|seq| MessageRow {
                id: format!("message-{seq}"),
                session_id: "session-1".into(),
                seq,
                role: "user".into(),
                content: vec![Block::Text {
                    text: format!("{} {SECRET}", "😀".repeat(20_000)),
                }],
                created_at: seq,
                turn_id: None,
                receipt: None,
            })
            .collect();
        let frame = message_delta_frame("session-1", messages);
        let encoded = serde_json::to_vec(&frame).unwrap();
        assert!(encoded.len() <= PHONE_FRAME_BUDGET, "{}", encoded.len());
        assert!(encoded.len() < 65_519);
        assert!(!String::from_utf8(encoded).unwrap().contains(SECRET));

        let live = project_event(&StreamEvent::TextDelta {
            text: "🙂".repeat(20_000),
        });
        let frame = SyncFrame::Live {
            session_id: "session-1".into(),
            event: live,
        };
        assert!(frame_fits(&frame, PHONE_LIVE_FRAME_BUDGET));
    }

    #[test]
    fn remote_identifier_validation_rejects_reflection_characters() {
        assert!(valid_remote_identifier("session-123.test_value"));
        for invalid in ["", "session:agent", "line\nbreak", "control\0id"] {
            assert!(!valid_remote_identifier(invalid), "accepted {invalid:?}");
        }
        assert!(!valid_remote_identifier(
            &"a".repeat(MAX_REMOTE_IDENTIFIER_BYTES + 1)
        ));
    }

    #[test]
    fn public_text_preserves_layout_but_removes_unsafe_controls_with_exact_bounds() {
        let projected = bounded_public_text("line one\r\n\tcode\0\u{1b}[31m\rline two", 1_024);
        assert_eq!(projected, "line one\n\tcode  [31m\nline two");
        assert!(projected
            .chars()
            .all(|character| !character.is_control() || matches!(character, '\n' | '\t')));

        assert_eq!(bounded_public_text("abcdefgh", 5), "abcde");
        let unicode = bounded_public_text(&"🙂".repeat(10), 7);
        assert_eq!(unicode.len(), 4);
        assert!(unicode.is_char_boundary(unicode.len()));
    }
}
