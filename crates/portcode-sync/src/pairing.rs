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

/// The n0 public production relay (§5.5). When a [`PairingPayload`] carries no
/// explicit `relay_url` (a desktop that emitted the QR before this field existed,
/// or one that relies on n0 discovery resolving the relay from the node id), the
/// browser dialer falls back to this so it still has a relay to ride. Documented
/// here so the default is auditable and pinnable when the product moves to a
/// self-hosted relay (§5.5). Matches the value the Phase 0 spike printed for the
/// phone.
pub const DEFAULT_RELAY_URL: &str = "https://relay.iroh.network./";

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
    /// The iroh relay URL the browser client should dial through (§5.5). The
    /// browser is relay-only (no UDP/hole-punch), so it needs a relay to reach the
    /// desktop. Optional + `#[serde(default)]` for backward compatibility: a
    /// desktop that emitted a QR before this field existed simply omits it, and the
    /// browser falls back to [`DEFAULT_RELAY_URL`] (see
    /// [`PairingPayload::relay_url_or_default`]). The desktop emit side therefore
    /// needs no change to keep compiling, and the existing native flow — which
    /// ignores this field entirely — is untouched.
    #[serde(default)]
    pub relay_url: Option<String>,
}

impl PairingPayload {
    /// Build a payload from raw public-key + nonce bytes and the desktop's node
    /// address. The relay URL defaults to `None` (the browser will fall back to
    /// [`DEFAULT_RELAY_URL`]); use [`PairingPayload::with_relay_url`] to pin one.
    pub fn new(public_key: &[u8], nonce: &[u8], node_addr: EndpointAddr) -> Self {
        Self {
            version: PAIRING_VERSION,
            public_key: B64.encode(public_key),
            nonce: B64.encode(nonce),
            node_addr,
            relay_url: None,
        }
    }

    /// Attach the relay URL the browser client should dial through (§5.5).
    pub fn with_relay_url(mut self, relay_url: impl Into<String>) -> Self {
        self.relay_url = Some(relay_url.into());
        self
    }

    /// The relay URL to dial, falling back to [`DEFAULT_RELAY_URL`] when the
    /// payload carries none (a pre-`relay_url` desktop, or one leaning on n0
    /// discovery). The browser transport calls this to decide which relay to ride.
    pub fn relay_url_or_default(&self) -> &str {
        self.relay_url.as_deref().unwrap_or(DEFAULT_RELAY_URL)
    }

