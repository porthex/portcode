//! Phone Sync — desktop-side device-trust gate.
//!
//! Closes the critical "handshake == authorized" vulnerability: completing the
//! keyless XX Noise handshake no longer grants a peer the command surface. A peer
//! is served only if its Noise static key is CONFIRMED-trusted (`db.rs`'s
//! `confirmed` column), and a NEW (untrusted) peer can pair only while a bounded
//! PAIRING WINDOW is open and the desktop user explicitly confirms its SAS.
//!
//! Two pieces of shared state live here, both held in Tauri managed state (so the
//! accept loop, `serve_connection`, and the `*_pairing` Tauri commands share one
//! instance):
//!
//!   * the **pairing window** — opened (with a TTL + the active nonce) by the
//!     desktop's "Pair a phone" action. Only while a window is open does the
//!     responder accept an XX handshake from a NEW peer, and the window's nonce is
//!     bound into the handshake prologue (`noise.rs`), so a peer with a stale/forged
//!     nonce fails cryptographically. The window is single-use: a successful confirm
//!     consumes it.
//!   * the **pending pairings** map — `request_id → oneshot sender + peer static +
//!     SAS`. When an untrusted peer connects inside an open window, `serve_connection`
//!     inserts an entry, emits `phone-sync://pairing-request` to the desktop UI, and
//!     awaits the oneshot. `confirm_pairing` / `reject_pairing` Tauri commands
//!     resolve it.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

/// How long a pairing window stays open after the desktop user clicks "Pair a
/// phone". A phone must scan + complete the handshake within this window; after
/// it lapses, new (untrusted) peers are dropped before any UI is shown.
pub const PAIRING_WINDOW_TTL: Duration = Duration::from_secs(120);

/// How long the desktop waits for the user to confirm/reject a pending pairing
/// before giving up and dropping the connection (no catch-up, no command loop).
pub const PAIRING_CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);

/// An open pairing window: a bounded interval during which the desktop will
/// entertain a NEW peer, plus the nonce that peer must have scanned.
struct PairingWindow {
    /// The nonce advertised in the current QR; bound into the handshake prologue.
    nonce: Vec<u8>,
    /// When the window stops accepting new peers.
    expires_at: Instant,
}

/// One outstanding "a new phone is trying to pair" request awaiting the desktop
/// user's decision.
struct PendingPairing {
    /// Resolved by `confirm_pairing` (true) / `reject_pairing` (false).
    responder: oneshot::Sender<bool>,
    /// The peer's pinned Noise static key (base64) — persisted as confirmed on accept.
    peer_key_b64: String,
}

/// What `serve_connection` should do with a freshly-handshaked peer, decided by
/// the device-trust gate BEFORE any catch-up or command dispatch.
#[derive(Debug, PartialEq, Eq)]
pub enum ServeDecision {
    /// The peer is confirmed-trusted — serve it immediately.
    Serve,
    /// The peer is untrusted and no pairing window is open — drop it (no UI, no
    /// dispatch).
    Drop,
    /// The peer is untrusted but a pairing window is open — prompt the desktop user
    /// (emit `phone-sync://pairing-request`) and await confirm/reject.
    Prompt,
}

/// The serve-time trust decision: a confirmed device is served; an untrusted one
/// is prompted only while a pairing window is open, else dropped. Pure (no I/O) so
/// the gate logic is unit-testable without an `AppHandle`/QUIC; `serve_connection`
/// calls it then acts (serve / drop / emit+await).
pub fn serve_decision(is_confirmed: bool, window_open: bool) -> ServeDecision {
    if is_confirmed {
        ServeDecision::Serve
    } else if window_open {
        ServeDecision::Prompt
    } else {
        ServeDecision::Drop
    }
}

/// Shared device-trust state. Construct one and put it in Tauri managed state.
pub struct PairingGate {
    window: Mutex<Option<PairingWindow>>,
    pending: Mutex<HashMap<String, PendingPairing>>,
}

impl Default for PairingGate {
    fn default() -> Self {
        Self::new()
    }
}

