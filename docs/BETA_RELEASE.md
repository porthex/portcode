# Beta release channel

Portcode Beta is the tester-facing Windows channel. It is promoted from a
selected green commit on `main`; the `release` branch and normal GitHub Releases
remain the Stable channel.

## Channel contract

| Property         | Beta                                  | Stable                                  |
| ---------------- | ------------------------------------- | --------------------------------------- |
| Source           | Selected green `main` SHA             | `release` branch                        |
| Version          | `X.Y.Z-beta.N`                        | `X.Y.Z`                                 |
| App name         | Portcode Beta                         | Portcode                                |
| Tauri identifier | `dev.porthex.portcode.beta`           | `dev.porthex.portcode`                  |
| GitHub release   | Published prerelease                  | Published normal release                |
| Manifest         | `/releases/download/beta/latest.json` | `/releases/latest/download/latest.json` |

Beta and Stable install side by side and keep separate application data. A
visible `BETA` pill prevents testers from confusing the two builds.

## Publish a beta

1. Confirm CI and E2E are green for the intended `main` SHA.
2. Open **Actions → Beta (Windows) → Run workflow** on `main`.
3. Enter the next prerelease version, such as `5.1.0-beta.1`.
4. Enable **require_authenticode** when Azure Trusted Signing is configured and
   the installer must carry a Windows-trusted publisher signature.
5. Wait for the workflow to build, sign, checksum, generate the SBOM, publish the
   immutable prerelease, and refresh the rolling `beta` manifest.
6. Download the installer from the versioned GitHub prerelease and verify
   `SHA256SUMS.txt`. When Authenticode is required, also run
   `Get-AuthenticodeSignature` and require `Status: Valid`.

The workflow always requires the Tauri Ed25519 signing key. It refuses to publish
an updater manifest without that signature. Authenticode is independently
verified and reported in the release notes; when the corresponding workflow
input is enabled, missing Azure credentials fail the build.

## Roll forward

Do not replace an existing version with different bytes. Fix the problem on
`main` and publish the next `beta.N` version. Installed Beta builds discover it
through the rolling manifest. Stable users never consume that manifest.
