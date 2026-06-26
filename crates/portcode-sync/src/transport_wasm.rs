//! Phone Sync — the BROWSER (wasm32) iroh transport (Phase 2).
//!
//! `#[cfg(target_arch = "wasm32")]`-only. This is the relay-only sibling of
//! [`super::transport_native`]: in the browser iroh has no UDP and cannot
//! hole-punch, so every byte rides an iroh **relay over a WebSocket** (still
//! end-to-end encrypted — the relay forwards opaque ciphertext). It is built with
//! `iroh = { default-features = false, features = ["tls-ring"] }` (drops
//! `metrics`, which breaks wasm; keeps the wasm-friendly rustls `ring` crypto
//! provider that [`presets::N0`] needs) and dials the desktop **through the relay
//! URL carried in the [`PairingPayload`]**.
//!
//! This file mirrors `transport_native.rs` field-for-field — the same
//! `SecureChannel`/`ChannelSender`/`ChannelReceiver` surface, the same
//! `encrypt_frame`/`decrypt_frame` + length-framing helpers, and the same
//! `drive_xx`/`drive_kk` handshake driver — so `session.rs`'s `FrameSink`/
//! `FrameSource` impls and the shared catch-up/live loops run against it
//! unchanged. The ONE difference from native is the dial: a relay-only browser
//! endpoint (`presets::N0`) connecting to `payload.node_addr` augmented with the
//! payload's relay URL, rather than a UDP-capable native endpoint.
//!
//! Concurrency note: browser wasm is single-threaded and browser futures are
//! `!Send`, so the `Transport` trait is `async_trait(?Send)` here (§5.2). The
//! `std::sync::Mutex` around the Noise transport is held ONLY across the
//! synchronous snow `read`/`write` and is always dropped before any stream
//! `.await` (see `encrypt_frame`/`decrypt_frame`), exactly as on native, so it
//! never crosses an await point.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use futures_util::future::{select, Either};
use gloo_timers::future::TimeoutFuture;
use iroh::endpoint::presets;
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointAddr, RelayUrl};

use crate::noise::{self, Handshake};
use crate::pairing::PairingPayload;
use crate::protocol::SyncFrame;
use crate::session::RecvError;
use crate::transport::{Paired, Transport, ALPN, MAX_FRAME};

/// Shared Noise transport state. A `std::sync::Mutex` (not tokio) because the lock
/// is held ONLY across the synchronous snow `write`/`read` and is always dropped
/// before any stream `.await` (see `encrypt_frame`/`decrypt_frame`). Identical to
/// the native transport so the two channel surfaces are byte-for-byte equivalent.
type SharedNoise = Arc<Mutex<noise::Transport>>;

/// An established encrypted channel: a relayed iroh bi-stream wrapped in the Noise
/// transport. Holds the `Connection` and `Endpoint` so they outlive the streams
/// (dropping either tears the relayed connection down).
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

    /// Receive + decrypt one `SyncFrame`. A clean end-of-stream is reported as
    /// [`RecvError::Closed`]; a torn relay connection / decrypt / parse failure is
    /// [`RecvError::Protocol`] so the session loops can force a reconnect.
    pub async fn recv_frame(&mut self) -> Result<SyncFrame, RecvError> {
        let ciphertext = read_framed(&mut self.recv).await?;
        decrypt_frame(&self.noise, &ciphertext).map_err(RecvError::Protocol)
    }

    /// Split into independent send/recv halves so live-forward and command-intake
    /// run as two concurrent `spawn_local` tasks. The halves share the Noise
    /// transport via the `Arc<Mutex>`; the sender additionally keeps
    /// `Connection`/`Endpoint` alive (dropping either tears the relayed connection
    /// down), so the receiver stays live as long as the sender does. Mirrors
    /// `transport_native::SecureChannel::split`.
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
    pub async fn recv_frame(&mut self) -> Result<SyncFrame, RecvError> {
        let ciphertext = read_framed(&mut self.recv).await?;
        decrypt_frame(&self.noise, &ciphertext).map_err(RecvError::Protocol)
    }
}

/// Serialize + Noise-encrypt one frame. The std-mutex guard is scoped to this
/// (non-async) fn and dropped at its `}`, so it can never be held across an
/// `.await`. Identical to `transport_native::encrypt_frame`.
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

