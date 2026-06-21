# Portcode Android App — Implementation Plan

> Status: **planning + scaffolded.** The Tauri v2 Android project is generated
> (`src-tauri/gen/android`, committed). This doc grounds the rest of the build in
> Portcode's _actual_ code + the real blockers, and sequences it into shippable,
> CI-verifiable increments. Companion to [`PHONE_SYNC_PLAN.md`](./PHONE_SYNC_PLAN.md)
> (the now-merged Sync Engine).
>
> Goal: an Android app that pairs with a desktop and **drives/continues a coding
> session from the phone** — the phone is a **remote control surface**, the desktop
> stays the brain (runs the agent, files, shell). E2E-encrypted over the merged
> iroh + Noise transport.

---

## 0. Where we are

- ✅ **Sync Engine is merged + green on `main`** — transport (iroh QUIC), crypto
  (Noise XX/KK + SAS), pairing, catch-up, live stream, command intake, and the
  desktop server (`phone_sync_listen` + `DesktopCommandHandler`). The phone↔desktop
  protocol exists and is tested.
- ✅ **Android project scaffolded** — `tauri android init` generated
  `src-tauri/gen/android` (Gradle project, `MainActivity.kt`, manifest, resources).
  `Cargo.toml` already had `crate-type = ["cdylib"]` and `lib.rs` the
  `#[cfg_attr(mobile, tauri::mobile_entry_point)]`, so the lib is mobile-ready.
- ✅ **Toolchain ready** — Android SDK + **NDK 27.0.12077973** + JDK 17 +
  tauri-cli 2.11.3 + the 4 rust android targets, all installed. (Tauri needs
  `NDK_HOME`/`ANDROID_NDK_ROOT` exported — they were empty; point them at
  `…\Sdk\ndk\27.0.12077973`.)

So the **shell builds**; the app's _behaviour_ is the work.

---

## 1. The core architectural decision: the phone is a REMOTE CLIENT, not the app

The desktop app (`src-tauri`) runs the agent locally: the LLM client (`llm.rs`),
the agent loop (`agent.rs`), the **tools** (`tools.rs` — `fs_read/write/edit`,
`glob`, `grep`, **`shell`** running PowerShell), and `keyring` secrets. **None of
that belongs on a phone:** there's no workspace, no PowerShell, no API key on the
device, and shipping the shell/file tools in a mobile binary is wrong + a security
smell. The phone should **only** speak the sync _client_ side of the protocol and
render the session.

This means the mobile build is **not** "the desktop app compiled for android." It
is a **different surface over the same crate**, selected by a Cargo **feature** (or
`cfg(mobile)`):

```
desktop build  =  agent + tools + llm + keyring(windows) + sync SERVER (phone_sync_listen)
mobile build   =  sync CLIENT (connect/pair/catch-up/live/command send) + remote UI + keyring(android) + QR scan
```

**Decision needed from the owner:** confirm "phone = pure remote client" (recommended;
matches the research doc). The alternative (phone also runs an agent) is out of scope

- infeasible (no LLM key/workspace on device).

---

## 2. Build blockers — RESOLVED: the app now cross-compiles for Android

