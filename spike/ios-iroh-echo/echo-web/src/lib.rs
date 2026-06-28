//! THROWAWAY Phase-0 iOS spike — browser echo client (Rust -> wasm).
//!
//! Minimal iroh-in-browser client that dials a native desktop echo peer
//! *by endpoint id, through an n0 public relay*, opens one bi stream, and
//! echoes text. Exposes a tiny `#[wasm_bindgen]` surface to `web/index.html`:
//!
//!   - `EchoClient.connect(endpoint_id, relay_url)` -> Promise
//!   - `EchoClient.send(text)`
//!   - `EchoClient.on_message(cb)`  (cb: (string) => void)
//!   - `EchoClient.on_status(cb)`   (cb: (string) => void)  // log line
//!   - `EchoClient.disconnect()`
//!
//! This is intentionally NOT the product transport. It carries no Noise
//! handshake and no SyncFrame — it only proves iroh holds a relayed connection
//! on iOS Safari / an installed PWA and survives a background -> resume re-dial.
//!
//! Facts baked in (plan §4.1):
//!   - browser iroh is relay-only over WebSocket;
//!   - dial by endpoint id (iroh 1.0 renamed NodeId -> EndpointId);
//!   - `presets::N0` gives n0 public relays + discovery for free.

use std::cell::RefCell;
use std::rc::Rc;

use futures_util::lock::Mutex as AsyncMutex;
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointId};
use std::str::FromStr;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

/// ALPN for the spike. The desktop peer MUST advertise the exact same bytes.
const ALPN: &[u8] = b"porthex/ios-spike-echo/0";

/// One-time wasm init: route panics to the JS console so on-device failures
/// are debuggable in Safari Web Inspector.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// The send and receive halves of the live connection are guarded by INDEPENDENT
/// locks: the read loop parks inside `read_exact` holding only the recv lock, so a
/// concurrent `send()` (which takes only the send lock) is never blocked by an
/// in-flight read. (A single mutex over both halves deadlocks: the read loop holds
/// it across the blocking `read_exact`, so `send`/`connect` can never acquire it
/// and the echo never round-trips.) The `Connection` is held alive next to the
/// send half so dropping the channel tears the stream down.
struct SendHalf {
    send: SendStream,
    // Hold the Connection so it is not dropped (which would close the stream).
    _conn: Connection,
}

#[wasm_bindgen]
pub struct EchoClient {
    endpoint: Rc<RefCell<Option<Endpoint>>>,
    send_half: Rc<AsyncMutex<Option<SendHalf>>>,
    recv_half: Rc<AsyncMutex<Option<RecvStream>>>,
    on_message: Rc<RefCell<Option<js_sys::Function>>>,
    on_status: Rc<RefCell<Option<js_sys::Function>>>,
}

#[wasm_bindgen]
impl EchoClient {
    #[wasm_bindgen(constructor)]
    pub fn new() -> EchoClient {
        EchoClient {
            endpoint: Rc::new(RefCell::new(None)),
            send_half: Rc::new(AsyncMutex::new(None)),
            recv_half: Rc::new(AsyncMutex::new(None)),
            on_message: Rc::new(RefCell::new(None)),
            on_status: Rc::new(RefCell::new(None)),
        }
    }

    /// Register the inbound-message callback: `(text: string) => void`.
    #[wasm_bindgen(js_name = onMessage)]
    pub fn on_message(&self, cb: js_sys::Function) {
        *self.on_message.borrow_mut() = Some(cb);
    }

    /// Register the status/log callback: `(line: string) => void`.
    #[wasm_bindgen(js_name = onStatus)]
    pub fn on_status(&self, cb: js_sys::Function) {
        *self.on_status.borrow_mut() = Some(cb);
    }

    /// Dial the desktop echo peer by endpoint id through the relay and open a
    /// bi stream. `relay_url` is accepted for parity with the runbook/UI; with
    /// `presets::N0` discovery resolves the peer's relay from its id, so the
    /// value is logged but not required to be the same string on both sides as
    /// long as both use n0 public relays. Resolves (JS Promise) on success.
    #[wasm_bindgen]
    pub async fn connect(&self, endpoint_id: String, relay_url: String) -> Result<(), JsValue> {
        self.status(&format!(
            "connect: dialing endpoint_id={} via relay={}",
            short(&endpoint_id),
            relay_url
        ));

        // Reuse the endpoint across reconnects when possible; (re)bind if absent.
        if self.endpoint.borrow().is_none() {
            self.status("binding browser endpoint (relay-only, presets::N0)…");
            let ep = Endpoint::bind(iroh::endpoint::presets::N0)
                .await
                .map_err(to_js)?;
            self.status(&format!("bound. local id={}", short(&ep.id().to_string())));
            *self.endpoint.borrow_mut() = Some(ep);
        }

        let ep = self
            .endpoint
            .borrow()
            .clone()
            .expect("endpoint just bound");

        let peer = EndpointId::from_str(endpoint_id.trim())
            .map_err(|e| JsValue::from_str(&format!("bad endpoint id: {e}")))?;

        self.status("opening relayed QUIC connection…");
        let conn = ep.connect(peer, ALPN).await.map_err(to_js)?;
        self.status("connected. opening bi stream…");
        let (send, recv) = conn.open_bi().await.map_err(to_js)?;
        self.status("bi stream open. ready to echo.");

        // Install the two halves under their independent locks.
        *self.send_half.lock().await = Some(SendHalf { send, _conn: conn });
        *self.recv_half.lock().await = Some(recv);

        // Spawn the read loop that fires on_message per echoed chunk.
        self.spawn_read_loop();
        Ok(())
    }

