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
//! `SessionList` then one bounded `MessageDelta` per session (see
//! [`serve_catch_up_with_cursors`] for how cursors scope each session's delta).

use std::collections::HashMap;

use crate::db::{Db, SYNC_CACHE_WINDOW};
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
/// sends the current session list, then one `MessageDelta` for EVERY session (see
/// [`serve_catch_up_with_cursors`]).
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
/// its `Hello`. Sends the current `SessionList`, then one `MessageDelta` for EVERY
/// session in that list (not just the cursor-listed ones).
///
/// The cursors are the client's per-session high-water marks: for a session it
/// already holds, we send only the rows newer than its cursor; for a session it has
/// NO cursor for — a fresh web client that sent an empty `Hello`, or a phone that
/// missed a session created while it was away — we send the full tail (`seq > -1`).
/// Either way the delta is BOUNDED to the last [`SYNC_CACHE_WINDOW`] rows via
/// `Db::messages_tail`, so it can't blow the Noise frame cap; older history is
/// fetched on demand by scroll-up pagination (`RemoteCommand::FetchMessages`). An
/// up-to-date cursor still yields an empty delta (unchanged behavior).
///
/// This is what makes desktop chat history appear on a web client: the wasm client
/// sends `Hello { cursors: [] }`, so the old per-cursor loop sent ZERO deltas and
/// no history; iterating sessions instead delivers each one's recent window.
///
/// `messages_tail` degrades a DB read error to an empty delta (see `db.rs`), so a
/// transient read failure for one session looks like "up to date" rather than an
/// error on this path; a `list_sessions` failure, by contrast, is propagated.
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
    let sessions = db.list_sessions().map_err(|e| e.to_string())?;

    // The client's per-session high-water marks, for the sessions it already holds.
    let cursor_seqs: HashMap<String, i64> =
        cursors.into_iter().map(|c| (c.session_id, c.seq)).collect();

    channel
        .send(&SyncFrame::SessionList {
            sessions: sessions.clone(),
        })
        .await?;

    // One bounded delta PER session. Use the client's cursor seq when it has one,
    // else -1 (full tail) for a session it has never seen.
    for session in &sessions {
        let after_seq = cursor_seqs.get(&session.id).copied().unwrap_or(-1);
        let messages = db.messages_tail(&session.id, after_seq, SYNC_CACHE_WINDOW);
        channel
            .send(&SyncFrame::MessageDelta {
                session_id: session.id.clone(),
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
        db.create_session("s1", "Alpha", None, None, 100).unwrap();
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

    /// Read the catch-up reply directly off the phone end: a `SessionList` followed
    /// by exactly `expect_sessions` `MessageDelta` frames (one per session), returned
    /// as `(session_id, messages)` pairs. Used for the empty-cursor path, where
    /// `request_catch_up` would read zero deltas (it reads one per cursor).
    async fn read_catch_up(
        phone: &mut MemChannel,
        expect_sessions: usize,
    ) -> (
        Vec<crate::db::SessionRow>,
        Vec<(String, Vec<crate::db::MessageRow>)>,
    ) {
        let sessions = match phone.recv().await.unwrap() {
            SyncFrame::SessionList { sessions } => sessions,
            other => panic!("expected SessionList, got {other:?}"),
        };
        let mut deltas = Vec::with_capacity(expect_sessions);
        for _ in 0..expect_sessions {
            match phone.recv().await.unwrap() {
                SyncFrame::MessageDelta {
                    session_id,
                    messages,
                } => deltas.push((session_id, messages)),
                other => panic!("expected MessageDelta, got {other:?}"),
            }
        }
        (sessions, deltas)
    }

    #[tokio::test]
    async fn empty_cursors_still_deliver_full_history_for_every_session() {
        // The web-client path: the wasm client connects with EMPTY cursors. The old
        // per-cursor loop sent zero deltas (so no desktop history ever reached the
        // browser); now every session gets its full-tail delta regardless of cursors.
        let db = Db::open(Path::new(":memory:")).unwrap();
        db.create_session("s1", "Alpha", None, None, 100).unwrap();
        db.append_message("s1", &user("a1"), 101); // seq 0
        db.append_message("s1", &user("a2"), 102); // seq 1
        db.create_session("s2", "Beta", None, None, 200).unwrap();
        db.append_message("s2", &user("b1"), 201); // seq 0

        let (mut desktop, mut phone) = mem_pair();
        // Empty cursors, exactly what the wasm `Session::connect` sends. Sent up
        // front (the channel is unbounded, so it buffers) so `serve_catch_up` can
        // read it while we read its reply off `phone` — both on the one `phone` half.
        phone
            .send(&SyncFrame::Hello {
                device_id: "web".into(),
                cursors: vec![],
            })
            .await
            .unwrap();
        let (serve_res, (sessions, deltas)) = tokio::join!(
            serve_catch_up(&mut desktop, &db),
            read_catch_up(&mut phone, 2)
        );
        serve_res.unwrap();

        // A delta per session (not zero), each with that session's full history.
        assert_eq!(sessions.len(), 2);
        assert_eq!(deltas.len(), 2);
        let by_id: std::collections::HashMap<_, _> = deltas.into_iter().collect();
        assert_eq!(by_id["s1"].len(), 2);
        assert_eq!(by_id["s1"][0].seq, 0);
        assert_eq!(by_id["s1"][1].seq, 1);
        assert_eq!(by_id["s2"].len(), 1);
        assert_eq!(by_id["s2"][0].seq, 0);
    }

    #[tokio::test]
    async fn empty_cursor_catch_up_caps_the_delta_at_the_window() {
        // A session longer than SYNC_CACHE_WINDOW must not serialize its whole
        // history into one frame (the Noise frame cap). The delta is bounded to the
        // last `SYNC_CACHE_WINDOW` rows — the most RECENT ones, in ascending order.
        let db = Db::open(Path::new(":memory:")).unwrap();
        db.create_session("s1", "Alpha", None, None, 100).unwrap();
        let total = SYNC_CACHE_WINDOW + 25;
        for i in 0..total {
            db.append_message("s1", &user(&format!("m{i}")), 1000 + i);
        }

        let (mut desktop, mut phone) = mem_pair();
        phone
            .send(&SyncFrame::Hello {
                device_id: "web".into(),
                cursors: vec![],
            })
            .await
            .unwrap();
        let (serve_res, (_sessions, deltas)) = tokio::join!(
            serve_catch_up(&mut desktop, &db),
            read_catch_up(&mut phone, 1)
        );
        serve_res.unwrap();

        let (_, messages) = &deltas[0];
        // Capped at the window (not `total`), holding the MOST RECENT rows: last seq is
        // total-1, first is the window's start; rows stay ascending.
        assert_eq!(messages.len() as i64, SYNC_CACHE_WINDOW);
        assert_eq!(messages.first().unwrap().seq, total - SYNC_CACHE_WINDOW);
        assert_eq!(messages.last().unwrap().seq, total - 1);
    }

    #[tokio::test]
    async fn a_partial_cursor_set_serves_known_sessions_incrementally_and_new_ones_fully() {
        // A phone reconnects holding s1 up to seq 0 but has never seen s2 (created
        // while it was away). s1 gets only the rows newer than its cursor; s2 — with
        // no cursor — gets its full tail.
        let db = Db::open(Path::new(":memory:")).unwrap();
        db.create_session("s1", "Alpha", None, None, 100).unwrap();
        db.append_message("s1", &user("a1"), 101); // seq 0 (phone has this)
        db.append_message("s1", &user("a2"), 102); // seq 1 (new)
        db.create_session("s2", "Beta", None, None, 200).unwrap();
        db.append_message("s2", &user("b1"), 201); // seq 0 (phone never saw s2)

        let (mut desktop, mut phone) = mem_pair();
        phone
            .send(&SyncFrame::Hello {
                device_id: "phone-1".into(),
                cursors: vec![Cursor {
                    session_id: "s1".into(),
                    seq: 0,
                }],
            })
            .await
            .unwrap();
        let (serve_res, (_sessions, deltas)) = tokio::join!(
            serve_catch_up(&mut desktop, &db),
            read_catch_up(&mut phone, 2)
        );
        serve_res.unwrap();

        let by_id: std::collections::HashMap<_, _> = deltas.into_iter().collect();
        // s1: only the row newer than the cursor (seq 1).
        assert_eq!(by_id["s1"].len(), 1);
        assert_eq!(by_id["s1"][0].seq, 1);
        // s2: full history (no cursor → full tail).
        assert_eq!(by_id["s2"].len(), 1);
        assert_eq!(by_id["s2"][0].seq, 0);
    }
}
