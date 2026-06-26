---
description: Distill durable, project-scoped, PII-free facts from this session into project memory.
argument-hint: "[optional: a specific fact or topic to record]"
allowed-tools: Read, Edit, Bash
---

You are updating Portcode's durable project memory at `.claude/memory/project-memory.md`.

1. Read `.claude/memory/project-memory.md` (its rules + current entries).
2. From the current session (and `$ARGUMENTS` if given), select ONLY facts that are:
   - durable (true beyond this session), and
   - PROJECT-scoped (about the codebase / architecture / conventions / decisions / gotchas), and
   - PII-FREE (no emails, names, usernames, home/user directory paths, IPs, hostnames, tokens, keys,
     or machine specifics).
   Discard anything transient or personal. Prefer 1-line bullets. Date Decisions entries (YYYY-MM-DD).
3. Place each fact under the right section (Architecture / Conventions / Decisions / Gotchas /
   Active workstreams). Prune stale Active-workstreams entries.
4. BEFORE writing, pass your proposed additions through the scrubber:
   `printf '%s' "<additions>" | node .claude/scripts/scrub-memory.mjs`
   Use the scrubbed output. If the scrubber changed anything, that means you tried to record PII —
   re-examine and REMOVE the source fact entirely; do not just keep the `[REDACTED_*]` placeholder.
5. Append the cleaned bullets to the correct sections with Edit (do not rewrite unrelated lines).
6. Run `node .claude/scripts/scrub-memory.mjs --check .claude/memory/project-memory.md` and confirm it
   exits 0 before finishing. If it exits 2, fix the offending lines, do not lower the bar.
7. Report what you added.

Never record personal data. When in doubt, leave it out. This repo is PUBLIC.
