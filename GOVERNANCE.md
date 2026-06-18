# Portcode Governance

This document explains **how Portcode is run**: who makes decisions, how you can
earn influence, what belongs in this open-source repository versus the reserved
commercial surface, and the project's standing positions on telemetry, the CLA,
and trust-boundary changes.

It complements—rather than repeats—the day-to-day contribution mechanics in
[CONTRIBUTING.md](CONTRIBUTING.md) and the conduct expectations in
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---

## Governance model

Portcode is an **open-source project developed and commercially funded by
Porthex**. It currently follows a **single-vendor / benevolent-dictator (BDFL)**
model: Porthex's maintainers are the final decision-makers and are accountable
for the project's direction, quality, and security.

We chose this model deliberately for a young, security-sensitive tool that runs
shell commands and holds API keys: clear ownership keeps the trust boundary
coherent. As the contributor community grows, we expect governance to become
more shared (for example, adding maintainers from outside Porthex and formalizing
a maintainers' council). Changes to this model will be made openly and recorded
here.

---

## Roles

| Role                       | Who                                 | What they can do                                                                |
| -------------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| **User / contributor**     | Anyone                              | File issues, join Discussions, open pull requests.                              |
| **Triager**                | Trusted contributors                | Label, triage, and reproduce issues; help shepherd PRs.                         |
| **Maintainer**             | Porthex team + invited contributors | Review and merge PRs, cut releases, own security-critical paths, set direction. |
| **Lead maintainer (BDFL)** | Porthex                             | Final decision when consensus is not reached.                                   |

### Earning triage and commit rights

Influence is earned through a **track record of good contributions**, not
applications. A typical path:

1. Contribute quality PRs, reviews, and issue triage over time.
2. A maintainer proposes you for **triager** rights (issue/PR triage, labeling).
3. Sustained, high-trust contribution—especially careful work near the security
   boundary—can lead to a **maintainer** invitation, with merge rights and
   `CODEOWNERS` entries.

There is no fixed quota or timeline; the bar is trust and demonstrated judgment,
weighted heavily for changes that touch the permission gate, secrets handling,
the `shell` path, the provider/LLM code, and the release/signing pipeline.

---

## How decisions are made

- **Most changes**: decided in the open on the issue or pull request. Maintainers
  seek rough consensus; for routine work, one maintainer approval is enough (see
  CONTRIBUTING.md → _Review and merge_).
- **Security-critical paths**: the permission gate, the workspace sandbox,
  secrets/credential handling, the `shell` execution path, the provider/LLM
  abstraction, the Tauri IPC/CSP configuration, and the release/signing
  workflows require the **maintainers specifically** (enforced via
  [`.github/CODEOWNERS`](.github/CODEOWNERS)) and may require two approvals.
- **Disagreements**: if consensus is not reached, the **lead maintainer decides**,
  and records the rationale on the thread.

### Lightweight RFCs for trust-boundary changes

Changes that alter a **trust boundary or a core abstraction** should start as a
short written proposal (an issue or Discussion labeled as an RFC) **before** a
large PR, so the design can be reviewed first. This applies to, for example:

- The **permission policy** (the `allow` / `ask` / `deny` model, "always allow"
  scope, or what counts as a mutating tool).
- The **workspace sandbox** / path-resolution rules.
- The **provider abstraction** (the `Provider` trait) and how BYOK keys are
  stored and used.
- The **auto-updater** and the release/signing model.
- The **IPC surface** and the WebView CSP posture.

Small, obvious fixes do not need an RFC—use judgment, and a maintainer will ask
for one if a change turns out to be load-bearing.

---

## Project scope — open core vs. reserved

Portcode is developed in the open, while some adjacent products are reserved for
Porthex's commercial offering. Stating this up front keeps contributions from
being rejected after the fact. (See also CONTRIBUTING.md → _Project scope_.)

**In this open-source repository:**

- The **agent loop** and its tools.
- The local **permission engine** and **workspace sandbox**.
- **BYOK / credential handling**, kept **provider-agnostic** (Anthropic today;
  OpenAI/Codex, Gemini, local, and custom providers planned via the `Provider`
  trait).
- The **React/TypeScript UI** and **Windows packaging**.
- The eventual **`portcode-core`** crate, the **CLI**, the **editor extension**,
  and the **embeddable SDK** as those surfaces land.

**Reserved for Porthex's commercial offering:**

- Fleet/organization **policy enforcement** and the **admin console**.
- A **managed BYOK gateway** / centralized inference service.
- **Audit-log retention** services.
- Enterprise **distribution artifacts** (e.g. MSI/Intune/ADMX/winget packaging).

A feature being "reserved" does not mean the open core is crippled to sell the
commercial product; the local engine that ships here is the real thing.

---

## Telemetry stance

**Portcode ships with no telemetry and no phone-home today.** Your prompts, code,
and keys stay on your machine and go only to the LLM provider you configured with
your own key.

We are not promising "never." If a usage signal is ever added, it will be
**strictly opt-in (off by default), clearly documented, and accompanied by a
privacy policy and a documented data pipeline.** Pull requests that add telemetry
or phone-home behavior **outside that agreed design will be declined.** Any such
change is a trust-boundary change and follows the RFC process above, with updates
to [SECURITY.md](SECURITY.md) and this document.

---

## Licensing and the CLA

Portcode is licensed under **Apache-2.0** (an OSI-approved license). Contributions
are accepted under a **Contributor License Agreement** ([CLA.md](CLA.md)),
enforced as a required check via CLA Assistant Lite.

We use a CLA rather than a DCO sign-off because the CLA grants Porthex the
copyright and patent licenses needed to ship and maintain Portcode **and**
preserves the ability to relicense in the future (for example, adopting a
source-available license such as the FSL if verbatim cloning ever became a real
threat). A DCO certifies origin but does **not** grant relicensing rights, so it
would not support this option. You keep ownership of your contributions; the CLA
simply grants the licenses the project needs.

---

## Third-party plugins

A third-party plugin API is **deferred**. Allowing external code to run inside a
shell-executing, key-holding agent is a significant security undertaking (it
needs a plugin trust/sandbox model), so it is intentionally out of scope for now
and tracked in the roadmap. Until then, extend Portcode by contributing to the
core—most notably by adding LLM providers through the `Provider` trait.

---

## Code of Conduct

All participation is governed by the
[Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). Enforcement reports
are handled privately through **GitHub's Private Vulnerability Reporting** on this
repository (there is no contact email at this time; a dedicated alias may be added
later).

---

## Changing this document

Governance evolves with the project. Proposed changes go through a pull request
like any other change; substantive changes (roles, decision rights, scope, the
telemetry or CLA stance) are treated as trust-boundary changes and are decided by
the maintainers, with the rationale recorded in the PR.
