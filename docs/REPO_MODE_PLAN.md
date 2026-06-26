# Repo Mode — Plan

> Status: **Proposal / design**. Connect a GitHub account, open a repo as a persistent
> local workspace, and run the Portcode agent against it — "like Claude Code, but native,
> instant, structural, and private."
>
> This document synthesizes four design tracks (UX, backend/data-model, differentiation,
> security) against the current codebase and the competitive landscape. Per-track detail
> and a competitor matrix were produced separately; this is the load-bearing summary.

---

## 1. The wedge (why this wins)

Portcode is a **native desktop app**, so the repo is _already on the user's disk_. Every
cloud agent (Claude Code web, Jules, Codex, Devin, Cursor background agents) pays a
1–5 minute cold-start tax, re-clones every session, and uploads code to understand it.
Portcode does none of that. The product is built on three structural advantages a
cloud agent **cannot copy without ceasing to be a cloud agent**:

1. **Instant + persistent** — clone to local disk once; the workspace, the code graph, and
   the session history persist. Reopening is instant. No re-clone, no re-index, no setup.
2. **Structural understanding** — the committed `graphify` knowledge graph (god nodes,
   community detection, cross-file relationships) is a _third path_ between Cursor's
   embeddings (stale + uploaded) and Claude Code's pure agentic grep (slow on big repos):
   local, structured, free, always-fresh.
3. **Private + portable** — local-first secrets vault, code never leaves the device,
   offline-capable, and **device-to-device P2P sync over iroh** (no competitor has
   multi-device workspace sync without a vendor cloud in the middle).

**One-sentence positioning:** _Repo Mode opens your repo instantly, shows you exactly which
parts of the codebase a task will touch — as a map — before it runs, and keeps your code
and secrets on your machine, following you across your own devices._

---

## 2. Where the codebase stands today (grounding)

Repo Mode builds on real assets and fills real gaps. Key files:

| Area        | Today                                                                                                                                                                          | Gap for Repo Mode                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Auth        | `oauth.rs` — loopback PKCE S256, **Anthropic only**                                                                                                                            | No GitHub auth (greenfield)                                                    |
| Secrets     | `secrets.rs` — OS-keychain vault, 4 accounts                                                                                                                                   | Add a `github` account (5th)                                                   |
| Persistence | `db.rs` — SQLite, WAL, append-only message log; `sessions.workspace` is a nullable path; `migrate_add_confirmed` is the additive-migration idiom                               | No `workspaces` table; no repo metadata                                        |
| FS tools    | `tools.rs` — `fs_read/write/edit/glob/grep`, sandboxed via `resolve_for_write`/`resolve_existing` with canonicalization (`:88-180`)                                            | No git tools; sandbox must rebind to repo root                                 |
| Shell       | `tools.rs:541-645` — `current_dir` set, **inherits full env**, 120s timeout                                                                                                    | No env scrub (token-leak risk); no OS confinement                              |
| Agent loop  | `agent.rs` — system prompt at `:57-77`, workspace resolution `:255-268`, dispatch `:369-405`, token refresh `:108-156`                                                         | No repo-context injection                                                      |
| Permissions | `permissions.rs` — single global `allow/deny/ask`; gate only on `mutating()` tools                                                                                             | No per-action risk tiers                                                       |
| Sync        | `sync/` — iroh QUIC + Noise XX/KK, SAS-confirmed pairing, `messages_since` log replication; **`emit_event` mirrors every `StreamEvent` (incl. tool output) to a paired phone** | No workspace frames; tool output is a token-exfil channel that needs redaction |
| Git         | **None anywhere** (no `git2`, no shelling to `git`)                                                                                                                            | Entire git engine is greenfield                                                |

**Back-compat is free:** every schema change is additive (new tables + a nullable
`sessions.workspace_id` FK). Path-based sessions keep working untouched; users who never
connect GitHub see no behavior change.

---

## 3. User experience (the flows)

**Design principle: from click to first agent action in under 10 seconds, and no "environment" concept.**

1. **Connect GitHub** — a single-purpose connect screen ("Your code stays local"). One click
   opens the system browser; on authorize, control lands back in the app automatically.
2. **Repo picker** — owner/org switcher (personal + every org the App is installed on),
   searchable + paginated list (server search falls through for large accounts), sorted by
   recently-pushed, with visibility/language/last-push per row. "Recent" comes from the
   local DB. No-repos / no-org / too-large / no-match all handled.
3. **Open** — a compact confirmation (branch dropdown defaulting to the repo default;
   managed clone location `…/Portcode/<owner>/<repo>`, editable; an optional collapsed
   "Setup commands" toggle). Not a multi-field form.
