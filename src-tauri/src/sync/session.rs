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
//! The protocol is written against split [`FrameSink`]/[`FrameSource`] traits
//! (combined by [`FrameChannel`]) rather than the concrete iroh transport, so it
//! can be tested over an in-memory channel without standing up QUIC endpoints.
//! See docs/PHONE_SYNC_PLAN.md.

use async_trait::async_trait;
use tokio::sync::broadcast;

use crate::db::{Db, MessageRow, SessionRow};
use crate::sync::protocol::{Cursor, RemoteCommand, SyncFrame};
use crate::sync::transport::{ChannelReceiver, ChannelSender, SecureChannel};

// ── frame-channel trait hierarchy ────────────────────────────────────────────

/// The send half of a frame channel.
#[async_trait]
pub trait FrameSink {
    async fn send(&mut self, frame: &SyncFrame) -> Result<(), String>;
}

/// The receive half of a frame channel.
#[async_trait]
pub trait FrameSource {
    async fn recv(&mut self) -> Result<SyncFrame, String>;
}

/// A bidirectional channel: both a [`FrameSink`] and a [`FrameSource`]. The
/// blanket impl gives this to anything that is both, so catch-up keeps a single
/// full-duplex bound while `forward_live` / `handle_commands` each need only one
/// half (the split [`ChannelSender`]/[`ChannelReceiver`]).
pub trait FrameChannel: FrameSink + FrameSource {}
impl<T: FrameSink + FrameSource + ?Sized> FrameChannel for T {}

// ── full-duplex: SecureChannel (production) ──────────────────────────────────

#[async_trait]
impl FrameSink for SecureChannel {
    async fn send(&mut self, frame: &SyncFrame) -> Result<(), String> {
        self.send_frame(frame).await
    }
}
#[async_trait]
impl FrameSource for SecureChannel {
    async fn recv(&mut self) -> Result<SyncFrame, String> {
        self.recv_frame().await
    }
}

// ── split halves: send-only / recv-only ──────────────────────────────────────

#[async_trait]
impl FrameSink for ChannelSender {
    async fn send(&mut self, frame: &SyncFrame) -> Result<(), String> {
        self.send_frame(frame).await
    }
}
#[async_trait]
impl FrameSource for ChannelReceiver {
    async fn recv(&mut self) -> Result<SyncFrame, String> {
        self.recv_frame().await
    }
}

// ── catch-up protocol ────────────────────────────────────────────────────────

/// The result of a catch-up: the desktop's session list plus, per session the
/// phone asked about, the messages newer than its cursor.
/// Phone side only (`request_catch_up`); the desktop never holds one.
#[cfg_attr(not(test), allow(dead_code))]
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
/// then reads the session list and one delta per cursor. Desktop only ever
/// *serves* catch-up; this requester is exercised by tests + the future phone client.
#[cfg_attr(not(test), allow(dead_code))]
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

// ── live stream + command intake (Phase 2c) ─────────────────────────────────
//
// After catch-up, two halves run concurrently over the (split) channel: live
// agent events are forwarded to the phone, and the phone's commands are read +
// dispatched. They're written as independent uni-directional loops so each is
// testable on its own; the real wiring splits the `SecureChannel` into a send
// half (for `forward_live`) and a recv half (for `handle_commands`) and spawns
// both — that split + the concrete `CommandHandler` (which calls `run_agent`
// etc. through `AppState`) is the integration step.

/// Forward live agent events from the desktop's `SyncHub` to the phone until the
/// hub is closed (all senders dropped) or a send fails. A `Lagged` (slow phone)
/// is non-fatal: dropped frames are reconciled by the catch-up path, so we keep
/// forwarding the live tail.
pub async fn forward_live(
    hub: &mut broadcast::Receiver<SyncFrame>,
    sink: &mut impl FrameSink,
) -> Result<(), String> {
    use broadcast::error::RecvError;
    loop {
        match hub.recv().await {
            Ok(frame) => sink.send(&frame).await?,
            Err(RecvError::Closed) => return Ok(()),
            Err(RecvError::Lagged(_)) => continue,
        }
    }
}

/// Executes the `RemoteCommand`s a phone sends. The real implementation wires to
/// the desktop's `run_agent` / `cancel_agent` / `resolve_permission` /
/// `create_session`; tests provide a recording fake.
///
/// `Send + Sync` are required because `handle_commands` is called from within
/// a `tauri::async_runtime::spawn` task (multi-threaded runtime), so the future
/// must be `Send`. `&dyn CommandHandler` is `Send` iff `dyn CommandHandler: Sync`,
/// which requires the `Sync` supertrait here.
#[async_trait]
pub trait CommandHandler: Send + Sync {
    async fn handle(&self, command: RemoteCommand) -> Result<(), String>;
}

/// Read frames from the phone and dispatch each `Command` to `handler`, until the
/// channel closes. `Ack`s (phone progress) are accepted and ignored for now; any
/// other frame in this position is a protocol error.
pub async fn handle_commands(
    source: &mut impl FrameSource,
    handler: &dyn CommandHandler,
) -> Result<(), String> {
    loop {
        match source.recv().await {
            Ok(SyncFrame::Command { command }) => handler.handle(command).await?,
            Ok(SyncFrame::Ack { .. }) => {}
            Ok(other) => return Err(format!("unexpected frame in command loop: {other:?}")),
            Err(_) => return Ok(()), // channel closed → done
        }
    }
}

