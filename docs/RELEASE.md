# Release runbook

How a Portcode release is cut, verified, rolled back, and set up the first time.
Portcode is a native Windows AI coding agent (Tauri v2 + Rust + React, pnpm)
shipped by **Porthex**.

> **Sensitivity — process only.** This document references secret **names** and
> steps. It contains **no** secret values, keys, certificates, tokens, or
> machine/infra paths, and must stay that way. All paths below are **relative to
> the repository root**.

---

## The branching model — `main` vs `release`

Portcode uses a **release-branch** model. Two long-lived branches, two jobs:

| Branch        | Role                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **`main`**    | **Active development / integration.** Every PR lands here. CI (`ci.yml`, `e2e.yml`) runs on it. This is the default branch.           |
| **`release`** | **The branch releases are cut from.** `main` is promoted here when it's time to ship. release-please and the `vX.Y.Z` tags live here. |

Nothing is released straight off `main`. Instead, a known-good `main` is
**promoted to `release`**, and the release automation runs **on `release`**.
This keeps day-to-day development on `main` decoupled from the version-bump,
changelog, and tag churn of cutting a release.

### ⚠️ `release` the BRANCH is not `release` the ENVIRONMENT

Two different things share the name **`release`** — don't conflate them:

- **The `release` git _branch_** — the branch in this repo that releases are cut
  from (this document). It's where release-please opens its release PR and where
  the `vX.Y.Z` tags are created.
- **The `release` GitHub _environment_** — a deployment environment (Settings →
  Environments) that holds the **signing secrets** and required reviewers. It is
  used by the signed Windows build job in `release.yml` (added by **PR #8**, see
  below). An _environment_ gates a workflow job; it is **not** a branch.

A release flows through **both**: the `vX.Y.Z` tag is created on the `release`
**branch**, and the signed build job that the tag triggers runs in the `release`
**environment** so it can read the signing secrets.

### What's wired today vs. once PR #8 lands

- **Today (on `main`):** release-please (changelog + 3-file version sync, now
  targeting `release`) and **`release-linux.yml`**, which on a `v*` tag builds
  the **unsigned** Linux bundles (AppImage + `.deb`) and attaches them to a
  **draft** GitHub Release.
- **Once PR #8 lands:** **`release.yml`** adds the **signed Windows** build —
  NSIS installer, Authenticode (Azure Trusted Signing), Tauri updater signature,
  `latest.json`, SBOM, and checksums — running in the `release` **environment**.
  Until PR #8 merges, treat the Windows-signing sections (§4–§7, §9) as the
  target process.

---

## TL;DR — cut a release (happy path)

1. **Land your changes on `main`** with
   [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
   `fix:`, …) so release-please can compute the next version. Let CI go green.
2. **Promote `main` → `release`.** Open a PR with **base `release`, head `main`**
   (or fast-forward `release` to `main` when their histories allow). This is the
   single "we intend to ship this" gate.
3. **Merge the open release-please PR** _on `release`_. release-please watches
   pushes to `release`, opens (or updates) a **release PR** there; merging it
   bumps the version in all **three** files, updates `CHANGELOG.md`, and creates
   the **`vX.Y.Z` tag** on `release`.
4. **The tag drives the build.** The `v*` tag triggers the release workflows:
   `release-linux.yml` (today → unsigned AppImage/`.deb`) and, once **PR #8**
   lands, the signed Windows `release.yml` running in the `release` environment.
5. **Verify** the build (§9), then **publish** the draft Release so it goes live
   (and, on Windows, `latest.json` enables auto-update).
6. **Sync the bump back to `main`** so the version files and `CHANGELOG.md` on
   `main` don't drift behind `release` (see "Keeping `main` in sync" below).

Everything below is the detail behind those lines.

---

## 1. Versioning — the three files

A release version is kept in lockstep across **three** files:

