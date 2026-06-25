//! Phone Sync — the BROWSER (wasm32) iroh transport — COMPILING SKELETON.
//!
//! `#[cfg(target_arch = "wasm32")]`-only. This is the relay-only sibling of
//! [`super::transport_native`]: in the browser iroh has no UDP and cannot
//! hole-punch, so every byte rides an iroh **relay over a WebSocket** (still
//! end-to-end encrypted — the relay forwards opaque ciphertext). It is built with
//! `iroh = { default-features = false }` (drops `metrics`, which breaks wasm) and
//! `relay_mode` forced on, configured with our relay URL from the
//! [`PairingPayload`].
//!
//! Phase 1 SCOPE: this file only has to *compile for wasm32* and implement the
//! [`Transport`] trait signature so the workspace split is real. The actual dial,
//! Noise handshake, and frame plumbing are Phase 2 (§5.2 / the roadmap's "WASM
//! transport + interop" milestone), so the channel bodies are `todo!()` stubs.
//! They are never reached today: no wasm consumer drives them until `portcode-wasm`
//! lands. The Noise handshake itself (`super::noise`) already compiles to wasm
//! unchanged; only the iroh stream plumbing below remains.

use async_trait::async_trait;

use crate::pairing::PairingPayload;
use crate::protocol::SyncFrame;
use crate::transport::{Paired, Transport};

/// Browser-side established channel. Mirrors the native `SecureChannel`'s surface
/// (`send_frame` / `recv_frame` / `split`) so `session.rs`'s frame-channel traits
/// (`FrameSink`/`FrameSource`) are implementable against it identically. Holds no
/// fields yet — the iroh browser endpoint/stream wiring is Phase 2.
pub struct SecureChannel {
    // Phase 2: the iroh relay-only `Connection` + bi-stream halves + the
    // `Arc<Mutex<noise::Transport>>`, exactly as in `transport_native::SecureChannel`.
    _private: (),
}

impl SecureChannel {
    /// Encrypt + send one `SyncFrame`. (Phase 2.)
    pub async fn send_frame(&mut self, _frame: &SyncFrame) -> Result<(), String> {
        todo!("Phase 2: browser iroh send over the relay WebSocket")
    }

    /// Receive + decrypt one `SyncFrame`. (Phase 2.)
    pub async fn recv_frame(&mut self) -> Result<SyncFrame, String> {
        todo!("Phase 2: browser iroh recv over the relay WebSocket")
    }

    /// Split into independent send/recv halves (Phase 2), mirroring the native
    /// channel so the same concurrent forward/intake loops run unchanged.
    pub fn split(self) -> (ChannelSender, ChannelReceiver) {
        todo!("Phase 2: split the browser channel into send/recv halves")
    }
}

/// Send half of a split browser [`SecureChannel`]. (Phase 2.)
pub struct ChannelSender {
    _private: (),
}

impl ChannelSender {
    pub async fn send_frame(&mut self, _frame: &SyncFrame) -> Result<(), String> {
        todo!("Phase 2: browser iroh send half")
    }
}

/// Receive half of a split browser [`SecureChannel`]. (Phase 2.)
pub struct ChannelReceiver {
    _private: (),
}

impl ChannelReceiver {
    pub async fn recv_frame(&mut self) -> Result<SyncFrame, String> {
        todo!("Phase 2: browser iroh recv half")
    }
}

/// The browser transport. Holds the relay configuration + the local Noise
/// identity once wired (Phase 2). Implements the shared [`Transport`] trait so the
/// session loop dials through it exactly as it dials the native transport.
pub struct WasmTransport {
    // Phase 2: local Noise static private key + the configured relay URL + a
    // lazily-bound relay-only iroh `Endpoint`.
    _private: (),
}

impl WasmTransport {
    /// Construct a browser transport. (Phase 2 fills in the relay/identity wiring;
    /// today it is an inert placeholder so the type + trait impl compile.)
    pub fn new() -> Self {
        Self { _private: () }
    }
}

impl Default for WasmTransport {
    fn default() -> Self {
        Self::new()
    }
}

// `async_trait(?Send)` because browser futures are `!Send` (§5.2). The cfg-gated
// trait definition in `transport.rs` already selects this variant for wasm, so we
// match it here.
#[async_trait(?Send)]
impl Transport for WasmTransport {
    type Channel = SecureChannel;

    async fn connect(
        &self,
        _payload: &PairingPayload,
        _reconnect: bool,
    ) -> Result<Paired<Self::Channel>, String> {
        // Phase 2: build a relay-only iroh endpoint (`default-features = false`,
        // relay_mode forced, configured with `_payload.node_addr` + the relay
        // URL), open a bi-stream, run `noise::Handshake::xx_initiator` (or
        // `kk_initiator` when `_reconnect`), and return the paired channel + SAS +
        // pinned peer key — the SAME `Paired` surface the native transport yields.
        todo!("Phase 2: browser relay-only dial + Noise handshake")
    }
}
