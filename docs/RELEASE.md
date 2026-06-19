# Release runbook

How a signed Portcode release is cut, verified, rolled back, and set up the
first time. Portcode is a native Windows AI coding agent (Tauri v2 + Rust +
React, pnpm) shipped by **Porthex**.

> **Status — documents PR #8.** This runbook describes the signed-release
> pipeline added in **PR #8** (`feat/phase2-release-pipeline`,
> `.github/workflows/release.yml`). It is accurate **once PR #8 merges**. The
> three-file version sync it relies on is automated by **PR #5** (release-please).
> Until both land, treat the steps below as the target process.

> **Sensitivity — process only.** This document references secret **names** and
> steps. It contains **no** secret values, keys, certificates, tokens, or
> machine/infra paths, and must stay that way. All paths below are **relative to
> the repository root**.

---

## TL;DR — cut a release (happy path)

1. **Land your changes on `main`** with [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, …) so release-please can compute the next version.
2. **Merge the open release-please PR** (PR #5's bot). It bumps the version in all
   three files, updates `CHANGELOG.md`, and creates the **`vX.Y.Z` tag**.
3. The tag push triggers **`.github/workflows/release.yml`**, which builds the
   NSIS installer, **Authenticode-signs** it (Azure Trusted Signing),
   **updater-signs** it (Tauri Ed25519), generates **`latest.json`**, a
   **CycloneDX SBOM**, and **SHA-256 checksums**, then attaches them all to the
   GitHub Release.
4. **Verify** the signed build on a clean Windows VM (§9), then **publish** the
   release so `latest.json` goes live and auto-update switches on.

Everything below is the detail behind those four lines.

---

## 1. Versioning — the three files

A release version is kept in lockstep across **three** files:

| File | Field |
| --- | --- |
| `package.json` | `"version"` |
| `src-tauri/Cargo.toml` | `[package] version` |
| `src-tauri/tauri.conf.json` | `"version"` (the workflow reads the installed version from here) |

**These are bumped automatically by release-please (PR #5).** You do not edit
them by hand. release-please watches Conventional Commits on `main`, opens a
"release PR" that bumps all three files plus `CHANGELOG.md`, and — when that PR
is merged — creates the matching **`vX.Y.Z`** git tag. Merging the release PR
*is* how a release is cut; the tag is what triggers the build.

> If you ever need a manual bump, change the value in **all three** files
> identically (they must match) and commit them together. Prefer the
> release-please path.

### Lockfile state

The build runs `pnpm install --frozen-lockfile`, so the lockfiles must be
**committed and clean**:

- `pnpm-lock.yaml` — in sync with `package.json`, or the install **fails**.
- `Cargo.lock` — committed (this is an app, not a library).

A version-only bump doesn't change the dependency graph, so the lockfiles
usually don't move. If a release also pulls in dependency changes, regenerate and
commit the refreshed lockfiles **before** tagging. The SBOM step (§6) reads both
`pnpm-lock.yaml` and `Cargo.lock`, so stale lockfiles also produce a wrong SBOM.

---

## 2. How the pipeline is wired

`.github/workflows/release.yml` (added by PR #8):

- **Triggers** on `push` of a **`v*`** tag, and on **`workflow_dispatch`** (a
  manual, unpublished **dry run**). The heavy signed `tauri build` is kept **out**
  of per-PR CI (that stays in `ci.yml`) and runs **once per release**.
- Runs on **`windows-latest`**, in the protected **`release`** environment.
- Default permissions are least-privilege (`contents: read`); the release job
  opts up to `contents: write` only to create the Release and upload assets.
- **Every signing step is secret-gated.** Secrets are mirrored into job `env` so a
  step's `if:` can detect their *presence* without ever interpolating a value into
  a run-step (which could leak it to logs). **With no secrets configured the
  workflow still builds, produces a SBOM, and computes checksums — an UNSIGNED dry
  run.** It never hard-fails for missing secrets; a real signed release just
  additionally requires the `release` environment and its secrets.

### What the workflow does, in order

1. Checkout, enable Corepack/pnpm, set up Node 20, materialize the pinned Rust
   toolchain (`rust-toolchain.toml`), restore the cargo cache.
2. `pnpm install --frozen-lockfile`.
3. **Supply-chain audit** — `cargo-deny` (licenses · advisories · bans · sources),
   reading `deny.toml` at the repo root. Fails fast before build time.
4. **Build** — `pnpm app:build` → `tauri build` → **NSIS installer** (§3).
5. **Authenticode sign** the installer via Azure Trusted Signing (§4) — *gated*.
6. **Updater sign** the installer with `tauri signer sign` (§5) — *gated*, runs
   **after** Authenticode.
7. **SHA-256 checksums** over the final (post-sign) bytes → `SHA256SUMS.txt`.
8. **Updater manifest** `latest.json` (§5) — *gated*.
9. **CycloneDX SBOM** via `cdxgen` (§6) → `portcode.cdx.json`, then validated.
10. **Publish** assets to the GitHub Release on tag refs (§7); on a non-tag dry
    run, the same artifacts are uploaded as a workflow artifact
    (`portcode-unpublished`) for inspection instead.

---

## 3. Build → NSIS installer

```sh
pnpm install        # CI uses --frozen-lockfile
pnpm app:build      # = tauri build (runs `pnpm build` = tsc --noEmit && vite build, then bundles)
```

`src-tauri/tauri.conf.json` sets `bundle.targets` to **`["nsis"]`**, so the build
produces a single NSIS setup executable here (relative to repo root):

```
src-tauri/target/release/bundle/nsis/Portcode_<version>_x64-setup.exe
```

For NSIS, the **updater target IS this `…-setup.exe`** — there is no separate
updater bundle. `createUpdaterArtifacts` is intentionally **not** enabled, so the
plain build needs no signing key and works in forks / dry runs; signing is layered
on afterward (§4–§5).

---

## 4. Authenticode signing (Azure Trusted Signing)

The installer is **Authenticode-signed in place** via **Azure Trusted Signing**
so Windows SmartScreen / Defender trust it. This step is **secret-gated** — it
runs only when the Azure service-principal secrets are present, and is skipped
cleanly (with a warning) on dry runs.

Required secret **names** (values live only in the `release` environment — never
in the repo or this doc):

| Secret name | Purpose |
| --- | --- |
| `AZURE_TENANT_ID` | Entra tenant of the signing service principal |
| `AZURE_CLIENT_ID` | Service-principal (app) client ID |
| `AZURE_CLIENT_SECRET` | Service-principal client secret |
| `AZURE_TS_ENDPOINT` | Trusted Signing account endpoint |
| `AZURE_TS_ACCOUNT` | Trusted Signing account name |
| `AZURE_TS_CERT_PROFILE` | Certificate profile to sign with |

Signing uses a SHA-256 file digest and an RFC-3161 timestamp from Microsoft's
public timestamp authority (configured in the workflow), so signatures remain
valid after the signing certificate rotates.

---

## 5. Updater manifest (Tauri Ed25519)

Portcode auto-updates through Tauri's updater, which verifies an **Ed25519**
signature over the installer before applying it.

- **Owner generates the key once** with `pnpm tauri signer generate` (see §10).
  The **private key is NEVER committed** — it lives only in the password manager
  and in the `release` environment secrets. The **public key lives in
  `src-tauri/tauri.conf.json`** (the `updater` plugin config added by PR #8).
- In CI, **after** Authenticode signing, `tauri signer sign <installer>` writes a
  detached **`<installer>.sig`** over the *final* installer bytes. (Order matters:
  Authenticode embeds a certificate into the binary, so the updater signature must
  be taken last, or the updater would reject the download.) The key and password
  are read from `env`, never passed on the command line.
- A `latest.json` manifest is then generated pointing the updater at the release
  download. Its shape (no real signature shown):

```json
{
  "version": "<version>",
  "notes": "Portcode <version>. See the release page for full notes.",
  "pub_date": "<UTC ISO-8601>",
  "platforms": {
    "windows-x86_64": {
      "signature": "<ed25519 signature of the installer>",
      "url": "https://github.com/<org>/<repo>/releases/download/vX.Y.Z/Portcode_<version>_x64-setup.exe"
    }
  }
}
```

Required secret **names**:

| Secret name | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Ed25519 private key contents (from `tauri signer generate`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password protecting that private key |

If `TAURI_SIGNING_PRIVATE_KEY` is absent (dry run), the updater signing and
`latest.json` steps are skipped and **no auto-update is offered** for that build.

---

## 6. SBOM + checksums

- **SBOM** — a single **CycloneDX** JSON (`portcode.cdx.json`) is generated in CI
  with `cdxgen`, covering **both** the pnpm (`pnpm-lock.yaml`) and cargo
  (`Cargo.lock`) dependency trees, then validated as parseable CycloneDX. License
  enrichment over the network is disabled for reproducibility.
- **Checksums** — `SHA256SUMS.txt` lists the SHA-256 of the **final, signed**
  installer bytes (computed after Authenticode), so consumers can verify the exact
  artifact they downloaded.

Both are attached to the release (§7).

---

## 7. Publish to GitHub Releases

Publishing is **gated to tag refs (`v*`)**. The publish step is **idempotent**:

- If a Release for the tag **already exists** (the release-please path — its merge
  created the tag and the Release), the workflow **uploads the assets to it**
  (`--clobber`).
- If it **does not** exist (e.g. a manually pushed tag), the workflow **creates**
  the Release with auto-generated notes.

Assets attached:

- `Portcode_<version>_x64-setup.exe` — the signed installer
- `SHA256SUMS.txt` — checksums
- `<installer>.sig` — Ed25519 updater signature
- `latest.json` — updater manifest
- `portcode.cdx.json` — CycloneDX SBOM

### Recommended publish gate (draft → verify → publish)

For the security-sensitive releases, configure release-please (PR #5) to open the
GitHub Release as a **draft**. The workflow then attaches the signed installer,
`latest.json`, checksums, `.sig`, and SBOM to that **draft**, and a maintainer
**publishes it only after the clean-VM verification in §9**. Publishing the draft
is what makes `latest/download/latest.json` resolvable and turns on auto-update —
so a build that fails verification is simply never published (the cleanest
rollback of all). The Tauri updater reads
`https://github.com/<org>/<repo>/releases/latest/download/latest.json`, which
points at the most recent **published, non-prerelease** release.

---

## 8. Owner setup (one time)

Do this **once**, before the first signed release. All values stay in GitHub /
your secret vault — **never** in the repo.

1. **Protected `release` environment** — Settings → Environments → New
   environment → **`release`**. Add **≥ 2 required reviewers** (the two-approval
   policy below) and, optionally, restrict deployments to protected branches /
   `v*` tags. Attach all **8 secrets** as **environment** secrets (not repo-wide)
   so only the gated release job can read them.
2. **Generate the updater key** — on a trusted machine, run
   `pnpm tauri signer generate` (offline). Store the **private key + password** in
   a password manager; **never commit it**. Paste the **public key** into the
   `updater` config in `src-tauri/tauri.conf.json` (PR #8). Add the private key as
   `TAURI_SIGNING_PRIVATE_KEY` and its password as
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. **Azure Trusted Signing** — create the Trusted Signing account + certificate
   profile and a service principal with the *Trusted Signing Certificate Profile
   Signer* role; record its values into the six `AZURE_*` secret names from §4.
4. **`v*` tag protection** — protect the `v*` tag pattern (Settings → Rules) so
   only maintainers can create/push release tags.
5. **Allow release-please to open PRs** — Settings → Actions → General → enable
   **"Allow GitHub Actions to create and approve pull requests"**, or
   release-please (PR #5) can't open its release PR.
6. **Two-approval policy** — require **2 reviews** on the release-please PR (it
   carries the version bump and is security-sensitive). Keep `main` branch
   protection on.

### The 8 secrets at a glance

| # | Secret name | Group |
| --- | --- | --- |
| 1 | `AZURE_TENANT_ID` | Azure Trusted Signing |
| 2 | `AZURE_CLIENT_ID` | Azure Trusted Signing |
| 3 | `AZURE_CLIENT_SECRET` | Azure Trusted Signing |
| 4 | `AZURE_TS_ENDPOINT` | Azure Trusted Signing |
| 5 | `AZURE_TS_ACCOUNT` | Azure Trusted Signing |
| 6 | `AZURE_TS_CERT_PROFILE` | Azure Trusted Signing |
| 7 | `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater |
| 8 | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri updater |

`GITHUB_TOKEN` is provided automatically by Actions and is **not** one of the 8.

---

## 9. Verify on a clean Windows VM

Do this on a **fresh Windows VM** (no dev toolchain, no prior Portcode install)
before publishing a draft release.

1. **Download** `Portcode_<version>_x64-setup.exe` and `SHA256SUMS.txt` from the
   (draft) release.
2. **Checksum** —
   `Get-FileHash -Algorithm SHA256 .\Portcode_<version>_x64-setup.exe` must match
   the line in `SHA256SUMS.txt`.
3. **Authenticode** —
   `Get-AuthenticodeSignature .\Portcode_<version>_x64-setup.exe` must report
   `Status: Valid` with the expected signer and a present timestamp. The
   installer's **Properties → Digital Signatures** tab should show the signature,
   and SmartScreen should **not** warn on a freshly downloaded copy.
4. **Install** and launch; confirm the app runs and reports `<version>`.
5. **Auto-update** — install a **prior** version first, then run the new release's
   verification: confirm the app fetches `latest.json`, that the updater **accepts
   the `.sig`** (validates against the public key in `tauri.conf.json`), applies
   the update, and relaunches on `<version>`. A bad/mismatched signature must be
   **rejected**.

Only after all five pass do you **publish** the draft.

---

## 10. Rollback — yanking a bad release

Because publishing is the final gate, the cleanest rollback is to **catch it in
§9 and never publish the draft**. If a bad build was already published:

1. **Point auto-update back.** In GitHub Releases, mark the bad release as a
   **draft** (or **pre-release**), or delete it. `latest/download/latest.json`
   then resolves to the **previous good** release, so the updater stops offering
   the bad build immediately.
2. **Roll forward, not back.** Updaters don't downgrade installed clients. To move
   anyone already on the bad version, cut a **new patch release** (`vX.Y.Z+1`)
   containing the fix (or the last-good build re-tagged). Clients on the bad
   version then update forward.
3. **Tag hygiene.** If the tag should not exist at all, delete it
   (`git push origin :refs/tags/vX.Y.Z`) and the associated Release. Avoid
   reusing a version number that clients may already have seen.
4. **Communicate.** Edit the bad release's notes to mark it **yanked** and link to
   the replacement; post an advisory (release notes / README / discussions). If
   it's a security issue, open a GitHub Security Advisory (GHSA).

---

## 11. Pre-flight checklist

Before cutting a release:

- [ ] CI is **green** on `main` (`ci.yml`).
- [ ] The `release` environment exists with **all 8 secrets** and **≥ 2 required
      reviewers**.
- [ ] Updater **public key** is in `src-tauri/tauri.conf.json`, matching the
      private key in `TAURI_SIGNING_PRIVATE_KEY`.
- [ ] `v*` **tag protection** is enabled; "Allow GitHub Actions to create and
      approve pull requests" is on.
- [ ] Lockfiles (`pnpm-lock.yaml`, `Cargo.lock`) are **committed and clean**.
- [ ] The release-please PR (version bump across the **3 files** + `CHANGELOG.md`)
      is reviewed with **2 approvals**.
- [ ] *(Recommended)* a **dry run** was triggered via `workflow_dispatch` on a
      non-tag ref and the `portcode-unpublished` artifact was inspected.

Then merge the release-please PR and let the `v*` tag drive the rest.

---

## Appendix — paths & commands

| What | Where (relative to repo root) |
| --- | --- |
| Release workflow | `.github/workflows/release.yml` |
| Per-PR CI (no signing) | `.github/workflows/ci.yml` |
| NSIS installer | `src-tauri/target/release/bundle/nsis/Portcode_<version>_x64-setup.exe` |
| Checksums | `src-tauri/target/release/bundle/nsis/SHA256SUMS.txt` |
| Updater signature | `src-tauri/target/release/bundle/nsis/Portcode_<version>_x64-setup.exe.sig` |
| Updater manifest | `src-tauri/target/release/bundle/nsis/latest.json` |
| SBOM | `portcode.cdx.json` |
| Supply-chain policy | `deny.toml` |
| Updater public key | `src-tauri/tauri.conf.json` |

```sh
# Local dry-run build (unsigned) — same as CI without secrets:
pnpm install
pnpm app:build

# Owner only, one time — generate the updater key (keep the private key secret):
pnpm tauri signer generate
```
