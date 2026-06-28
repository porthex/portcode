//! SQLite persistence for sessions and messages (crash-safe, WAL mode).
//!
//! The DB stores the canonical conversation (Anthropic-shaped `ChatMessage`s).
//! `ui_messages` reconstructs the frontend's *grouped* view, where tool results
//! are folded back under the assistant message that requested them.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::llm::{Block, ChatMessage};

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

#[derive(Serialize)]
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiMessage {
    id: String,
    role: String,
    blocks: Vec<UiBlock>,
    created_at: i64,
}

fn to_ui_block(b: &Block) -> UiBlock {
    match b {
        Block::Text { text } => UiBlock::Text { text: text.clone() },
        Block::ToolUse { id, name, input } => UiBlock::ToolUse {
            id: id.clone(),
            name: name.clone(),
            input: input.clone(),
        },
        Block::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => UiBlock::ToolResult {
            tool_use_id: tool_use_id.clone(),
            output: content.clone(),
            is_error: *is_error,
        },
    }
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
                created_at INTEGER NOT NULL
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
            );",
        )?;
        // Migrate pre-existing databases: the CREATE-IF-NOT-EXISTS above won't add
        // a column to a table that already exists, so add `model` in place. A
        // duplicate-column error (column already present) is expected and ignored.
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN model TEXT", []);
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
        Ok(Self {
            conn: Mutex::new(conn),
        })
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

    pub fn list_sessions(&self) -> rusqlite::Result<Vec<SessionRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, workspace, model, created_at, updated_at
             FROM sessions ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            let workspace: Option<String> = r.get(2)?;
            Ok(SessionRow {
                id: r.get(0)?,
                title: r.get(1)?,
                branch: git_branch(workspace.as_deref()),
                workspace,
                model: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })?;
        rows.collect()
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
        let id = uuid::Uuid::new_v4().to_string();
        let content = serde_json::to_string(&msg.content).unwrap_or_else(|_| "[]".into());
        let conn = self.conn.lock().unwrap();
        let seq = Self::next_seq(&conn, session_id);
        conn.execute(
            "INSERT INTO messages (id, session_id, seq, role, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, session_id, seq, msg.role, content, ts],
        )?;
        Ok(id)
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
            "SELECT id, session_id, seq, role, content, created_at
             FROM messages WHERE session_id = ?1 AND seq > ?2 ORDER BY seq",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![session_id, after_seq], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
            ))
        });
        let Ok(rows) = rows else { return Vec::new() };
        rows.filter_map(|res| res.ok())
            .map(
                |(id, session_id, seq, role, content, created_at)| MessageRow {
                    id,
                    session_id,
                    seq,
                    role,
                    // Same lenient parse as load_chat_messages/ui_messages: corrupt
                    // content degrades to an empty block list rather than dropping the
                    // row. TODO(phase-2): surface a warning instead of swallowing it.
                    content: serde_json::from_str(&content).unwrap_or_default(),
                    created_at,
                },
            )
            .collect()
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

    /// Grouped view for the frontend (tool results folded under their assistant).
    pub fn ui_messages(&self, session_id: &str) -> Vec<UiMessage> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, role, content, created_at FROM messages WHERE session_id = ?1 ORDER BY seq",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![session_id], |r| {
            let id: String = r.get(0)?;
            let role: String = r.get(1)?;
            let content: String = r.get(2)?;
            let ts: i64 = r.get(3)?;
            Ok((id, role, content, ts))
        });
        let Ok(rows) = rows else { return Vec::new() };

        let mut out: Vec<UiMessage> = Vec::new();
        for (id, role, content, ts) in rows.filter_map(|r| r.ok()) {
            let blocks: Vec<Block> = serde_json::from_str(&content).unwrap_or_default();
            if role == "assistant" {
                out.push(UiMessage {
                    id,
                    role,
                    blocks: blocks.iter().map(to_ui_block).collect(),
                    created_at: ts,
                });
            } else {
                let tool_results: Vec<UiBlock> = blocks
                    .iter()
                    .filter(|b| matches!(b, Block::ToolResult { .. }))
                    .map(to_ui_block)
                    .collect();
                if !tool_results.is_empty() {
                    if let Some(last) = out.last_mut() {
                        last.blocks.extend(tool_results);
                    }
                }
                let texts: Vec<UiBlock> = blocks
                    .iter()
                    .filter(|b| matches!(b, Block::Text { .. }))
                    .map(to_ui_block)
                    .collect();
                if !texts.is_empty() {
                    out.push(UiMessage {
                        id,
                        role: "user".into(),
                        blocks: texts,
                        created_at: ts,
                    });
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    #[test]
    fn now_ms_returns_a_recent_unix_millis() {
        let t = now_ms();
        assert!(t > 1_577_836_800_000, "now_ms too small: {t}"); // > 2020-01-01
        assert!(t < 4_102_444_800_000, "now_ms too large: {t}"); // < 2100-01-01
    }

    #[test]
    fn to_ui_block_maps_each_variant_with_the_camelcase_serde_shape() {
        assert_eq!(
            serde_json::to_value(to_ui_block(&Block::Text { text: "hi".into() })).unwrap(),
            json!({ "kind": "text", "text": "hi" })
        );
        assert_eq!(
            serde_json::to_value(to_ui_block(&Block::ToolUse {
                id: "t1".into(),
                name: "fs_read".into(),
                input: json!({ "path": "x" }),
            }))
            .unwrap(),
            json!({ "kind": "tool_use", "id": "t1", "name": "fs_read", "input": { "path": "x" } })
        );
        assert_eq!(
            serde_json::to_value(to_ui_block(&Block::ToolResult {
                tool_use_id: "t1".into(),
                content: "ok".into(),
                is_error: true,
            }))
            .unwrap(),
            json!({ "kind": "tool_result", "toolUseId": "t1", "output": "ok", "isError": true })
        );
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

    // ── messages_since: the Phone Sync catch-up delta ────────────────────────
    // Invariants protected here (ruflo tester, Phase 0 review): full pull,
    // strictly-greater boundary, up-to-date emptiness, ascending order, and
    // per-session isolation.

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
}
