# Portcode

A fast, native **AI coding agent for Windows** — part of the **Porthex** toolset.
Think Claude Code / Codex, but as a lean desktop app: a Rust core for speed and
reliability, a WebView2 UI for a rich coding surface.

> Status: Milestones 0–3 done; Milestone 4 (polish & ship) in progress.
> See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Features

- **Streaming agent loop** over the Anthropic Messages API (BYOK).
- **7 tools**, workspace-sandboxed: `fs_read`, `list`, `glob`, `grep` (read-only)
  and `fs_write`, `fs_edit`, `shell` (mutating, gated).
- **Permission gate** — `allow` / `ask` / `deny` (+ "always allow") for mutating
  tools, enforced in the Rust core.
- **Persistent sessions** — SQLite (WAL), survive restarts; history sidebar.
- **File explorer** — lazy, gitignore-aware tree; click a file to reference it.
- **Diff rendering** for edits (colorized unified diff) + syntax-highlighted
  code blocks.
- **Token + cost meter** per chat; **command palette** (Ctrl+K) and shortcuts.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+K` | Command palette |
| `Ctrl+N` | New chat |
| `Ctrl+B` | Toggle file explorer |
| `Ctrl+,` | Settings |
| `Enter` / `Shift+Enter` | Send / newline |

## Why this stack

Chosen for **reliability → speed → capability** (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)):

- **Tauri v2** shell — ~5–10 MB binary, uses the WebView2 already on Windows 11.
- **Rust + Tokio** core — no GC pauses, memory-safe agent loop, streaming, tools.
- **Anthropic API** (streaming) — Claude Opus 4.8 by default, provider-abstracted.
- **React + TypeScript + Vite + Tailwind** UI.
- **Windows Credential Manager** for API keys (never plaintext on disk).

## Prerequisites

- **Node** 18+ and **pnpm**
- **Rust** (stable, MSVC toolchain) — install via [rustup](https://rustup.rs)
- **VS 2022 Build Tools** with the *Desktop development with C++* workload
- **WebView2 runtime** (preinstalled on Windows 11)

## Develop

```bash
pnpm install

# UI only, in the browser (preview mode — uses a mock agent, no Rust needed):
pnpm dev            # http://localhost:1420

# Full native app (Rust core + window):
pnpm app:dev
```

In preview mode the UI is fully interactive and streams a mock reply, so you can
work on the frontend without the Rust toolchain. The native app talks to the real
agent core.

## Build a release / installer

```bash
pnpm app:build      # produces an NSIS installer under src-tauri/target/release/bundle
```

## First run

Open **Settings** (gear, bottom-left) → paste your Anthropic API key (stored in
Windows Credential Manager) → pick a model. Then describe a task in the composer.

## Layout

```
portcode/
├─ src/                # React + TS frontend
│  ├─ components/      # Chat, Sidebar, FileExplorer, Message, ToolCall,
│  │                   #   Composer, PermissionPrompt, CommandPalette, Settings
│  ├─ store/           # Zustand state
│  ├─ lib/ipc.ts       # Tauri bridge (+ browser mock)
│  └─ types.ts         # shared types mirroring the Rust models
├─ src-tauri/          # Rust core
│  └─ src/
│     ├─ lib.rs        # Tauri builder, commands, state
│     ├─ agent.rs      # the agent loop
│     ├─ llm.rs        # Anthropic streaming client + wire types
│     ├─ tools.rs      # tool trait + registry (7 tools)
│     ├─ permissions.rs# permission gate for mutating tools
│     ├─ db.rs         # SQLite session/message persistence
│     ├─ settings.rs   # settings persistence
│     └─ secrets.rs    # Credential Manager wrapper
└─ docs/               # ARCHITECTURE.md, ROADMAP.md, ***REMOVED***.md
```
