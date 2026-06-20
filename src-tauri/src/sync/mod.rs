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
//! hub taps that emit so a future transport can forward it untouched — the desktop
//! keeps doing all the work; the phone is only ever a mirror + remote control.

pub mod noise;
pub mod protocol;

use tokio::sync::broadcast;

use crate::llm::StreamEvent;
use protocol::SyncFrame;

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
}

impl Default for SyncHub {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncHub {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(HUB_CAPACITY);
        Self { tx }
    }

    /// Attach a new sync session. The receiver observes every frame published
    /// after this call.
    // TODO(phase-2): the consuming sync session must handle `RecvError::Lagged(n)`
    // by re-syncing from the DB (`messages_since`) instead of unwrapping the recv.
    // The real caller is the Phase 2 transport; only tests attach today, so the
    // lib build sees this as unused.
    #[allow(dead_code)]
    pub fn subscribe(&self) -> broadcast::Receiver<SyncFrame> {
        self.tx.subscribe()
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
        let session_id = channel
            .strip_prefix(AGENT_CHANNEL_PREFIX)
            .unwrap_or(channel)
            .to_string();
        self.tx.send(SyncFrame::Live { session_id, event }).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // StreamEvent/SyncFrame come via `use super::*`; only TryRecvError is new.
    use tokio::sync::broadcast::error::TryRecvError;

    fn delta() -> StreamEvent {
        StreamEvent::TextDelta { text: "hi".into() }
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
        assert!(hub.publish("agent://s1", delta()));

        match rx.try_recv() {
            Ok(SyncFrame::Live { session_id, event }) => {
                assert_eq!(session_id, "s1"); // "agent://" prefix stripped
                assert!(matches!(event, StreamEvent::TextDelta { text } if text == "hi"));
            }
            other => panic!("expected a Live frame, got {other:?}"),
        }
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
    }

    #[test]
    fn every_attached_session_sees_the_event() {
        let hub = SyncHub::new();
        let mut a = hub.subscribe();
        let mut b = hub.subscribe();
        assert_eq!(hub.subscriber_count(), 2);

        assert!(hub.publish("agent://s9", delta()));

        for rx in [&mut a, &mut b] {
            assert!(matches!(
                rx.try_recv(),
                Ok(SyncFrame::Live { session_id, .. }) if session_id == "s9"
            ));
        }
    }

    #[test]
    fn a_channel_without_the_prefix_passes_through_unchanged() {
        let hub = SyncHub::new();
        let mut rx = hub.subscribe();
        assert!(hub.publish("s1", delta()));
        assert!(matches!(
            rx.try_recv(),
            Ok(SyncFrame::Live { session_id, .. }) if session_id == "s1"
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
}
