# Portcode Android App — Implementation Plan

> **Document role:** shipped remote-client architecture plus the remaining
> acceptance/release runbook. Cross-project priority lives in
> [`docs/ROADMAP.md`](ROADMAP.md); completed PR history belongs in Git.
>
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

## 2. Android build and capability boundary

The app cross-compiles for `aarch64-linux-android` in CI and produces a debug APK.
The dependency graph uses Rustls rather than `openssl-sys`, and target gating keeps
desktop-only capabilities out of the Android build. Git history retains the resolved
cross-compilation investigation; this document records only the current boundary.

| Concern                                         | Implemented resolution                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Desktop credentials and executable capabilities | Desktop secrets, agent, tools, shell, and updater modules are excluded from mobile with `cfg(desktop)`       |
| Desktop sync server                             | Server/listener and `DesktopCommandHandler` stay desktop-only; mobile registers client connect/send commands |
| Mobile identity persistence                     | Mobile uses the app-private mobile persistence path rather than the Windows credential backend               |
| Windows-only dependencies                       | Target gating keeps Windows-only crates out of the Android target                                            |

The sync protocol core remains cross-platform, so Android reuses the audited
transport, Noise, pairing, framing, and session behavior rather than maintaining a
second mobile protocol.

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

## 7. Remaining correctness, acceptance, and release gates

Run these in the order tracked by [`docs/ROADMAP.md`](ROADMAP.md):

1. **Permission-decision delivery:** add a desktop receipt/ack plus idempotent
   client replay so a link drop after enqueue cannot clear the phone prompt while
   leaving the desktop permission gate pending.
2. **Physical-device acceptance:** install the debug APK, pair with a real desktop
   through the relay/network path, verify SAS, exercise run/cancel/permission
   flows—including a forced link drop during a permission response—then verify
   background/lock, resume/reconnect, and catch-up without loss.
3. **Release signing and distribution:** configure the owner-held Android signing
   identity, make the release build reproducible, and verify the distributable on
   a clean device.
4. **Push/wake:** choose FCM and store ownership before treating notification wake
   behavior as scheduled work.

The remaining work is correctness evidence, device acceptance, and production
release infrastructure, not the remote-client architecture. Record device model,
Android version, network/relay, latency, and reconnect results here when the gate runs.
