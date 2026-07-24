# Original feature task

## User request

> Alright man, as for the initial calibration, lets start with building a file upload system for Portcode like in codex and claude

## Clarification outcome

The user was offered scope choices but did not respond before the clarification timeout. Proceed with the recommended interpretation below and keep the assumptions explicit rather than silently inventing broader support.

## Product goal

Build a polished first-version attachment system for Portcode's chat composer, comparable to the practical attachment workflow in Codex and Claude: users can add multiple local files before sending, understand exactly what is attached, remove mistakes, and have supported files delivered to the real Codex turn rather than merely displayed in the UI.

## Acceptance criteria

1. The desktop composer exposes an accessible Attach files control for an active chat.
2. Users can add files through the native picker and drag/drop onto the composer. Paste support should attach pasted files when the host exposes them.
3. Multiple attachments are supported. The UI shows each filename, type or extension, readable size, and a remove action. Common images receive a thumbnail when safe and available.
4. Attachments belong to the active session's unsent draft. Switching sessions must not leak them into another chat. A rejected/failed send preserves them; an accepted send clears only the submitted session's attachments.
5. An attachment-only message is sendable when at least one valid attachment is present. Text may accompany attachments.
6. Common UTF-8 text/code files and common image formats are delivered to the real Codex app-server turn input. Text files must be clearly delimited with their filename; images must use the app-server's supported local-image input shape. The feature must not claim support for opaque binary formats that are not actually delivered.
7. Native code is the trust boundary for local paths and content. It canonicalizes and validates selected paths, accepts regular files only, applies count and per-file/aggregate size limits, rejects unsupported or unreadable files with safe user-facing errors, and does not expose file contents in logs.
8. Duplicate selections are handled deterministically without duplicate context. Ordering is stable and matches the visible attachment order.
9. The composer displays actionable validation/read errors without discarding already-valid attachments or the typed draft.
10. Attach/remove controls have accessible names, keyboard focus treatment, and disabled states. Drag-active, empty, populated, error, sending, session-switch, narrow-width, long-filename, duplicate, oversized, unsupported, and removal states have deliberate treatment.
11. Attachments cannot be modified while their turn is being accepted/sent. Rapid duplicate clicks or drops must not create duplicate sends or duplicate attachments.
12. Existing text-only send, draft persistence, streaming/stop behavior, message history, and native Codex execution remain compatible.
13. Frontend and Rust behavior is implemented test-first. Relevant focused tests, frontend coverage, and Rust workspace tests must pass.

## Initial limits and explicit non-goals

- Initial supported document scope is UTF-8 text/code files plus common raster images supported by Codex local-image input. PDF, Office documents, archives, audio, video, directories, and arbitrary opaque binaries must be rejected honestly unless the implementation adds a deterministic, tested conversion path.
- Use conservative configurable constants: at most 10 files, at most 20 MiB per file, and at most 50 MiB aggregate. Tests must cover exact-boundary and over-boundary behavior.
- This calibration targets the desktop local Codex workflow. Phone Sync attachment transfer is not required in this first version. Remote mode must hide or honestly disable attachment affordances rather than imply unsupported delivery.
- Do not call paid providers in automated tests.
- Do not weaken or rewrite unrelated tests, assertions, snapshots, or existing work to obtain a pass.

## Entry points

1. Start Portcode desktop with an active local chat and configured workspace.
2. Use the attachment control, drag files onto the composer, or paste a host-provided file.
3. Review/remove attachment chips.
4. Send text plus attachments or attachments alone.

## Safe test data

Use temporary fixture files created by tests. Fixtures must contain synthetic non-sensitive content. No production accounts, personal files, credentials, paid provider calls, or network uploads are permitted during automated tests or QA.

## Calibration notes

This is the first live pilot for the project-local QA agents. The coding agent must implement and run ordinary deterministic checks first. The QA pipeline runs only after implementation is declared complete, and remains read-only toward source/tests/snapshots.
