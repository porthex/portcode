//! `portcode-sync` — the shared Phone Sync protocol, crypto, session loop, and
//! transport, extracted so it builds for BOTH native (desktop) and `wasm32` (the
//! iroh-in-browser PWA client) from one source of truth. See
//! `docs/IOS_WEB_CLIENT_PLAN.md` §5.1.
//!
//! Layout (§5.1):
//! - [`wire`] — the pure-serde DTOs the protocol moves (`Block`, `ChatMessage`,
//!   `StreamEvent`, `SessionRow`, `MessageRow`); `src-tauri` re-exports these
//!   from `llm`/`db`.
//! - [`protocol`] — the `SyncFrame`/`RemoteCommand`/`Cursor` wire types.
//! - [`noise`] — the application-layer Noise XX/KK handshake (snow, pure-Rust
//!   resolver → wasm-safe).
//! - [`pairing`] — the `PairingPayload` QR/wire format.
//! - [`session`] — the transport-agnostic catch-up + live loops.
//! - [`transport`] — the shared `Transport` trait + framing constants.
//! - `transport_native` (native) / `transport_wasm` (wasm) — the iroh dial code.
//!
//! Native-only modules are gated off the wasm build so the browser target never
//! pulls in tokio `net`/`rt`/`time` or the native iroh `Endpoint`.

pub mod noise;
pub mod pairing;
pub mod protocol;
pub mod session;
pub mod transport;
pub mod wire;

#[cfg(not(target_arch = "wasm32"))]
pub mod transport_native;
#[cfg(target_arch = "wasm32")]
pub mod transport_wasm;

// Convenience re-exports so consumers can name the concrete channel/dial API
// without caring which transport module a given build selected. `src-tauri`
// imports these (e.g. `portcode_sync::SecureChannel`, `connect_and_pair`).
#[cfg(not(target_arch = "wasm32"))]
pub use transport_native::{
    accept_and_pair, build_endpoint, connect_and_pair, ChannelReceiver, ChannelSender,
    SecureChannel,
};

#[cfg(target_arch = "wasm32")]
pub use transport_wasm::{ChannelReceiver, ChannelSender, SecureChannel, WasmTransport};