    /// Resolve the [`EndpointAddr`] the browser should actually dial, applying the
    /// relay policy (H3): the desktop's `node_addr` (from its live `ep.addr()`)
    /// already carries its REAL home relay as a `TransportAddr::Relay`. Because
    /// [`EndpointAddr::with_relay_url`] *adds* to the address's relay set rather than
    /// replacing it, blindly inserting [`DEFAULT_RELAY_URL`] (or the payload's
    /// `relay_url`) would advertise a SECOND, possibly-wrong relay alongside the
    /// desktop's actual one — which can route a relay-only browser dial to a relay
    /// the desktop never registered with and time the attempt out.
    ///
    /// So we add a relay ONLY when `node_addr` advertises none of its own:
    ///   * `node_addr` already has a relay → dial it AS-IS (trust the desktop's live
    ///     home relay; never override or duplicate it).
    ///   * `node_addr` has no relay → fall back to the payload's `relay_url`, else
    ///     [`DEFAULT_RELAY_URL`], so a relay-only browser still has a path.
    ///
    /// Returns the dialable address, or an `Err` if the fallback relay URL can't be
    /// parsed. Pure (no I/O) so it is unit-testable on every target.
    pub fn dial_addr(&self) -> Result<EndpointAddr, String> {
        let addr = self.node_addr.clone();
        if addr.relay_urls().next().is_some() {
            // The desktop advertised its own relay — dial exactly what it gave us.
            return Ok(addr);
        }
        let relay_url: iroh::RelayUrl = self
            .relay_url_or_default()
            .parse()
            .map_err(|e| format!("bad relay url: {e}"))?;
        Ok(addr.with_relay_url(relay_url))
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

    // The relay URL is what the browser client dials through (§5.5). When set it
    // must survive the QR JSON round-trip; when absent the browser falls back to
    // the documented n0 default rather than failing.
    #[test]
    fn relay_url_round_trips_and_defaults_when_absent() {
        // Explicit relay survives the round-trip and is returned verbatim.
        let p = PairingPayload::new(&[1, 2, 3], &[4, 5, 6], sample_addr())
            .with_relay_url("https://relay.example.com./");
        assert_eq!(p.relay_url.as_deref(), Some("https://relay.example.com./"));
        let back: PairingPayload =
            serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(
            back.relay_url.as_deref(),
            Some("https://relay.example.com./")
        );
        assert_eq!(back.relay_url_or_default(), "https://relay.example.com./");

        // No relay set → falls back to the documented default.
        let bare = PairingPayload::new(&[1], &[2], sample_addr());
        assert_eq!(bare.relay_url, None);
        assert_eq!(bare.relay_url_or_default(), DEFAULT_RELAY_URL);
    }

    // H3 — relay policy. The desktop's QR carries `node_addr = ep.addr()`, which
    // already includes the desktop's REAL home relay. The browser must dial THAT
    // relay, not duplicate/override it with the hardcoded default. `dial_addr` must
    // therefore leave an address that already has a relay untouched.
    #[test]
    fn dial_addr_keeps_the_node_addrs_own_relay_and_does_not_add_the_default() {
        let real_relay: iroh::RelayUrl = "https://relay.real-home.example./".parse().unwrap();
        let addr = sample_addr().with_relay_url(real_relay.clone());
        // Even with a DIFFERENT payload relay_url set, an address that already
        // advertises its own relay is dialed as-is — we never override the live one.
        let p = PairingPayload::new(&[1, 2, 3], &[4, 5, 6], addr.clone())
            .with_relay_url("https://relay.iroh.network./");

        let dial = p.dial_addr().unwrap();
        let relays: Vec<_> = dial.relay_urls().cloned().collect();
        assert_eq!(
            relays,
            vec![real_relay],
            "an address with its own relay must be dialed unchanged — no default added, no override"
        );
        assert_eq!(dial.id, addr.id);
    }

    // When the desktop's `node_addr` carries NO relay (identity-only QR — e.g. the
    // listener wasn't bound yet when the QR was built), the browser still needs a
    // relay to ride, so `dial_addr` falls back: the payload's `relay_url` if set,
    // else the documented n0 default.
    #[test]
    fn dial_addr_adds_a_fallback_relay_only_when_the_node_addr_has_none() {
        // No relay anywhere → the n0 default is added so a relay-only browser can dial.
        let bare = PairingPayload::new(&[1], &[2], sample_addr());
        let dial = bare.dial_addr().unwrap();
        let relays: Vec<String> = dial.relay_urls().map(|u| u.to_string()).collect();
        assert_eq!(relays, vec![DEFAULT_RELAY_URL.to_string()]);

        // No relay on the addr, but the payload pins one → that pinned relay is used.
        let pinned = PairingPayload::new(&[1], &[2], sample_addr())
            .with_relay_url("https://relay.example.com./");
        let dial = pinned.dial_addr().unwrap();
        let relays: Vec<String> = dial.relay_urls().map(|u| u.to_string()).collect();
        assert_eq!(relays, vec!["https://relay.example.com./".to_string()]);
    }

    // Backward compatibility (the load-bearing constraint of work item 3): a QR
    // emitted by a desktop BEFORE the `relay_url` field existed has no `relayUrl`
    // key at all. `#[serde(default)]` must let the phone still decode it, with the
    // relay defaulting rather than the deserialize erroring — so the desktop emit
    // side needs no change to keep working.
    #[test]
    fn legacy_payload_without_relay_url_key_still_decodes() {
        let addr = sample_addr();
        let legacy = serde_json::json!({
            "version": PAIRING_VERSION,
            "publicKey": B64.encode([7u8, 8, 9]),
            "nonce": B64.encode([1u8, 2]),
            "nodeAddr": addr,
            // NOTE: no "relayUrl" key — this is the pre-field wire shape.
        });
        let back: PairingPayload = serde_json::from_value(legacy).unwrap();
        assert_eq!(back.relay_url, None);
        assert_eq!(back.relay_url_or_default(), DEFAULT_RELAY_URL);
        assert_eq!(back.node_addr.id, addr.id);
    }
}
