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
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn list_sessions(&self) -> rusqlite::Result<Vec<SessionRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, workspace, created_at, updated_at
             FROM sessions ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SessionRow {
                id: r.get(0)?,
                title: r.get(1)?,
                workspace: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn create_session(
        &self,
        id: &str,
        title: &str,
        workspace: Option<&str>,
        ts: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, workspace, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, title, workspace, ts],
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
