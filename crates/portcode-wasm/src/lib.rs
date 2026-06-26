// This crate is the BROWSER client and is meaningful only on wasm32: it depends on
// `portcode_sync::WasmTransport` + `spawn_local`, which exist only on the wasm
// target. Gate the whole crate to wasm32 so it compiles to an EMPTY lib on native
// — that keeps it a normal workspace member (so `cargo`/clippy/CI still gate it for
// wasm via `--target wasm32-unknown-unknown`) without reddening the native
// `cargo build/clippy/test --workspace` legs, which would otherwise try (and fail)
// to compile the wasm-only `Session` for the desktop triple.
#![cfg(target_arch = "wasm32")]

//! `portcode-wasm` — the thin wasm-bindgen wrapper that exposes the Phone Sync
//! client to the browser PWA as a single `Session` class (IOS_WEB_CLIENT_PLAN.md
//! §5.4).
//!
//! It owns NO protocol logic of its own: it dials through
//! [`portcode_sync::WasmTransport`] (the relay-only browser iroh transport), runs
//! the shared `session.rs` loops, and shuttles frames across the JS boundary with
//! `serde-wasm-bindgen`. The surface is intentionally shaped like the existing
//! `src/lib/ipc.ts` (`phoneSyncConnect` → `{ sas, peerPublicKey }`,
//! `phoneSyncSendCommand`, `onPhoneSyncFrame`, `phoneSyncDisconnect`) so the React
//! store wires to it with minimal change.
//!
//! Concurrency: browser wasm is single-threaded; the inbound-frame loop runs on
//! [`wasm_bindgen_futures::spawn_local`] and the split channel halves are shared
//! through `futures_util`'s `!Send`-friendly async `Mutex` (the same pattern the
//! Phase 0 spike used). All delays elsewhere use `gloo-timers`, never
//! `tokio::time`.

use std::cell::RefCell;
use std::rc::Rc;

use futures_util::lock::Mutex as AsyncMutex;
use wasm_bindgen::prelude::*;

use portcode_sync::noise::StaticKeypair;
use portcode_sync::pairing::PairingPayload;
use portcode_sync::protocol::{RemoteCommand, SyncFrame};
use portcode_sync::session::{run_client_recv, send_command};
use portcode_sync::transport::Transport;
use portcode_sync::{ChannelReceiver, ChannelSender, WasmTransport};

/// One-time wasm init: route Rust panics to the JS console so on-device failures
/// are debuggable in the Safari Web Inspector. Mirrors the Phase 0 spike.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// A live Phone Sync session: a paired, end-to-end-encrypted channel to the
/// desktop plus the JS callback inbound frames are delivered to.
///
/// Created by [`Session::connect`]. Holds the split channel's send half (for
/// [`Session::send_command`]) behind an async mutex shared with the inbound loop,
/// the `on_event` JS callback, and the pairing metadata (`sas`, `peer_public_key`)
/// the UI needs for SAS verification + key pinning.
#[wasm_bindgen]
pub struct Session {
    /// Send half of the secure channel. `None` after [`Session::disconnect`].
    sender: Rc<AsyncMutex<Option<ChannelSender>>>,
    /// The inbound-frame callback `(frame: SyncFrame) => void`, invoked per frame
    /// by the recv loop. Stored so [`Session::on_event`] can set it; the recv loop
    /// is NOT spawned until this is set (so no early frame is dropped, see
    /// [`Session::on_event`]).
    on_event: Rc<RefCell<Option<js_sys::Function>>>,
    /// The split receive half, parked here until [`Session::on_event`] registers a
    /// callback and starts the loop. `Some` until the loop is spawned (taken then),
    /// so the recv loop never runs — and therefore never reads + drops a frame —
    /// before a callback exists to deliver it to (§ early-frame fix).
    receiver: Rc<RefCell<Option<ChannelReceiver>>>,
    /// Short Authentication String to compare out-of-band before trusting the
    /// session (§5.10). Surfaced via the `sas` getter.
    sas: String,
    /// The desktop's pinned Noise static public key (base64), to persist in
    /// IndexedDB for KK reconnects (§5.8). Surfaced via the `peerPublicKey` getter.
    /// Always the QR-advertised key (validated against the live handshake), never an
    /// empty fallback, so a later KK reconnect can't overwrite the pin with `""`.
    peer_public_key: String,
    /// The phone's long-term Noise static PRIVATE key (base64). Persist after SAS
    /// confirmation and pass back to [`Session::connect`] on reconnect so KK
    /// authenticates as the SAME pinned phone (§5.8). Surfaced via the
    /// `privateKey` getter.
    private_key: String,
}

