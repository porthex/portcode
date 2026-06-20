# Phone Sync — Engineering Research

> Status: **research / decision doc** for the roadmap's "📱 Phone Sync" item. Not shipped, not
> committed-to as a design yet. This is a deep, cited survey to pick a stack before any code.
>
> Question researched: _How do we build a **fast, stable, reliable, end-to-end-encrypted** engine
> that lets a Portcode user **drive and continue a coding session from an iOS/Android phone while
> AFK**, using **free / self-hostable / open-source** tech only?_

---

## 0. TL;DR — the honest answer

1. **The "no-pay" constraint is fully achievable on Android, but NOT on iOS.** Reliable background
   wake-ups on iOS legally require Apple Push Notification service (APNs), which requires a paid
   **Apple Developer Program membership ($99/year)**. There is **no free, self-hosted path to wake
   a backgrounded iOS app.** Everything else in the stack can be free and self-hosted. This is the
   one wall money can't avoid — budget the $99/yr when you actually ship iOS.

2. **Re-frame the architecture.** The phone is **not** an equal peer that runs the agent. The
   desktop keeps the files, the shell, and the agent loop; it **stays running at home**. The phone
   is a **secure remote-control + session-continuation surface**. That means the core problem is a
   **secure real-time relay**, _not_ offline-first multi-writer data sync.

3. **A full CRDT (Automerge/Yjs) is overkill here.** The session is a 1-writer-at-a-time,
   1-to-1, append-mostly log (transcript + tool-call events + diffs). A plain **append-only event
   log over an encrypted channel** is simpler, faster, and lighter. Keep CRDTs in your back pocket
   only if multi-device concurrent editing ever becomes real.

