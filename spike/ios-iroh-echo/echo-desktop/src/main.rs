//! THROWAWAY Phase-0 iOS spike — native desktop echo peer.
//!
//! Binds a native iroh endpoint (presets::N0 -> n0 public relays + discovery),
//! prints its **endpoint id** (paste this into the phone) and the relay it is
//! using, then accepts incoming connections and echoes every length-prefixed
//! frame back. Pairs with `echo-web` (the wasm browser client).
//!
//! Framing matches the browser client: u32 big-endian length, then that many
//! UTF-8 bytes. We read a frame and write the identical frame back.
//!
//! Run:  cargo run --release   (from spike/ios-iroh-echo/echo-desktop/)

use anyhow::Result;
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::Endpoint;
// iroh's SendStream/RecvStream impl tokio's AsyncWrite/AsyncRead; we use the
// AsyncWriteExt::flush method. write_all/read_exact are inherent on the iroh
// streams (inherent methods take priority over the trait's).
use tokio::io::AsyncWriteExt;

/// Must byte-for-byte match `ALPN` in echo-web/src/lib.rs.
const ALPN: &[u8] = b"porthex/ios-spike-echo/0";

#[tokio::main]
async fn main() -> Result<()> {
    let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await?;

    let id = endpoint.id();

    // Give discovery/relay a moment to settle so we can print a relay home.
    println!("=========================================================");
    println!(" Portcode iOS spike — DESKTOP ECHO PEER");
    println!("=========================================================");
    println!();
    println!("  ENDPOINT ID (paste into the phone):");
    println!("    {id}");
    println!();
    println!("  RELAY: n0 public relays (presets::N0).");
    println!("    In the phone's relay field you can paste:");
    println!("      https://relay.iroh.network./");
    println!("    (With presets::N0 the dialer resolves this peer's relay from");
    println!("     its endpoint id via n0 discovery, so the exact string only");
    println!("     needs to be an n0 public relay.)");
    println!();
    println!("  ALPN: {}", String::from_utf8_lossy(ALPN));
    println!();
    println!("  Waiting for the phone to connect… (Ctrl-C to quit)");
    println!("=========================================================");

    // Accept loop. One connection per phone; echo on its bi stream(s).
    while let Some(incoming) = endpoint.accept().await {
        tokio::spawn(async move {
            match incoming.await {
                Ok(conn) => {
                    if let Err(e) = handle(conn).await {
                        eprintln!("[conn] ended: {e}");
                    }
                }
                Err(e) => eprintln!("[accept] handshake failed: {e}"),
            }
        });
    }

    Ok(())
}

async fn handle(conn: Connection) -> Result<()> {
    // On an accepted (HandshakeCompleted) connection, remote_id() -> EndpointId.
    let remote = conn.remote_id().to_string();
    println!("[conn] phone connected: {remote}");

    // The browser opens the bi stream; we accept it.
    let (mut send, mut recv) = conn.accept_bi().await?;
    println!("[conn] bi stream accepted; echoing…");

    loop {
        match read_frame(&mut recv).await {
            Ok(Some(body)) => {
                let text = String::from_utf8_lossy(&body);
                println!("[echo] {} bytes: {:?}", body.len(), text);
                write_frame(&mut send, &body).await?;
            }
            Ok(None) => {
                println!("[conn] stream closed by phone");
                break;
            }
            Err(e) => {
                eprintln!("[conn] read error: {e}");
                break;
            }
        }
    }
    Ok(())
}

/// Read one u32-BE-length-prefixed frame. Ok(None) on clean EOF.
async fn read_frame(recv: &mut RecvStream) -> Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match recv.read_exact(&mut len_buf).await {
        Ok(()) => {}
        // Clean end-of-stream while waiting for the next frame.
        Err(_) => return Ok(None),
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 || len > 1 << 20 {
        anyhow::bail!("bad frame length {len}");
    }
    let mut body = vec![0u8; len];
    recv.read_exact(&mut body).await?;
    Ok(Some(body))
}

async fn write_frame(send: &mut SendStream, body: &[u8]) -> Result<()> {
    let len = (body.len() as u32).to_be_bytes();
    send.write_all(&len).await?;
    send.write_all(body).await?;
    send.flush().await?;
    Ok(())
}