4. **The clone+index moment (signature)** — the workspace shell appears _immediately_ in a
   "warming up" state. Three streamed stages: **Clone** (real byte/object progress) →
   **Index** (graphify building the graph, AST-only, zero cost) → **Ready**. The user can
   browse files and even start typing a task _the instant clone finishes_ — they don't wait
   for indexing. "Cloned (1.8s)" markets directly against cloud cold starts.
5. **Working surface** — three zones: file tree (rooted at the sandbox = source of truth),
   agent/chat panel, and a **context rail** showing the repo's vital signs (branch, dirty
   count, ahead/behind, recent commits, a graph mini-map, sync status). Composer has a
   **Plan-first** (default) vs **Auto** toggle.
6. **Plan-first with graph impact (signature)** — before any edit, the agent shows the plan
   _against the code graph_: which modules/communities it will touch and the downstream
   blast radius, highlighted on the mini-map. Approve / scope-down / reject. No competitor
   can render structural impact because none has a persistent graph.
7. **Workspace management** — **workspaces are the top-level noun**, not a flat session log.
   Sessions are auto-titled, auto-summarized, and auto-archived (e.g. 14d idle + clean or
   PR merged). Directly fixes Claude Code's cluttered-list complaint. Per-workspace settings
   (`.portcode/workspace.json` or DB) override global.
8. **Branch / PR workflow** — lazy `portcode/<slug>` branch on first commit; one
   Review → Commit → Push → Open-PR surface with agent-drafted messages, native per-hunk
   diff, inline CI status, and "ask the agent to fix" on a failing check.
9. **Multi-device** — a workspace started on Desktop appears on another device as
   "synced · not cloned here → Clone here to continue." Device B re-clones from GitHub
   (fast, native) and fast-forwards to the synced commit SHA; session history is already
   present. **Working tree is never synced; metadata + sessions are.**

---

## 4. Backend architecture

### 4.1 GitHub integration

- **App type: GitHub App** (per-repo install scope, short-lived refreshable tokens, higher
  rate limits, clean attribution) over an OAuth App.
- **Auth flow — DECISION NEEDED (see §8):** the team split between **loopback PKCE** (reuse
  `oauth.rs` machinery verbatim, best UX) and **Device Flow** (needs only a public
  `client_id`, so _no client secret ships in the desktop binary_). Recommendation:
  **loopback PKCE if the App's token exchange can be done without embedding a secret;
  otherwise Device Flow.** This hinges on the GitHub App registration details (§8 Q1).
- **New `github_auth.rs`** (parallel to `oauth.rs`, sharing extracted PKCE helpers) and a
  thin **`github.rs`** REST/GraphQL client (`reqwest`) for: list installations, list repos,
  list branches, get repo (default branch/clone URL), create PR, get user. Tokens are read
  **only** by `github.rs` and the git credential callback — never returned in data structs.
- **Token storage:** a new `github-oauth` account in `secrets.rs`, mirroring `OAuthTokens`
  exactly (access + refresh + `expires_at`), with single-flight refresh modeled on
  `agent.rs:108-156`.

### 4.2 Git engine — **bundled `git2` (libgit2)**

- **Chosen** over shelling to system `git` (can't assume `git.exe` on a clean Windows box;
  brittle porcelain parsing; credential-helper leaks) and over `gix`/gitoxide (push/auth
  not yet mature). Build with `vendored-libgit2` + Windows **Schannel** transport (no
  OpenSSL dependency). Per `CLAUDE.md`, the crate is too heavy for low-RAM dev machines —
  **verify git via CI**, not local builds.
- **New `git.rs`** scoped to `workspace.local_path`: `clone` (with `transfer_progress` →
  Tauri events), `status`, `diff` (reuse `unified_diff`), `log`, `current_branch`,
  `create_branch`, `checkout`, `add`, `commit`, `push`, `fetch`, `pull`, `detect_conflicts`.
- **Auth without exposure:** token supplied via libgit2 `RemoteCallbacks::credentials`
  (`x-access-token:<token>`), read from the vault at call time, **never** written into the
  remote URL or `.git/config`, never an env var.

### 4.3 Data model (additive)

```sql
CREATE TABLE workspaces (
  id, name, kind ('repo'|'path'), local_path, remote_url, provider, owner, repo,
  default_branch, current_branch, graph_path, last_indexed_at, last_synced_sha,
  github_install_id, created_at, updated_at);
CREATE TABLE workspace_settings (workspace_id FK, key, value, PRIMARY KEY(workspace_id,key));
ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);  -- probe-and-add
```

Working-dir resolution becomes: `workspace_id → workspaces.local_path`, else legacy
`sessions.workspace` path, else global `Settings.workspace`, else `current_dir()`.

### 4.4 Agent integration

