//! Phone Sync — Phase 2b: the catch-up session protocol + live loops.
//!
//! When a phone (re)connects it runs a **catch-up** exchange over the encrypted
//! channel: it sends a [`SyncFrame::Hello`] carrying its per-session cursors
//! (the highest `seq` it already holds), the desktop replies with the current
//! [`SyncFrame::SessionList`], then one [`SyncFrame::MessageDelta`] per requested
//! session containing only the newer rows. After this the phone is up to date;
//! the live-stream + command-intake loop (Phase 2c) takes over.
//!
//! The protocol is written against split [`FrameSink`]/[`FrameSource`] traits
//! (combined by [`FrameChannel`]) rather than the concrete iroh transport, so it
//! can be tested over an in-memory channel without standing up QUIC endpoints.
//!
//! NOTE on the split (§5.1): the DESKTOP-side `serve_catch_up(&mut C, &Db)` reader
//! stays in `src-tauri` (it needs `crate::db::Db`, the SQLite store). Everything
//! here is transport-/DB-agnostic and shared by native + wasm. See
//! docs/PHONE_SYNC_PLAN.md and docs/IOS_WEB_CLIENT_PLAN.md.

use async_trait::async_trait;
use tokio::sync::broadcast;

use crate::protocol::{Cursor, RemoteCommand, SyncFrame};
use crate::wire::{MessageRow, SessionRow};

// The concrete secure-channel types come from whichever transport this build
// targets; the frame-channel trait impls below are identical against either.
#[cfg(not(target_arch = "wasm32"))]
use crate::transport_native::{ChannelReceiver, ChannelSender, SecureChannel};
#[cfg(target_arch = "wasm32")]
use crate::transport_wasm::{ChannelReceiver, ChannelSender, SecureChannel};

// ── frame-channel trait hierarchy ────────────────────────────────────────────

/// Why a frame receive ended. Distinguishes a CLEAN end-of-stream (the peer
/// finished/closed the channel with no bytes mid-frame — a normal shutdown) from a
/// PROTOCOL/transport error (a torn connection, a truncated frame, a Noise/AEAD
/// failure, a deserialization error). The live loops only treat `Closed` as a
/// graceful stop; a `Protocol` error is propagated so the caller forces a
/// reconnect/catch-up rather than silently treating corruption as "done".
#[derive(Debug)]
pub enum RecvError {
    /// The peer closed the channel cleanly (graceful EOF, no partial frame).
    Closed,
    /// A transport/protocol failure: a torn connection, a truncated/oversized
    /// frame, or a decrypt/deserialize error. Carries a human-readable detail.
    Protocol(String),
}

impl std::fmt::Display for RecvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecvError::Closed => write!(f, "channel closed"),
            RecvError::Protocol(e) => write!(f, "{e}"),
        }
    }
}

impl From<RecvError> for String {
    fn from(e: RecvError) -> String {
        e.to_string()
    }
}

/// The send half of a frame channel.
#[async_trait]
pub trait FrameSink {
    async fn send(&mut self, frame: &SyncFrame) -> Result<(), String>;
}