/// Write a 4-byte big-endian length prefix followed by `payload`. iroh's wasm
/// `SendStream` exposes the same inherent `write_all` as native (the Phase 0 spike
/// uses it), so this is identical to the native helper.
async fn write_framed(send: &mut SendStream, payload: &[u8]) -> Result<(), String> {
    if payload.len() > MAX_FRAME {
        return Err(format!(
            "frame of {} bytes exceeds the {MAX_FRAME}-byte cap",
            payload.len()
        ));
    }
    let len = u32::try_from(payload.len()).map_err(|_| "frame too large".to_string())?;
    send.write_all(&len.to_be_bytes())
        .await
        .map_err(|e| e.to_string())?;
    send.write_all(payload).await.map_err(|e| e.to_string())
}

/// Read a 4-byte big-endian length prefix then exactly that many bytes. A clean
/// finish at a frame boundary reports [`RecvError::Closed`]; a truncated/oversized
/// frame or a torn relay connection reports [`RecvError::Protocol`].
async fn read_framed(recv: &mut RecvStream) -> Result<Vec<u8>, RecvError> {
    let mut len_buf = [0u8; 4];
    match recv.read_exact(&mut len_buf).await {
        Ok(()) => {}
        Err(iroh::endpoint::ReadExactError::FinishedEarly(0)) => return Err(RecvError::Closed),
        Err(e) => return Err(RecvError::Protocol(e.to_string())),
    }
    let n = u32::from_be_bytes(len_buf) as usize;
    if n > MAX_FRAME {
        return Err(RecvError::Protocol(format!(
            "frame of {n} bytes exceeds the {MAX_FRAME}-byte cap"
        )));
    }
    let mut payload = vec![0u8; n];
    recv.read_exact(&mut payload)
        .await
        .map_err(|e| RecvError::Protocol(e.to_string()))?;
    Ok(payload)
}

/// How long (ms) the browser will wait for the dial + handshake to complete before
/// giving up. In the browser everything rides a single relay WebSocket; if the relay
/// is unreachable, the desktop is offline, or a packet is dropped mid-handshake, the
/// underlying `connect`/`open_bi`/handshake-read futures can park FOREVER (there is
/// no UDP timeout to fall back on). A bounded wait turns that hang into a clear `Err`
/// the PWA can surface + retry. 20s is generous for a relay round-trip yet short
/// enough that a stuck connect doesn't look like a frozen app.
const CONNECT_TIMEOUT_MS: u32 = 20_000;

/// Race `fut` against a `CONNECT_TIMEOUT_MS` timer (wasm-compatible — `gloo-timers`,
/// not `tokio::time`, which has no `time` feature on the browser target). Returns the
/// future's value on completion, or a clear timeout `Err` on expiry so the caller can
/// retry instead of hanging forever. Used ONLY on the `connect` path's
/// dial/handshake awaits.
async fn with_connect_timeout<T, F>(what: &str, fut: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let timeout = TimeoutFuture::new(CONNECT_TIMEOUT_MS);
    futures_util::pin_mut!(fut);
    match select(fut, timeout).await {
        Either::Left((res, _)) => res,
        Either::Right(((), _)) => Err(format!(
            "{what} timed out after {CONNECT_TIMEOUT_MS}ms (relay unreachable or peer offline?)"
        )),
    }
}

/// Drive a 3-message XX handshake over the framed stream as the INITIATOR (the
/// browser always dials, so it is always the initiator), capture the SAS + peer
/// static key, and transition into transport mode. The exact initiator branch of
/// `transport_native::drive_xx`.
async fn drive_xx_initiator(
    mut hs: Handshake,
    send: &mut SendStream,
    recv: &mut RecvStream,
) -> Result<(noise::Transport, String, Option<Vec<u8>>), String> {
    let m1 = hs.write(&[])?; // -> e
    write_framed(send, &m1).await?;
    let m2 = read_framed(recv).await?; // <- e, ee, s, es
    hs.read(&m2)?;
    let m3 = hs.write(&[])?; // -> s, se
    write_framed(send, &m3).await?;
    let sas = hs.sas();
    let peer_static = hs.remote_static();
    let transport = hs.into_transport()?;
    Ok((transport, sas, peer_static))
}

/// Drive a 2-message KK handshake over the framed stream as the INITIATOR (fast
/// reconnect against the already-pinned desktop key). KK message 1 carries the
/// initiator's static, so the responder authenticates immediately; message 2 is
/// the responder's reply. After it the SAS + (already-known) peer static are
/// captured and the channel switches to transport mode.
async fn drive_kk_initiator(
    mut hs: Handshake,
    send: &mut SendStream,
    recv: &mut RecvStream,
) -> Result<(noise::Transport, String, Option<Vec<u8>>), String> {
    let m1 = hs.write(&[])?; // -> e, es, ss
    write_framed(send, &m1).await?;
    let m2 = read_framed(recv).await?; // <- e, ee, se
    hs.read(&m2)?;
    let sas = hs.sas();
    let peer_static = hs.remote_static();
    let transport = hs.into_transport()?;
    Ok((transport, sas, peer_static))
}

