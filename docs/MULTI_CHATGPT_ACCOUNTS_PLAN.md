# Multiple ChatGPT subscription accounts — plan

- Status: shipped in PRs #130 and #138
- Scope: ChatGPT subscription accounts only
- Primary outcome: choose the account inside an empty chat, beside the model picker
- Started-chat switching: opens a new chat with the selected account
- Research date: 2026-07-20
- Related reference: [`OPENAI_SUBSCRIPTION_INTEGRATION.md`](OPENAI_SUBSCRIPTION_INTEGRATION.md)

This plan adds multiple ChatGPT subscription accounts without turning provider
authentication into global mutable state. Each session is pinned to one local
account profile. Every GPT chat starts with the default account from Settings.
When more than one account is connected, the user can choose another account in
the empty chat before sending its first message. Once a chat has started, its
account is immutable; choosing another account offers to continue in a new chat.

In this document, “ChatGPT account” means a ChatGPT subscription sign-in used by
Portcode's existing OpenAI subscription transport. It does not mean an OpenAI
Platform API key, API credits, or a generic multi-provider account.

## Decision summary

1. Store multiple ChatGPT OAuth profiles in the native backend and expose only
   display-safe account summaries to the frontend.
2. Add an opaque local `accountProfileId` to every new session. Never resolve a
   run through a global “active account.”
3. Keep the home and New Chat surfaces account-free. Apply the default account
   from Settings, and show the account selector beside the model picker only
   inside an empty GPT chat when there is a meaningful choice.
4. Freeze the selected account for the complete lifetime of every active turn,
   including retries, token refreshes, and tool-loop model calls.
5. Keep a started session pinned to its original account. A switch attempt shows
   a confirmation and creates a new chat under the requested account. Never
   silently switch on authentication failure, quota exhaustion, or model mismatch.
6. Do not copy the old transcript or hidden reasoning into the newly created chat.
7. Removing an account deletes credential material but retains a non-secret
   tombstone so existing sessions can reconnect to the same local profile safely.
8. V1 fails closed for remote OpenAI session creation until Phone Sync negotiates
   an account-profile capability; it never silently chooses a default account.

## Goals

- Let a user add, inspect, reconnect, and remove multiple ChatGPT subscription
  accounts.
- Provide one connected default account, configurable in Settings.
- Let users with multiple connected accounts change the account inside an empty
  GPT chat before the first message.
- Keep account controls out of the home and New Chat surfaces.
- Guarantee that concurrent sessions can use different accounts without
  influencing one another.
- Keep tokens, refresh credentials, and remote ChatGPT account IDs out of React
  state, SQLite session rows, sync frames, logs, and structured telemetry events.
  Native minidump attachments retain their documented, opt-in crash-diagnostics
  exception because they cannot be passed through the telemetry redactor.
- Preserve the current workspace, tools, agent loop, prompt, approvals,
  persistence, and release capability gate.
- Migrate the existing singleton ChatGPT credential without signing the user out
  or losing an existing session.
- Fail clearly and locally when a session's account needs reconnection.

## Non-goals for V1

- Claude or other provider accounts.
- OpenAI Platform API keys.
- Switching accounts during an active turn.
- Mutating the pinned account of a chat that already has a durable message.
- Automatically using another account when quota is exhausted.
- Merging billing, quota, or usage across accounts.
- Copying Codex threads or moving Portcode conversation ownership to OpenAI.
- User-defined aliases, account folders, account reordering, or elaborate account
  routing rules.

## Why the design is session-scoped

Portcode currently stores canonical messages locally, reloads the session history
for a run, and sends the accumulated input with `store: false`. The workspace and
tool context are also selected independently from the ChatGPT credential. See:

- [`src-tauri/src/db.rs`](../src-tauri/src/db.rs) for session and message storage.
- [`src-tauri/src/agent.rs`](../src-tauri/src/agent.rs) for credential resolution,
  history loading, refresh, and the tool loop.
- [`src-tauri/src/llm.rs`](../src-tauri/src/llm.rs) for full-history OpenAI input,
  `store: false`, and the `ChatGPT-Account-ID` header.
- [`src-tauri/src/secrets.rs`](../src-tauri/src/secrets.rs) for the current
  singleton `OpenAiOAuthTokens` storage.

That architecture makes a session-owned account reference the smallest stable
change. A global active account would be unsafe: changing it for one new session
could redirect a running or resumed session to a different account.

