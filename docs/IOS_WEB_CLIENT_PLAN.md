# iOS Web Client Plan — Phone Sync over iroh-in-the-browser (Vercel PWA)

> **Status:** Design / RFC. Not yet implemented. This document is the buildable
> plan for shipping a **browser-based Phone Sync client** — a static PWA hosted
> on Vercel that an **iOS** user opens, pairs with their desktop Portcode, and
> uses to watch and drive a live coding session.
>
> It builds directly on the existing Phone Sync stack (`src-tauri/src/sync/`,
> see `docs/ANDROID_APP_PLAN.md`) and reuses that Rust protocol code **compiled
> to WebAssembly** rather than reimplementing it in JavaScript.

---

## 1. Goal & constraints (the decisions this plan is built on)

| Decision              | Choice                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transport**         | Reuse **iroh in the browser (WASM)** — dial the desktop directly into the existing iroh network. No bespoke relay protocol, no WebSocket-tunnel-of-our-own. |
| **What Vercel hosts** | **Only the static client UI** (the PWA: HTML/JS/CSS/wasm). No backend functions, no relay, no persistent server on Vercel.                                  |
| **Primary target**    | **iOS** (Safari + installed Home-Screen PWA). Android/desktop browsers are a free side-benefit, not the design driver.                                      |
| **This deliverable**  | A deeply-researched, buildable design — not code yet.                                                                                                       |

Everything below honours those four constraints. Where a constraint forces a
non-obvious decision (e.g. Vercel _cannot_ be the relay), it is called out.

---

## 2. Feasibility verdict

**Viable, with one architectural shift and one mandatory up-front spike.**

The formerly fatal assumption — "a browser can't speak iroh" — is **false as of
iroh 1.0 (released 2026-06-15)**, which officially compiles to
`wasm32-unknown-unknown` and runs in the browser (CI-maintained). The remaining
work is real but bounded:

1. **The shift:** browser iroh nodes are **relay-only** (no UDP, no
   hole-punching). Every browser↔desktop byte transits an **iroh relay over a
   WebSocket** — still **end-to-end encrypted** (the relay forwards opaque
   ciphertext). We should **self-host an `iroh-relay`** to own latency,
   rate-limits, and version compatibility.
2. **The spike:** iroh's browser leg is the youngest part of an otherwise-1.0
   stack and has **no first-party iOS certification**. **Phase 0 is an on-device
   iOS proof-of-connection** before any product code is written.

Crucially, the existing protocol code is already structured to make this cheap:

- `snow = "0.10"` uses the **pure-Rust resolver** by default → compiles to wasm
  unchanged (cipher suite `Noise_XX_25519_ChaChaPoly_BLAKE2s` is all
  RustCrypto/dalek).
- The shared `session.rs` uses **only `tokio::sync` channels** (broadcast/mpsc),
  which work on wasm — no `tokio::time`, no `tokio::spawn` in shared code.
- `protocol.rs` / `noise.rs` / `session.rs` are already cross-platform and carry
  no desktop-only assumptions; only `transport.rs` (native iroh endpoint) needs
  a browser sibling.
- The frontend already has the seams: `connectRemote` / `applyFrame` /
  `reconnectRemote` in `store.ts`, `remoteMode` shell, `RemotePairing.tsx`, and
  an `ipc.ts` that already carries a browser mock.

---

## 3. Architecture

