//! Phone Sync — Phase 2b: the catch-up session protocol.
//!
//! When a phone (re)connects it runs a **catch-up** exchange over the encrypted
//! channel: it sends a [`SyncFrame::Hello`] carrying its per-session cursors
//! (the highest `seq` it already holds), the desktop replies with the current
//! [`SyncFrame::SessionList`], then one [`SyncFrame::MessageDelta`] per requested
//! session containing only the newer rows ([`Db::messages_since`]). After this the
//! phone is up to date; the live-stream + command-intake loop (Phase 2c) takes
//! over.
//!
//! The protocol is written against a small [`FrameChannel`] trait rather than the
//! concrete iroh transport, so it can be tested over an in-memory channel without
//! standing up QUIC endpoints — the real [`SecureChannel`] implements the trait.
//! Not yet wired to a command, so the module carries a `dead_code` allow until
//! Phase 3 drives a live session. See docs/PHONE_SYNC_PLAN.md.
#![allow(dead_code)]

use async_trait::async_trait;

use crate::db::{Db, MessageRow, SessionRow};
use crate::sync::protocol::{Cursor, SyncFrame};
use crate::sync::transport::SecureChannel;

/// A bidirectional channel that carries whole [`SyncFrame`]s. Implemented by the
/// encrypted [`SecureChannel`] in production and by an in-memory channel in tests.
#[async_trait]
pub trait FrameChannel {
    async fn send(&mut self, frame: &SyncFrame) -> Result<(), String>;
    async fn recv(&mut self) -> Result<SyncFrame, String>;
}

#[async_trait]
impl FrameChannel for SecureChannel {
    async fn send(&mut self, frame: &SyncFrame) -> Result<(), String> {
        self.send_frame(frame).await
    }
    async fn recv(&mut self) -> Result<SyncFrame, String> {
        self.recv_frame().await
    }
}

/// The result of a catch-up: the desktop's session list plus, per session the
/// phone asked about, the messages newer than its cursor.
pub struct CatchUp {
    pub sessions: Vec<SessionRow>,
    pub deltas: Vec<(String, Vec<MessageRow>)>,
}

/// Desktop side: answer a phone's catch-up request. Reads the phone's `Hello`,
/// sends the current session list, then one `MessageDelta` per requested cursor
/// (only the rows newer than that cursor's `seq`).
///
/// A cursor list is the phone's per-session high-water marks, so it gets deltas
/// only for sessions it already knows about. A session that appears in the
/// `SessionList` but has no cursor (e.g. created while the phone was away) is
/// picked up by a follow-up catch-up once the phone has seen the new id. Note
/// `messages_since` degrades a DB read error to an empty delta (see `db.rs`), so a
/// transient read failure for one session looks like "up to date" rather than an
/// error on this path; a `list_sessions` failure, by contrast, is propagated.
pub async fn serve_catch_up<C: FrameChannel + ?Sized>(
    channel: &mut C,
    db: &Db,
) -> Result<(), String> {
    let cursors = match channel.recv().await? {
        SyncFrame::Hello { cursors, .. } => cursors,
        other => return Err(format!("expected Hello, got {other:?}")),
    };

    channel
        .send(&SyncFrame::SessionList {
            sessions: db.list_sessions().map_err(|e| e.to_string())?,
        })
        .await?;

    for cursor in cursors {
        let messages = db.messages_since(&cursor.session_id, cursor.seq);
        channel
            .send(&SyncFrame::MessageDelta {
                session_id: cursor.session_id,
                messages,
            })
            .await?;
    }
    Ok(())
}

