# OpenAI subscription integration

- Status: architecture and protocol reference
- Research date: 2026-07-18
- OpenAI Codex source snapshot: [`23899f7cb63a1510e53fddd68740dfc325853e3b`](https://github.com/openai/codex/commit/23899f7cb63a1510e53fddd68740dfc325853e3b)

This document describes how Portcode can add a ChatGPT subscription-backed OpenAI provider while retaining Portcode's own agent loop, tools, prompts, storage, and UI. It is not a plan to embed, copy, or reimplement the Codex agent.

Labels used below:

- **Official**: behavior documented by OpenAI or present in the pinned OpenAI Codex source.
- **Portcode**: behavior observed in this repository.
- **Recommendation**: our design conclusion; it is not an OpenAI compatibility promise.

## Decision summary

1. Add an `openai` provider (presented to users as “OpenAI / ChatGPT subscription”) behind a narrow transport boundary. Keep `agent.rs` in charge of the turn/tool loop and map Portcode's existing tool schemas into Responses API function tools.
2. Discover models and their reasoning levels from the authenticated server catalog. Preserve the advertised reasoning-level order and default instead of hard-coding a model matrix.
3. Persist the OpenAI-native continuation items Portcode needs in their original order. The initial implementation extends the canonical block vocabulary with an opaque `Reasoning` block (including its source model), so encrypted reasoning can replay around existing function-call/result blocks without reaching the UI or Phone Sync. If the transport begins returning additional stateful output-item types, graduate this into a lossless provider sidecar rather than synthesizing unknown items.
4. Keep the direct ChatGPT transport feature-gated and easy to disable. The public Codex client proves how the official client currently talks to `chatgpt.com/backend-api/codex`; it does not establish a stable, supported third-party API contract for Portcode.
5. Seek confirmation from OpenAI before broadly distributing the direct path, especially for Enterprise workspaces and compliance-log attribution. Do not spoof Codex identity, copy Codex prompts/tools, or market subscription access as ordinary OpenAI Platform API access.

## Scope and non-goals

In scope:

- ChatGPT browser sign-in with OAuth authorization code + PKCE.
- Subscription/workspace entitlement and account display.
- Dynamic model selection and per-model reasoning effort.
- Streaming text, function calls, token usage, errors, and rate-limit UX.
- Automatic, single-flight token refresh and explicit sign-out.
- Preservation of Portcode's current prompt, tool executor, approvals, and conversation ownership.

Out of scope:

- Copying the Codex system prompt, built-in tool definitions, policy layer, rollout configuration, or agent engine.
- Replacing Portcode conversations with Codex threads.
- Treating a ChatGPT subscription as Platform API credits or silently falling back to metered API-key usage.
- Assuming every ChatGPT plan or workspace has a Codex entitlement.

## Supported boundary versus direct boundary

### OpenAI app-server

**Official.** `codex app-server` is the documented integration surface for rich clients. It owns ChatGPT authentication, token refresh, model listing, threads, approvals, events, and account rate-limit notifications. `account/login/start` returns an `authUrl`; `model/list` returns model and reasoning metadata. OpenAI describes ChatGPT-managed sign-in as the recommended authentication path. See the [app-server README](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/app-server/README.md) and [app-server documentation](https://learn.chatgpt.com/docs/app-server.md).

**Recommendation.** Do not ask app-server to run Portcode turns for this feature. That would move conversation and agent semantics into Codex, contrary to this feature's scope. App-server also does not document an interface that hands its managed access token to a third-party raw Responses client.

### Direct subscription transport

**Official.** The open-source Codex client currently uses ChatGPT OAuth credentials with the Responses wire format at `https://chatgpt.com/backend-api/codex`. The implementation details below are pinned to the source snapshot above; the base-URL selection is in [`model-provider-info/src/lib.rs`](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/model-provider-info/src/lib.rs).

**Recommendation / compatibility risk.** A Portcode provider that uses that transport is the only currently visible way to combine subscription authentication with Portcode's own agent loop, but the endpoint, shared OAuth client ID, allowed callbacks, headers, and response extensions are not documented as a stable general-purpose third-party contract. Keep the implementation isolated, versioned, observable without logging secrets, fixture-tested, feature-gated, and remotely disableable. Obtain OpenAI approval/support before broad release. This document makes no claim about contractual authorization.

### Release capability gate

The direct subscription transport is enabled automatically in debug builds for local self-development. Release builds fail closed unless the builder explicitly sets `PORTCODE_ENABLE_OPENAI_SUBSCRIPTION=1` while compiling. A deployment or local operator can disable an otherwise-enabled build at runtime by setting `PORTCODE_DISABLE_OPENAI_SUBSCRIPTION=1`; the disable override always wins.

The gate covers browser login/token exchange, refresh, model discovery, Responses inference, and subscription usage requests. Logout remains available so a disabled build can still erase stored credentials. The OpenAI OAuth status response exposes `available` and `unavailableReason`; while disabled it also reports `signedIn: false` and omits stored account metadata so the UI can hide unusable controls without implying that the credential was deleted.

## Portcode integration seams

**Portcode.** The existing architecture is already close to the right runtime boundary:

- `src-tauri/src/llm.rs` defines `LlmProvider::stream_turn` and an Anthropic provider.
- `src-tauri/src/agent.rs` owns the multi-turn tool loop and tool execution.
- `src-tauri/src/oauth.rs` has a browser OAuth + PKCE implementation for Anthropic.
- `src-tauri/src/secrets.rs` stores an OAuth credential blob.
- `src/components/Composer.tsx` (its `ModelPicker`) and the model/settings stores own provider/model selection.

The following seams need widening rather than special-casing Anthropic:

- Provider-specific credential variants and secret keys. OpenAI needs an ID token, access token, refresh token, derived account ID, FedRAMP flag, plan, email, and refresh metadata. Do not overwrite or reinterpret the existing Anthropic secret.
- Provider-scoped refresh locks. Preserve the existing single-flight behavior, but key it by provider/account.
- Provider-specific model catalogs, reasoning effort, and catalog refresh state.
- Provider-native conversation state. The initial implementation stores required encrypted reasoning as an ordered opaque canonical block next to the existing function-call/result blocks, and tags it with the source model so it is not replayed across an incompatible model switch. A raw-item sidecar/table remains the forward-compatible escalation path if future Responses output types cannot be represented losslessly this way.
- Provider-specific error and usage normalization into stable UI events.

The provider adapter should be the only layer that knows OpenAI response-item shapes. The rest of Portcode should continue to see text deltas, tool invocations, usage, normalized errors, and completion.

## OAuth and credentials

### Authorization request

**Official.** The current Codex browser flow in [`login/src/server.rs`](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/login/src/server.rs) uses:

- Issuer: `https://auth.openai.com`
- Authorization endpoint: `https://auth.openai.com/oauth/authorize`
- Loopback callback: `http://localhost:<port>/auth/callback`
- Preferred port `1455`, then fallback port `1457`
- PKCE `S256`
- A high-entropy, exactly validated `state`
- Current public client ID: `app_EMoamEEZ73f0CkXaXp7hrann`

Authorization query fields:

```text
response_type=code
client_id=<client id>
redirect_uri=http://localhost:<port>/auth/callback
scope=openid profile email offline_access api.connectors.read api.connectors.invoke
code_challenge=<base64url(sha256(verifier))>
code_challenge_method=S256
id_token_add_organizations=true
codex_cli_simplified_flow=true
state=<random state>
originator=<honest client originator>
```

`allowed_workspace_id=<comma-separated workspace IDs>` is optional in the official client.

The PKCE verifier is generated from 64 random bytes and base64url-encoded without padding; see [`pkce.rs`](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/login/src/pkce.rs).

**Recommendation.** Do not reuse Portcode's current ephemeral-port assumption. The official source says callback ports must stay synchronized with the authorization server's allow-list. Bind loopback only, try the registered ports, validate `state` before exchanging the code, bound request sizes, impose a login timeout, and support cancellation. State and PKCE mitigate callback-port interception, but a busy allowed port should fail safely.

The current client ID and `originator` behavior are implementation details. Portcode should identify itself honestly and should not pretend to be the Codex CLI. Confirmation from OpenAI is required before treating the shared public client registration as a supported production integration.

### Code exchange

**Official.** POST `https://auth.openai.com/oauth/token` with `Content-Type: application/x-www-form-urlencoded`:

```text
grant_type=authorization_code
code=<authorization code>
redirect_uri=<exact callback URI>
client_id=<client id>
code_verifier=<PKCE verifier>
```

The successful response requires `id_token`, `access_token`, and `refresh_token`. A callback error containing `missing_codex_entitlement` should become a specific workspace-admin message, not a generic network failure.

### ID-token claims

**Official.** The current decoder in [`token_data.rs`](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/login/src/token_data.rs) reads:

- Email from the top-level claim or `https://api.openai.com/profile.email`.
- `https://api.openai.com/auth.chatgpt_plan_type`.
- `https://api.openai.com/auth.chatgpt_user_id`, with `user_id` as fallback.
- `https://api.openai.com/auth.chatgpt_account_id`.
- `https://api.openai.com/auth.chatgpt_account_is_fedramp`.

Known plan strings include `free`, `plus`, `pro`, `business`, `enterprise`, and `edu`, but backend values can evolve.

**Recommendation.** Treat the plan as display metadata, preserve unknown values, and never use a locally decoded claim as Portcode authorization. Store the account ID needed for request routing. Do not expose the raw JWT to the frontend.

### Refresh and 401 recovery

**Official.** Current refresh behavior in [`auth/manager.rs`](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/login/src/auth/manager.rs) is:

- POST `https://auth.openai.com/oauth/token` with `Content-Type: application/json`.
- Body: `{ "client_id": ..., "grant_type": "refresh_token", "refresh_token": ... }`.
- `id_token`, `access_token`, and `refresh_token` in the response are independently optional. Retain old values for absent fields and persist a rotated refresh token when present.
- Refresh proactively when the access JWT expires within five minutes. If it has no usable expiry, the official client uses an eight-day last-refresh fallback.
- Serialize refreshes. On a 401, reload credentials, ensure they still belong to the same account, and refresh once only if another request has not already replaced the token.
- `refresh_token_expired`, `refresh_token_reused`, and `refresh_token_invalidated` are permanent re-authentication failures. Other failures are treated as transient unless the HTTP status establishes otherwise.

**Recommendation.** Persist the complete rotated credential atomically before waking waiters. Cache a permanent refresh failure only for the unchanged credential generation. Never loop refresh on repeated 401s. If account identity changes during recovery, cancel/restart the affected turn rather than sending history under a different account.

On logout, clear local credentials and perform the current official client's best-effort token revocation behavior where supported. Local clearing must still succeed if revocation is offline.

### Storage

Store access, refresh, and ID tokens only in the backend secret store. Derive and expose only the minimum account status needed by the UI. Use an OpenAI-specific secret name and schema version so Anthropic credentials cannot be corrupted by migration.

On Windows, the serialized token set is base64-encoded and split across versioned Credential Manager entries that remain below the platform's per-entry UTF-16 limit. An alternating-slot manifest makes updates atomic: write the inactive slot completely, switch the manifest, then clean the previous slot. Other targets keep the same public secret-store API.

The secret schema should retain at least:

```text
access_token
refresh_token
id_token
expires_at or decoded access-token expiry
last_refresh_at
account_id
user_id (optional)
email (optional display field)
plan (unknown-string capable)
is_fedramp
credential_generation/schema_version
```

## Authenticated request headers

**Official.** For ChatGPT-authenticated requests, the current bearer provider in [`bearer_auth_provider.rs`](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/model-provider/src/bearer_auth_provider.rs) supplies:

```http
Authorization: Bearer <access token>
ChatGPT-Account-ID: <chatgpt_account_id>
X-OpenAI-Fedramp: true     # only when the claim is true
```

Responses streaming also needs `Content-Type: application/json` and `Accept: text/event-stream`.

The official Codex client adds identity, version, request/session/thread, installation, and turn-state metadata. Some may affect diagnostics or routing, but their minimum contract for a third-party client is not publicly specified. Do not spoof Codex values. In particular, `x-codex-turn-state` is sticky state returned by the service and replayed only within the same turn, never across turns; support it only if the direct transport actually receives it and OpenAI confirms the behavior for Portcode.

## Model discovery and reasoning effort

### Catalog request

**Official.** [`endpoint/models.rs`](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/codex-api/src/endpoint/models.rs) requests:

```http
GET https://chatgpt.com/backend-api/codex/models?client_version=<Portcode protocol version>
```

using the same authenticated headers. The body is `{ "models": [...] }`; the response may include `ETag`.

The current [`ModelInfo`](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/protocol/src/openai_models.rs) includes, among other fields:

- `slug`, display name, description, priority, and visibility (`list`, `hide`, or `none`).
- Default and supported reasoning levels, each with a description.
- API support, tool/shell behavior, context-window and output-token limits.
- Reasoning-summary, verbosity, parallel-tool, modality, service-tier, and upgrade metadata.

The app-server's normalized `model/list` response similarly exposes the model ID, display name, hidden flag, default reasoning effort, supported reasoning efforts, modalities, and defaults. It explicitly preserves the server's reasoning-effort order.

### Picker behavior

**Recommendation.** The picker should:

- Show models with list visibility and preserve server ordering/priority.
- Preserve each model's advertised reasoning-effort order. Never alphabetize it.
- Select the advertised default effort on first use.
- Store model + effort per conversation, while retaining a user default for new conversations.
- If a cached effort is no longer supported, reset to the server default and tell the user once.
- Cache the last successful catalog with its ETag and retrieval time, but show a clear stale/offline state.
- Tolerate unknown model fields, visibility values, plan strings, reasoning-effort strings, and future enum additions.
- Disable send with an actionable state if there is no entitled model, rather than guessing a slug.

Current official Platform guidance resolves the general default to GPT-5.6 Sol, and current GPT-5.6 API docs describe `none`, `low`, `medium`, `high`, `xhigh`, and `max`, with `medium` as default. That is context, not a picker allow-list. Subscription models must use their own authenticated catalog; the protocol also permits other/unknown effort values. See the [current model guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6#migrate-to-gpt-56).

Changing model mid-conversation is a compatibility boundary. The safest UX is a new conversation. If switching in place is allowed, the provider must not replay model-specific opaque reasoning items to an incompatible model without an explicit, tested policy.

## Responses request

**Official.** The current Codex client sends `POST https://chatgpt.com/backend-api/codex/responses`. Its request shape, defined across [`core/src/client.rs`](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/core/src/client.rs) and [`codex-api/src/common.rs`](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/codex-api/src/common.rs), includes:

```json
{
  "model": "<catalog slug>",
  "instructions": "<Portcode system instructions>",
  "input": ["<ordered response input items>"],
  "tools": ["<Portcode function-tool definitions>"],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": {
    "effort": "<advertised effort>",
    "summary": "<optional supported setting>"
  },
  "store": false,
  "stream": true,
  "include": ["reasoning.encrypted_content"]
}
```

Optional fields supported by the current wire include text configuration, service tier, stream options, prompt-cache key, and client metadata. Add them only for a concrete Portcode feature, not merely to mimic Codex.

Set `parallel_tool_calls` only when the selected model advertises support and Portcode can safely execute/approve the calls independently; the literal `true` above illustrates the current request field, not a universal model capability.

The function-tool mapping is mechanical:

```json
{
  "type": "function",
  "name": "<existing Portcode tool name>",
  "description": "<existing Portcode description>",
  "parameters": { "type": "object", "properties": {} },
  "strict": false
}
```

`parameters` above is Portcode's existing complete JSON Schema; the empty `properties` object is only a placeholder. Do not import Codex shell, patch, search, or policy tools. A returned function-call `call_id` maps to Portcode's tool-use ID. The follow-up input item is `{ "type": "function_call_output", "call_id": "<same id>", "output": "<string>" }`. Existing Portcode approval and execution paths remain authoritative.

### Full-history and reasoning replay

**Official.** OpenAI's [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) recommends passing reasoning items back with function calls and their outputs. For consecutive function calls, every response item since the last user message should remain in order and untouched. In stateless/ZDR-style operation, encrypted reasoning content allows that replay without exposing the chain of thought. The official Codex client explicitly requests `reasoning.encrypted_content` and sends `store: false`.

For Portcode, the next request must be assembled as an ordered sequence such as:

```text
user input
assistant output/reasoning items exactly as returned
function_call item(s)
function_call_output item(s), matched by call_id
subsequent assistant items
next user input
```

Do not reduce this sequence to text + tool blocks and later synthesize it. Do not decrypt, display, summarize, edit, merge, or reorder encrypted reasoning. It is opaque provider state.

**Portcode risk.** The canonical `ChatMessage` representation does not preserve every possible future OpenAI output item. The initial integration preserves the stateful items currently required for tool continuation—reasoning, function calls, and function-call outputs—in order, and writes them through the existing transactional message persistence. If OpenAI adds another stateful output type, add a provider-native turn sidecar/table or lossless serialized item ledger rather than discarding or reconstructing it. An app restart after a function call must produce the same replay as an uninterrupted process.

## Streaming and item assembly

**Official.** The Responses SSE parser in [`sse/responses.rs`](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/codex-api/src/sse/responses.rs) handles events including:

- `response.created`
- `response.output_item.added`
- `response.output_text.delta`
- `response.output_item.done`
- reasoning summary part/text deltas and completion
- reasoning text deltas
- `response.completed`
- `response.failed`
- `response.incomplete`
- top-level `error`

The public API reference also defines `response.function_call_arguments.delta` and `.done`. The current Codex parser treats the final `response.output_item.done.item` as the canonical complete function-call item; its tests confirm that function-argument deltas can be ignored for final assembly.

**Recommendation.** Use a turn-local state machine:

1. Parse SSE frames incrementally with bounded buffers and tolerate unknown event types.
2. Forward text deltas to the UI once.
3. Optionally use function-argument deltas for a progressive indicator only.
4. Commit the complete function call from `response.output_item.done`. Never append both accumulated deltas and the final arguments.
5. Keep multiple parallel calls separate by output item/call ID, not arrival order.
6. Persist every completed native item in server order.
7. Treat `response.completed` as the only successful terminal event. EOF without it, an idle timeout, `failed`, `incomplete`, or top-level `error` is not success.
8. Never surface raw reasoning text or encrypted reasoning content. A supported reasoning summary is a distinct, optional user-facing artifact.

Usage on completion may contain:

```text
input_tokens
input_tokens_details.cached_tokens
output_tokens
output_tokens_details.reasoning_tokens
total_tokens
```

Normalize these into optional fields so missing subscription usage does not fail the turn.

## Errors, retries, and rate limits

### Response errors

**Official.** The current error mapping recognizes:

- `context_length_exceeded`: fatal for the current request; offer a new/compacted conversation.
- `insufficient_quota`: fatal account/quota state; do not retry in a loop.
- `rate_limit_exceeded`: retryable; the service message may include a delay.
- `server_is_overloaded` / `slow_down`: retryable with bounded backoff.
- `invalid_prompt`, `bio_policy`, `cyber_policy`: non-generic policy/request failures.
- `usage_not_included`: usage unavailable rather than necessarily a failed answer.
- `response.incomplete`: report `incomplete_details.reason`, such as a maximum-output-token limit.

The official client uses bounded request retries, bounded stream reconnects, and a five-minute stream idle timeout. Portcode should choose its own smaller UX-appropriate bounds, use jitter, honor server delay/reset hints, and remain cancellation-aware. Never retry a completed tool invocation blindly; reconnect/retry logic must be idempotent at the response-item boundary.

401 handling is the single refresh-and-retry path described earlier. 403 should distinguish missing entitlement/workspace restrictions where the response allows it. 429 should preserve the user's draft and display the reset window instead of suggesting that their Platform billing is at fault.

### Subscription rate-limit UX

**Official.** App-server exposes `account/rateLimits/read` and sparse `account/rateLimits/updated` notifications with primary/secondary windows, used percentage, duration, reset time, reached type, and credit state. The underlying ChatGPT responses may expose corresponding `x-codex-*` rate-limit and credit headers; see [`rate_limits.rs`](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/codex-api/src/rate_limits.rs).

**Recommendation.** If the direct path parses those headers, keep the parser optional and forward-compatible because they are backend-specific. Merge sparse updates; do not erase a previously known field merely because the next response omits it. Show:

- the limiting window and reset time in the user's local timezone;
- whether a retry is automatic and cancelable;
- a distinct re-authentication, entitlement, plan-limit, and transient-service state;
- cached rate-limit information as stale rather than current.

Do not present subscription usage as dollar-denominated Platform API spend.

## Security, privacy, and compliance

### Redaction

**Official.** The login implementation explicitly redacts credentials and callback secrets. Portcode logs, telemetry, crash reports, and support bundles must never contain:

- authorization codes, state, or PKCE verifier;
- access, refresh, or ID tokens, including HTTP headers;
- callback query strings or URL fragments;
- account/user IDs unless deliberately pseudonymized for a documented purpose;
- `reasoning.encrypted_content` or raw reasoning text;
- tool outputs already covered by Portcode's existing sensitive-data rules.

Redact by structured field name before formatting. Include at least `access_token`, `api_key`, `client_secret`, `code`, `code_verifier`, `id_token`, `refresh_token`, `requested_token`, `state`, `subject_token`, `token`, and `Authorization`. Treat encrypted reasoning as sensitive opaque content even though Portcode cannot read it.

### Data handling

**Official.** ChatGPT sign-in follows the user's ChatGPT workspace role, retention, residency, and related administrative controls; API-key usage follows the Platform organization instead. The official authentication guide distinguishes these two data/billing domains: [Codex authentication](https://learn.chatgpt.com/docs/auth.md).

**Recommendation.** Label the provider “OpenAI subscription” or “ChatGPT subscription,” not “OpenAI API.” Explain which signed-in workspace is active. The direct integration must not weaken workspace controls, cross account histories, or silently send a subscription conversation through an API key.

App-server states that client identity participates in Compliance Logs and asks Enterprise integrators to contact OpenAI about registering a known client name. That reinforces the need for an approved, honest Portcode client identity before enterprise release.

### Local persistence

- Keep tokens in the backend credential store; never browser local storage or frontend state.
- Restrict provider-native item storage and support-bundle export. Encrypted reasoning is replay state, not display data.
- Delete provider-native sidecars when the owning conversation is deleted.
- Logout should revoke where possible, clear tokens, invalidate model/rate-limit caches, and prevent queued requests from using the old credential generation.
- Do not allow OAuth response bodies, JWTs, or SSE frames to enter generic tracing.

## Compatibility guardrails

The direct transport should have:

- A dedicated `OpenAiSubscriptionTransport` module with no ChatGPT URLs or headers scattered through UI/agent code.
- A protocol version constant sent as Portcode's honest version, plus the pinned upstream source revision in developer diagnostics.
- JSON fixtures for authorization URL, exchange/refresh, model catalog, each terminal SSE state, parallel calls, encrypted reasoning replay, and unknown enum/event fields.
- A cached last-known-good model catalog with clear invalidation. Until that cache exists, keep any compatibility fallback explicit, versioned, and subordinate to every non-empty authenticated catalog; never present fallback presence as entitlement proof.
- A fast feature kill switch that does not affect Anthropic.
- Structured, secret-free counters for login stage, catalog failure category, terminal event, retry count, and protocol parse failure.
- Explicit product/legal review and an OpenAI contact before general availability.

Do not depend on:

- internal Codex prompt text or rollout model configuration;
- exact unknown JSON-field rejection behavior;
- a permanent shared client ID, backend base URL, header name, or callback allow-list;
- a static list of plan names, model slugs, reasoning efforts, or rate-limit headers;
- raw chain-of-thought visibility;
- Platform `previous_response_id` semantics when using the stateless ChatGPT transport.

## Implementation slices

1. **Domain/UI:** add provider identity, dynamic model catalog, reasoning effort, account status, and normalized error/rate-limit states without changing the agent loop.
2. **Credentials:** add provider-tagged OpenAI credentials, fixed-port PKCE login, claim parsing, atomic refresh rotation, single-flight 401 recovery, and logout.
3. **Catalog:** authenticated models fetch, forward-compatible decoding, ETag/cache behavior, and model/effort picker integration.
4. **Responses transport:** request mapping, SSE state machine, function-call assembly, usage/errors, cancellation, bounded retries, and no Codex tools/prompts.
5. **Persistence:** ordered encrypted-reasoning/function replay through canonical blocks, transactional association with visible messages/tool results, model-switch filtering, deletion, and a migration path to a raw-item ledger if future stateful item types require it.
6. **Hardening:** fixtures, redaction tests, entitlement/rate-limit UX, compatibility telemetry, feature gate, and OpenAI approval checkpoint.

## Test matrix

| Area            | Case                        | Required assertion                                                                                                                             |
| --------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth           | Authorization URL           | Exact registered callback, S256 challenge, scopes/flags, random state; no secret in logs.                                                      |
| OAuth           | Callback attack/error       | Wrong state, missing code, oversized request, timeout, cancel, busy ports, and `missing_codex_entitlement` all fail safely with distinct UX.   |
| Exchange        | Successful code exchange    | Form body is exact; all three initial tokens required; response is atomically persisted.                                                       |
| Refresh         | Rotation/concurrency        | Optional returned fields retain old values; rotated refresh token wins; concurrent callers produce one refresh.                                |
| Refresh         | Permanent/transient failure | Three permanent refresh codes require sign-in; transient failures do not delete usable credentials; repeated 401 retries once only.            |
| Claims          | Evolving JWT                | Email fallbacks, missing account ID, FedRAMP flag, unknown plan, and account change are handled without panic or cross-account retry.          |
| Catalog         | Discovery/cache             | Auth headers, client version, ETag/cache, list visibility, server order, unknown fields, empty catalog, and offline stale state.               |
| Reasoning       | Effort selection            | Advertised order/default preserved; unsupported saved value resets with notice; unknown effort round-trips.                                    |
| Text stream     | Happy path                  | Text deltas render once; usage is optional; success only follows `response.completed`.                                                         |
| Tool stream     | One/parallel calls          | Final `output_item.done` is canonical; deltas are not duplicated; calls remain separated by call ID; outputs match the same ID.                |
| Replay          | Reasoning/tool continuity   | Native items and encrypted content replay byte-for-byte in order across multiple tools and after process restart.                              |
| Persistence     | Crash boundaries            | Crash after call, tool result, or final item leaves a recoverable, non-duplicated ledger consistent with visible messages.                     |
| Terminal errors | SSE failures                | `failed`, `incomplete`, top-level error, malformed frame, EOF without completed, idle timeout, and cancellation normalize distinctly.          |
| Retry           | Safety                      | 401 refreshes once; 429/5xx back off with cancellation; a completed local tool is never executed twice by transport retry.                     |
| Account limits  | UX                          | Reset time/window/plan-limit state is clear; sparse headers merge; stale data is labeled; no Platform-spend language.                          |
| Privacy         | Redaction/deletion          | Tokens, callback fields, auth headers, JWTs, and encrypted reasoning are absent from logs/support bundles and removed with their conversation. |
| Regression      | Existing provider           | Anthropic login, picker, streaming, tool use, persistence, and cancellation remain unchanged.                                                  |
| Compatibility   | Unknown protocol data       | Unknown SSE events, JSON fields, plan/model/effort values, and missing optional usage do not break an otherwise valid turn.                    |

Per repository policy, Rust tests should run in CI rather than on a low-memory local machine. Any frontend changes must include matching tests and pass `pnpm test:coverage` before merge.

## Primary sources

- [Codex browser OAuth server and token exchange](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/login/src/server.rs)
- [Codex token parsing](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/login/src/token_data.rs)
- [Codex refresh manager](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/login/src/auth/manager.rs)
- [ChatGPT bearer/account headers](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/model-provider/src/bearer_auth_provider.rs)
- [Provider base URLs and retry defaults](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/model-provider-info/src/lib.rs)
- [Responses request construction](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/core/src/client.rs)
- [Models endpoint](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/codex-api/src/endpoint/models.rs) and [model protocol](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/protocol/src/openai_models.rs)
- [Responses SSE parser and fixtures](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/codex-api/src/sse/responses.rs)
- [ChatGPT rate-limit header parser](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/codex-api/src/rate_limits.rs)
- [Codex app-server protocol](https://github.com/openai/codex/blob/23899f7cb63a1510e53fddd68740dfc325853e3b/codex-rs/app-server/README.md)
- [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)
- [OpenAI current model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6)
- [Codex authentication and data-domain guidance](https://learn.chatgpt.com/docs/auth.md)
