//! Phone Sync — Phase 0: the in-process event-log spine.
//!
//! No network and no crypto live here yet (those are Phases 1–2; see
//! `docs/PHONE_SYNC_PLAN.md`). What exists today:
//!
//! * [`protocol`] — the `serde` wire types the phone and desktop will speak.
//! * [`SyncHub`] — a broadcast fan-out that mirrors every live agent event to any
//!   attached sync session, paired with `Db::messages_since` (in `db.rs`) for the
//!   catch-up delta a reconnecting phone missed.
//!
//! The desktop's agent loop already persists an append-only message log and emits
//! a typed [`StreamEvent`](crate::llm::StreamEvent) stream on `agent://{id}`. The
//! hub taps that emit and exhaustively projects them into public bounded DTOs —
//! the desktop keeps doing all the work; the phone is only a mirror + remote control.

pub mod client;
pub mod noise;
pub mod pairing;
pub mod public;
// DESKTOP-ONLY: the device-trust gate (pairing window + pending-confirm map) is
// part of the accept-loop SERVER. The phone is a pure CLIENT and never gates an
// inbound peer, so this is excluded from the mobile binary alongside `server`.
#[cfg(desktop)]
pub mod pairing_gate;
pub mod protocol;
// DESKTOP-ONLY: the accept-loop sync SERVER. `server.rs` does `use crate::agent`
// (the agent loop), which is `#[cfg(desktop)]`-excluded on mobile; gating the
// module here keeps that import resolvable and drops the server from the phone
// (a pure remote CLIENT). `client`/`protocol`/`transport`/etc. stay cross-platform.
#[cfg(desktop)]
pub mod server;
pub mod session;
pub mod transport;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast;

use std::sync::{Arc, Mutex};

use crate::llm::StreamEvent;
use protocol::SyncFrame;
use public::PhoneEventProjector;

/// Capacity of the broadcast ring buffer. A subscriber that falls more than this
/// many events behind gets a `Lagged` signal and must re-sync from the DB via the
/// catch-up delta (`Db::messages_since`) — which is exactly the reconnect path —
/// so a bounded buffer is correct rather than lossy.
const HUB_CAPACITY: usize = 1024;

/// Channel-name prefix the agent loop uses for its per-session event channel.
const AGENT_CHANNEL_PREFIX: &str = "agent://";

/// Fans live agent events out to every attached sync session.
///
/// Held in Tauri managed state so the agent/llm `emit` helpers can publish without
/// threading a handle through the whole call stack.
#[derive(Clone)]
pub struct SyncHub {
    tx: broadcast::Sender<SyncFrame>,
    projector: Arc<Mutex<PhoneEventProjector>>,
}

impl Default for SyncHub {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncHub {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(HUB_CAPACITY);
        Self {
            tx,
            projector: Arc::new(Mutex::new(PhoneEventProjector::new())),
        }
    }

    /// Attach a new sync session. The receiver observes every frame published
    /// after this call.
    // TODO(phase-2): the consuming sync session must handle `RecvError::Lagged(n)`
    // by re-syncing from the DB (`messages_since`) instead of unwrapping the recv.
    pub fn subscribe(&self) -> broadcast::Receiver<SyncFrame> {
        let starts_new_generation = self.tx.receiver_count() == 0;
        let receiver = self.tx.subscribe();
        if starts_new_generation {
            // A TextDelta may have been held when the previous last subscriber
            // disconnected. Catch-up owns reconciliation for this new connection;
            // never flush an old tail after it as a duplicate/out-of-order frame.
            if let Ok(mut projector) = self.projector.lock() {
                projector.clear();
            }
        }
        receiver
    }