impl PairingGate {
    pub fn new() -> Self {
        Self {
            window: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Open (or replace) the pairing window with `nonce`, valid for
    /// [`PAIRING_WINDOW_TTL`]. Called when the desktop advertises a fresh QR.
    pub fn open_window(&self, nonce: Vec<u8>) {
        if let Ok(mut w) = self.window.lock() {
            *w = Some(PairingWindow {
                nonce,
                expires_at: Instant::now() + PAIRING_WINDOW_TTL,
            });
        }
    }

    /// Consume (close) the window — called once a new device is confirmed, making
    /// the window single-use. Idempotent.
    pub fn close_window(&self) {
        if let Ok(mut w) = self.window.lock() {
            *w = None;
        }
    }

    /// The nonce of the currently-open, non-expired window, if any. Returns `None`
    /// (and eagerly clears an expired window) when no window is open — the signal
    /// the accept loop uses to know whether a NEW peer may even be entertained.
    /// A confirmed (already-trusted) peer is served regardless of the window; the
    /// window only gates FIRST pairings.
    pub fn active_nonce(&self) -> Option<Vec<u8>> {
        let mut guard = self.window.lock().ok()?;
        match guard.as_ref() {
            Some(w) if w.expires_at > Instant::now() => Some(w.nonce.clone()),
            Some(_) => {
                *guard = None; // lapsed → clear it
                None
            }
            None => None,
        }
    }

    /// Whether a pairing window is currently open (and not expired).
    pub fn window_is_open(&self) -> bool {
        self.active_nonce().is_some()
    }

    /// Register a pending pairing and return the receiver the caller awaits. The
    /// `request_id` is what the UI echoes back via `confirm_pairing`/`reject_pairing`.
    pub fn register_pending(
        &self,
        request_id: String,
        peer_key_b64: String,
    ) -> Result<oneshot::Receiver<bool>, String> {
        let (tx, rx) = oneshot::channel();
        let mut map = self
            .pending
            .lock()
            .map_err(|_| "pairing gate poisoned".to_string())?;
        map.insert(
            request_id,
            PendingPairing {
                responder: tx,
                peer_key_b64,
            },
        );
        Ok(rx)
    }

    /// Resolve a pending pairing by id with `accept`. Returns the peer's key when a
    /// matching request was found (so the caller can persist it on confirm), else
    /// `None` (already resolved / timed out / unknown id).
    pub fn resolve_pending(&self, request_id: &str, accept: bool) -> Option<String> {
        let mut map = self.pending.lock().ok()?;
        let entry = map.remove(request_id)?;
        // A receiver dropped (the awaiting connection already went away on timeout)
        // makes this send fail; that's harmless — nothing is left to serve.
        let _ = entry.responder.send(accept);
        Some(entry.peer_key_b64)
    }

    /// Drop a pending request without signalling (the awaiting side timed out or
    /// the connection died). Idempotent.
    pub fn forget_pending(&self, request_id: &str) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(request_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_window_means_no_active_nonce_and_closed() {
        let gate = PairingGate::new();
        assert!(gate.active_nonce().is_none());
        assert!(!gate.window_is_open());
    }

    #[test]
    fn open_window_exposes_its_nonce_until_consumed() {
        let gate = PairingGate::new();
        gate.open_window(vec![1, 2, 3]);
        assert!(gate.window_is_open());
        assert_eq!(gate.active_nonce().as_deref(), Some(&[1, 2, 3][..]));

        gate.close_window();
        assert!(!gate.window_is_open());
        assert!(gate.active_nonce().is_none());
    }

    #[test]
    fn an_expired_window_reads_as_closed_and_is_cleared() {
        let gate = PairingGate::new();
        // Open a window that is already expired (TTL in the past).
        if let Ok(mut w) = gate.window.lock() {
            *w = Some(PairingWindow {
                nonce: vec![9, 9],
                expires_at: Instant::now() - Duration::from_secs(1),
            });
        }
        assert!(
            !gate.window_is_open(),
            "an expired window must read as closed"
        );
        // And it was cleared, not left dangling.
        assert!(gate.window.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn confirm_resolves_the_pending_receiver_with_true_and_returns_the_key() {
        let gate = PairingGate::new();
        let rx = gate
            .register_pending("req-1".into(), "KEYB64".into())
            .unwrap();

        let key = gate.resolve_pending("req-1", true);
        assert_eq!(key.as_deref(), Some("KEYB64"));
        assert!(rx.await.unwrap(), "confirm must signal accept=true");
        // The entry is gone, so a second resolve is a no-op.
        assert!(gate.resolve_pending("req-1", true).is_none());
    }

    #[tokio::test]
    async fn reject_resolves_the_pending_receiver_with_false() {
        let gate = PairingGate::new();
        let rx = gate
            .register_pending("req-2".into(), "KEYB64".into())
            .unwrap();

        gate.resolve_pending("req-2", false);
        assert!(!rx.await.unwrap(), "reject must signal accept=false");
    }

    #[test]
    fn resolving_an_unknown_request_is_none() {
        let gate = PairingGate::new();
        assert!(gate.resolve_pending("nope", true).is_none());
    }

    #[tokio::test]
    async fn forget_pending_drops_the_sender_so_the_awaiter_errs() {
        let gate = PairingGate::new();
        let rx = gate.register_pending("req-3".into(), "K".into()).unwrap();
        gate.forget_pending("req-3");
        // The sender was dropped without a value → the receiver errors (the
        // serve path treats this as "dropped, do not serve").
        assert!(rx.await.is_err());
    }

    // ── serve-time trust decision (the gate's core, used by serve_connection) ──

    #[test]
    fn a_confirmed_device_is_always_served() {
        // Window state is irrelevant for a confirmed device (test d: reconnect
        // without re-confirmation, even outside any pairing window).
        assert_eq!(serve_decision(true, false), ServeDecision::Serve);
        assert_eq!(serve_decision(true, true), ServeDecision::Serve);
    }

    #[test]
    fn an_untrusted_device_outside_a_window_is_dropped() {
        // Test a: an untrusted peer with no open pairing window is dropped BEFORE
        // any command dispatch (the critical-fix path for a random off-LAN dialer).
        assert_eq!(serve_decision(false, false), ServeDecision::Drop);
    }

    #[test]
    fn an_untrusted_device_inside_a_window_is_prompted() {
        // Test b/c: an untrusted peer inside an open window is prompted (await the
        // desktop user's confirm/reject), never auto-served.
        assert_eq!(serve_decision(false, true), ServeDecision::Prompt);
    }

    // ── end-to-end gate flow over Db + PairingGate (no AppHandle/QUIC needed) ──
    //
    // These exercise the exact sequence `serve_connection` runs — decide, then
    // (for Prompt) register + await + persist — against a real in-memory Db, so the
    // serve/drop/persist outcomes are proven without standing up Tauri or iroh.

    use crate::db::Db;
    use std::path::Path;

    fn mem_db() -> Db {
        Db::open(Path::new(":memory:")).unwrap()
    }

    #[tokio::test]
    async fn untrusted_outside_window_drops_and_never_serves() {
        let db = mem_db();
        let gate = PairingGate::new();
        let pk = "PEER_A==";
        // No window open, device not confirmed → Drop, no dispatch, no persisted row.
        assert_eq!(
            serve_decision(db.is_device_confirmed(pk), gate.window_is_open()),
            ServeDecision::Drop
        );
        assert!(db.list_paired_devices().is_empty());
    }

    #[tokio::test]
    async fn untrusted_inside_window_confirmed_is_served_and_persisted() {
        let db = mem_db();
        let gate = PairingGate::new();
        let pk = "PEER_B==";
        gate.open_window(vec![1, 2, 3]);

        assert_eq!(
            serve_decision(db.is_device_confirmed(pk), gate.window_is_open()),
            ServeDecision::Prompt
        );
        let rx = gate.register_pending("req".into(), pk.into()).unwrap();

        // Simulate the confirm command: persist as confirmed + resolve the oneshot.
        let key = gate.resolve_pending("req", true).unwrap();
        db.confirm_paired_device(&key, "Phone", 100).unwrap();
        assert!(
            rx.await.unwrap(),
            "the served peer's await resolves accept=true"
        );

        // Served (true) AND the device is now confirmed-trusted for next time.
        assert!(db.is_device_confirmed(pk));
        assert!(db.list_paired_devices()[0].confirmed);
    }

    #[tokio::test]
    async fn untrusted_inside_window_rejected_is_dropped_and_not_persisted_as_trusted() {
        let db = mem_db();
        let gate = PairingGate::new();
        let pk = "PEER_C==";
        gate.open_window(vec![1, 2, 3]);

        let rx = gate.register_pending("req".into(), pk.into()).unwrap();
        // Simulate the reject command.
        gate.resolve_pending("req", false);
        // → serve_connection returns, no dispatch.
        assert!(
            !rx.await.unwrap(),
            "a rejected pairing resolves accept=false"
        );
        // Nothing was confirmed.
        assert!(!db.is_device_confirmed(pk));
    }

    #[tokio::test]
    async fn untrusted_inside_window_timeout_is_dropped() {
        let gate = PairingGate::new();
        gate.open_window(vec![1, 2, 3]);
        let rx = gate
            .register_pending("req".into(), "PEER_D==".into())
            .unwrap();

        // A 0ms timeout stands in for the real PAIRING_CONFIRM_TIMEOUT lapsing with
        // no user decision: the await errors → serve_connection drops the connection.
        let outcome = tokio::time::timeout(Duration::from_millis(0), rx).await;
        assert!(outcome.is_err(), "an un-answered pairing must time out");
        gate.forget_pending("req"); // serve_connection cleans up the stale entry
    }

    #[tokio::test]
    async fn a_confirmed_device_reconnects_without_a_window_or_reconfirmation() {
        let db = mem_db();
        let gate = PairingGate::new();
        let pk = "PEER_E==";
        // First pairing already confirmed this device.
        db.confirm_paired_device(pk, "Phone", 100).unwrap();

        // Reconnect: no pairing window open, yet the decision is Serve — no prompt,
        // no re-confirmation (test d).
        assert!(!gate.window_is_open());
        assert_eq!(
            serve_decision(db.is_device_confirmed(pk), gate.window_is_open()),
            ServeDecision::Serve
        );
    }
}