#[wasm_bindgen]
impl Session {
    /// Dial the desktop named by the scanned QR and run the Noise handshake.
    ///
    /// `qr` is the JSON [`PairingPayload`] the desktop rendered (public key, nonce,
    /// node address, optional relay URL). `reconnect = false` runs the XX first-
    /// pairing handshake (binding the QR nonce); `reconnect = true` runs the KK
    /// fast-resume handshake against the pinned desktop key (§5.8).
    ///
    /// Resolves (as a JS Promise) with a [`Session`] whose `sas` getter holds the
    /// SAS to show for out-of-band verification and whose `peerPublicKey` getter
    /// holds the key to pin. After this, register [`Session::on_event`] to start
    /// receiving forwarded frames.
    #[wasm_bindgen]
    pub async fn connect(
        qr: String,
        reconnect: bool,
        private_key: Option<String>,
    ) -> Result<Session, JsValue> {
        let payload: PairingPayload =
            serde_json::from_str(&qr).map_err(|e| js_err(&format!("bad QR payload: {e}")))?;

        // The phone's long-term Noise identity. On a reconnect JS passes back the
        // base64 private key persisted after the FIRST pairing, so KK authenticates
        // as the SAME pinned phone (a fresh keypair would present a different static
        // and fail the desktop's pin). On a first pairing none is supplied, so we
        // generate one — and surface it via the `privateKey` getter for JS to
        // persist alongside the pinned peer key (§5.8).
        let local = match &private_key {
            Some(b64) => {
                let private = B64
                    .decode(b64)
                    .map_err(|e| js_err(&format!("bad private key: {e}")))?;
                StaticKeypair::from_parts(Vec::new(), private)
            }
            None => StaticKeypair::generate().map_err(|e| js_err(&e))?,
        };
        let private_key_b64 = b64_encode(local.private_key());
        let transport = WasmTransport::new(local.private_key().to_vec());

        let paired = transport
            .connect(&payload, reconnect)
            .await
            .map_err(|e| js_err(&e))?;

        // The pinned key is ALWAYS the QR-advertised desktop static (`payload
        // .public_key`), never a blind re-encode of the handshake `peer_static`
        // (and never an empty fallback — that would let a later KK reconnect
        // overwrite the pin with ""). On the XX first pairing we additionally
        // VALIDATE that the live handshake authenticated the very key the QR
        // advertised: decode `payload.public_key` and require the handshake's
        // `peer_static` to match it byte-for-byte, so a MITM that completed a
        // handshake as a different static can't be pinned. (On a KK reconnect the
        // desktop static is an INPUT to the handshake — it already authenticated the
        // pinned key — so there's nothing new to cross-check.)
        let pinned = B64
            .decode(&payload.public_key)
            .map_err(|e| js_err(&format!("bad QR public key: {e}")))?;
        if !reconnect {
            let peer_static = paired.peer_static.as_deref().ok_or_else(|| {
                js_err("handshake produced no peer static key (malformed handshake)")
            })?;
            if peer_static != pinned.as_slice() {
                return Err(js_err(
                    "handshake peer key does not match the scanned QR key (possible MITM)",
                ));
            }
        }
        let peer_public_key = payload.public_key.clone();
        let sas = paired.sas.clone();

        // Split: the recv half drives the inbound loop, the send half backs
        // `send_command`. They share the Noise transport via the channel's internal
        // Arc<Mutex>; the send half also keeps the iroh connection alive. The recv
        // half is PARKED (not yet looping) until `on_event` registers a callback —
        // otherwise the loop would read + drop frames that arrive before JS wires up.
        let (sender, receiver) = paired.channel.split();
        let sender = Rc::new(AsyncMutex::new(Some(sender)));
        let on_event: Rc<RefCell<Option<js_sys::Function>>> = Rc::new(RefCell::new(None));

        Ok(Session {
            sender,
            on_event,
            receiver: Rc::new(RefCell::new(Some(receiver))),
            sas,
            peer_public_key,
            private_key: private_key_b64,
        })
    }

    /// Push one [`RemoteCommand`] to the desktop. `cmd` is the JS object form of a
    /// `RemoteCommand` (`Run`/`Cancel`/`Permission`/`CreateSession`), converted via
    /// `serde-wasm-bindgen`. No-op error if the session was already disconnected.
    #[wasm_bindgen(js_name = sendCommand)]
    pub fn send_command(&self, cmd: JsValue) -> Result<(), JsValue> {
        let command: RemoteCommand = serde_wasm_bindgen::from_value(cmd)
            .map_err(|e| js_err(&format!("bad command: {e}")))?;
        let sender = Rc::clone(&self.sender);
        // Sending is async (it awaits the QUIC-in-WebSocket write), but the JS API
        // is fire-and-forget like the desktop's `phoneSyncSendCommand`; drive it on
        // the local executor. Errors surface to the console (the channel closing is
        // the expected terminal case).
        spawn_local(async move {
            let mut guard = sender.lock().await;
            let Some(tx) = guard.as_mut() else {
                console_log("sendCommand: session disconnected");
                return;
            };
            if let Err(e) = send_command(tx, command).await {
                console_log(&format!("sendCommand failed: {e}"));
            }
        });
        Ok(())
    }