> **🚀 LANDMARK (probe run #2, 2026-06-21, GREEN):** with the single real blocker
> below fixed (PR #37), **the entire unmodified app cross-compiles for
> `aarch64-linux-android`** — `tauri android build --apk --debug` succeeds in CI
> (~7 min) and produces a debug APK. **`openssl-sys` was the _only_ actual build
> blocker.** The items I'd predicted (keyring, agent/tools/shell — the §2.1 table)
> turned out **not** to block compilation at all; they are _architecture_ concerns,
> not build errors. **Net: the platform split (§4) is no longer a prerequisite to
> build/ship an Android APK — it's a product decision we can make at leisure.** The
> CI probe (§5) now uploads the APK as an artifact every run.

### 2.0 Blocker #1 — `openssl-sys` native cross-compile (✅ FIXED in #37)

```
error: failed to run custom build command for `openssl-sys v0.9.117`
  Could not find openssl via pkg-config: pkg-config has not been configured to
  support cross-compilation. … $TARGET = aarch64-linux-android
```

`reqwest`'s **`native-tls`** feature pulled `native-tls → openssl-sys`, the native
OpenSSL **C** library — which can't cross-compile for Android without an OpenSSL
sysroot. `reqwest` is shared by **our dep _and_ `iroh` _and_ `tauri`** (feature
unification), so the fix had to drop `native-tls` from the **unified** graph.
**Fix (shipped, PR #37):** switch `reqwest` to pure-Rust **rustls** (the feature is
`rustls`, _not_ `rustls-tls`, in reqwest 0.13). `cargo tree` confirmed openssl-sys is
gone for the android target; the Windows + Linux Rust jobs confirm the desktop still
builds + tests pass.

> **Cost note — `aws-lc-sys`:** rustls 0.23's default provider is **aws-lc-rs**,
> which builds a C/asm crate on every target. It compiles everywhere (CI has
> cmake/NASM) but **adds ~7 min to the Windows Rust job**. A future tweak if that
> tax is unwanted: reqwest `rustls-no-provider` + install the **ring** provider
> (`rustls::crypto::ring::default_provider().install_default()` at `lib.rs` setup) —
> ring is already in-tree via iroh/quinn, lighter, and needs no cmake. Non-urgent.

### 2.1 NON-blockers — these compile fine (architecture concerns, not build errors)

The probe proved the items below do **not** block the Android build (keyring's
`windows-native` is internally `cfg`-gated/inert off-Windows; the agent/tools/shell
and sync server use cross-platform crates). They still matter as _product_ choices —
you don't want the agent running on a phone — but that is the §4 split: an
optimization, **not** a build prerequisite. The table doubles as the §4 to-do list.

| Blocker                                                                                         | Where                                                                                          | Fix                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`keyring` `windows-native` feature won't compile for android** _(predicted)_                  | `Cargo.toml` `keyring = { features = ["windows-native"] }`                                     | Make the feature per-target: `windows-native` only under `cfg(windows)`; on android use the **Android Keystore** (e.g. `keyring` with the `linux`/`secret-service` backends don't apply — use a small JNI bridge to `AndroidKeyStore`, or an encrypted-file fallback in app-private storage). Likely a `secrets.rs` trait with a per-platform impl. |
| **Agent/tools/shell are desktop-only**                                                          | `agent.rs`, `tools.rs`, `llm.rs`, the `run_agent`/`cancel_agent`/`resolve_permission` commands | Gate behind `#[cfg(not(mobile))]` / a `desktop` feature. The mobile `run()` registers only the client + remote commands.                                                                                                                                                                                                                            |
| **`shell` tool uses `tokio::process` (PowerShell)**                                             | `tools.rs`                                                                                     | Excluded with the tools (above).                                                                                                                                                                                                                                                                                                                    |
| **The sync SERVER (`phone_sync_listen`, `DesktopCommandHandler`, `server.rs`) is desktop-only** | `sync/server.rs`, `lib.rs`                                                                     | Gate `#[cfg(not(mobile))]`; mobile gets the _client_ listener counterpart.                                                                                                                                                                                                                                                                          |
| **Windows-only deps in the tree** (the iroh/tauri `windows-*` crates)                           | resolved via target-gating already                                                             | iroh/snow/tokio/serde are cross-platform; the `windows-*` crates are `cfg(windows)` so they drop out for android automatically. Verify in CI.                                                                                                                                                                                                       |

The **sync protocol core is already cross-platform** (`sync/{protocol,noise,transport,session,pairing,mod}.rs` use only iroh/snow/tokio/serde/base64) — it compiles for android as-is. That's the big win: the hard part (the encrypted session protocol) is reusable on the phone unchanged.

---

## 3. The mobile sync CLIENT (the new Rust)

Mirror of the desktop server, on the phone side. Most primitives already exist:

- `transport::connect_and_pair(endpoint, peer_addr, local_noise_private)` — **already
  built** (the initiator side; currently carries a narrow `dead_code` allow — it
  becomes live here).
- `session::request_catch_up(channel, device_id, cursors)` — **already built**.
- New: a **client session loop** — the dual of the server's `forward_live` +
  `handle_commands`: split the channel, spawn (a) a recv loop that decodes incoming
  `SyncFrame::Live`/`SessionList`/`MessageDelta` and pushes them to the UI (via a
  Tauri event, e.g. `phone-sync://session`), and (b) a send path that turns UI
  actions into `SyncFrame::Command` (`Run`/`Cancel`/`Permission`/`CreateSession`).
  This is protocol-level + **CI-verifiable on the desktop Rust job** (no android
  needed) — a good _first_ increment.
- New mobile commands (`#[cfg(mobile)]`): `phone_sync_connect(qr_payload)` (decode
  the QR, dial the desktop's `EndpointAddr`, run the XX pairing as initiator, show
  the SAS for the user to compare, persist the pinned key), `phone_sync_send(command)`,
  and the event stream the UI subscribes to.

**Addressing:** pairing needs the phone to reach the desktop's `EndpointAddr`. The
QR payload (`PairingPayload`) today carries the Noise pubkey + nonce; **it must also
carry the desktop's iroh `EndpointId` (+ relay URL or direct addrs)** so the phone
can dial. Extend `PairingPayload` + the desktop `phone_sync_begin_pairing` to
include the iroh node addr. (Small protocol addition.)

---

## 4. The mobile UI (remote mode)

- **`ipc.ts` third path.** Today: Tauri-local (desktop) or browser-mock. Add a
  **remote** path: under `mobile`, `runAgent`/sessions/messages proxy to the desktop
  via the mobile commands + the `phone-sync://session` event stream (fold `Live`
  `StreamEvent`s with the _same reducer_ the desktop store uses — already factored).
- **QR-scan pairing screen.** The phone scans the desktop's QR (from the desktop's
  PHONE SYNC settings). Use a Tauri mobile camera/QR plugin (or a JS QR lib +
  `getUserMedia`), then call `phone_sync_connect`. Show the **SAS** for out-of-band
  comparison before trusting the channel.
