# Contributing to Portcode

Thanks for your interest in contributing! Portcode is a fast, native Windows AI
coding agent built with Tauri v2, Rust, and React. This guide covers how to set
up your environment, the conventions we follow, and how changes get reviewed and
merged.

By participating in this project you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

> **Looking for help instead of contributing code?** See [SUPPORT.md](SUPPORT.md).
> **Found a security issue?** Do **not** open a public issue — follow
> [SECURITY.md](SECURITY.md).

---

## Table of contents

- [Ways to contribute](#ways-to-contribute)
- [Contributor License Agreement (CLA)](#contributor-license-agreement-cla)
- [Development environment](#development-environment)
- [Building and running](#building-and-running)
- [Known gotchas (read these first)](#known-gotchas-read-these-first)
- [Quality gates — run before you push](#quality-gates--run-before-you-push)
- [Branching and commits](#branching-and-commits)
- [Pull requests](#pull-requests)
- [Review and merge](#review-and-merge)
- [Project scope](#project-scope)

---

## Ways to contribute

- **Report bugs** and **request features** through the issue forms (the
  templates ask for the details we need to reproduce and triage).
- **Improve docs** — corrections and clarifications are always welcome.
- **Fix bugs or build features** — for anything non-trivial, please open or
  comment on an issue first so we can agree on the approach before you invest
  time. See [Project scope](#project-scope) for what belongs in this repo.
- **Ask questions** in [GitHub Discussions](SUPPORT.md), not the issue tracker.

---

## Contributor License Agreement (CLA)

Portcode is licensed under **Apache-2.0**. Before we can merge your first
contribution, you must agree to our [Contributor License Agreement](CLA.md).

The CLA is enforced as a required status check on pull requests (via CLA
Assistant Lite): the bot will comment on your PR with a one-time link, and you
sign by replying with the sentence it provides. You only need to do this once;
the agreement then applies to all of your future contributions. The CLA lets you
keep ownership of your work while granting the project the copyright and patent
licenses it needs to ship and maintain Portcode.

---

## Development environment

Portcode targets **Windows 10/11 today** (Linux and mobile are planned). You'll
need the following toolchain:

- **Visual Studio Build Tools** with the **MSVC** toolchain and the Windows SDK
  (Portcode uses `x86_64-pc-windows-msvc`, **not** the GNU toolchain).
- **WebView2 runtime** — ships with Windows 11; on Windows 10 install the
  Evergreen runtime if it isn't already present.
- **Rust** ≥ 1.77 (stable, MSVC). The pinned toolchain and components live in
  [`rust-toolchain.toml`](rust-toolchain.toml), so `rustup` will fetch the right
  channel automatically.
- **Node.js** (LTS) with **pnpm via Corepack**. This project uses **pnpm only** —
  do not use `npm` or `yarn`, as that would desync `pnpm-lock.yaml`.

```powershell
# From the repository root
corepack enable          # makes the pinned pnpm available
pnpm install             # install JS dependencies from the lockfile
```

Rust dependencies are fetched automatically by Cargo on the first build.

---

## Building and running

| Command          | What it does                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm app:dev`   | Run the **full app** (Tauri shell + Vite dev server with HMR). This is what you normally want.                |
| `pnpm dev`       | Run the **React UI only** in a browser (no Tauri backend — IPC calls will not work). Useful for pure UI work. |
| `pnpm app:build` | Production build → packaged **NSIS installer** (see below).                                                   |

### NSIS packaging

`pnpm app:build` runs the standard `tauri build` flow, which produces the
Windows installer via the NSIS bundler. No custom installer/template step is
required today.

> _Maintainer stub:_ if a custom NSIS plugin or template step is introduced
> later, document it here. Do not invent one.

Code signing (Azure Trusted Signing) and the auto-updater are wired in a later
phase and are **not** part of a local build.

---

## Known gotchas (read these first)

These will cost you time if you don't know about them:

- **Dev server port 1420 is pinned (`strictPort: true`).** Tauri's `devUrl` is
  hard-coded to `http://localhost:1420`, so Vite will **fail hard** rather than
  roll to another port if 1420 is already in use. Free the port instead of
  changing it:

  ```powershell
  Get-NetTCPConnection -LocalPort 1420 | Select-Object OwningProcess
  Stop-Process -Id <OwningProcess>
  ```

- **Tailwind v4 is CSS-first.** There is intentionally **no**
  `tailwind.config.js` — configuration lives in the CSS (`src/index.css` via
  `@tailwindcss/vite`). Please do not add a JS Tailwind config.

- **Zustand selectors must return stable references.** Selectors that build a
  **new** object or array on every call (e.g. `useStore(s => ({ a: s.a, b: s.b }))`)
  return a fresh reference each render and cause re-render storms or update
  loops. Use an **atomic single-value selector** per value, or wrap the selector
  in **`useShallow`** (Zustand v5). This is enforced by an ESLint rule, so CI
  will flag violations.

- **MSVC, not GNU.** The whole Windows toolchain assumes MSVC + the Windows SDK +
  WebView2.

- **The version number lives in three files** — `package.json`,
  `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. If you bump the
  version, keep all three in sync (the changelog/release process tracks this).

---

## Quality gates — run before you push

CI runs these on every pull request, so save yourself a round-trip and run them
locally first. They must all pass.

### Frontend (TypeScript / React)

```powershell
pnpm lint            # ESLint
pnpm format:check    # Prettier (use `pnpm format` to auto-fix)
pnpm typecheck       # tsc --noEmit
pnpm test            # Vitest
```

### Rust (Tauri backend)

Portcode is a single Rust crate today, so target it with `--manifest-path`:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

### Testing notes

- **Add tests for new functionality**, especially around the security-sensitive
  boundaries (the permission gate, the workspace path sandbox, file edits, and
  the `shell` path).
- **Never make live LLM API calls in tests or CI.** Use a deterministic mock
  provider; tests must be reproducible offline and must not require an API key.

---

## Branching and commits

- Branch off `main` with a short-lived, descriptive branch: `feat/…`, `fix/…`,
  `docs/…`, `chore/…`.
- We use **[Conventional Commits](https://www.conventionalcommits.org/)** with
  scopes, e.g.:

  ```
  feat(core): add Gemini provider behind the Provider trait
  fix(ui): stop re-render loop in the chat selector
  docs: clarify the port 1420 gotcha
  ```

  Conventional Commits drive the changelog and release-note categories, so
  please keep the type/scope accurate.

---

## Pull requests

- Keep PRs focused; one logical change per PR is much easier to review.
- Fill out the pull-request template (it includes a checklist for fmt/lint/tests,
  the CLA, and a security-sensitivity flag).
- Link the issue your PR addresses (`Fixes #123`).
- If your change touches the UI, include a screenshot or short clip.
- Make sure all [quality gates](#quality-gates--run-before-you-push) pass.
- **Flag security-sensitive changes.** If your PR touches the permission gate,
  secrets/credential handling, the `shell` execution path, the provider/LLM
  code, or the release/signing workflows, call it out in the description — these
  paths get extra scrutiny.

---

## Review and merge

- At least **one maintainer approval** is required. `CODEOWNERS` automatically
  requests the right reviewers; security-critical paths are gated to the
  maintainers specifically.
- All required checks (lint, typecheck, tests, Rust fmt/clippy/test, CLA) must be
  green.
- We **squash-merge**, using the PR title as the squash commit subject — so write
  the PR title as a clean Conventional Commit.

---

## Project scope

Portcode is developed in the open by Porthex. To set expectations before you
invest time, here is what does and does not belong in this repository. See
[GOVERNANCE.md](GOVERNANCE.md) for the full rationale.

**In scope (this repo):**

- The core agent loop and tools.
- The **permission gate** and workspace sandbox.
- BYOK / credential handling, kept **provider-agnostic** (Anthropic today;
  OpenAI/Codex, Gemini, local, and custom providers are planned via the
  `Provider` trait).
- The React/TypeScript UI and Windows packaging.
- New LLM providers added through the `Provider` trait.

**Out of scope (reserved):**

- Fleet/organization policy enforcement and admin consoles.
- A managed BYOK gateway or centralized inference service.
- Audit-log retention services and enterprise distribution artifacts.

**Telemetry:** Portcode ships with **no telemetry** and no phone-home today. Any
future signal would be **strictly opt-in, off by default, and documented**. PRs
that add telemetry or phone-home behavior outside that agreed design will be
declined.

---

Thank you for helping make Portcode better!
