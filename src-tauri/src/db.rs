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

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    pub workspace: Option<String>,
    pub model: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One persisted message, with its raw append-only `seq`. Unlike [`UiMessage`]
/// (the grouped frontend view), this is the flat row Phone Sync replicates: the
/// `MessageDelta` catch-up frame ships these verbatim. `content` is the typed
/// block list (same shape as [`ChatMessage::content`]).
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

/// A phone paired for Phone Sync, keyed by its Curve25519 static public key
/// (base64). `name` is a user-facing label; timestamps are unix millis.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub public_key: String,
    pub name: String,
    pub paired_at: i64,
    pub last_seen: i64,
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

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
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
                last_seen INTEGER NOT NULL
            );",
        )?;
        // Migrate pre-existing databases: the CREATE-IF-NOT-EXISTS above won't add
        // a column to a table that already exists, so add `model` in place. A
        // duplicate-column error (column already present) is expected and ignored.
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN model TEXT", []);
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn list_sessions(&self) -> rusqlite::Result<Vec<SessionRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, workspace, model, created_at, updated_at
             FROM sessions ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SessionRow {
                id: r.get(0)?,
                title: r.get(1)?,
                workspace: r.get(2)?,
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
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    fn next_seq(conn: &Connection, session_id: &str) -> i64 {
        conn.query_row(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM messages WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Append one canonical message; returns its row id.
    pub fn append_message(&self, session_id: &str, msg: &ChatMessage, ts: i64) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let content = serde_json::to_string(&msg.content).unwrap_or_else(|_| "[]".into());
        let conn = self.conn.lock().unwrap();
        let seq = Self::next_seq(&conn, session_id);
        let _ = conn.execute(
            "INSERT INTO messages (id, session_id, seq, role, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, session_id, seq, msg.role, content, ts],
        );
        id
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

    // ── paired devices (Phone Sync) ──────────────────────────────────────────

    /// Record a paired device (or refresh an existing one's name/last_seen). The
    /// `public_key` (base64) is the device identity; re-pairing keeps the original
    /// `paired_at`.
    pub fn add_paired_device(&self, public_key: &str, name: &str, ts: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO paired_devices (public_key, name, paired_at, last_seen)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(public_key) DO UPDATE SET name = ?2, last_seen = ?3",
            params![public_key, name, ts],
        )?;
        Ok(())
    }

    /// All paired devices, most recently paired first.
    pub fn list_paired_devices(&self) -> Vec<PairedDevice> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare(
            "SELECT public_key, name, paired_at, last_seen
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

        db.remove_paired_device("pubA").unwrap();
        let list = db.list_paired_devices();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].public_key, "pubB");
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
}