The audited runtime does **not** yet enforce this identity invariant. It compares
the stored singleton with an in-memory credential before refresh, but it can
persist a refresh response whose asserted account ID is missing or different.
V1 must validate the identity asserted by the new response before the credential
is persisted or used. Retaining an old account ID as metadata is not proof that
the refreshed token belongs to that account.

## Product contract

### Account management

Settings gains a **ChatGPT accounts** section with:

- One row per connected account.
- Email or the best available account label.
- Subscription tier when available.
- Connection state: connected, reconnect required, removed, or unavailable.
- **Add account**, **Reconnect**, and **Remove** actions.
- One connected account marked as the default, with an action to change the
  default when more than one connected account exists.

Adding an account starts the existing browser OAuth flow. Login remains globally
serialized because only one loopback authorization flow should own the callback
at a time. After login:

- A new remote ChatGPT account ID creates a local profile.
- An already-known remote account ID refreshes that profile instead of creating a
  duplicate.
- Email is display metadata, not identity. Two workspaces may legitimately share
  the same email address.

Removing an account deletes its OAuth token payload but retains a tombstone with
the opaque local profile ID, display-safe metadata, and an HMAC-SHA256 fingerprint
of the remote identity under a per-install secret. It does not delete or rewrite
sessions. Historical sessions remain readable and become non-runnable until an
exact-identity reconnect revives that same local profile. Permanently forgetting
the identity binding is a separate future action.

Removal must be rejected while that profile has an active run. This avoids
credential disappearance halfway through refresh or retry handling.

The **Remove** action is shown only for connected or reconnectable profiles. Once
removal succeeds, the stale action disappears immediately. If the removed profile
was the default, another connected profile becomes the default. Empty chats that
referenced the removed profile reconcile to the remaining connected default;
started chats retain their historical profile reference and require reconnection.

### In-session account selection

New Chat creates an empty, in-memory session and applies the default ChatGPT
account from Settings. The home screen, Sidebar New Chat action, collapsed rail,
Ctrl/Cmd+N, command palette, and other creation entry points do not show an
account prompt or picker.

Inside an empty GPT chat, `Composer` places the account selector next to the model
selector. Behavior:

1. With exactly one connected account, the default is used and the selector is
   hidden because there is no alternative.
2. With several connected accounts, the default is preselected and the user can
   choose another account before the first durable message.
3. Changing the account also changes the visible model catalog to that account's
   catalog. If the prior model is unavailable, Portcode visibly selects a valid
   model before the first send.
4. The native pin command is authoritative and permits the change only while the
   session has no durable messages and no active turn.
5. After the first message, a switch attempt never mutates the current chat. A
   confirmation dialog offers to continue in a new empty chat using the selected
   account and a compatible model.
6. If the selected account is removed, unavailable, or reconnect-required, the
   current history stays readable and the UI offers the appropriate Settings or
   reconnection path; it never silently borrows another account for a started chat.
7. Loading, registry failure, zero-account, and reconnect-only states remain
   distinct. An error or empty model response is never treated as a valid catalog.

Tokens and the raw remote account ID never appear in the UI.

### Existing and legacy sessions

The new database column is nullable for migration safety.

- New OpenAI sessions require an `accountProfileId`.
- An existing unpinned OpenAI session is pinned lazily on its first subsequent
  turn.
- If one account is connected, Portcode asks for confirmation and pins it.
- If several accounts are connected, Portcode requires a choice.
- Reading, exporting, renaming, or deleting a legacy session never requires a
  connected account.

The lazy step must be explicit because the database cannot prove which account
created an old session. Guessing from the currently active credential would hide
an irreversible attribution error.

## Backend design

### Stable local identity

Introduce an opaque local identifier:

```rust
pub struct AccountProfileId(Uuid); // canonical lowercase hyphenated UUID only
```

Suggested internal records:

```rust
pub struct OpenAiAccountProfile {
    pub id: AccountProfileId,
    pub tokens: OpenAiOAuthTokens,
    pub identity_fingerprint: [u8; 32],
    pub credential_generation: u64,
    pub state: StoredProfileState,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
}

pub struct OpenAiAccountSummary {
    pub id: AccountProfileId,
    pub account_label: Option<String>,
    pub tier: Option<String>,
    pub expires_at: Option<i64>,
    pub state: OpenAiAccountState,
}
```