4. **Recommended stack** (all Rust, all reuses the existing core):
   - **Transport:** [**iroh**](https://www.iroh.computer/) (QUIC + dial-by-public-key P2P with
     hole-punching and a self-hostable relay fallback).
   - **E2E crypto:** application-layer **Noise** via the [`snow`](https://docs.rs/snow) crate
     (`Noise_*_25519_ChaChaPoly_BLAKE2s`), QR/SAS pairing.
   - **Mobile app:** **Tauri v2 mobile** first (reuses _both_ the Rust core and the React/TS UI),
     with native background plugins; fall back to **uniffi**-exposed Rust core + native/RN UI if
     background robustness demands it.
   - **Wake-from-AFK:** **FCM high-priority** (free) or self-hosted **ntfy/UnifiedPush** on
     Android; **APNs** (paid, mandatory) on iOS.
   - **Sync model:** roll-your-own **append-only encrypted event log** over the iroh channel; no
     CRDT, no managed sync SaaS.

---

## 1. Architecture: remote-control relay vs. local-first state sync

Two models were compared.

**Model A — Secure real-time relay / remote-control.** The phone connects (via a relay when P2P
fails) to the always-on desktop, which does all the work; the phone streams the live session and
sends commands. This matches "drive from phone when AFK" because **execution needs the desktop's
files and shell** — the phone literally cannot run `shell`/`fs_edit` against your repo on its own.

**Model B — True local-first state sync (CRDTs).** Replicate the session log to a phone replica so
the phone has a full copy and can edit offline. CRDTs (Automerge/Yjs) auto-merge concurrent edits.

**Verdict: Model A.** Model B solves a problem you don't have. Your topology is the _easy_ case for
sync — **one writer at a time, 1-to-1, append-mostly** — exactly where the simpler
server-authoritative / append-log approaches are sufficient and CRDTs' conflict-resolution
machinery goes unused. CRDTs earn their cost only with genuine concurrent multi-writer editing of
the same data; for everything else, simpler designs win.
[mattweidner.com](https://mattweidner.com/2024/06/04/server-architectures.html) ·
[Ably: you don't need CRDTs](https://dev.to/ably/you-dont-need-crdts-for-collaborative-experiences-emj)
The session transcript, tool-call events, and diffs are immutable once written, so the delta to
sync is computable directly from the log. Use Model A for the live drive-the-session path, and a
simple append-only log replication for catching the phone up after it reconnects.

---

## 2. Transport — what's fastest + most reliable on flaky mobile networks

| Transport                       | HOL blocking                                  | Survives Wi-Fi↔cellular handoff                                               | Self-host cost               | Rust maturity                                                                                                                                |
| ------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **WebSocket (TCP)**             | Yes — one lost packet stalls the whole stream | **No** — connection breaks on IP change, app must reconnect & restore state   | Trivial (just TLS+TCP)       | High (`tokio-tungstenite`)                                                                                                                   |
| **WebRTC DataChannel**          | No (configurable reliability/order)           | Partial (ICE restart)                                                         | Needs STUN+**TURN** (coturn) | Pre-production (`webrtc-rs` v0.17 final Tokio release; ~109 KiB leak/conn; Sans-I/O `rtc` rewrite ongoing) or `datachannel` (libdatachannel) |
| **QUIC (HTTP/3, WebTransport)** | **No** — independent streams                  | **Yes** — Connection ID persists across IP/port change (connection migration) | Self-hostable                | High (`quinn`)                                                                                                                               |

Key facts:

- **WebSocket rides TCP, so a single lost packet stalls the entire message stream** until
  retransmission — head-of-line blocking — even for unrelated later messages.
  [websocket.org](https://websocket.org/guides/future-of-websockets/)
- **A TCP/WebSocket connection breaks when the client IP changes** (Wi-Fi→cellular handoff); the
  app must detect the drop and rebuild state itself.
  [Internet Society](https://pulse.internetsociety.org/blog/how-quic-helps-you-seamlessly-connect-to-different-networks)
- **QUIC uses a Connection ID that persists across IP/port changes**, enabling connection
  migration without the app re-establishing the connection.
  [Internet Society](https://pulse.internetsociety.org/blog/how-quic-helps-you-seamlessly-connect-to-different-networks)
  (Caveat: migration isn't perfectly seamless yet — iroh reports "hiccups for a few seconds" while
  re-routing; multipath QUIC aims to fix that. [iroh](https://www.iroh.computer/blog/iroh-on-QUIC-multipath))
- **QUIC/HTTP3 gives independent streams** so a loss on one doesn't block others, eliminating TCP's
  cross-stream HOL blocking.
  [MDN WebTransport](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API)
- **You cannot universally avoid a relay.** STUN hole-punching only works with endpoint-independent
  NAT mapping; if both peers are behind symmetric NAT, a relay is mandatory.
  [RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html) Roughly **15–30% of users** sit behind
  symmetric NAT/CGNAT where hole-punching fails.
  [eleshine-tech](https://www.eleshine-tech.com/webrtc-nat-traversal-stun-turn-hole-punching-guide.html)

**Why iroh.** [iroh](https://www.iroh.computer/) (Rust, by n0) is QUIC built on `quinn`: you **dial
peers by public key, not IP**, it hole-punches with **~90–95% direct-connection success**, and
falls back to a **self-hostable relay** (built-in ACME TLS) for the symmetric-NAT minority.
**iroh 1.0 shipped June 15, 2026** with a stable wire protocol and official **Swift/Kotlin** (plus
Python/Node) bindings — exactly the mobile targets you need.
[iroh FAQ](https://docs.iroh.computer/about/faq) ·
[iroh on GitHub](https://github.com/n0-computer/iroh) ·
[iroh multipath blog](https://www.iroh.computer/blog/iroh-on-QUIC-multipath)
It gives you QUIC's HOL-immunity + connection migration + P2P + a free relay, all in Rust that
links straight into your existing core.

> If you ever need the phone side to be a **browser**, use a **WebRTC DataChannel** instead
> (unreliable+unordered for stale-tolerant control input, a reliable channel for critical events),
> and self-host **coturn** for STUN+TURN — accepting `webrtc-rs` is still pre-production. Keep
> plain WebSocket only as a dead-simple signaling/fallback channel.

---

## 3. End-to-end encryption & pairing

Portcode's identity is "zero telemetry, keys never leave the machine." The relay must be **blind** —
it forwards ciphertext and can never read your code or session. Do **not** rely on the relay (or on
WebRTC's transport DTLS through an SFU) for confidentiality; run an **application-layer E2E session
end-to-end**.

- **Use the Noise Protocol Framework** via the pure-Rust [`snow`](https://docs.rs/snow) crate
  (v0.10, Curve25519 + ChaCha20-Poly1305 + BLAKE2s; `no_std`+`alloc` capable, so it works on both
  desktop and mobile). Construction: `Noise_*_25519_ChaChaPoly_BLAKE2s`.
- **Pattern choice:** **XX** for first-time pairing (neither device knows the other's key yet —
  "the most generically useful" pattern), then persist each device's static public key and switch
  to **KK** (or **IK**, as WireGuard does) for fast, mutually-authenticated reconnects.
  [Noise spec](https://noiseprotocol.org/noise.html)
- **Defeat MITM at pairing with a QR code / Short Authentication String (SAS).** A SAS is a
  truncated hash of the negotiated shared secret; comparing it out-of-band (best via QR when the
  devices are co-present) detects an active attacker, who can't make both endpoints display the same
  string. [IETF pairing draft](https://www.ietf.org/archive/id/draft-ietf-dnssd-pairing-01.xml)
- **Forward secrecy** comes from ephemeral X25519 keys (`ee` DH): past sessions stay safe even if a
  long-term static key later leaks. [WireGuard](https://www.wireguard.com/protocol/)
- **Cipher choice:** prefer **ChaCha20-Poly1305** — it's faster than AES-GCM on phone CPUs lacking
  AES hardware, and is what WireGuard mandates.
  [chacha20poly1305 crate](https://docs.rs/chacha20poly1305) · [WireGuard](https://www.wireguard.com/protocol/)
- **WebRTC note:** a _plain TURN relay_ keeps DTLS-SRTP end-to-end (relay sees only ciphertext),
  but the moment you add an **SFU/middlebox** that terminates DTLS, you must add SFrame / Insertable
  Streams app-layer encryption to keep true E2EE.
  [webrtcHacks](https://webrtchacks.com/true-end-to-end-encryption-with-webrtc-insertable-streams/)
  (iroh's transport is already TLS 1.3, but you still want the app-layer Noise session on top so the
  relay stays blind.)

This composes cleanly with iroh: iroh handles transport + NAT, Noise handles the blind-relay E2E
guarantee.

---

## 4. The phone app — maximizing reuse of the existing Rust core

You already ship **Tauri v2 (Rust core + React/TS UI)**. Reuse options, most-reuse first:

1. **Tauri v2 mobile (recommended first attempt).** Tauri v2 has been stable since 2024-10-02 and
   officially builds iOS/Android **from the same codebase** — you reuse **both the Rust core and the
   React/TS UI**, the largest reuse of any option. The team's own framing: "you can develop
   production-ready mobile applications with Tauri NOW," while admitting "not all of our desktop
   features and plugins are ported or available on mobile yet."
   [Tauri 2.0 blog](https://v2.tauri.app/blog/tauri-2-0-0-release-candidate/)
   - **Big caveat — background execution.** Tauri mobile has **effectively no first-class
     background execution**; a long-running Rust loop (e.g. a sync poller) **stops when the app is
     backgrounded.** [Tauri discussion #11688](https://github.com/orgs/tauri-apps/discussions/11688)
     The only path is community plugins (e.g. `tauri-plugin-background-service`) wrapping Android
     Foreground Services / iOS BGTaskScheduler — both heavily OS-limited.
     [crates.io](https://crates.io/crates/tauri-plugin-background-service)
   - **Maturity reality:** real-world Tauri-mobile shipping today skews to indie/local-first
     single-platform apps; one dev who shipped 4 Android apps in 2025 called it "viable for
     indie/personal production apps; questionable for commercial applications requiring advanced
     native features."
     [erikhorton.com](https://blog.erikhorton.com/2025/10/05/4-mobile-apps-with-tauri-a-retrospective.html)

2. **Keep the Rust core, expose it via [uniffi](https://github.com/mozilla/uniffi-rs) + native (or
   RN) UI.** uniffi is Mozilla's production-proven bindings generator (Firefox, hundreds of millions
   of users) with **Swift + Kotlin** output and **async** support (`async fn` ↔ Swift `async`/Kotlin
   `suspend`). [uniffi futures](https://mozilla.github.io/uniffi-rs/next/futures.html) Caveats: no
   cross-FFI **cancellation** (build your own cancel channel — essential for aborting in-flight
   network ops), and uniffi is "a long way from 1.0" so expect binding churn. There's also an
   early-stage [uniffi for React Native](https://hacks.mozilla.org/2024/12/introducing-uniffi-for-react-native-rust-powered-turbo-modules/)
   if you want an RN UI over the same Rust.

3. **Flutter + [flutter_rust_bridge](https://github.com/fzyzcjy/flutter_rust_bridge).** A Flutter
   Favorite at 2.x with async/Stream bridging and credible large users (AppFlowy, RustDesk).
   [LogRocket](https://blog.logrocket.com/using-flutter-rust-bridge-cross-platform-development/)
   Choose only if the team prefers Flutter.

4. **Fully native** — fallback only when platform constraints make web-runtime/FFI unacceptable; the
   most duplicated work.

**Recommendation:** prototype on **Tauri v2 mobile** (fastest, max reuse). Because Phone Sync needs
robust **background** behavior, plan to write the background/wake piece as **native plugins**
regardless — and if Tauri-mobile's runtime constraints bite, the escape hatch is keeping the Rust
core and re-exposing it via **uniffi** under a native UI, with no rewrite of your sync/crypto logic.

---

## 5. The AFK problem — background execution & wake-ups (where iOS costs money)

This is the crux of "work from phone when AFK," and where the free constraint breaks on iOS.

**iOS:**

- iOS **does not allow arbitrary apps to hold long-lived TCP/WebSocket connections in the
  background**; a backgrounded app is suspended and its sockets torn down — **APNs push is
  effectively the only sanctioned way to wake it.**
  [Apple Developer Forums](https://developer.apple.com/forums/thread/757385)
- A silent/background push (`content-available:1`) grants only a **~30-second** window before
  re-suspension. [appsonair](https://www.appsonair.com/blogs/background-execution-limits-in-ios-what-every-developer-must-know)
- Silent-push delivery is **best-effort and throttled** (battery/usage/frequency). Practical ceiling
  is roughly **2–3/hour per device** (some report fewer). ⚠️ _Apple does not publish a hard number —
  treat this as observed guidance, not a guarantee._
  [Pushwoosh](https://help.pushwoosh.com/hc/en-us/articles/26713265335581-Understanding-Silent-Push-Notification-Behavior-and-Limits-on-iOS)
- **APNs requires a paid Apple Developer Program membership ($99/year)** — **no free tier**; and the
  fee waiver is **only** for nonprofits/accredited-edu/government — **individuals/hobbyists are
  explicitly ineligible.**
  [Apple fee waivers](https://developer.apple.com/help/account/membership/fee-waivers/)
  (Token-based `.p8` keys don't expire, unlike `.p12` certs — but you still need the paid account.)

**Android (fully free + self-hostable):**

- In **Doze mode** Android suspends network, ignores wakelocks, and defers alarms/jobs/syncs until a
  maintenance window. [Android Doze](https://developer.android.com/training/monitoring-device-state/doze-standby)
- **FCM high-priority messages bypass Doze** (immediate delivery + temp network + wakelock); normal
  priority can be delayed. **FCM is free at any volume** (Firebase Spark tier, unmetered).
  [FCM priority](https://firebase.google.com/docs/cloud-messaging/android/message-priority) ·
  [Firebase pricing](https://firebase.google.com/pricing)
- **Or go Google-free:** **UnifiedPush + self-hosted [ntfy](https://docs.ntfy.sh/)** delivers
  high-priority wake-ups with no Google account and no fees (F-Droid build uses no Firebase at all).
  [UnifiedPush](https://unifiedpush.org/) · [ntfy](https://docs.ntfy.sh/subscribe/phone/) But note:
  **ntfy on iOS still can't be fully self-hosted** — it must forward a `poll_request` to an
  upstream APNs-connected server or iOS delivery is delayed by hours.
  [ntfy iOS config](https://docs.ntfy.sh/config/#ios-instant-notifications)

**Critical synthesis:** a relay/signaling layer (iroh-relay, coturn, a WebSocket relay,
Tailscale/headscale) **keeps a connection alive only while the app is awake/foregrounded. None of
them can wake a suspended iOS app or bypass Doze.** That always requires APNs (iOS) or
FCM/UnifiedPush (Android). [Apple](https://developer.apple.com/forums/thread/757385)

**Pattern:** push is a _doorbell_, not a _pipe_. On wake-up, the push tells the phone "there's new
session activity"; the app then opens the iroh/Noise channel during its brief window to pull the
delta and/or show a notification. Heavy lifting stays on the always-on desktop.

---

## 6. Turnkey sync frameworks — do they beat rolling our own?

Surveyed for free / self-hostable / OSS / E2E:

| Framework                  | OSS            | Self-host                                   | Free                       | E2E encryption                       | Fit for us                       |
| -------------------------- | -------------- | ------------------------------------------- | -------------------------- | ------------------------------------ | -------------------------------- |
| Automerge + automerge-repo | MIT            | Yes (ref server is "unsecured Express app") | Yes                        | **No** built-in; DIY                 | CRDT overkill; no auth/E2E yet   |
| Yjs / Yrs                  | MIT            | Yes                                         | Yes                        | DIY (relay can carry ciphertext)     | CRDT overkill                    |
| ElectricSQL                | Apache-2.0     | Yes                                         | Cloud free beta            | Yes (sync ciphertext as JSON)        | Read-path only; you build writes |
| PowerSync                  | OSS + Cloud    | Yes                                         | $0 tier (idle-deactivated) | Planned (Enterprise)                 | E2E not GA                       |
| Jazz                       | MIT            | Yes (own server)                            | Free tier + $9–79/mo       | **Yes, by default**                  | Strong if you want turnkey E2E   |
| Triplit                    | OSS            | Yes                                         | Cloud free tier            | Not a headline                       | Acquired by Supabase 2025        |
| Evolu                      | OSS            | Yes (**blind relay**)                       | Free                       | **Yes, by default** (RBSR, not CRDT) | Closest philosophy match         |
| Turso / libSQL             | OSS (`sqld`)   | Yes                                         | Usage-based                | No built-in                          | Server-authoritative; no E2E     |
| Ditto                      | **Closed SDK** | On-prem (paid)                              | Sales-led                  | Yes (commercial)                     | Not free/OSS                     |

Sources: [Automerge 2.0](https://automerge.org/blog/automerge-2/) ·
[automerge-repo](https://automerge.org/blog/automerge-repo/) ·
[sync-server](https://github.com/automerge/automerge-repo-sync-server) ·
[Electric security](https://electric-sql.com/docs/guides/security) ·
[Electric writes](https://electric-sql.com/docs/guides/writes) ·
[PowerSync pricing](https://powersync.com/pricing) ·
[Jazz](https://alternativeto.net/software/jazz/about) ·
[Evolu](https://www.evolu.dev/blog/scaling-local-first-software) ·
[libSQL](https://github.com/tursodatabase/libsql) ·
[Ditto](https://ditto.live/pricing/cloud-sync)

**Verdict: roll your own append-only encrypted log.** For a 1-writer, 1-to-1, append-mostly session,
the turnkey CRDT/sync frameworks add machinery you won't use, and most don't do E2E by default. Your
existing **SQLite-WAL session store already _is_ the log** — replicating its new rows over the
iroh+Noise channel is a small, well-understood problem. If you ever want it off-the-shelf with
E2E-by-default and a blind relay, **Evolu** (philosophy-aligned: blind relay, E2E, free,
self-hostable, RBSR not CRDT) or **Jazz** (MIT, E2E by default, self-hostable) are the strongest
fallbacks.

---

## 7. Recommended concrete stack

| Layer              | Pick                                                                               | Why                                                             | Cost                   |
| ------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------- |
| **Topology**       | Always-on desktop = brain; phone = remote-control + continuation                   | Execution needs desktop files/shell                             | —                      |
| **Transport**      | **iroh** (QUIC, dial-by-key, hole-punch + self-host relay)                         | HOL-immune, survives handoff, P2P, Rust + Swift/Kotlin bindings | Free (self-host relay) |
| **E2E crypto**     | **Noise via `snow`** (`Noise_XX→KK_25519_ChaChaPoly_BLAKE2s`) + **QR/SAS pairing** | Blind relay, forward secrecy, phone-friendly cipher             | Free                   |
| **Sync model**     | **Roll-your-own append-only encrypted event log** (replicate new SQLite-WAL rows)  | CRDT overkill for 1-writer 1-to-1                               | Free                   |
| **Phone app**      | **Tauri v2 mobile** first; **uniffi** + native UI as escape hatch                  | Reuse Rust core (+ React UI in Tauri)                           | Free                   |
| **Wake (Android)** | **FCM high-priority** or self-hosted **ntfy/UnifiedPush**                          | Bypasses Doze; fully free                                       | Free                   |
| **Wake (iOS)**     | **APNs** (mandatory)                                                               | Only sanctioned background wake on iOS                          | **$99/yr**             |

**Suggested build order:**

1. Desktop-side: expose the SQLite-WAL session log as an append-only event stream + a command intake.
2. Stand up iroh transport with a self-hosted relay; prove desktop↔desktop first.
3. Layer Noise (`snow`) on top; implement QR/SAS pairing + persisted device keys.
4. Tauri v2 mobile shell reusing the React UI; wire it to the iroh+Noise channel (foreground only).
5. Add the **doorbell**: FCM/ntfy on Android (free, ship first), then APNs on iOS (when you pay the $99).
6. Background plugins (native) for the brief wake windows; push = doorbell, not pipe.

---

## 8. What money _can't_ buy around

Be upfront with users (it fits Portcode's "don't blur what's real" ethos): **the iOS background
story costs $99/yr and is throttled by Apple no matter what you build.** Android can be 100% free and
even Google-free. Everything else — transport, encryption, relay, sync, the app itself — is free and
self-hostable. Recommend shipping **Android Phone Sync first** (fully free), and bringing iOS online
once the Apple Developer membership is in the budget.

---

### Method note

This report was produced by a 5-angle parallel web-research pass (transport, E2E/pairing,
Tauri-mobile-vs-alternatives, CRDT-sync-vs-relay, mobile-background-limits-and-relays), each
extracting falsifiable claims with sources. Decision-critical claims are sourced to primary docs
(Apple/Android/Firebase developer docs, the Noise spec, WireGuard, the Tauri blog, iroh docs). The
one explicitly-flagged uncertainty is the iOS silent-push throttle rate, which Apple does not
publish as a fixed number.
