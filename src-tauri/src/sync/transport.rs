//! Phone Sync — Phase 2: the iroh QUIC transport.
//!
//! Carries the application-layer Noise session (`super::noise`) over an iroh
//! bidirectional stream, so the relay only ever sees ciphertext. iroh gives us
//! dial-by-public-key P2P with hole-punching + a self-hostable relay fallback and
//! QUIC's connection migration (survives Wi-Fi↔cellular handoff); the Noise layer
//! on top keeps the relay blind.
//!
//! Two identities are in play and are intentionally separate:
//!   * the **iroh** `SecretKey` (Ed25519) — the transport/node identity.
//!   * the **Noise** `StaticKeypair` (Curve25519) — the app-layer pairing identity
//!     the phone actually pins (`super::noise` / `super::pairing`).
//!
//! Handshake + every frame are length-prefixed (4-byte big-endian) over the QUIC
//! stream. See docs/PHONE_SYNC_PLAN.md.

use std::sync::{Arc, Mutex};

use iroh::endpoint::presets;
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointAddr, RelayMode, SecretKey};

use super::noise::{self, Handshake};
use super::protocol::SyncFrame;

/// ALPN identifying the Phone Sync protocol on the QUIC connection.
const ALPN: &[u8] = b"porthex/phone-sync/0";

/// Hard cap on a single framed message, to refuse a hostile length prefix before
/// allocating. A Noise message (handshake or transport) is ≤ 65535 bytes incl.
/// the AEAD tag, so this sits above any legitimate single frame.
///
/// CARRY-FORWARD: a `SyncFrame` whose JSON exceeds ~65519 bytes (e.g. a large
/// `MessageDelta`) can't be sent as one Noise message — `noise::Transport::write`
/// will error. Chunking large frames is a later-increment task; today's frames
/// (acks, single events, small deltas) are well under the limit.
const MAX_FRAME: usize = 128 * 1024;

/// Build (and bind) an iroh endpoint with the given node identity + relay policy.
/// Hold the returned `Endpoint` alive for as long as its connections are in use —
/// it owns the socket + background tasks.
pub async fn build_endpoint(secret_key: SecretKey, relay: RelayMode) -> Result<Endpoint, String> {
    Endpoint::builder(presets::N0)
        .secret_key(secret_key)
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(relay)
        .bind()
        .await
        .map_err(|e| e.to_string())
}

/// A paired, end-to-end-encrypted channel plus the pairing metadata the caller
/// needs (the SAS to compare out-of-band, the peer's pinned static key).
pub struct Paired {
    pub channel: SecureChannel,
    /// Short Authentication String. The desktop surfaces it to the pairing UI for
    /// out-of-band comparison before confirming an untrusted device; the phone
    /// returns it from `phone_sync_connect` for the same comparison on its end.
    pub sas: String,
    /// The peer's pinned Noise static public key, the identity the device-trust
    /// gate keys off (confirmed vs. not). `None` only if the handshake never
    /// received it (a malformed/aborted handshake), which the serve path rejects.
    pub peer_static: Option<Vec<u8>>,
}

/// Shared Noise transport state. A `std::sync::Mutex` (not tokio) because the
/// lock is held ONLY across the synchronous snow `write`/`read` and is always
/// dropped before any stream `.await` (see `encrypt_frame`/`decrypt_frame`) — so
/// the guard never crosses an await point (keeps the spawned forward/intake
/// futures `Send`) and the two split halves can never both be inside snow at once.
type SharedNoise = Arc<Mutex<noise::Transport>>;

/// An established encrypted channel: a QUIC bi-stream wrapped in the Noise
/// transport. Holds the `Connection` and `Endpoint` so they outlive the streams
/// (dropping either tears the connection down).
pub struct SecureChannel {
    send: SendStream,
    recv: RecvStream,
    noise: SharedNoise,
    _conn: Connection,
    _endpoint: Endpoint,
}

impl SecureChannel {
    /// Encrypt + send one `SyncFrame`.
    pub async fn send_frame(&mut self, frame: &SyncFrame) -> Result<(), String> {
        let ciphertext = encrypt_frame(&self.noise, frame)?;
        write_framed(&mut self.send, &ciphertext).await
    }

