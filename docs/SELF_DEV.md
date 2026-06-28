# Self-dev mode

Self-dev mode is how you **build Portcode while living inside Portcode** — the
fastest way to find real bugs is to use the app all day as you change it.

This document covers **Phase 1**, which is shippable today and adds no risk to
the normal app. Phase 2 (the automatic, gated build-promotion supervisor) is
sketched at the bottom but intentionally **not** built yet.

> **Why not "two synced instances that auto-swap on every change"?**
> That was the original idea. A multi-agent feasibility study found it isn't
> viable on this stack: the sync engine is thin-client↔host (not peer↔peer) and
> serde-fragile across versions, one SQLite file + forward-only migrations makes
> role swap-back dangerous, and two live instances + a Rust rebuild blow past an
> 8 GB RAM machine. Phase 1 below delivers ~90% of the dogfooding benefit with
> none of that risk — the same pattern Chrome/VS Code/Zed use (a dev channel
> alongside stable).

---

## The picture: two apps, side by side

|            | **Portcode**                     | **Portcode Dev**                                               |
| ---------- | -------------------------------- | -------------------------------------------------------------- |
| Role       | your everyday app — always works | your workbench — new changes land here first                   |
| Identifier | `dev.porthex.portcode`           | `dev.porthex.portcode.dev`                                     |
| Data dir   | its own `AppData` folder         | a **separate** `AppData` folder (own `portcode.db` + settings) |
| Title bar  | `Portcode`                       | `Portcode Dev` + a magenta **DEV** pill                        |

Because the two builds use different bundle identifiers, Tauri gives each its own
data directory automatically — so anything you do in **Dev** can never scramble
your everyday app's history or settings.

**Shared:** the Windows Credential Manager login (Claude OAuth / API key, phone
-sync keys) is shared between the two builds, because it's keyed on a fixed
service name. That's a convenience in Phase 1 (log in once) — see the
[run one at a time](#run-one-at-a-time-in-phase-1) caveat.

---

## The two speeds of change

**1. Look & feel (most changes)** — React / TypeScript / CSS under `src/`.
These hot-reload **live** in the running window via Vite (React Fast Refresh).
Save the file, watch it update in under a second. No restart, no rebuild.

**2. Engine change** — the Rust core under `src-tauri/`. There is no Rust hot
reload: a change means a full `cargo` rebuild + app relaunch (minutes on a
low-RAM machine). For tight feedback while editing Rust, run `pnpm watch:rust`
(see below) to get type/borrow/clippy errors in **seconds** without a full
build, and only do the full rebuild when you actually want to run the change.

---

## Commands

```bash
# Run the self-dev app with live frontend reload (separate data dir + DEV pill).
pnpm app:dev:self

# Build an installable "Portcode Dev" you can keep alongside your normal app.
pnpm app:build:self

# Fast Rust feedback loop while editing src-tauri/ (needs: cargo install --locked bacon).
pnpm watch:rust
```

For reference, the normal app is still `pnpm app:dev` / `pnpm app:build`.

### How it's wired (no Rust changes)

- **`src-tauri/tauri.dev.conf.json`** — a partial config merged over
  `tauri.conf.json` by `tauri … --config` (run from the repo root, so the path
  resolves relative to the working directory). It only overrides `productName`,
  `identifier`, the window title, and the before-dev/before-build commands;
  everything else (`frontendDist`, `devUrl`, the updater, bundle settings) is
  inherited from the base config.
- **`.env.selfdev`** — sets `VITE_PORTCODE_CHANNEL=dev`, loaded by Vite's
  `selfdev` mode (`vite --mode selfdev`, run by `pnpm dev:self` / `build:self`).
- **`src/lib/channel.ts` + `src/components/ChannelBadge.tsx`** — read that flag
  and render the **DEV** pill in the title bar.
- **`src-tauri/bacon.toml`** — the `pnpm watch:rust` job definitions.

---

## Run one at a time (in Phase 1)

Phase 1 is designed for running **either** the stable app **or** the dev app —
not both at once. Two reasons, both because login/sync state is shared:

1. **Phone sync** uses one node identity from Credential Manager; two live
   instances would collide on the network bind.
2. **OAuth tokens** rotate in shared storage; two instances refreshing at once
   can clobber each other's token.

Running them one at a time sidesteps both entirely. (Running them
_simultaneously_, with separated identity + safe handoff, is Phase 2.)

The dev build does **not** auto-update itself (the updater is pull-only and
nothing in the UI triggers it), so it stays exactly the build you compiled.

---

## Phase 2 (roadmap — not built yet)

When a meaningful **Rust** change is ready to validate, a small supervisor
(`scripts/self-dev.*`) would promote it safely, blue-green style:

1. **Snapshot** the stable `portcode.db` (after a WAL checkpoint).
2. **Build** the candidate, then **health-gate** it (`pnpm test` + `cargo test`).
3. **Promote** only on green; keep the previous binary at a fixed path so a
   broken candidate **auto-rolls-back**.
4. **Sequential, not concurrent** (the 8 GB machine can't sustain two live
   instances plus a rebuild): close stable → build → gate → relaunch as the new
   stable.

Prerequisite safety for Phase 2 (because the agent can edit Portcode's own
source): a **protected-paths denylist** in `tools.rs::resolve_for_write` so a
single approved write can't silently neuter `permissions.rs` / `secrets.rs` /
`oauth.rs` / `sync/` / `.github/`.