    /// Number of attached sync sessions (0 when no phone is connected).
    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }

    /// Mirror a live agent event to attached sync sessions. `channel` is the
    /// agent loop's `agent://{session_id}` channel; the session id is recovered
    /// from it. Returns `true` if the frame reached at least one subscriber.
    ///
    /// The `receiver_count()` check is a hot-path optimization, **not** a
    /// correctness gate: when no phone is attached (the common case) it skips the
    /// `session_id` allocation entirely. Correctness rests on `send().is_ok()`,
    /// which is already `false` if every receiver dropped between the check and
    /// the send.
    pub fn publish(&self, channel: &str, event: StreamEvent) -> bool {
        if self.subscriber_count() == 0 {
            return false;
        }
        let Some(session_id) = channel.strip_prefix(AGENT_CHANNEL_PREFIX) else {
            return false;
        };
        // Subagent stream channels are `agent://{session}:{agentId}`, so the
        // recovered id carries a ':'. The phone has no view for a subagent's private
        // transcript, and `applyRemoteEvent` keys frames by session id — mirroring
        // these would only spawn a phantom session. Skip them. (A subagent's
        // permission prompts route on the PARENT channel, so they still reach the
        // phone.) A real session id is a UUID and never contains ':'.
        if !public::valid_remote_identifier(session_id) {
            return false;
        }
        let Ok(mut projector) = self.projector.lock() else {
            return false;
        };
        let mut published = false;
        for frame in projector.project_frames(session_id, &event) {
            published = self.tx.send(frame).is_ok() || published;
        }
        published
    }

    /// Publish an arbitrary [`SyncFrame`] to attached sync sessions. Returns `true`
    /// if it reached at least one subscriber.
    ///
    /// Unlike [`publish`](Self::publish) (which wraps an agent event into a `Live`
    /// frame), this forwards a fully-formed frame as-is — used to re-push a fresh
    /// `SessionList` when the session set changes (e.g. a phone `CreateSession`), so
    /// a created session becomes visible on the phone WITHOUT waiting for the next
    /// reconnect/catch-up. The same `receiver_count()` fast-path applies: a no-op
    /// when no phone is attached.
    // DESKTOP-ONLY: the only caller is the desktop sync SERVER's command handler
    // (`server::DesktopCommandHandler`, itself `#[cfg(desktop)]`). Gating it here
    // keeps the mobile build (which never serves) free of an unused method under
    // `-D warnings`.
    #[cfg(desktop)]
    pub fn publish_frame(&self, frame: SyncFrame) -> bool {
        if self.subscriber_count() == 0 {
            return false;
        }
        self.tx.send(frame).is_ok()
    }
}

/// The single sanctioned way to emit a live agent event.
///
/// Delivers `event` to the desktop UI on `channel` **and** mirrors it to any
/// attached phone via [`SyncHub`] (`publish` is a cheap no-op when none is
/// connected). Every `StreamEvent` MUST go out through here: emitting with
/// `AppHandle::emit` directly reaches only the desktop, so a paired phone would
/// never see it — which is exactly how a permission prompt once went missing and
/// hung a remote turn indefinitely.
pub fn emit_event(app: &AppHandle, channel: &str, event: StreamEvent) {
    if let Some(hub) = app.try_state::<SyncHub>() {
        hub.publish(channel, event.clone());
    }
    let _ = app.emit(channel, event);
}

/// Deliver an additive lifecycle event to the local desktop only. This is the
/// compatibility bridge for event variants that legacy Rust Phone Sync peers
/// cannot deserialize yet; authoritative TurnEnd/Error events still use
/// [`emit_event`] and remain mirrored normally.
pub fn emit_local_event(app: &AppHandle, channel: &str, event: StreamEvent) {
    let _ = app.emit(channel, event);
}

#[cfg(test)]
mod tests {
    use super::*;
    use portcode_sync::wire::PhoneStreamEvent;
    use tokio::sync::broadcast::error::TryRecvError;

    fn delta() -> StreamEvent {
        StreamEvent::TextDelta { text: "hi".into() }
    }

    fn usage() -> StreamEvent {
        StreamEvent::Usage {
            input_tokens: 1,
            output_tokens: 2,
        }
    }

    #[test]
    fn publish_is_a_noop_with_no_subscribers() {
        let hub = SyncHub::new();
        assert_eq!(hub.subscriber_count(), 0);
        assert!(!hub.publish("agent://s1", delta()));
    }

