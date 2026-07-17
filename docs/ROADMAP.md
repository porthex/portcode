# Portcode — Roadmap

## Milestone 0 — Foundations ✅ done

- [x] Tech-stack decision (Tauri v2 + Rust + React)
- [x] Toolchain (Rust MSVC + VS Build Tools) installed
- [x] Project scaffold (frontend + `src-tauri`)
- [x] Frontend runs in Vite with a working chat shell (mocked core)
- [x] Rust core compiles; native window opens (~40 MB RAM)

## Milestone 1 — Talking agent ✅ done (live-key check pending)

- [x] Anthropic streaming provider in Rust (`llm.rs`, SSE)
- [x] Settings UI + API key stored in Credential Manager
- [x] Agent loop wired end-to-end (streams text + runs tools)
- [ ] Verify a live reply with a real API key (needs user key)
- [x] Session persistence (SQLite, WAL) + history sidebar (with delete)

## Milestone 2 — Tools ✅ done

- [x] Tool trait + registry, JSON schemas
- [x] `fs_read`, `list`, `glob`, `grep` (read-only)
- [x] `fs_write`, `fs_edit`, `shell` (gated, sandboxed to workspace)
- [x] Permission gate (allow / ask / deny + "always allow") — Rust gate + UI prompt
- [x] Tool-call + result rendering in chat

## Milestone 3 — IDE surface ✅ done

- [x] Workspace open (folder picker) + lazy file tree (gitignore-aware)
- [x] File click inserts path into the composer
- [x] Diff rendering for edits (colorized unified diff via `similar`)
- [x] Inline syntax highlighting in chat code blocks (rehype-highlight)

## Milestone 4 — Product foundation ✅ implemented

- [x] Cancellation / stop button
- [x] Token + cost meter (per chat, model-priced)
- [x] Keyboard shortcuts + command palette (Ctrl+K / N / B / ,)
- [x] Crash-safe history (SQLite WAL + atomic per-turn writes); full
      interrupted-run _auto-resume_ still TODO
- [x] NSIS installer via the Tauri bundler
- [x] Signed-update client, stable-channel endpoint, settings, progress UI, and relaunch flow
- [x] Apache-2.0 license + CLA

## Milestone 5 — Agent parity foundation ✅ implemented

- [x] Provider abstraction and deterministic provider test seams
- [x] Permission modes, rules, read-only plan mode, and pre-apply diffs
- [x] Bounded parallel subagents with lifecycle UI and cancellation
- [x] Background shell tasks with status and cancellation
- [x] Persisted drafts, cumulative usage, message search, and session rename

## Milestone 6 — Phone Sync foundation 🟡 implemented, acceptance pending

- [x] Shared native/WASM protocol, Noise transport, pairing, catch-up, and command framing
- [x] Android remote-client split, QR scanner integration, and remote UI
- [x] Browser/PWA remote client, WASM connector, durable pairing storage, and reconnect lifecycle
- [ ] Validate desktop ↔ Android on a physical device, including reconnect/background behavior
- [ ] Validate desktop ↔ installed iOS PWA on a physical device (the go/no-go lifecycle gate)

## Milestone 7 — Stabilize and release

- [ ] Add a deterministic full acceptance path: session → mocked turn → permission → tool → restart
- [ ] Run the signed Windows release workflow into a **draft** GitHub Release
- [ ] Verify installer, signature, SBOM/checksums, clean-machine launch, and prior-version update
- [ ] Publish only after the draft passes the release checklist
- [ ] Complete live Anthropic and Phone Sync owner-device checks

## Blocked on the user

- [ ] Verify a live agent reply with a real Anthropic API key
- [ ] Provision/confirm production signing credentials and approve the first draft release
- [ ] Perform physical Android and iOS lifecycle checks

Implementation checkmarks above mean the code and automated gates exist. They do **not** claim
that a signed public release or real-phone acceptance run has completed.
