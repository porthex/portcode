# Portcode — Roadmap

> This is the single source of truth for delivery priority. Supporting design
> documents define architecture, constraints, and acceptance evidence; they do
> not establish a competing work order.

## Supporting documents

- Release gates and security boundary: [`RELEASE.md`](RELEASE.md) and
  [`RELEASE_SECURITY_BASELINE_PLAN.md`](RELEASE_SECURITY_BASELINE_PLAN.md)
- Phone clients and device evidence: [`ANDROID_APP_PLAN.md`](ANDROID_APP_PLAN.md),
  [`IOS_WEB_CLIENT_PLAN.md`](IOS_WEB_CLIENT_PLAN.md), and the
  [iOS connection spike](../spike/ios-iroh-echo/README.md)
- Review and attribution: [`GIT_DIFF_REVIEWER_DESIGN.md`](GIT_DIFF_REVIEWER_DESIGN.md)
  and [`TURN_COMPLETION_RECEIPTS.md`](TURN_COMPLETION_RECEIPTS.md)
- Provider integration: [`MULTI_CHATGPT_ACCOUNTS_PLAN.md`](MULTI_CHATGPT_ACCOUNTS_PLAN.md)
  and [`OPENAI_SUBSCRIPTION_INTEGRATION.md`](OPENAI_SUBSCRIPTION_INTEGRATION.md)
- Deferred concepts and operational guides: [`REPO_MODE_PLAN.md`](REPO_MODE_PLAN.md)
  and [`SELF_DEV.md`](SELF_DEV.md)

## Progress snapshot — 2026-07-21

Percentages hid whether evidence was code, automated testing, manual testing, or
external acceptance. This snapshot uses explicit evidence states instead.

| Track                           | Evidence state                                       | Missing proof or implementation                                                         |
| ------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Multiple ChatGPT accounts       | **Merged in PR #130; automated acceptance complete** | Owner-credential live smoke remains a broad-release gate                                |
| Desktop/release roadmap         | **Security baseline complete in PR #131**            | Deterministic acceptance, rehearsal, signing, and live checks                           |
| Android remote client           | **Scaffolded; correctness blockers found**           | Initial catch-up, capability/trust boundary, permission ack/replay, CI, device evidence |
| iOS/web client                  | **Scaffolded; correctness blockers found**           | Reconnect, key persistence, permission ack/replay, lifecycle/cursors, relay/PWA CI      |
| OpenAI subscription integration | **Transport implemented**                            | Per-profile hardening, catalog cache, retries, local telemetry, broad-release approval  |
| Git Review workspace            | **Phase 1 implemented**                              | Large-diff UX, structured read-only review, persistence, Fix handoff                    |
| Turn completion receipts        | **Corrective Phase 1 merged in PR #139**             | Durable patch blobs, retention, and exact historical anchors                            |
| Self-dev mode                   | **Deferred from this execution**                     | Optional Phase 2 remains deliberately unscheduled                                       |
| Repo Mode                       | **Proposal only**                                    | Re-grounding, one Git engine, GitHub auth decision, executable security bootstrap       |
| iOS connection spike            | **Harness only**                                     | No recorded physical-device go/no-go result                                             |

The retired parity tracker was a partial implementation log, not a coherent feature.
Its unfinished items are represented in the queue or the explicitly deferred list
below, and Git history retains its completed-build evidence without a second roadmap.

## Ordered work queue

Work top-to-bottom within the **Executable now** lane. Finish each plan as one
tested PR, require green GitHub CI, merge it to `main`, and only then start the
next plan. Self-dev is excluded from this execution. The actual signed/public
first release remains last; external evidence gates are performed when their
required device, credential, or owner decision is available.

### Executable now

