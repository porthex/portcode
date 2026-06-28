# Security Policy

Portcode runs shell commands, edits files, and holds large-language-model API
keys. We take security reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Report privately through GitHub Private Vulnerability Reporting.** On this
repository, open the **Security** tab and click **“Report a vulnerability”** to
start a private advisory:

<https://github.com/porthex/portcode/security/advisories/new>

That channel is the only supported way to report a vulnerability. Please **do
not** open a public issue, pull request, or Discussion for a suspected
vulnerability, and do not disclose it publicly until we have published a fix and
an advisory.

There is no security email at this time — GitHub Private Vulnerability Reporting
is intentionally the single intake channel. (A dedicated `security@` alias may be
added later; this document will be updated if so.)

### What to include

To help us triage quickly, please include as much as you can:

- A description of the vulnerability and its impact.
- Portcode version, Windows build (`winver`), and WebView2 runtime version.
- Step-by-step reproduction, ideally with a minimal proof of concept.
- Whether a `shell` command, a file write/edit, or an API key was involved.
- Any logs or screenshots — with secrets and API keys redacted.

## Our response

- **Acknowledgement:** within **14 days** of your report.
- **Assessment & updates:** we will confirm the issue, keep you informed of
  progress, and agree on a disclosure timeline with you.
- **Credit:** with your permission, we will credit you in the published advisory.

We follow coordinated disclosure and ask that you give us a reasonable window to
ship a fix before any public disclosure.

## Supported versions

Portcode is pre-1.0 and ships frequently. Only the **latest released version**
receives security fixes; please update before reporting.

| Version              | Supported |
| -------------------- | --------- |
| Latest `0.x` release | ✅        |
| Older releases       | ❌        |

## Threat model — what is in scope

Portcode’s security posture rests on a few load-bearing boundaries. A report
that demonstrates breaking one of these is **in scope**:

- **Permission-gate bypass** — a mutating tool (`fs_write`, `fs_edit`, `shell`)
  executing without going through the `allow` / `ask` / `deny` gate.
- **Workspace-sandbox escape** — a file tool reading or writing outside the
  configured workspace root (path-traversal, symlink, or normalization bugs).
- **Unauthorized `shell` execution** — running a command without the gate, or a
  summary shown to the user that does not match what is executed.
- **Credential exfiltration** — extracting a stored secret (an API key _or_ a
  subscription OAuth token) from the Windows Credential Manager, from logs, from
  process memory exposed to the WebView, or via the IPC boundary.
- **Remote code execution** beyond the gate, including via the LLM/IPC path,
  `csp: null` in the WebView, or a malicious tool result/prompt-injection chain
  that reaches a mutating tool without user approval.

### Out of scope

- A user **explicitly approving** a destructive command at the permission prompt
  (the gate did its job — the human chose to proceed).
- Issues that require a pre-compromised machine, local administrator abuse, or a
  malicious Windows account already able to read the user’s Credential Manager.
- Vulnerabilities in third-party dependencies with no demonstrated impact on
  Portcode — please report those upstream (we track them via Dependabot).

## Phone Sync web client (browser)

Phone Sync lets you drive a desktop coding session from your phone. Alongside the
native mobile client there is a **browser-based web client** — a static PWA
(hosted on Vercel) that compiles the _same_ Rust Phone Sync protocol to WebAssembly
and dials your desktop over an iroh relay. See
[`docs/IOS_WEB_CLIENT_PLAN.md`](docs/IOS_WEB_CLIENT_PLAN.md) §5.10 for the full
design; the security-relevant model:

- **End-to-end encryption is preserved.** The Noise XX handshake +
  ChaCha20-Poly1305 transport runs **inside** the iroh QUIC stream. The relay —
  ours (self-hosted, `relay/`) or n0's public relays for the spike — only ever
  forwards **opaque ciphertext**. Because the browser compiles the **same `snow`
  crypto code** to wasm, there is no second crypto implementation to audit. The
  relay **holds no secrets** and learns nothing about your session.
- **SAS out-of-band verification** is unchanged and **mandatory** before a session
  is usable. After `connect()` resolves, the user compares the short
  authentication string against the desktop out-of-band and confirms; this defends
  against a man-in-the-middle at pairing time.
- **Trust-on-first-use + key pinning.** After SAS confirmation the desktop's
  static public key is **pinned in IndexedDB**. Reconnects use the Noise KK
  pattern against the pinned key and never re-prompt — and a **changed key
  hard-fails** rather than silently re-pairing. The desktop's own trust gate
  (`pairing_gate.rs`) still gates inbound devices; a browser client is just
  another pinned device.
- **The relay holds no secrets and needs no auth.** It is blind by construction
  (above), so a compromised or hostile relay can drop or delay traffic (denial of
  service) but **cannot read, forge, or inject** session content — the Noise
  session would reject it.

### New surface: browser storage & XSS