```
                                  ┌──────────────────────────────────────┐
                                  │  iOS device (Safari / installed PWA)  │
   Vercel (static CDN)            │                                       │
   ┌────────────────────┐  load   │  ┌────────────────────────────────┐   │
   │ PWA shell          │────────▶│  │ React UI (reused store.ts,     │   │
   │  - index.html      │         │  │ RemotePairing, Chat, applyFrame)│   │
   │  - JS/CSS bundle   │         │  └───────────────┬────────────────┘   │
   │  - portcode_wasm   │         │     wasm-bindgen  │ connect()/sendCmd()/onEvent()
   │    (_bg.wasm)      │         │  ┌───────────────▼────────────────┐   │
   │  - manifest + SW   │         │  │ portcode-wasm  (Rust→WASM)      │   │
   └────────────────────┘         │  │  Noise (snow) + SyncFrame +     │   │
        static only;              │  │  session loop + BROWSER iroh     │   │
        NO relay, NO backend      │  └───────────────┬────────────────┘   │
                                  └──────────────────┼────────────────────┘
                                                     │ QUIC-in-WebSocket
                                                     │ (E2E encrypted; relay is blind)
                                          ┌──────────▼───────────┐
                                          │  iroh-relay          │  ◀── self-hosted
                                          │  (WebSocket)         │      (Fly/Render/VPS)
                                          └──────────┬───────────┘
                                                     │ relay leg
                                  ┌──────────────────▼────────────────────┐
                                  │  Desktop Portcode (Tauri, native iroh) │
                                  │  unchanged sync SERVER: runs the agent,│
                                  │  tools, DB, permission gate.           │
                                  │  Reachable by node id through relay.   │
                                  └────────────────────────────────────────┘
```

**Key properties**

- **Vercel is a dumb CDN.** It serves files. The live connection never touches
  it — it goes browser → relay → desktop.
- **The desktop is unchanged in spirit.** It already runs an iroh endpoint + the
  sync server. It only needs to (a) be configured with the **same relay** the
  browser uses, and (b) be **version-aligned** with the browser's iroh.
- **The relay is the one new piece of always-on infra.** It is _not_ on Vercel.
  It can be n0's public relays for the spike, but should be **self-hosted** for
  the product (cost/latency/version control). The relay never sees plaintext.

---

## 4. Research basis (condensed, with sources)

Four parallel research streams informed this plan. Highlights:

### 4.1 iroh-in-browser (the transport)

- iroh **1.0 (2026-06-15)** officially supports `wasm32-unknown-unknown` via
  wasm-bindgen; tracked issue #2799 closed for 1.0-rc.
- Browser nodes are **relay-only over WebSocket** — no direct/hole-punched
  connections. This is by design (browsers have no UDP), not a temporary gap. As
  of iroh **0.91 (2025-08-01)** _all_ relay traffic is WebSocket-based.
- A browser node **dials a native desktop by node id through a shared relay**;
  the desktop behind NAT is the documented happy path (it holds its own relay
  WebSocket). Connections stay mutually authenticated + E2E encrypted.
- **iOS-safe by construction:** the browser leg rides WebSocket (supported on
  iOS forever), _not_ WebTransport — so iOS is the expected environment.
- Build: `iroh = { version = "1", default-features = false }` (drops `metrics`,
  which breaks wasm). `getrandom` needs `wasm_js` + the cfg flag (see §6.3).
- Risk: youngest surface; no iroh first-party iOS cert; relay-only latency;
  **relay protocol is version-locked across browser/desktop/relay**.
- Sources: <https://docs.iroh.computer/deployment/wasm-browser-support> ·
  <https://www.iroh.computer/blog/v1> ·
  <https://www.iroh.computer/blog/iroh-and-the-web> ·
  <https://github.com/n0-computer/iroh-examples/tree/main/browser-echo> ·
  <https://github.com/n0-computer/iroh/discussions/3200>

### 4.2 iOS Safari / PWA constraints

- **WebSocket** is baseline on iOS; **WebTransport** only shipped in **Safari
  26.4 (~Mar 2026)** with a tiny mid-2026 install base — WebSocket fallback is
  mandatory (matches iroh anyway).
- **Backgrounding suspends the JS context within seconds and drops all
  connections.** No keep-alive, no Background Sync/Fetch, no silent push. The
  fix is **reconnect-on-resume + server-side catch-up by cursor** — which the
  protocol already supports (`Cursor` + `Db::messages_since`).
- **Web Push works on _installed_ iOS PWAs since iOS 16.4** — good for
  "permission needed" / "turn finished" re-engagement (visible notifications
  only; ~70–85% reliable → keep an in-app decision queue).
- **Camera/QR:** `getUserMedia` works in standalone PWAs since iOS 13.4; use
  **zxing-wasm** + a `<input capture>` file fallback (no `BarcodeDetector` on
  iOS). Permission re-prompts in standalone — keep the scanner on a stable URL.
