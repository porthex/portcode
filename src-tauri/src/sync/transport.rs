//! Phone Sync transport — re-export shim.
//!
//! Phase 1 of `docs/IOS_WEB_CLIENT_PLAN.md` (§5.1) moved the iroh QUIC transport
//! into the shared `portcode-sync` crate so the same code compiles for the future
//! wasm browser client. The desktop links the crate's NATIVE transport
//! (`portcode_sync::transport_native`, selected automatically off wasm) and names
//! the same types through this module, so every existing `crate::sync::transport::…`
//! path in `lib.rs`/`server.rs`/`client.rs` keeps resolving unchanged.

// Full-surface compatibility re-export (see noise.rs); `#[allow(unused_imports)]`
// because the channel half-types aren't named directly by src-tauri under
// `-D warnings`.
#[allow(unused_imports)]
pub use portcode_sync::transport_native::{
    accept_and_pair, build_endpoint, connect_and_pair, ChannelReceiver, ChannelSender,
    SecureChannel,
};

/// The crate's `Paired` is generic over the channel type (so it is shared by the
/// native + wasm transports). On desktop the channel is always the native iroh
/// [`SecureChannel`], so this alias lets every existing `sync::transport::Paired`
/// path stay a bare name (e.g. `serve_connection`'s parameter) without spelling
/// the generic.
pub type Paired = portcode_sync::transport::Paired<SecureChannel>;
