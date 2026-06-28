//! Phone Sync — the transport layer's SHARED surface.
//!
//! This module holds the parts of the transport that are identical on every
//! platform: the protocol ALPN, the single-frame size cap, the length-framing
//! constants, and — the one real abstraction (§5.2) — the [`Transport`] trait
//! the session loop dials through. The platform-specific halves live in:
//!
//!   * [`super::transport_native`] (`#[cfg(not(target_arch = "wasm32"))]`) — the
//!     iroh `Endpoint`/`Connection` dial code + `SecureChannel`, moved verbatim
//!     from the old `src-tauri/src/sync/transport.rs`.
//!   * [`super::transport_wasm`] (`#[cfg(target_arch = "wasm32")]`) — the
//!     relay-only browser endpoint (a compiling skeleton; full impl is Phase 2).
//!
//! Handshake + every frame are length-prefixed (4-byte big-endian) over the
//! transport stream, so the relay only ever sees ciphertext. See
//! docs/PHONE_SYNC_PLAN.md and docs/IOS_WEB_CLIENT_PLAN.md §5.2.

/// ALPN identifying the Phone Sync protocol on the QUIC connection. Shared so the
/// native dialer and the browser dialer negotiate the SAME protocol against the
/// desktop responder.
pub const ALPN: &[u8] = b"porthex/phone-sync/0";

/// Hard cap on a single framed message, to refuse a hostile length prefix before
/// allocating. A Noise message (handshake or transport) is ≤ 65535 bytes incl.
/// the AEAD tag, so this sits above any legitimate single frame.
///
/// CARRY-FORWARD: a `SyncFrame` whose JSON exceeds ~65519 bytes (e.g. a large
/// `MessageDelta`) can't be sent as one Noise message — `noise::Transport::write`
/// will error. Chunking large frames is a later-increment task; today's frames
/// (acks, single events, small deltas) are well under the limit.
pub const MAX_FRAME: usize = 128 * 1024;

use crate::pairing::PairingPayload;

/// Dial-and-pair: the one abstraction the session loop talks to so it is
/// transport-agnostic (§5.2). Native and browser implementations both run the
/// SAME Noise XX/KK handshake on top of their respective iroh stream, so the
/// `Paired` surface they return is identical and `session.rs` never learns which
/// transport produced it.
///
/// `Send` note: browser futures are `!Send`, so the trait is cfg-gated —
/// `async_trait` (Send futures) on native, `async_trait(?Send)` on wasm. A caller
/// that needs `dyn Transport` therefore gets the right bound for its platform;
/// callers that can stay generic (`T: Transport`, static dispatch) avoid `dyn`
/// entirely. See §5.2's `Send`/`!Send` discussion.
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait Transport {
    /// The established, split-able secure channel this transport yields. On native
    /// this is the iroh-backed `SecureChannel`; on wasm it is the browser
    /// channel. Both implement the `session` frame-channel traits.
    type Channel;

    /// Dial a peer by its pinned node identity + relay (carried in `payload`), run
    /// the Noise XX (first pairing) or KK (`reconnect`) handshake, and return an
    /// established secure channel plus the SAS to compare out-of-band and the
    /// peer's pinned static key.
    async fn connect(
        &self,
        payload: &PairingPayload,
        reconnect: bool,
    ) -> Result<Paired<Self::Channel>, String>;
}

/// A paired, end-to-end-encrypted channel plus the pairing metadata the caller
/// needs (the SAS to compare out-of-band, the peer's pinned static key). Generic
/// over the channel type so it is shared by both transports; the native dialer
/// builds `Paired<SecureChannel>`.
pub struct Paired<C> {
    pub channel: C,
    /// Short Authentication String. The desktop surfaces it to the pairing UI for
    /// out-of-band comparison before confirming an untrusted device; the phone
    /// returns it from `phone_sync_connect` for the same comparison on its end.
    pub sas: String,
    /// The peer's pinned Noise static public key, the identity the device-trust
    /// gate keys off (confirmed vs. not). `None` only if the handshake never
    /// received it (a malformed/aborted handshake), which the serve path rejects.
    pub peer_static: Option<Vec<u8>>,
}