| File                        | Field                                                            |
| --------------------------- | ---------------------------------------------------------------- |
| `package.json`              | `"version"`                                                      |
| `src-tauri/Cargo.toml`      | `[package] version`                                              |
| `src-tauri/tauri.conf.json` | `"version"` (the workflow reads the installed version from here) |

**These are bumped automatically by release-please.** You do not edit them by
hand. release-please watches Conventional Commits on the **`release`** branch,
opens a "release PR" against `release` that bumps all three files plus
`CHANGELOG.md`, and — when that PR is merged — creates the matching **`vX.Y.Z`**
git tag on `release`. Merging the release PR _is_ how a release is cut; the tag
is what triggers the build. The two non-`package.json` files are wired as
`extra-files` in `release-please-config.json`, and the last-released version per
branch is tracked in `.release-please-manifest.json`.

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

### Keeping `main` in sync

Merging the release-please PR adds the version-bump + `CHANGELOG.md` commit to
**`release`**, so `release` now has a commit `main` doesn't. After the release,
bring that commit back to `main` so the three version files and the changelog on
`main` don't lag — open a short PR with **base `main`, head `release`**, or
cherry-pick the release-please commit onto `main`. Do this promptly after each
release so the next `main → release` promotion stays a clean fast-forward where
possible.

---

## 2. How the pipeline is wired

Two tag-triggered workflows can build a release. Both fire on a **`v*`** tag
(branch-agnostic) — the tag release-please creates on `release` — so cutting the
release is the same action regardless of which builders are enabled.

### `release-linux.yml` — unsigned Linux bundles (live today)

- **Triggers** on `push` of a **`v*`** tag, and on **`workflow_dispatch`**.
- Builds the two desktop-Linux bundle formats — **AppImage** and **`.deb`** — via
  `tauri-apps/tauri-action`, and attaches them to a **draft** GitHub Release.
- **Intentionally unsigned.** Linux desktop bundles are not code-signed the way
  the Windows installer is. The only token used is the built-in `GITHUB_TOKEN`,
  solely to upload assets.

### `release.yml` — signed Windows installer (added by PR #8)

- **Triggers** on `push` of a **`v*`** tag, and on **`workflow_dispatch`** (a
  manual, unpublished **dry run**). The heavy signed `tauri build` is kept **out**
  of per-PR CI (that stays in `ci.yml`) and runs **once per release**.
- Runs on **`windows-latest`**, in the protected **`release` environment** (the
  GitHub _environment_, where the signing secrets live — not the `release`
  branch).
- Default permissions are least-privilege (`contents: read`); the release job
  opts up to `contents: write` only to create the Release and upload assets.
- **Every signing step is secret-gated.** Secrets are mirrored into job `env` so a
  step's `if:` can detect their _presence_ without ever interpolating a value into
  a run-step (which could leak it to logs). **With no secrets configured the
  workflow still builds, produces a SBOM, and computes checksums — an UNSIGNED dry
  run.** It never hard-fails for missing secrets; a real signed release just
  additionally requires the `release` environment and its secrets.

### What `release.yml` does, in order

1. Checkout, enable Corepack/pnpm, set up Node 20, materialize the pinned Rust
   toolchain (`rust-toolchain.toml`), restore the cargo cache.
2. `pnpm install --frozen-lockfile`.
3. **Supply-chain audit** — `cargo-deny` (licenses · advisories · bans · sources),
   reading `deny.toml` at the repo root. Fails fast before build time.
4. **Build** — `pnpm app:build` → `tauri build` → **NSIS installer** (§3).
5. **Authenticode sign** the installer via Azure Trusted Signing (§4) — _gated_.
6. **Updater sign** the installer with `tauri signer sign` (§5) — _gated_, runs
   **after** Authenticode.
7. **SHA-256 checksums** over the final (post-sign) bytes → `SHA256SUMS.txt`.
8. **Updater manifest** `latest.json` (§5) — _gated_.
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
runs only when the Azure service-principal secrets are present (in the `release`
**environment**), and is skipped cleanly (with a warning) on dry runs.

Required secret **names** (values live only in the `release` environment — never
in the repo or this doc):

