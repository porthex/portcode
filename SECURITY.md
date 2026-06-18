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
- **API-key exfiltration** — extracting a stored key (any provider) from the
  Windows Credential Manager, from logs, from process memory exposed to the
  WebView, or via the IPC boundary.
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

## Privacy note

Portcode sends **no telemetry** and has no phone-home. Your prompts, code, and
keys stay on your machine and only go to the LLM provider you configured with
your own key. Please keep that in mind when attaching reproduction material.
