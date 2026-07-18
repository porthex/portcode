# Portcode Android App — Implementation Plan

> Status: **remote client implemented; device/release acceptance pending.** The
> Tauri Android scaffold, mobile/desktop capability split, sync-client commands,
> remote-mode UI, and QR pairing surface are in the tree. Android CI builds a
> debug APK but remains non-blocking. Physical-device pairing, background/resume,
> release signing, and distribution are not yet validated.
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

- ✅ **Remote-client/platform split landed** — desktop-only agent, tools, server,
  secrets, and updater surfaces are `cfg(desktop)`; mobile registers the sync
  client commands and renders `remoteMode` with native QR scanning.
- ⚠️ **Acceptance remains** — the non-blocking CI probe proves cross-compilation,
  not physical-device pairing, lifecycle resilience, or release readiness.

---

## 1. The core architectural decision: the phone is a REMOTE CLIENT, not the app

The desktop app (`src-tauri`) runs the agent locally: the LLM client (`llm.rs`),
the agent loop (`agent.rs`), the **tools** (`tools.rs` — `read_file`, `write_file`,
`edit_file`, `find_files`, `search_text`, and **`run_command`** running PowerShell), and
`keyring` secrets. **None of
that belongs on a phone:** there's no workspace, no PowerShell, no API key on the
device, and shipping the shell/file tools in a mobile binary is wrong + a security
smell. The phone should **only** speak the sync _client_ side of the protocol and
render the session.

The mobile build is **not** "the desktop app compiled for Android." It is a
different surface over the same crate, selected by `cfg(mobile)` / `cfg(desktop)`:

```
desktop build  =  agent + tools + llm + keyring(windows) + sync SERVER (phone_sync_listen)
mobile build   =  sync CLIENT (connect/pair/catch-up/live/command send) + remote UI + keyring(android) + QR scan
```

That architectural decision is implemented: the phone is a pure remote client.
Running the agent, workspace tools, or desktop sync server on the phone remains
out of scope.

---

## 2. Build blockers — RESOLVED: the app now cross-compiles for Android

> **🚀 LANDMARK (probe run #2, 2026-06-21, GREEN):** with the single real blocker
> below fixed (PR #37), **the entire unmodified app cross-compiles for
> `aarch64-linux-android`** — `tauri android build --apk --debug` succeeds in CI
> (~7 min) and produces a debug APK. **`openssl-sys` was the _only_ actual build
> blocker.** The items I'd predicted (keyring, agent/tools/shell — the §2.1 table)
> turned out **not** to block compilation at all; they are _architecture_ concerns,
> not build errors. The platform split was therefore implemented as a product and
> security boundary rather than a cross-compile fix. The CI probe (§5) uploads a
> debug APK artifact when the build succeeds.

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

The probe proved the predicted items below did **not** block cross-compilation.
The product split has since landed, so this table records the implemented
resolution rather than an open to-do list.

| Concern                                         | Implemented resolution                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Desktop credentials and executable capabilities | Desktop secrets, agent, tools, shell, and updater modules are excluded from mobile with `cfg(desktop)`       |
| Desktop sync server                             | Server/listener and `DesktopCommandHandler` stay desktop-only; mobile registers client connect/send commands |
| Mobile identity persistence                     | Mobile uses the app-private mobile persistence path rather than the Windows credential backend               |
| Windows-only dependencies                       | Target gating keeps Windows-only crates out of the Android target                                            |

The **sync protocol core is already cross-platform** (`sync/{protocol,noise,transport,session,pairing,mod}.rs` use only iroh/snow/tokio/serde/base64) — it compiles for android as-is. That's the big win: the hard part (the encrypted session protocol) is reusable on the phone unchanged.

---

## 3. The mobile sync client (implemented)

The phone-side mirror of the desktop server is implemented:

- The initiator transport dials the desktop address from `PairingPayload` and
  establishes the Noise channel.
- The session client requests catch-up from its persisted cursors.
- A **client session loop** — the dual of the server's `forward_live` +
  `handle_commands`: split the channel, spawn (a) a recv loop that decodes incoming
  `SyncFrame::Live`/`SessionList`/`MessageDelta` and pushes them to the UI (via a
  Tauri event, e.g. `phone-sync://session`), and (b) a send path that turns UI
  actions into `SyncFrame::Command` (`Run`/`Cancel`/`Permission`/`CreateSession`).
  This is protocol-level + **CI-verifiable on the desktop Rust job** (no android
  needed).
- Mobile commands: `phone_sync_connect(qr_payload)` (decode
  the QR, dial the desktop's `EndpointAddr`, run the XX pairing as initiator, show
  the SAS for the user to compare, persist the pinned key), `phone_sync_send(command)`,
  and the event stream the UI subscribes to.

`PairingPayload` carries the desktop iroh node address needed for the phone to
dial. The remaining proof is a real device reaching a real desktop through the
configured network/relay path.

---

## 4. The mobile UI (remote mode implemented)

- **`ipc.ts` mobile path.** Under `mobile`, sessions/messages proxy to the desktop
  via the mobile commands + the `phone-sync://session` event stream (fold `Live`
  `StreamEvent`s with the _same reducer_ the desktop store uses — already factored).
- **QR-scan pairing screen.** The mobile surface uses the Tauri barcode-scanner
  plugin, calls `phone_sync_connect`, and shows the SAS comparison before trust.
- Reuse the whole Chat/Composer/Message UI as-is (the phone renders the same session).
  Hide desktop-only affordances (workspace picker, file tree) on mobile.

---

## 5. CI + build verification

The dedicated `android-build` workflow is implemented with `workflow_dispatch`
and path-filtered pull-request triggers:

- ubuntu runner (has the Android SDK pre-installed), set up JDK 17, pnpm install,
  `rustup target add aarch64-linux-android` (+ others), export `NDK_HOME`, then
  `pnpm tauri android build --apk --target aarch64` (or `cargo ndk`/`cargo build
--target aarch64-linux-android` for a faster compile-only check).
- The job builds and uploads a debug APK. It intentionally remains
  `continue-on-error`, so it is a non-blocking signal rather than a required
  merge gate. Promote it only after physical-device behavior is stable.

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
5. **Platform split** (§2.1) — ✅ **IMPLEMENTED**: desktop-only capability cluster
   excluded from mobile; mobile run path registers the sync-client commands.
6. **Remote-mode `ipc.ts` + QR pairing UI** (§4) — ✅ **IMPLEMENTED** with mobile
   platform detection, native scanning, remote shell, and automated tests.
7. **On-device acceptance** — ⏳ **NEXT GATE**: install the debug APK, pair with a
   real desktop through the relay/network path, verify SAS, run/cancel/permission
   flows, background/lock, resume/reconnect, and catch up without loss.
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
- ✅ Platform split, mobile sync commands, remote-mode UI, and QR pairing surface landed.
- ⏳ **Next:** increment 7 physical-device and background/resume acceptance, then
  release signing, distribution, and push/wake work.

The protocol foundation being already cross-platform + merged, plus the now-unblocked
Android cross-compile, is what makes the rest tractable — the phone reuses the hard,
tested crypto/transport/session code unchanged. The remaining work is real-device
validation and production release infrastructure, not the client architecture.
