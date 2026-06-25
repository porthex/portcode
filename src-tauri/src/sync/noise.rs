//! Phone Sync Noise crypto — re-export shim.
//!
//! Phase 1 of `docs/IOS_WEB_CLIENT_PLAN.md` (§5.1) moved the application-layer
//! Noise handshake (snow, pure-Rust resolver → wasm-safe) into the shared
//! `portcode-sync` crate. Re-exported here so every existing
//! `crate::sync::noise::…` path (e.g. `StaticKeypair` in `sync::pairing` and the
//! pairing/transport flows in `lib.rs`) keeps resolving unchanged.

pub use portcode_sync::noise::{Handshake, StaticKeypair, Transport};
