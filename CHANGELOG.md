# Changelog

All notable changes to Portcode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Version sync.** The release version lives in **three** files and they must
> match for every tagged release: `package.json`, `src-tauri/Cargo.toml`, and
> `src-tauri/tauri.conf.json`. See [`docs/RELEASE.md`](docs/RELEASE.md) (added in
> a later phase) for the bump procedure.

## [Unreleased]

### Added

- Open-source community-health and contributor infrastructure: `LICENSE`
  (Apache-2.0), `NOTICE`, `CLA.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, `SUPPORT.md`, `GOVERNANCE.md`, issue/PR templates, and
  `CODEOWNERS`.
- Repository hygiene and quality tooling: EditorConfig, Git attributes, ESLint
  (flat config) + Prettier, Rust toolchain pin + `rustfmt`/`clippy` config,
  Vitest, and a continuous-integration workflow (`ci.yml`) that runs lint,
  type-check, and tests on Windows.

## [0.1.0] - 2026-06-19

Initial public baseline of Portcode — a fast, native Windows AI coding agent
(part of the Porthex toolset).

### Added

- Streaming agent loop over the Anthropic Messages API (bring-your-own-key).
- Seven workspace-sandboxed tools: `fs_read`, `list`, `glob`, `grep`
  (read-only) and `fs_write`, `fs_edit`, `shell` (mutating, gated).
- Permission gate (`allow` / `ask` / `deny`, with "always allow") enforced in
  the Rust core for all mutating tools.
- Persistent sessions backed by SQLite (WAL) with a history sidebar.
- Lazy, gitignore-aware file explorer; colorized unified diffs for edits;
  syntax-highlighted code blocks.
- Per-chat token and cost meter; command palette (`Ctrl+K`) and keyboard
  shortcuts.
- API keys stored in the Windows Credential Manager (never written to disk in
  plaintext).

[Unreleased]: https://github.com/porthex/portcode/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/porthex/portcode/releases/tag/v0.1.0
