//! Phone Sync — Phase 1: the application-layer Noise session.
//!
//! Runs an end-to-end Noise handshake that will sit on top of (Phase 2) iroh's
//! transport, so the relay only ever sees ciphertext — it can never read your
//! code or session. `snow` (v0.10) provides `Noise_*_25519_ChaChaPoly_BLAKE2s`:
//! Curve25519 DH, ChaCha20-Poly1305 AEAD (fast on phones without AES hardware),
//! BLAKE2s hashing.
//!
//! Pairing uses **XX** (neither side knows the other's static key yet); the peer's
//! static public key is then pinned and **KK** is used for fast, mutually-
//! authenticated reconnects. The handshake hash yields a Short Authentication
//! String (SAS) the user compares out-of-band (QR when co-present) to defeat a
//! man-in-the-middle.
//!
//! No transport/network is wired here yet (Phase 2). `StaticKeypair::generate` is
//! consumed by the Phase 1b pairing flow, but the `Handshake`/`Transport` halves
//! aren't driven by non-test code until Phase 2 wires the transport — hence the
//! module-wide `dead_code` allowance, which comes off then. See
//! docs/PHONE_SYNC_PLAN.md.
#![allow(dead_code)]

use snow::params::NoiseParams;
use snow::{Builder, HandshakeState, TransportState};
use zeroize::Zeroize;

/// First-pairing pattern: neither device knows the other's static key yet.
const XX_PARAMS: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
/// Reconnect pattern: both sides have already pinned each other's static key.
const KK_PARAMS: &str = "Noise_KK_25519_ChaChaPoly_BLAKE2s";

/// Bytes of the handshake hash folded into the short auth string. 5 bytes (40
/// bits, rendered "aa bb cc dd ee") suits the primary QR / co-present comparison
/// flow; raise it if a typed/voice comparison path is added. This tunes
/// MITM-detection ergonomics only — it does not affect the channel's secrecy.
const SAS_BYTES: usize = 5;
/// Noise spec MAXMSGLEN — every message fits, so one fixed buffer always works.
const MAX_MSG: usize = 65535;

fn parse_params(spec: &str) -> Result<NoiseParams, String> {
    spec.parse::<NoiseParams>().map_err(|e| e.to_string())
}

fn err(e: snow::Error) -> String {
    e.to_string()
}

/// A device's long-term static identity (Curve25519). `public` is the stable id a
/// peer pins; `private` lives only in the OS credential store, never on disk.
/// Intentionally NOT `Debug`/`Serialize` — the private half must never land in a
/// log line or get serialized by accident.
#[derive(Clone)]
pub struct StaticKeypair {
    pub public: Vec<u8>,
    pub private: Vec<u8>,
}

impl StaticKeypair {
    /// Generate a fresh static identity from the OS CSPRNG (via getrandom).
    pub fn generate() -> Result<Self, String> {
        let kp = Builder::new(parse_params(XX_PARAMS)?)
            .generate_keypair()
            .map_err(err)?;
        Ok(Self {
            public: kp.public,
            private: kp.private,
        })
    }
}

/// Zero the private key bytes on drop so the long-term secret doesn't linger in
/// freed heap memory (crash dumps, swap, a process-memory scrape).
impl Drop for StaticKeypair {
    fn drop(&mut self) {
        self.private.zeroize();
    }
}

/// One side of an in-progress Noise handshake.
pub struct Handshake {
    state: HandshakeState,
}

impl Handshake {
    /// First-pairing initiator (writes the first message).
    pub fn xx_initiator(local_private: &[u8]) -> Result<Self, String> {
        Self::build(XX_PARAMS, local_private, None, true)
    }
    /// First-pairing responder.
    pub fn xx_responder(local_private: &[u8]) -> Result<Self, String> {
        Self::build(XX_PARAMS, local_private, None, false)
    }
    /// Reconnect initiator — the peer's static key must already be pinned.
    pub fn kk_initiator(local_private: &[u8], remote_public: &[u8]) -> Result<Self, String> {
        Self::build(KK_PARAMS, local_private, Some(remote_public), true)
    }
    /// Reconnect responder — the peer's static key must already be pinned.
    pub fn kk_responder(local_private: &[u8], remote_public: &[u8]) -> Result<Self, String> {
        Self::build(KK_PARAMS, local_private, Some(remote_public), false)
    }