| Secret name             | Purpose                                       |
| ----------------------- | --------------------------------------------- |
| `AZURE_TENANT_ID`       | Entra tenant of the signing service principal |
| `AZURE_CLIENT_ID`       | Service-principal (app) client ID             |
| `AZURE_CLIENT_SECRET`   | Service-principal client secret               |
| `AZURE_TS_ENDPOINT`     | Trusted Signing account endpoint              |
| `AZURE_TS_ACCOUNT`      | Trusted Signing account name                  |
| `AZURE_TS_CERT_PROFILE` | Certificate profile to sign with              |

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
  detached **`<installer>.sig`** over the _final_ installer bytes. (Order matters:
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

| Secret name                          | Purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Ed25519 private key contents (from `tauri signer generate`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password protecting that private key                        |

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
  created the tag and a draft Release), the workflow **uploads the assets to it**
  (`--clobber`).
- If it **does not** exist (e.g. a manually pushed tag), the workflow **creates**
  the Release with auto-generated notes.

Assets attached (signed Windows build, once PR #8 lands):

- `Portcode_<version>_x64-setup.exe` — the signed installer
- `SHA256SUMS.txt` — checksums
- `<installer>.sig` — Ed25519 updater signature
- `latest.json` — updater manifest
- `portcode.cdx.json` — CycloneDX SBOM

`release-linux.yml` additionally attaches the unsigned `*.AppImage` and `*.deb`
bundles to the same tag's draft Release.

### Recommended publish gate (draft → verify → publish)

Both release workflows create the Release as a **draft**. The build jobs attach
their artifacts to that draft, and a maintainer **publishes it only after the
clean-VM verification in §9**. Publishing the draft is what makes
`latest/download/latest.json` resolvable and turns on auto-update — so a build
that fails verification is simply never published (the cleanest rollback of all).
The Tauri updater reads
`https://github.com/<org>/<repo>/releases/latest/download/latest.json`, which
points at the most recent **published, non-prerelease** release.

---

## 7a. In-app auto-update behaviour

Portcode ships a **single `stable` update channel**: every build reads its
updater manifest from
`https://github.com/<org>/<repo>/releases/latest/download/latest.json`, which
resolves to the most recent **published, non-prerelease** Release. (A rolling
`staging` pre-release feed once existed; it has been retired.)

Auto-update is **ON by default** (Claude Code parity) and can be toggled in
**Settings**:

- **ON** — the updater **silently downloads + installs** the newer build, then
  **prompts to relaunch**.
- **OFF** — the updater only **notifies** that an update is available; nothing is
  downloaded or installed until the user acts.

---

## 8. Owner setup (one time)

Do this **once**, before the first signed release. All values stay in GitHub /
your secret vault — **never** in the repo.

1. **`release` branch** — already exists (cut from `main`). It is the source of
   all releases. Optionally protect it (Settings → Rules) so only maintainers can
   push and the same CI checks are required before promotion.
2. **Protected `release` _environment_** — Settings → Environments → New
   environment → **`release`** (the deployment environment, distinct from the
   branch). Add **≥ 2 required reviewers** (the two-approval policy below) and,
   optionally, restrict deployments to protected branches / `v*` tags. Attach all
   **8 secrets** as **environment** secrets (not repo-wide) so only the gated
   release job can read them.
3. **Generate the updater key** — on a trusted machine, run
   `pnpm tauri signer generate` (offline). Store the **private key + password** in
   a password manager; **never commit it**. Paste the **public key** into the
   `updater` config in `src-tauri/tauri.conf.json` (PR #8). Add the private key as
   `TAURI_SIGNING_PRIVATE_KEY` and its password as
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. **Azure Trusted Signing** — create the Trusted Signing account + certificate
   profile and a service principal with the _Trusted Signing Certificate Profile
   Signer_ role; record its values into the six `AZURE_*` secret names from §4.
5. **`v*` tag protection** — protect the `v*` tag pattern (Settings → Rules) so
   only maintainers can create/push release tags.
6. **Allow release-please to open PRs** — Settings → Actions → General → enable
   **"Allow GitHub Actions to create and approve pull requests"**, or release-please
   can't open its release PR on `release`.
7. **Two-approval policy** — require **2 reviews** on the release-please PR (it
   carries the version bump and is security-sensitive). Keep `main` branch
   protection on.

### The 8 secrets at a glance

| #   | Secret name                          | Group                 |
| --- | ------------------------------------ | --------------------- |
| 1   | `AZURE_TENANT_ID`                    | Azure Trusted Signing |
| 2   | `AZURE_CLIENT_ID`                    | Azure Trusted Signing |
| 3   | `AZURE_CLIENT_SECRET`                | Azure Trusted Signing |
| 4   | `AZURE_TS_ENDPOINT`                  | Azure Trusted Signing |
| 5   | `AZURE_TS_ACCOUNT`                   | Azure Trusted Signing |
| 6   | `AZURE_TS_CERT_PROFILE`              | Azure Trusted Signing |
| 7   | `TAURI_SIGNING_PRIVATE_KEY`          | Tauri updater         |
| 8   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri updater         |

`GITHUB_TOKEN` is provided automatically by Actions and is **not** one of the 8.

---

## 9. Verify on a clean Windows VM

Do this on a **fresh Windows VM** (no dev toolchain, no prior Portcode install)
before publishing a draft release. (Applies to the signed Windows build from
`release.yml`, once PR #8 lands.)

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

- [ ] CI is **green** on `main` (`ci.yml`, `e2e.yml`).
- [ ] `main` has been **promoted to `release`** (PR `main → release` merged, or
      fast-forwarded).
- [ ] The `release` **environment** exists with **all 8 secrets** and **≥ 2
      required reviewers** (required for the signed Windows build).
- [ ] Updater **public key** is in `src-tauri/tauri.conf.json`, matching the
      private key in `TAURI_SIGNING_PRIVATE_KEY`.
- [ ] `v*` **tag protection** is enabled; "Allow GitHub Actions to create and
      approve pull requests" is on.
- [ ] Lockfiles (`pnpm-lock.yaml`, `Cargo.lock`) are **committed and clean**.
- [ ] The release-please PR (version bump across the **3 files** + `CHANGELOG.md`)
      is reviewed with **2 approvals**.
- [ ] _(Recommended)_ a **dry run** was triggered via `workflow_dispatch` on a
      non-tag ref and the `portcode-unpublished` artifact was inspected.

Then merge the release-please PR (on `release`) and let the `v*` tag drive the
rest. Afterward, sync the bump back to `main` (§1).

---

## Appendix — paths & commands

| What                     | Where (relative to repo root)                                               |
| ------------------------ | --------------------------------------------------------------------------- |
| Signed Windows release   | `.github/workflows/release.yml` (added by PR #8)                            |
| Linux release (today)    | `.github/workflows/release-linux.yml`                                       |
| Changelog + version bump | `.github/workflows/release-please.yml` (targets the `release` branch)       |
| Per-PR CI (no signing)   | `.github/workflows/ci.yml`                                                  |
| NSIS installer           | `src-tauri/target/release/bundle/nsis/Portcode_<version>_x64-setup.exe`     |
| Checksums                | `src-tauri/target/release/bundle/nsis/SHA256SUMS.txt`                       |
| Updater signature        | `src-tauri/target/release/bundle/nsis/Portcode_<version>_x64-setup.exe.sig` |
| Updater manifest         | `src-tauri/target/release/bundle/nsis/latest.json`                          |
| SBOM                     | `portcode.cdx.json`                                                         |
| Supply-chain policy      | `deny.toml`                                                                 |
| Updater public key       | `src-tauri/tauri.conf.json`                                                 |

```sh
# Local dry-run build (unsigned) — same as CI without secrets:
pnpm install
pnpm app:build

# Owner only, one time — generate the updater key (keep the private key secret):
pnpm tauri signer generate
```
