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
    /// by the `spawn_local` recv loop. Stored so [`Session::on_event`] can set it
    /// after `connect` (the loop reads it each frame, so a late registration still
    /// catches subsequent frames).
    on_event: Rc<RefCell<Option<js_sys::Function>>>,
    /// Short Authentication String to compare out-of-band before trusting the
    /// session (§5.10). Surfaced via the `sas` getter.
    sas: String,
    /// The desktop's pinned Noise static public key (base64), to persist in
    /// IndexedDB for KK reconnects (§5.8). Surfaced via the `peerPublicKey` getter.
    peer_public_key: String,
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
    pub async fn connect(qr: String, reconnect: bool) -> Result<Session, JsValue> {
        let payload: PairingPayload =
            serde_json::from_str(&qr).map_err(|e| js_err(&format!("bad QR payload: {e}")))?;

        // The phone's long-term Noise identity. Generated fresh here for Phase 2;
        // a later increment will load a persisted identity from IndexedDB so KK
        // reconnects authenticate as the same pinned device.
        let local = StaticKeypair::generate().map_err(|e| js_err(&e))?;
        let transport = WasmTransport::new(local.private_key().to_vec());

        let paired = transport
            .connect(&payload, reconnect)
            .await
            .map_err(|e| js_err(&e))?;

        // base64-encode the pinned peer key (the desktop's Noise static) for JS to
        // persist. `peer_static` is only `None` on a malformed handshake, which the
        // transport would already have rejected — treat absence as empty.
        let peer_public_key = paired
            .peer_static
            .as_deref()
            .map(b64_encode)
            .unwrap_or_default();
        let sas = paired.sas.clone();

        // Split: the recv half drives the inbound loop, the send half backs
        // `send_command`. They share the Noise transport via the channel's internal
        // Arc<Mutex>; the send half also keeps the iroh connection alive.
        let (sender, receiver) = paired.channel.split();
        let sender = Rc::new(AsyncMutex::new(Some(sender)));
        let on_event: Rc<RefCell<Option<js_sys::Function>>> = Rc::new(RefCell::new(None));

        spawn_recv_loop(receiver, Rc::clone(&on_event));

        Ok(Session {
            sender,
            on_event,
            sas,
            peer_public_key,
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
    /// loop (spawned in `connect`) invokes it once per forwarded [`SyncFrame`], with
    /// the frame converted to a native JS object via `serde-wasm-bindgen`. The store
    /// wires this to `applyFrame`.
    #[wasm_bindgen(js_name = onEvent)]
    pub fn on_event(&mut self, cb: js_sys::Function) {
        *self.on_event.borrow_mut() = Some(cb);
    }

    /// Tear down the session: drop the send half (which owns the iroh
    /// connection/endpoint keep-alive), closing the QUIC stream and ending the recv
    /// loop. Idempotent — safe to call on every `visibilitychange` (§5.8).
    #[wasm_bindgen]
    pub fn disconnect(&mut self) {
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
