---
name: project-memory
description: Record or update durable, project-scoped, PII-free knowledge in Portcode's local project memory. Use when the user asks Codex to remember a project fact, preserve a decision or gotcha across local sessions, update project memory, or perform the Claude `/memory` workflow from Codex.
---

# Project Memory

Update `.claude/memory/project-memory.md` without recording personal or transient information.

1. Read the memory file and its rules. If it does not exist, create it locally with the headings Architecture, Conventions, Decisions, Gotchas, and Active workstreams. Never stage or force-add it.
2. Select only durable facts about the repository: architecture, conventions, decisions, gotchas, or active workstreams. Exclude session status, machine details, identities, credentials, and personal preferences unrelated to the project.
3. Keep additions concise. Date decision entries as `YYYY-MM-DD`. Remove stale active-workstream entries when evidence shows they are finished.
4. Before editing, pass proposed text to `node .claude/scripts/scrub-memory.mjs`. If it changes anything, discard the source fact instead of saving a redaction placeholder.
5. Use `apply_patch` to add facts under the appropriate heading without rewriting unrelated content.
6. Run `node .claude/scripts/scrub-memory.mjs --check .claude/memory/project-memory.md`. A clean file exits `0`; if it exits `2`, remove the offending content and check again.
7. Report exactly what durable facts changed.

The memory file is Git-ignored and must stay local. Never put emails, names, usernames, home-directory paths, IPs, hostnames, tokens, keys, credentials, or machine-specific details in it. When uncertain, leave the fact out.
