//! Phone Sync — Phase 1b: desktop device identity + pairing advertisement.
//!
//! Phase 1 of `docs/IOS_WEB_CLIENT_PLAN.md` (§5.1) moved the wasm-safe
//! [`PairingPayload`] QR/wire type into the shared `portcode-sync` crate (it is
//! re-exported below). The two helpers that read the OS credential store via
//! `crate::secrets` — `device_identity()` and `iroh_node_addr()` — are
//! desktop-only and stay here.
//!
//! `device_identity()` loads (or, on first run, generates + persists) the
//! desktop's long-term Noise static keypair. [`PairingPayload`] is the content a
//! desktop renders as a QR code for a phone to scan to start pairing — the static
//! public key, a fresh nonce binding the attempt, and the desktop's dialable iroh
//! node address so the phone knows *where* to connect.

use iroh::EndpointAddr;

use crate::secrets;
use crate::sync::noise::StaticKeypair;

/// The pairing QR/wire payload, now defined in the shared crate. Re-exported so
/// every existing `sync::pairing::PairingPayload` path (in `lib.rs`) is unchanged.
pub use portcode_sync::pairing::PairingPayload;

/// Load the device's long-term Noise identity, creating + persisting it on first
/// run. The private key lives only in the OS credential store.
pub fn device_identity() -> Result<StaticKeypair, String> {
    if let Some((public, private)) = secrets::get_device_key() {
        return Ok(StaticKeypair::from_parts(public, private));
    }
    let kp = StaticKeypair::generate()?;
    secrets::set_device_key(&kp.public, kp.private_key())?;
    Ok(kp)
}

/// The desktop's dialable iroh address, derived from its persisted node key.
/// Identity-only (no inline relay/direct addrs): with n0 discovery the phone
/// resolves the live addresses from the `EndpointId`. Synchronous — no live
/// endpoint needed, so it can be built at pairing time before the listener binds.
pub fn iroh_node_addr() -> Result<EndpointAddr, String> {
    Ok(EndpointAddr::new(
        secrets::get_or_create_iroh_key()?.public(),
    ))
}
