// Shared types. These mirror the Rust core's serde models so the IPC boundary
// stays a single source of truth.

import type { ToolName } from "./lib/toolNames";

export type Role = "user" | "assistant" | "system";

export type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: ToolName; input: unknown }
  | { kind: "tool_result"; toolUseId: string; output: string; isError: boolean };

/**
 * Defensive compatibility shape for opaque OpenAI continuation metadata from
 * an older/raw sync peer. Current desktop builds filter it before Phone Sync;
 * it is never a renderable ContentBlock.
 */
export interface ReasoningWireBlock {
  type: "reasoning";
  model?: string | null;
  id?: string | null;
  encrypted_content?: string | null;
  summary?: unknown[];
}

export interface Message {
  id: string;
  role: Role;
  blocks: ContentBlock[];
  createdAt: number;
  /** Stable native turn identity. Absent on legacy persisted messages. */
  turnId?: string;
  /** Durable completion metadata. Present only after this assistant turn settles. */
  receipt?: TurnReceipt;
}

/** A display-ready page of persisted conversation history. `nextCursor` is an
 * opaque backend cursor for the next older page; null means the beginning. */
export interface UiMessagePage {
  messages: Message[];
  nextCursor: string | null;
}

export type MessageLoadPhase = "idle" | "loading" | "refreshing" | "ready" | "error";

/** Per-session transcript hydration/cache metadata. */
export interface MessageLoadState {
  phase: MessageLoadPhase;
  loadedAt: number | null;
  lastAccessedAt: number;
  requestId: number;
  error: string | null;
  nextCursor: string | null;
  loadingOlder: boolean;
}

export type SessionActivity = "idle" | "running" | "waiting" | "stopping";

/** Durable terminal state for one top-level agent turn. */
export type TurnStatus = "completed" | "cancelled" | "error" | "interrupted";

/**
 * How confidently a changed-file entry can be attributed to this turn. `exact`
 * is tool-observed, `observed` is a before/after workspace delta, `ambiguous`
 * may include concurrent/background changes, and `unavailable` means no reliable
 * workspace comparison was possible.
 */
export type TurnChangeCertainty = "exact" | "observed" | "ambiguous" | "unavailable";

/** One compact changed-file row persisted with a turn receipt. */
export interface TurnChangedFile {
  path: string;
  oldPath?: string;
  status: GitChangeStatus;
  additions?: number;
  deletions?: number;
  binary: boolean;
  certainty: TurnChangeCertainty;
}

/** Persisted, reload-safe completion metadata for an assistant turn. */
export interface TurnReceipt {
  turnId: string;
  status: TurnStatus;
  /** Provider/native stop reason; omitted when the turn failed before one existed. */
  stopReason?: string;
  startedAt: number;
  completedAt: number;
  /** Omitted for startup-recovered interruptions whose actual end time is unknown. */
  durationMs?: number;
  changedFiles: TurnChangedFile[];
  changedFileCount: number;
  additions: number;
  deletions: number;
  filesTruncated: boolean;
  changeCertainty: TurnChangeCertainty;
  /** True when commands launched by this turn were still alive at completion. */
  backgroundTasksRunning: boolean;
}

/** Read-only review manifest captured for one completed turn. */
export interface TurnReviewManifest {
  turnId: string;
  snapshotId: string;
  repositoryRoot: string;
  receipt: TurnReceipt;
  files: TurnChangedFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
  /** False when the receipt is durable but historical patch bodies are unavailable. */
  patchesAvailable: boolean;
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
  | {
      type: "turn_start";
      messageId: string;
      /** Optional only so an older desktop/phone peer degrades safely. */
      turnId?: string;
      /** Native wall-clock start. Optional only for legacy peers. */
      startedAt?: number;
    }
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: ToolName; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError: boolean }
  | {
      type: "permission_request";
      id: string;
      tool: ToolName;
      summary: string;
      input: unknown;
      /** Pre-apply unified diff for file tools; absent for commands/other. */
      diff?: string;
    }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn_end"; stopReason: string; receipt?: TurnReceipt }
  | { type: "error"; message: string; receipt?: TurnReceipt }
  // ── subagents (`delegate_task`; historical `task`) ─────────────────────
  /** A subagent started. `parentId` is the launching subagent, absent at top level. */
  | { type: "agent_started"; agentId: string; description: string; parentId?: string }
  /** A subagent completed a model turn — `step` is its 1-based turn count. */
  | { type: "agent_progress"; agentId: string; step: number }
  /** A subagent finished. `status` is "ok" | "cancelled" | "error". */
  | { type: "agent_finished"; agentId: string; status: string }
  // ── background command tasks (`run_command`; historical `shell`) ─────────────
  /** A command was launched in the background. Emitted on the SESSION
   *  channel, so the persistent session listener (not the per-turn one) tracks it. */
  | { type: "background_task_started"; id: string; command: string }
  /** A background command finished. Can arrive AFTER the launching turn
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

/** Live/terminal state of a background command task. `running` until it finishes,
 *  then `ok` (exit 0) or `error` (any non-zero / failed-to-run exit). */