- **Git tools** added to `default_registry()`: `git_status`/`git_diff`/`git_log` (read,
  auto), `git_branch`/`git_commit` (mutating, gated). **`git_push` is a user-driven Tauri
  command in v1, not an autonomous agent tool.** All path args route through the existing
  `resolve_existing`/`resolve_for_write` guards — git gets no sandbox exemption.
- **Repo-context injection** at `agent.rs:57-77`: a tight (<~400 token), capped, _lazy_
  block — branch, dirty summary, top-5 commits (recomputed per turn), plus a _cached_
  graphify summary read from disk. Repo content is framed as **untrusted data, not
  instructions**.
- **Graphify:** built after clone as a background task (AST-only, no API cost), stored
  per-workspace **outside the clone** (e.g. `<app_config>/graphs/<workspace_id>/`) so it
  never dirties git or gets committed; incremental `graphify update` after commits.

### 4.5 IPC surface (`lib.rs` → `src/lib/ipc.ts`)

`github_device_login`/`github_status`/`github_logout`, `list_user_repos`,
`list_repo_branches`, `clone_repo` (streams progress on `repo://{id}`), `list_workspaces`,
`delete_workspace`, `set_session_workspace`, `git_summary`, `git_create_pr`, `git_push`.
`create_session` gains an optional `workspaceId`.

### 4.6 Sync

Sync **metadata + sessions (+ optionally a compact graph summary)**, **never** the working
tree or tokens. New additive `WorkspaceList`/`WorkspaceUpsert` frames in `sync/protocol.rs`
carry a tokenless `WorkspaceRow` (its `local_path` is advisory — each device keeps its own).
Conflict model: append-only session log is already conflict-free; workspace metadata is
last-writer-wins on `updated_at`; the working tree is owned per-device and collaboration
happens through GitHub (push/PR), not iroh. A soft active-device lock prevents two agents
pushing the same branch.

---

## 5. Differentiating features (ranked)

| #   | Feature                                                                                        | Tier               | Effort | Leans on                   |
| --- | ---------------------------------------------------------------------------------------------- | ------------------ | ------ | -------------------------- |
| 1   | **Warm Workspaces** — instant clone + persistent index, instant reopen                         | Launch             | M      | FS, graphify, SQLite       |
| 2   | **Graph-Native Agent** — graphify _is_ the retrieval layer (callers/callees, not top-k chunks) | Launch             | M      | graphify, agent loop       |
| 3   | **Visual Plan Approval** — approve a _map_ of the blast radius before edits                    | Launch             | M-L    | graphify impact, native UI |
| 4   | **Vault secrets + privacy/offline** — secrets the agent uses but the model never sees          | Launch             | M      | secrets vault, agent loop  |
| 6   | **Native Review Cockpit** — desktop diff + branch/PR, graph-annotated hunks                    | Launch (core)      | M      | native UI, git, graphify   |
| 5   | **P2P Workspace Sync** — start on desktop, finish on laptop; no vendor cloud                   | Fast-follow        | L      | iroh, SQLite               |
| 7   | **Smart lifecycle** — auto-summary, auto-archive, semantic+structural search                   | Fast-follow        | S-M    | SQLite, native UI          |
| 8   | **Parallel local agents on worktrees** — free, instant, no cloud quota                         | Fast-follow        | M      | git worktrees, agent loop  |
| 9   | **Multi-repo / monorepo graph** — one graph, topologically-aware cross-repo changes            | Fast-follow (v1.x) | L      | graphify, git              |

**Launch package = 1 + 2 + 3 + 4 + 6**: _instant, structural, private, reviewable_ — one
coherent story, each piece leaning on an asset cloud competitors structurally lack.

**Anti-features / scope traps (do NOT build in v1):** a hosted cloud backend (concedes the
moat); vector embeddings "to be safe" (reintroduces staleness + upload); a full IDE;
multi-user real-time collab (P2P _device_ sync is the differentiator, not CRDT collab);
every VCS + CI at launch (GitHub + one more proves "not GitHub-only"); a standalone
graph-viz toy; an agent marketplace; auto-merge / fully autonomous PR shipping (keep the
human at the plan-approval gate).

---

## 6. Security (threat-model-driven)

An autonomous agent with a token + git + shell on the user's **real machine** (no container)
makes sandboxing _more_ important, not less. Three load-bearing facts drive the work:
`shell` inherits the full env; the permission gate is binary+global; the sync hub forwards
raw tool output to the phone.

**Must-fix before launch:**

- **M1** Rebind sandbox base to canonical `repo_root`; route all git/shell paths through the
  existing resolvers.
- **M2** Reads outside root: **refuse, not gate** (fix the non-mutating bypass at
  `agent.rs:383-385`).