- Reuse the whole Chat/Composer/Message UI as-is (the phone renders the same session).
  Hide desktop-only affordances (workspace picker, file tree) on mobile.

---

## 5. CI + build verification (overcome the 8GB local wall)

The desktop crate already can't build on the 8GB dev box; android is heavier.
**Add an `android-build` CI job** (separate workflow, `workflow_dispatch` +
`pull_request` touching mobile paths, so it doesn't slow every PR):

- ubuntu runner (has the Android SDK pre-installed), set up JDK 17, pnpm install,
  `rustup target add aarch64-linux-android` (+ others), export `NDK_HOME`, then
  `pnpm tauri android build --apk --target aarch64` (or `cargo ndk`/`cargo build
--target aarch64-linux-android` for a faster compile-only check).
- This is where the §2 blockers surface concretely — fix them iteratively against
  this job. **Verify the cross-compile in CI, not on the dev box.**

---

## 6. The genuine owner-only wall

- **On-device run** (`tauri android dev` / installing the APK) needs a real device
  or emulator + the owner.
- **Release signing + Play Store**: a keystore + signing config in
  `gen/android/app/build.gradle.kts`, and a Play listing — owner credentials.
- **Push / wake-from-AFK** (the research doc's "doorbell"): FCM (free) integration
  is its own phase, needed for true background AFK; foreground sync works without it.

---

## 7. Suggested increment order (each CI-verifiable where noted)

1. **Client session loop** in `sync/session.rs` — ✅ **DONE (#34)**: `run_client_recv`
   - `send_command` (the recv-live + send-command duals) + in-memory-channel tests.
2. **`PairingPayload` carries the iroh node addr** — ✅ **DONE (#35)**: `begin_pairing`
   fills it from the persisted node key; JSON round-trip test.
3. **`android-build` CI job** (§5) — ✅ **DONE (#36)**: a non-blocking probe that
   captured the real blockers (and proved openssl-sys was the only one).
4. **Drop the `openssl-sys` blocker** (reqwest → rustls) — ✅ **DONE (#37)**. With
   this, **the whole app cross-compiles for Android** (probe green). Architecture-neutral.
5. **Platform split** (§2.1) — ⏸ **OWNER-GATED**: `secrets.rs` per-target keyring;
   `#[cfg(mobile)]` to exclude agent/tools/server; the mobile `run()` + client commands.
   **No longer a _build_ blocker** (the app already compiles) — this is the _product_
   decision to make the mobile binary a lean remote client. Confirm the architecture (§1) first.
6. **Remote-mode `ipc.ts`** + the QR-scan pairing screen (§4). ✅ frontend-CI-verifiable.
7. **On-device** (owner): install the debug APK (now built by the §5 probe as an
   artifact), SAS-compare a real pairing end-to-end.
8. **Signing + push** (owner / later phases).

---

### Progress log

- ✅ `tauri android init` scaffold (#34) + client primitives + toolchain verified
  (SDK / NDK 27 / JDK 17 / rust android targets).
- ✅ Pairing payload carries the iroh node address (#35).
- ✅ Non-blocking Android cross-compile probe (#36) → **confirmed `openssl-sys` was the
  sole build blocker** (the predicted source-level ones don't block compilation).
- ✅ `reqwest` → rustls (#37): **the app now cross-compiles for Android**; the probe is
  green and uploads a debug APK artifact on every run.
- ⏸ **Next, owner-gated:** the §5 platform split (the product decision to make the
  mobile binary a lean remote client), then remote-mode UI, on-device install, signing/push.

The protocol foundation being already cross-platform + merged, plus the now-unblocked
Android cross-compile, is what makes the rest tractable — the phone reuses the hard,
tested crypto/transport/session code unchanged; the remaining work is the (optional)
platform split and the mobile UI.