    fn build(
        spec: &str,
        local_private: &[u8],
        remote_public: Option<&[u8]>,
        initiator: bool,
    ) -> Result<Self, String> {
        // snow 0.10: the key setters return `Result<Builder, _>`, so `?` each one
        // (older snow returned a bare `Self`).
        let mut builder = Builder::new(parse_params(spec)?)
            .local_private_key(local_private)
            .map_err(err)?;
        if let Some(rp) = remote_public {
            builder = builder.remote_public_key(rp).map_err(err)?;
        }
        let state = if initiator {
            builder.build_initiator().map_err(err)?
        } else {
            builder.build_responder().map_err(err)?
        };
        Ok(Self { state })
    }

    /// Write the next handshake message; returns the bytes to send to the peer.
    pub fn write(&mut self, payload: &[u8]) -> Result<Vec<u8>, String> {
        let mut buf = vec![0u8; MAX_MSG];
        let len = self.state.write_message(payload, &mut buf).map_err(err)?;
        buf.truncate(len);
        Ok(buf)
    }

    /// Read a handshake message from the peer; returns the decrypted payload.
    pub fn read(&mut self, message: &[u8]) -> Result<Vec<u8>, String> {
        let mut buf = vec![0u8; MAX_MSG];
        let len = self.state.read_message(message, &mut buf).map_err(err)?;
        buf.truncate(len);
        Ok(buf)
    }

    pub fn is_finished(&self) -> bool {
        self.state.is_handshake_finished()
    }

    /// The peer's static public key, once it has been received (`None` before
    /// then). Persist this after an XX pairing to enable KK reconnects.
    pub fn remote_static(&self) -> Option<Vec<u8>> {
        self.state.get_remote_static().map(<[u8]>::to_vec)
    }

    /// Short Authentication String derived from the handshake hash. Identical on
    /// both peers iff there was no MITM; the user compares it out-of-band (QR /
    /// voice). Capture this BEFORE [`Handshake::into_transport`], which consumes
    /// the handshake state.
    pub fn sas(&self) -> String {
        sas_from_hash(self.state.get_handshake_hash())
    }

    /// Finish the handshake and switch to the encrypted transport channel.
    ///
    /// Consumes the handshake — after an XX pairing, call [`Handshake::sas`] and
    /// [`Handshake::remote_static`] FIRST: the peer's pinned key and the SAS are
    /// not recoverable from the returned [`Transport`].
    pub fn into_transport(self) -> Result<Transport, String> {
        Ok(Transport {
            state: self.state.into_transport_mode().map_err(err)?,
        })
    }
}

/// An established, encrypted Noise channel.
pub struct Transport {
    state: TransportState,
}

impl Transport {
    /// Encrypt `plaintext`; returns the ciphertext to send.
    pub fn write(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let mut buf = vec![0u8; MAX_MSG];
        let len = self.state.write_message(plaintext, &mut buf).map_err(err)?;
        buf.truncate(len);
        Ok(buf)
    }

    /// Decrypt a received ciphertext; returns the plaintext.
    pub fn read(&mut self, message: &[u8]) -> Result<Vec<u8>, String> {
        let mut buf = vec![0u8; MAX_MSG];
        let len = self.state.read_message(message, &mut buf).map_err(err)?;
        buf.truncate(len);
        Ok(buf)
    }
}