Running in a browser adds a surface the native desktop client does not have: the
pinned peer key and device identity live in **IndexedDB**, reachable by any script
that executes in the app's origin. The threat is **key exfiltration via XSS**.
Mitigations, all required before launch:

- **Strict Content-Security-Policy on the Vercel app** — no inline scripts, no
  `eval`, a tight `script-src`/`connect-src` allowlist (self + the relay WSS
  origin), `object-src 'none'`, `base-uri 'none'`. This is the primary XSS
  defense; pinned in `vercel.json` (no COOP/COEP needed — the wasm is
  single-threaded, no `SharedArrayBuffer`).
- **Subresource Integrity (SRI) on the wasm** and the JS glue, so a tampered
  CDN/build artifact cannot be substituted for the audited bundle.
- **No third-party scripts.** The PWA ships its own first-party code only — no
  analytics, no tag managers, no external script injection. This keeps the CSP
  allowlist tight and removes the most common XSS entry point.
- **Worst case is bounded.** Even if a key were exfiltrated, the attacker still
  faces the SAS verification at pairing and the desktop's per-device trust gate;
  a stolen pinned key lets an attacker impersonate _that_ phone to the desktop,
  which is why the desktop gate and a key-change hard-fail matter.

The relay deploy artifacts and runbook live in [`relay/`](relay/) and the
relay/version-lock posture is documented in
[`relay/README.md`](relay/README.md).

## Subscription sign-in (experimental)

As an alternative to an API key, Portcode can authenticate with an existing
**Claude Pro/Max subscription** via an OAuth Authorization-Code + PKCE flow
("**Sign in with Claude**"). A few security-relevant notes:

- **Token storage.** The sign-in yields an access token and a refresh token,
  stored together as a JSON blob in the **Windows Credential Manager** under the
  service `dev.porthex.portcode`, account `anthropic-oauth` — the same protected
  store used for API keys, never written to disk in plaintext. "Log out" deletes
  the entry. Access tokens are refreshed automatically when near expiry, under a
  single-flight lock so concurrent turns can't race the rotating refresh token.
- **Loopback redirect.** The browser redirect is caught by a one-shot listener
  bound to an OS-assigned ephemeral port on `127.0.0.1`; it accepts only
  `/callback` and validates the OAuth `state` (an independent 32-byte nonce, not
  the PKCE verifier) to reject forged callbacks. All OAuth HTTP happens in the
  Rust core, never the WebView.
- **Unofficial flow.** This is **not** an official, supported Anthropic
  integration API. The client id, endpoints, and the `anthropic-beta:
oauth-2025-04-20` request shape are reverse-engineered from the public Claude
  Code flow (cross-checked against the MIT-licensed opencode project) and may
  change or stop working without notice. Subscription requests also send the
  Claude Code identity as the first system block.
- **Terms of service.** Using a subscription this way may carry account / terms
  risk that an API key does not. You choose this mode explicitly; if in doubt,
  use a regular API key. Model availability and rate-limit behavior under a
  subscription can differ from the API.

## Privacy note

By default Portcode sends **no telemetry** and has no phone-home. Your prompts,
code, and keys (or subscription tokens) stay on your machine and only go to the
LLM provider you configured. Please keep that in mind when attaching reproduction
material.

### Crash reporting (opt-in, off by default)

Portcode includes an **optional** crash/error reporting capability to help fix
bugs. It is **off by default** and never reports unless BOTH are true:

1. you explicitly enable it (a one-time first-run prompt, or **Settings → Privacy**), and
2. the build was compiled with a reporting key (DSN).

The DSN is injected only into **official signed release builds** and is never
checked into the source tree, so development, contributor, and fork builds
**cannot report at all** — the pipeline is a compile-time no-op there.

When you do enable it:

- **Reports are scrubbed before they leave.** Each event is rebuilt from an
  allowlist of safe fields, then every surviving string is run through a secret
  redactor that strips `sk-ant-…`/`sk-…` API keys, OAuth/bearer tokens, emails,
  IP addresses, home-directory paths, and long key-shaped blobs. Breadcrumb
  payloads, request bodies, environment, local variables, and source context are
  dropped wholesale. **Your prompts, code, and file contents are not sent.**
- **Scope:** unexpected errors and crashes, plus sampled, scrubbed performance
  traces in the app window. Ordinary handled errors (network failures, denied
  permissions, bad input) are not reported.
- **Region:** events go to a **Sentry project hosted in the EU**.
- **Opting out is instant and total** — toggle it off in Settings and nothing
  further is sent.

**Native crashes on desktop include a memory snapshot.** To diagnose segfaults
and aborts the desktop captures a **minidump** — a snapshot of process memory at
the moment of the crash. The minidump is attached to the report and, unlike the
event fields above, **cannot be scrubbed**: it may contain fragments of whatever
was in memory, which can include secrets. It is still fully consent-gated — no
report (minidump included) is sent while reporting is off. Enable crash reporting
only if you accept that trade-off.
