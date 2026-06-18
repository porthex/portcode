<!--
Thanks for contributing to Portcode! Please read CONTRIBUTING.md before opening
your first PR: https://github.com/porthex/portcode/blob/main/CONTRIBUTING.md
Write the PR title as a Conventional Commit (e.g. `fix(ui): stop re-render loop`)
— we squash-merge using the title as the commit subject.
-->

## Summary

<!-- What does this change and why? Keep it focused — one logical change per PR. -->

## Linked issue

<!-- e.g. "Fixes #123". For anything non-trivial, please open/discuss an issue first. -->

Fixes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor / chore
- [ ] Other (describe):

## Quality gates

Run these locally before pushing (CI runs them too — see
[CONTRIBUTING.md](https://github.com/porthex/portcode/blob/main/CONTRIBUTING.md#quality-gates--run-before-you-push)):

- [ ] `pnpm lint` passes
- [ ] `pnpm format:check` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --check` passes
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` passes
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] I added or updated tests for this change (or explained why none are needed)

## Security sensitivity

- [ ] This PR touches a **security-sensitive path** — the permission gate, secrets / credential handling, the `shell` execution path, the provider/LLM code, the Tauri IPC/CSP config, or a release/signing workflow.

<!-- If checked: describe the security impact. These paths require maintainer review (CODEOWNERS) and get extra scrutiny. -->

## Screenshots

<!-- If this changes the UI, include a before/after screenshot or short clip. Otherwise delete this section. -->

## Checklist

- [ ] My commits follow [Conventional Commits](https://www.conventionalcommits.org/) and the PR title is a clean commit subject.
- [ ] I have agreed to the [Contributor License Agreement](https://github.com/porthex/portcode/blob/main/CLA.md) (the CLA bot will prompt on first contribution).
- [ ] I updated `CHANGELOG.md` (Unreleased) if this is a user-facing change.
- [ ] I updated relevant documentation.
