# Phase 0 — iOS proof-of-connection spike (THROWAWAY)

> This directory is a **throwaway, standalone spike**. It is intentionally
> separate from the product crates (`src-tauri/`) and the main frontend — it is
> not part of any Cargo workspace and cannot affect the main build. Its only job
> is to answer the **Phase 0 go/no-go question** from
> [`docs/IOS_WEB_CLIENT_PLAN.md`](../../docs/IOS_WEB_CLIENT_PLAN.md) §8:
>
> **Does iroh-in-browser actually hold a connection on real iOS Safari / an
> installed PWA, dialing a native iroh desktop through a relay, and survive a
> background → resume reconnect?**
>
> It carries **no Noise handshake and no SyncFrame** — it only proves the
> transport. Delete this whole directory once Phase 0 is decided.

## What's here

| Path            | What it is                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `echo-desktop/` | Native Rust binary (`iroh = "1"`). Binds an endpoint, prints its **endpoint id** + relay, echoes bytes. |
| `echo-web/`     | Rust → wasm crate (`iroh` relay-only, `getrandom` wasm_js). The browser echo client.                    |
| `web/`          | `index.html` + `app.js` + PWA manifest/icon. Loads the wasm, connects, and does the resume-reconnect.   |
| `build.sh`      | Builds `echo-web` into `web/pkg/` with `wasm-pack`.                                                     |

**Relay:** the spike uses **n0 public relays** (`presets::N0`) — zero infra, no
self-hosted relay (plan §5.5). The default relay URL shown in the UI is
`https://relay.iroh.network./`. With `presets::N0`, the dialer resolves the
desktop's relay from its endpoint id via n0 discovery, so the phone only needs
_an_ n0 public relay in that field.

---

## Prerequisites

On the **machine that runs the desktop peer and serves the page**:

- **Rust** (stable) — https://rustup.rs
- **wasm32 target**: `rustup target add wasm32-unknown-unknown`
- **wasm-pack**: `cargo install wasm-pack`
  (or `curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh`)
- **LLVM clang** — required to compile the crypto/QUIC deps to wasm.
  (Apple Clang **cannot** target wasm32; install real LLVM clang, e.g.
  `brew install llvm` on macOS / `apt install clang` on Linux.)
- An **iPhone** on the **same network is _not_ required** — traffic goes through
  the public relay, so the phone can be on cellular. But it is easiest to test
  if the phone can reach the laptop's HTTP server (same Wi-Fi) OR you deploy
  `web/` to Vercel (below).

---

## Step-by-step runbook

### 1. Run the desktop echo peer, copy its endpoint id

```bash
cd spike/ios-iroh-echo/echo-desktop
cargo run --release
```

It prints a banner like:

```
  ENDPOINT ID (paste into the phone):
    <a long base32 endpoint id>

  RELAY: n0 public relays (presets::N0).
```

**Copy the endpoint id.** Leave this running.

### 2. Build the wasm + serve the web page

```bash
cd spike/ios-iroh-echo
./build.sh                       # builds echo-web -> web/pkg/
cd web
python3 -m http.server 8000      # localhost is a secure context; fine for wasm
```

Find the laptop's LAN IP (e.g. `192.168.1.42`). On the **same Wi-Fi**, the phone
opens `http://192.168.1.42:8000`.

> A secure context (HTTPS or `localhost`) is required for wasm + PWA install.
> A plain `http://<lan-ip>` page **will load the wasm** on iOS for a quick test,
> but **"Add to Home Screen" / installed-PWA behaviour is only fully correct over
> HTTPS** — so for the real installed-PWA test, prefer Vercel (next).

#### (Recommended) deploy `web/` to Vercel as a static site

This gives you HTTPS (needed for a faithful installed-PWA test) and a stable URL
the phone can open from anywhere:

```bash
cd spike/ios-iroh-echo
./build.sh                       # produce web/pkg/ first
cd web
npx vercel deploy --prod         # or `vercel` for a preview URL
```