/// The browser transport. Holds the local Noise static private key the handshake
/// authenticates as; the relay URL + dialable address come from the
/// [`PairingPayload`] at `connect` time. Implements the shared [`Transport`] trait
/// so the session loop dials through it exactly as it dials the native transport.
pub struct WasmTransport {
    /// The phone's long-term Noise static private key (Curve25519). Held here so
    /// `connect` can build the XX/KK initiator without it crossing the JS boundary.
    local_noise_private: Vec<u8>,
}

impl WasmTransport {
    /// Construct a browser transport that authenticates with `local_noise_private`
    /// (the phone's pinned Noise static private key).
    pub fn new(local_noise_private: Vec<u8>) -> Self {
        Self {
            local_noise_private,
        }
    }
}

// `async_trait(?Send)` because browser futures are `!Send` (§5.2). The cfg-gated
// trait definition in `transport.rs` already selects this variant for wasm, so we
// match it here.
#[async_trait(?Send)]
impl Transport for WasmTransport {
    type Channel = SecureChannel;

    /// Dial the desktop through the relay and run the Noise handshake.
    ///
    /// `reconnect = false` (first pairing): XX, binding the QR nonce as the Noise
    /// prologue so a stale/forged nonce fails cryptographically (matches the native
    /// responder, which binds its open-window nonce).
    ///
    /// `reconnect = true` (fast resume): KK against the pinned desktop key carried
    /// in `payload.public_key`. KK has no prologue (the static keys already
    /// authenticate both sides), matching `noise::Handshake::kk_initiator`.
    async fn connect(
        &self,
        payload: &PairingPayload,
        reconnect: bool,
    ) -> Result<Paired<Self::Channel>, String> {
        // Build a relay-only browser endpoint. `presets::N0` selects the n0 relays
        // + discovery + the wasm-friendly rustls crypto provider; in the browser
        // iroh is relay-only by construction (no UDP), so no explicit relay-mode
        // toggle is needed — the endpoint simply rides the relay WebSocket.
        let endpoint = Endpoint::bind(presets::N0)
            .await
            .map_err(|e| e.to_string())?;

        // Build the dialable address: the desktop's node identity from the QR,
        // augmented with the relay URL the desktop advertised (or the documented
        // n0 default). Adding the relay explicitly means we dial through the
        // intended relay even if discovery is slow/unavailable.
        let relay_url: RelayUrl = payload
            .relay_url_or_default()
            .parse()
            .map_err(|e| format!("bad relay url: {e}"))?;
        let peer: EndpointAddr = payload.node_addr.clone().with_relay_url(relay_url);

        // Every browser await below rides the relay WebSocket and can hang forever
        // (no UDP timeout to fall back on), so each is bounded by `CONNECT_TIMEOUT_MS`
        // — a stuck relay/offline peer becomes a clear `Err` the PWA retries on,
        // never a frozen connect. Localized to this `connect` path only.
        let conn = with_connect_timeout("dial", async {
            endpoint
                .connect(peer, ALPN)
                .await
                .map_err(|e| e.to_string())
        })
        .await?;
        let (mut send, mut recv) = with_connect_timeout("open stream", async {
            conn.open_bi().await.map_err(|e| e.to_string())
        })
        .await?;

        let (noise, sas, peer_static) = if reconnect {
            // KK reconnect: authenticate against the pinned desktop static key.
            let remote_public = B64
                .decode(&payload.public_key)
                .map_err(|e| format!("bad peer public key: {e}"))?;
            let hs = Handshake::kk_initiator(&self.local_noise_private, &remote_public)?;
            with_connect_timeout("handshake", drive_kk_initiator(hs, &mut send, &mut recv)).await?
        } else {
            // XX first pairing: bind the QR nonce as the Noise prologue.
            let nonce = B64
                .decode(&payload.nonce)
                .map_err(|e| format!("bad pairing nonce: {e}"))?;
            let hs = Handshake::xx_initiator(&self.local_noise_private, &nonce)?;
            with_connect_timeout("handshake", drive_xx_initiator(hs, &mut send, &mut recv)).await?
        };

        Ok(Paired {
            channel: SecureChannel {
                send,
                recv,
                noise: Arc::new(Mutex::new(noise)),
                _conn: conn,
                _endpoint: endpoint,
            },
            sas,
            peer_static,
        })
    }
}