/// The receive half of a frame channel. A clean end-of-stream is reported as
/// [`RecvError::Closed`]; everything else is [`RecvError::Protocol`].
#[async_trait]
pub trait FrameSource {
    async fn recv(&mut self) -> Result<SyncFrame, RecvError>;
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
    async fn recv(&mut self) -> Result<SyncFrame, RecvError> {
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
    async fn recv(&mut self) -> Result<SyncFrame, RecvError> {
        self.recv_frame().await
    }
}

// ── catch-up protocol ────────────────────────────────────────────────────────

/// The result of a catch-up: the desktop's session list plus, per session the
/// phone asked about, the messages newer than its cursor.
/// Phone side only (`request_catch_up`); the desktop never holds one.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug)]
pub struct CatchUp {
    pub sessions: Vec<SessionRow>,
    pub deltas: Vec<(String, Vec<MessageRow>)>,
}

/// Phone side: run a catch-up against the desktop. Sends `Hello` with `cursors`,
/// then reads the session list and one delta per cursor. Desktop only ever
/// *serves* catch-up (`serve_catch_up`, which lives in `src-tauri` because it
/// needs `Db`); this requester is exercised by tests + the future phone client.
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
    // The desktop answers one MessageDelta per cursor IN ORDER, so the delta for
    // `cursor` must carry `cursor.session_id`. Validate it: a delta for a session
    // we didn't request (or out of order) means the channel is desynced or a peer
    // is feeding us rows for a session this catch-up never asked about — reject it
    // rather than silently recording the wrong session's messages.
    for cursor in &cursors {
        match channel.recv().await? {
            SyncFrame::MessageDelta {
                session_id,
                messages,
            } => {
                if session_id != cursor.session_id {
                    return Err(format!(
                        "catch-up MessageDelta session_id {session_id:?} does not match the \
                         requested cursor {:?}",
                        cursor.session_id
                    ));
                }
                deltas.push((session_id, messages));
            }
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
// etc. through `AppState`) is the integration step in `src-tauri`.

/// Forward live agent events from the desktop's broadcast hub to the phone until
/// the hub is closed (all senders dropped) or a send fails.
///
/// A `Lagged` (the phone fell behind the broadcast buffer) is NOT silently
/// skipped: once the broadcast ring overwrites un-forwarded frames, continuing
/// would permanently drop those live events with no signal to recover. We return
/// an error so the caller tears the live forward down and forces a fresh
/// catch-up (which reconciles the gap by cursor) instead of leaking a hole in the
/// phone's view of the live stream.
pub async fn forward_live(
    hub: &mut broadcast::Receiver<SyncFrame>,
    sink: &mut impl FrameSink,
) -> Result<(), String> {
    use broadcast::error::RecvError;
    loop {
        match hub.recv().await {
            Ok(frame) => sink.send(&frame).await?,
            Err(RecvError::Closed) => return Ok(()),
            Err(RecvError::Lagged(n)) => {
                return Err(format!(
                    "live forward lagged {n} frames behind the broadcast buffer; \
                     reconnect + catch-up required to avoid dropping live events"
                ))
            }
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
            Err(RecvError::Closed) => return Ok(()), // peer closed cleanly → done
            // A transport/protocol error is NOT a clean shutdown: surface it so the
            // session is torn down + reconnected rather than silently ending intake.
            Err(RecvError::Protocol(e)) => return Err(e),
        }
    }
}

// ── phone (client) side — the dual of forward_live + handle_commands ─────────
//
// After pairing + catch-up, the phone RECEIVES forwarded frames (live events) and
// SENDS commands. These are what the mobile/web app drives. Protocol-level +
// tested on the desktop CI (no android/wasm needed); their consumer is the mobile
// sync-client commands (android plan increment #4) and the wasm `Session` class
// (web plan §5.4). See docs/ANDROID_APP_PLAN.md / docs/IOS_WEB_CLIENT_PLAN.md.

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
            Err(RecvError::Closed) => return Ok(()), // peer closed cleanly → done
            // A transport/protocol error means the live view is now incomplete:
            // surface it so the client reconnects + re-runs catch-up.
            Err(RecvError::Protocol(e)) => return Err(e),
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
    use crate::wire::StreamEvent;
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
        async fn recv(&mut self) -> Result<SyncFrame, RecvError> {
            // A dropped sender (all senders gone) is a clean end-of-stream.
            self.rx.recv().await.ok_or(RecvError::Closed)
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

    // Catch-up's DESKTOP serve side (`serve_catch_up`) needs `Db`, so it and its
    // round-trip tests stay in `src-tauri`. Here we exercise the phone-side
    // `request_catch_up` against a scripted desktop, proving the requester reads
    // the SessionList + per-cursor deltas correctly without a Db.
    #[tokio::test]
    async fn request_catch_up_reads_session_list_then_one_delta_per_cursor() {
        let (mut phone, mut desktop) = mem_pair();

        let cursors = vec![
            Cursor {
                session_id: "s1".into(),
                seq: -1,
            },
            Cursor {
                session_id: "s2".into(),
                seq: 4,
            },
        ];

        // Script the desktop responder: read Hello, then reply SessionList + one
        // MessageDelta per cursor (the exact sequence `serve_catch_up` produces).
        let desktop_task = async {
            match desktop.recv().await.unwrap() {
                SyncFrame::Hello { cursors, device_id } => {
                    assert_eq!(device_id, "phone-1");
                    assert_eq!(cursors.len(), 2);
                }
                other => panic!("expected Hello, got {other:?}"),
            }
            desktop
                .send(&SyncFrame::SessionList {
                    sessions: vec![SessionRow {
                        id: "s1".into(),
                        title: "Alpha".into(),
                        branch: None,
                        workspace: None,
                        created_at: 1,
                        updated_at: 2,
                    }],
                })
                .await
                .unwrap();
            desktop
                .send(&SyncFrame::MessageDelta {
                    session_id: "s1".into(),
                    messages: vec![MessageRow {
                        id: "m1".into(),
                        session_id: "s1".into(),
                        seq: 0,
                        role: "user".into(),
                        content: vec![],
                        created_at: 3,
                    }],
                })
                .await
                .unwrap();
            desktop
                .send(&SyncFrame::MessageDelta {
                    session_id: "s2".into(),
                    messages: vec![],
                })
                .await
                .unwrap();
        };

        let (catch_up, ()) = tokio::join!(
            request_catch_up(&mut phone, "phone-1", cursors),
            desktop_task
        );
        let catch_up = catch_up.unwrap();

        assert_eq!(catch_up.sessions.len(), 1);
        assert_eq!(catch_up.sessions[0].id, "s1");
        assert_eq!(catch_up.deltas.len(), 2);
        assert_eq!(catch_up.deltas[0].0, "s1");
        assert_eq!(catch_up.deltas[0].1.len(), 1);
        assert_eq!(catch_up.deltas[1].0, "s2");
        assert!(catch_up.deltas[1].1.is_empty());
    }

    /// A FrameSource that yields a scripted sequence, then a terminal error. Used
    /// to prove the loops distinguish a clean close from a protocol error.
    struct ScriptedSource {
        frames: std::collections::VecDeque<SyncFrame>,
        terminal: Option<RecvError>,
    }
    #[async_trait]
    impl FrameSource for ScriptedSource {
        async fn recv(&mut self) -> Result<SyncFrame, RecvError> {
            if let Some(f) = self.frames.pop_front() {
                return Ok(f);
            }
            match self.terminal.take() {
                Some(e) => Err(e),
                None => Err(RecvError::Closed),
            }
        }
    }

    #[tokio::test]
    async fn request_catch_up_rejects_a_delta_for_an_unrequested_session() {
        let (mut phone, mut desktop) = mem_pair();
        let cursors = vec![Cursor {
            session_id: "s1".into(),
            seq: -1,
        }];
        // Desktop replies with a SessionList then a delta for the WRONG session.
        let desktop_task = async {
            desktop.recv().await.unwrap(); // Hello
            desktop
                .send(&SyncFrame::SessionList { sessions: vec![] })
                .await
                .unwrap();
            desktop
                .send(&SyncFrame::MessageDelta {
                    session_id: "s2".into(), // not the requested s1
                    messages: vec![],
                })
                .await
                .unwrap();
        };
        let (res, ()) = tokio::join!(request_catch_up(&mut phone, "p1", cursors), desktop_task);
        let err = res.unwrap_err();
        assert!(
            err.contains("does not match"),
            "mismatched session_id must be rejected, got: {err}"
        );
    }

    #[tokio::test]
    async fn forward_live_errors_when_the_phone_lags_behind_the_broadcast_buffer() {
        // A tiny buffer (cap 1) so a burst overruns it before forward_live drains.
        let (hub_tx, mut hub_rx) = broadcast::channel::<SyncFrame>(1);
        for i in 0..8 {
            hub_tx
                .send(SyncFrame::Ack {
                    session_id: format!("s{i}"),
                    seq: i,
                })
                .unwrap();
        }
        // A sink that accepts everything; the lag comes from the hub, not the sink.
        struct NullSink;
        #[async_trait]
        impl FrameSink for NullSink {
            async fn send(&mut self, _: &SyncFrame) -> Result<(), String> {
                Ok(())
            }
        }
        let mut sink = NullSink;
        let err = forward_live(&mut hub_rx, &mut sink).await.unwrap_err();
        assert!(
            err.contains("lagged"),
            "a lagged phone must error (force catch-up), got: {err}"
        );
    }

    #[tokio::test]
    async fn handle_commands_propagates_a_protocol_error_but_swallows_a_clean_close() {
        struct NoopHandler;
        #[async_trait]
        impl CommandHandler for NoopHandler {
            async fn handle(&self, _: RemoteCommand) -> Result<(), String> {
                Ok(())
            }
        }

        // Clean close after one command → Ok.
        let mut clean = ScriptedSource {
            frames: [SyncFrame::Command {
                command: RemoteCommand::Run {
                    session_id: "s1".into(),
                    text: "go".into(),
                },
            }]
            .into(),
            terminal: None,
        };
        handle_commands(&mut clean, &NoopHandler).await.unwrap();

        // A protocol error → Err (forces reconnect), not a silent return.
        let mut broken = ScriptedSource {
            frames: Default::default(),
            terminal: Some(RecvError::Protocol("stream reset by peer".into())),
        };
        let err = handle_commands(&mut broken, &NoopHandler)
            .await
            .unwrap_err();
        assert!(
            err.contains("reset"),
            "protocol error must propagate: {err}"
        );
    }

    #[tokio::test]
    async fn run_client_recv_propagates_a_protocol_error_but_swallows_a_clean_close() {
        // Clean close → Ok, all frames delivered.
        let mut clean = ScriptedSource {
            frames: [SyncFrame::Ack {
                session_id: "s1".into(),
                seq: 1,
            }]
            .into(),
            terminal: None,
        };
        let mut count = 0usize;
        {
            let mut on_frame = |_: SyncFrame| count += 1;
            run_client_recv(&mut clean, &mut on_frame).await.unwrap();
        }
        assert_eq!(count, 1);

        // Protocol error → Err.
        let mut broken = ScriptedSource {
            frames: Default::default(),
            terminal: Some(RecvError::Protocol("connection lost".into())),
        };
        let mut noop = |_: SyncFrame| {};
        let err = run_client_recv(&mut broken, &mut noop).await.unwrap_err();
        assert!(err.contains("lost"), "protocol error must propagate: {err}");
    }

    #[tokio::test]
    async fn forward_live_relays_hub_events_to_the_channel() {
        let (hub_tx, mut hub_rx) = broadcast::channel::<SyncFrame>(1024);
        let (mut desktop, mut phone) = mem_pair();

        hub_tx
            .send(SyncFrame::Live {
                session_id: "s1".into(),
                event: StreamEvent::TextDelta { text: "a".into() },
            })
            .unwrap();
        hub_tx
            .send(SyncFrame::Live {
                session_id: "s1".into(),
                event: StreamEvent::TextDelta { text: "b".into() },
            })
            .unwrap();
        drop(hub_tx); // close the broadcast so forward_live drains then returns

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