1. **Turn completion receipts corrective Phase 1 (P0) — complete in
   [PR #139](https://github.com/porthex/portcode/pull/139).**
   Remove eager Git capture from read-only turns, classify and gate mutating tools,
   replace per-path Git subprocesses with bounded bulk capture, and separate agent
   completion from receipt readiness.
   - **Dependency:** existing receipt lifecycle and Git snapshot implementation.
   - **Evidence:** the mutation, constant-process, two-second finalization,
     crash-recovery, remote-compatibility, UX, and cross-platform CI gates in
     [`TURN_COMPLETION_RECEIPTS.md`](TURN_COMPLETION_RECEIPTS.md) passed before merge.
2. **Multiple ChatGPT accounts (P0) — complete in
   [PR #130](https://github.com/porthex/portcode/pull/130).** Singleton OpenAI
   subscription state is now represented by crash-safe native profiles; every
   OpenAI session and completed turn is pinned to one profile; identity is
   immutable through root/subagents; and account selection/management is shipped.
   Session-scoped selection and started-chat locking were completed in PR #138.
   - **Dependency:** existing direct-subscription transport and capability gate.
   - **Evidence:** the plan's migration, identity, concurrency, UX, redaction,
     Rust, frontend-coverage, PR CI, and merge acceptance is green.
3. **Release security baseline (P0) — complete in
   [PR #131](https://github.com/porthex/portcode/pull/131).** Scrub shell
   subprocess environments to a reviewed allowlist; project phone-bound
   `StreamEvent` data through a bounded, default-deny schema with credential
   redaction; and define an always-ask floor for shell, install, and future
   high-risk Git actions.
   - **Dependency:** none.
   - **Evidence:** focused adversarial tests, documented local automated gates,
     and exact-head CI/Android/E2E acceptance are green.
   - **Deferred:** permission-response acknowledgement and idempotent replay
     remain in the Android/iOS correctness plans; physical-device,
     live-provider, and signing evidence remain external gates.
4. **Deterministic desktop acceptance (P0).** Exercise session → mocked turn →
   permission → tool → persistence → process restart, including explicit
   interrupted-run behavior.
   - **Dependency:** release security baseline.
   - **Done when:** the path is deterministic in CI and failure output identifies
     the broken boundary.
5. **Android protocol and security correctness (P0).** Repair initial Hello/
   catch-up, remove credential-management commands from the mobile boundary,
   persist trust only after SAS verification, add acknowledged/idempotent replay
   for permission decisions across link loss, and make Android CI mandatory.
   - **Dependency:** release security baseline.
   - **Done when:** production client catch-up and capability-boundary regression
     tests pass before physical-device acceptance is claimed.
6. **iOS/web protocol and security correctness (P0).** Standardize reconnect
   handshakes, persist the browser private identity only after SAS verification,
   make lifecycle redial and durable cursors real, replay unacknowledged permission
   decisions idempotently, and add web/PWA CI gates.
   - **Dependency:** release security baseline.
   - **Done when:** reconnect, lifecycle, cursor, relay, and browser security tests
     pass before physical-device acceptance is claimed.
7. **OpenAI transport hardening (P1).** Add a last-known-good/ETag model catalog,
   bounded cancellation-aware 429/5xx retry behavior, compatibility telemetry,
   and evidence for the existing release kill switch. Keep broad release disabled
   until product/legal review and OpenAI contact are complete.
   - **Dependency:** release security baseline.
   - **Done when:** the hardening rows in the integration test matrix pass and the
     release-enable decision is documented.
8. **Git Review Phase 2 (P1).** Land large-diff virtualization/navigation first,
   then structured findings, evidence/severity filters, snapshot persistence,
   Fix selected, and focused re-check.
   - **Dependency:** the landed Phase 1 Review Workspace.
   - **Done when:** read-only AI review is trustworthy on a large diff without
     exposing mutating tools.
9. **Conversation continuity (P1).** Specify and implement context compaction
   first, then conversation fork and checkpoint/rewind semantics.
   - **Dependency:** provider-neutral conversation-state contract.
   - **Done when:** restart, provider-switch, and tool-history behavior are covered
     before any UI claims continuity.
10. **Durable historical patches (P1).** Store immutable historical patch bytes
    with a bounded retention policy and exact old-snapshot anchors. Defer richer
    history navigation and rollback until usage justifies them.
    - **Dependency:** corrective receipt Phase 1 gates and snapshot identities.
    - **Done when:** Last agent turn review never reconstructs an old patch from the
      live working tree.

11. **Local Git handoff (P2).** Add stage/unstage and commit only after Review
    snapshot preconditions are proven; add push/PR handoff last.
    - **Dependency:** Git Review Phase 2 and durable snapshot handling.
    - **Done when:** stale hashes fail closed and no second Git architecture is
      introduced for Repo Mode.

12. **Re-ground Repo Mode before build (P2).** Rewrite its current-state model
    around the existing `git.rs`, `git_review.rs`, permission modes, and optional
    Git-ignored Graphify output; then resolve GitHub App/token decisions and pass
    its security Phase 0 before estimating implementation.
    - **Dependency:** local Git architecture decision plus owner decisions.
    - **Done when:** the plan describes the current tree and every security bootstrap
      control has an executable test.

13. **Unsigned release-candidate rehearsal (P0).** Exercise packaging, updater
    artifacts, checksums/SBOM, install/launch, uninstall, prior-version update,
    and corrupted-signature rejection without production signing credentials.
    - **Dependency:** every executable product/security plan above plus
      deterministic desktop acceptance.
    - **Done when:** the remaining first-release delta is limited to owner-held
      signing, external acceptance, and publication approval.

### Owner, device, or externally blocked

1. **Physical Phone Sync acceptance:** run the iOS go/no-go spike first, then the
   installed-PWA and Android pairing/background/resume matrices against a real
   desktop and relay. Record device, OS, relay, latency, and reconnect evidence.
2. **Signed Windows draft release:** provision signing credentials, cut a draft,
   verify installer/signature/SBOM/checksums on a clean machine, test update from
   the prior version, and approve publication.
3. **Live Anthropic acceptance:** verify a real reply and tool turn with an
   owner-provided key without storing that key in project artifacts.
4. **OpenAI broad-release approval:** confirm the supported distribution boundary
   before enabling direct subscription access in release builds.
5. **Mobile production choices:** decide Android signing/store/FCM and production
   iOS relay/Web Push ownership before scheduling distribution work.

Phone Sync acceptance blocks advertising Phone Sync as ready. Whether it also
blocks the base desktop v1 release is an explicit product-scope decision.

### Later — preserved, not committed

- Edit content inside the permission prompt.
- Per-agent worktree isolation, pending one shared Repo Mode/worktree model.
- Custom slash commands, hooks, skills, MCP, and plugins, pending separate scope
  and security review.
- Self-dev Phase 2 blue-green supervisor and automatic rollback.
- Repo Mode multi-device workspace sync, headless host, submodules/LFS, monorepo
  expansion, and parallel worktree agents.

## Milestone 0 — Foundations ✅ done

- [x] Tech-stack decision (Tauri v2 + Rust + React)
- [x] Toolchain (Rust MSVC + VS Build Tools) installed
- [x] Project scaffold (frontend + `src-tauri`)
- [x] Frontend runs in Vite with a working chat shell (mocked core)
- [x] Rust core compiles; native window opens (~40 MB RAM)

## Milestone 1 — Talking agent 🟡 implementation complete, live acceptance pending

- [x] Anthropic streaming provider in Rust (`llm.rs`, SSE)
- [x] Settings UI + API key stored in Credential Manager
- [x] Agent loop wired end-to-end (streams text + runs tools)
- [ ] Verify a live reply with a real API key (needs user key)
- [x] Session persistence (SQLite, WAL) + history sidebar (with delete)

## Milestone 2 — Tools ✅ done

- [x] Tool trait + registry, JSON schemas
- [x] `read_file`, `list_directory`, `find_files`, `search_text` (read-only)
- [x] `write_file`, `edit_file`, `run_command` (gated, sandboxed to workspace)
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
- [x] Crash-safe history (SQLite WAL + atomic per-turn writes) and explicit
      interrupted-run receipts
- [ ] Full interrupted-run auto-resume
- [x] NSIS installer via the Tauri bundler
- [x] Signed-update client, stable-channel endpoint, settings, progress UI, and relaunch flow
- [x] Apache-2.0 license + CLA

## Milestone 5 — Agent parity foundation ✅ implemented

- [x] Provider abstraction and deterministic provider test seams
- [x] Permission modes, rules, read-only plan mode, and pre-apply diffs
- [x] Bounded parallel subagents with lifecycle UI and cancellation
- [x] Background `run_command` tasks with status and cancellation
- [x] Persisted drafts, cumulative usage, message search, and session rename

## Milestone 6 — Phone Sync foundation 🟡 implemented, acceptance pending

- [x] Shared native/WASM protocol, Noise transport, pairing, catch-up, and command framing
- [x] Android remote-client split, QR scanner integration, and remote UI
- [x] Browser/PWA remote client, WASM connector, durable pairing storage, and reconnect lifecycle
- [ ] Validate desktop ↔ Android on a physical device, including reconnect/background behavior
- [ ] Validate desktop ↔ installed iOS PWA on a physical device (the go/no-go lifecycle gate)

## Milestone 7 — Stabilize and release

- [x] Harden shell environment inheritance and phone-bound event projection
- [ ] Add a deterministic full acceptance path: session → mocked turn → permission → tool → restart
- [ ] Rehearse packaging, install/update, checksums, and SBOM without production signing
- [ ] Run the signed Windows release workflow into a **draft** GitHub Release
- [ ] Verify installer, signature, SBOM/checksums, clean-machine launch, and prior-version update
- [ ] Publish only after the draft passes the release checklist
- [ ] Complete live Anthropic and Phone Sync owner-device checks

Implementation checkmarks above mean the code and automated gates exist. They do **not** claim
that a signed public release or real-phone acceptance run has completed.
