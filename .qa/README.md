# Portcode feature-evolution and QA workflow

This directory contains a two-phase, evidence-driven pipeline that improves a requested feature before implementation and independently verifies it afterward.

The original task is copied and hashed; agents never rewrite it. Sensible low-risk additions are made only in a generated feature brief with explicit provenance.

## Pipeline

### Phase 1: prepare before implementation

1. `real-world-use-case-scout` freezes explicit requirements and researches project patterns, platform guidance, accessibility standards, user evidence, and comparable products.
2. `pre-implementation-risk-architect` freezes trust boundaries, ownership, races, acceptance boundaries, rollback, persistence, and required test capabilities.
3. `feature-brief-synthesizer` creates the builder brief, preserving the original request and classifying additions as Required, Expected, Optional, or Rejected.

An `Expected` behavior can be included automatically only when it is additive-low risk and has either one strong primary source or two independent comparable-product sources. Larger changes remain Optional.

### Builder handoff

The coding agent builds from `reports/feature-brief.json`. It may implement evidence-backed Expected behavior in addition to the explicit request, but it must respect the stated change budget and frozen risks.

### Phase 2: verify after implementation

1. `feature-completeness` derives the implemented state/transition model from the original request, enriched brief, frozen risks, and diff.
2. `edge-case-explorer` operates the safe running application and records behavioral candidates.
3. `design-ux-auditor` records screenshot-backed design and interaction candidates.
4. `post-implementation-risk-verifier` accounts for every frozen `RISK-###` as `verified-safe`, `finding`, `not-applicable`, or `blocked`.
5. `independent-reproducer` independently resolves all `OBS-###`, `DES-###`, and `RV-###` candidates.

A blocked frozen risk is never treated as passed. It forces the coverage gate and final merge gate to `needs-review` unless a confirmed blocking defect already causes `fail`.

All reports receive JSON Schema validation plus deterministic semantic and provenance validation.

## Prerequisites

- Node.js, Git, and Python with `jsonschema`.
- Hermes Agent installed and authenticated.
- Hermes `file`, `terminal`, `browser`, and `vision` toolsets.
- Portcode dependencies installed.
- The configured safe QA target and readiness port available.

The default target is the Portcode web preview. It cannot prove native Tauri IPC or WebView2-only behavior. Native risks must be tested using an approved isolated native target or reported blocked—not passed.

## Task file

Write the user's original request and explicit acceptance criteria to `.qa/tasks/current.md`. Do not summarize it from the implementation.

## Commands

Validate contracts without invoking AI:

```sh
pnpm qa:contracts
```

Preview preparation:

```sh
pnpm qa:prepare --task .qa/tasks/current.md --dry-run
```

Run preparation before the builder starts:

```sh
pnpm qa:prepare --task .qa/tasks/current.md
```

The command prints a `preparationRoot` and the generated `featureBrief`. Give that exact feature brief to the builder.

After implementation, verify against the frozen preparation:

```sh
pnpm qa:change --task .qa/tasks/current.md --preparation .qa/generated/<prepare-run-id>
```

After an infrastructure or provider failure, resume the same source-bound run from its last fully validated checkpoint:

```sh
pnpm qa:change --task .qa/tasks/current.md --preparation .qa/generated/<prepare-run-id> --resume-run <verify-run-id>
```

Resume is fail-closed: the task, provider, phase, Git state, and complete working-tree hash must be unchanged. Only checkpoints that passed schema, evidence, semantic, and provenance validation are reused. The failed stage and everything after it run again with isolated per-attempt evidence directories.

Full-repository mode is intentionally not exposed yet; only change-scoped verification has defined coverage semantics.

Direct Node equivalents:

```sh
node .qa/scripts/qa-runner.mjs --phase prepare --mode change --task .qa/tasks/current.md
node .qa/scripts/qa-runner.mjs --phase verify --mode change --task .qa/tasks/current.md --preparation .qa/generated/<prepare-run-id>
node --test .qa/tests/*.test.mjs
```

## Gates and exit codes

The verification manifest records separate gates:

- `findingGate`: independently reproduced defects.
- `coverageGate`: whether every frozen risk was actually verified or validly ruled out.
- `mergeGate`: the stricter combined result.

Exit codes:

- `0`: prepared successfully, or verification passed both gates.
- `1`: confirmed finding matched a blocking severity.
- `2`: blocked/inconclusive coverage, invalid output, stale preparation, provider failure, source mutation, or runner error.

## Artifacts and integrity

Each phase writes `.qa/generated/<timestamp>/` containing copied task text, Git identity, exact prompts, raw provider output, schema-valid reports, hashes, app logs, and a run manifest.

Verification requires the same task hash as preparation and re-hashes the scout, risk register, and feature brief before use. It rejects altered or incomplete preparation runs.

The runner hashes tracked and unignored source outside `.qa/generated` before invoking agents and compares it after every stage. If an agent changes source, tests, task text, or QA definitions, the run stops without resetting user work.

Provider stdout may contain tool previews. The runner accepts exactly one schema-valid report and rejects ambiguous multiple valid reports.

## Calibration policy

Do not enable a completion hook or CI gate until representative feature pilots demonstrate acceptable recall, false-positive rate, blocked-coverage rate, native coverage, runtime, and cost. Runner success is not equivalent to trustworthy coverage.
