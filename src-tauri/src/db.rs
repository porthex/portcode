//! SQLite persistence for sessions and messages (crash-safe, WAL mode).
//!
//! The DB stores the canonical conversation (Anthropic-shaped `ChatMessage`s).
//! `ui_messages` reconstructs the frontend's *grouped* view, where tool results
//! are folded back under the assistant message that requested them.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;

use crate::llm::{Block, ChatMessage};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    pub workspace: Option<String>,
    pub model: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
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
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);",
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
        db.create_session("a", "Alpha", None, 100).unwrap();
        db.create_session("b", "Beta", Some("C:/ws"), 200).unwrap();
        let rows = db.list_sessions().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "b"); // newer updated_at first
        assert_eq!(rows[0].workspace.as_deref(), Some("C:/ws"));
        assert_eq!(rows[1].workspace, None);
    }

    #[test]
    fn rename_touch_and_set_title_if_blank_behave() {
        let db = mem_db();
        db.create_session("a", "New chat", None, 100).unwrap();

        db.rename_session("a", "Renamed").unwrap();
        assert_eq!(db.list_sessions().unwrap()[0].title, "Renamed");

        db.touch_session("a", 500);
        assert_eq!(db.list_sessions().unwrap()[0].updated_at, 500);

        // only overwrites a blank / "New chat" title — not a real one
        db.set_title_if_blank("a", "should not apply");
        assert_eq!(db.list_sessions().unwrap()[0].title, "Renamed");

        db.create_session("b", "New chat", None, 50).unwrap();
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
        db.create_session("a", "A", None, 1).unwrap();
        db.append_message("a", &text("hi"), 2);
        db.delete_session("a").unwrap();
        assert!(db.list_sessions().unwrap().is_empty());
        assert!(db.load_chat_messages("a").is_empty());
    }

    #[test]
    fn append_and_load_chat_messages_round_trips_in_seq_order() {
        let db = mem_db();
        db.create_session("a", "A", None, 1).unwrap();
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
        db.create_session("a", "A", None, 1).unwrap();
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
}