- **Install is a hard prerequisite** (P0): it gates Web Push, durable storage
  (`navigator.storage.persist()` granted only for installed apps), and the
  correct storage **partition** — a key written in a Safari tab is invisible to
  the installed app. **Pair inside the installed app.**
- **Storage:** IndexedDB for the pinned key; call+verify `persist()`; design a
  re-pair fallback (7-day ITP eviction + clears still possible).
- Sources: <https://webkit.org/blog/17862/webkit-features-for-safari-26-4/> ·
  <https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/> ·
  <https://webkit.org/blog/14403/updates-to-storage-policy/> ·
  <https://bugs.webkit.org/show_bug.cgi?id=215884> ·
  <https://caniuse.com/webtransport>

### 4.3 Rust→WASM feasibility (the stack)

- **snow 0.10** default = pure-Rust resolver → wasm-safe. **Do not enable
  `ring`** (doesn't build for wasm32-unknown-unknown).
- **tokio:** runtime/timers **don't** work on browser wasm, but **`tokio::sync`
  channels do** (the only tokio our shared `session.rs` uses). Spawn via
  **`wasm_bindgen_futures::spawn_local`**; delays via **`gloo-timers`**.
- **getrandom 0.3** needs **both** `features=["wasm_js"]` **and**
  `--cfg getrandom_backend="wasm_js"` (enable in the wasm crate only).
- One shared crate + a thin `cdylib` wrapper; gate deps with
  `[target.'cfg(...)']`; `protocol.rs`/`noise.rs` carry zero cfg.
- Interop: `serde-wasm-bindgen` + `tsify` (not `tsify-next`, now unmaintained);
  async fns auto-return JS Promises; incoming frames via a stored
  `js_sys::Function` callback.
- Build: `wasm-pack build --target web`; **no COOP/COEP** needed (no threads).
  Vercel has no Rust toolchain → **prebuild the wasm in GitHub Actions**.
- Size risk: QUIC+crypto+serde can hit hundreds of KB–>1 MB → lazy-load the wasm
  chunk, `opt-level="z"` + `lto`, Brotli (Vercel default), measure with twiggy.
- Sources: <https://docs.rs/tokio/latest/tokio/#wasm-support> ·
  <https://github.com/RReverser/serde-wasm-bindgen> ·
  <https://github.com/madonoharu/tsify> ·
  <https://github.com/Menci/vite-plugin-wasm>

---

## 5. Detailed design

### 5.1 Rust workspace restructure

Today all sync code lives inside the `src-tauri` crate. To target both native
(desktop) and `wasm32` from one source of truth, extract a shared crate:

```
portcode/
├── Cargo.toml                      # [workspace] resolver = "2"
├── crates/
│   ├── portcode-sync/              # SHARED protocol + crypto + session + transport trait
│   │   ├── Cargo.toml              # target-gated deps (native iroh vs browser iroh)
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── protocol.rs         # MOVED verbatim from src-tauri/src/sync/
│   │       ├── noise.rs            # MOVED verbatim (snow pure-resolver)
│   │       ├── session.rs          # MOVED verbatim (tokio::sync channels only)
│   │       ├── pairing.rs          # MOVED verbatim (PairingPayload / QR format)
│   │       ├── transport.rs        # the Transport trait + shared framing
│   │       ├── transport_native.rs # #[cfg(not(wasm32))] iroh native endpoint
│   │       └── transport_wasm.rs   # #[cfg(wasm32)] iroh browser endpoint
│   └── portcode-wasm/              # THIN wasm-bindgen wrapper (cdylib)
│       ├── Cargo.toml              # crate-type = ["cdylib", "rlib"]
│       └── src/lib.rs              # #[wasm_bindgen] Session API (§5.4)
├── src-tauri/                      # desktop binary → depends on portcode-sync (native)
│   └── src/sync/                   # server.rs + pairing_gate.rs + client.rs stay here
│                                   #   (desktop/mobile-specific; re-export shared types)
└── src/, web/, package.json, ...   # frontends (§5.6)
```

**Migration is mechanical, not a rewrite:**

- `protocol.rs`, `noise.rs`, `session.rs`, `pairing.rs` move into
  `portcode-sync` **unchanged** (verified wasm-safe in §2).
- `transport.rs` splits: the `SyncFrame` length-framing + a new `Transport`
  trait stay shared; the iroh `Endpoint`/`Connection` code becomes
  `transport_native.rs`; a new `transport_wasm.rs` builds the browser endpoint.
- `server.rs`, `pairing_gate.rs` (both already `#[cfg(desktop)]`) and `client.rs`
  stay in `src-tauri` — they depend on Tauri/agent/db and are not part of the
  wasm client. `src-tauri` re-exports shared types from `portcode-sync` so the
  rest of the desktop code is untouched.

> The same `portcode-sync` crate is what the **native mobile (Android)** client
> will also consume — so this restructure pays for both the web _and_ the native
> mobile roadmaps.

### 5.2 The `Transport` trait (the one real abstraction)

`session.rs`'s loops already talk to traits (`FrameSink`/`FrameSource`/
`FrameChannel`). We add a connection-establishment trait so the session loop is
transport-agnostic:

