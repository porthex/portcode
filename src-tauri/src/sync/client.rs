//! Phone Sync — the MOBILE CLIENT session loop (the dual of `server.rs`).
//!
//! After pairing the phone RECEIVES forwarded live frames and SENDS commands.
//! `run_client_session` composes the two tested phone-side primitives
//! (`session::run_client_recv` + `session::send_command`) over a split
//! `SecureChannel`, relaying frames to the UI via `app.emit` and draining a
//! command mpsc, then self-clears its `AppState` slot when the session ends so a
//! desktop-initiated drop is observed by the UI as a clean disconnect.

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter}; // Emitter brings `app.emit` into scope
use tokio::sync::mpsc::UnboundedReceiver;

use crate::sync::protocol::RemoteCommand;
use crate::sync::session::send_command;
use crate::sync::transport::SecureChannel;

/// Tauri event channel the UI listens on for forwarded frames.
pub const FRAME_EVENT: &str = "phone-sync://frame";

/// Tauri event emitted when the live session ends because the channel died
/// unexpectedly (the desktop closed it, or the network dropped). A phone-INITIATED
/// disconnect removes the UI listener before tearing down, so the UI only observes
/// this for an unexpected drop — its cue to leave the dead session and offer a
/// one-tap reconnect.
pub const DISCONNECT_EVENT: &str = "phone-sync://disconnected";

/// Live-connection holder stored in `AppState`. Dropping `commands` ends the
/// send loop; aborting `task` ends the session.
pub struct PhoneClientConn {
    /// Push remote commands to the live send loop. Dropping it ends that loop.
    pub commands: tokio::sync::mpsc::UnboundedSender<RemoteCommand>,
    /// The spawned session task; aborted on disconnect.
    pub task: tauri::async_runtime::JoinHandle<()>,
    /// Identity token for this session. The task self-clears the slot only when
    /// the installed connection still carries the SAME token (by pointer), so a
    /// concurrent reconnect that replaced this connection is never wiped.
    pub token: Arc<()>,
}

