# Portcode Phone Sync — self-hosted `iroh-relay` runbook

This directory contains everything needed to **stand up a self-hosted,
version-pinned `iroh-relay`** for Portcode Phone Sync, plus the runbook for
deploying, upgrading, and pointing the desktop + web client at it.

It implements **Phase 6** of [`../docs/IOS_WEB_CLIENT_PLAN.md`](../docs/IOS_WEB_CLIENT_PLAN.md)
("Self-host relay + launch"). The actual hosting choice and ongoing cost are an
operator decision — these files make the deploy a one-step action on whichever
host you pick.

> The hosting decision (Fly.io vs Render vs VPS) and its recurring cost are
> **yours to make** — see [docs/IOS_WEB_CLIENT_PLAN.md §9](../docs/IOS_WEB_CLIENT_PLAN.md).
> This runbook gives you a ready-to-deploy config for each.

---

## Why a relay at all (and why self-host)

Browser iroh nodes are **relay-only** over a WebSocket — they cannot do
UDP/hole-punching (this is by design; browsers have no UDP). So **every
browser ↔ desktop byte transits an iroh relay** (§3 of the plan).

The relay is **blind**: the Noise XX handshake + ChaCha20-Poly1305 transport run
_inside_ the iroh QUIC stream, so the relay only ever forwards **opaque
ciphertext**. It holds **no secrets**, needs **no auth integration**, and learns
nothing about your sessions (§5.5, §5.10).

You can use **n0's public relays for the spike** (zero setup), but you should
**self-host for the product** (§5.5) to:

- **Control latency** — place the relay near your users (relay-only means the
  relay hop dominates round-trip time).
