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

- A redesigned chat and agent workspace with live Markdown formatting, grouped
  project exploration, nested subagent activity, durable in-flight drafts, and
  a docked environment/Git summary.
- A first-class Git review workspace for inspecting changed files and diffs,
  tracking snapshot-safe inline comments, and handing review context to agents.
- A native repository-backed branch picker for Git review, plus the preserved
  cross-surface Repo Mode design for future desktop and remote work.
- Provider-aware settings, model and reasoning controls, included-plan usage,
  and an experimental direct ChatGPT subscription provider that is enabled for
  self-development but release-gated pending an approved production boundary.
- Multiple crash-safe ChatGPT subscription profiles with explicit per-session
  account pinning, isolated refresh/model/usage state, safe legacy migration,
  and reconnectable account tombstones that preserve conversation history.
- A release security baseline with structurally classified tool risk, public
  Phone Sync DTOs, adversarial boundary tests, and an executable acceptance
  matrix for subprocess, permission, sync, settings, and provider HTTP controls.
- Focused accessibility, cancellation, reconnect, large-transcript, and desktop
  smoke-test coverage for the new interaction paths.
- Open-source community-health and contributor infrastructure: `LICENSE`
  (Apache-2.0), `NOTICE`, `CLA.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, `SUPPORT.md`, `GOVERNANCE.md`, issue/PR templates, and
  `CODEOWNERS`.
- Repository hygiene and quality tooling: EditorConfig, Git attributes, ESLint
  (flat config) + Prettier, Rust toolchain pin + `rustfmt`/`clippy` config,
  Vitest, and a continuous-integration workflow (`ci.yml`) that runs lint,
  type-check, and tests on Windows.

### Changed

- Built-in tools now use provider-neutral canonical names (`read_file`,
  `list_directory`, `find_files`, `search_text`, `write_file`, `edit_file`,
  `run_command`, and `delegate_task`) while preserving legacy transcript and
  permission-rule aliases.
- Tool details are quieter and lazy by default, generated folders are hidden
  until requested, Settings is organized as a searchable control deck, and the
  sidebar toolbar stays bounded at narrow desktop widths.
- The status HUD now reports the active provider's most constrained included
  plan allowance, while Settings navigation remains pinned to the chosen route
  during smooth scrolling.
- Agent shells and native read-only Git now receive an exact-name, default-deny
  environment; shell output is memory-bounded; and credentialed provider clients
  reject cross-origin redirects and status errors without reading response bodies.

### Fixed

- Markdown now formats during streaming, active exploration uses present-tense
  wording, interrupted tools or agents no longer remain visibly running, and a
  stopped turn can no longer duplicate cached user messages during hydration.
- Hardened run cancellation, credential refresh, permission-rule ordering,
  session model persistence, remote teardown, and workspace Git inspection.
- Aligned remote push-registration protocol handling and hardened partial-turn
  cancellation, secret scrubbing, file-edit previews, telemetry consent,
  pairing/reconnect controls, and remote-client lifecycle cleanup.
- Auto and legacy defaults cannot implicitly approve protected shell actions;
  Bypass now skips every prompt as advertised, while explicit desktop “Always
  allow” choices persist scoped rules and take effect during the current task.
  Pre-commit settings failures preserve the live policy while post-commit
  durability uncertainty is reconciled explicitly; and Phone Sync no longer
  forwards raw desktop tool payloads or account attribution.

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