`OpenAiOAuthTokens.account_id` remains the authoritative remote identity and stays
inside native code. Frontend and sync consumers use only `AccountProfileId`.
Profile IDs are parsed and canonicalized before any storage key is constructed;
remote IDs and display metadata have strict length and character bounds.

### Secret storage

Replace the singleton OpenAI slot with a versioned account registry behind an
injectable `SecretStore`. Reads return typed absence, unavailable/locked,
corruption, integrity, size, conflict, and I/O failures; only typed absence means
"signed out."

- One small index containing local profile IDs and display-safe metadata.
- One bounded, chunked secret payload per profile containing the complete OAuth
  token set.
- Versioned key names so the legacy credential remains recoverable during
  migration.
- A/B manifests for both index and profiles containing schema, slot, chunk count,
  decoded byte length, SHA-256, and monotonically increasing generation.
- A short process-wide commit lock. The non-Windows whole-map backend also locks
  its complete read-modify-write, uses a unique restrictive temp file, flushes it,
  and atomically replaces the destination. Corruption is preserved and surfaced,
  never overwritten as an empty store.
- A durable migration journal that records the generated UUID before any profile
  write, then advances through profile-verified, registry-committed, and
  legacy-deleted phases. Startup resumes the same UUID after every interruption.
- Atomic migration order: journal UUID, write/read-verify profile, write/read-
  verify index, delete the legacy singleton, verify, then clear the journal.

Never place refresh tokens, access tokens, ID tokens, or the raw remote account ID
in SQLite. Existing secret redaction and diagnostic rules continue to apply.

### Session persistence

Add a nullable column without a foreign key to the secret store:

```sql
ALTER TABLE sessions ADD COLUMN account_profile_id TEXT NULL;
ALTER TABLE turn_receipts ADD COLUMN account_profile_id TEXT NULL;
```

No cascading relationship is desirable: removing a credential must not remove
conversation history. Extend `SessionRow`, the TypeScript `Session` type, session
creation, listing, and sync serialization with the optional opaque ID.

Record the local account profile ID in the serialized turn completion receipt and
its indexed database column. This provides immutable support/audit attribution
without storing remote identifiers. Historical receipts remain valid when a
profile is removed, and old receipt payloads decode with the field absent.

### Credential registry API

Replace singleton operations with profile-scoped operations:

```text
list_openai_accounts() -> [OpenAiAccountSummary]
start_openai_account_login() -> OpenAiAccountSummary
reconnect_openai_account(accountProfileId) -> OpenAiAccountSummary
remove_openai_account(accountProfileId) -> ()
openai_models(accountProfileId) -> [OpenAiModel]
get_plan_usage(provider, accountProfileId) -> PlanUsageSnapshot
pin_session_openai_account(sessionId, accountProfileId) -> SessionRow
```

Internal credential operations become:

```text
load_openai_profile(accountProfileId)
store_openai_profile(profile)
refresh_openai_profile(accountProfileId)
load_credential_for(provider, accountProfileId)
```

Refresh locking is keyed by `AccountProfileId`; OpenAI browser login uses a
separate global `try_lock` from Anthropic login. A slow refresh for Account A must
not block a valid cached run for Account B. Profile lifecycle leases cover runs,
model discovery, usage, and refresh; removal becomes linearizable with admission
and succeeds only at zero leases.

### Run invariants

At the beginning of a turn, `agent.rs` must:

1. Reserve the session and read its authoritative database model and pinned
   `accountProfileId` together. A frontend-supplied model is not run authority.
2. Acquire a lifecycle lease for that exact profile before spawning asynchronous
   work; removal cannot race past this admission point.
3. Load and, if necessary, refresh exactly that profile under its refresh lock.
4. Freeze an immutable `RunAuthContext` containing the local profile ID, expected
   remote identity, credential generation, and credential.
5. Clone that context through every root/subagent request, retry, 401 recovery,
   and tool-loop model call. Subagents never reload a global credential.
6. Hold the profile lease through terminal receipt persistence and emission.

Every refresh response must independently assert the exact expected remote
account ID. A missing or different identity quarantines only that profile,
aborts with a reconnect error, and is never persisted or used. Generation checks
prevent a stale refresh from overwriting a concurrent reconnect/login.

The following are forbidden:

- Looking up a “current” or “last used” account after the run begins.
- Falling back to a different connected profile.
- Reusing Account A's model catalog or quota snapshot for Account B.
- Mutating a session's pinned profile during an active run.

