# Graphify — code knowledge graph

[Graphify](https://github.com/safishamsi/graphify) turns this repository into a queryable
knowledge graph so humans and AI assistants can ask questions about the code instead of grepping
through files. This document explains how it is wired into Portcode and how to run it.

## What it is and what it produces

Graphify is a **Python CLI** (PyPI package `graphifyy`, command `graphify`) that doubles as a
`/graphify` skill for Claude Code and other AI assistants. It is **not** an npm/npx package, a
library you import, or a GitHub Action. Running it parses the repo locally with tree-sitter and
writes a `graphify-out/` directory containing:

- `graph.json` — the full GraphRAG-ready knowledge graph (nodes + edges).
- `graph.html` — an interactive viewer (click, filter, and search nodes).
- `GRAPH_REPORT.md` — plain-language highlights: "god nodes", surprising cross-file connections,
  and suggested questions.
- `manifest.json` — a portable file index (safe to commit).

The committed `/graphify` skill (`.claude/skills/graphify/`) plus the `CLAUDE.md` rules and the
`.claude/settings.json` hooks then steer assistants to query that graph before grepping.

## Prerequisites

- Python 3.10+ (this machine runs 3.14; graphify's optional Leiden clustering needs Python < 3.13
  and falls back automatically otherwise).
- The graphify CLI, installed once per developer:

  ```bash
  uv tool install graphifyy      # recommended; puts `graphify` on PATH
  # or: pipx install graphifyy
  ```

  The CLI is a global dev tool, not a project dependency — see
  [What was deliberately not added](#what-was-deliberately-not-added).

## Running it on this repo

From the repository root:

```bash
graphify .          # PowerShell or any terminal (no leading slash on Windows)
```

or, inside Claude Code:

```text
/graphify .
```

Output lands in `graphify-out/` at the repo root. Query the graph instead of grepping:

```bash
graphify query "what connects the Tauri commands to the React store?"
graphify path "App" "invoke"
graphify explain "useAppStore"
graphify update .   # refresh after code edits (AST-only, no API cost)
```

## Required secret / API key

**None is required for normal use on this repo.** Portcode is almost entirely code
(TypeScript/React + Rust), and code extraction runs 100% locally via tree-sitter — fully offline,
no key, ever. When you run `/graphify` inside Claude Code, the semantic pass for the few non-code
files (Markdown docs, images) is supplied by your IDE session's model, so still no separate key.

A key is only needed if you run graphify **headless** (the `graphify extract` command outside an
IDE, for example in CI) **and** want that non-code layer. In that case, set exactly one backend
key as a normal environment variable in that shell or runner:

| Provider         | Env var                                |
| ---------------- | -------------------------------------- |
| Anthropic Claude | `ANTHROPIC_API_KEY`                    |
| OpenAI           | `OPENAI_API_KEY`                       |
| Google Gemini    | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |

Set it locally for a session in PowerShell: `$env:ANTHROPIC_API_KEY = "sk-..."`.

There is **no GitHub Actions secret to configure today**, because no CI workflow was added (see
below). If you later add a workflow that runs `graphify extract` on docs or images, store the key
as a repository secret (Settings → Secrets and variables → Actions) named for the provider, e.g.
`ANTHROPIC_API_KEY`, and reference it from that workflow.

## `.graphifyignore`

Graphify already honors `.gitignore` automatically, so `.graphifyignore` only adds
project-specific noise on top:

- `pnpm-lock.yaml`, `src-tauri/Cargo.lock` — large generated lockfiles with no semantic value.
- `src-tauri/gen/` — generated Tauri output.
- `graphify-out/` — never graph graphify's own output.
- `*.png`, `*.ico`, `*.icns`, `*.webp` — binary icon assets (~40 of them); excluding them keeps
  extraction code-focused and fully offline. Delete these lines if you want images in the graph.

## Repo config edits

- **`.gitignore`** — ignores only graphify's local / machine-specific output
  (`graphify-out/.graphify_python`, `cost.json`, `cache/`, `memory/`). The shareable graph
  (`graph.json`, `graph.html`, `GRAPH_REPORT.md`, `manifest.json`) stays committable per
  graphify's team workflow. To skip versioning the graph entirely, replace the block with a single
  `graphify-out/` line.
- **`.gitattributes`** — marks `graphify-out/graph.json` and `graph.html` as
  `linguist-generated -diff` (mirrors the existing `pnpm-lock.yaml` / `src-tauri/gen` rules).
- **`.prettierignore`** — excludes the root `CLAUDE.md`, which `graphify install` regenerates, so a
  future upgrade cannot break `pnpm format:check`. (Matches the existing `.claude/` exclusion.)

## What was deliberately not added

- **No GitHub Actions workflow.** Graphify's official setup requires no consumer CI; its own
  `release-graph.yml` is internal release automation, not a template. Auto-rebuild is the local,
  per-developer `graphify hook install` (a git post-commit hook, which is not committable).
  Whether and when to rebuild in CI — and any key that would require — is left as a project
  decision.
- **No `package.json` / `Cargo.toml` dependency.** Graphify is a Python CLI, not an npm/npx package
  or a crate, so it does not belong in a manifest. It is installed globally per developer and
  invoked on demand (directly, or via the `/graphify` skill).

## Verification status

- **AST smoke test: passed.** `graphify extract` over the real `src/` (output written to a temp
  directory outside the repo) found 16 code files and produced a graph of **83 nodes, 190 edges,
  8 communities** with 0 API calls — fully offline.
- **`prettier --check .`: passed** with these changes ("All matched files use Prettier code
  style!"), matching the CI `format:check` gate.