    #[test]
    fn a_subscriber_receives_a_live_frame_with_the_session_id_recovered() {
        let hub = SyncHub::new();
        let mut rx = hub.subscribe();
        assert_eq!(hub.subscriber_count(), 1);

        // `broadcast::send` is synchronous, so `try_recv` right after it is not
        // racy and needs no runtime.
        assert!(!hub.publish("agent://s1", delta()));
        assert!(hub.publish("agent://s1", usage()));

        match rx.try_recv() {
            Ok(SyncFrame::Live { session_id, event }) => {
                assert_eq!(session_id, "s1"); // "agent://" prefix stripped
                assert!(matches!(event, PhoneStreamEvent::TextDelta { text } if text == "hi"));
            }
            other => panic!("expected a Live frame, got {other:?}"),
        }
        assert!(matches!(
            rx.try_recv(),
            Ok(SyncFrame::Live {
                event: PhoneStreamEvent::Usage { .. },
                ..
            })
        ));
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
    }

    #[test]
    fn every_attached_session_sees_the_event() {
        let hub = SyncHub::new();
        let mut a = hub.subscribe();
        let mut b = hub.subscribe();
        assert_eq!(hub.subscriber_count(), 2);

        assert!(hub.publish("agent://s9", usage()));

        for rx in [&mut a, &mut b] {
            assert!(matches!(
                rx.try_recv(),
                Ok(SyncFrame::Live { session_id, .. }) if session_id == "s9"
            ));
        }
    }

    #[test]
    fn a_channel_without_the_prefix_is_rejected() {
        let hub = SyncHub::new();
        let mut rx = hub.subscribe();
        assert!(!hub.publish("s1", usage()));
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
    }

    #[test]
    fn publish_skips_subagent_channels_to_avoid_phantom_phone_sessions() {
        // A subagent's stream channel is `agent://{session}:{agentId}`. The phone
        // can't render a subagent's private transcript and keys frames by session
        // id, so mirroring one would only create a phantom session — publish must
        // drop it (returning false) even with a live subscriber. A subagent's
        // permission prompts ride the parent `agent://{session}` channel, which is
        // NOT skipped, so they still reach the phone.
        let hub = SyncHub::new();
        let mut rx = hub.subscribe();
        assert_eq!(hub.subscriber_count(), 1);

        assert!(!hub.publish("agent://sess-1:agent-abc", usage()));
        // Nothing was broadcast for the subagent channel.
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));

        // The parent channel for the same session is still mirrored.
        assert!(hub.publish("agent://sess-1", usage()));
        assert!(matches!(
            rx.try_recv(),
            Ok(SyncFrame::Live { session_id, .. }) if session_id == "sess-1"
        ));
    }

    // Guards against ghost-publishing: once the phone disconnects the hub must
    // fall back to the cheap no-op path. (ruflo tester, Phase 0 review.)
    #[test]
    fn dropping_the_last_receiver_makes_publish_a_noop_again() {
        let hub = SyncHub::new();
        let rx = hub.subscribe();
        assert_eq!(hub.subscriber_count(), 1);

        drop(rx);
        assert_eq!(hub.subscriber_count(), 0);
        assert!(!hub.publish("agent://s1", delta()));
    }

    #[test]
    fn a_new_subscriber_generation_never_receives_a_stale_held_text_tail() {
        let hub = SyncHub::new();
        let first = hub.subscribe();
        assert!(!hub.publish(
            "agent://s1",
            StreamEvent::TextDelta {
                text: "held for first phone".into(),
            },
        ));
        drop(first);

        let mut second = hub.subscribe();
        assert!(hub.publish("agent://s1", usage()));
        assert!(matches!(
            second.try_recv(),
            Ok(SyncFrame::Live {
                event: PhoneStreamEvent::Usage { .. },
                ..
            })
        ));
        assert!(matches!(second.try_recv(), Err(TryRecvError::Empty)));
    }
}