/// Phone side: run a catch-up against the desktop. Sends `Hello` with `cursors`,
/// then reads the session list and one delta per cursor.
pub async fn request_catch_up<C: FrameChannel + ?Sized>(
    channel: &mut C,
    device_id: &str,
    cursors: Vec<Cursor>,
) -> Result<CatchUp, String> {
    channel
        .send(&SyncFrame::Hello {
            device_id: device_id.to_string(),
            cursors: cursors.clone(),
        })
        .await?;

    let sessions = match channel.recv().await? {
        SyncFrame::SessionList { sessions } => sessions,
        other => return Err(format!("expected SessionList, got {other:?}")),
    };

    let mut deltas = Vec::with_capacity(cursors.len());
    for _ in &cursors {
        match channel.recv().await? {
            SyncFrame::MessageDelta {
                session_id,
                messages,
            } => deltas.push((session_id, messages)),
            other => return Err(format!("expected MessageDelta, got {other:?}")),
        }
    }
    Ok(CatchUp { sessions, deltas })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{Block, ChatMessage};
    use std::path::Path;
    use tokio::sync::mpsc;

    /// In-memory `FrameChannel` for testing the protocol without QUIC/Noise.
    struct MemChannel {
        tx: mpsc::UnboundedSender<SyncFrame>,
        rx: mpsc::UnboundedReceiver<SyncFrame>,
    }

    #[async_trait]
    impl FrameChannel for MemChannel {
        async fn send(&mut self, frame: &SyncFrame) -> Result<(), String> {
            self.tx
                .send(frame.clone())
                .map_err(|_| "closed".to_string())
        }
        async fn recv(&mut self) -> Result<SyncFrame, String> {
            self.rx.recv().await.ok_or_else(|| "closed".to_string())
        }
    }

    /// Two cross-wired in-memory channels (a's sends arrive at b's recv, etc.).
    fn mem_pair() -> (MemChannel, MemChannel) {
        let (a_tx, a_rx) = mpsc::unbounded_channel();
        let (b_tx, b_rx) = mpsc::unbounded_channel();
        (
            MemChannel { tx: a_tx, rx: b_rx },
            MemChannel { tx: b_tx, rx: a_rx },
        )
    }

    fn user(text: &str) -> ChatMessage {
        ChatMessage {
            role: "user".into(),
            content: vec![Block::Text { text: text.into() }],
        }
    }

    #[tokio::test]
    async fn catch_up_delivers_the_session_list_and_per_cursor_deltas() {
        let db = Db::open(Path::new(":memory:")).unwrap();
        db.create_session("s1", "Alpha", None, 100).unwrap();
        db.append_message("s1", &user("first"), 101);
        db.append_message("s1", &user("second"), 102);

        let (mut desktop, mut phone) = mem_pair();
        // serve + request run concurrently on one task via join!, so neither side
        // is spawned (no `Send` requirement) and a current-thread runtime suffices.
        let (serve_res, catch_up) = tokio::join!(
            serve_catch_up(&mut desktop, &db),
            // The phone holds nothing yet (cursor seq = -1 → full history).
            request_catch_up(
                &mut phone,
                "phone-1",
                vec![Cursor {
                    session_id: "s1".into(),
                    seq: -1,
                }],
            ),
        );
        serve_res.unwrap();
        let catch_up = catch_up.unwrap();

        assert_eq!(catch_up.sessions.len(), 1);
        assert_eq!(catch_up.sessions[0].id, "s1");
        assert_eq!(catch_up.deltas.len(), 1);
        let (session_id, messages) = &catch_up.deltas[0];
        assert_eq!(session_id, "s1");
        assert_eq!(messages.len(), 2); // both messages, since the phone had none
        assert_eq!(messages[0].seq, 0);
        assert_eq!(messages[1].seq, 1);
    }

    #[tokio::test]
    async fn catch_up_for_an_up_to_date_cursor_returns_an_empty_delta() {
        let db = Db::open(Path::new(":memory:")).unwrap();
        db.create_session("s1", "Alpha", None, 100).unwrap();
        db.append_message("s1", &user("only"), 101); // seq 0

        let (mut desktop, mut phone) = mem_pair();
        // Phone already holds seq 0 → nothing newer.
        let (serve_res, catch_up) = tokio::join!(
            serve_catch_up(&mut desktop, &db),
            request_catch_up(
                &mut phone,
                "phone-1",
                vec![Cursor {
                    session_id: "s1".into(),
                    seq: 0,
                }],
            ),
        );
        serve_res.unwrap();
        let catch_up = catch_up.unwrap();

        assert_eq!(catch_up.deltas.len(), 1);
        assert!(catch_up.deltas[0].1.is_empty());
    }
}