- **M3** **`shell` env scrub** (`.env_clear()` + curated allowlist) so no secret is ever
  shell-readable.
- **M4** Token via **credential helper / libgit2 callback** — never in URL, `.git/config`,
  or env; clone/push run as a Portcode-spawned env-scrubbed child, not via the agent's shell.
- **M5** **Redactor at `emit_event` before `hub.publish`** (masks `ghp_`/`gho_`/`github_pat_`
  etc.) — covers UI, logs, and the phone-sync exfil path.
- **M6** **Push restricted to the agent branch**; default-branch and force-push **refused**.
- **M7** **Per-action risk tiers**: `shell`, `git_push`, dependency-install are **always-ask**
  and bypass the `allow` fast-path.
- **M8** **Neutralize cloned-repo git hooks** (`core.hooksPath` → empty) + **block writes to
  `.git/**`\*\*.
- **M9** **Secret-scan gate on `git_commit`** + staging denylist (`.env*`, `*.pem`, `id_*`…).
- **M10** **Installs off by default / always-ask**, `--ignore-scripts` where possible
  (postinstall scripts are the #1 real-world supply-chain vector).
- **M11** Reject **NTFS ADS / `\\?\` / UNC / reserved-name** paths in the resolver.
- **M12** **No destructive git tools** exposed at launch (`reset --hard`, `clean -fdx`, …).
- **M13** Verify **remote (phone) sessions inherit the same gate + branch limits**; push/PR
  approval is desktop-only.

**Hardening-later:** Windows Job Object + restricted/low-integrity token for shell/git/
install; GitHub App installation tokens (short-lived, per-repo) replacing PATs;
network-egress allowlist; shell command pre-screen; compile-time assertion that no
`SyncFrame` can carry a credential.

**Prompt-injection stance:** assume injection _succeeds_. Privilege is enforced by the gate,
not the model — a fully co-opted agent still cannot push to main, read outside root, exfil
the token, or run an install without explicit human approval. Containment, not detection.

---

## 7. Phased build order

- **Phase 1 — Auth + read-only GitHub (no disk writes).** `secrets.rs` github account →
  `github_auth.rs` → `github.rs` (list repos/branches/user) → connect screen + repo picker.
- **Phase 2 — Git engine + clone + workspace model.** `git2` (vendored, Schannel); `git.rs`
  clone/status/log/branch; `workspaces` tables + `sessions.workspace_id` migration;
  `clone_repo` with progress; workspace switcher; graphify build-on-clone.
- **Phase 3 — Agent integration.** Repo-context injection (lazy, capped, untrusted-framed);
  read-only git tools; graph summary caching + incremental update; security M1–M3, M8, M11.
- **Phase 4 — Write path.** `git.rs` commit/push (credential callback, branch-restricted);
  gated `git_commit`/`git_branch` tools; `git_create_pr`; native diff/review; security
  M4, M6, M7, M9, M10, M12; per-action risk tiers in `permissions.rs`.
- **Phase 5 — Multi-device sync.** `WorkspaceList`/`WorkspaceUpsert` frames; "Clone here"
  flow (re-clone + fast-forward + graph rebuild); active-device soft lock; redactor M5; M13.

**Testing gates (per `CLAUDE.md`):** new `src/` code ships with matching `*.test.ts(x)` and
must pass `pnpm test:coverage` before a PR (the post-merge `main` Coverage job is gated).
Rust is verified via CI (`cargo test`), not local builds — especially important once
libgit2 raises build cost.

---

## 8. Decisions needed before build

1. **GitHub App provisioning & auth flow (biggest):** who owns the App registration, is
   token-expiry enabled, and can the token exchange be done **without** embedding a client
   secret in the desktop binary? This picks loopback-PKCE vs Device Flow and confirms the
   refresh design.
2. **PAT vs GitHub App installation tokens at launch** — materially changes the token-leak
   blast radius (per-repo + 1h vs broad). Recommendation: App installation tokens.
3. **Clone storage & quota** — managed dir location, disk-pressure / eviction policy for
   many large clones, and whether blobless/partial clone is the default for huge repos.
4. **Graphify availability in shipped builds** — is the CLI guaranteed present, or is graph
   context strictly best-effort? (Spec currently treats it as optional/degrade-gracefully.)
5. **Workspace = repo root vs subdirectory/monorepo** — affects sandbox base and graph scope;
   submodules/LFS deferred from v1.
6. **`allow` policy in Repo Mode** — should a token-bearing repo session even allow the
   global `allow` policy, or force an `ask`-floor for all writes? Recommendation: `ask`-floor.

---

_Companion design tracks (UX, backend, differentiation, security) and the competitor matrix
were produced as part of this effort and can be expanded into standalone docs on request._