export type BackgroundTaskStatus = "running" | "ok" | "error";

/** A background command task (`run_command` background mode) tracked per session
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

/** A subagent (`delegate_task`) tracked for the live agents panel. */
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
  tool: ToolName;
  summary: string;
  input: unknown;
  /** Pre-apply unified diff for file tools; absent for commands/other. */
  diff?: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export type WorkspaceGitSummary =
  | {
      kind: "repository";
      branch: string | null;
      detachedHead: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      changedFiles: number;
      untrackedFiles: number;
      additions: number;
      deletions: number;
    }
  | { kind: "notRepository" }
  | { kind: "unavailable"; reason: "missing" | "timeout" | "failed" };

/** Read-only facts for the workspace actually used by native agent runs. */
export interface WorkspaceSummary {
  path: string;
  /** False when the native core fell back to its process working directory. */
  configured: boolean;
  git: WorkspaceGitSummary;
}

/** The main desktop work surface. Review is workspace-scoped, not session history. */
export type WorkspaceSurface = "chat" | "review";

/** Which review context the workspace surface should present. */
export type ReviewTarget = { kind: "workspace" } | { kind: "turn"; turnId: string };

export type GitReviewScope =
  | { kind: "workingTree" }
  | { kind: "staged" }
  | { kind: "unstaged" }
  | { kind: "branch"; base: string }
  | { kind: "commit"; revision: string };

export interface GitReviewBranch {
  /** User-facing short name, such as `main` or `origin/main`. */
  name: string;
  /** Fully qualified ref passed back to Git, avoiding ambiguous short names. */
  revision: string;
  kind: "local" | "remote";
  current: boolean;
}

export type GitChangeArea = "staged" | "unstaged" | "untracked" | "committed";
export type GitChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "unmerged";