### Model catalogs and usage

Model availability and subscription limits are account-scoped. Cache keys must
include `AccountProfileId`:

```text
(accountProfileId, catalogVersion) -> model catalog
accountProfileId -> plan usage snapshot
```

Signing out or reconnecting invalidates only that profile's cache. Removing one
profile must not clear another account's catalog or usage state.

### Remote/phone sessions

The desktop remains the credential authority. No OAuth material is copied to a
phone or web client.

V1 does **not** extend the existing remote `CreateSession` variant with an
optional profile field. Old peers could ignore an unknown field and silently use
a default account. Instead:

- Keep optional/defaulted profile fields on session and receipt DTOs so old JSON
  continues to decode.
- Explicitly reject remote creation when the authoritative default model is
  OpenAI.
- Allow remote execution of already-pinned sessions because desktop admission
  resolves their database profile.
- Fail legacy unpinned OpenAI sessions with a desktop-selection instruction.
- Add remote account selection later only after `Hello` capability negotiation
  and a distinct versioned create command are implemented.

## Frontend design

### State

Add display-only account state:

```ts
interface OpenAIAccountSummary {
  id: string;
  accountLabel: string | null;
  tier: string | null;
  expiresAt: number | null;
  state: "connected" | "reconnect_required" | "removed" | "unavailable";
}
```

The store persists `lastOpenAIAccountProfileId` as the user's default account.
Settings is the authoritative UI for changing it. The value seeds new empty GPT
chats but never changes a started session; execution always reads the session's
pinned profile.

`newSession()` creates an empty in-memory session using that default. The session
is materialized only on first send. Account changes before that boundary go
through the native compare-and-set pin command so account removal, another window,
or a concurrent first send cannot produce a partially initialized session.

### Components

Keep the surface small:

- Extend the ChatGPT sign-in area in
  [`src/components/Settings.tsx`](../src/components/Settings.tsx) into an account
  list with a visible default and default-selection action.
- Add `SessionAccountSwitcher` beside the model selector in
  [`src/components/Composer.tsx`](../src/components/Composer.tsx). Hide it when
  fewer than two accounts are connected unless the pinned account is unavailable.
- Route a locked switch through `SessionActionDialog`, which offers to create a
  new chat for the selected account without altering the current chat.
- Use explicit loading, registry-error, zero-connected, and reconnect-only states;
  errors never collapse to an empty connected-account list.
- Remove successful accounts from actionable Settings rows immediately so a stale
  **Remove** button cannot remain visible.
- Resolve authorization and account labels from the active session's pinned
  profile, not the default-account preference.

No dedicated account-management route, routing rules editor, or automatic quota
balancer is needed.

## Started-chat switching boundary

### Implemented behavior

An account switch attempted after the first durable message is rejected by the
native session pin command. The UI explains that the existing chat cannot change
accounts and offers to create a new empty chat under the selected account. The old
chat, workspace, and files remain intact; conversation history and hidden provider
state are not copied.

### Full-history feasibility

Switching between completed turns is technically possible in Portcode without
losing visible conversation or files:

- Canonical messages are local and can be replayed under the next credential.
- Workspaces, branches, and file changes do not belong to the ChatGPT account.
- Completed tool calls and results are part of the local session history.
- The current OpenAI request uses `store: false`, so continuity does not depend on
  an OpenAI-hosted response chain.

