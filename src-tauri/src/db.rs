//! SQLite persistence for sessions and messages (crash-safe, WAL mode).
//!
//! The DB stores the canonical conversation (Anthropic-shaped `ChatMessage`s).
//! `ui_messages` reconstructs the frontend's *grouped* view, where tool results
//! are folded back under the assistant message that requested them.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::llm::{Block, ChatMessage};
use portcode_sync::wire::{TurnChangeCertainty, TurnReceipt, TurnStatus};

/// How many of the most-recent messages per session the desktop ships in a single
/// catch-up [`SyncFrame::MessageDelta`](crate::sync::protocol::SyncFrame). Bounds
/// the serialized delta so it fits the Noise transport's ~65 KB frame cap; anything
/// older is fetched on demand by scroll-up pagination (`messages_page` +
/// `RemoteCommand::FetchMessages`). See `Db::messages_tail`.
pub const SYNC_CACHE_WINDOW: i64 = 200;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// `SessionRow` and `MessageRow` are Phone Sync wire DTOs; Phase 1 of
// docs/IOS_WEB_CLIENT_PLAN.md (§5.1) moved them into the shared `portcode-sync`
// crate (`portcode_sync::wire`) so the wasm browser client can decode the
// `SessionList` / `MessageDelta` catch-up frames without linking this desktop
// crate. Re-exported here UNCHANGED (same camelCase serde shape), so every
// `crate::db::SessionRow` / `MessageRow` path resolves to the SAME type. The flat
// `MessageRow` is what Phone Sync replicates (the `MessageDelta` frame ships these
// verbatim); `content` is the typed block list (same shape as `ChatMessage::content`).
// (`SessionRow` carries the per-session `model` column added by per-session-model.)
pub use portcode_sync::wire::{MessageRow, SessionRow};

/// Best-effort current git branch of a session's `workspace`, read directly from
/// `.git/HEAD` — no `git` subprocess and no extra dependency. Returns the short
/// branch name, or `None` when there's no workspace, it isn't a git repo, or HEAD
/// is detached (a raw commit SHA). Linked worktrees/submodules store `.git` as a
/// file pointing at the real gitdir, which we follow.
fn git_branch(workspace: Option<&str>) -> Option<String> {
    let ws = workspace?;
    let dot_git = Path::new(ws).join(".git");
    let head_path = if dot_git.is_dir() {
        dot_git.join("HEAD")
    } else if dot_git.is_file() {
        // `.git` is a file: `gitdir: <path>` (absolute, or relative to the ws).
        let contents = std::fs::read_to_string(&dot_git).ok()?;
        let gitdir = Path::new(contents.strip_prefix("gitdir:")?.trim());
        let resolved = if gitdir.is_absolute() {
            gitdir.to_path_buf()
        } else {
            Path::new(ws).join(gitdir)
        };
        resolved.join("HEAD")
    } else {
        return None;
    };
    let head = std::fs::read_to_string(head_path).ok()?;
    // "ref: refs/heads/<name>" → <name>; a bare SHA means a detached HEAD.
    head.trim()
        .strip_prefix("ref: refs/heads/")
        .map(String::from)
}

/// A phone paired for Phone Sync, keyed by its Curve25519 static public key
/// (base64). `name` is a user-facing label; timestamps are unix millis.
/// `confirmed` is the desktop-side trust gate: a device only graduates from
/// "handshake completed" to "may issue commands" once the desktop user has
/// explicitly compared the SAS and confirmed it (see `confirm_paired_device`).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub public_key: String,
    pub name: String,
    pub paired_at: i64,
    pub last_seen: i64,
    /// Whether the desktop user has explicitly confirmed this device's SAS. Only
    /// a confirmed device is served the command surface; an unconfirmed row (the
    /// default, and what every pre-migration row becomes) must re-confirm.
    pub confirmed: bool,
}

/// A persisted composer draft for one session. camelCase to match the frontend
/// `DraftEntry` (the `get_drafts` init bundle hydrates the per-session draft map).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DraftRow {
    pub session_id: String,
    pub text: String,
}

/// Cumulative token usage for one session. camelCase to match the frontend
/// `SessionUsage` (the `get_all_usage` bundle hydrates the usage map + the
/// workspace-total spend in the status HUD).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    pub session_id: String,
    pub input: i64,
    pub output: i64,
}

/// One message-search hit (newest-first). camelCase to match the frontend
/// `SearchHit`. `seq` is the message's monotonic position in its session; the UI
/// jumps to `session_id` and scrolls to `message_id`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: String,
    pub message_id: String,
    pub seq: i64,
    pub role: String,
    pub snippet: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum UiBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        #[serde(rename = "toolUseId")]
        tool_use_id: String,
        output: String,
        #[serde(rename = "isError")]
        is_error: bool,
    },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UiMessage {
    id: String,
    role: String,
    blocks: Vec<UiBlock>,
    created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    receipt: Option<TurnReceipt>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UiMessagePage {
    pub messages: Vec<UiMessage>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct UiMessageCursor {
    v: u8,
    session_id: String,
    anchor_seq: i64,
    rank: i64,
    tie: String,
}

const UI_MESSAGE_PAGE_SIZE: usize = 100;

fn encode_ui_cursor(
    session_id: &str,
    anchor_seq: i64,
    rank: i64,
    tie: &str,
) -> rusqlite::Result<String> {
    let json = serde_json::to_vec(&UiMessageCursor {
        v: 1,
        session_id: session_id.to_string(),
        anchor_seq,
        rank,
        tie: tie.to_string(),
    })
    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    Ok(URL_SAFE_NO_PAD.encode(json))
}

fn decode_ui_cursor(session_id: &str, value: &str) -> rusqlite::Result<UiMessageCursor> {
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|error| {
        rusqlite::Error::InvalidParameterName(format!("invalid message cursor: {error}"))
    })?;
    let cursor: UiMessageCursor = serde_json::from_slice(&bytes).map_err(|error| {
        rusqlite::Error::InvalidParameterName(format!("invalid message cursor: {error}"))
    })?;
    if cursor.v != 1 || cursor.session_id != session_id || cursor.anchor_seq < 0 {
        return Err(rusqlite::Error::InvalidParameterName(
            "message cursor does not belong to this session".into(),
        ));
    }
    Ok(cursor)
}

/// Durable receipt plus the terminal Git identity used by the historical Review
/// commands. The changed-file manifest lives inside `receipt`; patches are never
/// regenerated from a different workspace state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnReceiptRecord {
    pub session_id: String,
    pub message_id: String,
    pub receipt: TurnReceipt,
    pub repository_root: Option<String>,
    pub terminal_snapshot_id: Option<String>,
}

fn to_ui_block(b: &Block) -> Option<UiBlock> {
    match b {
        Block::Text { text } => Some(UiBlock::Text { text: text.clone() }),
        Block::ToolUse { id, name, input } => Some(UiBlock::ToolUse {
            id: id.clone(),
            name: name.clone(),
            input: input.clone(),
        }),
        Block::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => Some(UiBlock::ToolResult {
            tool_use_id: tool_use_id.clone(),
            output: content.clone(),
            is_error: *is_error,
        }),
        // Reasoning is opaque provider continuation state, not display content.
        Block::Reasoning { .. } => None,
    }
}

/// A stored assistant tool request without a later result is historical, not live:
/// the frontend has no run handle after a reload and would otherwise render it as
/// "running" forever. Add a display-only terminal result; canonical model history
/// remains untouched, and a real persisted result wins whenever one exists.
fn finalize_unmatched_ui_tools(blocks: &mut Vec<UiBlock>) {
    let resolved: Vec<String> = blocks
        .iter()
        .filter_map(|block| match block {
            UiBlock::ToolResult { tool_use_id, .. } => Some(tool_use_id.clone()),
            _ => None,
        })
        .collect();
    let mut finalized = Vec::new();
    for block in blocks.iter() {
        let UiBlock::ToolUse { id, .. } = block else {
            continue;
        };
        if !resolved.contains(id) && !finalized.contains(id) {
            finalized.push(id.clone());
        }
    }
    blocks.extend(
        finalized
            .into_iter()
            .map(|tool_use_id| UiBlock::ToolResult {
                tool_use_id,
                output: "Interrupted: the previous run ended before this tool returned a result."
                    .into(),
                is_error: true,
            }),
    );
}

fn ensure_turn_assistant(
    out: &mut Vec<UiMessage>,
    indices: &mut HashMap<String, usize>,
    turn_id: &str,
    created_at: i64,
    receipt: Option<&TurnReceipt>,
) -> usize {
    if let Some(index) = indices.get(turn_id) {
        if out[*index].receipt.is_none() {
            out[*index].receipt = receipt.cloned();
        }
        return *index;
    }
    let index = out.len();
    out.push(UiMessage {
        id: turn_id.to_string(),
        role: "assistant".into(),
        blocks: Vec::new(),
        created_at,
        turn_id: Some(turn_id.to_string()),
        receipt: receipt.cloned(),
    });
    indices.insert(turn_id.to_string(), index);
    index
}

/// Escape LIKE wildcards so a literal query matches literally under
/// `... LIKE ? ESCAPE '\'` (otherwise a `%` or `_` in the query would widen it).
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for ch in s.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// A one-line excerpt of `text` around the first ASCII-case-insensitive match of
/// `needle` (which the caller has already ASCII-lowercased). Returns `None` when
/// `text` doesn't actually contain the needle — this is what drops LIKE matches
/// that only hit serialized JSON structure rather than real conversation text.
fn search_snippet(text: &str, needle: &str) -> Option<String> {
    // Collapse whitespace so a multi-line message reads as a single preview line.
    let normalized: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    // ASCII-lowercase preserves the byte layout, so an offset found in `hay` is a
    // valid index into `normalized` too (no multibyte-slice panic risk).
    let hay = normalized.to_ascii_lowercase();
    let pos = hay.find(needle)?;
    let match_end = pos + needle.len();
    let mut start = pos.saturating_sub(40);
    while start > 0 && !normalized.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (match_end + 100).min(normalized.len());
    while end < normalized.len() && !normalized.is_char_boundary(end) {
        end += 1;
    }
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(&normalized[start..end]);
    if end < normalized.len() {
        out.push('…');
    }
    Some(out)
}

