//! Phone Sync — Phase 1b: the pairing advertisement payload.
//!
//! [`PairingPayload`] is the content a desktop renders as a QR code for a phone
//! to scan to start pairing — the static public key, a fresh nonce binding the
//! attempt, and the desktop's dialable iroh node address so the phone knows
//! *where* to connect.
//!
//! The QR is an *out-of-band channel*, not a secret: it carries the public key, a
//! nonce, and the public node address. The actual mutually-authenticated XX
//! handshake that consumes it (and the SAS the user compares) runs over the
//! transport in Phase 2. See docs/PHONE_SYNC_PLAN.md.
//!
//! NOTE: the desktop-only `device_identity()` / `iroh_node_addr()` helpers (which
//! read the OS credential store via `crate::secrets`) stay in `src-tauri`'s
//! `sync::pairing`; only this wasm-safe payload type moved into `portcode-sync`.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use iroh::EndpointAddr;
use serde::{Deserialize, Serialize};

/// QR/wire format version so a phone can refuse an incompatible pairing format.
const PAIRING_VERSION: u32 = 1;

/// What a desktop shows as a QR code (and a phone scans) to start pairing.
/// `Deserialize` is for the phone-side decode (Phase 2) and the round-trip test —
/// don't strip it as "unused".
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairingPayload {
    pub version: u32,
    /// base64 of the desktop's Curve25519 static public key.
    pub public_key: String,
    /// base64 random nonce, anti-replay for this pairing attempt.
    pub nonce: String,
    /// The desktop's dialable iroh node address — the phone deserializes this
    /// straight into an [`iroh::EndpointAddr`] to dial. Carries the persisted
    /// `EndpointId`; with n0 discovery the phone resolves the live relay/direct
    /// addresses from the id alone, so an identity-only address is enough to dial.
    pub node_addr: EndpointAddr,
}

impl PairingPayload {
    /// Build a payload from raw public-key + nonce bytes and the desktop's node
    /// address.
    pub fn new(public_key: &[u8], nonce: &[u8], node_addr: EndpointAddr) -> Self {
        Self {
            version: PAIRING_VERSION,
            public_key: B64.encode(public_key),
            nonce: B64.encode(nonce),
            node_addr,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::SecretKey;

    fn sample_addr() -> EndpointAddr {
        EndpointAddr::new(SecretKey::generate().public())
    }

    #[test]
    fn pairing_payload_encodes_key_and_nonce_and_round_trips() {
        let pubkey = vec![1u8, 2, 3, 4, 250, 255];
        let nonce = vec![9u8, 8, 7, 6];
        let p = PairingPayload::new(&pubkey, &nonce, sample_addr());

        assert_eq!(p.version, PAIRING_VERSION);
        assert_eq!(B64.decode(&p.public_key).unwrap(), pubkey);
        assert_eq!(B64.decode(&p.nonce).unwrap(), nonce);

        let json = serde_json::to_string(&p).unwrap();
        let back: PairingPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(back.version, p.version);
        assert_eq!(back.public_key, p.public_key);
        assert_eq!(back.nonce, p.nonce);
    }

    // The dialable node address is what lets the phone *find* the desktop, so it
    // must survive the QR JSON round-trip intact (the phone deserializes the whole
    // payload and dials `node_addr`). Build an address from a fresh node key, push
    // it through serde, and assert it comes back equal.
    #[test]
    fn pairing_payload_carries_node_addr_through_json_round_trip() {
        let addr = sample_addr();
        let p = PairingPayload::new(&[1, 2, 3], &[4, 5, 6], addr.clone());
        assert_eq!(p.node_addr, addr);

        let json = serde_json::to_string(&p).unwrap();
        let back: PairingPayload = serde_json::from_str(&json).unwrap();
        // The phone can reconstruct the exact iroh address it needs to dial.
        assert_eq!(back.node_addr, addr);
        assert_eq!(back.node_addr.id, addr.id);
    }
}