    /// Receive + decrypt one `SyncFrame`.
    pub async fn recv_frame(&mut self) -> Result<SyncFrame, String> {
        let ciphertext = read_framed(&mut self.recv).await?;
        decrypt_frame(&self.noise, &ciphertext)
    }

    /// Split into independent send/recv halves so live-forward and command-intake
    /// run as two concurrent tasks. The halves share the Noise transport via the
    /// `Arc<Mutex>`; the sender additionally keeps `Connection`/`Endpoint` alive
    /// (dropping either tears the QUIC connection down), so the receiver stays
    /// live as long as the sender does.
    pub fn split(self) -> (ChannelSender, ChannelReceiver) {
        (
            ChannelSender {
                send: self.send,
                noise: Arc::clone(&self.noise),
                _conn: self._conn,
                _endpoint: self._endpoint,
            },
            ChannelReceiver {
                recv: self.recv,
                noise: self.noise,
            },
        )
    }
}

/// Send half of a split [`SecureChannel`]. Owns the connection/endpoint keep-alive.
pub struct ChannelSender {
    send: SendStream,
    noise: SharedNoise,
    _conn: Connection,
    _endpoint: Endpoint,
}

impl ChannelSender {
    pub async fn send_frame(&mut self, frame: &SyncFrame) -> Result<(), String> {
        let ciphertext = encrypt_frame(&self.noise, frame)?;
        write_framed(&mut self.send, &ciphertext).await
    }
}

/// Receive half of a split [`SecureChannel`].
pub struct ChannelReceiver {
    recv: RecvStream,
    noise: SharedNoise,
}

impl ChannelReceiver {
    pub async fn recv_frame(&mut self) -> Result<SyncFrame, String> {
        let ciphertext = read_framed(&mut self.recv).await?;
        decrypt_frame(&self.noise, &ciphertext)
    }
}

/// Serialize + Noise-encrypt one frame. The std-mutex guard is scoped to this
/// (non-async) fn and dropped at its `}`, so it can never be held across an `.await`.
fn encrypt_frame(noise: &SharedNoise, frame: &SyncFrame) -> Result<Vec<u8>, String> {
    let plaintext = serde_json::to_vec(frame).map_err(|e| e.to_string())?;
    let mut guard = noise
        .lock()
        .map_err(|_| "noise mutex poisoned".to_string())?;
    guard.write(&plaintext)
}

/// Noise-decrypt + deserialize one frame. Guard dropped before `from_slice`.
fn decrypt_frame(noise: &SharedNoise, ciphertext: &[u8]) -> Result<SyncFrame, String> {
    let plaintext = {
        let mut guard = noise
            .lock()
            .map_err(|_| "noise mutex poisoned".to_string())?;
        guard.read(ciphertext)?
    };
    serde_json::from_slice(&plaintext).map_err(|e| e.to_string())
}

/// Dial a peer, run the XX pairing handshake as the initiator, and return the
/// resulting encrypted channel. `nonce` is the pairing nonce the phone scanned
/// from the desktop's QR — it is bound into the handshake prologue so the
/// responder, which uses its OPEN pairing window's nonce, only completes the
/// handshake when the two match (a stale/forged nonce fails cryptographically).
pub async fn connect_and_pair(
    endpoint: &Endpoint,
    peer: EndpointAddr,
    local_noise_private: &[u8],
    nonce: &[u8],
) -> Result<Paired, String> {
    let conn = endpoint
        .connect(peer, ALPN)
        .await
        .map_err(|e| e.to_string())?;
    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
    let hs = Handshake::xx_initiator(local_noise_private, nonce)?;
    let (noise, sas, peer_static) = drive_xx(hs, &mut send, &mut recv, true).await?;
    Ok(Paired {
        channel: SecureChannel {
            send,
            recv,
            noise: Arc::new(Mutex::new(noise)),
            _conn: conn,
            _endpoint: endpoint.clone(),
        },
        sas,
        peer_static,
    })
}