    /// Send one text line to the peer (length-prefixed: u32 BE len + bytes).
    #[wasm_bindgen]
    pub fn send(&self, text: String) {
        let send_half = self.send_half.clone();
        let status = self.on_status.clone();
        spawn_local(async move {
            // Take ONLY the send lock — the read loop holds the recv lock, so this
            // never contends with an in-flight read (that was the deadlock).
            let mut guard = send_half.lock().await;
            let Some(half) = guard.as_mut() else {
                emit(&status, "send: not connected");
                return;
            };
            let bytes = text.into_bytes();
            // Mirror the inbound `1 << 20` frame cap on the OUTBOUND side: reject an
            // oversized frame BEFORE writing any bytes, so a too-large send can't put
            // a length prefix the peer will reject mid-frame on the wire (which would
            // desync the stream). Matches the read loop's `len > 1 << 20` guard.
            if bytes.len() > 1 << 20 {
                emit(
                    &status,
                    &format!("send: frame of {} bytes exceeds the 1 MiB cap", bytes.len()),
                );
                return;
            }
            let len = (bytes.len() as u32).to_be_bytes();
            if let Err(e) = half.send.write_all(&len).await {
                emit(&status, &format!("send error (len): {e}"));
                return;
            }
            if let Err(e) = half.send.write_all(&bytes).await {
                emit(&status, &format!("send error (body): {e}"));
                return;
            }
            emit(&status, &format!("sent {} bytes", bytes.len()));
        });
    }

    /// Tear down the live channel. The endpoint is kept bound so a resume
    /// re-dial is fast. Idempotent — safe to call on every visibility change.
    ///
    /// AWAITABLE: `async`, so wasm-bindgen exposes it as a Promise that resolves
    /// only AFTER both channel halves are dropped (the Connection torn down). The JS
    /// `resumeReconnect` `await`s this before re-dialing, so the old connection is
    /// fully gone before the new dial — no two-connections race on resume.
    #[wasm_bindgen]
    pub async fn disconnect(&self) {
        // Drop both halves. Dropping the send half drops the Connection, which also
        // fails the read loop's next `read_exact` so it exits.
        let dropped_send = self.send_half.lock().await.take().is_some();
        self.recv_half.lock().await.take();
        if dropped_send {
            emit(&self.on_status, "disconnected (channel dropped)");
        }
    }

    fn spawn_read_loop(&self) {
        let recv_half = self.recv_half.clone();
        let on_message = self.on_message.clone();
        let status = self.on_status.clone();
        spawn_local(async move {
            loop {
                // Hold ONLY the recv lock across the blocking read, so a concurrent
                // `send()` (send lock) is never blocked by an in-flight read.
                let mut guard = recv_half.lock().await;
                let Some(recv) = guard.as_mut() else {
                    // Channel was dropped (disconnect / resume). Stop the loop.
                    break;
                };
                let mut len_buf = [0u8; 4];
                if let Err(e) = read_exact(recv, &mut len_buf).await {
                    emit(&status, &format!("read loop ended: {e}"));
                    break;
                }
                let len = u32::from_be_bytes(len_buf) as usize;
                if len == 0 || len > 1 << 20 {
                    emit(&status, &format!("read loop: bad frame len {len}"));
                    break;
                }
                let mut body = vec![0u8; len];
                if let Err(e) = read_exact(recv, &mut body).await {
                    emit(&status, &format!("read loop ended: {e}"));
                    break;
                }
                drop(guard); // release the recv lock before invoking JS
                let text = String::from_utf8_lossy(&body).to_string();
                if let Some(cb) = on_message.borrow().as_ref() {
                    let _ = cb.call1(&JsValue::NULL, &JsValue::from_str(&text));
                }
            }
        });
    }

    fn status(&self, line: &str) {
        emit(&self.on_status, line);
    }
}

impl Default for EchoClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Read exactly `buf.len()` bytes from a RecvStream (iroh's read_exact returns
/// a ReadExactError; map it to a String).
async fn read_exact(recv: &mut RecvStream, buf: &mut [u8]) -> Result<(), String> {
    recv.read_exact(buf).await.map_err(|e| e.to_string())
}

fn emit(cb: &Rc<RefCell<Option<js_sys::Function>>>, line: &str) {
    web_sys::console::log_1(&JsValue::from_str(line));
    if let Some(f) = cb.borrow().as_ref() {
        let _ = f.call1(&JsValue::NULL, &JsValue::from_str(line));
    }
}

fn to_js<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn short(id: &str) -> String {
    if id.len() > 16 {
        format!("{}…{}", &id[..8], &id[id.len() - 6..])
    } else {
        id.to_string()
    }
}
