# Codex activity visibility and GUI-parity feature

## Original request

Use the Portcode QA system on the base Codex engine interaction where the user chats with the AI. Portcode uses the existing Codex CLI/app-server backbone; it must not rebuild agent reasoning, tools, tasks, or multi-agent orchestration. Codex already creates and runs subagents. Portcode should project and display most useful Codex GUI behaviors and UI/UX, including subagent work, tasks/plans, and live reports/progress to the user. Research the actual Codex concepts and protocol names rather than relying on the user's informal terminology. Implement the feature completely, use a swarm for independent investigation and QA, and return a verified pull request.

## Scope assumptions

- Codex app-server is authoritative for threads, turns, items, tools, plans, delegated agents, approvals, progress, and terminal outcomes.
- Portcode is a projection/presentation layer: preserve and correlate the app-server event stream, then render useful activity without inventing a parallel execution backbone.
- Primary target: native Windows Tauri/WebView Portcode chat. Existing remote projection must not silently corrupt or misrepresent activity.
- Preserve ordinary chat, permissions, cancellation, receipts, attachments, persistence, and session isolation.
- Prefer broad useful behavior coverage over copying Codex branding or pixel-for-pixel styling.
- Extreme zoom stress (including 200% zoom combined with increased root text scaling) is non-blocking for this PR; supported-layout usability and ordinary accessibility behavior remain required.
- Unknown/new Codex activity should remain inspectable rather than being silently discarded.
- Most of this may already be implemented. Preserve working behavior and architecture; first establish an acceptance matrix against the actual current implementation, then complete missing or disconnected paths and harden lifecycle, persistence, recovery, accessibility, and edge cases. Do not replace stable existing features merely to reimplement them.

## Required outcome

A reviewed, tested pull request that completes and stabilizes the existing Codex interaction UI, exposes the most important currently available working-state behaviors, and closes reproducible gaps with deterministic regressions and evidence-backed QA. Every independently confirmed blocking product finding must be fixed before the PR is considered ready.

## Explicit follow-up sequence (not current-PR scope)

These requested capabilities must remain out of the current PR and be preserved as the next implementation sequence rather than silently dropped:

1. Next PR: Codex scheduled tasks, voice, and marketplace behavior/UI.
2. Following PR: computer-use and raw-reasoning support. Raw reasoning must be treated as sensitive, explicitly disclosed/opt-in diagnostic content rather than ordinary transcript text.
