# Dev setup — Portcode self-dev workspace

A copy-pasteable on-ramp for running Portcode and its self-dev workspace on
Windows. This guide focuses on getting you to `pnpm app:dev:self` (the "Portcode
Dev" build) as fast as possible.

- **Toolchain depth + contributor norms:** [CONTRIBUTING.md](../CONTRIBUTING.md)
- **Why self-dev exists, how it's wired, Phase 2 roadmap:** [docs/SELF_DEV.md](SELF_DEV.md)

---

## Prerequisites

All five items below are required. The last one (bacon) is optional and only
needed for the `pnpm watch:rust` Rust feedback loop.

### 1. Visual Studio Build Tools with MSVC

Portcode uses the `x86_64-pc-windows-msvc` target — the GNU toolchain is **not**
supported. You need MSVC and the Windows SDK.

```powershell
# Install via the Visual Studio Installer
# Component required: "Desktop development with C++"
winget install Microsoft.VisualStudio.2022.BuildTools
```

Or open the installer manually and check **Desktop development with C++**.

### 2. WebView2 runtime

- **Windows 11** — already installed, nothing to do.
- **Windows 10** — download and run the Evergreen Bootstrapper from
  [microsoft.com/en-us/edge/webview2](https://microsoft.com/en-us/edge/webview2).

### 3. Rust via rustup

`rust-toolchain.toml` in the repo root pins the exact channel (stable),
components (rustfmt, clippy), and targets (win-msvc, linux-gnu). `rustup`
materializes this automatically the first time you build — no manual toolchain
juggling required.

The crate requires Rust 1.91 or later (`rust-version` in `src-tauri/Cargo.toml`).
Current stable exceeds this.

```powershell
winget install Rustlang.Rustup
```

Or install from [rustup.rs](https://rustup.rs).

### 4. Node.js LTS + pnpm via Corepack

CI runs Node 20. Any LTS release >= 20 works locally. The project uses
`pnpm@10.34.3` (pinned in `package.json`). Use Corepack to manage pnpm — do
**not** use npm or yarn, as that would desync `pnpm-lock.yaml`.

```powershell
winget install OpenJS.NodeJS.LTS
# After Node is installed:
corepack enable   # makes the pinned pnpm@10.34.3 available
```

### 5. bacon (optional — for `pnpm watch:rust`)

Only needed if you want fast incremental Rust feedback while editing
`src-tauri/`. Skip this if you don't plan to change Rust.

```powershell
cargo install --locked bacon
```

---

## Clone + install

```powershell
git clone https://github.com/porthex/portcode.git
cd portcode

corepack enable    # if you haven't already
pnpm install       # installs JS dependencies from pnpm-lock.yaml
```

Rust dependencies are fetched by Cargo automatically on the first build — no
separate step is needed.

---

## Run commands

| Command               | What it does                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm app:dev`        | Full Tauri app + Vite dev server with HMR on port 1420 (everyday stable build)                 |
| `pnpm dev`            | React UI only in a browser — no Tauri/IPC. Fast for pure UI iteration.                         |
| `pnpm app:build`      | Production NSIS installer                                                                      |
| `pnpm app:dev:self`   | **Self-dev**: runs "Portcode Dev" (separate data dir + magenta DEV pill) with live FE reload   |
| `pnpm app:build:self` | **Self-dev**: builds an installable "Portcode Dev" you can keep alongside the normal app       |
| `pnpm watch:rust`     | **Self-dev**: bacon fast `cargo check`/clippy loop while editing `src-tauri/` (requires bacon) |

---

## Self-dev daily loop

### Two apps, one machine

`pnpm app:dev:self` launches a build with a different Tauri bundle identifier
(`dev.porthex.portcode.dev`), so the OS gives it its own `AppData` folder — its
own `portcode.db`, its own settings. Anything you do in Dev can never scramble
your everyday app's history.

The title bar shows **"Portcode Dev"** and a magenta **DEV** pill so you always
know which instance you're looking at.

### Two speeds of change

**Frontend (`src/` — React / TypeScript / CSS)**
Changes hot-reload live in the running window via Vite / React Fast Refresh.
Save the file and the update appears in under a second. No restart needed.

**Rust core (`src-tauri/`)**
There is no Rust hot-reload. A change requires a full `cargo` rebuild + app
relaunch, which takes several minutes on a low-RAM machine. Use
`pnpm watch:rust` in a separate terminal for type / borrow / clippy feedback
in seconds while editing; trigger the full rebuild only when you want to run
the change.

### Run one at a time

Phase 1 is designed for running _either_ the stable app _or_ the dev app —
not both simultaneously. Two reasons:

1. **Phone sync** uses one node identity from Windows Credential Manager; two
   live instances collide on the network bind.
2. **OAuth tokens** rotate in shared storage; two instances refreshing at once
   can clobber each other's token.

See [docs/SELF_DEV.md — Run one at a time](SELF_DEV.md#run-one-at-a-time-in-phase-1)
for the full explanation and the Phase 2 plan that removes this constraint.

---

## Quality gates — run before pushing

CI runs these on every pull request. Save yourself a round-trip and run them
locally first.

### Frontend

```powershell
pnpm lint            # ESLint
pnpm format:check    # Prettier (pnpm format to auto-fix)
pnpm typecheck       # tsc --noEmit
pnpm test            # Vitest
```

### Rust

The repo is a Cargo workspace (`src-tauri/`, `crates/portcode-sync`, `crates/portcode-wasm`). Run from
the repo root:

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

### Coverage (not a PR gate)

`pnpm test:coverage` is measured on `main`/`release` only — contributor PRs are
never gated on it. See [CONTRIBUTING.md — Testing notes](../CONTRIBUTING.md#testing-notes).

---

## Troubleshooting

### Port 1420 is already in use

`vite.config.ts` sets `strictPort: true`, so Vite will error rather than try
another port. This applies to both `pnpm app:dev` and `pnpm app:dev:self` (the
self-dev config inherits `devUrl: http://localhost:1420`).

```powershell
Get-NetTCPConnection -LocalPort 1420 | Select-Object OwningProcess
Stop-Process -Id <OwningProcess>
```

Free the port — do not change the port number; Tauri's config hard-codes it.

### MSVC not found / linker errors

Make sure the **MSVC** toolchain is active (`rustup show` should show
`x86_64-pc-windows-msvc`), not the GNU toolchain. WebView2 headers and the
Windows SDK also need to be present from the Visual Studio Build Tools install.

### `pnpm watch:rust` fails: "bacon not found"

Install it first:

```powershell
cargo install --locked bacon
```

Then re-run `pnpm watch:rust`.

### Rust builds are slow / machine runs out of memory

Full Tauri builds are heavy on an 8 GB machine. Workflow:

1. Use `pnpm watch:rust` for fast type/borrow/clippy feedback while editing.
2. Let CI (`cargo clippy` / `cargo test`) run the Rust verification leg on PRs
   — you don't need to run a full local Tauri build to contribute Rust changes.
3. Only run `pnpm app:dev:self` for a full rebuild when you need to test a
   running Rust change end-to-end.
