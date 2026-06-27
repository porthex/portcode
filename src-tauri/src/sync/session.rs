//! Phone Sync — Phase 2b: the desktop catch-up serve path.
//!
//! Phase 1 of `docs/IOS_WEB_CLIENT_PLAN.md` (§5.1) moved the transport-agnostic
//! session machinery — the `FrameSink`/`FrameSource`/`FrameChannel` traits, the
//! `forward_live` / `handle_commands` loops, the `CommandHandler` trait, and the
//! phone-side `request_catch_up` / `run_client_recv` / `send_command` — into the
//! shared `portcode-sync` crate (re-exported below).
//!
//! What stays here: [`serve_catch_up`], the DESKTOP side of the catch-up exchange,
//! because it reads from `crate::db::Db` (the SQLite store), which is desktop-only
//! and not part of the wasm client. It answers a phone's `Hello` with the current
//! `SessionList` then one `MessageDelta` per requested cursor.

use crate::db::Db;
use crate::sync::protocol::{Cursor, SyncFrame};

// Re-export the shared session surface so every existing `crate::sync::session::…`
// path (in `lib.rs`, `server.rs`, `client.rs`, and their tests) keeps resolving.
// `#[allow(unused_imports)]`: the desktop crate uses only part of this surface
// (the phone-side `request_catch_up`/`run_client_recv`/`CatchUp` are wasm-client
// facing), but the shim re-exports the whole module under `-D warnings`.
#[allow(unused_imports)]
pub use portcode_sync::session::{
    forward_live, handle_commands, request_catch_up, run_client_recv, send_command, CatchUp,
    CommandHandler, FrameChannel, FrameSink, FrameSource, RecvError,
};

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
    serve_catch_up_with_cursors(channel, db, cursors).await
}

/// Desktop side: the catch-up REPLY, given the phone's cursors already read from
/// its `Hello`. Sends the current `SessionList` then one `MessageDelta` per cursor.
///
/// Split out from [`serve_catch_up`] for the first-pairing path: there the desktop
/// reads the phone's early `Hello` itself (while watching the pre-trust channel for
/// a `PairingReject`, see `serve_connection`), so by the time catch-up runs the
/// `Hello` is already consumed and only the cursors remain to be answered.
pub async fn serve_catch_up_with_cursors<C: FrameChannel + ?Sized>(
    channel: &mut C,
    db: &Db,
    cursors: Vec<Cursor>,
) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{Block, ChatMessage};
    use crate::sync::protocol::Cursor;
    use async_trait::async_trait;
    use std::path::Path;
    use tokio::sync::mpsc;

    /// In-memory channel for testing the desktop serve path against the phone-side
    /// `request_catch_up` (from the shared crate) without QUIC/Noise.
    struct MemChannel {
        tx: mpsc::UnboundedSender<SyncFrame>,
        rx: mpsc::UnboundedReceiver<SyncFrame>,
    }

    #[async_trait]
    impl FrameSink for MemChannel {
        async fn send(&mut self, frame: &SyncFrame) -> Result<(), String> {
            self.tx
                .send(frame.clone())
                .map_err(|_| "closed".to_string())
        }
    }
    #[async_trait]
    impl FrameSource for MemChannel {
        async fn recv(&mut self) -> Result<SyncFrame, portcode_sync::session::RecvError> {
            self.rx
                .recv()
                .await
                .ok_or(portcode_sync::session::RecvError::Closed)
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
        db.create_session("s1", "Alpha", None, None, 100).unwrap();
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
        db.create_session("s1", "Alpha", None, None, 100).unwrap();
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

    #[tokio::test]
    async fn serve_catch_up_with_cursors_skips_the_hello_and_answers_directly() {
        // The first-pairing path: the desktop has ALREADY read the phone's `Hello`
        // (while watching for a reject), so it answers the stashed cursors via
        // `serve_catch_up_with_cursors` WITHOUT reading another `Hello`. The reply
        // sequence (SessionList then one MessageDelta per cursor) must be identical
        // to `serve_catch_up`'s — we read it off the phone end directly.
        let db = Db::open(Path::new(":memory:")).unwrap();
        db.create_session("s1", "Alpha", None, 100).unwrap();
        db.append_message("s1", &user("first"), 101); // seq 0
        db.append_message("s1", &user("second"), 102); // seq 1

        let (mut desktop, mut phone) = mem_pair();
        let cursors = vec![Cursor {
            session_id: "s1".into(),
            seq: -1, // phone holds nothing → full history
        }];

        // No `Hello` is sent: the helper must NOT block on one. Run serve + a manual
        // phone reader concurrently.
        let (serve_res, ()) = tokio::join!(
            serve_catch_up_with_cursors(&mut desktop, &db, cursors),
            async {
                match phone.recv().await.unwrap() {
                    SyncFrame::SessionList { sessions } => {
                        assert_eq!(sessions.len(), 1);
                        assert_eq!(sessions[0].id, "s1");
                    }
                    other => panic!("expected SessionList, got {other:?}"),
                }
                match phone.recv().await.unwrap() {
                    SyncFrame::MessageDelta {
                        session_id,
                        messages,
                    } => {
                        assert_eq!(session_id, "s1");
                        assert_eq!(messages.len(), 2); // both rows, phone had none
                        assert_eq!(messages[0].seq, 0);
                        assert_eq!(messages[1].seq, 1);
                    }
                    other => panic!("expected MessageDelta, got {other:?}"),
                }
            },
        );
        serve_res.unwrap();
    }
}