```rust
// portcode-sync/src/transport.rs (shared)
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait Transport {
    /// Dial a peer by its pinned node identity + relay, run the Noise XX/KK
    /// handshake, and return an established, split-able secure channel + SAS.
    async fn connect(&self, payload: &PairingPayload, reconnect: bool)
        -> Result<Paired, String>;
}
```

- **Native** (`transport_native.rs`, `#[cfg(not(wasm32))]`): the existing iroh
  `Endpoint::builder(...).bind()` + dial-by-pubkey code, moved verbatim.
- **Browser** (`transport_wasm.rs`, `#[cfg(wasm32)]`): iroh endpoint with
  `default-features = false`, **relay mode forced** (browser can't do direct),
  configured with our relay URL. Same ALPN (`porthex/phone-sync/0`), same Noise
  handshake on top — the `Paired`/`SecureChannel` surface is identical, so
  `session.rs` doesn't know or care which transport it got.

`Send` note: browser futures are `!Send`. The shared session loop must therefore
either be generic (`T: Transport`, static dispatch, no `dyn`) or, where `dyn` is
needed, use the cfg-gated `async_trait(?Send)` above. On native this means the
session task runs on a `current_thread`/`LocalSet` runtime rather than the
multi-thread pool — a small, contained change to the spawn site in `client.rs`.

### 5.3 WASM build configuration

`crates/portcode-sync/Cargo.toml`:

```toml
[dependencies]                       # shared, wasm-safe
serde = { version = "1", features = ["derive"] }
serde_json = "1"
futures-util = "0.3"
async-trait = "0.1"
base64 = "0.22"
zeroize = "1"
snow = "0.10"                        # default = pure-Rust resolver (wasm-safe). DO NOT add "ring".
rand = "0.8"

[target.'cfg(not(target_arch = "wasm32"))'.dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "time"] }
iroh = "1"                           # native: direct + relay

[target.'cfg(target_arch = "wasm32")'.dependencies]
tokio = { version = "1", features = ["sync", "macros"] }   # channels only — NO time/net/rt-multi-thread
iroh = { version = "1", default-features = false }          # relay-only
getrandom = { version = "0.3", features = ["wasm_js"] }
gloo-timers = { version = "0.3", features = ["futures"] }
wasm-bindgen-futures = "0.4"
js-sys = "0.3"
web-sys = "0.3"
```

`crates/portcode-wasm/.cargo/config.toml` (the getrandom flag is **mandatory** on
getrandom 0.3 — verify the resolved version in `Cargo.lock`):

```toml
[target.wasm32-unknown-unknown]
rustflags = ["--cfg", 'getrandom_backend="wasm_js"']
```

Audit native bleed-through before each wasm build:
`cargo tree -i mio --target wasm32-unknown-unknown` must return nothing (any
`mio` means a tokio `net`/`rt-multi-thread` path leaked into shared code).

Toolchain: needs **LLVM clang** (Apple Clang can't target wasm32). Build with
`wasm-pack build --target web` (emits an `init()` + `_bg.wasm` + `.d.ts`).

Release size flags (`portcode-wasm` profile): `opt-level = "z"`, `lto = true`,
`codegen-units = 1`, `panic = "abort"`, `strip = true`; wasm-pack runs
`wasm-opt` automatically. Measure with `twiggy top`/`twiggy monomorphizations`.

### 5.4 wasm-bindgen interop surface (the JS↔Rust contract)

A single `Session` class mirrors what `store.ts` already expects from `ipc.ts`:

```rust
// crates/portcode-wasm/src/lib.rs
#[wasm_bindgen]
pub struct Session { /* holds SecureChannel split halves + command tx + on_event cb */ }

#[wasm_bindgen]
impl Session {
    /// Dial + Noise handshake. Resolves with the SAS to show for verification.
    /// `reconnect=true` uses the KK pattern against the pinned key (fast resume).
    #[wasm_bindgen]
    pub async fn connect(qr: String, reconnect: bool) -> Result<Session, JsValue>;

    /// Push one RemoteCommand (JSON: Run/Cancel/Permission/CreateSession).
    #[wasm_bindgen(js_name = sendCommand)]
    pub fn send_command(&self, cmd: JsValue) -> Result<(), JsValue>;

    /// Register the inbound-frame callback. Rust calls it per SyncFrame.
    #[wasm_bindgen(js_name = onEvent)]
    pub fn on_event(&mut self, cb: js_sys::Function);

    /// Tear down the session (drops the channel; ends the loops).
    #[wasm_bindgen]
    pub fn disconnect(&mut self);

    /// The pinned peer public key (to persist in IndexedDB for re-pair).
    #[wasm_bindgen(getter, js_name = peerPublicKey)]
    pub fn peer_public_key(&self) -> String;
}
```

- Frames cross via `serde-wasm-bindgen` (native JS objects); `SyncFrame`/
  `RemoteCommand`/`Cursor` get `#[derive(Tsify)]` so the **exact same TS types**
  the desktop UI uses are generated from the Rust source of truth.
- The session loop is driven by `spawn_local` inside `connect`; inbound frames
  fire the stored `on_event` callback (which the store wires to `applyFrame`).
- This surface is intentionally **shaped like the existing `ipc.ts`**
  (`phoneSyncConnect` → `{ sas, peerPublicKey }`, `phoneSyncSendCommand`,
  `onPhoneSyncFrame`, `phoneSyncDisconnect`) so the store changes are minimal.

### 5.5 Self-hosted iroh relay

- For **Phase 0 spike**: use n0's public relays (zero setup) to validate
  connectivity, then decide.
- For the **product**: run the official `iroh-relay` binary on a small always-on
  host (Fly.io / Render / a cheap VPS). Reasons: control latency (place near
  users), avoid public-relay rate limits, and **pin the relay version** to match
  the browser+desktop iroh (relay protocol is version-locked).
- The relay is **blind** (forwards ciphertext) so it holds no secrets and needs
  no auth integration — but it is the one piece of infra with an ongoing cost
  and an uptime requirement. **This is not on Vercel** (Vercel can't hold the
  long-lived WebSocket); it's the only always-on component.
- Desktop + browser must both be configured with the relay URL and a matching
  iroh version. Add the relay URL to the `PairingPayload` so the phone learns it
  at pair time.

### 5.6 Frontend: the Vercel web client

Goal: **maximum reuse** of the existing React app, minimum fork.

- **Build target split.** Add a second Vite entry/config that builds a
  **browser** bundle (no `@tauri-apps/*`), output to `web-dist/`, deployed to
  Vercel. The Tauri build keeps using `dist/` unchanged.
- **`ipc.ts` becomes runtime-dispatched.** Today it has a Tauri path + a browser
  mock. Replace the mock with a **real WASM-backed implementation**: detect
  "web client" mode and route `phoneSyncConnect`/`SendCommand`/`Disconnect` +
  the frame listener to the `Session` wasm class from §5.4. The Tauri path is
  untouched.
- **`scanner.ts` gets a browser impl.** Today `isScannerAvailable()` is
  Tauri-mobile only. Add a web implementation using `getUserMedia` +
  **zxing-wasm**, with a `<input type="file" accept="image/*" capture>` fallback
  for when camera permission is denied/unpersisted.
- **Reused unchanged:** `store.ts` (`connectRemote`, `applyFrame`,
  `reconnectRemote`, `disconnectRemote`, `remoteMode`, `remoteConnected`,
  `remoteSas`, `remoteDropped`), `RemotePairing.tsx`, `Chat`, `Message`,
  `PermissionPrompt`, `ToolCall`. `remoteMode` flips on for the web build.
- **Lazy-load the wasm.** `import()` the wasm-bindgen glue behind the pairing
  action (or on first connect), with `React.lazy` for the session screens, so
  the PWA shell paints fast on mobile before the ~hundreds-of-KB wasm arrives.

### 5.7 iOS PWA layer

The PWA scaffolding that makes this work on iOS (all in the `web/` build):

- **Manifest** (`display: standalone`, `id`, `name`, `short_name`, `icons`,
  `theme_color`, `start_url`, `scope`). `background_color` is ignored on iOS.
- **Apple meta tags** (still required in 2026): `apple-touch-icon`,
  `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title`, and
  hand-authored `apple-touch-startup-image` splash screens (iOS does not derive
  them from the manifest). `viewport-fit=cover` + `env(safe-area-inset-*)` for
  notch/Dynamic Island.
- **Install gate (P0).** Detect non-installed state
  (`matchMedia('(display-mode: standalone)')` / `navigator.standalone`) and show
  an onboarding screen guiding Share → Add to Home Screen. **Pairing is blocked
  until installed** — because install is what grants Web Push, durable storage,
  and the correct storage partition.
- **Service worker** for the offline shell + Web Push handling. (Standard SW
  push; optionally Declarative Web Push payloads for iOS 18.4+.)
- **Storage.** Persist the pinned peer key + device identity in **IndexedDB**;
  call `navigator.storage.persist()` and verify `persisted()` at pair time.
- **Web Push** (installed only): "permission decision needed" and "turn
  finished". Tapping cold-starts the PWA → reconnect (§5.8). Use the **App
  Badging API** for pending-decision counts. Treat push as best-effort; the
  in-app decision queue is the source of truth.

### 5.8 Session persistence across backgrounding (the core iOS challenge)

This is the namesake of the work (`ios-session-persistence`). iOS **suspends the
JS context within seconds** of backgrounding and **drops the connection** — there
is no way to keep it alive. The design accepts this and makes resume seamless:

1. **On `visibilitychange → hidden`:** proactively close the channel and persist
   the last-applied `Cursor` per session (we already track `seq`).
2. **On `visibilitychange → visible`** (also `pageshow`, `online`): treat the
   connection as dead; do **not** trust `readyState`. Re-dial using the **KK
   reconnect** path (`connect(qr, reconnect=true)`) against the pinned key — fast
   because both sides are already pinned.
3. **Catch-up by cursor.** On reconnect the client sends its `Hello { cursors }`;
   the desktop replays only the missed rows via the **existing**
   `Db::messages_since` / `MessageDelta` mechanism. The long-running agent turn
   kept running on the desktop the entire time — the phone just re-mirrors.
4. **Backoff.** Exponential backoff + jitter (≈1s→30s) on failed re-dials;
   surface `remoteDropped` (already in the store) with a one-tap reconnect.

This is exactly why the desktop-does-all-the-work model matters: the iOS client
can die and resurrect freely without losing session state, because **state lives
on the desktop** and the phone is a resumable mirror.

### 5.9 Pairing & QR on the web

- Desktop shows its pairing QR (existing `phone_sync_begin_pairing` →
  `PairingPayload`, rendered with `qrcode.react`). Add the **relay URL** to the
  payload so the web client knows which relay to dial through.
- Web client scans via `getUserMedia` + **zxing-wasm** (stable URL, triggered by
  a tap, no route/hash changes mid-scan), or the `<input capture>` file fallback,
  or manual paste (already supported).
- After `connect()` resolves with the **SAS**, the user compares it out-of-band
  against the desktop and taps to confirm (`confirmRemoteSas`, existing). Only
  then is the session unlocked. The pinned key is written to IndexedDB.

### 5.10 Security model

- **E2E encryption is preserved end-to-end.** The Noise XX handshake +
  ChaCha20-Poly1305 transport runs **inside** the iroh stream; the relay (ours or
  n0's) only ever forwards ciphertext. Compiling the _same_ `snow` code to wasm
  means the browser client has the identical crypto as the native client — no
  second crypto implementation to audit.
- **SAS out-of-band verification** is unchanged and mandatory before a session
  is usable — defends against a MITM at pairing time.
- **Trust-on-first-use + key pinning:** the desktop's static key is pinned in
  IndexedDB after SAS confirmation; reconnects use KK against the pinned key and
  never re-prompt unless the key changes (which must hard-fail).
- **Desktop trust gate unchanged:** `pairing_gate.rs` still gates inbound devices
  on the desktop; a browser client is just another pinned device.
- **Fail-closed command parsing** (`parse_decision`, existing) still treats any
  unknown permission decision as Deny.
- **New surface to threat-model:** browser storage (IndexedDB key exfiltration
  via XSS) — mitigate with a strict CSP on the Vercel app, Subresource Integrity
  on the wasm, and no third-party script injection. Document this in
  `SECURITY.md` before launch.

---

## 6. Vercel deployment & CI

- **Vercel build is static-only.** It runs `vite build` of the `web/` target →
  `web-dist/`. **No serverless functions, no relay.**
- **Vercel has no Rust.** Do **not** compile wasm on Vercel. Instead:
  - **GitHub Actions builds the wasm** (`wasm-pack build --target web`, pinned
    `rust-toolchain.toml`, LLVM clang) and commits/uploads the artifact, or
  - the wasm artifact is published and the web build pulls it in.
    Recommended: GH Actions job produces `portcode_wasm` package; Vercel's build
    consumes the prebuilt files. (`{"github":{"enabled":false}}` if we want Vercel
    to deploy only, not build Rust.)
- **No COOP/COEP headers** (single-threaded wasm, no SharedArrayBuffer). Add a
  strict **CSP** + cache headers + SRI on the wasm instead.
- **Brotli** is automatic on Vercel's CDN (~40–55% of raw wasm on the wire).
- A `vercel.json` pins headers (CSP, `Cross-Origin-Resource-Policy`, immutable
  caching for hashed assets, `application/wasm` is served correctly by default).

---

## 7. Testing & coverage strategy

Portcode gates **frontend coverage on `main`/`release`** (`pnpm test:coverage`).
New frontend code **must** ship with tests in the same change (per `CLAUDE.md`).

- **Rust (`portcode-sync`):** unit tests move with the code (the existing
  `protocol`/`noise`/`session` tests). Add wasm-target build verification in CI
  (`cargo build --target wasm32-unknown-unknown` + `wasm-pack test --headless`
  for the Noise round-trip). Rust tests run in CI (the crate is too heavy to
  build on low-RAM dev machines — **verify via CI**).
- **Frontend:** the reused store/components keep their `*.test.tsx`. New code —
  the WASM-backed `ipc` adapter, the web `scanner`, the install-gate, the
  reconnect/visibility logic — needs matching vitest tests (mock the `Session`
  wasm class) to keep coverage ≥ threshold and avoid reddening `main` post-merge.
- **E2E (wdio):** add a browser-mode smoke that pairs against a headless desktop
  - local relay and exercises connect → command → frame → background → resume.
- **iOS on-device:** the Phase 0 spike and a manual pre-launch checklist
  (install, pair, background/lock for >30s, resume, push tap) — there is no CI
  for real iOS Safari lifecycle behaviour.

---

## 8. Phased roadmap

| Phase                                              | Goal                                                                                                 | Exit criteria                                                                                                                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. iOS proof-of-connection (spike)** ⚠️ do first | De-risk the one unknown: does iroh-in-browser actually hold a connection on real iOS?                | A throwaway wasm page on **real iOS Safari + installed PWA** dials a native iroh desktop through a relay, exchanges bytes, and survives a background→resume reconnect. **Go/no-go gate for everything below.** |
| **1. Workspace restructure**                       | Extract `portcode-sync`; desktop builds unchanged against it.                                        | `cargo build` (desktop) + `cargo test` green; `cargo build --target wasm32-unknown-unknown` of `portcode-sync` compiles.                                                                                       |
| **2. WASM transport + interop**                    | `transport_wasm.rs` + `portcode-wasm` `Session` class; Noise handshake works browser↔desktop.        | A Node/headless harness pairs, gets a SAS, sends a command, receives a `Live` frame through the relay.                                                                                                         |
| **3. Web frontend**                                | Vercel build target; WASM-backed `ipc`; web `scanner`; reuse store/UI.                               | A desktop-browser PWA pairs, drives a real session, mirrors live frames.                                                                                                                                       |
| **4. iOS PWA hardening**                           | Install gate, manifest/meta/splash, IndexedDB + `persist()`, visibility reconnect + cursor catch-up. | On real iOS: install → pair → run a turn → lock phone 1 min → resume with full catch-up, no data loss.                                                                                                         |
| **5. Web Push + polish**                           | Installed-PWA push for permission/turn events + App Badge; CSP/SRI; size budget.                     | Push pulls user back to a pending permission; Lighthouse PWA pass; wasm gzip budget met.                                                                                                                       |
| **6. Self-host relay + launch**                    | Replace public relay with self-hosted, version-pinned `iroh-relay`; docs.                            | Stable relay; runbook; `SECURITY.md` updated; README "Phone Sync" status moved from roadmap → alpha.                                                                                                           |

---

## 9. Risks, open questions & decisions needed

**Top risks (carry-forward):**

1. **iOS Safari lifecycle is the real unknown** — long-lived WebSocket survival
   across backgrounding. Mitigated by the resume-by-cursor design, but **Phase 0
   must prove it on-device** before committing.
2. **Relay-only performance & cost** — every byte is relayed; self-hosting adds
   the only always-on infra + a monthly cost. Acceptable for a control/mirror
   plane (small frames), not for high-bandwidth.
3. **iroh version lock-step** across browser/desktop/relay — upgrades can break
   the relay protocol. Pin all three; budget for coordinated bumps.
4. **wasm bundle size** (QUIC+crypto+serde) — mitigated by lazy-load + size
   flags + Brotli; measure early with twiggy, don't let it bloat the shell.
5. **`Send`/`!Send` split** may force a `current_thread`/`LocalSet` runtime for
   the session loop on native — contained but fiddly.
6. **getrandom version drift** — exact `wasm_js` + cfg-flag requirement; verify
   `Cargo.lock` resolves getrandom 0.3.

**Decisions needed before/at Phase 1:**

- **Relay hosting choice** (Fly.io vs Render vs VPS) and who operates it — this
  is the one recurring cost and uptime commitment, and it is **required** (Vercel
  cannot fill this role). _(Spike can defer it by using n0 public relays.)_
- **Repo layout for the web app:** same repo (recommended — shares
  `portcode-sync` and types) vs a separate deploy. Plan assumes same repo.
- **Web Push backend:** Web Push needs a tiny push-send step (VAPID). Since
  Vercel is static-only and the desktop is the event source, the desktop itself
  can send Web Push directly to Apple's push service (`*.push.apple.com`) using
  the stored subscription — no extra server. Confirm this routing in Phase 5.

---

## 10. What this explicitly is NOT

- Not a relay on Vercel (impossible — Vercel can't hold the long-lived socket).
- Not a reimplementation of Noise/protocol in JS (we compile the Rust to wasm).
- Not browser↔desktop direct P2P (iroh browser is relay-only today).
- Not a replacement for the native mobile (Android) client — it's a **sibling**
  client that shares the same `portcode-sync` crate.

---

_This plan reuses the existing Phone Sync foundation (`src-tauri/src/sync/`) and
the roadmap framing in `docs/ANDROID_APP_PLAN.md`. Implementation should land
phase-by-phase behind the existing `remoteMode` shell so nothing ships to desktop
users until each phase is green._
