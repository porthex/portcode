# Self-dev mode

Self-dev mode is how you **build Portcode while living inside Portcode** — the
fastest way to find real bugs is to use the app all day as you change it.

This document covers **Phase 1** (the side-by-side dev build, shippable today and
adding no risk to the normal app) and **Phase 2** (the gated promotion supervisor
that lets the running dev build apply its own changes) — both now built behind the
`self-dev` Cargo feature, so a production build carries none of it.

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

# Same, but UNDER THE RESTART LOOP so the in-app promote gate can apply its own
# Rust changes (Phase 2). Builds with `--features self-dev`; see Phase 2 below.
pnpm app:dev:self:loop

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

## Phase 2 — the promotion supervisor (BUILT)

When a **Rust** change is ready to validate, the in-app promotion supervisor lets
the running dev build apply it safely. It is **feature-gated** behind the
`self-dev` Cargo feature (`#[cfg(all(desktop, feature = "self-dev"))]`), so a
production build carries none of it. Live in `src-tauri/src/selfdev/`.

**The model — gate + restart the dev build** (not a blue-green binary swap). The
original blue-green sketch (keep two binaries, auto-roll-back to the old one) was
dropped: `tauri dev` compiles the binary once at startup and `app.restart()` only
relaunches the _same_ binary, so the running app can't recompile itself — the swap
plumbing wasn't worth it. Instead, **safety lives in a test GATE**, and applying a
change is just a controlled relaunch of `tauri dev` (which recompiles). Rollback,
if something slips through, is a `git revert` + another apply.

**The flow** (the **Promote** control sits beside the DEV pill in the title bar):

1. **Promote** → **Snapshot** the dev `portcode.db` (after a WAL checkpoint) to a
   recoverable copy under `selfdev/`.
2. **Gate** the change: `pnpm test`, then `cargo test --workspace`. Any failure
   (or a cancel) stops here and shows why — nothing is applied.
3. On green → **Gate passed ✓**, with an **↻ Apply & Restart** button.
4. **Apply** → the app records `applying` and exits with a distinctive code
   (`86`). An external **restart-loop wrapper** sees that code and relaunches
   `tauri dev`, which **recompiles**, bringing the change live. Any other exit
   code stops the loop.

Because the app can't recompile itself, **Apply only works under the wrapper** —
run the dev build with `pnpm app:dev:self:loop` (which sets
`PORTCODE_SELFDEV_RESTART_LOOP=1` and passes `--no-watch`, so changes apply only
through the gate, never on every save). Without the wrapper, `promote_apply`
refuses rather than closing the app with nothing to relaunch it.

Commands: `promote_begin` / `promote_cancel` / `promote_status` / `promote_apply`
(registered only with `--features self-dev`); progress is pushed on the
`selfdev://promote` event and drives the `PromoteBadge`.

### Increment 1 — protected-paths denylist (BUILT)

Prerequisite safety for Phase 2 (because the agent can edit Portcode's own
source): a **protected-paths denylist** so a single approved write can't silently
neuter Portcode's own guards. Implemented in `src-tauri/src/tools.rs`:

- A **compiled-in** `const PROTECTED: &[(&str, &str)]` (path-prefix → reason) —
  deliberately not a runtime config file, which the agent could just `fs_write` to
  empty. A future settings layer may only ever ADD entries; this const set is
  always unioned in and can never be removed or disabled (the floor only rises).
- Covered: `src-tauri/src/permissions.rs`, `secrets.rs`, `oauth.rs`, `sync/**`,
  `tools.rs` + `agent.rs` (anti-tamper — the agent can't rewrite its own guards or
  this very denylist), `.github/**`, `tauri.conf.json`, `tauri.dev.conf.json`,
  `rust-toolchain.toml`, `deny.toml`.
- Enforced at the single write chokepoint: `protected_reason()` is matched on the
  workspace-relative, normalized path (case-insensitive; immune to `./`, `..`, and
  Windows' silently-stripped trailing dots/spaces). `fs_write` is gated at the end
  of `resolve_for_write`; `fs_edit` (which resolves an existing file) is gated right
  after `resolve_existing` in both `run` and `preview`.

**The `shell` bypass** — `shell` runs arbitrary commands with `cwd = workspace` and
never resolves a write target, so `Set-Content permissions.rs …` would otherwise
sidestep the denylist. Closed with `shell_targets_protected_path()`, a conservative
TEXTUAL pre-exec scan run at the tool layer (so it holds even in `auto`/`bypass`
permission mode, where the user never sees the command). It blocks a command that
BOTH names a protected path AND carries a write indicator (redirection, or a known
file-mutating cmdlet/command). A full shell parser is infeasible and would be a
footgun, so **path/indicator obfuscation (string concat, base64, env-var
indirection) is a documented residual gap** — mitigated by the file tools being
hard-blocked (the agent's normal edit path), the Phase-2 promotion health-gate, and
git rollback. The protected source files are themselves git-tracked, so any sneaked
change is visible in the diff before promotion.

The scanner has been hardened against two additional bypass vectors:

- **PowerShell cmdlet aliases** — short aliases (`sc`/Set-Content, `ac`/Add-Content,
  `clc`/Clear-Content, `ni`/New-Item, `mi`/Move-Item, `cpi`/Copy-Item,
  `ri`/Remove-Item, `rni`/Rename-Item) are matched as whole tokens so they cannot
  hide inside innocent words like "basic" or "describe". Previously only the full
  cmdlet name was listed, so `sc permissions.rs 'x'` slipped through.

- **Windows 8.3 short names** — `PERMIS~1.RS` is the 8.3 alias Windows assigns to
  `permissions.rs` when it is the first file in the directory whose name starts with
  the same six characters. The scanner detects the `NAME~<digit>` pattern in path
  tokens and checks whether the stem prefix (capped at 6 chars, matching Windows'
  truncation rule) is a prefix of any protected filename stem or directory component.
  Previously `echo x > src-tauri\src\PERMIS~1.RS` bypassed the scan entirely.

**Remaining documented residual gaps** (defense-in-depth; primary protection is the
`fs_write`/`fs_edit` hard-block + promotion health-gate + git rollback):

- Command obfuscation — base64 payloads, string concatenation, environment-variable
  indirection, `iex`/`Invoke-Expression`, COM/WMI paths, etc.
- 8.3 `~2`, `~3`, … collision variants (extremely unlikely for the protected file set
  but not impossible on a heavily populated directory).
