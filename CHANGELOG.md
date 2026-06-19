# Changelog

All notable changes to Portcode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Version sync.** The release version lives in **three** files and they must
> match for every tagged release: `package.json`, `src-tauri/Cargo.toml`, and
> `src-tauri/tauri.conf.json`. See [`docs/RELEASE.md`](docs/RELEASE.md) (added in
> a later phase) for the bump procedure.

## [0.2.0](https://github.com/porthex/portcode/compare/v0.1.0...v0.2.0) (2026-06-19)


### Features

* build and test on Linux (CI matrix + AppImage/deb) ([#4](https://github.com/porthex/portcode/issues/4)) ([e0bccff](https://github.com/porthex/portcode/commit/e0bccffde0a28f301961abad3af0acfe52851756))


### Bug Fixes

* format files failing prettier format:check (CI unblock) ([#7](https://github.com/porthex/portcode/issues/7)) ([c72afae](https://github.com/porthex/portcode/commit/c72afae997bee14a442b75a443464c70960c83ca))


### Continuous Integration

* add release-please changelog automation + 3-file version sync ([#9](https://github.com/porthex/portcode/issues/9)) ([#5](https://github.com/porthex/portcode/issues/5)) ([40fb94e](https://github.com/porthex/portcode/commit/40fb94ee742567eef22ee6b71799441f51e32e11))


### Miscellaneous Chores

* **deps-dev:** Bump @types/react-dom from 18.3.7 to 19.2.3 ([#3](https://github.com/porthex/portcode/issues/3)) ([697359f](https://github.com/porthex/portcode/commit/697359f394f2f099fdce15f0f9d11c7ca66766df))
* **deps-dev:** Bump eslint from 9.39.4 to 10.5.0 ([#2](https://github.com/porthex/portcode/issues/2)) ([a2f653c](https://github.com/porthex/portcode/commit/a2f653c46c941621dc9c37f0a95e6f455bc2ad10))
* **deps-dev:** Bump vite from 6.4.3 to 8.0.16 ([#1](https://github.com/porthex/portcode/issues/1)) ([a8c02e3](https://github.com/porthex/portcode/commit/a8c02e3f1b8d194a5d8a99494511e52a37b767fd))
* enforce prettier via husky pre-commit + format repo ([#10](https://github.com/porthex/portcode/issues/10)) ([1c136a3](https://github.com/porthex/portcode/commit/1c136a340591d9510520a40e61c0e5ec1a56fc76))

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
