# Portcode automatic QA workflow

This directory contains a read-only, evidence-driven QA pipeline for evaluating a feature after its implementation agent finishes.

## Pipeline

1. `feature-completeness` creates the requirement, state, transition, and edge-case model.
2. `edge-case-explorer` operates the safe running application and records behavioral candidates.
3. `design-ux-auditor` operates rendered states and records screenshot-backed design candidates.
4. `independent-reproducer` independently confirms, rejects, or marks every candidate inconclusive and calculates the merge gate.

Reports are validated twice: JSON Schema validation checks shape, then `.qa/scripts/validate-contracts.mjs` checks references, candidate accounting, evidence, totals, and gate derivation.

## Prerequisites

- Run from the Portcode repository.
- Node.js and Git must be available.
- `python` must have the `jsonschema` package.
- Hermes Agent must be installed and authenticated for the default provider.
- Hermes needs the `file`, `terminal`, `browser`, and `vision` toolsets.
- Portcode dependencies must already be installed.
- Port `1420` must be available for the web preview.

The default runtime uses the Portcode web preview. It cannot prove native Tauri IPC or WebView2-only behavior; agents must block or mark those cases inconclusive rather than passing them.

## Task file

Create a task document from `.qa/tasks/example.md`. Include the original request rather than a summary reverse-engineered from the implementation.

Recommended path:

```text
.qa/tasks/current.md
```

## Commands

Validate contracts without invoking AI:

```sh
pnpm qa:contracts
```

Preview the planned workflow without starting Portcode or invoking an agent:

```sh
pnpm qa:change --task .qa/tasks/current.md --dry-run
```

Run change-focused QA:

```sh
pnpm qa:change --task .qa/tasks/current.md
```

Run broader QA:

```sh
pnpm qa:full --task .qa/tasks/current.md
```

Direct Node invocation works if the package-manager launcher is unavailable:

```sh
node .qa/scripts/qa-runner.mjs --mode change --task .qa/tasks/current.md
node --test .qa/tests/*.test.mjs
```

On this Windows installation, the Corepack `pnpm` shim is known to mis-resolve its own path when called from the Hermes Git-Bash environment (`D:\\c\\Users...`). The runner therefore starts Vite through `node_modules/vite/bin/vite.js` directly. Use the direct Node commands above in that shell; the package scripts remain available from shells where `pnpm` resolves normally.

## Exit codes

- `0`: merge gate passed.
- `1`: confirmed finding matched a blocking severity.
- `2`: blocked, inconclusive, invalid output, provider failure, source mutation, or runner error.

## Artifacts

Each run is written under:

```text
.qa/generated/<timestamp>/
```

It contains:

- Copied original task.
- Git diff and status.
- Exact prompts.
- Raw provider stdout/stderr.
- Validated JSON reports.
- Application logs.
- Run manifest, report hashes, stage outcomes, and final gate.

The runner never automatically deletes artifacts.

## Source-integrity guard

Before invoking the first agent, the runner hashes every tracked and unignored source file outside `.qa/generated`. It compares that snapshot after each agent. If an agent changes, adds, or removes source files, the workflow stops with exit code `2` and records the paths. It does not reset or overwrite those files.

This is a detection boundary, not an operating-system sandbox. The prompts and agents remain explicitly read-only.

## Provider configuration

`.qa/config.json` defines the provider and safe application target. The default provider executes a fresh Hermes one-shot session for each stage. Provider output must contain exactly one JSON object.

Do not place API keys or credentials in `.qa/config.json`. Authentication remains in the provider's normal credential store.

## Initial calibration

Do not enable this as a mandatory commit or CI gate until it has been run against a real Portcode feature and reviewed for:

- True positive findings.
- False positives.
- Missed seeded defects.
- Reproduction reliability.
- Native-only coverage gaps.
- Runtime and model cost.
