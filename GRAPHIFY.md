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
- `.claude/skills/` — graphify's own vendored skill and reference docs. These describe how to
  _drive_ graphify; they are tooling/meta, not Portcode product knowledge, so keeping them out
  leaves the graph focused on the app's own architecture. (`.claude/settings.json` is **not**
  matched, so the project's hook config still participates in the graph.)
- `GRAPHIFY_NOTES.md` — the transient graphify research write-up, not part of the documented
  architecture.

## Repo config edits

- **`.gitignore`** — ignores graphify's local / machine-specific output: the interpreter and
  scan-root pointers (`.graphify_python`, `.graphify_root`), all `.graphify_*.json` working files,
  the `.needs_update` flag, `cost.json`, `cache/`, `memory/`, and the dated backup directories
  `graphify update` snapshots before each rebuild (`graphify-out/YYYY-MM-DD/`). The shareable graph
  (`graph.json`, `graph.html`, `GRAPH_REPORT.md`, `manifest.json`) stays committable per graphify's
  team workflow. To skip versioning the graph entirely, replace the block with a single
  `graphify-out/` line.
- **`.gitattributes`** — marks `graphify-out/graph.json` and `graph.html` as
  `linguist-generated -diff` (mirrors the existing `pnpm-lock.yaml` / `src-tauri/gen` rules).
- **`.prettierignore`** — excludes the root `CLAUDE.md` (which `graphify install` regenerates), the
  whole machine-generated `graphify-out/` tree, and `GRAPHIFY_NOTES.md`, so neither a graphify
  upgrade nor a graph rebuild can break `pnpm format:check`. (Matches the existing `.claude/`
  exclusion.)
- **`eslint.config.js`** — adds `graphify-out/**` to the flat-config `ignores` so the generated
  graph artifacts are never linted as source.

## What was deliberately not added

- **No GitHub Actions workflow.** Graphify's official setup requires no consumer CI; its own
  `release-graph.yml` is internal release automation, not a template. Auto-rebuild is the local,
  per-developer `graphify hook install` (a git post-commit hook, which is not committable).
  Whether and when to rebuild in CI — and any key that would require — is left as a project
  decision.
- **No `package.json` / `Cargo.toml` dependency.** Graphify is a Python CLI, not an npm/npx package
  or a crate, so it does not belong in a manifest. It is installed globally per developer and
  invoked on demand (directly, or via the `/graphify` skill).

## Implement once, grow forever

The graph is **built once** and then **grows incrementally and idempotently** — you never re-run
the full build. Two layers, two refresh paths:

- **Code + structure layer (deterministic, no API key).** Every commit, run:

  ```bash
  graphify update .
  ```

  This re-extracts changed code/markdown with tree-sitter, merges the result into the existing
  `graph.json`, and rewrites `graph.html` + `GRAPH_REPORT.md`. Install it as an automatic
  post-commit hook once per machine with `graphify hook install` (also wires a union **merge
  driver** so parallel branches/worktrees never leave conflict markers in `graph.json`).

- **Semantic doc + community-naming layer (needs the IDE model or one API key).** When the prose
  docs change, run `/graphify --update` inside Claude Code (free, uses the session model) — or
  headless `graphify extract . && graphify cluster-only .` with a backend key. `graphify update .`
  alone keeps the existing doc/semantic nodes but renders communities as `Community N` until this
  pass re-runs (graphify can't name clusters without a model).

**What guarantees idempotent growth** (so re-running never duplicates and never churns):

1. **Deterministic node IDs** — every entity's ID is derived purely from its location + name
   (`{parent_dir}_{file}_{symbol}`, lowercased, no chunk suffixes), so the same entity always
   produces the same ID and re-ingesting is a no-op via dedupe-by-ID.
2. **Content-hash cache** — `graphify-out/cache/` keys extraction on a SHA-256 of each file, so
   unchanged files are skipped on every re-run (the semantic LLM layer is paid for once).
3. **Prune-and-merge** — `graphify update` removes only the changed/deleted files' nodes and merges
   fresh ones into the existing graph (edge direction preserved); it never rebuilds from scratch.
4. **No-op guard** — with nothing changed, `update` prints _"No code-graph topology changes
   detected; outputs left untouched"_ and rewrites nothing.

### Proven on this repo (initial build + grow-forever evidence)

- **Initial build (`implement once`).** In-IDE pipeline over the repo (36 code/config files via
  tree-sitter, 0 API calls; 23 project docs named by the session model; images excluded) →
  canonical **`graph.json` = 620 nodes, 944 edges, 44 named communities**. Committed.
- **Idempotent.** `graphify update .` run twice with no source change produced a **byte-identical**
  graph (same node/edge counts, identical content hashes, **0 nodes/edges added or removed**); the
  second run reported _"No topology changes … outputs left untouched."_
- **Grows incrementally.** Adding one source file (`src/lib/_graph_probe.ts`) and re-running
  `graphify update .` grew the graph by **exactly +4 nodes and +4 edges** — the file node, its two
  functions + interface, three `contains` edges and the correctly-detected `probeWrap → probeAdd`
  `calls` edge — with **0 existing entries changed**. Removing the file and re-running pruned those
  4 nodes back out, returning to the **exact** baseline hash. (The probe was temporary and is not
  in the tree.)

## Reconciliation with the research notes

This setup was landed from the prior tooling commit `77ccf6c` and then reconciled toward
`GRAPHIFY_NOTES.md` / the global skill, with two deliberate divergences from `77ccf6c`, both noted
in-place above:

- **`.graphifyignore`** additionally excludes `.claude/skills/` and `GRAPHIFY_NOTES.md` so the
  graph stays focused on Portcode's architecture rather than graphify's own tool docs.
- **`.gitignore` / `.prettierignore` / `eslint.config.js`** were extended so the committed
  `graphify-out/` artifacts and graphify's local/working/backup files never trip the CI quality
  gates (`pnpm format:check`, `pnpm lint`).

## Verification status

- **Full build: passed, fully offline for code.** Canonical graph **620 nodes / 944 edges / 44
  communities**, code layer extracted with **0 API calls**; community + doc naming supplied by the
  in-IDE session model (no separate key).
- **Idempotency + incremental growth: verified** (see evidence above).
- **CI gates: green.** `pnpm format:check`, `pnpm lint`, and `pnpm typecheck` pass with the
  generated `graphify-out/` tree present (it is excluded from all three). The Rust gates are
  unaffected — no Rust files changed.
