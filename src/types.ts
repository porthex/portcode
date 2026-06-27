// Shared types. These mirror the Rust core's serde models so the IPC boundary
// stays a single source of truth.

export type Role = "user" | "assistant" | "system";

export type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; output: string; isError: boolean };

export interface Message {
  id: string;
  role: Role;
  blocks: ContentBlock[];
  createdAt: number;
}

export interface Session {
  id: string;
  title: string;
  workspace: string | null;
  /**
   * Current git branch of `workspace`, computed live by the Rust core on each
   * `list_sessions` (read from `.git/HEAD`, never stored). `null`/absent when
   * there's no workspace, it isn't a git repo, or HEAD is detached. Drives the
   * `⎇` row label and `groupBy: "branch"`.
   */
  branch?: string | null;
  /** The model this chat uses. Defaults to the last-used `settings.model`. */
  model: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Derived lifecycle state of a session row in the sidebar.
 * - `running`  — the open session while a turn streams (the only honest "live"
 *   signal: the store tracks a single global `streaming`, owned by the active run).
 * - `archived` — user-archived (a frontend-only flag, see {@link SessionFolder}).
 * - `idle`     — everything else.
 * NOT a Rust-backed field; the core's {@link Session} model is unchanged. Derived
 * by `deriveStatus` in `lib/sessionView`.
 */
export type SessionStatus = "running" | "idle" | "archived";

/**
 * How the SESSIONS list is ordered. `recent` = most-recently-updated first.
 * `manual` is entered implicitly when the user drag-reorders the list (the sort
 * presets switch "off") and orders by the persisted {@link Session} order.
 */
export type SessionSort = "recent" | "name" | "status" | "manual";

/**
 * How the SESSIONS list is grouped. `none` = the manual folder tree (drag to
 * reorder / into folders); `status` / `branch` / `workspace` are automatic
 * groupings that override folders.
 */
export type SessionGroup = "none" | "status" | "branch" | "workspace";

/**
 * A user-created folder that groups sessions in the sidebar (manual-org mode).
 * Folders + membership (`folderOf` in the store) are a frontend-only overlay
 * persisted to localStorage — the Rust core never sees them.
 */
export interface SessionFolder {
  id: string;
  name: string;
  /** Expanded (children shown) vs collapsed. */
  open: boolean;
}

/** Events streamed from the core during an agent run. */
export type StreamEvent =
  | { type: "turn_start"; messageId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError: boolean }
  | {
      type: "permission_request";
      id: string;
      tool: string;
      summary: string;
      input: unknown;
      /** Pre-apply unified diff for file tools; absent for shell/other. */
      diff?: string;
    }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn_end"; stopReason: string }
  | { type: "error"; message: string }
  // ── subagents (the `task` tool) — see AgentInfo / the live agents panel ──
  /** A subagent started. `parentId` is the launching subagent, absent at top level. */
  | { type: "agent_started"; agentId: string; description: string; parentId?: string }
  /** A subagent completed a model turn — `step` is its 1-based turn count. */
  | { type: "agent_progress"; agentId: string; step: number }
  /** A subagent finished. `status` is "ok" | "cancelled" | "error". */
  | { type: "agent_finished"; agentId: string; status: string }
  // ── background shell tasks (the `shell` tool's background mode) ──────────────
  /** A `shell` command was launched in the background. Emitted on the SESSION
   *  channel, so the persistent session listener (not the per-turn one) tracks it. */
  | { type: "background_task_started"; id: string; command: string }
  /** A background `shell` command finished. Can arrive AFTER the launching turn
   *  ended, which is why it rides the persistent session listener. */
  | {
      type: "background_task_finished";
      id: string;
      command: string;
      exitCode: number;
      output: string;
    };

/** Terminal/live state of a subagent in the agents panel. */
export type AgentStatus = "running" | "ok" | "cancelled" | "error";

/** Live/terminal state of a background shell task. `running` until it finishes,
 *  then `ok` (exit 0) or `error` (any non-zero / failed-to-run exit). */
export type BackgroundTaskStatus = "running" | "ok" | "error";

/** A background shell task (the `shell` tool's background mode) tracked per session
 *  for the background-tasks panel. Outlives the turn that launched it. */
export interface BackgroundTaskInfo {
  id: string;
  command: string;
  status: BackgroundTaskStatus;
  /** Process exit code, once finished (undefined while running). */
  exitCode?: number;
  /** Captured stdout/stderr, once finished (undefined while running). */
  output?: string;
}

/** A subagent (the `task` tool) tracked for the live agents panel. */
export interface AgentInfo {
  id: string;
  description: string;
  /** The launching subagent's id, or undefined for a top-level launch. */
  parentId?: string;
  /** "running" until an `agent_finished` arrives, then its terminal status. */
  status: AgentStatus;
  /** Latest reported turn count (`agent_progress`); 0 before the first turn. */
  step: number;
}

export interface PendingPermission {
  id: string;
  tool: string;
  summary: string;
  input: unknown;
  /** Pre-apply unified diff for file tools; absent for shell/other. */
  diff?: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export type ToolPolicy = "allow" | "ask" | "deny";

/**
 * The permission MODE — the coarse default behaviour of the gate. Mirrors the
 * Rust `PermissionMode`. `auto` auto-allows every mutating tool and `bypass`
 * skips the gate entirely, so both are opt-in only and shown with a danger
 * indicator; the quick-cycle covers only the safe trio.
 */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypass";

/** Permission modes reachable by the quick-cycle affordance — the safe trio.
 *  `auto`/`bypass` are deliberately excluded (Settings-only opt-in). */
export const CYCLE_MODES: PermissionMode[] = ["default", "acceptEdits", "plan"];

/** Modes that loosen the gate and must be surfaced as dangerous. */
export const DANGER_MODES: PermissionMode[] = ["auto", "bypass"];

/**
 * A per-tool / per-command permission rule. Mirrors the Rust `Rule`. Evaluated
 * before the mode default, first match wins. `command` is a literal shell
 * command PREFIX (an allow-list convenience, never a guarantee — anything
 * chained after the prefix matches too).
 */
export interface Rule {
  tool: string;
  command?: string;
  decision: ToolPolicy;
}

export interface Settings {
  provider: "anthropic";
  model: string;
  apiKeySet: boolean;
  /** Legacy global policy; the `default` mode's fallthrough (back-compat). */
  defaultPolicy: ToolPolicy;
  workspace: string | null;
  /** Reveal the agent's reply with a terminal-style typing animation. */
  typingAnimation: boolean;
  /** The active permission mode (default/acceptEdits/plan/auto/bypass). */
  permissionMode: PermissionMode;
  /** Per-tool/command permission rules, evaluated before the mode default. */
  rules: Rule[];
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  apiKeySet: false,
  defaultPolicy: "ask",
  workspace: null,
  typingAnimation: true,
  permissionMode: "default",
  rules: [],
};

/**
 * Anthropic subscription (Claude Pro/Max) OAuth status. Mirrors the Rust
 * core's `OAuthStatus` serde model. `expiresAt` is a unix timestamp in
 * SECONDS (null when not signed in / unknown).
 */
export interface OAuthStatus {
  signedIn: boolean;
  expiresAt: number | null;
  /** Signed-in account email (from the OAuth profile); null if unknown. */
  account: string | null;
  /** Plan-tier display label, e.g. "Claude Max" / "Claude Pro"; null if unknown. */
  tier: string | null;
}

/** A single selectable model, tagged with the provider that serves it. */
export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
}

/** A provider and the models it offers — the unit the picker groups by. */
export interface ProviderGroup {
  id: string;
  label: string;
  models: ModelInfo[];
}

/**
 * Provider-grouped model catalogue. Only Anthropic is wired up and working
 * today, so it is the only provider listed — we never surface providers that
 * don't actually run (that would be dishonest UI). Adding a real provider later
 * is a data change here, not a structural rewrite.
 */
export const PROVIDERS: ProviderGroup[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    models: [
      { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "anthropic" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", provider: "anthropic" },
    ],
  },
];

/**
 * Flat list of every model across all providers. Derived from PROVIDERS so the
 * grouped catalogue stays the single source of truth. Each element carries the
 * extra `provider` field, which is backward-compatible with `{id,label}` uses.
 */
export const MODELS: ModelInfo[] = PROVIDERS.flatMap((p) => p.models);

export interface Usage {
  input: number;
  output: number;
}

/**
 * One session's cumulative token usage, as returned by the `get_usage` /
 * `get_all_usage` IPC commands (mirrors the Rust `UsageRow`, camelCase). The
 * `get_all_usage` bundle hydrates the in-memory usage map on startup so per-session
 * meters — and the workspace-total spend in the status HUD — survive a restart.
 */
export interface SessionUsage {
  sessionId: string;
  input: number;
  output: number;
}

/**
 * One session's persisted unsent composer draft, as returned by the `get_drafts`
 * IPC command (mirrors the Rust `DraftRow`, camelCase). The bundle is the
 * authoritative restore on startup; an optimistic localStorage mirror gives the
 * instant restore before this resolves (Zeigarnik open-loop).
 */
export interface DraftEntry {
  sessionId: string;
  text: string;
}

/**
 * The composer's live presence phase, driven by REAL turn/stream events (never
 * padded latency). Surfaced in the `role="status"` region beside the composer:
 * - `idle`     — at rest ("ready when you are").
 * - `received` — the instant a turn is sent, before the first byte ("got it — reading…").
 * - `thinking` — the first real stream event arrived, or a 900ms settle fallback fired
 *   ("thinking with you…").
 * - `stopping` — the user pressed Stop; acknowledged in <100ms before the cancel resolves.
 */
export type ComposerPhase = "idle" | "received" | "thinking" | "stopping";

// ── Phone Sync ────────────────────────────────────────────────────────────────

/** A phone that has been paired with this desktop device. */
export interface PairedDevice {
  publicKey: string;
  name: string;
  pairedAt: number;
  lastSeen: number;
  /** Whether the desktop user has confirmed this device's SAS (the trust gate).
   *  An unconfirmed device is never served the command surface. */
  confirmed: boolean;
}

/** Returned by `phone_sync_status`: this device's identity + all paired phones. */
export interface PhoneSyncStatus {
  devicePublicKey: string;
  paired: PairedDevice[];
}

/**
 * Payload of the desktop-side `phone-sync://pairing-request` event: an untrusted
 * phone completed the handshake inside an open pairing window and is awaiting the
 * desktop user's SAS confirmation. The user compares `sas` with the code shown on
 * the phone, then calls `confirm_pairing(requestId)` or `reject_pairing(requestId)`.
 */
export interface PairingRequest {
  requestId: string;
  sas: string;
  /** The phone's pinned Noise static key (base64) — shown for reference. */
  peerKeyHex: string;
}

/**
 * The desktop's dialable iroh node address, as carried in a {@link PairingPayload}.
 * Opaque to the UI — the phone deserializes it back into an iroh `EndpointAddr`
 * to dial; the desktop side never introspects it. Shape mirrors iroh's
 * `EndpointAddr` JSON serialization (an `id` plus transport addresses).
 */
export type PairingNodeAddr = Record<string, unknown>;

/**
 * The payload returned by `phone_sync_begin_pairing`. The contents should be
 * displayed as copyable text (or a QR code) for the phone to scan / enter.
 * TODO: render as a QR code image in a later iteration.
 */
export interface PairingPayload {
  version: number;
  publicKey: string;
  nonce: string;
  /**
   * The desktop's dialable iroh node address — the phone needs it to know where to
   * connect. The desktop ALWAYS populates this, and the Rust `phone_sync_connect`
   * deserializer REQUIRES it, so a real payload never omits it. The `?` is only a
   * defensive concession for a hand-pasted/partial payload, which the phone then
   * surfaces as a connect error rather than dialing without an address.
   */
  nodeAddr?: PairingNodeAddr;
}

// ── Mobile remote client (the phone drives a paired desktop) ───────────────────

/** Result of `phone_sync_connect` — mirrors the Rust `ConnectInfo` (camelCase).
 *  `sas` is the short authentication string the user compares out-of-band; the
 *  `peerPublicKey` is the desktop key the phone pinned. */
export interface ConnectInfo {
  sas: string;
  peerPublicKey: string;
  /**
   * The desktop's Web Push VAPID PUBLIC key (base64url), learned at connect time
   * from the pairing payload. The Rust side adds `vapid_public_key` to
   * `PairingPayload` + a `vapidPublicKey` getter on the wasm `Session`. The
   * installed iOS PWA uses it as the `applicationServerKey` when subscribing to
   * Web Push, then registers the subscription with the desktop via a
   * `register_push` {@link RemoteCommand} (§5.7). Optional: absent on a desktop
   * that predates push support and on the inert preview/mock — push is
   * best-effort re-engagement, never core, so its absence degrades to a no-op.
   */
  vapidPublicKey?: string;
}

/**
 * A command the phone issues to drive the always-on desktop. The wire shape is
 * **snake_case** (serde internally-tagged on `cmd`) — it mirrors the Rust
 * `RemoteCommand` exactly, so it is sent to `phone_sync_send_command` verbatim.
 */
export type RemoteCommand =
  | { cmd: "run"; session_id: string; text: string }
  | { cmd: "cancel"; session_id: string }
  | { cmd: "cancel_agent"; agent_id: string }
  | { cmd: "permission"; id: string; decision: string }
  | { cmd: "create_session"; title?: string | null }
  /**
   * Register an installed-PWA Web Push subscription with the desktop (the push
   * SENDER) so it can deliver "permission needed" / "turn finished" notifications
   * (§5.7). `endpoint` is the push service URL; `p256dh`/`auth` are the
   * base64url-encoded subscription keys from `PushSubscription.getKey(...)`. The
   * desktop sends VAPID-signed pushes to `endpoint` using these. Sent best-effort
   * after a successful `PushManager.subscribe` — never on the native/Tauri path.
   */
  | { cmd: "register_push"; endpoint: string; p256dh: string; auth: string };

/** A catch-up message row from the desktop (camelCase; mirrors Rust `MessageRow`).
 *  Distinct from {@link Message}: it carries the session id + monotonic `seq`. */
export interface MessageRow {
  id: string;
  sessionId: string;
  seq: number;
  role: Role;
  content: ContentBlock[];
  createdAt: number;
}

/**
 * A frame on the phone↔desktop channel, delivered to the phone via the
 * `phone-sync://frame` event. Mirrors the Rust `SyncFrame` (serde tag `t`,
 * snake_case variants). The phone receives `sessionList`/`messageDelta`/`live`;
 * the others exist for completeness. Frame-level fields stay snake_case; the
 * nested rows (`Session`/`MessageRow`/`Cursor`) are camelCase.
 */
export type SyncFrame =
  | { t: "session_list"; sessions: Session[] }
  | { t: "message_delta"; session_id: string; messages: MessageRow[] }
  | { t: "live"; session_id: string; event: StreamEvent }
  | { t: "command"; command: RemoteCommand }
  | { t: "ack"; session_id: string; seq: number }
  | { t: "hello"; device_id: string; cursors: { sessionId: string; seq: number }[] }
  // The desktop declined the pairing (SAS mismatch / user reject). The phone must
  // stop: it drops the session and shows a "rejected on the other device" notice.
  // `reason` is an optional human-readable note; absent/null when none was given.
  | { t: "pairing_reject"; reason?: string | null };

// Anthropic list prices, USD per million tokens (input / output).
export const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};

export function estimateCost(model: string, usage: Usage): number {
  const p = MODEL_PRICING[model] ?? { in: 0, out: 0 };
  return (usage.input * p.in + usage.output * p.out) / 1_000_000;
}