This is consistent with OpenAI's documented stateless conversation pattern, in
which an application maintains context by sending prior messages again. See
[Conversation state](https://developers.openai.com/api/docs/guides/conversation-state).

Switching during an active turn is not safe. A turn can issue several model calls,
refresh credentials, recover from a 401, and execute tools. Changing identity in
that loop risks charging or governing different parts of one turn under different
accounts.

### Why full-history switching is not a simple toggle

Continuing under Account B sends Account A's previous prompts, assistant messages,
tool outputs, terminal output, and file excerpts to Account B. Different ChatGPT
workspaces may have different administrative controls, retention, residency, and
permissions. See [OpenAI authentication](https://developers.openai.com/codex/auth/).

Portcode also retains encrypted reasoning items for stateless continuation.
OpenAI documents replaying encrypted reasoning in stateless mode, but does not
document portability between unrelated ChatGPT accounts or workspaces. See
[Reasoning models](https://developers.openai.com/api/docs/guides/reasoning).

Therefore a future cross-account continuation must remove previous encrypted
reasoning and make the data transfer explicit.

OpenAI's public Codex app-server protocol presents one current account through
account read/login/logout operations; it does not document a concurrent
multi-account registry. Portcode must own account selection rather than depend on
an undocumented OpenAI-side switch. See
[Codex App Server](https://developers.openai.com/codex/app-server/).

### Possible follow-up: handoff fork

If users later need contextual continuation rather than today's safe new-chat
flow, add an explicit linked-session handoff:

- Same workspace and branch.
- New session ID pinned to the selected account.
- User-visible handoff summarizing goals, decisions, completed changes, relevant
  files, Git state, and next steps.
- No encrypted reasoning or hidden provider state.
- Link to the source session for navigation and audit.

This preserves the work while minimizing cross-account transcript transfer.

An advanced **Continue with full history** option may be considered later. It
would require explicit confirmation that prior conversation and tool history will
be sent to the new account, removal of encrypted reasoning, account-specific model
validation, an account-boundary marker, and a guarantee that no run or mutating
background activity is active.

## Failure behavior

| Condition                                      | Required behavior                                        |
| ---------------------------------------------- | -------------------------------------------------------- |
| Selected profile is missing                    | Keep session readable; request reconnection              |
| Access token expires                           | Refresh only the pinned profile                          |
| Refresh omits or changes the remote account ID | Abort; persist/use nothing; quarantine only that profile |
| Account reaches quota                          | Explain which account; never auto-switch                 |
| Model unavailable to selected account          | Require a visible model change before run                |
| Account removed during active run              | Reject removal                                           |
| Account removed after completed turn           | Keep history; block future runs                          |
| Registry/index is corrupt                      | Fail closed; preserve recoverable secret entries         |
| Secret backend is locked/unavailable           | Surface unavailable; never reinterpret it as signed out  |
| Legacy migration is interrupted                | Retry idempotently on next startup                       |
| Direct subscription feature gate is off        | Keep removal available; hide run/login actions           |

## Security and privacy requirements

- Credentials remain in the native secret store and never cross IPC.
- IPC responses contain only local profile ID, display label, tier, expiry, and
  connection state.
- Logs and structured telemetry events may contain an ephemeral hash or local
  profile ID only when needed for correlation; never include tokens or the remote
  account ID. Opt-in native minidump attachments retain the documented exception
  for process-memory snapshots that cannot be redacted before upload.
- Error messages must not dump OAuth responses or authorization headers.
- Centralize OpenAI authentication/header construction for inference, model
  discovery, and plan usage. Redaction covers bearer tokens and the
  `ChatGPT-Account-ID` header/value.
- Account deletion must target an exact validated local profile ID.
- Reconnection must verify that the returned remote identity matches the profile
  being reconnected. If the user signs into another account, offer to add it as a
  new profile instead of replacing the old one silently.
- Retain the compile-time and runtime release gates described in
  [`OPENAI_SUBSCRIPTION_INTEGRATION.md`](OPENAI_SUBSCRIPTION_INTEGRATION.md).
- Keep the direct subscription transport isolated because it is not documented as
  a stable general-purpose third-party API boundary.

## Implementation phases (completed)

### Phase 0 — Registry refactor with one-account behavior

- Add `AccountProfileId` and the versioned native registry.
- Add typed/injectable secret-store errors and serialized, corruption-preserving
  non-Windows writes.
- Migrate the existing singleton credential with the durable UUID journal.
- Convert status, refresh, logout, model, and usage functions to accept a profile
  internally.
- Keep the frontend behavior functionally unchanged.
- Add Rust migration, registry, refresh-isolation, and corruption tests.

Exit criterion: a user with one existing ChatGPT sign-in remains signed in and all
current OpenAI tests pass through the new registry.

### Phase 1 — Multiple account management

- Add list/add/reconnect/remove commands.
- Replace the singleton Settings card with account rows.
- Deduplicate and revive profiles by a keyed remote-identity fingerprint.
- Key model catalogs, usage snapshots, and refresh locks by profile.
- Add lifecycle leases and tombstone-based removal/reconnect behavior.
- Add frontend and Rust tests for two independent accounts.

Exit criterion: two mock accounts can coexist, refresh independently, and produce
requests with their own bearer token and `ChatGPT-Account-ID` header.

### Phase 2 — Session pinning and in-chat selection

- Add the nullable session database column and TypeScript field.
- Seed local empty sessions with the default profile ID and fail closed for
  unnegotiated remote OpenAI creation.
- Add the empty-chat account selector beside the model selector.
- Lock the account after the first durable message and route later switch attempts
  to a confirmed new-chat flow.
- Resolve every run through the session's pinned profile.
- Add account labels to session chrome and the reconnect-required state.
- Cover legacy-session pinning explicitly.

Exit criterion: Account A and Account B can run concurrent sessions, changing an
empty chat affects no started session, and there is no global credential lookup in
the run path.

### Phase 3 — Hardening and release

- Exercise cancellation, 401 recovery, token expiry, account removal, app restart,
  corrupt secret data, quota errors, model mismatch, and concurrent runs.
- Verify token and account-ID redaction in logs, errors, structured telemetry
  events, receipts, and sync frames; preserve the explicit opt-in native minidump
  exception documented by the existing crash-reporting boundary.
- Run `cargo test --workspace`.
- Run `pnpm test:coverage`; cover new frontend lines instead of lowering the gate.
- Complete deterministic two-account QA through the normal gated test/build
  surfaces and local provider seams. Do not use self-dev mode for this roadmap
  execution.
- Before broad release, repeat the core add/run/refresh/quota matrix with two
  owner-provided live accounts. This credential-dependent smoke is external
  release evidence, not a reason to weaken or bypass deterministic CI coverage.
- Release behind the existing subscription capability gate and retain the remote
  disable path.

Exit criterion: the acceptance checklist below passes and rollback disables new
login/run behavior without preventing credential removal.

### Later — Explicit cross-account handoff

Implement the linked-session handoff only after V1 has production evidence. Do not
couple it to the account-registry migration or session-picker release.

## Test plan

### Rust

- Registry round-trip for zero, one, and multiple profiles.
- Typed absence, locked/unavailable, corruption, integrity, and size failures.
- Legacy singleton migration interruption after every journal/profile/index/
  cleanup write; retry must use the same UUID and never delete legacy data early.
- A/B incomplete writes preserve the last committed generation.
- Concurrent non-Windows writes cannot lose sibling entries or collide on a temp
  file.
- Duplicate login updates the correct remote identity.
- Reconnect refuses to replace a profile with another remote identity.
- Removing one profile preserves other profiles and all sessions.
- Per-profile refresh locks allow Account A and Account B to refresh independently.
- Same-profile refreshes are single-flight; stale refresh cannot overwrite a
  reconnect/login generation.
- Terminal refresh failure invalidates only the selected profile.
- `create_session` persists the selected profile ID.
- Legacy session pinning requires confirmation or selection as specified.
- A run continues using its original profile when the default account changes.
- A missing or changed remote account ID during refresh persists and sends
  nothing, aborts the turn, and quarantines only that profile.
- Removal/run/model/usage admission races are linearizable.
- Parent, nested, and parallel subagents use the root run's exact account headers.
- Legacy session pin races have one CAS winner and never send under a loser.
- Account-specific model and usage caches cannot leak across profiles.
- Serialization and migration tolerate missing optional fields.

### Frontend

- One connected account is the default and does not render a redundant selector.
- Settings can change the default when multiple accounts are connected.
- New Chat and the home screen do not render account selection.
- Multiple accounts show the default profile beside the model picker in an empty
  GPT chat.
- Choosing another account before the first message pins the correct ID and uses
  that account's model catalog.
- Choosing another account after the first message leaves the current chat
  unchanged and offers a compatible new chat.
- Rapid repeated creation or confirmation still creates one session.
- No-account state routes to Add Account.
- Loading, registry error, zero-account, and reconnect-only states remain
  distinguishable and accessible.
- Removed or expired account leaves history readable and shows reconnect UI.
- Account selection updates the available model list.
- Existing sessions do not change when the default account changes.
- Settings add/reconnect/remove actions preserve loading and error states.
- A removed profile no longer renders a stale **Remove** action.
- Capability-off Settings still lists accounts and exposes Remove while hiding
  login/reconnect/run controls.
- Ctrl/Cmd+N, command palette, full Sidebar, collapsed rail, and composer fallback
  all create an account-prompt-free empty chat through the same guarded resolver.
- Legacy pin confirmation occurs before draft clearing or optimistic message state.
- No token or remote account ID appears in serialized store state.

### Integration and manual QA

- Run two mock accounts concurrently and verify the exact request headers.
- Restart the app and confirm profile/session associations persist.
- Expire Account A while Account B continues normally.
- Exhaust or simulate quota for Account A and confirm no fallback occurs.
- Attempt removal and account changes during an active run.
- Verify session export/history remains available after credential removal.
- Verify account data shown to a remote client is display-safe and credentials
  remain desktop-only.
- Inspect logs and structured telemetry events for credential and account-ID
  leakage, with the documented opt-in native minidump exception treated
  separately.

## Acceptance checklist

- [x] A user can connect at least two ChatGPT subscription accounts.
- [x] One connected account is always the default, and Settings can change the
      default when alternatives exist.
- [x] Home and New Chat surfaces do not show an account prompt.
- [x] An empty GPT chat shows account selection beside the model selector only
      when multiple accounts are connected or the pinned account is unavailable.
- [x] Selecting another account before the first message takes one interaction.
- [x] Selecting another account after the first message preserves the current
      chat and offers to continue in a new chat.
- [x] Every new OpenAI session persists a local account profile ID.
- [x] Existing started sessions never change account when the default or another
      empty chat's selection changes.
- [x] Every turn, retry, and refresh uses one immutable account identity.
- [x] Root and every nested/parallel subagent use that same immutable identity.
- [x] Account-specific model catalogs and quota snapshots stay isolated.
- [x] Removing an account never deletes session history.
- [x] Removing an account removes its stale **Remove** action and reconciles the
      default/empty-chat selection safely.
- [x] Removing then reconnecting the same remote identity revives the exact local
      profile; reconnecting a different identity does not mutate it.
- [x] No automatic quota-based or error-based account switching exists.
- [x] No credential or raw remote account ID crosses IPC, sync, logs, or structured
      telemetry events; opt-in native minidump attachments retain their documented
      process-memory exception.
- [x] Legacy single-account users migrate without signing in again.
- [x] Migration interruption resumes the same journaled UUID and never destroys
      the recoverable singleton credential.
- [x] Rust tests and frontend coverage pass.
- [x] Release and runtime disable gates continue to work.

### Acceptance evidence — 2026-07-20

- Native: `cargo fmt --all --check`, workspace clippy with warnings denied, 357
  desktop tests, and 55 shared Phone Sync tests passed.
- Browser transport: both WASM crates built and linted for
  `wasm32-unknown-unknown`; dependency-boundary and committed interop-contract
  freshness checks passed.
- Frontend: lint, typecheck, 1,628 tests, and coverage passed at 96.19% statements,
  97.41% functions, and 98.04% lines without lowering thresholds.
- Product builds: desktop and web/PWA production builds, E2E typecheck, the normal
  gated Tauri debug build, and its live WebView2 smoke journey passed. Self-dev was
  not used.
- Adversarial evidence covers two-account exact headers, root/nested/parallel
  identity, 429/no-fallback behavior, malformed-refresh quarantine, removal with
  byte-for-byte history/usage preservation, lifecycle races, wrong-identity
  reconnect, display-safe remote attribution, and every one of 272 legacy
  migration mutation points for both supported singleton encodings.
- IPC and sync payload whitelists plus log/error and structured-telemetry
  redaction tests cover the credential boundary. The checked claim excludes the
  pre-existing, opt-in native minidump attachment path documented in
  `src-tauri/src/telemetry.rs`, whose process-memory contents cannot be redacted.
- No private OAuth credentials were used in automated acceptance. A live
  two-owner-account OAuth/quota smoke remains required before broad-release
  approval; this document does not claim that external credential evidence.

## Rollback

The feature should be reversible without database surgery:

- Disable multi-account UI and account-specific session creation through the
  existing subscription feature gate or a narrower multi-account gate.
- Continue reading the account registry as a single selected profile so existing
  users can run or remove credentials.
- Preserve `account_profile_id` columns and registry entries; do not down-migrate
  or discard associations.
- Never restore the old singleton writer after registry migration, because doing
  so could overwrite one of several profiles.

## Final recommendation

The shipped contract uses a Settings-owned default and session-scoped account
selection. New Chat remains a clean one-click action. Users with alternatives can
change the account beside the model picker while the chat is empty; the first
durable message locks that account.

After that boundary, Portcode offers a new empty chat for the requested account
instead of changing credentials in place. A future linked-session handoff may add
an explicit, sanitized context transfer, but it must never become a silent
credential toggle.