/// Render the first `SAS_BYTES` of the (32-byte BLAKE2s) handshake hash as a
/// grouped hex code — short, stable, and identical on both honest peers.
fn sas_from_hash(hash: &[u8]) -> String {
    hash.iter()
        .take(SAS_BYTES)
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive a 3-message XX handshake to completion.
    fn run_xx(ini: &mut Handshake, res: &mut Handshake) {
        let m1 = ini.write(&[]).unwrap(); // -> e
        res.read(&m1).unwrap();
        let m2 = res.write(&[]).unwrap(); // <- e, ee, s, es
        ini.read(&m2).unwrap();
        let m3 = ini.write(&[]).unwrap(); // -> s, se
        res.read(&m3).unwrap();
    }

    /// Drive a 2-message KK handshake to completion.
    fn run_kk(ini: &mut Handshake, res: &mut Handshake) {
        let m1 = ini.write(&[]).unwrap(); // -> e, es, ss
        res.read(&m1).unwrap();
        let m2 = res.write(&[]).unwrap(); // <- e, ee, se
        ini.read(&m2).unwrap();
    }

    #[test]
    fn generate_produces_distinct_32_byte_curve25519_keys() {
        let kp = StaticKeypair::generate().unwrap();
        assert_eq!(kp.public.len(), 32);
        assert_eq!(kp.private.len(), 32);
        // fresh randomness each call (bind kp2 — StaticKeypair impls Drop, so a
        // field can't be moved out of a temporary).
        let kp2 = StaticKeypair::generate().unwrap();
        assert_ne!(kp.private, kp2.private);
    }

    #[test]
    fn xx_pairing_completes_pins_peer_keys_and_agrees_on_sas() {
        let a = StaticKeypair::generate().unwrap();
        let b = StaticKeypair::generate().unwrap();
        let mut ini = Handshake::xx_initiator(&a.private).unwrap();
        let mut res = Handshake::xx_responder(&b.private).unwrap();

        run_xx(&mut ini, &mut res);

        assert!(ini.is_finished() && res.is_finished());
        // each side learned the other's static public key
        assert_eq!(ini.remote_static().as_deref(), Some(b.public.as_slice()));
        assert_eq!(res.remote_static().as_deref(), Some(a.public.as_slice()));
        // and derived the same SAS (no MITM)
        assert_eq!(ini.sas(), res.sas());
        assert!(!ini.sas().is_empty());
    }

    #[test]
    fn transport_round_trips_in_both_directions_after_xx() {
        let a = StaticKeypair::generate().unwrap();
        let b = StaticKeypair::generate().unwrap();
        let mut ini = Handshake::xx_initiator(&a.private).unwrap();
        let mut res = Handshake::xx_responder(&b.private).unwrap();
        run_xx(&mut ini, &mut res);

        let mut it = ini.into_transport().unwrap();
        let mut rt = res.into_transport().unwrap();

        let pt = b"hello phone".to_vec();
        let ct = it.write(&pt).unwrap();
        assert_eq!(ct.len(), pt.len() + 16); // plaintext + 16-byte AEAD tag
        assert_eq!(rt.read(&ct).unwrap(), pt);

        let pt2 = b"hello desktop".to_vec();
        let ct2 = rt.write(&pt2).unwrap();
        assert_eq!(it.read(&ct2).unwrap(), pt2);
    }

    #[test]
    fn kk_reconnect_with_pinned_keys_succeeds() {
        let a = StaticKeypair::generate().unwrap();
        let b = StaticKeypair::generate().unwrap();
        // keys pinned from a prior XX pairing
        let mut ini = Handshake::kk_initiator(&a.private, &b.public).unwrap();
        let mut res = Handshake::kk_responder(&b.private, &a.public).unwrap();

        run_kk(&mut ini, &mut res);
        assert!(ini.is_finished() && res.is_finished());

        let mut it = ini.into_transport().unwrap();
        let mut rt = res.into_transport().unwrap();
        let pt = b"reconnected".to_vec();
        let ct = it.write(&pt).unwrap();
        assert_eq!(rt.read(&ct).unwrap(), pt);
    }

    #[test]
    fn a_tampered_handshake_message_is_rejected() {
        let a = StaticKeypair::generate().unwrap();
        let b = StaticKeypair::generate().unwrap();
        let mut ini = Handshake::xx_initiator(&a.private).unwrap();
        let mut res = Handshake::xx_responder(&b.private).unwrap();

        let m1 = ini.write(&[]).unwrap();
        res.read(&m1).unwrap();
        let mut m2 = res.write(&[]).unwrap();
        m2[0] ^= 0xff; // flip a bit in the responder's reply

        assert!(
            ini.read(&m2).is_err(),
            "initiator must reject a tampered handshake message"
        );
    }

    #[test]
    fn kk_with_the_wrong_peer_key_fails() {
        let a = StaticKeypair::generate().unwrap();
        let b = StaticKeypair::generate().unwrap();
        let imposter = StaticKeypair::generate().unwrap();

        // initiator pins the wrong peer key
        let mut ini = Handshake::kk_initiator(&a.private, &imposter.public).unwrap();
        let mut res = Handshake::kk_responder(&b.private, &a.public).unwrap();

        let m1 = ini.write(&[]).unwrap();
        assert!(
            res.read(&m1).is_err(),
            "responder must reject an unauthenticated peer"
        );
    }

    #[test]
    fn sas_is_deterministic_and_grouped() {
        let a = StaticKeypair::generate().unwrap();
        let b = StaticKeypair::generate().unwrap();
        let mut ini = Handshake::xx_initiator(&a.private).unwrap();
        let mut res = Handshake::xx_responder(&b.private).unwrap();
        run_xx(&mut ini, &mut res);

        let sas = ini.sas();
        assert_eq!(sas, ini.sas()); // stable across calls
        assert_eq!(sas.split(' ').count(), SAS_BYTES);
        assert!(sas
            .split(' ')
            .all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_hexdigit())));
    }

    // ── security proofs (the whole point of the crypto) ──────────────────────

    #[test]
    fn a_mitm_session_yields_a_different_sas_than_the_honest_pairing() {
        // Honest A <-> B.
        let a = StaticKeypair::generate().unwrap();
        let b = StaticKeypair::generate().unwrap();
        let mut ini = Handshake::xx_initiator(&a.private).unwrap();
        let mut res = Handshake::xx_responder(&b.private).unwrap();
        run_xx(&mut ini, &mut res);
        let honest_sas = ini.sas();

        // A unknowingly handshakes with an interceptor M instead of B.
        let m = StaticKeypair::generate().unwrap();
        let mut ini2 = Handshake::xx_initiator(&a.private).unwrap();
        let mut mitm = Handshake::xx_responder(&m.private).unwrap();
        run_xx(&mut ini2, &mut mitm);

        // The out-of-band SAS comparison is what catches the MITM.
        assert_ne!(
            honest_sas,
            ini2.sas(),
            "a MITM session must not match the honest SAS"
        );
    }

    #[test]
    fn transport_rejects_a_tampered_ciphertext() {
        let a = StaticKeypair::generate().unwrap();
        let b = StaticKeypair::generate().unwrap();
        let mut ini = Handshake::xx_initiator(&a.private).unwrap();
        let mut res = Handshake::xx_responder(&b.private).unwrap();
        run_xx(&mut ini, &mut res);
        let mut it = ini.into_transport().unwrap();
        let mut rt = res.into_transport().unwrap();

        let mut ct = it.write(b"sensitive").unwrap();
        ct[0] ^= 0x01; // flip one bit of the AEAD ciphertext
        assert!(
            rt.read(&ct).is_err(),
            "AEAD tag check must reject a tampered ciphertext"
        );
    }

    #[test]
    fn transport_rejects_a_replayed_message() {
        let a = StaticKeypair::generate().unwrap();
        let b = StaticKeypair::generate().unwrap();
        let mut ini = Handshake::xx_initiator(&a.private).unwrap();
        let mut res = Handshake::xx_responder(&b.private).unwrap();
        run_xx(&mut ini, &mut res);
        let mut it = ini.into_transport().unwrap();
        let mut rt = res.into_transport().unwrap();

        let ct = it.write(b"once").unwrap();
        rt.read(&ct).unwrap(); // first delivery advances the receive nonce
        assert!(
            rt.read(&ct).is_err(),
            "a replayed ciphertext must fail (nonce already advanced)"
        );
    }

    #[test]
    fn independent_sessions_of_the_same_keypairs_produce_different_ciphertexts() {
        // Ephemeral keys give each session its own keys (forward secrecy).
        let a = StaticKeypair::generate().unwrap();
        let b = StaticKeypair::generate().unwrap();

        let mut i1 = Handshake::xx_initiator(&a.private).unwrap();
        let mut r1 = Handshake::xx_responder(&b.private).unwrap();
        run_xx(&mut i1, &mut r1);
        let mut t1 = i1.into_transport().unwrap();

        let mut i2 = Handshake::xx_initiator(&a.private).unwrap();
        let mut r2 = Handshake::xx_responder(&b.private).unwrap();
        run_xx(&mut i2, &mut r2);
        let mut t2 = i2.into_transport().unwrap();

        let pt = b"same plaintext".to_vec();
        assert_ne!(
            t1.write(&pt).unwrap(),
            t2.write(&pt).unwrap(),
            "separate sessions must not produce identical ciphertext"
        );
    }

    #[test]
    fn remote_static_is_none_until_the_peer_key_is_received_during_xx() {
        let a = StaticKeypair::generate().unwrap();
        let b = StaticKeypair::generate().unwrap();
        let mut ini = Handshake::xx_initiator(&a.private).unwrap();
        let mut res = Handshake::xx_responder(&b.private).unwrap();

        let m1 = ini.write(&[]).unwrap(); // -> e
        assert!(ini.remote_static().is_none()); // hasn't seen b's s yet
        res.read(&m1).unwrap();
        let m2 = res.write(&[]).unwrap(); // <- e, ee, s, es
        ini.read(&m2).unwrap();
        assert!(ini.remote_static().is_some()); // now has b's s

        let m3 = ini.write(&[]).unwrap(); // -> s, se
        assert!(res.remote_static().is_none()); // hasn't read a's s yet
        res.read(&m3).unwrap();
        assert!(res.remote_static().is_some());
    }

    #[test]
    fn into_transport_before_the_handshake_finishes_errs() {
        let a = StaticKeypair::generate().unwrap();
        let ini = Handshake::xx_initiator(&a.private).unwrap();
        assert!(!ini.is_finished());
        assert!(ini.into_transport().is_err());
    }

    #[test]
    fn handshake_read_rejects_garbage_without_panicking() {
        let a = StaticKeypair::generate().unwrap();
        let mut ini = Handshake::xx_initiator(&a.private).unwrap();
        ini.write(&[]).unwrap(); // XX: write before reading
        assert!(ini.read(&[]).is_err());

        let b = StaticKeypair::generate().unwrap();
        let mut res = Handshake::xx_responder(&b.private).unwrap();
        assert!(res.read(&[0xde, 0xad, 0xbe, 0xef]).is_err());
    }

    #[test]
    fn transport_read_rejects_garbage_without_panicking() {
        let a = StaticKeypair::generate().unwrap();
        let b = StaticKeypair::generate().unwrap();
        let mut ini = Handshake::xx_initiator(&a.private).unwrap();
        let mut res = Handshake::xx_responder(&b.private).unwrap();
        run_xx(&mut ini, &mut res);
        let mut rt = res.into_transport().unwrap();

        assert!(rt.read(&[]).is_err());
        assert!(rt.read(&[0xba, 0xad, 0xf0, 0x0d]).is_err());
    }
}