/// Map one `messages` row to a [`MessageRow`]. Shared by every catch-up/pagination
/// query (`messages_since` / `messages_tail` / `messages_page`) so they decode the
/// six columns identically. `content` is parsed leniently: corrupt JSON degrades to
/// an empty block list rather than failing the row (same policy as
/// `load_chat_messages`/`ui_messages`).
fn row_to_message(r: &rusqlite::Row) -> rusqlite::Result<MessageRow> {
    let content: String = r.get(4)?;
    let mut blocks: Vec<Block> = serde_json::from_str(&content).unwrap_or_default();
    // Phone Sync is a display/control channel; inference always resumes on the
    // desktop from the canonical DB. Do not replicate opaque encrypted reasoning
    // state to display-only clients.
    blocks.retain(|block| !matches!(block, Block::Reasoning { .. }));
    Ok(MessageRow {
        id: r.get(0)?,
        session_id: r.get(1)?,
        seq: r.get(2)?,
        role: r.get(3)?,
        content: blocks,
        created_at: r.get(5)?,
        turn_id: r.get(6)?,
        receipt: r
            .get::<_, Option<String>>(7)?
            .and_then(|json| serde_json::from_str(&json).ok()),
    })
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        // Retry briefly on a transient lock instead of failing a write instantly —
        // a swallowed write used to look like a successful persist.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                workspace TEXT,
                model TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                turn_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
            CREATE TABLE IF NOT EXISTS paired_devices (
                public_key TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                paired_at INTEGER NOT NULL,
                last_seen INTEGER NOT NULL,
                confirmed INTEGER NOT NULL DEFAULT 0
            );
            -- An unsent composer draft per session (Zeigarnik open-loop: an
            -- unfinished message survives a restart). One row per session; cleared
            -- on a real send. No FK to `sessions` so a draft can outlive a brief
            -- window where the session row hasn't been created yet (the frontend
            -- creates the session first in practice, but we stay defensive).
            CREATE TABLE IF NOT EXISTS drafts (
                session_id TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            -- Cumulative token usage per session (input/output), accumulated across
            -- every turn so the running cost survives a restart. Upserted additively
            -- on each `usage` stream event (see agent.rs).
            CREATE TABLE IF NOT EXISTS usage (
                session_id TEXT PRIMARY KEY,
                input INTEGER NOT NULL DEFAULT 0,
                output INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS turn_receipts (
                turn_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                receipt_json TEXT NOT NULL,
                repository_root TEXT,
                terminal_snapshot_id TEXT,
                started_at INTEGER NOT NULL,
                completed_at INTEGER NOT NULL,
                terminal INTEGER NOT NULL DEFAULT 0,
                anchor_seq INTEGER
            );",
        )?;
        // Migrate pre-existing databases: the CREATE-IF-NOT-EXISTS above won't add
        // a column to a table that already exists, so add `model` in place.
        // Probe first instead of swallowing every ALTER error: a real migration
        // failure must fail startup rather than make model changes appear durable
        // until the next reload.
        Self::migrate_add_model(&conn)?;
        // ADDITIVE migration: a `paired_devices` table created before the
        // device-trust gate landed has no `confirmed` column. Add it without
        // dropping the table, defaulting every pre-existing row to 0 (untrusted).
        // That means devices paired under the old, vulnerable "handshake ==
        // authorized" code must re-confirm on their next connection — the
        // intended, secure-by-default behavior for this alpha. `ALTER TABLE ... ADD
        // COLUMN` errors with "duplicate column name" once the column exists, so we
        // probe `PRAGMA table_info` first and only add when missing (keeping
        // startup idempotent across launches).
        Self::migrate_add_confirmed(&conn)?;
        Self::migrate_add_turn_id(&conn)?;
        Self::migrate_add_receipt_terminal(&conn)?;
        Self::migrate_add_receipt_anchor(&conn)?;
        Self::recover_pending_turn_receipts(&conn, now_ms())?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_turn_receipts_session
             ON turn_receipts(session_id, started_at)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_turn_receipts_timeline
             ON turn_receipts(session_id, terminal, anchor_seq)",
            [],
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Idempotently add the per-session `model` column to a legacy sessions table.
    /// Existing rows intentionally remain NULL; the frontend falls back to the
    /// last-used default until the user selects and persists a model for that chat.
    fn migrate_add_model(conn: &Connection) -> rusqlite::Result<()> {
        let mut stmt = conn.prepare("PRAGMA table_info(sessions)")?;
        let has_model = stmt
            .query_map([], |r| r.get::<_, String>(1))?
            .filter_map(|c| c.ok())
            .any(|name| name == "model");
        if !has_model {
            conn.execute("ALTER TABLE sessions ADD COLUMN model TEXT", [])?;
        }
        Ok(())
    }

    /// Idempotently add the `confirmed` column to a legacy `paired_devices`
    /// table. No-op when the column already exists (fresh DBs create it inline).
    fn migrate_add_confirmed(conn: &Connection) -> rusqlite::Result<()> {
        let mut stmt = conn.prepare("PRAGMA table_info(paired_devices)")?;
        let has_confirmed = stmt
            .query_map([], |r| r.get::<_, String>(1))?
            .filter_map(|c| c.ok())
            .any(|name| name == "confirmed");
        if !has_confirmed {
            conn.execute(
                "ALTER TABLE paired_devices ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        Ok(())
    }

    /// Additive receipt migration. NULL identifies legacy rows and deliberately
    /// preserves their historical grouping behavior.
    fn migrate_add_turn_id(conn: &Connection) -> rusqlite::Result<()> {
        let mut stmt = conn.prepare("PRAGMA table_info(messages)")?;
        let has_turn_id = stmt
            .query_map([], |r| r.get::<_, String>(1))?
            .filter_map(|column| column.ok())
            .any(|name| name == "turn_id");
        if !has_turn_id {
            conn.execute("ALTER TABLE messages ADD COLUMN turn_id TEXT", [])?;
        }
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(turn_id, seq)",
            [],
        )?;
        Ok(())
    }

    /// Earlier receipt builds had no explicit pending state and every stored row
    /// was terminal. Preserve those rows as terminal during the additive migration;
    /// new pending writes always set `terminal = 0` explicitly.
    fn migrate_add_receipt_terminal(conn: &Connection) -> rusqlite::Result<()> {
        let mut stmt = conn.prepare("PRAGMA table_info(turn_receipts)")?;
        let has_terminal = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(|column| column.ok())
            .any(|name| name == "terminal");
        if !has_terminal {
            conn.execute(
                "ALTER TABLE turn_receipts
                 ADD COLUMN terminal INTEGER NOT NULL DEFAULT 1",
                [],
            )?;
        }
        Ok(())
    }

    /// Add a stable timeline position for receipts, including turns that failed
    /// before writing a canonical message. The backfill first attaches receipts to
    /// their turn's earliest row, otherwise places them immediately before the
    /// first later message (or at the end for a receipt-only tail).
    fn migrate_add_receipt_anchor(conn: &Connection) -> rusqlite::Result<()> {
        let mut stmt = conn.prepare("PRAGMA table_info(turn_receipts)")?;
        let has_anchor = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(|column| column.ok())
            .any(|name| name == "anchor_seq");
        if !has_anchor {
            conn.execute(
                "ALTER TABLE turn_receipts ADD COLUMN anchor_seq INTEGER",
                [],
            )?;
        }
        conn.execute(
            "UPDATE turn_receipts AS tr
             SET anchor_seq = COALESCE(
                 (SELECT MIN(m.seq) FROM messages m WHERE m.turn_id = tr.turn_id),
                 (SELECT MIN(m.seq) FROM messages m
                  WHERE m.session_id = tr.session_id AND m.created_at >= tr.started_at),
                 (SELECT COALESCE(MAX(m.seq) + 1, 0) FROM messages m
                  WHERE m.session_id = tr.session_id)
             )
             WHERE anchor_seq IS NULL",
            [],
        )?;
        Ok(())
    }

    /// Terminalize rows left pending by a prior process. The interruption instant
    /// is unknowable, so duration remains omitted; `completed_at` records recovery
    /// time, not a fabricated crash time.
    fn recover_pending_turn_receipts(conn: &Connection, recovered_at: i64) -> rusqlite::Result<()> {
        let pending: Vec<(String, String)> = {
            let mut stmt =
                conn.prepare("SELECT turn_id, receipt_json FROM turn_receipts WHERE terminal = 0")?;
            let rows = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .filter_map(|row| row.ok())
                .collect();
            rows
        };
        for (turn_id, json) in pending {
            let Ok(mut receipt) = serde_json::from_str::<TurnReceipt>(&json) else {
                // A corrupt pending row must not retry forever or leak through a
                // future join. Mark it terminal; typed reads will continue to hide it.
                conn.execute(
                    "UPDATE turn_receipts SET terminal = 1 WHERE turn_id = ?1",
                    params![turn_id],
                )?;
                continue;
            };
            receipt.status = TurnStatus::Interrupted;
            receipt.stop_reason = Some("process_interrupted".into());
            receipt.completed_at = recovered_at.max(receipt.started_at);
            receipt.duration_ms = None;
            receipt.change_certainty = TurnChangeCertainty::Unavailable;
            receipt.background_tasks_running = false;
            let recovered_json = serde_json::to_string(&receipt)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            conn.execute(
                "UPDATE turn_receipts
                 SET receipt_json = ?2, completed_at = ?3, terminal = 1
                 WHERE turn_id = ?1",
                params![turn_id, recovered_json, receipt.completed_at],
            )?;
        }
        Ok(())
    }

    pub fn list_sessions(&self) -> rusqlite::Result<Vec<SessionRow>> {
        // Collect database fields under the mutex, then release it before reading
        // each workspace's `.git/HEAD`; filesystem I/O must not serialize all DB work.
        let rows: Vec<SessionRow> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT id, title, workspace, model, created_at, updated_at
                 FROM sessions ORDER BY updated_at DESC",
            )?;
            let mapped = stmt.query_map([], |r| {
                Ok(SessionRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    branch: None,
                    workspace: r.get(2)?,
                    model: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            })?;
            mapped.collect::<rusqlite::Result<Vec<_>>>()?
        };

        Ok(rows
            .into_iter()
            .map(|mut session| {
                session.branch = git_branch(session.workspace.as_deref());
                session
            })
            .collect())
    }

    /// Resolve the workspace persisted for exactly one session. The nested
    /// option distinguishes an unknown session (`None`) from a known session
    /// that intentionally has no workspace (`Some(None)`). Archive safety uses
    /// this rather than accepting an arbitrary path from the frontend.
    pub fn workspace_for_session(&self, id: &str) -> rusqlite::Result<Option<Option<String>>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT workspace FROM sessions WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
    }

    pub fn create_session(
        &self,
        id: &str,
        title: &str,
        workspace: Option<&str>,
        model: Option<&str>,
        ts: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, workspace, model, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, title, workspace, model, ts],
        )?;
        Ok(())
    }

    pub fn rename_session(&self, id: &str, title: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET title = ?2 WHERE id = ?1",
            params![id, title],
        )?;
        Ok(())
    }

    /// Persist the model selected for one existing session. This is deliberately
    /// separate from global settings: changing the default for future chats must
    /// not rewrite every existing conversation's provider/model identity.
    pub fn update_session_model(&self, id: &str, model: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let updated = conn.execute(
            "UPDATE sessions SET model = ?2 WHERE id = ?1",
            params![id, model],
        )?;
        if updated == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn session_model(&self, id: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT model FROM sessions WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
    }

    fn require_session(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let exists = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
            params![id],
            |row| row.get::<_, i64>(0),
        )?;
        if exists == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn touch_session(&self, id: &str, ts: i64) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
            params![id, ts],
        );
    }

    pub fn set_title_if_blank(&self, id: &str, title: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE sessions SET title = ?2
             WHERE id = ?1 AND (title = '' OR title = 'New chat')",
            params![id, title],
        );
    }

    pub fn delete_session(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM messages WHERE session_id = ?1", params![id])?;
        conn.execute(
            "DELETE FROM turn_receipts WHERE session_id = ?1",
            params![id],
        )?;
        // Drop the session's draft + cumulative usage too, so a deleted session
        // leaves no orphaned rows that would skew the workspace-total spend.
        conn.execute("DELETE FROM drafts WHERE session_id = ?1", params![id])?;
        conn.execute("DELETE FROM usage WHERE session_id = ?1", params![id])?;
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ── drafts (composer open-loop persistence) ──────────────────────────────

    /// Upsert (or clear) one session's unsent draft. An empty/whitespace-only
    /// `text` DELETES the row instead of storing a blank — a real send clears the
    /// draft, and `get_draft` of an absent row reads as "no draft" (`None`), so the
    /// table never accumulates empty rows.
    pub fn save_draft(&self, session_id: &str, text: &str, ts: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        if text.trim().is_empty() {
            conn.execute(
                "DELETE FROM drafts WHERE session_id = ?1",
                params![session_id],
            )?;
        } else {
            conn.execute(
                "INSERT INTO drafts (session_id, text, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id) DO UPDATE SET text = ?2, updated_at = ?3",
                params![session_id, text, ts],
            )?;
        }
        Ok(())
    }

    /// The stored draft for a session, or `None` when there is none.
    pub fn get_draft(&self, session_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT text FROM drafts WHERE session_id = ?1",
            params![session_id],
            |r| r.get::<_, String>(0),
        )
        .ok()
    }

    /// Every stored draft (the init-bundle hydration for the frontend's per-session
    /// draft map). A DB read error degrades to an empty list, never an error.
    pub fn all_drafts(&self) -> Vec<DraftRow> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT session_id, text FROM drafts") else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| {
            Ok(DraftRow {
                session_id: r.get(0)?,
                text: r.get(1)?,
            })
        });
        let Ok(rows) = rows else { return Vec::new() };
        rows.filter_map(|r| r.ok()).collect()
    }

    // ── usage (cumulative per-session token spend) ───────────────────────────

    /// Accumulate token usage for a session (additive upsert). Called once per
    /// `usage` stream event so the running total survives a restart. Negative
    /// deltas are ignored at the call site; here we simply add.
    pub fn add_usage(
        &self,
        session_id: &str,
        input: i64,
        output: i64,
        ts: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO usage (session_id, input, output, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id) DO UPDATE SET
                 input = input + ?2, output = output + ?3, updated_at = ?4",
            params![session_id, input, output, ts],
        )?;
        Ok(())
    }

    /// Cumulative usage for one session (zeros when none recorded).
    pub fn get_usage(&self, session_id: &str) -> UsageRow {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT input, output FROM usage WHERE session_id = ?1",
            params![session_id],
            |r| {
                Ok(UsageRow {
                    session_id: session_id.to_string(),
                    input: r.get(0)?,
                    output: r.get(1)?,
                })
            },
        )
        .unwrap_or(UsageRow {
            session_id: session_id.to_string(),
            input: 0,
            output: 0,
        })
    }

    /// Every session's cumulative usage (init-bundle hydration + the basis for the
    /// workspace-total spend). A DB read error degrades to an empty list.
    pub fn all_usage(&self) -> Vec<UsageRow> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT session_id, input, output FROM usage") else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| {
            Ok(UsageRow {
                session_id: r.get(0)?,
                input: r.get(1)?,
                output: r.get(2)?,
            })
        });
        let Ok(rows) = rows else { return Vec::new() };
        rows.filter_map(|r| r.ok()).collect()
    }

    fn next_seq(conn: &Connection, session_id: &str) -> i64 {
        conn.query_row(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM messages WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Append one canonical message, returning its row id. Propagates the insert
    /// failure (disk full, corruption, lock that outlived the busy-timeout) so a lost
    /// write is surfaced as a turn error instead of silently desyncing the log.
    pub fn try_append_message(
        &self,
        session_id: &str,
        msg: &ChatMessage,
        ts: i64,
    ) -> rusqlite::Result<String> {
        self.try_append_message_for_turn(session_id, None, msg, ts)
    }

    /// Append one canonical message associated with a root turn. The row keeps its
    /// own UUID for append-only replication; `turn_id` is the authoritative display
    /// message id used to fold all assistant/tool rounds into one bubble on reload.
    pub fn try_append_message_for_turn(
        &self,
        session_id: &str,
        turn_id: Option<&str>,
        msg: &ChatMessage,
        ts: i64,
    ) -> rusqlite::Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let content = serde_json::to_string(&msg.content).unwrap_or_else(|_| "[]".into());
        let conn = self.conn.lock().unwrap();
        let seq = Self::next_seq(&conn, session_id);
        conn.execute(
            "INSERT INTO messages (id, session_id, seq, role, content, created_at, turn_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, session_id, seq, msg.role, content, ts, turn_id],
        )?;
        Ok(id)
    }

    /// Persist an in-flight placeholder. Pending rows are durable for crash
    /// recovery but intentionally invisible to UI, Phone Sync, and Review reads.
    pub fn save_pending_turn_receipt(
        &self,
        session_id: &str,
        message_id: &str,
        receipt: &TurnReceipt,
    ) -> rusqlite::Result<()> {
        self.save_turn_receipt_state(session_id, message_id, receipt, None, None, false)
    }

    /// Insert or replace the immutable terminal receipt and make it visible to all
    /// reload surfaces.
    pub fn save_turn_receipt(
        &self,
        session_id: &str,
        message_id: &str,
        receipt: &TurnReceipt,
        repository_root: Option<&str>,
        terminal_snapshot_id: Option<&str>,
    ) -> rusqlite::Result<()> {
        self.save_turn_receipt_state(
            session_id,
            message_id,
            receipt,
            repository_root,
            terminal_snapshot_id,
            true,
        )
    }

    fn save_turn_receipt_state(
        &self,
        session_id: &str,
        message_id: &str,
        receipt: &TurnReceipt,
        repository_root: Option<&str>,
        terminal_snapshot_id: Option<&str>,
        terminal: bool,
    ) -> rusqlite::Result<()> {
        let json = serde_json::to_string(receipt)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO turn_receipts (
                 turn_id, session_id, message_id, receipt_json,
                 repository_root, terminal_snapshot_id, started_at, completed_at, terminal,
                 anchor_seq
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                 (SELECT COALESCE(MAX(seq) + 1, 0) FROM messages WHERE session_id = ?2))
             ON CONFLICT(turn_id) DO UPDATE SET
                 session_id = excluded.session_id,
                 message_id = excluded.message_id,
                 receipt_json = excluded.receipt_json,
                 repository_root = excluded.repository_root,
                 terminal_snapshot_id = excluded.terminal_snapshot_id,
                 started_at = excluded.started_at,
                 completed_at = excluded.completed_at,
                 terminal = excluded.terminal,
                 anchor_seq = COALESCE(turn_receipts.anchor_seq, excluded.anchor_seq)
             WHERE turn_receipts.terminal = 0 OR excluded.terminal = 1",
            params![
                receipt.turn_id,
                session_id,
                message_id,
                json,
                repository_root,
                terminal_snapshot_id,
                receipt.started_at,
                receipt.completed_at,
                if terminal { 1_i64 } else { 0_i64 },
            ],
        )?;
        Ok(())
    }

    pub fn get_turn_receipt(&self, turn_id: &str) -> Option<TurnReceiptRecord> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT session_id, message_id, receipt_json, repository_root,
                    terminal_snapshot_id
             FROM turn_receipts WHERE turn_id = ?1 AND terminal = 1",
            params![turn_id],
            |row| {
                let json: String = row.get(2)?;
                let receipt = serde_json::from_str(&json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                Ok(TurnReceiptRecord {
                    session_id: row.get(0)?,
                    message_id: row.get(1)?,
                    receipt,
                    repository_root: row.get(3)?,
                    terminal_snapshot_id: row.get(4)?,
                })
            },
        )
        .ok()
    }

    /// Test-only convenience wrapper that panics on failure. Production code calls
    /// `try_append_message` and propagates the error instead of fabricating an id.
    #[cfg(test)]
    pub fn append_message(&self, session_id: &str, msg: &ChatMessage, ts: i64) -> String {
        self.try_append_message(session_id, msg, ts)
            .expect("append_message: insert failed in test")
    }

    /// Canonical message list for feeding the model.
    pub fn load_chat_messages(&self, session_id: &str) -> Vec<ChatMessage> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) =
            conn.prepare("SELECT role, content FROM messages WHERE session_id = ?1 ORDER BY seq")
        else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![session_id], |r| {
            let role: String = r.get(0)?;
            let content: String = r.get(1)?;
            Ok((role, content))
        });
        let Ok(rows) = rows else { return Vec::new() };
        rows.filter_map(|res| res.ok())
            .map(|(role, content)| ChatMessage {
                role,
                content: serde_json::from_str(&content).unwrap_or_default(),
            })
            .collect()
    }

    /// Append-only catch-up delta for Phone Sync: every message in `session_id`
    /// whose `seq` is **strictly greater** than `after_seq`, in ascending `seq`
    /// order. Pass `after_seq = -1` to get the whole session (seq starts at 0).
    ///
    /// Backed by the `idx_messages_session(session_id, seq)` index. An unknown
    /// session yields an empty vec (not an error) — a reconnecting phone may ask
    /// about a session it doesn't yet know.
    pub fn messages_since(&self, session_id: &str, after_seq: i64) -> Vec<MessageRow> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare(
            "SELECT m.id, m.session_id, m.seq, m.role, m.content, m.created_at,
                    m.turn_id,
                    CASE WHEN m.turn_id IS NOT NULL AND m.seq = (
                        SELECT MAX(mx.seq) FROM messages mx WHERE mx.turn_id = m.turn_id
                    ) THEN tr.receipt_json END
             FROM messages m
             LEFT JOIN turn_receipts tr ON tr.turn_id = m.turn_id AND tr.terminal = 1
             WHERE m.session_id = ?1 AND m.seq > ?2 ORDER BY m.seq",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![session_id, after_seq], row_to_message);
        let Ok(rows) = rows else { return Vec::new() };
        rows.filter_map(|res| res.ok()).collect()
    }

    /// Append-only catch-up delta, BOUNDED to at most the last `limit` rows: every
    /// message in `session_id` whose `seq` is **strictly greater** than `after_seq`,
    /// keeping only the most-recent `limit` of them, returned in ascending `seq`
    /// order. Pass `after_seq = -1` for the tail of the whole session.
    ///
    /// This is the bounded counterpart of [`messages_since`](Self::messages_since):
    /// a long session would otherwise serialize its entire history into one frame,
    /// and the Noise transport caps a frame at ~65 KB, so an unbounded delta can
    /// fail to send. The catch-up serve path (`sync::session`) uses this with
    /// [`SYNC_CACHE_WINDOW`] so a client always gets a recent, send-safe window;
    /// older history is then fetched on demand via pagination ([`messages_page`]).
    ///
    /// SQL fetches the newest `limit` rows (`seq DESC LIMIT limit`) then reverses to
    /// ascending in Rust, so the result is the LAST `limit` rows, not the first.
    /// Backed by the `idx_messages_session(session_id, seq)` index. A non-positive
    /// `limit` or an unknown session yields an empty vec (not an error).
    pub fn messages_tail(&self, session_id: &str, after_seq: i64, limit: i64) -> Vec<MessageRow> {
        if limit <= 0 {
            return Vec::new();
        }
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare(
            "SELECT m.id, m.session_id, m.seq, m.role, m.content, m.created_at,
                    m.turn_id,
                    CASE WHEN m.turn_id IS NOT NULL AND m.seq = (
                        SELECT MAX(mx.seq) FROM messages mx WHERE mx.turn_id = m.turn_id
                    ) THEN tr.receipt_json END
             FROM messages m
             LEFT JOIN turn_receipts tr ON tr.turn_id = m.turn_id AND tr.terminal = 1
             WHERE m.session_id = ?1 AND m.seq > ?2 ORDER BY m.seq DESC LIMIT ?3",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![session_id, after_seq, limit], row_to_message);
        let Ok(rows) = rows else { return Vec::new() };
        let mut out: Vec<MessageRow> = rows.filter_map(|res| res.ok()).collect();
        // The query returned newest-first (so LIMIT keeps the tail); reverse to the
        // ascending seq order the wire frame expects.
        out.reverse();
        out
    }

    /// One page of OLDER history for scroll-up pagination: up to `limit` messages in
    /// `session_id` whose `seq` is **strictly less** than `before_seq`, in ascending
    /// `seq` order, plus a `has_more` flag that is true when at least one row exists
    /// older than the returned page's oldest seq (so the client knows to offer
    /// "load more"). Pass a `before_seq` larger than any held seq to page from the
    /// newest end.
    ///
    /// Implemented by fetching `limit + 1` newest-first rows below the cursor: if
    /// `limit + 1` came back there is an older row beyond this page (`has_more`), so
    /// we drop the extra and report true; otherwise this is the last page. The kept
    /// rows are reversed to ascending. A non-positive `limit` or an unknown session
    /// yields `(empty, false)`.
    pub fn messages_page(
        &self,
        session_id: &str,
        before_seq: i64,
        limit: i64,
    ) -> (Vec<MessageRow>, bool) {
        if limit <= 0 {
            return (Vec::new(), false);
        }
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare(
            "SELECT m.id, m.session_id, m.seq, m.role, m.content, m.created_at,
                    m.turn_id,
                    CASE WHEN m.turn_id IS NOT NULL AND m.seq = (
                        SELECT MAX(mx.seq) FROM messages mx WHERE mx.turn_id = m.turn_id
                    ) THEN tr.receipt_json END
             FROM messages m
             LEFT JOIN turn_receipts tr ON tr.turn_id = m.turn_id AND tr.terminal = 1
             WHERE m.session_id = ?1 AND m.seq < ?2 ORDER BY m.seq DESC LIMIT ?3",
        ) else {
            return (Vec::new(), false);
        };
        // Fetch one extra row to detect whether older history remains beyond this page.
        let probe = limit.saturating_add(1);
        let rows = stmt.query_map(params![session_id, before_seq, probe], row_to_message);
        let Ok(rows) = rows else {
            return (Vec::new(), false);
        };
        let mut out: Vec<MessageRow> = rows.filter_map(|res| res.ok()).collect();
        let has_more = out.len() as i64 > limit;
        if has_more {
            // Drop the probe row (the oldest of the newest-first batch) so the page is
            // exactly `limit` rows; its existence is what `has_more` records.
            out.truncate(limit as usize);
        }
        // Newest-first → ascending for the wire frame.
        out.reverse();
        (out, has_more)
    }

    /// Search message TEXT (user + assistant) for `query`, newest first, capped at
    /// `limit` hits. A LIKE pre-filter bounds the scan; each candidate's real block
    /// text is then extracted and re-checked so structural JSON matches (field names,
    /// tool I/O) never surface. ASCII-case-insensitive. A DB error degrades to an
    /// empty list rather than an error — search is best-effort, never a hard failure.
    pub fn search_messages(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        let trimmed = query.trim();
        if trimmed.is_empty() || limit == 0 {
            return Vec::new();
        }
        let needle = trimmed.to_ascii_lowercase();
        let like = format!("%{}%", escape_like(trimmed));
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, session_id, seq, role, content FROM messages
             WHERE content LIKE ?1 ESCAPE '\\'
             ORDER BY created_at DESC, seq DESC",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![like], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        });
        let Ok(rows) = rows else { return Vec::new() };
        let mut hits = Vec::new();
        for (id, session_id, seq, role, content) in rows.filter_map(|r| r.ok()) {
            // Only real conversation text is searchable — tool I/O is excluded so a
            // file dump or command output can't drown the results in noise.
            let blocks: Vec<Block> = serde_json::from_str(&content).unwrap_or_default();
            let text = blocks
                .iter()
                .filter_map(|b| match b {
                    Block::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(" ");
            if let Some(snippet) = search_snippet(&text, &needle) {
                hits.push(SearchHit {
                    session_id,
                    message_id: id,
                    seq,
                    role,
                    snippet,
                });
                if hits.len() >= limit {
                    break;
                }
            }
        }
        hits
    }

    // ── paired devices (Phone Sync) ──────────────────────────────────────────

    /// Record a paired device (or refresh an existing one's name/last_seen). The
    /// `public_key` (base64) is the device identity; re-pairing keeps the original
    /// `paired_at`. A brand-new row defaults to `confirmed = 0` (untrusted); the
    /// `ON CONFLICT` path deliberately leaves `confirmed` UNTOUCHED so a device the
    /// user already confirmed stays trusted across reconnects (and a known-but-
    /// unconfirmed device is never silently upgraded by a mere reconnect).
    pub fn add_paired_device(&self, public_key: &str, name: &str, ts: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO paired_devices (public_key, name, paired_at, last_seen, confirmed)
             VALUES (?1, ?2, ?3, ?3, 0)
             ON CONFLICT(public_key) DO UPDATE SET name = ?2, last_seen = ?3",
            params![public_key, name, ts],
        )?;
        Ok(())
    }

    /// Mark a device CONFIRMED-trusted (the desktop user compared its SAS and
    /// accepted it). Upserts so a confirm can land even if the row was not
    /// pre-inserted, keeping the original `paired_at` on conflict.
    pub fn confirm_paired_device(
        &self,
        public_key: &str,
        name: &str,
        ts: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO paired_devices (public_key, name, paired_at, last_seen, confirmed)
             VALUES (?1, ?2, ?3, ?3, 1)
             ON CONFLICT(public_key) DO UPDATE SET name = ?2, last_seen = ?3, confirmed = 1",
            params![public_key, name, ts],
        )?;
        Ok(())
    }

    /// Whether a device's static key is confirmed-trusted. The serve-time
    /// authorization check: only a `true` here lets a peer reach the command
    /// surface without a fresh desktop confirmation. A missing row or a DB read
    /// error both read as `false` (fail-closed).
    pub fn is_device_confirmed(&self, public_key: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT confirmed FROM paired_devices WHERE public_key = ?1",
            params![public_key],
            |r| r.get::<_, i64>(0),
        )
        .is_ok_and(|c| c != 0)
    }

    /// All paired devices, most recently paired first.
    pub fn list_paired_devices(&self) -> Vec<PairedDevice> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare(
            "SELECT public_key, name, paired_at, last_seen, confirmed
             FROM paired_devices ORDER BY paired_at DESC",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| {
            Ok(PairedDevice {
                public_key: r.get(0)?,
                name: r.get(1)?,
                paired_at: r.get(2)?,
                last_seen: r.get(3)?,
                confirmed: r.get::<_, i64>(4)? != 0,
            })
        });
        let Ok(rows) = rows else { return Vec::new() };
        rows.filter_map(|r| r.ok()).collect()
    }

    /// Forget a paired device. Idempotent.
    pub fn remove_paired_device(&self, public_key: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM paired_devices WHERE public_key = ?1",
            params![public_key],
        )?;
        Ok(())
    }

    /// Bump a device's `last_seen` (called when a sync session connects in Phase 2).
    pub fn touch_paired_device(&self, public_key: &str, ts: i64) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE paired_devices SET last_seen = ?2 WHERE public_key = ?1",
            params![public_key, ts],
        );
    }

    /// Truthful grouped view for the frontend (tool results folded under their
    /// assistant). SQL and row errors propagate; malformed legacy block/receipt
    /// JSON remains display-lenient for backwards compatibility.
    pub fn try_ui_messages(&self, session_id: &str) -> rusqlite::Result<Vec<UiMessage>> {
        self.require_session(session_id)?;
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.role, m.content, m.created_at, m.turn_id, tr.receipt_json
             FROM messages m
             LEFT JOIN turn_receipts tr ON tr.turn_id = m.turn_id AND tr.terminal = 1
             WHERE m.session_id = ?1 ORDER BY m.seq",
        )?;
        let rows = stmt.query_map(params![session_id], |r| {
            let id: String = r.get(0)?;
            let role: String = r.get(1)?;
            let content: String = r.get(2)?;
            let ts: i64 = r.get(3)?;
            let turn_id: Option<String> = r.get(4)?;
            let receipt = r
                .get::<_, Option<String>>(5)?
                .and_then(|json| serde_json::from_str::<TurnReceipt>(&json).ok());
            Ok((id, role, content, ts, turn_id, receipt))
        })?;

        let mut out: Vec<UiMessage> = Vec::new();
        let mut turn_assistants = HashMap::new();
        for row in rows {
            let (id, role, content, ts, turn_id, receipt) = row?;
            let blocks: Vec<Block> = serde_json::from_str(&content).unwrap_or_default();
            if let Some(turn_id) = turn_id {
                let tool_results: Vec<UiBlock> = blocks
                    .iter()
                    .filter(|block| matches!(block, Block::ToolResult { .. }))
                    .filter_map(to_ui_block)
                    .collect();
                let texts: Vec<UiBlock> = blocks
                    .iter()
                    .filter(|block| matches!(block, Block::Text { .. }))
                    .filter_map(to_ui_block)
                    .collect();

                if role == "assistant" {
                    let index = ensure_turn_assistant(
                        &mut out,
                        &mut turn_assistants,
                        &turn_id,
                        ts,
                        receipt.as_ref(),
                    );
                    out[index]
                        .blocks
                        .extend(blocks.iter().filter_map(to_ui_block));
                } else {
                    if !texts.is_empty() {
                        out.push(UiMessage {
                            id,
                            role: "user".into(),
                            blocks: texts,
                            created_at: ts,
                            turn_id: Some(turn_id.clone()),
                            receipt: None,
                        });
                    }
                    if !tool_results.is_empty() || receipt.is_some() {
                        let index = ensure_turn_assistant(
                            &mut out,
                            &mut turn_assistants,
                            &turn_id,
                            receipt.as_ref().map_or(ts, |value| value.started_at),
                            receipt.as_ref(),
                        );
                        out[index].blocks.extend(tool_results);
                    }
                }
                continue;
            }

            if role == "assistant" {
                out.push(UiMessage {
                    id,
                    role,
                    blocks: blocks.iter().filter_map(to_ui_block).collect(),
                    created_at: ts,
                    turn_id: None,
                    receipt: None,
                });
            } else {
                let tool_results: Vec<UiBlock> = blocks
                    .iter()
                    .filter(|b| matches!(b, Block::ToolResult { .. }))
                    .filter_map(to_ui_block)
                    .collect();
                if !tool_results.is_empty() {
                    if let Some(last) = out.last_mut() {
                        last.blocks.extend(tool_results);
                    }
                }
                let texts: Vec<UiBlock> = blocks
                    .iter()
                    .filter(|b| matches!(b, Block::Text { .. }))
                    .filter_map(to_ui_block)
                    .collect();
                if !texts.is_empty() {
                    out.push(UiMessage {
                        id,
                        role: "user".into(),
                        blocks: texts,
                        created_at: ts,
                        turn_id: None,
                        receipt: None,
                    });
                }
            }
        }

        // A provider/config failure can terminalize after the durable TurnStart but
        // before any canonical chat row is appended. Keep that receipt reloadable by
        // synthesizing the same empty assistant bubble live TurnStart created.
        let mut receipts = conn.prepare(
            "SELECT receipt_json FROM turn_receipts
             WHERE session_id = ?1 AND terminal = 1
             ORDER BY anchor_seq, started_at, turn_id",
        )?;
        let records = receipts.query_map(params![session_id], |row| {
            let json: String = row.get(0)?;
            Ok(serde_json::from_str::<TurnReceipt>(&json).ok())
        })?;
        for row in records {
            let Some(receipt) = row? else { continue };
            if turn_assistants.contains_key(&receipt.turn_id) {
                continue;
            }
            let index = out
                .iter()
                .position(|message| message.created_at > receipt.started_at)
                .unwrap_or(out.len());
            out.insert(
                index,
                UiMessage {
                    id: receipt.turn_id.clone(),
                    role: "assistant".into(),
                    blocks: Vec::new(),
                    created_at: receipt.started_at,
                    turn_id: Some(receipt.turn_id.clone()),
                    receipt: Some(receipt),
                },
            );
        }
        for message in &mut out {
            finalize_unmatched_ui_tools(&mut message.blocks);
        }
        Ok(out)
    }

    /// Legacy best-effort wrapper retained for Phone Sync tests and non-critical
    /// internal callers. New Tauri history commands use `try_ui_messages`.
    pub fn ui_messages(&self, session_id: &str) -> Vec<UiMessage> {
        self.try_ui_messages(session_id).unwrap_or_default()
    }

    /// Newest-first cursor paging over a bounded SQL timeline. The base window is
    /// 100 persisted events; only the oldest boundary may expand so one logical
    /// turn, legacy tool owner/result pair, or same-anchor receipt group is never
    /// split between pages.
    pub fn try_ui_message_page(
        &self,
        session_id: &str,
        cursor: Option<&str>,
    ) -> rusqlite::Result<UiMessagePage> {
        self.require_session(session_id)?;
        let decoded = cursor
            .map(|value| decode_ui_cursor(session_id, value))
            .transpose()?;
        let has_cursor = i64::from(decoded.is_some());
        let upper_anchor = decoded.as_ref().map_or(i64::MAX, |value| value.anchor_seq);
        let upper_rank = decoded.as_ref().map_or(i64::MAX, |value| value.rank);
        let upper_tie = decoded
            .as_ref()
            .map_or_else(String::new, |value| value.tie.clone());

        let conn = self.conn.lock().unwrap();
        let timeline = "WITH timeline(kind, anchor_seq, rank, tie, turn_id, role, content) AS (
                 SELECT 'message', m.seq, 1, m.id, m.turn_id, m.role, m.content
                 FROM messages m WHERE m.session_id = ?1
                 UNION ALL
                 SELECT 'receipt', tr.anchor_seq, 0, tr.turn_id, tr.turn_id,
                        'assistant', '[]'
                 FROM turn_receipts tr
                 WHERE tr.session_id = ?1 AND tr.terminal = 1
                   AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.turn_id = tr.turn_id)
             )";
        let key_sql = format!(
            "{timeline}
             SELECT kind, anchor_seq, rank, tie, turn_id, role, content
             FROM timeline
             WHERE ?2 = 0 OR anchor_seq < ?3
                OR (anchor_seq = ?3 AND rank < ?4)
                OR (anchor_seq = ?3 AND rank = ?4 AND tie < ?5)
             ORDER BY anchor_seq DESC, rank DESC, tie DESC LIMIT ?6"
        );
        let mut key_stmt = conn.prepare(&key_sql)?;
        let key_rows = key_stmt.query_map(
            params![
                session_id,
                has_cursor,
                upper_anchor,
                upper_rank,
                upper_tie,
                (UI_MESSAGE_PAGE_SIZE + 1) as i64
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )?;
        let mut keys = key_rows.collect::<rusqlite::Result<Vec<_>>>()?;
        if keys.is_empty() {
            return Ok(UiMessagePage {
                messages: Vec::new(),
                next_cursor: None,
            });
        }
        keys.truncate(UI_MESSAGE_PAGE_SIZE);
        let oldest = keys.last().expect("non-empty timeline window");
        let mut start_anchor = oldest.1;

        // A turn can span many persisted rows. Expand to its first row so the
        // display fold never creates a partial assistant/tool group.
        if let Some(turn_id) = oldest.4.as_deref() {
            if let Some(first) = conn.query_row(
                "SELECT MIN(seq) FROM messages WHERE session_id = ?1 AND turn_id = ?2",
                params![session_id, turn_id],
                |row| row.get::<_, Option<i64>>(0),
            )? {
                start_anchor = start_anchor.min(first);
            }
        } else if oldest.0 == "message" && oldest.5 != "assistant" {
            let blocks: Vec<Block> = serde_json::from_str(&oldest.6).unwrap_or_default();
            if blocks
                .iter()
                .any(|block| matches!(block, Block::ToolResult { .. }))
            {
                if let Some(owner) = conn.query_row(
                    "SELECT MAX(seq) FROM messages WHERE session_id = ?1 AND seq < ?2",
                    params![session_id, start_anchor],
                    |row| row.get::<_, Option<i64>>(0),
                )? {
                    start_anchor = owner;
                }
            }
        }

        let data_sql = "WITH timeline(kind, anchor_seq, rank, tie, id, role, content, created_at,
                            turn_id, receipt_json) AS (
                 SELECT 'message', m.seq, 1, m.id, m.id, m.role, m.content,
                        m.created_at, m.turn_id, tr.receipt_json
                 FROM messages m
                 LEFT JOIN turn_receipts tr
                   ON tr.turn_id = m.turn_id AND tr.terminal = 1
                 WHERE m.session_id = ?1
                 UNION ALL
                 SELECT 'receipt', tr.anchor_seq, 0, tr.turn_id, tr.turn_id,
                        'assistant', '[]', tr.started_at, tr.turn_id, tr.receipt_json
                 FROM turn_receipts tr
                 WHERE tr.session_id = ?1 AND tr.terminal = 1
                   AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.turn_id = tr.turn_id)
             )
             SELECT kind, id, role, content, created_at, turn_id, receipt_json
             FROM timeline
             WHERE anchor_seq >= ?6 AND (
                    ?2 = 0 OR anchor_seq < ?3
                    OR (anchor_seq = ?3 AND rank < ?4)
                    OR (anchor_seq = ?3 AND rank = ?4 AND tie < ?5)
             )
             ORDER BY anchor_seq, rank, tie";
        let mut data_stmt = conn.prepare(data_sql)?;
        let rows = data_stmt.query_map(
            params![
                session_id,
                has_cursor,
                upper_anchor,
                upper_rank,
                upper_tie,
                start_anchor
            ],
            |row| {
                let receipt = row
                    .get::<_, Option<String>>(6)?
                    .and_then(|json| serde_json::from_str::<TurnReceipt>(&json).ok());
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    receipt,
                ))
            },
        )?;

        let mut out = Vec::new();
        let mut turn_assistants = HashMap::new();
        for row in rows {
            let (kind, id, role, content, ts, turn_id, receipt) = row?;
            if kind == "receipt" {
                let turn_id = turn_id.expect("receipt timeline event has turn id");
                ensure_turn_assistant(
                    &mut out,
                    &mut turn_assistants,
                    &turn_id,
                    ts,
                    receipt.as_ref(),
                );
                continue;
            }
            let blocks: Vec<Block> = serde_json::from_str(&content).unwrap_or_default();
            if let Some(turn_id) = turn_id {
                let tool_results: Vec<UiBlock> = blocks
                    .iter()
                    .filter(|block| matches!(block, Block::ToolResult { .. }))
                    .filter_map(to_ui_block)
                    .collect();
                let texts: Vec<UiBlock> = blocks
                    .iter()
                    .filter(|block| matches!(block, Block::Text { .. }))
                    .filter_map(to_ui_block)
                    .collect();
                if role == "assistant" {
                    let index = ensure_turn_assistant(
                        &mut out,
                        &mut turn_assistants,
                        &turn_id,
                        ts,
                        receipt.as_ref(),
                    );
                    out[index]
                        .blocks
                        .extend(blocks.iter().filter_map(to_ui_block));
                } else {
                    if !texts.is_empty() {
                        out.push(UiMessage {
                            id,
                            role: "user".into(),
                            blocks: texts,
                            created_at: ts,
                            turn_id: Some(turn_id.clone()),
                            receipt: None,
                        });
                    }
                    if !tool_results.is_empty() || receipt.is_some() {
                        let index = ensure_turn_assistant(
                            &mut out,
                            &mut turn_assistants,
                            &turn_id,
                            receipt.as_ref().map_or(ts, |value| value.started_at),
                            receipt.as_ref(),
                        );
                        out[index].blocks.extend(tool_results);
                    }
                }
            } else if role == "assistant" {
                out.push(UiMessage {
                    id,
                    role,
                    blocks: blocks.iter().filter_map(to_ui_block).collect(),
                    created_at: ts,
                    turn_id: None,
                    receipt: None,
                });
            } else {
                let tool_results: Vec<UiBlock> = blocks
                    .iter()
                    .filter(|block| matches!(block, Block::ToolResult { .. }))
                    .filter_map(to_ui_block)
                    .collect();
                if !tool_results.is_empty() {
                    if let Some(last) = out.last_mut() {
                        last.blocks.extend(tool_results);
                    }
                }
                let texts: Vec<UiBlock> = blocks
                    .iter()
                    .filter(|block| matches!(block, Block::Text { .. }))
                    .filter_map(to_ui_block)
                    .collect();
                if !texts.is_empty() {
                    out.push(UiMessage {
                        id,
                        role: "user".into(),
                        blocks: texts,
                        created_at: ts,
                        turn_id: None,
                        receipt: None,
                    });
                }
            }
        }
        for message in &mut out {
            finalize_unmatched_ui_tools(&mut message.blocks);
        }

        let has_older = conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM messages WHERE session_id = ?1 AND seq < ?2
                 UNION ALL
                 SELECT 1 FROM turn_receipts tr
                 WHERE tr.session_id = ?1 AND tr.terminal = 1 AND tr.anchor_seq < ?2
                   AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.turn_id = tr.turn_id)
             )",
            params![session_id, start_anchor],
            |row| row.get::<_, i64>(0),
        )? != 0;
        let next_cursor = if has_older {
            Some(encode_ui_cursor(session_id, start_anchor, 0, "")?)
        } else {
            None
        };
        Ok(UiMessagePage {
            messages: out,
            next_cursor,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portcode_sync::wire::{TurnChangeCertainty, TurnStatus};
    use serde_json::json;
    use std::path::PathBuf;

    fn mem_db() -> Db {
        Db::open(Path::new(":memory:")).expect("in-memory db")
    }

    fn text(t: &str) -> ChatMessage {
        ChatMessage {
            role: "user".into(),
            content: vec![Block::Text { text: t.into() }],
        }
    }

    fn assistant(t: &str) -> ChatMessage {
        ChatMessage {
            role: "assistant".into(),
            content: vec![Block::Text { text: t.into() }],
        }
    }

    fn receipt(turn_id: &str) -> TurnReceipt {
        TurnReceipt {
            turn_id: turn_id.into(),
            status: TurnStatus::Completed,
            stop_reason: Some("end_turn".into()),
            started_at: 2,
            completed_at: 9,
            duration_ms: Some(7),
            changed_files: Vec::new(),
            changed_file_count: 0,
            additions: 0,
            deletions: 0,
            files_truncated: false,
            change_certainty: TurnChangeCertainty::Exact,
            background_tasks_running: false,
        }
    }

    #[test]
    fn now_ms_returns_a_recent_unix_millis() {
        let t = now_ms();
        assert!(t > 1_577_836_800_000, "now_ms too small: {t}"); // > 2020-01-01
        assert!(t < 4_102_444_800_000, "now_ms too large: {t}"); // < 2100-01-01
    }

    #[test]
    fn to_ui_block_maps_each_variant_with_the_camelcase_serde_shape() {
        assert_eq!(
            serde_json::to_value(to_ui_block(&Block::Text { text: "hi".into() }).unwrap()).unwrap(),
            json!({ "kind": "text", "text": "hi" })
        );
        assert_eq!(
            serde_json::to_value(
                to_ui_block(&Block::ToolUse {
                    id: "t1".into(),
                    name: "fs_read".into(),
                    input: json!({ "path": "x" }),
                })
                .unwrap()
            )
            .unwrap(),
            json!({ "kind": "tool_use", "id": "t1", "name": "fs_read", "input": { "path": "x" } })
        );
        assert_eq!(
            serde_json::to_value(
                to_ui_block(&Block::ToolResult {
                    tool_use_id: "t1".into(),
                    content: "ok".into(),
                    is_error: true,
                })
                .unwrap()
            )
            .unwrap(),
            json!({ "kind": "tool_result", "toolUseId": "t1", "output": "ok", "isError": true })
        );
        assert!(to_ui_block(&Block::Reasoning {
            model: Some("gpt-5.6-sol".into()),
            id: Some("r1".into()),
            encrypted_content: Some("opaque".into()),
            summary: Vec::new(),
        })
        .is_none());
    }

    #[test]
    fn create_and_list_sessions_orders_by_updated_at_desc() {
        let db = mem_db();
        db.create_session("a", "Alpha", None, None, 100).unwrap();
        db.create_session("b", "Beta", Some("C:/ws"), None, 200)
            .unwrap();
        let rows = db.list_sessions().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "b"); // newer updated_at first
        assert_eq!(rows[0].workspace.as_deref(), Some("C:/ws"));
        assert_eq!(rows[1].workspace, None);
        // A non-existent workspace path resolves to no branch (not an error).
        assert_eq!(rows[0].branch, None);
    }

    #[test]
    fn legacy_session_model_migrates_and_selected_model_round_trips() {
        // Simulate the sessions table from before per-session models. Migration is
        // additive: the conversation row survives, reads as no explicit model, and
        // can then persist a selection that list_sessions returns after a reload.
        let conn = Connection::open(Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                workspace TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO sessions (id, title, workspace, created_at, updated_at)
            VALUES ('legacy', 'Kept chat', NULL, 10, 20);",
        )
        .unwrap();

        Db::migrate_add_model(&conn).unwrap();
        Db::migrate_add_model(&conn).unwrap(); // idempotent on every later launch
        let db = Db {
            conn: Mutex::new(conn),
        };

        let before = db.list_sessions().unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].title, "Kept chat");
        assert_eq!(before[0].model, None);

        db.update_session_model("legacy", "gpt-5.6-sol").unwrap();
        let after = db.list_sessions().unwrap();
        assert_eq!(after[0].model.as_deref(), Some("gpt-5.6-sol"));
    }

    #[test]
    fn legacy_messages_gain_nullable_turn_id_without_rewriting_rows() {
        let conn = Connection::open(Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            INSERT INTO messages (id, session_id, seq, role, content, created_at)
            VALUES ('legacy-message', 'legacy-session', 0, 'user', '[]', 1);",
        )
        .unwrap();

        Db::migrate_add_turn_id(&conn).unwrap();
        Db::migrate_add_turn_id(&conn).unwrap();
        let turn_id: Option<String> = conn
            .query_row(
                "SELECT turn_id FROM messages WHERE id = 'legacy-message'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(turn_id.is_none());
    }

    #[test]
    fn legacy_receipts_without_pending_column_migrate_as_terminal() {
        let conn = Connection::open(Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "CREATE TABLE turn_receipts (
                turn_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                receipt_json TEXT NOT NULL,
                repository_root TEXT,
                terminal_snapshot_id TEXT,
                started_at INTEGER NOT NULL,
                completed_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO turn_receipts (
                turn_id, session_id, message_id, receipt_json, started_at, completed_at
             ) VALUES ('legacy-turn', 's', 'legacy-turn', ?1, 1, 2)",
            params![serde_json::to_string(&receipt("legacy-turn")).unwrap()],
        )
        .unwrap();

        Db::migrate_add_receipt_terminal(&conn).unwrap();
        Db::migrate_add_receipt_terminal(&conn).unwrap();
        let terminal: i64 = conn
            .query_row(
                "SELECT terminal FROM turn_receipts WHERE turn_id = 'legacy-turn'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(terminal, 1);
    }

    #[test]
    fn update_session_model_errors_when_session_is_missing_or_deleted() {
        let db = mem_db();
        assert!(matches!(
            db.update_session_model("missing", "gpt-5.6-sol"),
            Err(rusqlite::Error::QueryReturnedNoRows)
        ));

        db.create_session("deleted", "Deleted", None, None, 1)
            .unwrap();
        db.delete_session("deleted").unwrap();
        assert!(matches!(
            db.update_session_model("deleted", "gpt-5.6-sol"),
            Err(rusqlite::Error::QueryReturnedNoRows)
        ));
    }

    #[test]
    fn workspace_lookup_distinguishes_unknown_unset_and_configured_sessions() {
        let db = mem_db();
        assert_eq!(db.workspace_for_session("missing").unwrap(), None);

        db.create_session("local", "Local", None, None, 1).unwrap();
        assert_eq!(db.workspace_for_session("local").unwrap(), Some(None));

        db.create_session("work", "Work", Some("C:/work/portcode"), None, 2)
            .unwrap();
        assert_eq!(
            db.workspace_for_session("work").unwrap(),
            Some(Some("C:/work/portcode".into()))
        );
    }

    #[test]
    fn git_branch_reads_head_ref_and_handles_detached() {
        // A repo whose HEAD points at a branch resolves to that branch name.
        let dir = std::env::temp_dir().join(format!("pc_branch_{}", now_ms()));
        let git = dir.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/feature/x\n").unwrap();
        let ws = dir.to_str().unwrap();
        assert_eq!(git_branch(Some(ws)).as_deref(), Some("feature/x"));

        // A detached HEAD (a raw commit SHA) has no branch.
        std::fs::write(
            git.join("HEAD"),
            "0123456789abcdef0123456789abcdef01234567\n",
        )
        .unwrap();
        assert_eq!(git_branch(Some(ws)), None);

        // No workspace, and a path that isn't a repo, both yield None.
        assert_eq!(git_branch(None), None);
        assert_eq!(git_branch(Some("/portcode/definitely/not/a/repo")), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_touch_and_set_title_if_blank_behave() {
        let db = mem_db();
        db.create_session("a", "New chat", None, None, 100).unwrap();

        db.rename_session("a", "Renamed").unwrap();
        assert_eq!(db.list_sessions().unwrap()[0].title, "Renamed");

        db.touch_session("a", 500);
        assert_eq!(db.list_sessions().unwrap()[0].updated_at, 500);

        // only overwrites a blank / "New chat" title — not a real one
        db.set_title_if_blank("a", "should not apply");
        assert_eq!(db.list_sessions().unwrap()[0].title, "Renamed");

        db.create_session("b", "New chat", None, None, 50).unwrap();
        db.set_title_if_blank("b", "Derived");
        let b = db
            .list_sessions()
            .unwrap()
            .into_iter()
            .find(|s| s.id == "b")
            .unwrap();
        assert_eq!(b.title, "Derived");
    }

    #[test]
    fn delete_session_removes_it_and_its_messages() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        db.append_message("a", &text("hi"), 2);
        db.delete_session("a").unwrap();
        assert!(db.list_sessions().unwrap().is_empty());
        assert!(db.load_chat_messages("a").is_empty());
    }

    #[test]
    fn search_messages_finds_text_newest_first_with_snippets() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        db.create_session("b", "B", None, None, 1).unwrap();
        db.append_message("a", &text("let's refactor the parser today"), 10);
        db.append_message("b", &assistant("the PARSER lives in llm.rs"), 20);

        let hits = db.search_messages("parser", 50);
        assert_eq!(hits.len(), 2);
        // created_at DESC: "b" (ts 20) precedes "a" (ts 10).
        assert_eq!(hits[0].session_id, "b");
        assert_eq!(hits[0].role, "assistant");
        assert_eq!(hits[1].session_id, "a");
        // ASCII-case-insensitive, and the snippet carries the matched text.
        assert!(hits[0].snippet.to_lowercase().contains("parser"));
    }

    #[test]
    fn search_messages_ignores_tool_io_and_structural_json() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        // Only real conversation TEXT is searchable: a tool call's name, its input,
        // and its output must NOT match, and the serialized block tag ("tool_use")
        // must not register as a hit even though it's present in the stored JSON.
        db.append_message(
            "a",
            &ChatMessage {
                role: "assistant".into(),
                content: vec![
                    Block::ToolUse {
                        id: "t1".into(),
                        name: "grep".into(),
                        input: json!({ "pattern": "needle_in_tool" }),
                    },
                    Block::ToolResult {
                        tool_use_id: "t1".into(),
                        content: "secret_output_token".into(),
                        is_error: false,
                    },
                ],
            },
            5,
        );
        assert!(db.search_messages("needle_in_tool", 50).is_empty());
        assert!(db.search_messages("secret_output_token", 50).is_empty());
        assert!(db.search_messages("tool_use", 50).is_empty());
    }

    #[test]
    fn search_messages_respects_limit_and_empty_query() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        for i in 0..5_i64 {
            db.append_message("a", &text(&format!("match number {i}")), 10 + i);
        }
        assert_eq!(db.search_messages("match", 3).len(), 3);
        assert!(db.search_messages("   ", 50).is_empty());
        assert!(db.search_messages("match", 0).is_empty());
        assert!(db.search_messages("no_such_term", 50).is_empty());
    }

    #[test]
    fn search_messages_treats_like_wildcards_literally() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        db.append_message("a", &text("progress is 50% done"), 10);
        db.append_message("a", &text("a plain sentence"), 11);
        // The "%" is a literal here, not a LIKE wildcard — only the first message hits.
        let hits = db.search_messages("50%", 50);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].seq, 0);
        assert!(hits[0].snippet.contains("50%"));
    }

    #[test]
    fn append_and_load_chat_messages_round_trips_in_seq_order() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        db.append_message("a", &text("one"), 2);
        db.append_message(
            "a",
            &ChatMessage {
                role: "assistant".into(),
                content: vec![Block::Text { text: "two".into() }],
            },
            3,
        );
        let msgs = db.load_chat_messages("a");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[1].role, "assistant");
        assert!(matches!(&msgs[0].content[0], Block::Text { text } if text == "one"));
    }

    #[test]
    fn ui_messages_folds_tool_results_under_the_requesting_assistant() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        db.append_message("a", &text("do it"), 2);
        db.append_message(
            "a",
            &ChatMessage {
                role: "assistant".into(),
                content: vec![Block::ToolUse {
                    id: "t1".into(),
                    name: "fs_read".into(),
                    input: json!({}),
                }],
            },
            3,
        );
        // a tool result arrives as a "user"-role message; it must fold under the assistant
        db.append_message(
            "a",
            &ChatMessage {
                role: "user".into(),
                content: vec![Block::ToolResult {
                    tool_use_id: "t1".into(),
                    content: "file".into(),
                    is_error: false,
                }],
            },
            4,
        );

        let ui = db.ui_messages("a");
        assert_eq!(ui.len(), 2); // user text, then assistant (with the result folded in)
        let assistant = serde_json::to_value(&ui[1]).unwrap();
        assert_eq!(assistant["role"], "assistant");
        let blocks = assistant["blocks"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["kind"], "tool_use");
        assert_eq!(blocks[1]["kind"], "tool_result");
    }

    #[test]
    fn turn_rows_reload_as_one_live_shaped_assistant_and_replicate_receipt_once() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        let turn_id = "turn-1";
        db.try_append_message_for_turn("a", Some(turn_id), &text("do it"), 2)
            .unwrap();
        db.try_append_message_for_turn(
            "a",
            Some(turn_id),
            &ChatMessage {
                role: "assistant".into(),
                content: vec![Block::ToolUse {
                    id: "tool-1".into(),
                    name: "write_file".into(),
                    input: json!({ "path": "a.txt" }),
                }],
            },
            3,
        )
        .unwrap();
        db.try_append_message_for_turn(
            "a",
            Some(turn_id),
            &ChatMessage {
                role: "user".into(),
                content: vec![Block::ToolResult {
                    tool_use_id: "tool-1".into(),
                    content: "ok".into(),
                    is_error: false,
                }],
            },
            4,
        )
        .unwrap();
        db.try_append_message_for_turn("a", Some(turn_id), &assistant("done"), 5)
            .unwrap();
        let receipt = receipt(turn_id);
        db.save_turn_receipt("a", turn_id, &receipt, Some("repo"), Some("snap"))
            .unwrap();

        let ui = db.ui_messages("a");
        assert_eq!(ui.len(), 2);
        assert_eq!(ui[1].id, turn_id);
        assert_eq!(ui[1].turn_id.as_deref(), Some(turn_id));
        assert_eq!(ui[1].blocks.len(), 3);
        assert_eq!(ui[1].receipt.as_ref(), Some(&receipt));

        let replicated = db.messages_since("a", -1);
        assert!(replicated
            .iter()
            .all(|message| message.turn_id.as_deref() == Some(turn_id)));
        assert_eq!(
            replicated
                .iter()
                .filter(|message| message.receipt.is_some())
                .count(),
            1
        );
        assert_eq!(replicated.last().unwrap().receipt.as_ref(), Some(&receipt));
    }

    #[test]
    fn deleting_session_removes_its_turn_receipts() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        let receipt = receipt("turn-delete");
        db.save_turn_receipt("a", "turn-delete", &receipt, None, None)
            .unwrap();
        assert!(db.get_turn_receipt("turn-delete").is_some());
        db.delete_session("a").unwrap();
        assert!(db.get_turn_receipt("turn-delete").is_none());
    }

    #[test]
    fn receipt_without_canonical_messages_still_reloads_as_assistant_bubble() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        let receipt = receipt("preflight-turn");
        db.save_turn_receipt("a", "preflight-turn", &receipt, None, None)
            .unwrap();

        let ui = db.ui_messages("a");
        assert_eq!(ui.len(), 1);
        assert_eq!(ui[0].id, "preflight-turn");
        assert_eq!(ui[0].role, "assistant");
        assert_eq!(ui[0].receipt.as_ref(), Some(&receipt));
    }

    #[test]
    fn pending_receipt_is_hidden_from_reload_phone_and_review_lookup() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        db.try_append_message_for_turn("a", Some("pending-turn"), &text("working"), 2)
            .unwrap();
        db.save_pending_turn_receipt("a", "pending-turn", &receipt("pending-turn"))
            .unwrap();

        assert!(db.get_turn_receipt("pending-turn").is_none());
        let ui = db.ui_messages("a");
        assert_eq!(ui.len(), 1);
        assert_eq!(ui[0].role, "user");
        assert!(ui.iter().all(|message| message.receipt.is_none()));
        assert!(db
            .messages_since("a", -1)
            .iter()
            .all(|message| message.receipt.is_none()));
    }

    #[test]
    fn startup_recovers_pending_receipt_as_unknown_duration_interruption() {
        let path = std::env::temp_dir().join(format!(
            "portcode_pending_receipt_{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        {
            let db = Db::open(&path).unwrap();
            db.create_session("a", "A", None, None, 1).unwrap();
            db.try_append_message_for_turn("a", Some("crashed-turn"), &text("working"), 2)
                .unwrap();
            db.save_pending_turn_receipt("a", "crashed-turn", &receipt("crashed-turn"))
                .unwrap();
            assert!(db.get_turn_receipt("crashed-turn").is_none());
        }

        let recovered = Db::open(&path).unwrap();
        let record = recovered
            .get_turn_receipt("crashed-turn")
            .expect("startup terminalizes the pending row");
        assert_eq!(record.receipt.status, TurnStatus::Interrupted);
        assert_eq!(
            record.receipt.stop_reason.as_deref(),
            Some("process_interrupted")
        );
        assert_eq!(record.receipt.duration_ms, None);
        assert_eq!(
            record.receipt.change_certainty,
            TurnChangeCertainty::Unavailable
        );
        assert!(recovered
            .ui_messages("a")
            .iter()
            .any(|message| message.receipt.as_ref() == Some(&record.receipt)));
        drop(recovered);
        for candidate in [
            path.clone(),
            PathBuf::from(format!("{}-wal", path.display())),
            PathBuf::from(format!("{}-shm", path.display())),
        ] {
            let _ = std::fs::remove_file(candidate);
        }
    }

    // ── messages_since: the Phone Sync catch-up delta ────────────────────────
    // Invariants protected here (ruflo tester, Phase 0 review): full pull,
    // strictly-greater boundary, up-to-date emptiness, ascending order, and
    // per-session isolation.

    #[test]
    fn ui_messages_terminalizes_an_unmatched_historical_tool_after_reload() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        db.append_message(
            "a",
            &ChatMessage {
                role: "assistant".into(),
                content: vec![Block::ToolUse {
                    id: "orphan".into(),
                    name: "shell".into(),
                    input: json!({ "command": "long task" }),
                }],
            },
            2,
        );

        let ui = db.ui_messages("a");
        let assistant = serde_json::to_value(&ui[0]).unwrap();
        let blocks = assistant["blocks"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[1]["kind"], "tool_result");
        assert_eq!(blocks[1]["toolUseId"], "orphan");
        assert_eq!(blocks[1]["isError"], true);
        assert!(blocks[1]["output"]
            .as_str()
            .unwrap()
            .starts_with("Interrupted:"));
    }

    #[test]
    fn messages_since_minus_one_returns_all_rows() {
        let db = mem_db();
        db.create_session("s", "S", None, None, 1).unwrap();
        db.append_message("s", &text("first"), 2);
        db.append_message("s", &assistant("second"), 3);
        db.append_message("s", &text("third"), 4);

        let rows = db.messages_since("s", -1);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].seq, 0); // seq starts at 0
        assert_eq!(rows[0].session_id, "s");
    }

    #[test]
    fn messages_since_returns_only_rows_strictly_after_the_cursor() {
        let db = mem_db();
        db.create_session("s", "S", None, None, 1).unwrap();
        db.append_message("s", &text("msg0"), 2);
        db.append_message("s", &text("msg1"), 3);
        db.append_message("s", &text("msg2"), 4);

        // after_seq=0 must return seq 1 and 2, NOT seq 0 (boundary is `>`, not `>=`)
        let rows = db.messages_since("s", 0);
        let seqs: Vec<i64> = rows.iter().map(|r| r.seq).collect();
        assert_eq!(seqs, [1, 2]);
    }

    #[test]
    fn messages_since_highest_seq_returns_empty() {
        let db = mem_db();
        db.create_session("s", "S", None, None, 1).unwrap();
        db.append_message("s", &text("only"), 2);

        // 0 is the only/highest seq, so an up-to-date phone gets nothing back.
        assert!(db.messages_since("s", 0).is_empty());
    }

    #[test]
    fn messages_since_returns_rows_in_ascending_seq_order() {
        let db = mem_db();
        db.create_session("s", "S", None, None, 1).unwrap();
        db.append_message("s", &text("a"), 2);
        db.append_message("s", &assistant("b"), 3);
        db.append_message("s", &text("c"), 4);

        let seqs: Vec<i64> = db.messages_since("s", -1).iter().map(|r| r.seq).collect();
        assert_eq!(seqs, [0, 1, 2]);
    }

    #[test]
    fn messages_since_is_isolated_between_sessions() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        db.create_session("b", "B", None, None, 1).unwrap();
        db.append_message("a", &text("in a"), 2);
        db.append_message("b", &text("in b"), 3);

        let rows_a = db.messages_since("a", -1);
        assert_eq!(rows_a.len(), 1);
        assert_eq!(rows_a[0].session_id, "a");
        assert_eq!(db.messages_since("b", -1).len(), 1);
    }

    #[test]
    fn messages_since_unknown_session_returns_empty_not_error() {
        let db = mem_db();
        assert!(db.messages_since("no-such-session", -1).is_empty());
    }

    #[test]
    fn messages_since_parses_content_back_into_typed_blocks() {
        // Protects the SyncFrame::MessageDelta payload: content stored by
        // append_message must re-read as the same Block variant.
        let db = mem_db();
        db.create_session("s", "S", None, None, 1).unwrap();
        db.append_message("s", &assistant("hello phone"), 2);

        let rows = db.messages_since("s", -1);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "assistant");
        assert!(matches!(&rows[0].content[0], Block::Text { text } if text == "hello phone"));
    }

    // ── messages_tail: the BOUNDED catch-up window (7a) ──────────────────────
    // Invariants: at most N rows, the MOST RECENT N (not the oldest), ascending
    // order, per-session isolation, and unknown session → empty.

    #[test]
    fn messages_tail_caps_at_the_limit_and_keeps_the_most_recent_rows() {
        let db = mem_db();
        db.create_session("s", "S", None, None, 1).unwrap();
        for i in 0..10 {
            db.append_message("s", &text(&format!("m{i}")), 100 + i); // seq 0..9
        }
        // Full tail from -1, capped to the last 3 rows (seq 7, 8, 9), ascending.
        let rows = db.messages_tail("s", -1, 3);
        let seqs: Vec<i64> = rows.iter().map(|r| r.seq).collect();
        assert_eq!(seqs, [7, 8, 9]);
    }

    #[test]
    fn messages_tail_returns_all_rows_when_under_the_limit() {
        let db = mem_db();
        db.create_session("s", "S", None, None, 1).unwrap();
        db.append_message("s", &text("a"), 100); // seq 0
        db.append_message("s", &assistant("b"), 101); // seq 1

        let seqs: Vec<i64> = db
            .messages_tail("s", -1, 50)
            .iter()
            .map(|r| r.seq)
            .collect();
        assert_eq!(seqs, [0, 1]); // fewer than the limit → all, still ascending
    }

    #[test]
    fn messages_tail_honors_the_after_seq_cursor() {
        let db = mem_db();
        db.create_session("s", "S", None, None, 1).unwrap();
        for i in 0..6 {
            db.append_message("s", &text(&format!("m{i}")), 100 + i); // seq 0..5
        }
        // Only rows strictly after seq 2 (3,4,5), capped to the last 2 (4,5).
        let seqs: Vec<i64> = db.messages_tail("s", 2, 2).iter().map(|r| r.seq).collect();
        assert_eq!(seqs, [4, 5]);
    }

    #[test]
    fn messages_tail_is_isolated_per_session_and_empty_for_unknown_or_nonpositive_limit() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        db.create_session("b", "B", None, None, 1).unwrap();
        db.append_message("a", &text("in a"), 2);
        db.append_message("b", &text("in b"), 3);

        assert_eq!(db.messages_tail("a", -1, 10).len(), 1);
        assert_eq!(db.messages_tail("a", -1, 10)[0].session_id, "a");
        // Unknown session → empty (a reconnecting client may ask about an unknown id).
        assert!(db.messages_tail("no-such", -1, 10).is_empty());
        // A non-positive limit yields nothing rather than an error or all rows.
        assert!(db.messages_tail("a", -1, 0).is_empty());
        assert!(db.messages_tail("a", -1, -5).is_empty());
    }

    // ── messages_page: scroll-up pagination (7b) ─────────────────────────────
    // Invariants: rows strictly BEFORE the cursor, the most-recent page first call,
    // has_more true/false at the boundaries, ascending order, unknown → empty.

    #[test]
    fn messages_page_returns_the_most_recent_page_below_the_cursor_ascending() {
        let db = mem_db();
        db.create_session("s", "S", None, None, 1).unwrap();
        for i in 0..10 {
            db.append_message("s", &text(&format!("m{i}")), 100 + i); // seq 0..9
        }
        // Page from above the newest seq: the last 3 rows (7,8,9) ascending, and
        // there is older history → has_more.
        let (rows, has_more) = db.messages_page("s", 1_000, 3);
        let seqs: Vec<i64> = rows.iter().map(|r| r.seq).collect();
        assert_eq!(seqs, [7, 8, 9]);
        assert!(has_more);
    }

    #[test]
    fn messages_page_walks_older_pages_via_the_returned_cursor() {
        let db = mem_db();
        db.create_session("s", "S", None, None, 1).unwrap();
        for i in 0..5 {
            db.append_message("s", &text(&format!("m{i}")), 100 + i); // seq 0..4
        }
        // First (newest) page below seq 5 → 3,4 with more behind.
        let (p1, more1) = db.messages_page("s", 5, 2);
        assert_eq!(p1.iter().map(|r| r.seq).collect::<Vec<_>>(), [3, 4]);
        assert!(more1);
        // Next page, before the oldest held seq (3) → 1,2 with more behind.
        let (p2, more2) = db.messages_page("s", p1[0].seq, 2);
        assert_eq!(p2.iter().map(|r| r.seq).collect::<Vec<_>>(), [1, 2]);
        assert!(more2);
        // Final page → just seq 0, nothing older.
        let (p3, more3) = db.messages_page("s", p2[0].seq, 2);
        assert_eq!(p3.iter().map(|r| r.seq).collect::<Vec<_>>(), [0]);
        assert!(!more3);
    }

    #[test]
    fn messages_page_has_more_is_false_when_the_page_exactly_drains_the_history() {
        let db = mem_db();
        db.create_session("s", "S", None, None, 1).unwrap();
        for i in 0..3 {
            db.append_message("s", &text(&format!("m{i}")), 100 + i); // seq 0..2
        }
        // A page sized exactly to the remaining rows: all of them, no more behind.
        let (rows, has_more) = db.messages_page("s", 1_000, 3);
        assert_eq!(rows.iter().map(|r| r.seq).collect::<Vec<_>>(), [0, 1, 2]);
        assert!(!has_more);
    }

    #[test]
    fn messages_page_excludes_the_cursor_row_and_handles_edges() {
        let db = mem_db();
        db.create_session("s", "S", None, None, 1).unwrap();
        for i in 0..4 {
            db.append_message("s", &text(&format!("m{i}")), 100 + i); // seq 0..3
        }
        // before_seq is EXCLUSIVE: paging before seq 2 returns 0,1 (not 2).
        let (rows, _) = db.messages_page("s", 2, 10);
        assert_eq!(rows.iter().map(|r| r.seq).collect::<Vec<_>>(), [0, 1]);
        // Paging before the very first seq returns nothing, no more.
        let (none, more) = db.messages_page("s", 0, 10);
        assert!(none.is_empty());
        assert!(!more);
        // Unknown session and non-positive limit both yield (empty, false).
        // (MessageRow has no PartialEq, so assert the two fields, not the whole tuple.)
        let (unknown_rows, unknown_more) = db.messages_page("no-such", 1_000, 10);
        assert!(unknown_rows.is_empty());
        assert!(!unknown_more);
        let (zero_rows, zero_more) = db.messages_page("s", 1_000, 0);
        assert!(zero_rows.is_empty());
        assert!(!zero_more);
    }

    // ── paired_devices (Phone Sync registry) ─────────────────────────────────

    #[test]
    fn paired_devices_add_list_and_remove() {
        let db = mem_db();
        db.add_paired_device("pubA", "Pixel", 100).unwrap();
        db.add_paired_device("pubB", "iPhone", 200).unwrap();

        let list = db.list_paired_devices();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].public_key, "pubB"); // most recently paired first
        assert_eq!(list[0].name, "iPhone");
        assert_eq!(list[0].paired_at, 200);
        assert_eq!(list[0].last_seen, 200);
        assert!(!list[0].confirmed); // a freshly-added device is untrusted

        db.remove_paired_device("pubA").unwrap();
        let list = db.list_paired_devices();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].public_key, "pubB");
    }

    // ── device-trust gate (confirmed column) ─────────────────────────────────

    #[test]
    fn a_newly_added_device_is_unconfirmed_by_default() {
        let db = mem_db();
        db.add_paired_device("pub", "Pixel", 100).unwrap();
        assert!(!db.is_device_confirmed("pub"));
        assert!(!db.list_paired_devices()[0].confirmed);
    }

    #[test]
    fn confirm_paired_device_marks_it_trusted() {
        let db = mem_db();
        db.add_paired_device("pub", "Pixel", 100).unwrap();
        assert!(!db.is_device_confirmed("pub"));

        db.confirm_paired_device("pub", "Pixel", 200).unwrap();
        assert!(db.is_device_confirmed("pub"));
        let d = &db.list_paired_devices()[0];
        assert!(d.confirmed);
        assert_eq!(d.paired_at, 100); // original paired_at preserved
        assert_eq!(d.last_seen, 200); // last_seen refreshed
    }

    #[test]
    fn confirm_can_upsert_a_brand_new_device() {
        // A confirm landing before any add still creates the (trusted) row.
        let db = mem_db();
        db.confirm_paired_device("pub", "Pixel", 300).unwrap();
        assert!(db.is_device_confirmed("pub"));
        assert_eq!(db.list_paired_devices()[0].paired_at, 300);
    }

    #[test]
    fn a_reconnect_does_not_silently_upgrade_or_downgrade_trust() {
        let db = mem_db();
        // Confirm a device, then re-add it (the serve-path upsert on reconnect).
        db.confirm_paired_device("pub", "Pixel", 100).unwrap();
        db.add_paired_device("pub", "Pixel", 500).unwrap();
        // Still trusted: add_paired_device leaves `confirmed` untouched on conflict.
        assert!(db.is_device_confirmed("pub"));
        // And an unconfirmed device stays unconfirmed across a reconnect.
        db.add_paired_device("other", "iPhone", 100).unwrap();
        db.add_paired_device("other", "iPhone", 500).unwrap();
        assert!(!db.is_device_confirmed("other"));
    }

    #[test]
    fn is_device_confirmed_is_false_for_an_unknown_key() {
        let db = mem_db();
        assert!(!db.is_device_confirmed("never-seen"));
    }

    #[test]
    fn migrate_add_confirmed_is_additive_and_defaults_legacy_rows_to_untrusted() {
        // Simulate a PRE-MIGRATION database: the old paired_devices schema with no
        // `confirmed` column, holding a row paired under the vulnerable code.
        let conn = Connection::open(Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "CREATE TABLE paired_devices (
                public_key TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                paired_at INTEGER NOT NULL,
                last_seen INTEGER NOT NULL
            );
            INSERT INTO paired_devices (public_key, name, paired_at, last_seen)
            VALUES ('legacy', 'Old Phone', 100, 100);",
        )
        .unwrap();

        // Migrating must ADD the column (not drop the table) and default the legacy
        // row to untrusted — so a device paired under the old code must re-confirm.
        Db::migrate_add_confirmed(&conn).unwrap();
        let confirmed: i64 = conn
            .query_row(
                "SELECT confirmed FROM paired_devices WHERE public_key = 'legacy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(confirmed, 0, "legacy rows must default to untrusted");
        // The row itself survived (additive, not a drop+recreate).
        let name: String = conn
            .query_row(
                "SELECT name FROM paired_devices WHERE public_key = 'legacy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "Old Phone");

        // Idempotent: a second migration is a no-op, not a "duplicate column" error.
        Db::migrate_add_confirmed(&conn).unwrap();
    }

    #[test]
    fn re_pairing_updates_name_and_last_seen_but_keeps_paired_at() {
        let db = mem_db();
        db.add_paired_device("pub", "Old name", 100).unwrap();
        db.add_paired_device("pub", "New name", 500).unwrap();

        let list = db.list_paired_devices();
        assert_eq!(list.len(), 1); // still one row (upsert on the key)
        assert_eq!(list[0].name, "New name");
        assert_eq!(list[0].paired_at, 100); // original
        assert_eq!(list[0].last_seen, 500); // refreshed
    }

    #[test]
    fn touch_paired_device_bumps_last_seen_only() {
        let db = mem_db();
        db.add_paired_device("pub", "Dev", 100).unwrap();
        db.touch_paired_device("pub", 999);

        let d = &db.list_paired_devices()[0];
        assert_eq!(d.paired_at, 100);
        assert_eq!(d.last_seen, 999);
    }

    #[test]
    fn remove_paired_device_is_idempotent() {
        let db = mem_db();
        assert!(db.remove_paired_device("nope").is_ok());
    }

    // ── drafts (composer open-loop persistence) ──────────────────────────────

    #[test]
    fn save_and_get_draft_round_trips() {
        let db = mem_db();
        assert_eq!(db.get_draft("s"), None); // nothing stored yet
        db.save_draft("s", "half a thought", 100).unwrap();
        assert_eq!(db.get_draft("s").as_deref(), Some("half a thought"));
        // Upsert overwrites in place (still one row).
        db.save_draft("s", "a fuller thought", 200).unwrap();
        assert_eq!(db.get_draft("s").as_deref(), Some("a fuller thought"));
        assert_eq!(db.all_drafts().len(), 1);
    }

    #[test]
    fn saving_an_empty_draft_clears_the_row() {
        let db = mem_db();
        db.save_draft("s", "typed something", 100).unwrap();
        assert!(db.get_draft("s").is_some());
        // A real send clears the draft: an empty string deletes the row rather than
        // persisting a blank, so get_draft reads as "no draft".
        db.save_draft("s", "", 200).unwrap();
        assert_eq!(db.get_draft("s"), None);
        assert!(db.all_drafts().is_empty());
        // Whitespace-only is treated the same as empty (it never round-trips a draft).
        db.save_draft("s", "   \n  ", 300).unwrap();
        assert_eq!(db.get_draft("s"), None);
    }

    #[test]
    fn drafts_are_isolated_per_session() {
        let db = mem_db();
        db.save_draft("a", "draft for a", 1).unwrap();
        db.save_draft("b", "draft for b", 1).unwrap();
        assert_eq!(db.get_draft("a").as_deref(), Some("draft for a"));
        assert_eq!(db.get_draft("b").as_deref(), Some("draft for b"));
        let mut all = db.all_drafts();
        all.sort_by(|x, y| x.session_id.cmp(&y.session_id));
        assert_eq!(
            all,
            vec![
                DraftRow {
                    session_id: "a".into(),
                    text: "draft for a".into()
                },
                DraftRow {
                    session_id: "b".into(),
                    text: "draft for b".into()
                },
            ]
        );
    }

    #[test]
    fn deleting_a_session_drops_its_draft_and_usage() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        db.save_draft("a", "unsent", 2).unwrap();
        db.add_usage("a", 100, 50, 3).unwrap();
        db.delete_session("a").unwrap();
        assert_eq!(db.get_draft("a"), None);
        assert_eq!(
            db.get_usage("a"),
            UsageRow {
                session_id: "a".into(),
                input: 0,
                output: 0
            }
        );
    }

    // ── usage (cumulative per-session token spend) ───────────────────────────

    #[test]
    fn usage_accumulates_additively_across_events() {
        let db = mem_db();
        // Unknown session reads as zeros, not an error.
        assert_eq!(
            db.get_usage("s"),
            UsageRow {
                session_id: "s".into(),
                input: 0,
                output: 0
            }
        );
        db.add_usage("s", 1000, 200, 10).unwrap();
        db.add_usage("s", 500, 300, 20).unwrap();
        assert_eq!(
            db.get_usage("s"),
            UsageRow {
                session_id: "s".into(),
                input: 1500,
                output: 500
            }
        );
    }

    #[test]
    fn all_usage_reports_every_session() {
        let db = mem_db();
        db.add_usage("a", 100, 10, 1).unwrap();
        db.add_usage("b", 200, 20, 1).unwrap();
        let mut all = db.all_usage();
        all.sort_by(|x, y| x.session_id.cmp(&y.session_id));
        assert_eq!(
            all,
            vec![
                UsageRow {
                    session_id: "a".into(),
                    input: 100,
                    output: 10
                },
                UsageRow {
                    session_id: "b".into(),
                    input: 200,
                    output: 20
                },
            ]
        );
        // The workspace-total spend is the sum across sessions.
        let total_in: i64 = all.iter().map(|u| u.input).sum();
        let total_out: i64 = all.iter().map(|u| u.output).sum();
        assert_eq!((total_in, total_out), (300, 30));
    }

    #[test]
    fn ui_message_pages_are_bounded_and_reconstruct_the_full_history() {
        let db = mem_db();
        db.create_session("paged", "Paged", None, None, 1).unwrap();
        for index in 0..250 {
            db.append_message("paged", &text(&format!("message-{index}")), index + 2);
        }

        let full = db.try_ui_messages("paged").unwrap();
        let mut reconstructed = Vec::new();
        let mut cursor = None;
        loop {
            let page = db.try_ui_message_page("paged", cursor.as_deref()).unwrap();
            assert!(page.messages.len() <= UI_MESSAGE_PAGE_SIZE);
            let mut combined = page.messages;
            combined.extend(reconstructed);
            reconstructed = combined;
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(
            reconstructed.iter().map(|m| &m.id).collect::<Vec<_>>(),
            full.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn ui_message_page_cursor_rejects_malformed_and_cross_session_values() {
        let db = mem_db();
        db.create_session("a", "A", None, None, 1).unwrap();
        db.create_session("b", "B", None, None, 1).unwrap();
        for index in 0..101 {
            db.append_message("a", &text(&index.to_string()), index + 2);
        }
        let cursor = db
            .try_ui_message_page("a", None)
            .unwrap()
            .next_cursor
            .unwrap();
        assert!(db.try_ui_message_page("b", Some(&cursor)).is_err());
        assert!(db.try_ui_message_page("a", Some("not-base64")).is_err());
    }

    #[test]
    fn ui_message_page_expands_a_turn_at_the_oldest_boundary() {
        let db = mem_db();
        db.create_session("turns", "Turns", None, None, 1).unwrap();
        for index in 0..48 {
            db.append_message("turns", &text(&format!("before-{index}")), index + 2);
        }
        for index in 0..5 {
            db.try_append_message_for_turn(
                "turns",
                Some("boundary-turn"),
                &assistant(&format!("turn-{index}")),
                100 + index,
            )
            .unwrap();
        }
        for index in 0..97 {
            db.append_message("turns", &text(&format!("after-{index}")), 200 + index);
        }

        let page = db.try_ui_message_page("turns", None).unwrap();
        let turn = page
            .messages
            .iter()
            .find(|message| message.turn_id.as_deref() == Some("boundary-turn"))
            .expect("expanded boundary turn");
        assert_eq!(turn.blocks.len(), 5);
    }

    #[test]
    fn receipt_only_turn_is_paged_at_its_anchor() {
        let db = mem_db();
        db.create_session("receipts", "Receipts", None, None, 1)
            .unwrap();
        for index in 0..105 {
            db.append_message("receipts", &text(&index.to_string()), index + 2);
        }
        let receipt = receipt("receipt-only");
        db.save_turn_receipt("receipts", "receipt-only", &receipt, None, None)
            .unwrap();

        let page = db.try_ui_message_page("receipts", None).unwrap();
        assert!(page
            .messages
            .iter()
            .any(|message| message.id == "receipt-only" && message.receipt.is_some()));
        assert!(page.next_cursor.is_some());
    }

    #[test]
    fn ui_message_reads_error_for_an_unknown_session() {
        let db = mem_db();
        assert!(db.try_ui_messages("missing").is_err());
        assert!(db.try_ui_message_page("missing", None).is_err());
    }
}
