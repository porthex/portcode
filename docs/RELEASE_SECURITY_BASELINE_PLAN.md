# Release security baseline — plan

- Status: complete in [PR #131](https://github.com/porthex/portcode/pull/131);
  local and exact-head GitHub automated acceptance green
- Priority: P0, before deterministic desktop and mobile acceptance
- Audit baseline: `d7526aa` (`feat(openai): add multiple ChatGPT accounts`)
- Audit date: 2026-07-20
- Evidence boundary: automated local and GitHub CI evidence; no claim of physical-phone,
  live-provider, production-signing, or public-release acceptance

This plan closes the release-critical boundaries where an agent-controlled child
process, a paired phone, a persisted permission setting, or a credentialed HTTP
request can currently receive more authority or data than intended. It is an
executable security plan, not a claim that Phone Sync or the first release is
already accepted.

## Decision summary

1. Clear every app-owned child-process environment and reconstruct it from one
   reviewed, exact-name allowlist. Apply the boundary to both agent shells and
   native Git; never pass ambient credentials, proxy secrets, loader hooks,
   language-runtime injection variables, SSH agents, or Git overrides.
2. Keep the desktop's rich internal `StreamEvent` and persistence types private.
   Phone Sync uses separate public DTOs, built by an exhaustive projection that
   redacts credentials, bounds every arbitrary field, removes raw tool payloads,
   and applies equally to live traffic, reconnect catch-up, and pagination.
3. Replace the optional `Tool::mutating()` default with a required structural
   permission-risk classification. Shell, dependency installation, high-risk
   Git, and unknown future protected actions always require one approval per
   call, even under legacy Allow, Auto, Bypass, wildcard rules, or old shell
   rules.
4. Make Plan and cancellation absolute deny states. Preserve explicit Ask/Deny
   outcomes and existing ordinary file-tool behavior.
5. Hide remembered approval for protected actions and for phone prompts. Keep old
   rules readable/removable, but cap them at runtime so migration can never
   weaken the floor.
6. Persist Settings transactionally before replacing the in-memory policy. A
   failed write is an error, not an apparent successful security change.
7. Never read or reflect unbounded provider error bodies. Reject cross-origin
   credentialed redirects, including scheme and effective-port changes, so
   custom authentication headers and request bodies cannot be replayed to a new
   origin.
8. Validate every phone-supplied identifier before DB lookup, channel creation,
   or reflection. Invalid identifiers produce no attacker-derived outbound ID.

## Current-state audit

The audit found these release blockers at the baseline commit:

- `tools.rs::build_shell_command` and the shared native Git runner inherit the
  entire Portcode environment. This includes API tokens, registry credentials,
  proxy credentials, `SSH_AUTH_SOCK`, `GIT_*` behavior overrides, dynamic-loader
  hooks, and runtime injection variables.
- Shell output is collected without a byte bound and truncated only after the
  child exits, so a noisy command can allocate without limit. The background path
  has the same issue and no execution timeout.
- `SyncHub::publish` clones an internal `StreamEvent` directly into a phone frame.
  Raw tool inputs, file and shell results, permission input/diffs, background
  output, provider errors, receipt paths, and agent descriptions can cross.
- Reconnect and pagination bypass any live-only filter because database rows
  retain raw tool blocks; only opaque reasoning is currently removed.
- Noise accepts less than 64 KiB of plaintext, while existing tool outputs and
  permission diffs may exceed that before framing. One oversized event can end
  the live forwarder and force a reconnect.
- `Run` and `FetchMessages` accept unbounded session identifiers and can reflect
  them into outbound channel/frame fields.
- Permission precedence is currently cancel → Bypass → first rule → mode. Thus
  shell can execute without a prompt through legacy Allow, Auto, Bypass, or an
  Allow rule, and an Allow rule can override Plan mode.
- Command-prefix rules are not shell-aware: an approval stored for `git status`
  is also a prefix match for a chained command. Command parsing cannot safely
  distinguish every package-manager, nested-shell, encoded, aliased, or chained
  operation.
- Settings writes ignore filesystem errors after mutating memory, so a user can
  see a safer policy that silently reverts after restart.
- Anthropic API and OAuth failures read and reflect unbounded provider-controlled
  bodies. The shared HTTP client also follows redirects without a policy for the
  custom `ChatGPT-Account-ID` and `x-api-key` headers.

## Threat model and invariants

### In scope

- A model emits an adversarial shell command, tool input, file content, tool
  output, agent description, provider error, or path.
- The desktop process contains ambient credentials or injection variables that
  must not become child-process input.
- A previously trusted phone is buggy or malicious and sends oversized,
  malformed, or reflective identifiers.
- Existing settings contain permissive legacy defaults, aliases, wildcard rules,
  shell rules, Auto, or Bypass.
- A provider or intermediary returns an unbounded body or redirects a
  credentialed request across origins.
- A future tool author forgets to classify a new operation.

### Non-negotiable invariants

- No app-owned child receives an environment variable merely because Portcode
  inherited it.
- Raw internal tool input/output is never a Phone Sync frame source.
- Every outbound arbitrary string is redacted, control-normalized, UTF-8 safely
  bounded, and subject to a final serialized-size assertion.
- Live and historical phone views apply the same projection.
- Projection failure drops or substitutes safe static content; it never falls
  back to the raw value.
- A new internal stream variant fails compilation until its phone behavior is
  reviewed explicitly.
- Cancellation and Plan cannot be weakened by any persisted rule or mode.
- Protected actions can resolve only to Ask or Deny before the one-shot response.
- Frontend behavior is advisory; Rust remains authoritative if a client forges a
  remembered approval.
- A pre-commit policy-save failure changes neither disk nor in-memory policy; a
  visible post-commit candidate is reflected in memory and reported as
  durability-unconfirmed rather than misclassified as unchanged or successful.
- Cross-origin credential redirects are rejected before another origin receives
  headers or a replayed body.

### Explicit non-goals

- A filesystem or network sandbox for approved shell commands. Shell remains
  workspace-rooted by `cwd`, not contained; absolute paths and network access are
  possible after explicit approval.
- Complete descendant-process termination. Job Objects/process groups belong in
  deterministic desktop acceptance unless a safe abstraction lands here.
- Passing ambient GitHub, registry, SSH-agent, proxy, or package-manager
  credentials to agent processes. Future authenticated operations need typed,
  separately approved brokers.
- Replacing dependency-owned browser openers, crash-monitor re-exec, Tauri
  relaunch, or the signed updater. Their environment needs are recorded as
  lifecycle exceptions and are not copied into the agent allowlist.
- Physical-device trust/SAS acceptance, Android/iOS correctness, signed release,
  live Anthropic acceptance, or OpenAI broad-release approval.
- Delivery acknowledgement/replay for a phone permission response. The current
  command channel confirms enqueue, not desktop receipt; a link loss can leave a
  gate pending until it is resolved or cancelled on the desktop. Reliable ack,
  reconnect replay, and physical-device evidence remain in the Android/iOS
  correctness plans.

## Subprocess environment design

Add one desktop module that accepts a test-injected source environment and
applies a `ChildKind` policy with `env_clear()` before any reviewed variables are
added. The initial kinds are `AgentShell` and `ReadOnlyGit`.

Exact-name common candidates are limited to:

- execution/home/temp: `PATH`, `HOME`, `TMPDIR`, `TMP`, and `TEMP`;
- locale/terminal: `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `TERM`,
  `COLORTERM`, and `NO_COLOR`;
- Unix desktop storage: `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, and
  `XDG_STATE_HOME`;
- Windows runtime/user storage: `SystemRoot`, `WINDIR`, `PATHEXT`, `USERPROFILE`,
  `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, and the
  exact Program Files variables;
- path-only toolchain roots, retained only when absolute: `CARGO_HOME`,
  `RUSTUP_HOME`, `PNPM_HOME`, `COREPACK_HOME`, `VOLTA_HOME`, `NVM_HOME`,
  `NVM_SYMLINK`, `JAVA_HOME`, `GRADLE_USER_HOME`, `ANDROID_HOME`,
  `ANDROID_SDK_ROOT`, `DOTNET_ROOT`, `GOPATH`, `GOROOT`, `VIRTUAL_ENV`, and
  `CONDA_PREFIX`.

Windows names compare case-insensitively. `PATH` is rebuilt from bounded,
absolute, non-empty components; relative and empty entries are removed. Prefix
families such as `NPM_CONFIG_*` are forbidden because they can contain tokens.
Git receives the same minimal base, then only Portcode-owned
`GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, and `LC_ALL=C`.

Shell selection is platform-specific and deterministic: Windows system shells
resolve through an absolute trusted system path (or a discovered executable from
the sanitized absolute `PATH`), `cmd.exe` uses `/D /S /C`, and Unix defaults to
`/bin/sh -c`. Foreground and background commands share the same builder and a
bounded concurrent stdout/stderr drain that continues reading after the retained
prefix is full, preventing pipe deadlock and unbounded allocation.

## Phone-bound public schema

`SyncFrame` must embed public DTOs rather than the desktop's internal
`StreamEvent`, `SessionRow`, `MessageRow`, `Block`, and `TurnReceipt` types. The
JSON tags and required legacy fields remain compatible, but the Rust type system
prevents a raw internal value from being published accidentally.

The projector is exhaustive and has no wildcard arm. Its policy is:

| Internal data          | Phone representation                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| Turn IDs/timestamps    | Validated bounded identifiers and numeric timestamps                                       |
| Text deltas            | Cross-chunk credential-redacted, control-normalized, bounded text                          |
| Tool use               | Bounded ID + allowlisted name + empty input object                                         |
| Tool result            | Bounded ID + error flag + static completed/failed summary                                  |
| Permission request     | Bounded ID/tool/risk + bounded redacted summary; empty input; no raw diff                  |
| Usage                  | Existing bounded numeric counters                                                          |
| Turn end/error         | Allowlisted stop state, bounded public message, projected receipt                          |
| Agent lifecycle        | Bounded IDs, allowlisted status, bounded redacted label                                    |
| Background start/end   | Bounded ID/status/exit code and safe label/static summary; no raw output                   |
| Session                | Bounded title/branch and safe workspace label; no absolute workspace or account profile ID |
| Historical text        | Redacted and bounded                                                                       |
| Historical tool blocks | Empty input/static result, exactly like live projection                                    |
| Reasoning              | Omitted                                                                                    |
| Receipt                | No account profile ID; bounded safe paths and counts                                       |

The hub owns a small bounded per-session text holdback so a credential divided
across adjacent deltas is redacted before release. It flushes safe text in order
before non-text events and at terminal events. Every live frame has a conservative
public budget well below Noise's 65,519-byte plaintext limit. Catch-up and pages
project before framing and retain rows only within a deterministic encoded-byte
budget; an oversized row degrades to bounded static content instead of tearing
down the connection.

The public event enum includes a serde `Unknown` sink that clients ignore so an
unknown future public event does not terminate the receive loop. New public
behavior still requires a negotiated capability; this plan does not silently
send a new semantic variant to an old peer.

## Permission-risk design

Every `Tool` must implement a required classification:

```text
ReadOnly            no permission gate
Configurable        existing mode/rule behavior (write/edit)
Shell               one approval per call
DependencyInstall   one approval per call for future typed installers
HighRiskGit         one approval per call for future typed Git mutations
Unknown             fail-safe one approval per call
```

Current `run_command` is always `Shell`; therefore npm/pnpm/yarn/bun, pip/uv,
cargo install, shell-invoked Git, encoded commands, chained commands, and
background commands are covered without brittle command parsing. The current
native Git engine is read-only and outside the mutating gate. Future stage/
unstage or branch creation may be Configurable only after snapshot preconditions;
commit/amend, revert, worktree-changing checkout, branch deletion, push, PR
publication/merge, reset, clean, and rebase are HighRiskGit. Force push,
destructive clean, and hard reset remain refused until a separate safety design
exists.

Decision precedence is fixed:

1. cancellation → Deny;
2. Plan → Deny;
3. compute the compatibility outcome: Bypass allows ordinary actions while
   ignoring rules; otherwise first matching rule, then mode/default;
4. for Shell, DependencyInstall, HighRiskGit, or Unknown, clamp Allow to Ask while
   preserving Ask and Deny;
5. after a one-shot Allow, recheck cancellation immediately before execution.

The permission event carries the risk additively. Missing risk from an older core
is treated as legacy Configurable for decode compatibility; an unknown value is
non-rememberable and always-ask. The prompt hides “Always allow” for protected or
unknown risks and for every remote prompt. Store logic independently refuses to
persist those approvals. Historical protected Allow rules remain visible with an
“overridden by mandatory approval” explanation and can be removed, but new ones
cannot be created.

## Settings durability and compatibility

Keep all existing mode strings, rule ordering, legacy tool aliases, and stored
rules. Safety is a runtime clamp, so no destructive migration is required.

Settings updates use clone → patch/validate → atomic durable write → replace
in-memory state. The write uses a temporary subdirectory beneath the destination
parent, flushes the candidate, atomically replaces the destination, then fsyncs
the parent directory on Unix or uses `MOVEFILE_WRITE_THROUGH` on Windows.

Failures are stage-aware. A proven pre-commit failure leaves both current memory
and the prior file unchanged. If the destination already contains the exact
candidate bytes but the final durability barrier fails, the backend updates
memory to that visible candidate, returns a coded warning, and every direct
frontend save path reloads authoritative settings. An unreadable or externally
changed destination is reported as state-unknown and does not mutate the running
policy. Tests cover all three outcomes, retry confirmation, restart round-trip,
legacy JSON, and permissive old settings under the new floor.

## Credentialed HTTP boundary

The shared credential client follows only same-origin redirects, with a bounded
redirect count. Origin equality includes scheme, host, and effective port.
Cross-origin 301/302/303/307/308 responses fail without contacting the target;
this protects Authorization, `x-api-key`, `ChatGPT-Account-ID`, refresh tokens,
and request bodies. Credential header values are marked sensitive as an
additional logging defense.

Anthropic API and OAuth non-success handling uses status-derived public errors and
does not read provider bodies. Diagnostics, if later required, must be separately
bounded/redacted and local-only.

## Remote command validation

All phone-supplied session, agent, permission, and request identifiers use a
shared bounded safe-character validator before lookup or formatting. `Run` and
`FetchMessages` additionally require an authoritative existing database session
and publish only that stored ID. Invalid/unknown values cause no outbound frame
containing the supplied identifier and do not interrupt the next valid command.
User text and page parameters receive semantic bounds in addition to the encrypted
transport limit.

## Implementation slices

1. Add the process environment policy, deterministic shell launch, bounded child
   drains, native Git integration, and direct child-process tests.
2. Add public Phone Sync DTOs, exhaustive live/history projection, text holdback,
   byte-budget enforcement, identifier validation, and compatibility tests.
3. Add required tool risk classification, permission precedence/floor, additive
   event risk, frontend/store/Settings UX, and transactional Settings writes.
4. Harden provider/OAuth errors and credential redirect policy with adversarial
   local-server tests.
5. Run focused suites, then the complete Rust/frontend/WASM/build gates; update
   release/security/roadmap documentation only from proven evidence.

## Automated acceptance matrix

| Boundary              | Required proof                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent shell           | Only reviewed environment names survive; planted secrets/injection variables do not; cwd and execution still work                          |
| Native Git            | Same scrubbed base; ambient `GIT_*`, tokens, proxy and loader variables absent; typed read-only operations remain green                    |
| Child output          | Foreground/background stdout and stderr are drained with fixed memory and explicit truncation                                              |
| Tool registry         | Every registered tool has an explicit risk classification                                                                                  |
| Protected floor       | Every mode, legacy default, exact/wildcard/prefix rule, and alias can yield only Ask/Deny for protected actions                            |
| Plan/cancel           | Absolute Deny under every rule and risk                                                                                                    |
| Execution paths       | Root, nested/parallel subagent, background, and phone-driven runs share the same Rust gate                                                 |
| Prompt/store          | No remembered protected/remote approval; forged persistence attempt is inert; ordinary file remembrance still works                        |
| Settings              | Pre-commit failure leaves memory/disk unchanged; post-commit sync ambiguity reconciles and warns; durable save survives reload             |
| Live projection       | Fixtures for every internal event remove raw sentinels and credentials; local desktop still receives raw data                              |
| Cross-delta redaction | One credential split across adjacent deltas never appears in a hub frame                                                                   |
| History projection    | Catch-up/page removes reasoning, raw tool input/results, account IDs, absolute paths, and planted credentials                              |
| Frame budget          | Every public frame, including Unicode/path/result stress cases, stays below the configured and Noise limits                                |
| Wire compatibility    | Projected JSON decodes with a legacy-shape test; missing/unknown risk and unknown public events fail safe                                  |
| Remote reflection     | Oversized/control/colon identifiers cause no DB/process action or reflected frame; next valid command succeeds                             |
| Provider errors       | Endless/oversized non-success bodies return promptly and never appear in user or phone errors                                              |
| Redirects             | A second local origin receives no request, custom header, bearer/API key, refresh token, or body                                           |
| Full gates            | Format, clippy, Rust workspace tests, frontend lint/typecheck/coverage, desktop/web builds, WASM builds, artifact freshness, and GitHub CI |

## Acceptance checklist

- [x] Agent shell and native Git use the reviewed default-deny environment.
- [x] Foreground and background command output is memory-bounded.
- [x] Every registered tool is structurally classified.
- [x] Plan/cancel are absolute deny and protected actions always ask.
- [x] Protected/remote approvals cannot be remembered in UI, store, or backend.
- [x] Permission policy saves are transactional and durable.
- [x] Phone live events use public DTOs and never embed raw internal payloads.
- [x] Catch-up and pagination use the same public projection.
- [x] Every public arbitrary field is redacted/bounded and frames fit Noise.
- [x] Invalid remote identifiers cannot be reflected.
- [x] Provider error bodies are not reflected or read without bounds.
- [x] Credentialed redirects cannot cross origin.
- [x] Focused adversarial tests pass.
- [x] Full local release gates pass.
- [x] GitHub PR CI passes on the exact merge head.

## Manual and external evidence

Automated tests prove the boundary with synthetic secrets, malicious payloads,
local HTTP origins, and in-memory Phone Sync channels. The final local decision
smoke in the Rust suite checks that Auto and Bypass still prompt for protected
actions and that ordinary Accept Edits file approval retains its documented mode.

Permission responses currently have no delivery acknowledgement. If a phone link
drops after enqueue but before desktop resolution, the prompt can disappear on
the phone while the desktop gate remains pending; resolve or cancel it on the
desktop. Ack/replay is an Android/iOS protocol-correctness acceptance item, not a
security-authority or data-disclosure claim of this baseline.

This plan does not use self-dev mode. Physical phones, live provider credentials,
production signing, updater publication, and broad-release approval stay in their
existing later gates and must not be inferred from this PR.

## Acceptance evidence

### Local verification — 2026-07-21

- Frontend: Prettier, ESLint, TypeScript, desktop production build, web production
  build, and E2E TypeScript all passed. Vitest coverage passed 57 files / 1,650
  tests at 96.18% statements, 97.43% functions, and 98.02% lines.
- Rust: `cargo fmt --all -- --check`, strict workspace/all-target clippy, and 462
  workspace tests passed (404 desktop core + 58 shared sync).
- WASM: `portcode-sync` and `portcode-wasm` built for
  `wasm32-unknown-unknown`; strict target clippy passed; `wasm-pack 0.15.0`
  rebuilt the web package, and the locally generated package matched the
  then-committed files. The Linux CI freshness gate later detected
  JS/declaration drift and repaired it through the same-repository artifact job;
  see GitHub verification.
- Desktop journey: the isolated debug Tauri build launched successfully and the
  real WebView passed shell/title, Settings/model-listbox, close, composer draft,
  nested-list, Tab-escape, and no-fallback checks.
- Focused adversarial coverage includes planted child-process secrets, fixed-memory
  stdout/stderr drains, all permission modes/rules/aliases/risks, transactional
  Settings failure stages, every internal live event, cross-delta credentials,
  hostile history/Unicode/frame sizes, reflective identifiers, open-ended provider
  bodies, and cross-origin credential redirects. The aggregate Rust suite also
  passed the named Auto/Bypass protected-floor and Accept Edits file/shell cases.
- Mobile cfg audit found and repaired the shared scrubber boundary. Android-target
  checks for the new `atomicwrites` and `regex` dependencies passed; a full local
  app cross-check is unavailable because this machine has no Android NDK compiler,
  so the GitHub Android job remains the authoritative target proof.

### GitHub verification — 2026-07-21

- [Initial CI run 29778669443](https://github.com/porthex/portcode/actions/runs/29778669443)
  on source head `fe9a0a9` passed repository safety, both frontend legs, both
  Rust legs, and the WASM compile/clippy/build steps, but its final committed
  artifact freshness check correctly failed because the Linux-generated
  JS/declaration files had drifted.
- The same run's same-repository artifact job regenerated the package and pushed
  bot commit
  [`484c337`](https://github.com/porthex/portcode/commit/484c337eaeb1624b398ca2b39fef0a03cafe9496),
  including the JS/declaration contract and rebuilt WASM binary. The
  `GITHUB_TOKEN` push did not recursively run workflows, so that bot commit alone
  was not treated as acceptance evidence.
- A subsequent human-authored evidence commit on top of `484c337` re-triggered
  all workflows. [PR #131](https://github.com/porthex/portcode/pull/131) passed
  required CI, Android, and Tauri E2E checks on its exact merge head. The initial
  [Android run 29778669259](https://github.com/porthex/portcode/actions/runs/29778669259)
  and [E2E run 29778668877](https://github.com/porthex/portcode/actions/runs/29778668877)
  had also passed on source head `fe9a0a9`.
- Physical phones, live provider credentials, production signing/updater
  publication, and broad-release approval were intentionally unavailable and
  remain later roadmap gates. Remote permission-response acknowledgement and
  idempotent replay across link loss remain Android/iOS protocol-correctness
  work.

## Rollback

The changes are safe to roll back at the feature surface without reintroducing
raw transport or ambient credentials:

- keep public wire DTOs backward-decodable and retain old stored rules unchanged;
- disable Phone Sync publication if projection fails rather than falling back to
  internal events;
- preserve the environment allowlist and mandatory floor even if UX changes are
  reverted;
- keep the prior Settings file on proven pre-commit failure, and reconcile to an
  exact visible candidate while surfacing any unconfirmed durability barrier;
- reject credentialed redirects rather than retrying with a less restrictive
  client.

No rollback path may restore ambient environment inheritance, raw phone payloads,
unbounded provider-body reflection, or a remembered approval for a protected
action.
