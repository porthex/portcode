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
  createdAt: number;
  updatedAt: number;
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
    }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn_end"; stopReason: string }
  | { type: "error"; message: string };

export interface PendingPermission {
  id: string;
  tool: string;
  summary: string;
  input: unknown;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export type ToolPolicy = "allow" | "ask" | "deny";

export interface Settings {
  provider: "anthropic";
  model: string;
  apiKeySet: boolean;
  defaultPolicy: ToolPolicy;
  workspace: string | null;
  /** Reveal the agent's reply with a terminal-style typing animation. */
  typingAnimation: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  apiKeySet: false,
  defaultPolicy: "ask",
  workspace: null,
  typingAnimation: true,
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

export const MODELS = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export interface Usage {
  input: number;
  output: number;
}

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
  | { t: "hello"; device_id: string; cursors: { sessionId: string; seq: number }[] };

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
