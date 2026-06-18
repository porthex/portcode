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

## Milestone 4 — Polish & ship (mostly done)

- [x] Cancellation / stop button
- [x] Token + cost meter (per chat, model-priced)
- [x] Keyboard shortcuts + command palette (Ctrl+K / N / B / ,)
- [x] Crash-safe history (SQLite WAL + atomic per-turn writes); full
      interrupted-run _auto-resume_ still TODO
- [x] NSIS installer via Tauri bundler (`Portcode_0.1.0_x64-setup.exe`, 2.3 MB;
      release exe 6.0 MB, ~32 MB RAM)
- [ ] Auto-update channel — needs a release endpoint + signing keypair (user)

## Blocked on the user

- [ ] Verify a live agent reply with a real Anthropic API key
- [ ] Auto-update infrastructure (host + `tauri signer` keypair)
- [ ] Licensing decision (recommended: Apache-2.0 + CLA; see ***REMOVED***.md)