- **Avoid public-relay rate limits** — your traffic, your caps.
- **Pin the version** — the relay protocol is **version-locked** across
  browser/desktop/relay (§9 risk #3). Self-hosting lets you upgrade all three in
  lock-step instead of being surprised by a public-relay bump.

It is **not on Vercel** — Vercel is a static CDN and cannot hold the long-lived
WebSocket (§3, §6). The relay is the **one always-on piece of infra** with an
uptime requirement and a monthly cost.

---

## Spike vs product: use n0 public relays first

| Stage                | Relay                                | Why                                                                              |
| -------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| **Phase 0 spike**    | n0 public relays (iroh default)      | Zero setup — validate that iroh-in-browser holds a connection on real iOS first. |
| **Product / launch** | This self-hosted, version-pinned one | Latency control, no public rate limits, version lock-step.                       |

For the spike you don't deploy anything here: native iroh defaults to n0's public
relays, and the browser endpoint can point at the same. Only once the on-device
go/no-go gate passes do you stand up the relay in this directory.

---

## What's in this directory

| File                 | Purpose                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `Dockerfile`         | Builds + pins the official `iroh-relay` binary (`cargo install iroh-relay --version <pin>`).  |
| `relay.config.toml`  | The relay config (`iroh-relay --config-path`). Blind relay, WS listener, QUIC discovery port. |
| `fly.toml`           | Fly.io deploy (edge-terminated TLS, always-on, health check, region pin).                     |
| `render.yaml`        | Render Blueprint (edge-terminated TLS, always-on, health check, region pin).                  |
| `docker-compose.yml` | Plain-VPS deploy (relay-terminated TLS).                                                      |

---

## The version lock (read this before anything else)

`iroh-relay`, the desktop `iroh`, and the browser `iroh` (WASM) **must be the
same major/minor version** — the relay protocol is version-locked (§9 risk #3).
A mismatch fails pairing, often silently.

**The pin is `1.0.0`**, which is what `iroh = "1"` resolves to in the Rust
workspace today:

- Declared as `iroh = "1"` in `src-tauri/Cargo.toml` (and, once the shared crate
  lands per §5.1 of the plan, in `crates/portcode-sync/Cargo.toml`).
- Resolved to `1.0.0` in `Cargo.lock`.
- `iroh-relay` is published from the **same iroh workspace** and shares that
  version number, so **`iroh-relay 1.0.0` speaks the iroh 1.0.0 relay protocol.**

The pin lives in three places that must agree:

1. `Dockerfile` → `ARG IROH_VERSION=1.0.0`
2. `fly.toml` → `[build.args] IROH_VERSION` / `render.yaml` → `envVars IROH_VERSION`
3. The workspace `iroh` dependency (the source of truth — read it from
   `Cargo.lock`).

### Verify the lock before deploying

```sh
# From the repo root — what the desktop/browser will actually run:
grep -A2 '^name = "iroh"' Cargo.lock        # -> version = "1.0.0"

# What this relay will run (the Dockerfile pin):
grep IROH_VERSION relay/Dockerfile           # -> ARG IROH_VERSION=1.0.0
```

These two must match. If they don't, fix the relay pin (below) before deploying.

### Upgrading in lock-step

When you bump `iroh` in the Rust workspace (e.g. to `1.1.0`):

1. Update the workspace dep and run `cargo update -p iroh`; confirm the new
   resolved version in `Cargo.lock`.
2. Set the **same** version in `relay/Dockerfile` (`ARG IROH_VERSION`), and in
   `fly.toml` / `render.yaml` / `docker-compose.yml`.
3. Rebuild + redeploy the relay **together with** shipping the new desktop build
   and the new WASM bundle. Do not ship a desktop/browser bump without
   redeploying the relay (or vice versa).
4. Smoke-test pairing end-to-end after the coordinated deploy.

> Treat an `iroh-relay` startup error about an **unknown config field** as a
> version-drift signal: the config schema moved under you. Run
> `iroh-relay --help` against the pinned binary and reconcile `relay.config.toml`.

---

## Deploy

### Build locally (smoke test the image)

```sh
cd relay
docker build --build-arg IROH_VERSION=1.0.0 -t portcode-relay:1.0.0 .
docker run --rm -p 443:443 -p 3478:3478/udp portcode-relay:1.0.0
```

### Fly.io

```sh
cd relay
fly launch --no-deploy --copy-config   # first time: creates the app from fly.toml
# Edit fly.toml: set `app`, `primary_region` (nearest your users).
fly deploy                             # builds Dockerfile, ships, keeps 1 machine up
# Optional custom domain:
fly certs add relay.example.com
```

Fly terminates TLS at its anycast edge and forwards plaintext to the container
(Shape B in `relay.config.toml`). `auto_stop_machines = "off"` +
`min_machines_running = 1` keep it always-on.

### Render

Push the repo to GitHub, then in Render: **New → Blueprint**, point it at the
repo. Render reads `relay/render.yaml`, builds the Dockerfile, and runs it on a
managed HTTPS hostname. Set `region` to the one nearest your users and keep a
plan that does **not** spin down on idle (the free tier drops live WebSockets).

### Plain VPS (docker-compose)

```sh
cd relay
# Shape A: put a real TLS cert at ./certs and enable the [tls] block in
# relay.config.toml, OR front the container with your own reverse proxy.
docker compose up -d --build
docker compose logs -f relay
```

---

## Getting the public relay URL

After deploy, your relay URL is the **WSS origin** clients dial:

- **Fly:** `wss://portcode-relay.fly.dev` (or `wss://relay.example.com` if you
  added a custom domain).
- **Render:** `wss://portcode-relay.onrender.com`.
- **VPS:** `wss://relay.example.com` (the domain whose cert you installed).

Confirm it's serving:

```sh
# Plain HTTP probe (the health-check path) should return 200:
curl -sI https://portcode-relay.fly.dev/

# WebSocket upgrade should switch protocols (101):
curl -sI -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZQ==" \
     https://portcode-relay.fly.dev/
```

---

## Pointing the desktop + web client at the relay

Both ends must be configured with **the same relay URL** and a **matching iroh
version** (§5.5). The phone learns the relay at pair time:

- **Desktop:** build its iroh endpoint with this relay (the native transport's
  `RelayMode` — see `crates/portcode-sync/src/transport_native.rs`,
  `build_endpoint(secret_key, relay)`). For the spike this is `RelayMode::Default`
  (n0 public); for the product, configure it with your `wss://…` relay URL.
- **PairingPayload carries the relay URL.** The desktop's pairing QR
  (`PairingPayload`, see `crates/portcode-sync/src/pairing.rs`) advertises the
  desktop's dialable iroh address; per §5.5/§5.9 the **`relay_url`** is added to
  this payload so the web client learns which relay to dial through when it scans
  the QR. The browser endpoint (`transport_wasm.rs`, relay-only) is built with
  that URL.
- **Web client (browser):** the WASM `Session.connect(qr, …)` (§5.4) reads the
  `relay_url` out of the scanned payload and forces relay mode to it.

So the operational contract is: **deploy the relay → put its `wss://…` URL into
the desktop's relay config → the desktop bakes it into the PairingPayload → the
phone reads it from the QR.** No relay URL is hard-coded in the browser bundle.

---

## Uptime & cost

- **Always-on.** The relay is the single piece of infra that must stay up — a
  dropped relay drops every live phone session (the desktop keeps running; phones
  reconnect-by-cursor on resume, §5.8, but only once the relay is back). The Fly
  and Render configs are set to **never idle-stop**.
- **Small footprint.** This is a **control/mirror plane** — command + frame
  traffic, small frames, not bulk transfer (§9 risk #2). A `shared-cpu-1x` /
  `256 MB` machine is plenty; scale only under real concurrent load.
- **Cost is an operator decision (§9).** Expect a small always-on VM bill on any
  of the three hosts. Pick the region nearest your users; the relay hop dominates
  latency in relay-only mode.
- **One relay, one URL.** Run a single region to start; add regions only if your
  user base is geographically split and latency demands it (each region is
  another always-on cost).