    /// Register the inbound-frame callback `(frame: SyncFrame) => void`. The recv
    /// loop invokes it once per forwarded [`SyncFrame`], with the frame converted to
    /// a native JS object via `serde-wasm-bindgen`. The store wires this to
    /// `applyFrame`.
    ///
    /// The recv loop is started HERE, on the first registration — NOT in `connect`.
    /// Starting it earlier would let it read + discard any frame the desktop sends
    /// between `connect` resolving and JS wiring up `onEvent`. Parking the receiver
    /// until a callback exists means the first frame is the first one delivered. A
    /// later re-registration just swaps the callback (the loop reads `on_event` each
    /// frame), so it never spawns a second loop.
    #[wasm_bindgen(js_name = onEvent)]
    pub fn on_event(&mut self, cb: js_sys::Function) {
        *self.on_event.borrow_mut() = Some(cb);
        if let Some(receiver) = self.receiver.borrow_mut().take() {
            spawn_recv_loop(receiver, Rc::clone(&self.on_event));
        }
    }

    /// Tear down the session: drop the send half (which owns the iroh
    /// connection/endpoint keep-alive), closing the QUIC stream and ending the recv
    /// loop. Idempotent — safe to call on every `visibilitychange` (§5.8).
    #[wasm_bindgen]
    pub fn disconnect(&mut self) {
        // Drop a still-parked receiver (the case where `onEvent` was never called,
        // so no recv loop ever started) so the channel tears down fully.
        let _ = self.receiver.borrow_mut().take();
        let sender = Rc::clone(&self.sender);
        spawn_local(async move {
            // Dropping the ChannelSender drops the Connection + Endpoint, which
            // resets the stream; the recv half's next read then errors and
            // `run_client_recv` returns, ending the loop.
            let _ = sender.lock().await.take();
        });
    }

    /// The Short Authentication String to compare out-of-band before trusting the
    /// session (§5.10). Stable for the life of the session.
    #[wasm_bindgen(getter)]
    pub fn sas(&self) -> String {
        self.sas.clone()
    }

    /// The desktop's pinned Noise static public key (base64) — persist in IndexedDB
    /// after SAS confirmation to enable KK reconnects (§5.8).
    #[wasm_bindgen(getter, js_name = peerPublicKey)]
    pub fn peer_public_key(&self) -> String {
        self.peer_public_key.clone()
    }

    /// The phone's own long-term Noise static PRIVATE key (base64) — persist after
    /// SAS confirmation and pass back as the third `connect` arg on reconnect so KK
    /// authenticates as the SAME pinned phone (§5.8). NEVER log or expose it
    /// elsewhere.
    #[wasm_bindgen(getter, js_name = privateKey)]
    pub fn private_key(&self) -> String {
        self.private_key.clone()
    }
}

/// Spawn the inbound-frame loop: read forwarded frames from the channel's recv half
/// and fire the stored `on_event` callback per frame, until the channel closes.
/// This is the phone-side dual of the desktop's `forward_live`, driven through the
/// shared [`run_client_recv`] so no protocol logic is duplicated here.
fn spawn_recv_loop(mut receiver: ChannelReceiver, on_event: Rc<RefCell<Option<js_sys::Function>>>) {
    spawn_local(async move {
        let mut on_frame = |frame: SyncFrame| {
            // Convert the frame to a native JS object and hand it to the callback.
            // A serialize error or a JS-side throw is logged, not fatal — the loop
            // keeps mirroring subsequent frames.
            let Some(cb) = on_event.borrow().clone() else {
                return; // no callback registered yet; drop this frame
            };
            match serde_wasm_bindgen::to_value(&frame) {
                Ok(js) => {
                    let _ = cb.call1(&JsValue::NULL, &js);
                }
                Err(e) => console_log(&format!("frame serialize failed: {e}")),
            }
        };
        if let Err(e) = run_client_recv(&mut receiver, &mut on_frame).await {
            console_log(&format!("recv loop ended: {e}"));
        }
    });
}

// ── small helpers ─────────────────────────────────────────────────────────────

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use wasm_bindgen_futures::spawn_local;

fn b64_encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

fn js_err(msg: &str) -> JsValue {
    JsValue::from_str(msg)
}

fn console_log(line: &str) {
    web_sys::console::log_1(&JsValue::from_str(line));
}