/// Accept one inbound connection, run the XX pairing handshake as the responder,
/// and return the resulting encrypted channel.
///
/// `nonce_for` yields the handshake-prologue nonce and is invoked AFTER a
/// connection has actually arrived (post-`accept`), NOT before. This timing is
/// load-bearing: the accept loop is usually parked in `accept()` with no pairing
/// window open, and a window opens (with a fresh nonce) only when the desktop user
/// clicks "Pair a phone". Reading the nonce lazily — once a phone has connected —
/// captures the window that is open AT THAT MOMENT, so a legitimate first pairing
/// binds the same nonce on both ends. Reading it eagerly (before `accept`) would
/// snapshot the stale empty nonce and break every first pairing.
pub async fn accept_and_pair(
    endpoint: &Endpoint,
    local_noise_private: &[u8],
    nonce_for: impl FnOnce() -> Vec<u8>,
) -> Result<Paired, String> {
    let incoming = endpoint.accept().await.ok_or("endpoint closed")?;
    let conn = incoming.await.map_err(|e| e.to_string())?;
    let (mut send, mut recv) = conn.accept_bi().await.map_err(|e| e.to_string())?;
    // Resolve the prologue nonce now that a peer has connected (see above).
    let nonce = nonce_for();
    let hs = Handshake::xx_responder(local_noise_private, &nonce)?;
    let (noise, sas, peer_static) = drive_xx(hs, &mut send, &mut recv, false).await?;
    Ok(Paired {
        channel: SecureChannel {
            send,
            recv,
            noise: Arc::new(Mutex::new(noise)),
            _conn: conn,
            _endpoint: endpoint.clone(),
        },
        sas,
        peer_static,
    })
}

/// Drive a 3-message XX handshake over the framed stream, capture the SAS + peer
/// static key, and transition into transport mode.
async fn drive_xx(
    mut hs: Handshake,
    send: &mut SendStream,
    recv: &mut RecvStream,
    initiator: bool,
) -> Result<(noise::Transport, String, Option<Vec<u8>>), String> {
    if initiator {
        let m1 = hs.write(&[])?; // -> e
        write_framed(send, &m1).await?;
        let m2 = read_framed(recv).await?; // <- e, ee, s, es
        hs.read(&m2)?;
        let m3 = hs.write(&[])?; // -> s, se
        write_framed(send, &m3).await?;
    } else {
        let m1 = read_framed(recv).await?;
        hs.read(&m1)?;
        let m2 = hs.write(&[])?;
        write_framed(send, &m2).await?;
        let m3 = read_framed(recv).await?;
        hs.read(&m3)?;
    }
    // Capture before `into_transport` consumes the handshake.
    let sas = hs.sas();
    let peer_static = hs.remote_static();
    let transport = hs.into_transport()?;
    Ok((transport, sas, peer_static))
}

/// Write a 4-byte big-endian length prefix followed by `payload`.
async fn write_framed(send: &mut SendStream, payload: &[u8]) -> Result<(), String> {
    let len = u32::try_from(payload.len()).map_err(|_| "frame too large".to_string())?;
    send.write_all(&len.to_be_bytes())
        .await
        .map_err(|e| e.to_string())?;
    send.write_all(payload).await.map_err(|e| e.to_string())
}