// ── phone (client) side — the dual of forward_live + handle_commands ─────────
//
// After pairing + catch-up, the phone RECEIVES forwarded frames (live events) and
// SENDS commands. These are what the mobile app drives. Protocol-level + tested on
// the desktop CI (no android needed); their consumer is the mobile sync-client
// commands (android plan increment #4). See docs/ANDROID_APP_PLAN.md.

/// Phone side: receive forwarded frames until the channel closes, handing each to
/// `on_frame` (the UI applies it). The dual of the desktop's `forward_live`.
#[cfg_attr(not(test), allow(dead_code))]
pub async fn run_client_recv(
    source: &mut impl FrameSource,
    on_frame: &mut dyn FnMut(SyncFrame),
) -> Result<(), String> {
    loop {
        match source.recv().await {
            Ok(frame) => on_frame(frame),
            Err(_) => return Ok(()), // channel closed → done
        }
    }
}

/// Phone side: send one `RemoteCommand` to the desktop — the frames
/// `handle_commands` consumes.
#[cfg_attr(not(test), allow(dead_code))]
pub async fn send_command(sink: &mut impl FrameSink, command: RemoteCommand) -> Result<(), String> {
    sink.send(&SyncFrame::Command { command }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{Block, ChatMessage};
    use std::path::Path;
    use tokio::sync::mpsc;

    /// In-memory channel for testing the protocol without QUIC/Noise.
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
        // Seed a concrete per-session model so the catch-up SessionList carries it
        // through to the phone (covers the DB→sync model propagation).
        db.create_session("s1", "Alpha", None, Some("claude-sonnet-4-6"), 100)
            .unwrap();
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
        // The session row's model propagates verbatim through the SessionList frame,
        // so the phone can run remote turns against the chat's stored model.
        assert_eq!(
            catch_up.sessions[0].model.as_deref(),
            Some("claude-sonnet-4-6")
        );
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
    async fn forward_live_relays_hub_events_to_the_channel() {
        use crate::llm::StreamEvent;
        use crate::sync::SyncHub;

        let hub = SyncHub::new();
        let mut hub_rx = hub.subscribe();
        let (mut desktop, mut phone) = mem_pair();

        hub.publish("agent://s1", StreamEvent::TextDelta { text: "a".into() });
        hub.publish("agent://s1", StreamEvent::TextDelta { text: "b".into() });
        drop(hub); // close the broadcast so forward_live drains then returns

        let (fwd, frames) = tokio::join!(forward_live(&mut hub_rx, &mut desktop), async {
            let mut got = Vec::new();
            got.push(phone.recv().await.unwrap());
            got.push(phone.recv().await.unwrap());
            got
        });
        fwd.unwrap();

        assert_eq!(frames.len(), 2);
        assert!(matches!(
            &frames[0],
            SyncFrame::Live { session_id, .. } if session_id == "s1"
        ));
    }

    #[tokio::test]
    async fn handle_commands_dispatches_commands_and_ignores_acks() {
        use std::sync::{Arc, Mutex};

        struct Recorder {
            seen: Arc<Mutex<Vec<RemoteCommand>>>,
        }
        #[async_trait]
        impl CommandHandler for Recorder {
            async fn handle(&self, command: RemoteCommand) -> Result<(), String> {
                self.seen.lock().unwrap().push(command);
                Ok(())
            }
        }

        let (mut desktop, mut phone) = mem_pair();
        phone
            .send(&SyncFrame::Command {
                command: RemoteCommand::Run {
                    session_id: "s1".into(),
                    text: "do it".into(),
                },
            })
            .await
            .unwrap();
        phone
            .send(&SyncFrame::Ack {
                session_id: "s1".into(),
                seq: 3,
            })
            .await
            .unwrap();
        drop(phone); // close → handle_commands drains then returns

        let seen = Arc::new(Mutex::new(Vec::new()));
        handle_commands(&mut desktop, &Recorder { seen: seen.clone() })
            .await
            .unwrap();

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1); // the Ack was ignored, not dispatched
        assert!(matches!(
            &seen[0],
            RemoteCommand::Run { session_id, .. } if session_id == "s1"
        ));
    }

    #[tokio::test]
    async fn client_recv_relays_frames_to_the_callback_until_closed() {
        use crate::llm::StreamEvent;

        let (mut desktop, mut phone) = mem_pair();
        desktop
            .send(&SyncFrame::Live {
                session_id: "s1".into(),
                event: StreamEvent::TextDelta { text: "hi".into() },
            })
            .await
            .unwrap();
        desktop
            .send(&SyncFrame::Ack {
                session_id: "s1".into(),
                seq: 1,
            })
            .await
            .unwrap();
        drop(desktop); // close → run_client_recv drains then returns

        let mut got: Vec<SyncFrame> = Vec::new();
        {
            let mut on_frame = |f: SyncFrame| got.push(f);
            run_client_recv(&mut phone, &mut on_frame).await.unwrap();
        }

        assert_eq!(got.len(), 2);
        assert!(matches!(
            &got[0],
            SyncFrame::Live { session_id, .. } if session_id == "s1"
        ));
    }

    #[tokio::test]
    async fn send_command_emits_a_command_frame() {
        let (mut phone, mut desktop) = mem_pair();
        send_command(
            &mut phone,
            RemoteCommand::Run {
                session_id: "s1".into(),
                text: "hi".into(),
            },
        )
        .await
        .unwrap();

        match desktop.recv().await.unwrap() {
            SyncFrame::Command {
                command: RemoteCommand::Run { session_id, .. },
            } => assert_eq!(session_id, "s1"),
            other => panic!("expected Command::Run, got {other:?}"),
        }
    }
}