When Vercel asks for settings: **no build command, no framework — it is a static
directory**. Output directory = `.` (the `web/` dir, which now contains `pkg/`).
Vercel serves `.wasm` with the correct `application/wasm` type by default and
applies Brotli automatically. (The product app will prebuild wasm in CI; for the
spike, building locally and deploying the `web/` dir is fine.)

### 3. On the iPhone — install and connect

1. Open the URL in **Safari**.
2. Tap **Share → Add to Home Screen**, then **launch the app from the new icon**
   (not the Safari tab). This is the configuration that matters for iOS.
3. In the installed app: **paste the endpoint id**, leave the relay URL as the
   default n0 relay, tap **Connect**.
4. Watch the on-screen log. You should see: `binding…` → `connected.` →
   `bi stream open.` → `CONNECTED.`
5. Type a message, tap **Send**. You should see `SEND -> …` then a green
   `ECHO <- …` line, and the **desktop terminal** prints the echoed bytes.

### 4. THE CRITICAL TEST — background → resume reconnect

This is the whole point of Phase 0 (plan §4.2 / §5.8 — iOS suspends the JS
context on background and silently kills the socket):

1. With the app **connected and echoing**, **lock the phone** (or switch to
   another app / Home Screen) and **wait ≥ 30 seconds** (try 60s+ too).
2. **Reopen the app.** The log should show a `resume (...): re-dialing…` line
   immediately, then go back through `connected.` → `bi stream open.` →
   `CONNECTED.` **without you touching anything** (the page re-dials on
   `visibilitychange→visible` / `pageshow` / `online`).
3. **Send another message.** Confirm the echo round-trips again.

If reconnect does not happen automatically, tap **Connect** once — if a manual
re-dial works but the automatic one does not, note that (it is a UI/lifecycle
detail, not a transport blocker).

---

## GO / NO-GO checklist (Phase 0 exit criteria)

Tie each to the plan's Phase 0 exit: _"a throwaway wasm page on real iOS Safari +
installed PWA dials a native iroh desktop through a relay, exchanges bytes, and
survives a background→resume reconnect."_

| #   | Question                                                                                  | GO if…                                                 |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | **Connects at all?** Does the installed PWA reach `CONNECTED` + echo once?                | Yes, in Safari **and** the installed PWA.              |
| 2   | **Survives background→resume?** After ≥30s locked, does it auto-reconnect and echo again? | Yes — automatically (or at worst with one manual tap). |
| 3   | **Latency acceptable?** Round-trip echo feels interactive (rough: < ~1s).                 | Echo returns promptly; no multi-second stalls.         |
| 4   | **Stable?** Repeat the background/resume cycle 3–5×.                                      | Reconnects every time; no permanent dead state.        |

- **All four GO → proceed** to Phase 1 (extract `portcode-sync`, build the real
  WASM transport).
- **#1 fails** → iroh-in-browser does not work on iOS as assumed → **NO-GO**;
  revisit the transport decision (this is the fatal-risk gate).
- **#2 fails** (connects but never resumes) → transport is fine but the iOS
  lifecycle/resume model needs rework before committing — **conditional**; the
  product design (resume-by-cursor, §5.8) depends on resume working.
- **#3 badly fails** → relay-only latency may be unacceptable for the control
  plane → consider self-hosted relay placement earlier than planned.

Record the outcome (device model, iOS version, relay used, observed latency,
how many resume cycles) against this checklist — that is the Phase 0 deliverable.

---

## Notes / caveats

- This spike is **not wired into the workspace**. Each crate has an empty
  `[workspace]` table so it is its own root and cannot pull the main build in.
- `echo-web/.cargo/config.toml` sets `--cfg getrandom_backend="wasm_js"` and
  defaults the build target to wasm32 — **mandatory** for getrandom 0.3 on wasm.
- The framing is a trivial `u32 BE length + bytes`; both sides must match
  (`ALPN = porthex/ios-spike-echo/0`). The product uses Noise + SyncFrame instead.
- Throwaway: **delete `spike/ios-iroh-echo/` after the go/no-go decision.**