/// Read a 4-byte big-endian length prefix then exactly that many bytes.
async fn read_framed(recv: &mut RecvStream) -> Result<Vec<u8>, String> {
    let mut len_buf = [0u8; 4];
    recv.read_exact(&mut len_buf)
        .await
        .map_err(|e| e.to_string())?;
    let n = u32::from_be_bytes(len_buf) as usize;
    if n > MAX_FRAME {
        return Err(format!(
            "frame of {n} bytes exceeds the {MAX_FRAME}-byte cap"
        ));
    }
    let mut payload = vec![0u8; n];
    recv.read_exact(&mut payload)
        .await
        .map_err(|e| e.to_string())?;
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::StreamEvent;
    use crate::sync::noise::StaticKeypair;

    /// The pairing nonce both peers bind into the handshake prologue. Real code
    /// derives it from the QR / the open pairing window; the tests just need both
    /// sides to agree on the same bytes for the handshake to complete.
    const TEST_NONCE: &[u8] = &[0x01, 0x02, 0x03, 0x04];

    // Headless desktop↔desktop proof: two in-process iroh endpoints (no relay)
    // pair over QUIC via the XX Noise handshake, agree on a SAS, pin each other's
    // static keys, and exchange encrypted SyncFrames both directions.
    //
    // `multi_thread` is REQUIRED: iroh streams are lazy (the responder's
    // `accept_bi` only resolves once the initiator writes its first message), so
    // the accept-side and connect-side futures must progress on separate threads
    // or they deadlock under a current-thread runtime.
    #[tokio::test(flavor = "multi_thread")]
    async fn two_endpoints_pair_over_iroh_and_exchange_encrypted_frames() {
        let server_ep = build_endpoint(SecretKey::generate(), RelayMode::Disabled)
            .await
            .unwrap();
        let client_ep = build_endpoint(SecretKey::generate(), RelayMode::Disabled)
            .await
            .unwrap();

        // App-layer pairing identities.
        let server_noise = StaticKeypair::generate().unwrap();
        let client_noise = StaticKeypair::generate().unwrap();

        // Direct dial address — populated immediately after bind with relay off.
        let server_addr = server_ep.addr();

        // server_ep is moved into the task and dropped when it returns; the
        // Endpoint clone inside the returned Paired (Arc-backed) keeps the socket
        // alive for the frame exchange below.
        let server_priv = server_noise.private.clone();
        let server_task = tokio::spawn(async move {
            accept_and_pair(&server_ep, &server_priv, || TEST_NONCE.to_vec()).await
        });

        let mut client =
            connect_and_pair(&client_ep, server_addr, &client_noise.private, TEST_NONCE)
                .await
                .expect("client pairing");
        let mut server = server_task.await.unwrap().expect("server pairing");

        // Out-of-band SAS matches, and each side pinned the other's static key.
        assert_eq!(client.sas, server.sas);
        assert!(!client.sas.is_empty());
        assert_eq!(
            client.peer_static.as_deref(),
            Some(server_noise.public.as_slice())
        );
        assert_eq!(
            server.peer_static.as_deref(),
            Some(client_noise.public.as_slice())
        );

        // Encrypted frame, client -> server.
        client
            .channel
            .send_frame(&SyncFrame::Ack {
                session_id: "s1".into(),
                seq: 7,
            })
            .await
            .unwrap();
        match server.channel.recv_frame().await.unwrap() {
            SyncFrame::Ack { session_id, seq } => {
                assert_eq!(session_id, "s1");
                assert_eq!(seq, 7);
            }
            other => panic!("expected Ack, got {other:?}"),
        }

        // Encrypted frame, server -> client.
        server
            .channel
            .send_frame(&SyncFrame::Live {
                session_id: "s1".into(),
                event: StreamEvent::TextDelta { text: "hi".into() },
            })
            .await
            .unwrap();
        match client.channel.recv_frame().await.unwrap() {
            SyncFrame::Live { session_id, .. } => assert_eq!(session_id, "s1"),
            other => panic!("expected Live, got {other:?}"),
        }
    }

    // Security proof over the real iroh transport: a phone presenting a DIFFERENT
    // pairing nonce than the responder's open-window nonce fails the XX handshake
    // (the nonce is bound into the Noise prologue). This is the transport-level
    // analogue of `noise::tests::xx_with_a_mismatched_prologue_nonce_fails`, and it
    // proves a stale/forged QR can't complete pairing even after dialing in.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_mismatched_pairing_nonce_fails_the_handshake_over_iroh() {
        let server_ep = build_endpoint(SecretKey::generate(), RelayMode::Disabled)
            .await
            .unwrap();
        let client_ep = build_endpoint(SecretKey::generate(), RelayMode::Disabled)
            .await
            .unwrap();
        let server_noise = StaticKeypair::generate().unwrap();
        let client_noise = StaticKeypair::generate().unwrap();
        let server_addr = server_ep.addr();

        // Responder binds nonce A; the dialing phone binds a DIFFERENT nonce B.
        let server_priv = server_noise.private.clone();
        let server_task = tokio::spawn(async move {
            accept_and_pair(&server_ep, &server_priv, || vec![0xAA, 0xAA]).await
        });

        let client_res = connect_and_pair(
            &client_ep,
            server_addr,
            &client_noise.private,
            &[0xBB, 0xBB],
        )
        .await;

        // At least one side must reject the prologue-mismatched handshake; in
        // practice both error. Asserting the initiator fails is the load-bearing
        // claim (the phone never gets a usable channel).
        assert!(
            client_res.is_err(),
            "a phone with the wrong pairing nonce must fail the handshake"
        );
        // Drain the server task so it doesn't dangle (it also errors).
        let _ = server_task.await;
    }

    // End-to-end Phase 2c proof: pair two iroh endpoints, split BOTH channels,
    // and run the real concurrent server loops (forward_live + handle_commands)
    // against a client that issues one Command and reads forwarded Live frames.
    // `multi_thread` for the same lazy-stream reason as the test above.
    #[tokio::test(flavor = "multi_thread")]
    async fn split_channels_forward_live_and_dispatch_commands_over_iroh() {
        use crate::sync::protocol::RemoteCommand;
        use crate::sync::session::{forward_live, handle_commands, CommandHandler};
        use crate::sync::SyncHub;
        use async_trait::async_trait;

        struct Recorder {
            seen: Arc<Mutex<Vec<RemoteCommand>>>,
        }
        #[async_trait]
        impl CommandHandler for Recorder {
            async fn handle(&self, command: RemoteCommand) -> Result<(), String> {
                self.seen.lock().unwrap().push(command);
                Ok(())
            }
        }

        let server_ep = build_endpoint(SecretKey::generate(), RelayMode::Disabled)
            .await
            .unwrap();
        let client_ep = build_endpoint(SecretKey::generate(), RelayMode::Disabled)
            .await
            .unwrap();
        let server_noise = StaticKeypair::generate().unwrap();
        let client_noise = StaticKeypair::generate().unwrap();
        let server_addr = server_ep.addr();

        let server_priv = server_noise.private.clone();
        let server_task = tokio::spawn(async move {
            accept_and_pair(&server_ep, &server_priv, || TEST_NONCE.to_vec()).await
        });
        let client = connect_and_pair(&client_ep, server_addr, &client_noise.private, TEST_NONCE)
            .await
            .expect("client pairing");
        let server = server_task.await.unwrap().expect("server pairing");

        // ── server: split, run both loops concurrently ──
        let hub = SyncHub::new();
        let mut hub_rx = hub.subscribe(); // subscribe BEFORE publish
        let (mut server_send, mut server_recv) = server.channel.split();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler = Recorder { seen: seen.clone() };

        let forward =
            tokio::spawn(async move { forward_live(&mut hub_rx, &mut server_send).await });
        let intake = tokio::spawn(async move { handle_commands(&mut server_recv, &handler).await });

        // ── client: split, send one Command, read one forwarded Live ──
        let (mut client_send, mut client_recv) = client.channel.split();
        client_send
            .send_frame(&SyncFrame::Command {
                command: RemoteCommand::Run {
                    session_id: "s1".into(),
                    text: "hello from phone".into(),
                },
            })
            .await
            .expect("client sends command");

        hub.publish("agent://s1", StreamEvent::TextDelta { text: "hi".into() });

        match client_recv
            .recv_frame()
            .await
            .expect("client receives live")
        {
            SyncFrame::Live { session_id, .. } => assert_eq!(session_id, "s1"),
            other => panic!("expected Live, got {other:?}"),
        }

        // Wait until the command is actually PROCESSED before dropping the send
        // half — dropping `client_send` resets its QUIC stream, which on a slow
        // runner can discard a not-yet-delivered command frame (the same race that
        // flaked the client.rs integration test). 2s budget; fails fast otherwise.
        for _ in 0..200 {
            if !seen.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // Close: drop hub (forward_live returns), drop client send (server recv
        // ends → handle_commands returns). Join both before asserting `seen`.
        drop(hub);
        drop(client_send);
        forward.await.unwrap().expect("forward_live ok");
        intake.await.unwrap().expect("handle_commands ok");

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(matches!(
            &seen[0],
            RemoteCommand::Run { session_id, text }
                if session_id == "s1" && text == "hello from phone"
        ));
    }
}