/// Run one client session: split the paired channel, then concurrently
/// (a) relay every inbound `SyncFrame` to the UI via `app.emit`, and
/// (b) forward UI-issued `RemoteCommand`s to the desktop. Returns when either
/// the channel closes (recv ends) or the command sender is dropped (send ends);
/// on return it self-clears `slot` so the UI's next state read sees
/// "disconnected".
pub async fn run_client_session(
    channel: SecureChannel,
    app: AppHandle,
    mut commands: UnboundedReceiver<RemoteCommand>,
    slot: Arc<Mutex<Option<PhoneClientConn>>>,
    token: Arc<()>,
    installed: tokio::sync::oneshot::Receiver<()>,
) {
    // Wait until `phone_sync_connect` has INSTALLED this connection (carrying our
    // `token`) into `slot` before doing anything. Otherwise, if the freshly-paired
    // channel dies in the window before install, the loops below would end and the
    // self-clear tail would run against a slot that does NOT yet hold our token
    // (ptr_eq false → no-op) — then install would publish a connection whose task
    // has already exited and whose channel is dead, a permanent phantom "connected".
    // A dropped sender (connect aborted before signalling) resolves `Err`, meaning
    // nothing was installed, so we simply exit without touching the slot.
    if installed.await.is_err() {
        return;
    }
    let (mut sender, mut receiver) = channel.split();
    // Clone the handle for the frame-relay loop so the original `app` stays free to
    // emit the disconnect event after the session ends.
    let frame_app = app.clone();

    // recv loop: emit each inbound frame to the UI until the channel closes.
    //
    // This is the inline equivalent of `session::run_client_recv` (loop on
    // `recv` → relay, stop on error). We do NOT call `run_client_recv` here even
    // though it expresses exactly this: its `&mut dyn FnMut(SyncFrame)` parameter
    // is `!Send`, and a value of that type would be held across the inner await,
    // which would make THIS future `!Send` and reject it from
    // `tauri::async_runtime::spawn` (which requires `Future + Send`). Reading the
    // recv half directly keeps the only values held across the await
    // (`&mut ChannelReceiver`, `AppHandle`) `Send`. `run_client_recv` stays the
    // tested primitive (and the headless test below drives it).
    let recv = async {
        while let Ok(frame) = receiver.recv_frame().await {
            let _ = frame_app.emit(FRAME_EVENT, frame);
        }
    };
    // send loop: drain commands until the UI drops the sender (or a send fails).
    let send = async {
        while let Some(cmd) = commands.recv().await {
            if send_command(&mut sender, cmd).await.is_err() {
                break;
            }
        }
    };

    // Both halves on THIS one spawned task — no nested spawn, so no extra Send
    // bound beyond what `split` already guarantees. join! returns when BOTH end;
    // in practice when either underlying transport half dies the other follows
    // (a dropped ChannelSender tears the QUIC connection down, erroring the recv
    // stream → run_client_recv returns; a closed recv side errors the next send).
    tokio::join!(recv, send);

    // The channel ended. Notify the UI so it can leave the now-dead session and
    // offer a reconnect. (A phone-INITIATED disconnect removes the UI listener
    // before tearing down, so this is only observed for an unexpected drop.)
    let _ = app.emit(DISCONNECT_EVENT, ());

    // Self-clear — but ONLY if this session is still the installed one. A
    // concurrent reconnect may have aborted this task AND installed a new
    // `PhoneClientConn` before this tail runs (abort cannot cancel a task already
    // past its last await), so blindly clearing would wipe the live reconnect and
    // orphan its task. Compare identity tokens by pointer: clear only when the
    // slot still holds OUR token. `if let Ok` so a poisoned mutex never panics.
    if let Ok(mut guard) = slot.lock() {
        if guard
            .as_ref()
            .is_some_and(|c| Arc::ptr_eq(&c.token, &token))
        {
            guard.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // End-to-end proof that the two primitives `run_client_session` composes —
    // recv→callback (live frames) and send→command — flow over a real iroh pair
    // against the production desktop loops (`forward_live` + `handle_commands`).
    // We drive those primitives directly (not `run_client_session`) because that
    // fn needs a real `AppHandle`/`app.emit`, which can't be built headlessly —
    // exactly as `server.rs` leaves `DesktopCommandHandler` to compile-only.
    // `multi_thread` is REQUIRED for the same lazy-iroh-stream reason as
    // transport.rs's integration tests.
    #[tokio::test(flavor = "multi_thread")]
    async fn client_session_primitives_flow_over_iroh() {
        // `RemoteCommand`, `send_command`, `Arc`, and `Mutex` are already in scope
        // via the module's `use super::*`.
        use crate::llm::StreamEvent;
        use crate::sync::noise::StaticKeypair;
        use crate::sync::protocol::SyncFrame;
        use crate::sync::session::{
            forward_live, handle_commands, run_client_recv, CommandHandler,
        };
        use crate::sync::transport::{accept_and_pair, build_endpoint, connect_and_pair};
        use crate::sync::SyncHub;
        use async_trait::async_trait;
        use iroh::{RelayMode, SecretKey};

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
        let server_task =
            tokio::spawn(async move { accept_and_pair(&server_ep, &server_priv).await });
        let client = connect_and_pair(&client_ep, server_addr, &client_noise.private)
            .await
            .expect("client pairing");
        let server = server_task.await.unwrap().expect("server pairing");

        // ── server (the desktop dual): split + run both production loops ──
        let hub = SyncHub::new();
        let mut hub_rx = hub.subscribe(); // subscribe BEFORE publish
        let (mut server_send, mut server_recv) = server.channel.split();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler = Recorder { seen: seen.clone() };

        let forward =
            tokio::spawn(async move { forward_live(&mut hub_rx, &mut server_send).await });
        let intake = tokio::spawn(async move { handle_commands(&mut server_recv, &handler).await });

        // ── client: drive run_client_session's two composed halves directly ──
        let (mut c_send, mut c_recv) = client.channel.split();

        // send→command: the phone issues one RemoteCommand (what `send_command`
        // forwards inside run_client_session's send loop).
        send_command(
            &mut c_send,
            RemoteCommand::Run {
                session_id: "s1".into(),
                text: "hello from phone".into(),
            },
        )
        .await
        .expect("client sends command");

        // recv→callback: publish a live event and assert the client receives the
        // forwarded Live frame. `run_client_recv` reads exactly this off the recv
        // half; we read one frame inline (Send-safe, no spawned closure) to assert
        // the path, then confirm the loop drains-then-returns on close below.
        hub.publish("agent://s1", StreamEvent::TextDelta { text: "hi".into() });
        match c_recv.recv_frame().await.expect("client receives live") {
            SyncFrame::Live { session_id, .. } => assert_eq!(session_id, "s1"),
            other => panic!("expected Live, got {other:?}"),
        }

        // Close down: drop the hub (forward_live returns) and the client send
        // half (server recv ends → handle_commands returns). The client recv loop
        // drains then returns Ok once the channel closes.
        drop(hub);
        let mut got: Vec<SyncFrame> = Vec::new();
        {
            let mut on_frame = |f: SyncFrame| got.push(f);
            run_client_recv(&mut c_recv, &mut on_frame)
                .await
                .expect("client recv loop ok");
        }
        // The one Live frame was already consumed inline above, so the drain loop
        // sees nothing more before the channel closes and returns cleanly.
        assert!(got.is_empty());

        // Wait until the desktop has actually PROCESSED the command before tearing
        // the send half down. Dropping `c_send` resets its QUIC stream, which on a
        // slow/loaded runner can discard a not-yet-delivered command frame — that
        // race flaked `seen.len() == 1` on CI. Polling `seen` (handle_commands runs
        // concurrently and records each command) makes delivery deterministic; the
        // 2s budget still fails fast if a command genuinely never arrives.
        for _ in 0..200 {
            if !seen.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        drop(c_send);
        forward.await.unwrap().expect("forward_live ok");
        intake.await.unwrap().expect("handle_commands ok");

        // The desktop saw exactly the one command the phone sent.
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(matches!(
            &seen[0],
            RemoteCommand::Run { session_id, text }
                if session_id == "s1" && text == "hello from phone"
        ));
    }
}
