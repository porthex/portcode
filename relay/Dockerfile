# syntax=docker/dockerfile:1
#
# Self-hosted iroh-relay for Portcode Phone Sync (browser web client + desktop).
#
# WHY THIS EXISTS (docs/IOS_WEB_CLIENT_PLAN.md §3, §5.5):
#   Browser iroh nodes are RELAY-ONLY over a WebSocket — they cannot hole-punch.
#   Every browser <-> desktop byte therefore transits an iroh relay. The relay is
#   BLIND: it forwards opaque ciphertext (the Noise XX session lives INSIDE the
#   QUIC stream), so it holds no secrets and needs no auth integration. We
#   self-host it to control latency (place it near users), avoid public-relay
#   rate limits, and — most importantly — PIN THE RELAY VERSION in lock-step with
#   the browser+desktop `iroh` dependency. The relay protocol is version-locked
#   across browser/desktop/relay (§9 risk #3); a mismatch silently breaks pairing.
#
# VERSION LOCK (the load-bearing pin):
#   IROH_VERSION below MUST match the `iroh` crate version the Rust workspace
#   resolves. It is pinned to 1.0.0, which is what `iroh = "1"` resolves to today
#   (declared in src-tauri/Cargo.toml; once the shared crate lands per the plan,
#   the source of truth is crates/portcode-sync/Cargo.toml + Cargo.lock). The
#   `iroh-relay` crate is published from the same iroh workspace and shares the
#   version number, so 1.0.0 of `iroh-relay` speaks the 1.0.0 relay protocol.
#   When you bump `iroh` in the Rust workspace, bump IROH_VERSION here in the
#   SAME change and redeploy (see relay/README.md "Upgrading in lock-step").
#
# INSTALL METHOD (noted per the build-it-for-real constraint):
#   We build the official `iroh-relay` binary from crates.io with
#   `cargo install iroh-relay --version <pin>`. This is the documented install
#   path (https://crates.io/crates/iroh-relay). n0 does not publish a pinned,
#   per-release relay container image, so building from the pinned crate is the
#   reproducible, version-locked option.

# ---- build stage -------------------------------------------------------------
# rust-toolchain.toml pins Rust to stable; iroh requires >= 1.91, so the build
# image is pinned at or above that floor.
FROM rust:1.91-slim-bookworm AS build

# Keep in lock-step with `iroh` in the Rust workspace (resolves to 1.0.0 today).
ARG IROH_VERSION=1.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin the exact relay build by version. `--root /out` keeps the binary in a clean
# prefix we copy from in the runtime stage. `--locked` is intentionally omitted:
# we install from the published crate (no shipped Cargo.lock to honour); the
# `--version` pin is what makes the build reproducible and version-locked.
RUN cargo install iroh-relay --version "${IROH_VERSION}" --root /out

# ---- runtime stage -----------------------------------------------------------
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --uid 10001 relay

COPY --from=build /out/bin/iroh-relay /usr/local/bin/iroh-relay
COPY relay.config.toml /etc/iroh-relay/relay.config.toml

USER relay

# The relay's WebSocket endpoint. The container runs as the NON-ROOT `relay` user,
# which cannot bind a privileged port (<1024) — so the relay listens on the
# UNPRIVILEGED internal port 8443 (matches relay.config.toml `http_bind_addr`).
# Hosts that terminate TLS at their own edge (Fly/Render) map their public 443
# (wss) -> this container's 8443; a VPS doing Shape A (relay-terminated TLS) maps
# host 443 -> 8443 too (see docker-compose.yml). We also expose the UDP port
# iroh-relay uses for QUIC address discovery (the native-side relay leg).
EXPOSE 8443/tcp
EXPOSE 3478/udp

# Liveness: confirm the pinned binary is present and runnable. iroh-relay also
# serves an HTTP probe path once running (the host health checks below hit that
# over the network); this container-level check guards against a broken image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["/usr/local/bin/iroh-relay", "--help"]

ENTRYPOINT ["/usr/local/bin/iroh-relay"]
CMD ["--config-path", "/etc/iroh-relay/relay.config.toml"]
