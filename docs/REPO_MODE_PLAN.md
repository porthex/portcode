# Repo Mode — Plan

> Status: **Proposal requiring re-grounding before implementation**. The current
> tree has moved beyond several assumptions in the original design. Priority and
> dependencies live in [`ROADMAP.md`](ROADMAP.md); this document preserves the
> product concept, security constraints, and decisions that still need owners.
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
2. **Structural understanding** — optional, Git-ignored local `graphify` output (god nodes,
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

| Area        | Today                                                                                                                     | Gap for Repo Mode                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Auth        | Anthropic and OpenAI OAuth paths use loopback PKCE S256                                                                   | No GitHub auth or product-approved GitHub App/token model                          |
| Secrets     | Provider credentials use the OS-keychain vault                                                                            | No least-privilege GitHub credential account or storage contract                   |
| Persistence | `db.rs` uses SQLite/WAL and sessions can carry a workspace path                                                           | No first-class workspace/repository model                                          |
| FS tools    | File tools are workspace-sandboxed and reject canonical paths outside the root                                            | No Repo Mode binding lifecycle or repository-metadata write policy                 |
| Shell       | Child processes use a reviewed default-deny environment, bounded output, and the workspace as `current_dir`               | No OS sandbox or Repo Mode-specific process/credential contract                    |
| Agent loop  | The agent resolves a workspace and dispatches tools                                                                       | No bounded, untrusted-framed repository context contract                           |
| Permissions | Persisted modes/rules exist; protected Shell actions have an unconditional per-call Ask floor                             | No typed high-risk Git/install actions or Repo Mode action policy                  |
| Sync        | Phone Sync uses redacted, byte-bounded public DTOs for live events and catch-up                                           | No workspace frames or repository-binding synchronization                          |
| Git         | A hardened read-only Git runner and Review Workspace expose status, manifests, patches, snapshots, and turn-scoped review | No clone/workspace lifecycle, GitHub auth, or guarded stage/commit/push/PR handoff |

Backwards compatibility is a design requirement, not an assumption. Any new
workspace schema and binding lifecycle must prove migration, downgrade, and
path-based-session behavior before implementation.

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
  list branches, get repo (default branch/clone URL), create PR, get user. User OAuth tokens
  are read **only** by `github.rs`; the git credential callback receives only a just-in-time
  installation token from the internal credential broker. Neither is returned in data
  structs.
- **Token storage:** `github-oauth` is the **user OAuth record only** (identity,
  installation discovery, access + refresh + `expires_at`), with single-flight refresh
  modeled on `agent.rs:108-156`. Repo-scoped GitHub App **installation tokens are a separate
  credential class**: mint one just in time for the selected installation, keep it in
  memory only for the operation, zero/drop it afterward, and never persist it in
  `github-oauth`, SQLite, logs, URLs, or `.git/config`.

### 4.2 Git engine — **bundled `git2` (libgit2)**

- **Chosen** over shelling to system `git` (can't assume `git.exe` on a clean Windows box;
  brittle porcelain parsing; credential-helper leaks) and over `gix`/gitoxide (push/auth
  not yet mature). Build with `vendored-libgit2` + Windows **Schannel** transport (no
  OpenSSL dependency). Per `CLAUDE.md`, the crate is too heavy for low-RAM dev machines —
  **verify git via CI**, not local builds.
- **New `git.rs`:** existing-repository operations are scoped to the canonical `local_path`
  from the current device's validated, `ready` `workspace_bindings` row. `clone` alone
  accepts a validated canonical target binding already in `cloning` state, emits
  `transfer_progress` Tauri events, and transitions it to `ready` only after success (or
  `failed` on error). Other operations are `status`, `diff` (reuse `unified_diff`), `log`,
  `current_branch`, `create_branch`, `checkout`, `add`, `commit`, `push`, `fetch`,
  `fast_forward_if_clean`, and `detect_conflicts`. There is no implicit pull/rebase
  operation.
- **Auth without exposure:** the just-in-time installation token is supplied via libgit2
  `RemoteCallbacks::credentials` (`x-access-token:<token>`), **never** written into the
  remote URL or `.git/config`, never an env var.
- **Audited `.git` mutation boundary:** generic FS tools and `shell` are unconditionally
  blocked from writing `.git/**`. Only the internal libgit2 adapter may mutate Git metadata,
  through an explicit operation allowlist: clone/init metadata, fetch, clean fast-forward,
  checkout, create branch, stage, commit, push, and the one-time `core.hooksPath`
  neutralization. Every allowlisted entry point validates the canonical workspace binding
  and records an audit event; adding another `.git` writer requires a security review and a
  named allowlist case.

### 4.3 Data model (additive)

```sql
CREATE TABLE workspaces (
  id, name, kind ('repo'|'path'), remote_url, provider, owner, repo,
  default_branch, current_branch, graph_path, last_indexed_at, last_synced_sha,
  github_install_id, created_at, updated_at);
CREATE TABLE workspace_settings (workspace_id FK, key, value, PRIMARY KEY(workspace_id,key));
CREATE TABLE workspace_bindings (
  workspace_id FK, device_id, local_path, clone_state, checked_out_sha,
  updated_at, PRIMARY KEY(workspace_id,device_id));
ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);  -- probe-and-add
```

`workspace_bindings` is device-local and is never replicated with another device's path.
Its `clone_state` is an explicit state machine (`not_cloned` → `cloning` → `ready` or
`failed`), not a hint inferred from path existence. For a session with `workspace_id`,
working-dir resolution is strictly `(workspace_id, this_device_id) → ready binding →
canonical local_path`; a missing, non-ready, mismatched, or non-canonical binding is a hard
error and **must not fall back** to `sessions.workspace`, global settings, or `current_dir()`.
Those fallbacks remain only for legacy sessions that have no `workspace_id`.

### 4.4 Agent integration

- **Git tools** added to `default_registry()`: `git_status`/`git_diff`/`git_log` (read,
  auto), `git_branch`/`git_commit` (mutating, gated). **`git_push` is a user-driven Tauri
  command in v1, not an autonomous agent tool.** All caller-supplied path args route through
  the existing `resolve_existing`/`resolve_for_write` guards. The internal adapter's named
  Git-metadata operations are the only `.git/**` exception; they do not grant agent FS or
  shell tools any sandbox exemption.
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

Sync **metadata + sessions (+ optionally a compact graph summary)**, but the protocol schema
has no fields for the working tree, device-local bindings, or credentials. New additive
`WorkspaceList`/`WorkspaceUpsert` frames in `sync/protocol.rs` carry a credential-free
`WorkspaceRow`; each device advertises only `clone_state`/availability and resolves its own
`workspace_bindings` row locally. The no-credential release claim remains contingent on the
M5 negative tests in §6 and §8.2. Conflict
model: append-only session log is already conflict-free; workspace metadata is
last-writer-wins on `updated_at`; the working tree is owned per-device and collaboration
happens through GitHub (push/PR), not iroh.

Branch mutation uses an **expiring owner lease**, not a soft presence lock. The lease carries
`owner_device_id`, `lease_expires_at`, and a monotonically increasing `fencing_token`.
Commit/push entry points require an unexpired lease and the current fencing token; renewal
or takeover increments the token, so a stale owner is rejected even if it reconnects. Each
local mutation checks the lease and token atomically in SQLite; the synchronized lease record
uses `(fencing_token, owner_device_id)` ordering to converge. Because P2P peers can partition,
GitHub remains the final cross-device arbiter: a push fetches immediately beforehand and
supplies the expected remote-head OID to a compare-and-swap/lease-protected ref update. If
the actual remote head differs, the push hard-fails and requires fetch/review/replan rather
than rebasing or forcing implicitly.

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
- **M4** Installation token via the internal **libgit2 credential callback only** — never in
  URL, `.git/config`, env, a generic credential helper, or the agent's shell. Clone/push are
  internal allowlisted libgit2 operations, not child-process or shell operations.
- **M5** **Default-deny sync projection:** raw tool output is never a sync-frame source.
  `emit_event` maps only an explicit source allowlist into bounded structured fields,
  scrubs each allowed field at construction, and applies a final credential redactor before
  `hub.publish` (including `ghp_`/`gho_`/`github_pat_` patterns). Unit, property/fuzz, and
  desktop-to-remote integration tests with canary secrets must prove the invariant before
  release; the final redactor is defense in depth, not permission to mirror arbitrary text.
- **M6** **Push restricted to the agent branch**; default-branch and force-push **refused**.
- **M7** **Per-action risk tiers**: `shell`, `git_push`, dependency-install are **always-ask**
  and bypass the `allow` fast-path.
- **M8** **Neutralize cloned-repo git hooks** (`core.hooksPath` → empty) + block generic
  FS/shell writes to `.git/**`; only the audited libgit2 operation allowlist in §4.2 may
  write Git metadata.
- **M9** **Secret-scan gate on `git_commit`** + staging denylist (`.env*`, `*.pem`, `id_*`…).
- **M10** **Installs off by default / always-ask**, `--ignore-scripts` where possible
  (postinstall scripts are the #1 real-world supply-chain vector).
- **M11** Reject **NTFS ADS / `\\?\` / UNC / reserved-name** paths in the resolver.
- **M12** **No destructive git tools** exposed at launch (`reset --hard`, `clean -fdx`, …).
- **M13** Verify **remote (phone) sessions inherit the same gate + branch limits**; push/PR
  approval is desktop-only.

**Hardening-later:** Windows Job Object + restricted/low-integrity token for shell/git/
install; narrower GitHub App permissions and shorter installation-token lifetimes;
network-egress allowlist; shell command pre-screen; compile-time assertion that no
`SyncFrame` can carry a credential.

**Prompt-injection stance:** assume injection _succeeds_. Privilege is enforced by the gate,
not the model. Only after M3–M5 and M13 enforcement plus their negative/canary integration
tests pass may we claim that a fully co-opted agent cannot push to main, read outside root,
exfiltrate a credential, or run an install without explicit human approval. Token-bearing
Repo Mode and remote event mirroring remain disabled until that evidence exists.
Containment, not detection.

---

## 7. Phased build order

> **Do not execute this phase order yet.** First complete the roadmap's Repo Mode
> re-grounding item: reuse the existing read-only Git/Review and release-security
> boundaries, resolve the GitHub credential model, and turn every Phase 0 control
> into an executable test. The sequence below is a dependency sketch, not an
> approved delivery schedule.

- **Phase 0 — Safety bootstrap (blocks all workspace execution).** Land and test **M1, M2,
  and M8 first**: canonical repo-root binding, unconditional outside-root read refusal, and
  the generic `.git/**` write block plus audited libgit2 allowlist/hook neutralization. Clone,
  checkout, and every workspace-bound agent action hard-fail behind this bootstrap until all
  three controls are implemented; no later phase may provide a compatibility fallback around
  it. Clone itself is metadata-first/no-checkout: it applies the empty hooks path before the
  first checkout, so repository hooks never execute during workspace creation.
- **Phase 1 — Auth + read-only GitHub (no disk writes).** `secrets.rs` github account →
  `github_auth.rs` → `github.rs` (list repos/branches/user) → connect screen + repo picker.
- **Phase 2 — Clone + workspace model.** Extend the existing hardened Git boundary;
  decide explicitly whether any libgit2 dependency is justified instead of creating a
  second Git architecture. Add clone/status/log/branch support, `workspaces` tables +
  `sessions.workspace_id` migration;
  per-device `workspace_bindings` state; `clone_repo` with progress; workspace switcher;
  graphify build-on-clone. This phase cannot clone or checkout until Phase 0's controls pass.
- **Phase 3 — Agent integration.** Repo-context injection (lazy, capped, untrusted-framed);
  read-only git tools; graph summary caching + incremental update; security M3 and M11.
  Workspace-bound agent actions remain disabled unless the current device has a canonical,
  `ready` binding and the Phase 0 controls are active.
- **Phase 4 — Write path.** `git.rs` commit/push (credential callback, branch-restricted);
  gated `git_commit`/`git_branch` tools; `git_create_pr`; native diff/review; security
  M4, M6, M7, M9, M10, M12; per-action risk tiers in `permissions.rs`.
- **Phase 5 — Multi-device sync.** `WorkspaceList`/`WorkspaceUpsert` frames; "Clone here"
  flow (re-clone + fast-forward + graph rebuild); fenced expiring owner lease + expected
  remote-head validation; default-deny sync projection/redactor M5; M13.

**Testing gates (per `CLAUDE.md`):** new `src/` code ships with matching `*.test.ts(x)` and
must pass `pnpm test:coverage` before a PR (the post-merge `main` Coverage job is gated).
Rust is verified via CI (`cargo test`), not local builds — especially important once
libgit2 raises build cost.

---

## 8. Repo Mode across all apps (one engine, many surfaces)

Portcode is already **one brain, many remote surfaces**. The desktop (Tauri) runs the agent,
tools, `shell`, secrets, and the sync **server**; the **Android app** (`docs/ANDROID_APP_PLAN.md`)
and the **iOS/web PWA** (`docs/IOS_WEB_CLIENT_PLAN.md`) are **remote clients** over the
encrypted iroh + Noise channel — _"the phone is a remote control surface, the desktop stays
the brain."_ Both remotes share one Rust crate, `portcode-sync` (the planned workspace
extraction), and the existing `remoteMode` shell / `applyFrame` reducer / `RemoteCommand` +
`SyncFrame` protocol.

**Repo Mode inherits this model unchanged.** Its engine — libgit2 clone, the sandboxed FS
tools, the user OAuth record in the OS keychain, ephemeral push-capable installation tokens
in desktop memory, graphify indexing, git ops — is
**desktop-only for the same reason `agent`/`tools`/`shell` are already `#[cfg(not(mobile))]`:**
a phone has no workspace, no shell, and nowhere safe to hold a push-capable token; a browser
has no filesystem at all. So:

> **Repo Mode = a desktop engine + Repo-Mode-aware remote surfaces.** No surface clones
> in-browser or on-phone. The remotes _drive and review_ a workspace hosted on a paired,
> running desktop. There is no cloud host (that's the §5 anti-feature).

### 8.1 Capability matrix

| Capability                     | Desktop (engine)                                   | Android (remote)                        | iOS / Web PWA (remote)             |
| ------------------------------ | -------------------------------------------------- | --------------------------------------- | ---------------------------------- |
| Connect GitHub / credentials   | ✅ OAuth in keychain; installation token in memory | initiate only; no credential frame      | initiate only; no credential frame |
| Repo picker → clone → index    | ✅ executes locally                                | request + watch progress                | request + watch progress           |
| Run agent task                 | ✅                                                 | mirror + send `Run`/`Cancel`            | mirror + send `Run`/`Cancel`       |
| **Graph-impact plan approval** | ✅ full graph viz                                  | approve (graph → list on small screens) | approve (graph → list)             |
| Permission / plan approval     | ✅                                                 | ✅ (`Command(Permission)`)              | ✅ (`Command(Permission)`)         |
| Native diff review             | ✅ side-by-side                                    | read-only mirrored diff                 | read-only mirrored diff            |
| Per-hunk stage / commit        | ✅                                                 | trigger via command                     | trigger via command                |
| **Push / open PR approval**    | ✅ **desktop-only**                                | draft + view status only                | draft + view status only           |
| Offline use                    | ✅ (local engine)                                  | ✗ (needs paired desktop)                | ✗ (needs paired desktop)           |

Push/PR approval staying desktop-only is the security position (M13 / §9 Q7): a paired remote
must not be able to approve a push the desktop policy would refuse.

### 8.2 Protocol additions (additive, ride the existing channel)

Extend `RemoteCommand` / `SyncFrame` in `portcode-sync` — additive, exactly like the
`WorkspaceList` / `WorkspaceUpsert` frames in §4.6, and reusing them:

- **Commands (remote → desktop):** `ListRepos`, `CloneRepo{owner,repo,branch}`,
  `OpenWorkspace{id}`, `RequestDiff{path?}`, `Commit{message}`, `DraftPr{...}`. Push/PR
  _execution_ requires a desktop-side confirmation, not just a remote command.
- **Frames (desktop → remote):** `WorkspaceList`, `CloneProgress`, `RepoContext`
  (branch/dirty/recent-commits), `Diff`. All E2E-encrypted. This list is also the source
  allowlist: raw tool output and arbitrary `StreamEvent` text cannot be encoded as Repo Mode
  sync frames; allowed structured fields are scrubbed before the final M5 redaction pass.
- **Token-does-not-cross is a release invariant, not an assumed fact:** it may be claimed as
  guaranteed only after M5's unit, property/fuzz, and desktop-to-remote canary-secret tests
  pass in CI. Until then it remains a design target; encryption protects transport but does
  not make an accidentally serialized token safe.

### 8.3 Per-surface notes

- **Desktop** — the full experience of §3–§6, and the **only** surface that works standalone
  (no pairing, fully offline).
- **Android (remote)** — Tauri-mobile client; per its plan, desktop-only affordances (file
  tree, raw workspace picker) are hidden, but Repo Mode _adds_ a mobile-appropriate repo
  picker + diff viewer that drive the desktop. An FCM "doorbell" wakes the phone when the
  agent needs a plan/permission approval. The Android Keystore holds only the **pairing**
  key — never the GitHub token.
- **iOS / Web PWA (remote)** — iroh-in-browser (WASM), relay-only, install-gated. Repo Mode
  rides the same `remoteMode` / `applyFrame` path. iOS backgrounding drops the socket, so a
  long desktop clone or agent run survives via **resume-by-cursor** (`Db::messages_since`
  replays the missed stream on reconnect — the desktop kept working the whole time). Web Push
  pulls the user back for a pending plan/permission decision.

### 8.4 Build leverage

Repo Mode's remote surface is **additive frames on the `portcode-sync` crate that the web and
Android roadmaps are already extracting** — so the same work lands the capability on desktop,
iOS/web, and Android at once, with one protocol and one crypto implementation to audit.

### 8.5 The honest constraint (and the future option)

Today the phone/web surfaces require a **paired, running desktop** — there is no always-on
host, by design (your code and secrets never leave your machine). If "use Repo Mode with no
desktop awake" becomes a goal, the clean path is a **headless / always-on desktop host** (the
same engine run as a background service the remotes dial) — **not** a cloud backend, which
stays the anti-feature. Captured as a §9 decision.

---

## 9. Decisions needed before build

1. **GitHub App provisioning & auth flow (biggest):** who owns the App registration, is
   token-expiry enabled, and can the token exchange be done **without** embedding a client
   secret in the desktop binary? This picks loopback-PKCE vs Device Flow and confirms the
   refresh design.
2. **Installation-token broker details** — PATs are out of scope. Confirm the minimum GitHub
   App permissions, mint-before-operation path, maximum in-memory lifetime, concurrent-use
   behavior, and zeroization/drop test strategy for non-persisted installation tokens.
3. **Clone storage & quota** — managed dir location, disk-pressure / eviction policy for
   many large clones, and whether blobless/partial clone is the default for huge repos.
4. **Graphify availability in shipped builds** — is the CLI guaranteed present, or is graph
   context strictly best-effort? (Spec currently treats it as optional/degrade-gracefully.)
5. **Workspace = repo root vs subdirectory/monorepo** — affects sandbox base and graph scope;
   submodules/LFS deferred from v1.
6. **`allow` policy in Repo Mode** — should a token-bearing repo session even allow the
   global `allow` policy, or force an `ask`-floor for all writes? Recommendation: `ask`-floor.
7. **Remote approval authority (cross-app):** can a paired remote (Android / iOS-web) approve
   a `git_push` / PR, or are those desktop-only? Recommendation: desktop-only (§8.1, M13).
8. **Headless desktop host (cross-app):** do we want Repo Mode usable when no desktop UI is
   awake? If so, ship a headless/always-on host of the same engine — explicitly **not** a
   cloud backend (§8.5). Defer past v1 unless prioritized.

---

_Companion design tracks (UX, backend, differentiation, security) and the competitor matrix
were produced as part of this effort and can be expanded into standalone docs on request.
Cross-app surfacing (§8) builds on `docs/ANDROID_APP_PLAN.md` and `docs/IOS_WEB_CLIENT_PLAN.md`._
