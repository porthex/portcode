# Codex Phase 2 Acceptance Matrix — Marketplace and Scheduled Task Templates

Status: frozen before implementation

## Authority

- Codex CLI/app-server `0.145.0`
- Tag `rust-v0.145.0`
- Commit `25af12f7e61572b0bc18ddb1008be543b91519b0`
- Portcode is a presentation/control client. It must not emulate Codex scheduling, plugin installation, or authentication.

## Product boundary

Phase 2 adds desktop-local Codex capability surfaces for plugin marketplaces and read-only scheduled-task template discovery. These surfaces are unavailable in Phone Sync and browser preview except for deterministic mocks used by tests.

Voice is deferred and must not be implemented, configured, or partially exposed by this branch or PR.

Phase 3 computer use and raw reasoning are explicitly out of scope.

## Marketplace

| Case                | Requirement                                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Discovery           | `plugin/list` is the sole source of marketplace/plugin rows. Loading, empty, partial-error, offline/auth, and success states are distinct.                                                                                                                                                 |
| Detail              | `plugin/read` is the sole source of description, skills, hooks, apps, MCP servers, screenshots, share URL, and scheduled-task metadata. Unknown fields are ignored without losing known fields.                                                                                            |
| Install safety      | `mustShowInstallationInterstitial !== false` fails closed: installation requires an explicit disclosure/confirmation step. `DISABLED_BY_ADMIN` and policy-blocked entries cannot be installed.                                                                                             |
| Install lifecycle   | `plugin/install` owns installation. Portcode disables duplicate actions, reports native errors, refreshes authoritative state after success, and surfaces `appsNeedingAuth` without exposing credentials.                                                                                  |
| Uninstall lifecycle | `plugin/uninstall` owns removal. Portcode requires explicit confirmation, warns that external connector authorization may survive uninstall, disables duplicate actions, and refreshes authoritative state after success.                                                                  |
| Marketplace sources | Add/remove/refresh actions use `marketplace/add`, `marketplace/remove`, and `marketplace/upgrade`; the UI labels `upgrade` as “Refresh marketplace snapshot,” never “Update plugin.” User input is passed only through typed native commands, never an arbitrary app-server method bridge. |
| Capability trust    | Installation is not authentication, hook trust, task scheduling, or authorization to access external data. Hook-bearing plugins and connectors receive explicit disclosures; Portcode never renders plugin HTML or grants WebView privileges to remote content.                            |
| Fail-open catalog   | `marketplaceLoadErrors` do not erase healthy rows; each affected source is visibly degraded.                                                                                                                                                                                               |
| Remote safety       | Marketplace catalog, local paths, plugin details, and management actions never enter transcript persistence, Phone Sync frames, or remote DOM.                                                                                                                                             |

## Scheduled tasks

| Case                       | Requirement                                                                                                                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority                  | Portcode does not invent a scheduler or persist schedules. `PluginDetail.scheduledTasks` is authoritative metadata from `plugin/read`.                                                                                                                                           |
| Availability semantics     | `null` means metadata unavailable; `[]` means known empty; a populated array is rendered distinctly.                                                                                                                                                                             |
| Schedule grammar           | Hourly, daily, weekdays, and weekly variants render deterministically, including weekday order and local-time labels without changing source values.                                                                                                                             |
| Prompt privacy             | Task prompts appear only in the open marketplace detail/task surface. They do not enter transcript, draft persistence, accessibility content outside that surface, Phone Sync, telemetry, or wire output unless the user deliberately submits the text as an ordinary user turn. |
| Optional prompt flow       | “Send prompt to Codex” requires deliberate confirmation and creates only an ordinary Codex turn. It is never labeled run-now, schedule, create, install, or execute, and success does not imply an automation exists.                                                            |
| Unsupported lifecycle      | App-server `0.145.0` exposes no list/create/edit/enable/disable/delete/run-now API and no task-specific lifecycle events. Portcode advertises none of them and does not infer task enablement from plugin installation.                                                          |
| Generic automation threads | If Codex supplies a thread with `threadSource: "automation"`, Portcode may label that generic source. It must not infer a task key, schedule, next run, history, or scheduler state.                                                                                             |

## Deferred capability

Voice, microphone capture, realtime sessions, WebRTC media, recorded-audio prompts, transcription, playback, voice settings, media permissions, CSP exceptions, and dormant voice feature flags are explicitly excluded from Phase 2.

## Architecture and bounds

- Native Rust exposes typed, allowlisted Tauri commands; no frontend-accessible arbitrary JSON-RPC method command.
- App-server request timeouts and process-generation semantics remain authoritative.
- React state retains only display-safe catalog/detail metadata for this phase.
- Marketplace catalog rendering is bounded and virtualized/paginated if authoritative results exceed 200 visible rows.
- URLs shown or opened are restricted to `https:`; local paths are not copied or exposed as links.
- Existing Phase 1 retention limits remain unchanged: 2,000 current events, 8,000 archived events, 10,000 reachable events, and at most 200 detailed rendered events.

## Explicit exclusions

- No independent Portcode scheduler, configured-automation list, run history, or run-now action.
- No standalone skill installer/remover. Local skills and independently configured MCP servers remain separate Codex facilities rather than marketplace inventory.
- No arbitrary MCP configuration editor or direct MCP tool-call control in the marketplace surface.
- No voice, microphone, realtime, transcription, playback, recorded-audio prompt, or media-permission implementation in this branch or PR.

## Required verification

1. RED test observed before every implementation slice.
2. Focused TypeScript/Vitest and Rust tests for projection, allowlists, lifecycle, stale ownership, privacy, and errors.
3. Full frontend tests, typecheck, ESLint, Prettier, production build, Rust fmt, Clippy, and Rust test suite.
4. Existing QA contracts remain green; add Phase 2 privacy and capability contracts.
5. Native Windows Tauri/WebView2 acceptance for marketplace loading/detail/actions, scheduled-task-template presentation/use flow, keyboard, responsive layout, and reduced motion.
6. Independent code/privacy/accessibility review and visual review before PR delivery.