export interface GitChangedFile {
  path: string;
  oldPath: string | null;
  status: GitChangeStatus;
  /** A working-tree file can be present in both the staged and unstaged groups. */
  areas: GitChangeArea[];
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface GitReviewManifest {
  snapshotId: string;
  repositoryRoot: string;
  scope: GitReviewScope;
  baseLabel: string;
  targetLabel: string;
  headOid: string | null;
  files: GitChangedFile[];
  additions: number;
  deletions: number;
  /** Metadata or snapshot fingerprinting reached a native safety cap. */
  truncated: boolean;
}

export type GitDiffLineKind = "context" | "addition" | "deletion" | "meta";

export interface GitDiffLine {
  kind: GitDiffLineKind;
  /** Line content without the unified-diff +/-/space prefix. */
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface GitDiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: GitDiffLine[];
}

export interface GitFilePatch {
  snapshotId: string;
  path: string;
  oldPath: string | null;
  status: GitChangeStatus;
  binary: boolean;
  filePatchHash: string;
  hunks: GitDiffHunk[];
  truncated: boolean;
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
 * before the mode default, first match wins. `command` is a literal terminal
 * command PREFIX (an allow-list convenience, never a guarantee — anything
 * chained after the prefix matches too).
 */
export interface Rule {
  tool: ToolName | "*";
  command?: string;
  decision: ToolPolicy;
}

export interface Settings {
  provider: ProviderId;
  model: string;
  /** Default/current reasoning level for OpenAI subscription models. */
  reasoningEffort: ReasoningEffort;
  /** OpenAI response processing tier. Fast requests priority processing. */
  responseSpeed: ResponseSpeed;
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
  /** Download + install new versions automatically, then prompt to relaunch. */
  autoUpdate: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  reasoningEffort: "medium",
  responseSpeed: "standard",
  apiKeySet: false,
  defaultPolicy: "ask",
  workspace: null,
  // Keep the core chat path immediate by default. The decode effect remains an
  // opt-in visual preference for people who enjoy it, but should never be the
  // reason a healthy stream feels behind the model.
  typingAnimation: false,
  permissionMode: "default",
  rules: [],
  autoUpdate: true,
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

/** Providers backed by Portcode's native agent runtimes. */
export type ProviderId = "anthropic" | "openai";

/** One provider-reported subscription quota window. `usedPercent` is normalized
 * to 0..100 by the native core. `resetsAt` may be RFC 3339 or unix seconds because
 * the providers currently use different wire formats. */
export interface PlanUsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

/** Display-safe plan quota snapshot; never contains OAuth tokens or raw headers. */
export interface PlanUsageSnapshot {
  provider: ProviderId;
  plan: string | null;
  windows: PlanUsageWindow[];
  /** Unix timestamp in seconds when the native core completed the fetch. */
  updatedAt: number;
}

/** Known reasoning levels plus a forward-compatible live-catalogue escape hatch. */
export type KnownReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "custom";
export type ReasoningEffort = KnownReasoningEffort | (string & {});

export type ResponseSpeed = "standard" | "fast";

export const REASONING_EFFORT_LABELS: Record<KnownReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
  custom: "Custom",
};

export function reasoningEffortLabel(effort: ReasoningEffort): string {
  return (
    REASONING_EFFORT_LABELS[effort as KnownReasoningEffort] ??
    effort.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/** ChatGPT subscription auth state, intentionally distinct from Claude OAuth. */
export interface OpenAIAuthStatus {
  signedIn: boolean;
  expiresAt: number | null;
  account: string | null;
  tier: string | null;
  /** False when this build deliberately excludes direct ChatGPT subscription access. */
  available?: boolean;
  /** User-facing reason supplied by the native capability gate. */
  unavailableReason?: string | null;
}

/** Row returned by the native `openai_models` catalogue command. */
export interface OpenAIModelCatalogRow {
  id: string;
  label: string;
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
}

/** A single selectable model, tagged with the provider that serves it. */
export interface ModelInfo {
  id: string;
  label: string;
  provider: ProviderId;
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

/** A provider and the models it offers — the unit the picker groups by. */
export interface ProviderGroup {
  id: ProviderId;
  label: string;
  models: ModelInfo[];
}

/** Provider-grouped catalogue: static Claude models plus OpenAI live/fallback rows. */
export const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "anthropic" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", provider: "anthropic" },
];

const OPENAI_FALLBACK_REASONING: ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Offline-safe choices used until the signed-in Codex catalogue arrives. */
export const OPENAI_FALLBACK_MODELS: ModelInfo[] = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    provider: "openai",
    reasoningEfforts: OPENAI_FALLBACK_REASONING,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    provider: "openai",
    reasoningEfforts: OPENAI_FALLBACK_REASONING,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    provider: "openai",
    reasoningEfforts: OPENAI_FALLBACK_REASONING,
    defaultReasoningEffort: "medium",
  },
];

/** Prefer a non-empty live subscription catalogue; use fallbacks only offline. */
export function mergeOpenAIModels(rows: OpenAIModelCatalogRow[] = []): ModelInfo[] {
  const normalized = rows
    .filter((row) => row.id.trim() !== "")
    .map<ModelInfo>((row) => ({
      id: row.id,
      label: row.label || row.id,
      provider: "openai",
      reasoningEfforts: [...new Set(row.reasoningEfforts ?? [])],
      defaultReasoningEffort: row.defaultReasoningEffort || "medium",
    }));
  const live = [...new Map(normalized.map((model) => [model.id, model])).values()];
  return live.length > 0 ? live : OPENAI_FALLBACK_MODELS;
}

export function providerGroups(
  openAIModels: ModelInfo[] = OPENAI_FALLBACK_MODELS,
): ProviderGroup[] {
  return [
    { id: "anthropic", label: "Anthropic · Claude", models: ANTHROPIC_MODELS },
    { id: "openai", label: "OpenAI · ChatGPT subscription", models: openAIModels },
  ];
}

export const PROVIDERS: ProviderGroup[] = providerGroups();

/**
 * Flat list of every model across all providers. Derived from PROVIDERS so the
 * grouped catalogue stays the single source of truth. Each element carries the
 * extra `provider` field, which is backward-compatible with `{id,label}` uses.
 */
export const MODELS: ModelInfo[] = PROVIDERS.flatMap((p) => p.models);

export function modelCatalog(openAIModels: ModelInfo[] = OPENAI_FALLBACK_MODELS): ModelInfo[] {
  return [...ANTHROPIC_MODELS, ...openAIModels];
}

export function modelInfo(
  id: string,
  openAIModels: ModelInfo[] = OPENAI_FALLBACK_MODELS,
): ModelInfo | undefined {
  return modelCatalog(openAIModels).find((model) => model.id === id);
}

/** Resolve provider from catalogue first, with a conservative unknown-slug fallback. */
export function providerForModel(
  id: string,
  openAIModels: ModelInfo[] = OPENAI_FALLBACK_MODELS,
): ProviderId {
  const known = modelInfo(id, openAIModels);
  if (known) return known.provider;
  if (/^(gpt-|o\d|codex-|openai-)/i.test(id)) return "openai";
  return "anthropic";
}

/** Pick a supported effort, preferring the model's advertised default. */
export function reasoningEffortForModel(
  id: string,
  current: ReasoningEffort,
  openAIModels: ModelInfo[] = OPENAI_FALLBACK_MODELS,
): ReasoningEffort {
  const model = modelInfo(id, openAIModels);
  const supported = model?.reasoningEfforts ?? [];
  if (supported.length === 0 || supported.includes(current)) return current;
  if (model?.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return supported[0] ?? current;
}

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
 * One message-search hit from `search_messages` (mirrors the Rust `SearchHit`,
 * camelCase). Newest-first; the command palette jumps to `sessionId` and scrolls
 * to `messageId`. `snippet` is a one-line excerpt around the match.
 */
export interface SearchHit {
  sessionId: string;
  messageId: string;
  seq: number;
  role: Role;
  snippet: string;
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

// ── Auto-update ────────────────────────────────────────────────────────────────

/**
 * A pending application update, as returned by `update_check`. Mirrors the Rust
 * core's `UpdateInfo` serde model; `update_check` resolves null when the running
 * build is already the latest. `notes`/`date` are best-effort metadata from the
 * release manifest (null when the feed omits them).
 */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
  date: string | null;
}

/** Which release feed this build follows. Portcode ships a single public
 *  `stable` channel (the rolling `staging` pre-release feed was retired).
 *  Returned by `update_channel`. */
export type UpdateChannel = "stable";

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
  | { cmd: "create_session"; title?: string | null; request_id?: string }
  /**
   * Request an OLDER page of a session's history for scroll-up pagination. The
   * initial catch-up ships only the most-recent window; scrolling up past it asks
   * the desktop for the rows STRICTLY BEFORE `before_seq` (up to `limit`). The
   * desktop answers with a `message_page` {@link SyncFrame}. `before_seq` is the
   * smallest `seq` the client currently holds for the session. Mirrors the Rust
   * `RemoteCommand::FetchMessages` (snake_case fields).
   */
  | { cmd: "fetch_messages"; session_id: string; before_seq: number; limit: number }
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
  content: Array<ContentBlock | ReasoningWireBlock>;
  createdAt: number;
  /** Stable turn identity and receipt are absent on legacy catch-up rows. */
  turnId?: string;
  receipt?: TurnReceipt;
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
  | { t: "session_created"; request_id: string; session: Session }
  | { t: "message_delta"; session_id: string; messages: MessageRow[] }
  // An OLDER page of one session's history (scroll-up pagination), answering a
  // `fetch_messages` command. `messages` are the rows before the requested cursor,
  // ascending; `has_more` is true when still older history exists. PREPENDED to the
  // held list (vs message_delta, which replaces/appends recent rows). Mirrors the
  // Rust `SyncFrame::MessagePage` (frame fields snake_case; rows camelCase).
  | { t: "message_page"; session_id: string; messages: MessageRow[]; has_more: boolean }
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
