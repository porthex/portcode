import { create } from "zustand";
import type {
  AgentInfo,
  AgentStatus,
  ArchiveSessionResult,
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  ComposerPhase,
  ContentBlock,
  DraftEntry,
  Message,
  MessageLoadState,
  MessageRow,
  ModelInfo,
  OAuthStatus,
  OpenAIAccountSummary,
  OpenAIAuthStatus,
  OpenAIModelCatalogState,
  OpenAIReconnectMismatch,
  PairingPayload,
  PairingRequest,
  PendingPermission,
  PermissionMode,
  PhoneSyncStatus,
  ReviewTarget,
  RemoteCommand,
  Rule,
  SearchHit,
  Session,
  SessionFolder,
  SessionGroup,
  SessionSort,
  SessionUsage,
  Settings,
  StreamEvent,
  SyncFrame,
  UpdateChannel,
  UpdateInfo,
  Usage,
  TurnReceipt,
  TurnStatus,
  WorkspaceSurface,
} from "../types";
import {
  CYCLE_MODES,
  DEFAULT_SETTINGS,
  OPENAI_FALLBACK_MODELS,
  normalizeOpenAIModels,
  openAIAccountLabel,
  providerForModel,
  reasoningEffortForModel,
} from "../types";
import * as ipc from "../lib/ipc";
import { isMobilePlatform } from "../lib/platform";
import { markdownLiteralText, remoteAccountLabel } from "../lib/sessionFormat";
import { classifySettingsSaveFailure } from "../lib/settingsPersistence";
import { canonicalToolName, isCommandToolName, toolNamesEquivalent } from "../lib/toolNames";

// ── Per-run state ─────────────────────────────────────────────────────────────
// The streaming/cancel/pendingPermission of a single agent run. Today there is at
// most one run per session (the Rust core refuses a 2nd concurrent run per
// session), so the runs map is keyed by session id; but modelling it as a
// COLLECTION is what lets multiple concurrent agents each carry their own run
// state — the foundation a parallel-agents UI builds on. The top-level
// `streaming`/`cancel`/`pendingPermission` fields are kept as a derived MIRROR of
// the active session's run (see `projectActiveRun`), so every existing component
// and selector keeps reading a single "global" view unchanged.
interface RunState {
  streaming: boolean;
  // The handle that aborts this run. Always null on the phone (the cancel handle
  // belongs to the desktop-local agent run; the phone stops via a remote command).
  cancel: (() => Promise<void>) | null;
  pendingPermission: PendingPermission | null;
  /** Provisional until turn_start reconciles it to the native identity. */
  turnId: string | null;
  /** Native start time when known; optimistic/client-observed before turn_start. */
  startedAt: number | null;
  /** A bounded terminal boundary is active: either Stop acknowledgement or
   * post-response receipt/Git finalization. `streaming` distinguishes the two. */
  finalizing: boolean;
  /** Response time frozen by `turn_phase:agent_completed`; excludes receipt work. */
  agentDurationMs?: number | null;
  /** Monotonic lifecycle revision. Optional for restored/legacy state. */
  phaseRevision?: number;
  /** Last terminal receipt for this session's run, retained after streaming ends. */
  receipt: TurnReceipt | null;
  outcome: TurnStatus | null;
  /** Presence belongs to this run even while another session is selected. */
  composerPhase?: ComposerPhase;
  activeTool?: string | null;
  /** Terminal problem completed off-screen; cleared when the session is viewed. */
  unseenOutcome?: TurnStatus | null;
}

const EMPTY_RUN: RunState = {
  streaming: false,
  cancel: null,
  pendingPermission: null,
  turnId: null,
  startedAt: null,
  finalizing: false,
  agentDurationMs: null,
  phaseRevision: 0,
  receipt: null,
  outcome: null,
  composerPhase: "idle",
  activeTool: null,
  unseenOutcome: null,
};

// Single source of truth for the run-map key. The identity of a session id today;
// the one place to change when a future subagent run needs a composite id (e.g.
// `${sessionId}:${agentId}`) — without touching the StreamEvent wire shape, which
// already carries the session id every write site keys off.
const runKey = (sessionId: string): string => sessionId;

// Build the scoped allow-RULE that "Always allow" adds, instead of flipping the
// global policy to allow-everything. A legacy peer without risk can still scope a
// command to that exact text. Other tools are scoped by tool. Historical names
// are normalized before persistence so new settings never extend the legacy
// vocabulary. The native gate treats this explicit user choice differently from
// an implicit Auto/default allow, so remembered protected approvals are effective.
const scopedAllowRule = (p: PendingPermission): Rule => {
  const tool = canonicalToolName(p.tool);
  if (isCommandToolName(p.tool)) {
    const command = (p.input as { command?: unknown } | null)?.command;
    if (typeof command === "string" && command.length > 0) {
      return { tool, command, decision: "allow" };
    }
  }
  return { tool, decision: "allow" };
};

const sameRuleScope = (left: Rule, right: Rule): boolean =>
  toolNamesEquivalent(left.tool, right.tool) && left.command === right.command;

// Rules are first-match. Put an explicit "Always allow" scope first so an older
// broad ask/deny rule cannot silently shadow the choice the user just made, and
// discard any equivalent legacy/canonical scope instead of leaving dead entries.
const rulesWithEffectiveAllow = (rules: Rule[], allow: Rule): Rule[] => {
  const first = rules[0];
  if (first && sameRuleScope(first, allow) && first.decision === "allow") return rules;
  return [allow, ...rules.filter((rule) => !sameRuleScope(rule, allow))];
};

/**
 * In-app auto-update state, driving the {@link UpdateBanner}.
 * - `idle`       — no update offered (or the banner was dismissed); `error` may
 *                  retain a quiet background-check failure for Settings only.
 * - `available`  — an update exists; awaiting the user's Install (autoUpdate off).
 * - `downloading`— downloading + staging the update; `progress` is a 0–100 percent
 *                  (null = indeterminate, the server reported no total).
 * - `ready`      — downloaded + staged; awaiting a relaunch.
 * - `error`      — an explicit check/download failed; `error` carries the message.
 */
export interface UpdateState {
  phase: "idle" | "available" | "downloading" | "ready" | "error";
  info: UpdateInfo | null;
  progress: number | null;
  error: string | null;
}

const IDLE_UPDATE: UpdateState = { phase: "idle", info: null, progress: null, error: null };

interface TranscriptScrollRequest {
  id: string;
  sessionId: string;
  kind: "latest" | "newTurn";
  targetMessageId?: string;
}

interface AppState {
  sessions: Session[];
  activeId: string | null;
  /** Local-only new-chat shell. It becomes durable on the first send. */
  pendingSession: Session | null;
  messages: Record<string, Message[]>; // sessionId -> messages
  messageLoads: Record<string, MessageLoadState>;
  // Per-session scroll-up pagination state (remote mode). `hasMore` is whether the
  // desktop holds older history beyond what we hold (seeded from each message_page
  // frame; undefined entry = unknown, treated as "might have more"); `loading` guards
  // against firing a second fetch while one is in flight; `oldestSeq` is the smallest
  // `seq` currently held for the session — the `before_seq` cursor the next page
  // request walks back from. The in-memory `Message` doesn't carry `seq`, so it is
  // tracked here from the seq-bearing `message_delta`/`message_page` rows. Keyed by
  // sessionId.
  messagePaging: Record<string, { hasMore: boolean; loading: boolean; oldestSeq: number }>;
  usage: Record<string, Usage>; // sessionId -> cumulative token usage
  agents: Record<string, AgentInfo[]>; // sessionId -> live subagents (the agents panel)
  backgroundTasks: Record<string, BackgroundTaskInfo[]>; // sessionId -> background command tasks
  settings: Settings;
  oauthStatus: OAuthStatus | null; // Claude subscription sign-in state
  oauthError: string | null; // last sign-in/out failure, surfaced in Settings
  openAIAuthStatus: OpenAIAuthStatus | null; // ChatGPT subscription sign-in state
  openAIAuthError: string | null; // OpenAI sign-in/out/catalog failure
  openAIReconnectMismatch: OpenAIReconnectMismatch | null;
  openAIAccounts: OpenAIAccountSummary[]; // display-safe native profile summaries
  openAIAccountsLoading: boolean;
  openAIAccountsError: string | null;
  openAIModelCatalogs: Record<string, OpenAIModelCatalogState>; // strictly profile-scoped
  /** Compatibility/default view: the Settings-selected profile's catalogue. */
  openAIModels: ModelInfo[];
  /** Settings-managed default for new GPT chats. Existing chats stay session-pinned. */
  lastOpenAIAccountProfileId: string | null;
  phoneSync: PhoneSyncStatus | null; // phone sync device identity + paired devices
  pairingPayload: PairingPayload | null; // in-progress pairing code to display
  pairingError: string | null; // last begin-pairing/unpair failure, surfaced in Settings
  // Desktop-side device-trust gate: a phone completed the handshake inside an open
  // pairing window and is awaiting the desktop user's SAS confirmation. Null when
  // no request is outstanding; surfaced in the Settings pairing UI.
  pairingRequest: PairingRequest | null;
  pairingRequestUnlisten: (() => void) | null; // tears down the pairing-request subscription
  creatingSession: boolean; // a newSession() create is in flight (re-entry guard)
  runs: Record<string, RunState>; // runKey(sessionId) -> per-run state (the N-run model)
  // ── Active-run mirror (derived from runs[activeId]) ─────────────────────────
  // These three reflect the ACTIVE session's run, so every component/selector and
  // every re-entry guard keeps reading one "global" view. They are recomputed by
  // `projectActiveRun` in every set() that mutates `runs` or `activeId`; never
  // write them directly — write the run via `setRun`/`runPatch` and they follow.
  streaming: boolean;
  showSettings: boolean;
  showFiles: boolean;
  showSidebar: boolean; // mobile: the session-list drawer (overlay) is open
  sidebarCollapsed: boolean; // desktop: the inline rail is collapsed to a 52px strip
  showPalette: boolean;
  workspaceSurface: WorkspaceSurface; // desktop center route; review is workspace-scoped
  reviewTarget: ReviewTarget; // workspace-wide review or one receipt's persisted turn snapshot

  // ── Sessions sidebar organization (frontend-only overlay, persisted) ─────────
  // The Rust `Session` model is unchanged; folders/membership/archived/sort/group
  // live entirely client-side in localStorage. See lib/sessionView for the pure
  // ordering/grouping logic these drive.
  sortBy: SessionSort; // list order: recent | name | status | manual (drag-reordered)
  groupBy: SessionGroup; // grouping: none (folder tree) | status | branch | workspace
  folders: SessionFolder[]; // user folders (manual-org mode)
  folderOf: Record<string, string | null>; // sessionId → folderId (absent/null = loose)
  archivedIds: string[]; // sessions the user archived
  manualOrder: string[]; // drag-reordered session ids (honoured when sortBy === "manual")
  ambientRain: boolean; // decorative neon-rain backdrop (off by default)
  scanlines: boolean; // CRT scanline overlay (off by default)
  uiScale: number; // interface zoom factor (1 = default); applied via documentElement.style.zoom
  // Per-session unsent composer drafts (Zeigarnik open-loop). Keyed by sessionId
  // so a half-written message can't bleed across sessions; persisted via the
  // backend (durable) with an optimistic localStorage mirror for instant restore.
  drafts: Record<string, string>;
  // The composer's live presence phase, driven by REAL turn/stream events (never
  // padded). Surfaced in the role="status" region beside the composer.
  composerPhase: ComposerPhase;
  // The tool the active turn is currently running (the core's tool name, e.g.
  // `read_file`/`run_command`), or null between tools. Set on a real `tool_use` and cleared
  // on its `tool_result`; surfaced as the "running <tool>…" presence phrase. Display
  // is streaming-gated, so a residual value can never show once a turn ends.
  activeTool: string | null;
  // The message a ⌘K search result asked to reveal; the Chat transcript scrolls it
  // into view, then clears it (see jumpToMessage / clearScrollTarget). Null at rest.
  scrollTargetId: string | null;
  // One-shot navigation intent for transcript positioning. Session selection asks
  // for the latest message; an accepted send asks Chat to place that new user turn
  // at the top with a response runway beneath it.
  transcriptScrollRequest: TranscriptScrollRequest | null;
  crashReporting: boolean | null; // opt-in crash/error reporting; null = not yet asked (show first-run prompt)
  cancel: (() => Promise<void>) | null;
  pendingPermission: PendingPermission | null;

  // ── Error surfacing ─────────────────────────────────────────────────────────
  initError: string | null; // startup (init) failure — Chat shows an error/retry panel
  loadErrors: Record<string, boolean>; // sessionId -> a getMessages load failed; Chat offers retry
  settingsError: string | null; // last saveSettings failure, surfaced in Settings
  workspaceError: string | null; // last openWorkspace (picker/save) failure, surfaced in FileExplorer

  // ── Mobile remote client (this device is the phone driving a paired desktop) ──
  remoteMode: boolean; // render the remote-client shell (pairing → remote session) instead of the desktop layout
  remoteConnected: boolean; // a live desktop session is established
  remoteVerified: boolean; // the user confirmed the SAS matches; gates entry to the remote session
  remoteSas: string | null; // short-auth-string to compare out-of-band; null when not connected
  remotePeerKey: string | null; // the desktop's pinned static public key (from ConnectInfo); the STABLE identity, distinct from the SAS
  remoteVapidKey: string | null; // the desktop's Web Push VAPID public key (from ConnectInfo); null when the desktop sent none. Drives the installed-PWA push subscription (§5.7).
  remoteError: string | null; // last remote failure, surfaced in pairing or session UI
  remoteUnlisten: (() => void) | null; // tears down the frame subscription (private; mirrors `cancel`)
  remoteDropped: boolean; // the live session ended unexpectedly — the UI offers a reconnect
  remoteRejected: boolean; // the pairing was declined (this phone rejected the SAS, or the desktop did) — the UI shows a "rejected" notice
  remoteRejectReason: string | null; // optional human-readable reason from an inbound desktop `pairing_reject`; null when none/locally-initiated
  remoteConnecting: boolean; // a connectRemote dial is in flight (private re-entry guard)
  lastPairingQr: string | null; // last successful pairing payload, kept for one-tap reconnect
  remoteChatOpen: boolean; // remote: a session is open (chat view) vs. the sessions list
  online: boolean; // the device has network — remote needs it to reach the desktop

  // ── Auto-update (desktop only) ────────────────────────────────────────────────
  update: UpdateState; // in-app update flow state, drives the UpdateBanner
  updateChannel: UpdateChannel; // which release feed this build follows

  init: () => Promise<void>;
  retryInit: () => Promise<void>;
  retryLoad: (id: string) => Promise<void>;
  hydrateMessages: (id: string, options?: { force?: boolean; prefetch?: boolean }) => Promise<void>;
  prefetchSession: (id: string) => Promise<void>;
  toggleFiles: () => void;
  toggleSidebar: () => void;
  setShowSidebar: (v: boolean) => void;
  setSidebarCollapsed: (v: boolean) => void;

  // Sidebar organization actions (all persist their slice to localStorage).
  setSortBy: (v: SessionSort) => void;
  setGroupBy: (v: SessionGroup) => void;
  setManualOrder: (ids: string[]) => void; // drag-reorder: records order + flips sortBy to manual
  addFolder: () => void;
  toggleFolder: (id: string) => void;
  renameFolder: (id: string, name: string) => void;
  deleteFolder: (id: string) => void; // members fall back to loose
  moveSessionToFolder: (sessionId: string, folderId: string | null) => void;
  toggleArchived: (sessionId: string, force?: boolean) => Promise<ArchiveSessionResult>;
  setDraft: (v: string) => void;
  appendDraft: (v: string) => void;
  openWorkspace: () => Promise<void>;
  newSession: (accountProfileId?: string, modelId?: string) => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  setSessionModel: (model: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  stopSession: (sessionId: string) => Promise<void>;
  cancelAgent: (agentId: string) => Promise<void>;
  setShowSettings: (v: boolean) => void;
  setShowPalette: (v: boolean) => void;
  setWorkspaceSurface: (v: WorkspaceSurface) => void;
  openWorkspaceReview: () => void;
  openTurnReview: (turnId: string) => void;
  // ── message search (⌘K jump to a past turn) ──
  searchMessages: (query: string) => Promise<SearchHit[]>;
  jumpToMessage: (sessionId: string, messageId: string) => Promise<void>;
  clearScrollTarget: () => void;
  clearTranscriptScrollRequest: (id: string) => void;
  setAmbientRain: (v: boolean) => void;
  setScanlines: (v: boolean) => void;
  setUiScale: (n: number) => void;
  setCrashReporting: (v: boolean) => void;
  updateSettings: (s: Partial<Settings>) => Promise<void>;
  cyclePermissionMode: () => Promise<void>;
  refreshOAuthStatus: () => Promise<void>;
  loginWithClaude: () => Promise<void>;
  logoutClaude: () => Promise<void>;
  refreshOpenAIStatus: () => Promise<void>;
  loginWithOpenAI: () => Promise<void>;
  reconnectOpenAIAccount: (accountProfileId: string) => Promise<void>;
  removeOpenAIAccount: (accountProfileId: string) => Promise<void>;
  setDefaultOpenAIAccount: (accountProfileId: string) => Promise<void>;
  loadOpenAIAccountModels: (accountProfileId: string, force?: boolean) => Promise<ModelInfo[]>;
  pinSessionOpenAIAccount: (
    sessionId: string,
    accountProfileId: string,
  ) => Promise<"selected" | "locked" | "error">;
  refreshPhoneSync: () => Promise<void>;
  beginPairing: () => Promise<void>;
  unpair: (publicKey: string) => Promise<void>;
  clearPairing: () => void;
  listenForPairingRequests: () => Promise<void>;
  confirmPairingRequest: () => Promise<void>;
  rejectPairingRequest: () => Promise<void>;
  resolvePermission: {
    (
      sessionId: string,
      permissionId: string,
      decision: "allow" | "deny",
      always?: boolean,
    ): Promise<void>;
    (decision: "allow" | "deny", always?: boolean): Promise<void>;
  };
  setRemoteMode: (v: boolean) => void;
  clearRemoteError: () => void;
  confirmRemoteSas: () => void;
  rejectRemoteSas: () => Promise<void>;
  applyFrame: (frame: SyncFrame) => void;
  connectRemote: (qr: string, verified?: boolean) => Promise<void>;
  sendRemoteCommand: (command: RemoteCommand) => Promise<void>;
  // Request the next older page of a session's history (scroll-up pagination).
  loadOlderMessages: (sessionId: string) => Promise<void>;
  disconnectRemote: () => Promise<void>;
  reconnectRemote: () => Promise<void>;
  openRemoteSession: (id: string) => Promise<void>;
  closeRemoteSession: () => void;
  forgetRemotePairing: () => void;
  setOnline: (v: boolean) => void;
  hydrateRememberedQr: (qr: string) => void;

  // ── Auto-update ───────────────────────────────────────────────────────────────
  checkForUpdate: (options?: { background?: boolean }) => Promise<void>;
  startUpdateDownload: () => Promise<void>;
  applyUpdateProgress: (downloaded: number, total: number | null) => void;
  markUpdateReady: () => void;
  relaunchForUpdate: () => Promise<void>;
  setAutoUpdate: (enabled: boolean) => Promise<void>;
  loadUpdateChannel: () => Promise<void>;
  dismissUpdateBanner: () => void;
}

// Project the active session's run onto the three mirror fields. Called in every
// set() that changes `runs` or `activeId`, so `streaming`/`cancel`/
// `pendingPermission` always reflect the run on screen. A session with no run (or
// no active session) reads as the empty run, i.e. idle.
const projectActiveRun = (
  st: Pick<AppState, "activeId" | "runs">,
): Pick<
  AppState,
  "streaming" | "cancel" | "pendingPermission" | "composerPhase" | "activeTool"
> => {
  const r = (st.activeId ? st.runs[runKey(st.activeId)] : undefined) ?? EMPTY_RUN;
  return {
    streaming: r.streaming,
    cancel: r.cancel,
    pendingPermission: r.pendingPermission,
    composerPhase: r.composerPhase ?? "idle",
    activeTool: r.activeTool ?? null,
  };
};

// Build the state patch that applies `patch` to `sessionId`'s run and re-projects
// the active-run mirror in the SAME set(). Combine its result with other fields
// (e.g. a `messages` update) by spreading it. This is the only place run state is
// written, so the mirror can never drift from `runs`.
const runPatch = (
  st: Pick<AppState, "activeId" | "runs">,
  sessionId: string,
  patch: Partial<RunState>,
): Pick<
  AppState,
  "runs" | "streaming" | "cancel" | "pendingPermission" | "composerPhase" | "activeTool"
> => {
  const key = runKey(sessionId);
  const runs = { ...st.runs, [key]: { ...(st.runs[key] ?? EMPTY_RUN), ...patch } };
  return { runs, ...projectActiveRun({ activeId: st.activeId, runs }) };
};

// Convenience wrapper around `runPatch` for the common "just patch this run" case.
const setRun = (
  set: (fn: (st: AppState) => Partial<AppState>) => void,
  sessionId: string,
  patch: Partial<RunState>,
): void => set((st) => runPatch(st, sessionId, patch));

// Patch the ACTIVE session's run — for actions (stop / resolvePermission) that
// always target the run on screen. With an active session it goes through
// `runPatch` (run + mirror stay in lockstep); with no active session it clears
// just the named mirror fields, so the visible flags always clear regardless.
// (`Partial<RunState>`'s keys are all mirror fields, so it doubles as the patch.)
const now = () => Date.now();

// ── Live subagents (the agents panel) ────────────────────────────────────────
// The agent lifecycle events (agent_started / agent_progress / agent_finished)
// maintain a per-session list of subagents. These pure helpers let the desktop
// `onEvent` path and the phone `applyRemoteEvent` path update the map identically.

// Map the wire status string to the AgentStatus union (defensive: an unknown
// value reads as a finished "ok" rather than widening the type).
const toAgentStatus = (s: string): AgentStatus =>
  s === "running" || s === "cancelled" || s === "error" ? s : "ok";

const patchAgents = (
  agents: Record<string, AgentInfo[]>,
  sessionId: string,
  fn: (list: AgentInfo[]) => AgentInfo[],
): Record<string, AgentInfo[]> => ({ ...agents, [sessionId]: fn(agents[sessionId] ?? []) });

// Add a newly-started agent, preserving start order; replace on a duplicate id
// (defensive against a re-delivered agent_started) rather than listing it twice.
const startAgent = (list: AgentInfo[], info: AgentInfo): AgentInfo[] =>
  list.some((a) => a.id === info.id)
    ? list.map((a) => (a.id === info.id ? info : a))
    : [...list, info];

// Patch one agent by id; a no-op when the id isn't present (e.g. a progress /
// finished event arriving for an agent whose start we never saw).
const updateAgent = (list: AgentInfo[], id: string, patch: Partial<AgentInfo>): AgentInfo[] =>
  list.map((a) => (a.id === id ? { ...a, ...patch } : a));

// Fold one agent lifecycle StreamEvent into a session's agent list. Shared by the
// desktop and phone event paths; returns the agents map unchanged for any other
// event so callers can route the three agent events through one branch.
const applyAgentEvent = (
  agents: Record<string, AgentInfo[]>,
  sessionId: string,
  e: StreamEvent,
): Record<string, AgentInfo[]> => {
  switch (e.type) {
    case "agent_started":
      return patchAgents(agents, sessionId, (list) =>
        startAgent(list, {
          id: e.agentId,
          description: e.description,
          parentId: e.parentId,
          status: "running",
          step: 0,
        }),
      );
    case "agent_progress":
      return patchAgents(agents, sessionId, (list) =>
        updateAgent(list, e.agentId, { step: e.step }),
      );
    case "agent_finished":
      return patchAgents(agents, sessionId, (list) =>
        updateAgent(list, e.agentId, { status: toAgentStatus(e.status) }),
      );
    default:
      return agents;
  }
};

// ── Background command tasks (the background-tasks panel) ────────────────────
// Mirror the agent helpers, but background tasks intentionally OUTLIVE the turn
// that launched them — so, unlike agents, they are never cleared on a turn
// boundary. Exit code 0 reads as success; anything else (including the -1 the
// backend reports for a child that failed to spawn) reads as an error.
type TerminalAgentStatus = Exclude<AgentStatus, "running">;

// A terminal top-level turn is also a terminal boundary for every child agent it
// launched. Normally `agent_finished` arrives first; this closes the gap when Stop,
// a transport drop, or a listener teardown makes that last lifecycle event miss UI.
const terminalizeRunningAgents = (
  agents: Record<string, AgentInfo[]>,
  sessionId: string,
  status: TerminalAgentStatus,
): Record<string, AgentInfo[]> => {
  const list = agents[sessionId];
  if (!list?.some((agent) => agent.status === "running")) return agents;
  return patchAgents(agents, sessionId, (current) =>
    current.map((agent) => (agent.status === "running" ? { ...agent, status } : agent)),
  );
};

const TOOL_INTERRUPTED_CANCELLED =
  "Interrupted: the run was stopped before this tool returned a result.";
const TOOL_INTERRUPTED_ERROR = "Interrupted: the run ended before this tool returned a result.";

/** Patch exactly one assistant turn. A missing/legacy turn id is a no-op. */
function patchTurnMessage(
  messages: Record<string, Message[]>,
  sessionId: string,
  turnId: string | null | undefined,
  fn: (message: Message) => Message,
): Record<string, Message[]> {
  if (!turnId) return messages;
  const current = messages[sessionId];
  if (!current) return messages;
  const index = current.findIndex(
    (message) =>
      message.role === "assistant" && (message.turnId === turnId || message.id === turnId),
  );
  if (index < 0) return messages;
  const updated = [...current];
  updated[index] = fn(current[index]);
  return { ...messages, [sessionId]: updated };
}

function findTurnMessage(
  messages: Record<string, Message[]>,
  sessionId: string,
  turnId: string | null | undefined,
): Message | undefined {
  if (!turnId) return undefined;
  return messages[sessionId]?.find(
    (message) =>
      message.role === "assistant" && (message.turnId === turnId || message.id === turnId),
  );
}

/** Replace a provisional/local identity with the native turn_start identity.
 * Both optimistic rows share the provisional turn id, so reconcile the user
 * bubble with its assistant. Otherwise a later hydration sees the persisted user
 * row as a different message and appends the optimistic echo again. */
function reconcileTurnMessage(
  messages: Record<string, Message[]>,
  sessionId: string,
  previousTurnId: string | null | undefined,
  turnId: string,
  messageId: string,
  startedAt: number,
): Record<string, Message[]> {
  const current = messages[sessionId];
  if (!current) return messages;
  const index = current.findIndex(
    (message) =>
      message.role === "assistant" &&
      (message.turnId === previousTurnId ||
        message.id === previousTurnId ||
        message.turnId === turnId ||
        message.id === messageId),
  );
  if (index < 0) return messages;
  const updated = current.map((message, messageIndex) => {
    if (messageIndex === index) {
      return { ...message, id: messageId, turnId, createdAt: startedAt };
    }
    if (previousTurnId && message.turnId === previousTurnId) {
      return { ...message, turnId };
    }
    return message;
  });
  return { ...messages, [sessionId]: updated };
}

// ToolCall derives `running` solely from an absent matching tool_result. Append one
// explicit terminal result per unmatched use at every turn boundary so a cancelled
// stream can never leave a permanently pulsing card. The existing block schema also
// round-trips through SQLite/Phone Sync and needs no renderer-specific sentinel.
function finalizePendingTools(blocks: ContentBlock[], output: string): ContentBlock[] {
  const resolved = new Set(
    blocks.flatMap((block) => (block.kind === "tool_result" ? [block.toolUseId] : [])),
  );
  const finalized = new Set<string>();
  const terminalResults: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.kind !== "tool_use" || resolved.has(block.id) || finalized.has(block.id)) continue;
    finalized.add(block.id);
    terminalResults.push({
      kind: "tool_result",
      toolUseId: block.id,
      output,
      isError: true,
    });
  }
  return terminalResults.length > 0 ? [...blocks, ...terminalResults] : blocks;
}

function latestPendingToolName(blocks: ContentBlock[]): string | null {
  const resolved = new Set(
    blocks.flatMap((block) => (block.kind === "tool_result" ? [block.toolUseId] : [])),
  );
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind === "tool_use" && !resolved.has(block.id)) return block.name;
  }
  return null;
}

const fallbackReceipt = (
  st: AppState,
  sessionId: string,
  status: TurnStatus,
  stopReason?: string,
): TurnReceipt | null => {
  const run = st.runs[runKey(sessionId)];
  // Never fabricate metadata for historical/legacy rows. A fallback is valid only
  // for a turn this client actually observed from optimistic send or turn_start.
  if (!run?.turnId || run.startedAt === null) return null;
  const completedAt = now();
  const agentDurationMs = run.agentDurationMs ?? Math.max(0, completedAt - run.startedAt);
  return {
    turnId: run.turnId,
    status,
    ...(stopReason ? { stopReason } : {}),
    startedAt: run.startedAt,
    completedAt,
    durationMs: agentDurationMs,
    agentDurationMs,
    changedFiles: [],
    changedFileCount: 0,
    additions: 0,
    deletions: 0,
    filesTruncated: false,
    changeCertainty: "unavailable",
    changeState: "unknown",
    backgroundTasksRunning: (st.backgroundTasks[sessionId] ?? []).some(
      (task) => task.status === "running",
    ),
  };
};

/** Provisional outcome facts carried by `agent_completed`. They stabilize the
 * assistant bubble and freeze its timer while the authoritative receipt is still
 * being assembled; `turn_end`/`error` replaces this object in place. */
const receiptFromAgentCompletion = (
  st: AppState,
  sessionId: string,
  event: Extract<StreamEvent, { type: "turn_phase" }>,
): TurnReceipt | null => {
  const run = st.runs[runKey(sessionId)];
  if (!run?.turnId || run.turnId !== event.turnId || run.startedAt === null) return null;
  const completedAt = Math.max(run.startedAt, event.at);
  const agentDurationMs = Math.max(0, event.agentDurationMs ?? completedAt - run.startedAt);
  const status = event.status ?? "completed";
  return {
    turnId: event.turnId,
    status,
    ...(event.stopReason ? { stopReason: event.stopReason } : {}),
    startedAt: run.startedAt,
    completedAt,
    durationMs: agentDurationMs,
    agentDurationMs,
    changedFiles: [],
    changedFileCount: 0,
    additions: 0,
    deletions: 0,
    filesTruncated: false,
    changeCertainty: "unavailable",
    changeState: event.receiptExpected === false ? "none" : "unknown",
    backgroundTasksRunning: (st.backgroundTasks[sessionId] ?? []).some(
      (task) => task.status === "running",
    ),
  };
};

const patchTerminalTurnMessage = (
  messages: Record<string, Message[]>,
  sessionId: string,
  previousTurnId: string | null,
  toolOutput: string,
  receipt?: TurnReceipt,
  terminalText?: string,
): Record<string, Message[]> => {
  let next = messages;
  if (receipt && previousTurnId && receipt.turnId !== previousTurnId) {
    next = reconcileTurnMessage(
      next,
      sessionId,
      previousTurnId,
      receipt.turnId,
      receipt.turnId,
      receipt.startedAt,
    );
  }
  const turnId = receipt?.turnId ?? previousTurnId;
  return patchTurnMessage(next, sessionId, turnId, (message) => {
    const finalized = finalizePendingTools(message.blocks, toolOutput);
    const blocks = terminalText ? appendText(finalized, terminalText) : finalized;
    return {
      ...message,
      turnId: turnId ?? message.turnId,
      blocks,
      ...(receipt ? { receipt } : {}),
    };
  });
};

const terminalizeTurnState = (
  st: AppState,
  sessionId: string,
  toolOutput: string,
  status: TurnStatus,
  stopReason?: string,
  nativeReceipt?: TurnReceipt,
  terminalText?: string,
): Pick<
  AppState,
  | "messages"
  | "agents"
  | "runs"
  | "streaming"
  | "cancel"
  | "pendingPermission"
  | "composerPhase"
  | "activeTool"
> => {
  const currentRun = st.runs[runKey(sessionId)] ?? EMPTY_RUN;
  // A native terminal can race with the cancel invoke resolving. Never let the
  // caller's subsequent optimistic fallback overwrite the authoritative receipt
  // that already landed during that acknowledgement window.
  const nativeWithAgentDuration =
    nativeReceipt &&
    nativeReceipt.agentDurationMs === undefined &&
    currentRun.agentDurationMs != null
      ? { ...nativeReceipt, agentDurationMs: currentRun.agentDurationMs }
      : nativeReceipt;
  const receipt =
    nativeWithAgentDuration ??
    currentRun.receipt ??
    fallbackReceipt(st, sessionId, status, stopReason);
  const turnId = receipt?.turnId ?? currentRun.turnId;
  const messages = patchTerminalTurnMessage(
    st.messages,
    sessionId,
    currentRun.turnId,
    toolOutput,
    receipt ?? undefined,
    terminalText,
  );
  const agentStatus: TerminalAgentStatus =
    status === "completed" ? "ok" : status === "cancelled" ? "cancelled" : "error";
  return {
    messages,
    agents: terminalizeRunningAgents(st.agents, sessionId, agentStatus),
    ...runPatch(st, sessionId, {
      streaming: false,
      cancel: null,
      pendingPermission: null,
      turnId,
      startedAt: receipt?.startedAt ?? currentRun.startedAt,
      finalizing: false,
      agentDurationMs:
        receipt?.agentDurationMs ?? currentRun.agentDurationMs ?? receipt?.durationMs ?? null,
      phaseRevision: currentRun.phaseRevision ?? 0,
      receipt,
      outcome: receipt?.status ?? status,
      composerPhase: "idle",
      activeTool: null,
      unseenOutcome:
        st.activeId !== sessionId && status !== "completed" ? (receipt?.status ?? status) : null,
    }),
  };
};

const terminalizeAllRunningTurns = (
  st: AppState,
  toolOutput: string,
  status: TurnStatus,
): Pick<
  AppState,
  "messages" | "agents" | "runs" | "streaming" | "cancel" | "pendingPermission"
> => {
  const sessionIds = new Set(
    Object.entries(st.runs)
      .filter(([, run]) => run.streaming)
      .map(([sessionId]) => sessionId),
  );
  if (st.streaming && st.activeId) sessionIds.add(st.activeId);
  let cursor = st;
  for (const sessionId of sessionIds) {
    const terminal = terminalizeTurnState(cursor, sessionId, toolOutput, status);
    cursor = { ...cursor, ...terminal };
  }
  return {
    messages: cursor.messages,
    agents: cursor.agents,
    runs: cursor.runs,
    ...projectActiveRun(cursor),
  };
};

const bgStatus = (exitCode: number): BackgroundTaskStatus => (exitCode === 0 ? "ok" : "error");

const patchBackgroundTasks = (
  tasks: Record<string, BackgroundTaskInfo[]>,
  sessionId: string,
  fn: (list: BackgroundTaskInfo[]) => BackgroundTaskInfo[],
): Record<string, BackgroundTaskInfo[]> => ({
  ...tasks,
  [sessionId]: fn(tasks[sessionId] ?? []),
});

// Add a newly-started task, preserving launch order. A duplicate start may refresh
// a still-running row, but it must never regress an already-terminal task back to
// running when lifecycle events are replayed or delivered out of order.
const startBackgroundTask = (
  list: BackgroundTaskInfo[],
  info: BackgroundTaskInfo,
): BackgroundTaskInfo[] =>
  list.some((t) => t.id === info.id)
    ? list.map((t) => (t.id === info.id && t.status === "running" ? info : t))
    : [...list, info];

// Fold one background-task StreamEvent into a session's task list. Shared by the
// desktop persistent-listener path and the phone frame path; returns the map
// unchanged for any other event. A `finished` event UPSERTS: it carries the full
// command, so a finish whose `started` we somehow missed still surfaces (rather
// than silently dropping, as an update-by-id would).
const applyBackgroundEvent = (
  tasks: Record<string, BackgroundTaskInfo[]>,
  sessionId: string,
  e: StreamEvent,
): Record<string, BackgroundTaskInfo[]> => {
  switch (e.type) {
    case "background_task_started":
      return patchBackgroundTasks(tasks, sessionId, (list) =>
        startBackgroundTask(list, { id: e.id, command: e.command, status: "running" }),
      );
    case "background_task_finished": {
      const finished: BackgroundTaskInfo = {
        id: e.id,
        command: e.command,
        status: bgStatus(e.exitCode),
        exitCode: e.exitCode,
        output: e.output,
      };
      return patchBackgroundTasks(tasks, sessionId, (list) =>
        list.some((t) => t.id === e.id)
          ? list.map((t) => (t.id === e.id ? { ...t, ...finished } : t))
          : [...list, finished],
      );
    }
    default:
      return tasks;
  }
};

// Desktop persistent background-task listeners, keyed by session id. Module-scoped
// (like `remoteWatchdog`) because they outlive any single action and must survive
// across turns: a `background_task_finished` can land long after the launching
// turn's per-turn listener was disposed. Each subscription folds ONLY background
// events into `backgroundTasks` (the per-turn listener still owns the turn's own
// deltas, so there is no double-handling). Installed only on a DESKTOP that drives
// its own local agent — never in remote mode (see `ensureBackgroundListener`); the
// phone/remote client tracks background tasks via forwarded frames instead.
const bgListeners = new Map<string, () => void>();

// Ensure a persistent background-task listener exists for `sessionId`.
//
// Skipped entirely in remote mode: the phone (and a desktop acting as a remote
// client) receives background events as forwarded frames, so a local
// `agent://{session}` Tauri listener there would be inert AND leak for the app's
// lifetime (nothing emits on that channel, and teardown only runs on delete). The
// other call sites (init/newSession) already early-return in remote mode; this is
// the central guard that also covers selectSession.
//
// Idempotent and race-safe: a UNIQUE reservation token is stored synchronously
// (re-entry guard), and the slot is only CLAIMED after the await if it is still
// that same token — so a teardown, or a fresh reservation, that lands mid-subscribe
// can't be clobbered (we tear our own just-created listener down instead).
const ensureBackgroundListener = async (sessionId: string): Promise<void> => {
  if (useStore.getState().remoteMode) return;
  if (bgListeners.has(sessionId)) return;
  const token = () => {};
  bgListeners.set(sessionId, token); // reserve synchronously (re-entry guard)
  let unlisten: () => void;
  try {
    unlisten = await ipc.subscribeSessionEvents(sessionId, (e) =>
      useStore.setState((st) => ({
        backgroundTasks: applyBackgroundEvent(st.backgroundTasks, sessionId, e),
      })),
    );
  } catch {
    // Subscribe failed — release only OUR reservation (a concurrent retry may have
    // already replaced it), never another's.
    if (bgListeners.get(sessionId) === token) bgListeners.delete(sessionId);
    return;
  }
  if (bgListeners.get(sessionId) !== token) {
    // A teardown removed our reservation, or a newer ensure replaced it, during the
    // await — tear our just-created listener down rather than leak or clobber it.
    unlisten();
    return;
  }
  bgListeners.set(sessionId, unlisten);
};

const teardownBackgroundListener = (sessionId: string): void => {
  const unlisten = bgListeners.get(sessionId);
  if (unlisten) unlisten();
  bgListeners.delete(sessionId);
};

// Tear down EVERY desktop persistent background-task listener. Called when a device
// dials into remote-client mode (the persistent path must never coexist with the
// remote-frame path on one device, which would otherwise re-populate the just-reset
// `backgroundTasks` map). Exported so tests can reset the module-scoped registry
// between cases.
export const teardownAllBackgroundListeners = (): void => {
  bgListeners.forEach((unlisten) => unlisten());
  bgListeners.clear();
};

// A turn must always reach a terminal state. If the backend hangs or dies without
// emitting turn_end/error, this client-side watchdog force-ends the turn once the
// run has been idle this long, so `streaming` can never get stuck true (which would
// otherwise silently no-op every later send). Kept above the backend's own idle
// timeout so the backend's specific error wins in the normal stalled-network case.
const TURN_IDLE_TIMEOUT_MS = 150_000;
// cancel_agent acknowledges the abort request before the run has captured and
// emitted its durable terminal receipt. Keep listening long enough for native
// finalization, but bound the wait for legacy/mocked cores with no terminal event.
const CANCEL_TERMINAL_GRACE_MS = 30_000;
// `agent_completed` makes the response visibly complete before Git attribution is
// ready. Native has a tighter capture budget; this client cap is the last-resort
// guarantee that a lost terminal event cannot keep Send locked indefinitely.
const RECEIPT_TERMINAL_GRACE_MS = 5_000;

// Serialize model writes per session so two quick selections cannot reach SQLite
// out of order (a slower first invoke completing last would otherwise survive reload).
const sessionModelWriteQueues = new Map<string, Promise<void>>();
const persistedSessionModels = new Map<string, string>();
const openAIModelRequestVersions = new Map<string, number>();
const enqueueSessionModelWrite = (sessionId: string, model: string): Promise<void> => {
  const prior = sessionModelWriteQueues.get(sessionId);
  const write = prior
    ? prior.catch(() => {}).then(() => ipc.updateSessionModel(sessionId, model))
    : ipc.updateSessionModel(sessionId, model);
  sessionModelWriteQueues.set(sessionId, write);
  const cleanup = () => {
    if (sessionModelWriteQueues.get(sessionId) === write) sessionModelWriteQueues.delete(sessionId);
  };
  void write.then(cleanup, cleanup);
  return write;
};

// Stop can land while runAgent is still awaiting its handle. Keep that intent
// separate from `streaming` so the composer remains blocked until cancellation is
// actually acknowledged (or fails visibly) instead of claiming the run stopped.
const stopRequestedSessions = new Set<string>();
let pendingRemoteCreateRequestId: string | null = null;
let pendingRemoteCreateTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRemoteFirstMessage: { draftId: string; body: string } | null = null;
const clearPendingRemoteCreate = (): void => {
  pendingRemoteCreateRequestId = null;
  pendingRemoteFirstMessage = null;
  if (pendingRemoteCreateTimer !== null) clearTimeout(pendingRemoteCreateTimer);
  pendingRemoteCreateTimer = null;
};
// Marks production local cancel wrappers that retain their event listener for a
// later native receipt. Restored/legacy callbacks are not in this set and keep the
// old immediate fallback behavior.
const receiptAwareCancels = new WeakSet<() => Promise<void>>();

// Remote-turn idle watchdog (symmetric with the local one in send()). In remote
// mode the turn runs on the desktop and only a desktop-originated live frame can
// clear `streaming`; if the channel stays alive but the desktop's agent dies/hangs
// without emitting turn_end/error (no drop, the send resolved), the phone is stuck
// with a disabled composer forever. This module-scoped handle drives a force-end on
// idle. Module-scoped (not closure-scoped like the local watchdog) so the remote
// frame handler, drop listener, stop(), and disconnect can all reset/clear it.
const remoteWatchdogs = new Map<string, ReturnType<typeof setInterval>>();
const remoteLastActivity = new Map<string, number>();
const remoteCancelTerminalTimers = new Map<string, ReturnType<typeof setTimeout>>();

const clearRemoteWatchdog = (sessionId?: string): void => {
  const ids = sessionId === undefined ? [...remoteWatchdogs.keys()] : [sessionId];
  for (const id of ids) {
    const timer = remoteWatchdogs.get(id);
    if (timer !== undefined) clearInterval(timer);
    remoteWatchdogs.delete(id);
    remoteLastActivity.delete(id);
  }
};

const clearRemoteCancelTerminalTimer = (sessionId?: string): void => {
  const ids = sessionId === undefined ? [...remoteCancelTerminalTimers.keys()] : [sessionId];
  for (const id of ids) {
    const timer = remoteCancelTerminalTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    remoteCancelTerminalTimers.delete(id);
  }
};

const armRemoteWatchdog = (sessionId: string, turnId: string): void => {
  clearRemoteWatchdog(sessionId);
  remoteLastActivity.set(sessionId, now());
  const timer = setInterval(() => {
    const st = useStore.getState();
    const run = st.runs[runKey(sessionId)];
    if (remoteWatchdogs.get(sessionId) !== timer || !run?.streaming || run.turnId !== turnId) {
      clearRemoteWatchdog(sessionId);
      return;
    }
    if (now() - (remoteLastActivity.get(sessionId) ?? 0) < TURN_IDLE_TIMEOUT_MS) return;
    clearRemoteWatchdog(sessionId);
    clearSettleTimer(sessionId);
    useStore.setState((current) =>
      terminalizeTurnState(
        current,
        sessionId,
        TOOL_INTERRUPTED_ERROR,
        "interrupted",
        undefined,
        undefined,
        "\n\n**The desktop stopped responding (timed out).**",
      ),
    );
  }, 1000);
  remoteWatchdogs.set(sessionId, timer);
};

// ── Draft persistence ─────────────────────────────────────────────────────────
// The optimistic localStorage mirror (written synchronously by setDraft) gives the
// instant restore; the durable backend write is DEBOUNCED so a burst of keystrokes
// doesn't hammer SQLite. One timer per session, keyed so switching sessions can't
// drop a pending save. A send (or any clear) flushes immediately instead.
const DRAFT_SAVE_DEBOUNCE_MS = 400;
const draftSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

const flushPendingDraftSave = (sessionId: string): void => {
  const t = draftSaveTimers.get(sessionId);
  if (t !== undefined) {
    clearTimeout(t);
    draftSaveTimers.delete(sessionId);
  }
};

// Fire the durable backend write. Best-effort: a backend reject is swallowed (the
// localStorage mirror already holds the value). Wrapped so the debounce timer can
// never throw an unhandled error — tolerating a test IPC mock that omits saveDraft
// (a missing fn throws synchronously) or returns a non-promise.
const fireDraftSave = (sessionId: string, text: string): void => {
  try {
    void Promise.resolve(ipc.saveDraft(sessionId, text)).catch(() => {});
  } catch {
    /* ipc.saveDraft unavailable in this environment — drop the durable write */
  }
};

// Persist a session's draft to the durable backend. `immediate` (send/clear) skips
// the debounce and cancels any pending one so a just-sent draft can't be resurrected
// by a stale timer.
const persistDraft = (sessionId: string, text: string, immediate: boolean): void => {
  flushPendingDraftSave(sessionId);
  if (immediate) {
    fireDraftSave(sessionId, text);
    return;
  }
  draftSaveTimers.set(
    sessionId,
    setTimeout(() => {
      draftSaveTimers.delete(sessionId);
      fireDraftSave(sessionId, text);
    }, DRAFT_SAVE_DEBOUNCE_MS),
  );
};

// Merge the durable backend drafts under the optimistic localStorage mirror. The
// mirror is written on every keystroke (synchronous) and so is never staler than
// the debounced backend — it WINS on conflict, while the backend fills in keys the
// mirror lacks (e.g. localStorage was evicted but SQLite survived).
const mergeDrafts = (
  mirror: Record<string, string>,
  rows: DraftEntry[],
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.text) out[r.sessionId] = r.text;
  return { ...out, ...mirror };
};

const usageFromRows = (rows: SessionUsage[]): Record<string, Usage> => {
  const out: Record<string, Usage> = {};
  for (const r of rows) out[r.sessionId] = { input: r.input, output: r.output };
  return out;
};

// ── Composer presence settle ──────────────────────────────────────────────────
// The instant a turn is sent we show "got it — reading…"; the first REAL stream
// event settles it to "thinking with you…". This timer is the FALLBACK for a turn
// that takes a beat to produce its first byte — it is NOT padded latency: the real
// event (text_delta/tool_use), when it arrives first, settles the phase and cancels
// this timer (see onEvent / applyRemoteEvent).
const COMPOSER_SETTLE_MS = 900;
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();

// How many older messages one scroll-up pagination request fetches (the desktop
// clamps it to its own max). Comfortably under the catch-up window so a page is a
// modest, send-safe increment.
const PAGE_SIZE = 100;

const clearSettleTimer = (sessionId?: string): void => {
  const ids = sessionId === undefined ? [...settleTimers.keys()] : [sessionId];
  for (const id of ids) {
    const timer = settleTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    settleTimers.delete(id);
  }
};

// Arm the received→thinking settle fallback. Re-reads live state when it fires so it
// only advances a turn that is still streaming and still in the "received" phase.
const armSettleTimer = (sessionId: string, turnId: string): void => {
  clearSettleTimer(sessionId);
  settleTimers.set(
    sessionId,
    setTimeout(() => {
      settleTimers.delete(sessionId);
      const st = useStore.getState();
      const run = st.runs[runKey(sessionId)];
      if (run?.streaming && run.turnId === turnId && run.composerPhase === "received") {
        useStore.setState((current) => runPatch(current, sessionId, { composerPhase: "thinking" }));
      }
    }, COMPOSER_SETTLE_MS),
  );
};

const MESSAGE_CACHE_TTL_MS = 60_000;
const MESSAGE_CACHE_INACTIVE_LIMIT = 20;
const messageLoadPromises = new Map<string, Promise<void>>();

const idleMessageLoad = (at = now()): MessageLoadState => ({
  phase: "idle",
  loadedAt: null,
  lastAccessedAt: at,
  requestId: 0,
  error: null,
  nextCursor: null,
  loadingOlder: false,
});

const messageIdentity = (message: Message): string =>
  message.turnId ? `${message.role}:turn:${message.turnId}` : `${message.role}:id:${message.id}`;

/** Merge a refreshed newest-page tail into the held chronological transcript.
 * Cached rows before the first shared message are older than the bounded page and
 * must stay in front; rows after the final shared message may have arrived live
 * while the request was in flight. Null means there is no safe identity anchor, so
 * the caller must keep both the held transcript and its matching paging cursor. */
const mergeNewestHydratedPage = (persisted: Message[], current: Message[]): Message[] | null => {
  if (persisted.length === 0) return current.length === 0 ? [] : null;
  if (current.length === 0) return persisted;

  const currentByKey = new Map(current.map((message) => [messageIdentity(message), message]));
  const currentIndexByKey = new Map(
    current.map((message, index) => [messageIdentity(message), index]),
  );
  const persistedKeys = new Set(persisted.map(messageIdentity));
  const overlapIndexes = persisted.flatMap((message) => {
    const index = currentIndexByKey.get(messageIdentity(message));
    return index === undefined ? [] : [index];
  });
  if (overlapIndexes.length === 0) return null;
  for (let index = 1; index < overlapIndexes.length; index += 1) {
    if (overlapIndexes[index] <= overlapIndexes[index - 1]) return null;
  }

  const firstOverlap = overlapIndexes[0];
  const lastOverlap = overlapIndexes[overlapIndexes.length - 1];
  if (
    current
      .slice(firstOverlap, lastOverlap + 1)
      .some((message) => !persistedKeys.has(messageIdentity(message)))
  ) {
    return null;
  }

  const older = current.slice(0, firstOverlap);
  const seen = new Set(older.map(messageIdentity));
  const merged = [...older];
  for (const message of persisted) {
    const key = messageIdentity(message);
    seen.add(key);
    merged.push(currentByKey.get(key) ?? message);
  }
  for (const message of current.slice(lastOverlap + 1)) {
    const key = messageIdentity(message);
    if (!seen.has(key)) merged.push(message);
  }
  return merged;
};

/** Merge an authoritative chronological prefix (a full history or older page),
 * retaining current/live versions on overlap and appending the held newer tail. */
const mergePersistedPrefix = (persisted: Message[], current: Message[]): Message[] => {
  const currentByKey = new Map(current.map((message) => [messageIdentity(message), message]));
  const seen = new Set<string>();
  const merged = persisted.map((message) => {
    const key = messageIdentity(message);
    seen.add(key);
    return currentByKey.get(key) ?? message;
  });
  for (const message of current) {
    const key = messageIdentity(message);
    if (!seen.has(key)) merged.push(message);
  }
  return merged;
};

const evictMessageCache = (st: AppState): Partial<AppState> => {
  const candidates = Object.entries(st.messageLoads)
    .filter(([id, load]) => {
      if (id === st.activeId || load.phase === "loading" || load.phase === "refreshing")
        return false;
      const run = st.runs[runKey(id)];
      if (run?.streaming || run?.finalizing || run?.pendingPermission) return false;
      if ((st.backgroundTasks[id] ?? []).some((task) => task.status === "running")) return false;
      return id in st.messages;
    })
    .sort(([, left], [, right]) => right.lastAccessedAt - left.lastAccessedAt);
  if (candidates.length <= MESSAGE_CACHE_INACTIVE_LIMIT) return {};
  const messages = { ...st.messages };
  const messageLoads = { ...st.messageLoads };
  for (const [id] of candidates.slice(MESSAGE_CACHE_INACTIVE_LIMIT)) {
    delete messages[id];
    messageLoads[id] = idleMessageLoad(messageLoads[id]?.lastAccessedAt);
  }
  return { messages, messageLoads };
};

const anyRunBusy = (st: AppState): boolean =>
  Object.values(st.runs).some((run) => run.streaming || run.finalizing || run.pendingPermission) ||
  st.streaming ||
  st.pendingPermission !== null;

// ── message search (web/preview fallback) ─────────────────────────────────────
// In Tauri the SQLite-backed `search_messages` command searches the FULL history.
// In web/preview mode (no desktop DB) this searches the in-memory loaded messages
// so ⌘K still finds a past turn. Mirrors the Rust search: real text blocks only,
// case-insensitive, newest first, capped.
const SEARCH_LIMIT = 50;

const snippetAround = (text: string, needle: string): string => {
  const norm = text.replace(/\s+/g, " ").trim();
  const at = norm.toLowerCase().indexOf(needle);
  if (at < 0) return norm.slice(0, 140);
  const start = Math.max(0, at - 40);
  const end = Math.min(norm.length, at + needle.length + 100);
  return (start > 0 ? "…" : "") + norm.slice(start, end) + (end < norm.length ? "…" : "");
};

const searchInMemory = (messages: Record<string, Message[]>, query: string): SearchHit[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const scored: { hit: SearchHit; at: number }[] = [];
  for (const [sessionId, list] of Object.entries(messages)) {
    list.forEach((msg, idx) => {
      const text = msg.blocks
        .filter((b): b is Extract<ContentBlock, { kind: "text" }> => b.kind === "text")
        .map((b) => b.text)
        .join(" ");
      if (text.toLowerCase().includes(needle)) {
        scored.push({
          hit: {
            sessionId,
            messageId: msg.id,
            seq: idx,
            role: msg.role,
            snippet: snippetAround(text, needle),
          },
          at: msg.createdAt,
        });
      }
    });
  }
  scored.sort((a, b) => b.at - a.at);
  return scored.slice(0, SEARCH_LIMIT).map((s) => s.hit);
};

// Frontend-only UI preferences (decorative overlays). Cosmetic client state,
// not the Rust core's Settings — persisted in localStorage so they work the
// same in preview and native without an IPC round-trip.
const readPref = (k: string): boolean => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
const writePref = (k: string, v: boolean): void => {
  try {
    localStorage.setItem(k, v ? "1" : "0");
  } catch {
    /* storage disabled / over quota — ignore */
  }
};

// Tri-state pref: null when never set (e.g. crash-reporting consent not yet
// asked), otherwise the stored boolean. Lets a first-run prompt distinguish
// "declined" from "not yet decided".
const readTriPref = (k: string): boolean | null => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
};

// String prefs (e.g. the remembered pairing payload — public connection info, not
// a secret). Same best-effort localStorage discipline as the boolean prefs.
const readStr = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const writeStr = (k: string, v: string | null): void => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage disabled / over quota — ignore */
  }
};

// Interface scale (a numeric UI-zoom factor, persisted as a string number).
// Same best-effort localStorage discipline as the other prefs; a missing or
// garbage value falls back to 1 (no scaling) so the UI can never load broken.
const readUiScale = (): number => {
  const raw = readStr("pc.uiScale");
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
};
// Apply the scale to the whole document. Chromium/WebView2 supports the `zoom`
// property, which scales the entire UI crisply (unlike a transform). Guarded for
// non-DOM environments (the no-op preview/test bootstrap before the DOM exists).
const applyUiScale = (n: number): void => {
  try {
    document.documentElement.style.zoom = String(n);
  } catch {
    /* no document (SSR / early init) — ignore */
  }
};

// JSON prefs (sidebar folders + membership + archived ids — frontend-only
// organization overlays, never secrets). Same best-effort localStorage
// discipline: a parse error or disabled storage falls back to the default.
const readJSON = <T>(k: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(k);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
};
const writeJSON = (k: string, v: unknown): void => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage disabled / over quota / not serializable — ignore */
  }
};

// Validated reads for the enumerated sidebar prefs, so a stale/garbage value
// can never put the list into an undefined sort/group mode.
const readSort = (): SessionSort => {
  const v = readStr("pc.sortBy");
  return v === "name" || v === "status" || v === "manual" ? v : "recent";
};
const readGroup = (): SessionGroup => {
  const v = readStr("pc.groupBy");
  return v === "workspace" || v === "status" || v === "branch" ? v : "none";
};

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const connectedOpenAIAccounts = (accounts: OpenAIAccountSummary[]) =>
  accounts.filter((account) => account.state === "connected");

export const preferredOpenAIAccount = (
  accounts: OpenAIAccountSummary[],
  preferredId: string | null,
): OpenAIAccountSummary | undefined => {
  const connected = connectedOpenAIAccounts(accounts);
  const explicitlyPreferred = connected.find((account) => account.id === preferredId);
  if (explicitlyPreferred) return explicitlyPreferred;
  return [...connected].sort(
    (left, right) =>
      (right.lastUsedAt ?? -1) - (left.lastUsedAt ?? -1) ||
      right.updatedAt - left.updatedAt ||
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id),
  )[0];
};

/** Resolve a catalogue without ever borrowing another account's successful data. */
const EMPTY_OPENAI_MODELS: ModelInfo[] = [];

export function modelsForOpenAIProfile(
  accountProfileId: string | null | undefined,
  catalogs: Record<string, OpenAIModelCatalogState>,
  unpinnedFallback?: ModelInfo[],
): ModelInfo[] {
  if (!accountProfileId) return unpinnedFallback ?? EMPTY_OPENAI_MODELS;
  const catalog = catalogs[accountProfileId];
  return catalog?.status === "ready" ? catalog.models : EMPTY_OPENAI_MODELS;
}

function makeSession(model: string, accountProfileId: string | null = null): Session {
  const t = now();
  return {
    id: uid(),
    title: "New chat",
    workspace: null,
    // Branch is computed by the core from the workspace's git HEAD on the next
    // list; a fresh, workspace-less chat has none until then.
    branch: null,
    model,
    accountProfileId,
    createdAt: t,
    updatedAt: t,
  };
}

export const useStore = create<AppState>((set, get) => ({
  sessions: [],
  activeId: null,
  pendingSession: null,
  messages: {},
  messageLoads: {},
  messagePaging: {},
  usage: {},
  agents: {},
  backgroundTasks: {},
  settings: DEFAULT_SETTINGS,
  oauthStatus: null,
  oauthError: null,
  openAIAuthStatus: null,
  openAIAuthError: null,
  openAIReconnectMismatch: null,
  openAIAccounts: [],
  openAIAccountsLoading: false,
  openAIAccountsError: null,
  openAIModelCatalogs: {},
  openAIModels: OPENAI_FALLBACK_MODELS,
  lastOpenAIAccountProfileId: readStr("pc.lastOpenAIAccountProfileId"),
  phoneSync: null,
  pairingPayload: null,
  pairingError: null,
  pairingRequest: null,
  pairingRequestUnlisten: null,
  creatingSession: false,
  runs: {},
  streaming: false,
  showSettings: false,
  showFiles: false,
  showSidebar: false,
  sidebarCollapsed: readPref("pc.sidebarCollapsed"),
  showPalette: false,
  workspaceSurface: "chat",
  reviewTarget: { kind: "workspace" },
  sortBy: readSort(),
  groupBy: readGroup(),
  folders: readJSON<SessionFolder[]>("pc.folders", []),
  folderOf: readJSON<Record<string, string | null>>("pc.folderOf", {}),
  archivedIds: readJSON<string[]>("pc.archivedIds", []),
  manualOrder: readJSON<string[]>("pc.manualOrder", []),
  ambientRain: readPref("pc.ambientRain"),
  scanlines: readPref("pc.scanlines"),
  uiScale: readUiScale(),
  // Hydrate the optimistic mirror synchronously so a reload restores drafts BEFORE
  // the backend round-trip; init() then merges the authoritative backend drafts.
  drafts: readJSON<Record<string, string>>("pc.drafts", {}),
  composerPhase: "idle",
  activeTool: null,
  scrollTargetId: null,
  transcriptScrollRequest: null,
  crashReporting: readTriPref("pc.crashReporting"),
  cancel: null,
  pendingPermission: null,
  initError: null,
  loadErrors: {},
  settingsError: null,
  workspaceError: null,
  // Default into remote mode on a phone; desktop/preview start in the normal
  // layout and can opt in via setRemoteMode (e.g. the command palette) for testing.
  remoteMode: isMobilePlatform(),
  remoteConnected: false,
  remoteVerified: false,
  remoteSas: null,
  remotePeerKey: null,
  remoteVapidKey: null,
  remoteError: null,
  remoteUnlisten: null,
  remoteDropped: false,
  remoteRejected: false,
  remoteRejectReason: null,
  remoteConnecting: false,
  // Remembered across launches so the phone can reconnect without re-scanning the
  // QR (Android frequently kills backgrounded apps). Public payload — no secret.
  lastPairingQr: readStr("pc.lastPairingQr"),
  // After SAS verification the remote lands on the sessions LIST; opening a session
  // flips this true (chat view). Reset on every disconnect/drop/fresh-dial.
  remoteChatOpen: false,
  // Network presence. Seeded from the browser; App keeps it live via online/offline
  // events. Remote mode shows the offline screen when this is false.
  online: typeof navigator !== "undefined" && "onLine" in navigator ? navigator.onLine : true,

  // Auto-update: starts idle (no banner) on the stable channel; App.tsx kicks off a
  // check + channel load on a desktop mount.
  update: IDLE_UPDATE,
  updateChannel: "stable",

  async init() {
    // The phone/remote client has no local sessions DB or settings — its session
    // and message state arrive authoritatively from the desktop's frames — and the
    // desktop-only Tauri commands below would reject on a real mobile build, leaving
    // a stale initError that paints a spurious "Couldn't start Portcode" panel over
    // the connected remote session. So init() is a no-op there (mirrors newSession).
    if (get().remoteMode) {
      set({ initError: null });
      return;
    }
    // Desktop is the SYNC SERVER: subscribe to inbound pairing-confirm requests so
    // the device-trust gate's prompt can surface in Settings. Fire-and-forget (the
    // listener install is resilient and the mock is inert), kept off the load-
    // bearing startup path below.
    void get().listenForPairingRequests();
    // Fetch settings, subscription status, and phone sync status together.
    // The oauth and phoneSync calls are kept resilient so an unwired/older
    // core can't block startup. The load-bearing calls (getSettings/listSessions/
    // createSession/getMessages) are guarded so a failed startup surfaces an
    // error+retry panel instead of a permanently blank welcome shell.
    try {
      const openAIStatusPromise =
        typeof ipc.openaiOauthStatus === "function"
          ? ipc.openaiOauthStatus().catch(() => null)
          : Promise.resolve(null);
      const openAIAccountsPromise: Promise<{
        accounts: OpenAIAccountSummary[];
        error: string | null;
      }> =
        typeof ipc.listOpenAIAccounts === "function"
          ? ipc
              .listOpenAIAccounts()
              .then((accounts) => ({ accounts, error: null }))
              .catch((error) => ({ accounts: [], error: errMessage(error) }))
          : Promise.resolve({ accounts: [], error: null });
      const [
        rawSettings,
        oauthStatus,
        openAIAuthStatus,
        openAIAccountDiscovery,
        phoneSync,
        backendDrafts,
        allUsage,
      ] = await Promise.all([
        ipc.getSettings(),
        ipc.oauthStatus().catch(() => null),
        openAIStatusPromise,
        openAIAccountsPromise,
        ipc.phoneSyncStatus().catch(() => null),
        // Resilient: an older core that predates these commands must not block
        // startup — fall back to empty (the localStorage mirror still restores drafts).
        ipc.getDrafts().catch(() => []),
        ipc.getAllUsage().catch(() => []),
      ]);
      const openAIAccounts = openAIAccountDiscovery.accounts;
      const openAIAvailable = openAIAuthStatus?.available !== false;
      const preferredAccount = preferredOpenAIAccount(
        openAIAccounts,
        get().lastOpenAIAccountProfileId,
      );
      // A transient registry read failure is not evidence that the user's chosen
      // default disappeared. Retain it so a later successful refresh can reconcile
      // against the authoritative connected profiles without silently switching MRU.
      const defaultOpenAIAccountProfileId = openAIAccountDiscovery.error
        ? get().lastOpenAIAccountProfileId
        : (preferredAccount?.id ?? null);
      if (
        !openAIAccountDiscovery.error &&
        defaultOpenAIAccountProfileId !== get().lastOpenAIAccountProfileId
      ) {
        writeStr("pc.lastOpenAIAccountProfileId", defaultOpenAIAccountProfileId);
      }
      let openAIModelCatalogs: Record<string, OpenAIModelCatalogState> = {};
      let openAIModels = openAIAvailable && !preferredAccount ? OPENAI_FALLBACK_MODELS : [];
      if (openAIAvailable && preferredAccount && typeof ipc.openaiModels === "function") {
        try {
          const models = normalizeOpenAIModels(await ipc.openaiModels(preferredAccount.id));
          if (models.length === 0) {
            openAIModelCatalogs = {
              [preferredAccount.id]: {
                status: "error",
                models: [],
                error: "This account returned no compatible OpenAI models.",
              },
            };
          } else {
            openAIModels = models;
            openAIModelCatalogs = {
              [preferredAccount.id]: { status: "ready", models, error: null },
            };
          }
        } catch (error) {
          openAIModelCatalogs = {
            [preferredAccount.id]: {
              status: "error",
              models: [],
              error: errMessage(error),
            },
          };
        }
      }
      const requestedModel = rawSettings.model ?? DEFAULT_SETTINGS.model;
      const requestedProvider =
        rawSettings.provider === "openai"
          ? "openai"
          : providerForModel(requestedModel, openAIModels);
      const preferredCatalog = preferredAccount
        ? openAIModelCatalogs[preferredAccount.id]
        : undefined;
      const startupOpenAIBlockReason =
        requestedProvider !== "openai"
          ? null
          : !openAIAvailable
            ? (openAIAuthStatus?.unavailableReason ??
              "ChatGPT subscription access is unavailable in this build.")
            : openAIAccountDiscovery.error
              ? "Couldn't load ChatGPT accounts: " + openAIAccountDiscovery.error
              : !preferredAccount
                ? "Choose a default ChatGPT account in Settings before creating a GPT chat."
                : preferredCatalog?.status !== "ready"
                  ? (preferredCatalog?.error ??
                    "Load the default ChatGPT account's models before creating a GPT chat.")
                  : !preferredCatalog.models.some((candidate) => candidate.id === requestedModel)
                    ? "Choose a model available to the default ChatGPT account before creating a GPT chat."
                    : null;
      const model = requestedModel;
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        ...rawSettings,
        model,
        provider: requestedProvider,
        reasoningEffort: reasoningEffortForModel(
          model,
          rawSettings.reasoningEffort ?? DEFAULT_SETTINGS.reasoningEffort,
          openAIModels,
        ),
      };
      // Authoritative durable drafts merged under the already-hydrated optimistic
      // mirror; usage restored so per-session meters + workspace spend survive restart.
      const drafts = mergeDrafts(get().drafts, backendDrafts);
      const usage = usageFromRows(allUsage);
      const loaded = await ipc.listSessions();
      if (loaded.length === 0 && startupOpenAIBlockReason) {
        set((st) => ({
          settings,
          oauthStatus,
          openAIAuthStatus,
          openAIAuthError: startupOpenAIBlockReason,
          openAIAccounts,
          openAIAccountsLoading: false,
          openAIAccountsError: openAIAccountDiscovery.error,
          openAIModelCatalogs,
          openAIModels,
          lastOpenAIAccountProfileId: defaultOpenAIAccountProfileId,
          phoneSync,
          drafts,
          usage,
          sessions: [],
          activeId: null,
          pendingSession: null,
          messages: {},
          showSettings: true,
          initError: null,
          ...projectActiveRun({ activeId: null, runs: st.runs }),
        }));
        return;
      }
      if (loaded.length === 0) {
        const accountProfileId =
          providerForModel(settings.model, openAIModels) === "openai"
            ? defaultOpenAIAccountProfileId
            : null;
        const pendingSession = makeSession(settings.model, accountProfileId);
        set((st) => ({
          settings,
          oauthStatus,
          openAIAuthStatus,
          openAIAuthError: null,
          openAIAccounts,
          openAIAccountsLoading: false,
          openAIAccountsError: openAIAccountDiscovery.error,
          openAIModelCatalogs,
          openAIModels,
          lastOpenAIAccountProfileId: defaultOpenAIAccountProfileId,
          phoneSync,
          drafts,
          usage,
          sessions: [],
          activeId: pendingSession.id,
          pendingSession,
          messages: { [pendingSession.id]: [] },
          messageLoads: {
            ...st.messageLoads,
            [pendingSession.id]: { ...idleMessageLoad(), phase: "ready", loadedAt: now() },
          },
          initError: null,
          // Keep the active-run mirror consistent with the newly active session
          // (idle here — a fresh session has no run).
          ...projectActiveRun({ activeId: pendingSession.id, runs: st.runs }),
        }));
        // Subscribe a persistent background-task listener so a task launched in
        // this session is tracked even after its turn's per-turn listener is gone.
        return;
      }
      // Old DB rows predate per-session model (null/absent) — coalesce to the
      // last-used default so Session.model stays a non-null string.
      const sessions = loaded.map((row) => ({ ...row, model: row.model ?? settings.model }));
      const activeId = sessions[0].id;
      set((st) => ({
        settings,
        oauthStatus,
        openAIAuthStatus,
        openAIAuthError: null,
        openAIAccounts,
        openAIAccountsLoading: false,
        openAIAccountsError: openAIAccountDiscovery.error,
        openAIModelCatalogs,
        openAIModels,
        lastOpenAIAccountProfileId: defaultOpenAIAccountProfileId,
        phoneSync,
        drafts,
        usage,
        sessions,
        activeId,
        pendingSession: null,
        initError: null,
        // Keep the active-run mirror consistent with the activated session.
        ...projectActiveRun({ activeId, runs: st.runs }),
      }));
      await get().hydrateMessages(activeId);
      // One persistent background-task listener per known session (idempotent), so
      // a finish that lands while a different session is on screen is still tracked.
      sessions.forEach((s) => void ensureBackgroundListener(s.id));
    } catch (err) {
      set({ initError: errMessage(err) });
    }
  },

  async retryInit() {
    if (get().pendingSession) {
      set({ initError: null });
      return;
    }
    set({ initError: null });
    await get().init();
  },

  async retryLoad(id) {
    await get().hydrateMessages(id, { force: true });
  },

  async hydrateMessages(id, options) {
    const existingPromise = messageLoadPromises.get(id);
    if (existingPromise) return existingPromise;

    const snapshot = get();
    const existing = snapshot.messages[id];
    const previous = snapshot.messageLoads[id] ?? idleMessageLoad();
    const at = now();

    // Remote transcripts are seeded authoritatively by message_delta. Selection
    // merely exposes the loading state until that frame (including an empty one).
    if (snapshot.remoteMode || snapshot.remoteConnected) {
      set((st) => ({
        messageLoads: {
          ...st.messageLoads,
          [id]: {
            ...(st.messageLoads[id] ?? idleMessageLoad(at)),
            phase: id in st.messages ? "ready" : "loading",
            lastAccessedAt: at,
            error: null,
          },
        },
      }));
      return;
    }

    const fresh =
      existing !== undefined &&
      previous.loadedAt !== null &&
      at - previous.loadedAt < MESSAGE_CACHE_TTL_MS;
    if (fresh && !options?.force) {
      set((st) => ({
        messageLoads: {
          ...st.messageLoads,
          [id]: { ...previous, phase: "ready", lastAccessedAt: at, error: null },
        },
        ...evictMessageCache(st),
      }));
      return;
    }

    const requestId = previous.requestId + 1;
    set((st) => ({
      messageLoads: {
        ...st.messageLoads,
        [id]: {
          ...previous,
          phase: existing === undefined ? "loading" : "refreshing",
          lastAccessedAt: at,
          requestId,
          error: null,
          loadingOlder: false,
        },
      },
      loadErrors: { ...st.loadErrors, [id]: false },
    }));

    const request = (async () => {
      try {
        const page =
          typeof ipc.getMessagePage === "function"
            ? await ipc.getMessagePage(id, null)
            : { messages: await ipc.getMessages(id), nextCursor: null };
        set((st) => {
          const load = st.messageLoads[id];
          if (load?.requestId !== requestId) {
            return {};
          }
          const merged = mergeNewestHydratedPage(page.messages, st.messages[id] ?? []);
          const accepted = merged !== null;
          const messages = accepted ? { ...st.messages, [id]: merged } : st.messages;
          const messageLoads = {
            ...st.messageLoads,
            [id]: {
              ...load,
              phase: "ready" as const,
              loadedAt: accepted ? now() : load.loadedAt,
              lastAccessedAt: now(),
              error: null,
              nextCursor: accepted ? page.nextCursor : load.nextCursor,
              loadingOlder: false,
            },
          };
          const next = { ...st, messages, messageLoads };
          return {
            messages,
            messageLoads,
            loadErrors: { ...st.loadErrors, [id]: false },
            ...evictMessageCache(next),
          };
        });
      } catch (error) {
        set((st) => {
          const load = st.messageLoads[id];
          if (load?.requestId !== requestId) return {};
          return {
            messageLoads: {
              ...st.messageLoads,
              [id]: {
                ...load,
                phase: "error" as const,
                error: errMessage(error),
                loadingOlder: false,
              },
            },
            loadErrors: { ...st.loadErrors, [id]: true },
          };
        });
      }
    })();
    messageLoadPromises.set(id, request);
    try {
      await request;
    } finally {
      if (messageLoadPromises.get(id) === request) messageLoadPromises.delete(id);
    }
  },

  async prefetchSession(id) {
    if (id === get().activeId || get().remoteMode || get().remoteConnected) return;
    await get().hydrateMessages(id);
  },

  async newSession(accountProfileId, modelId) {
    // Guard async account/catalog preparation and the remote create handshake.
    if (get().creatingSession) return;
    set({ creatingSession: true });
    // Remote mode also opens a local-only shell. Its first send creates the
    // desktop-owned session, waits for acknowledgement, then runs the turn.
    if (get().remoteConnected) {
      const pendingSession = makeSession(modelId ?? get().settings.model, null);
      set((st) => {
        const drafts = { ...st.drafts };
        if (st.pendingSession) delete drafts[st.pendingSession.id];
        return {
          pendingSession,
          activeId: pendingSession.id,
          drafts,
          messages: { ...st.messages, [pendingSession.id]: [] },
          messageLoads: {
            ...st.messageLoads,
            [pendingSession.id]: { ...idleMessageLoad(), phase: "ready", loadedAt: now() },
          },
          creatingSession: false,
          showSidebar: false,
          remoteChatOpen: true,
          ...projectActiveRun({ activeId: pendingSession.id, runs: st.runs }),
        };
      });
      return;
    }
    try {
      const model = modelId ?? get().settings.model;
      let profileId: string | null = null;
      const provider = accountProfileId ? "openai" : providerForModel(model, get().openAIModels);
      if (provider === "openai") {
        const state = get();
        if (!accountProfileId && state.openAIAccountsError) {
          set({
            showSettings: true,
            openAIAuthError: `ChatGPT account registry is unavailable: ${state.openAIAccountsError}. Retry account discovery before creating a session.`,
          });
          return;
        }
        if (state.openAIAuthStatus?.available === false) {
          set({
            showSettings: true,
            openAIAuthError:
              state.openAIAuthStatus.unavailableReason ??
              "ChatGPT subscription access is unavailable in this build.",
          });
          return;
        }
        const selected = accountProfileId
          ? connectedOpenAIAccounts(state.openAIAccounts).find(
              (account) => account.id === accountProfileId,
            )
          : preferredOpenAIAccount(state.openAIAccounts, state.lastOpenAIAccountProfileId);
        if (!selected) {
          set({
            showSettings: true,
            openAIAuthError: "Choose a default ChatGPT account in Settings first.",
          });
          return;
        }
        profileId = selected.id;
        const models = await get().loadOpenAIAccountModels(profileId);
        if (models.length === 0) {
          throw new Error(
            get().openAIModelCatalogs[profileId]?.error ??
              "No compatible OpenAI models are available for this ChatGPT account.",
          );
        }
        if (!models.some((candidate) => candidate.id === model)) {
          set({
            ...(modelId ? {} : { showSettings: true }),
            openAIAuthError:
              "Choose a model available to " +
              openAIAccountLabel(selected, state.openAIAccounts) +
              " before creating this session.",
          });
          return;
        }
      }

      const s = makeSession(model, profileId);
      const priorPendingId = get().pendingSession?.id;
      if (priorPendingId) {
        set((st) => {
          const drafts = { ...st.drafts };
          delete drafts[priorPendingId];
          writeJSON("pc.drafts", drafts);
          return { drafts };
        });
      }
      set((st) => ({
        pendingSession: s,
        activeId: s.id,
        messages: { ...st.messages, [s.id]: [] },
        messageLoads: {
          ...st.messageLoads,
          [s.id]: { ...idleMessageLoad(), phase: "ready", loadedAt: now() },
        },
        showSidebar: false, // close the mobile drawer on navigation
        initError: null,
        // A brand-new session has no run yet → the mirror projects to idle.
        ...projectActiveRun({ activeId: s.id, runs: st.runs }),
      }));
      if (profileId) {
        set({
          openAIModels: modelsForOpenAIProfile(profileId, get().openAIModelCatalogs),
        });
      }
    } catch (err) {
      // A failed create (locked DB / core not ready) must surface instead of being a
      // swallowed unhandled rejection — callers use bare `onClick={newSession}` /
      // `void newSession()`. Reuse initError so Chat's existing error/retry panel shows it.
      set({ initError: errMessage(err) });
    } finally {
      set({ creatingSession: false });
    }
  },

  async selectSession(id) {
    // Switch immediately and project the target's independent run before history I/O.
    set((st) => {
      const drafts = { ...st.drafts };
      if (st.pendingSession) delete drafts[st.pendingSession.id];
      writeJSON("pc.drafts", drafts);
      const runs = st.runs[runKey(id)]?.unseenOutcome
        ? { ...st.runs, [runKey(id)]: { ...st.runs[runKey(id)], unseenOutcome: null } }
        : st.runs;
      return {
        activeId: id,
        pendingSession: null,
        drafts,
        showSidebar: false, // close the mobile drawer on navigation
        runs,
        transcriptScrollRequest: { id: uid(), sessionId: id, kind: "latest" },
        ...projectActiveRun({ activeId: id, runs }),
      };
    });
    // Belt-and-suspenders: ensure the session being viewed has a background-task
    // listener (idempotent — a no-op if init/newSession already subscribed it).
    void ensureBackgroundListener(id);
    await get().hydrateMessages(id);
  },

  // ── message search (⌘K jump to a past turn) ──────────────────────────────────

  async searchMessages(query) {
    const q = query.trim();
    if (!q) return [];
    // Tauri: full-history SQLite search. Web/preview: ipc returns [], then fall back
    // to the in-memory loaded messages so ⌘K still works without a desktop DB.
    const fromDb = await ipc.searchMessages(q);
    if (fromDb.length > 0) return fromDb;
    return searchInMemory(get().messages, q);
  },

  async jumpToMessage(sessionId, messageId) {
    // Reuse the single source of truth for activeId + lazy message load. selectSession
    // no-ops while a turn streams, so only reveal the turn if we actually landed on
    // its session — otherwise scrollTargetId would strand and ghost-scroll a later
    // navigation to that session.
    await get().selectSession(sessionId);
    if (get().activeId !== sessionId) return;
    if (!(get().messages[sessionId] ?? []).some((message) => message.id === messageId)) {
      try {
        const messages = await ipc.getMessages(sessionId);
        set((st) => ({
          messages: {
            ...st.messages,
            [sessionId]: mergePersistedPrefix(messages, st.messages[sessionId] ?? []),
          },
          messageLoads: {
            ...st.messageLoads,
            [sessionId]: {
              ...(st.messageLoads[sessionId] ?? idleMessageLoad()),
              phase: "ready",
              loadedAt: now(),
              lastAccessedAt: now(),
              error: null,
              nextCursor: null,
            },
          },
        }));
      } catch {
        // The selected transcript retains its page/error state; the search target
        // simply cannot be revealed until a later retry succeeds.
        return;
      }
    }
    // Ask the transcript to reveal the matched turn; Chat scrolls + clears it once
    // the (possibly just-loaded) message is in the DOM.
    set({ scrollTargetId: messageId });
  },

  clearScrollTarget() {
    set({ scrollTargetId: null });
  },

  clearTranscriptScrollRequest(id) {
    set((st) => (st.transcriptScrollRequest?.id === id ? { transcriptScrollRequest: null } : {}));
  },

  async deleteSession(id) {
    const state = get();
    const targetRun = state.runs[runKey(id)];
    if (
      !state.archivedIds.includes(id) ||
      targetRun?.streaming ||
      targetRun?.finalizing ||
      targetRun?.pendingPermission ||
      (!targetRun && state.activeId === id && (state.streaming || state.pendingPermission)) ||
      (state.backgroundTasks[id] ?? []).some((task) => task.status === "running")
    )
      return;
    try {
      await ipc.deleteSession(id);
    } catch (err) {
      // A failed delete (locked DB / core not ready) must surface instead of being a
      // swallowed unhandled rejection — caller is a bare onClick={() => deleteSession(s.id)}.
      // Reuse initError so Chat's existing error/retry panel shows it; leave the list untouched.
      set({ initError: errMessage(err) });
      return;
    }
    teardownBackgroundListener(id); // stop tracking the deleted session's tasks
    set((st) => {
      const sessions = st.sessions.filter((s) => s.id !== id);
      const messages = { ...st.messages };
      delete messages[id];
      const runs = { ...st.runs };
      delete runs[runKey(id)]; // drop the deleted session's run
      const messageLoads = { ...st.messageLoads };
      delete messageLoads[id];
      const backgroundTasks = { ...st.backgroundTasks };
      delete backgroundTasks[id]; // drop its background tasks
      const activeId = st.activeId === id ? (sessions[0]?.id ?? null) : st.activeId;
      // Prune the gone session's usage + draft to stay in lockstep with the backend
      // (db.rs deletes both rows on delete_session). Otherwise the deleted session's
      // tokens keep inflating the HUD's workspace-total spend until a restart re-reads
      // the (pruned) backend totals — a non-deterministic, trust-eroding drift — and a
      // dead draft lingers in the mirror that mergeDrafts would keep re-preserving.
      let usage = st.usage;
      if (id in usage) {
        usage = { ...st.usage };
        delete usage[id];
      }
      let drafts = st.drafts;
      if (id in drafts) {
        drafts = { ...st.drafts };
        delete drafts[id];
        writeJSON("pc.drafts", drafts);
      }
      flushPendingDraftSave(id); // cancel any in-flight debounced save for the gone session
      // Drop the gone session's sidebar-org entries so stale folder membership /
      // archived state can't accumulate in localStorage across deletions.
      let folderOf = st.folderOf;
      if (id in folderOf) {
        folderOf = { ...st.folderOf };
        delete folderOf[id];
        writeJSON("pc.folderOf", folderOf);
      }
      let archivedIds = st.archivedIds;
      if (archivedIds.includes(id)) {
        archivedIds = archivedIds.filter((x) => x !== id);
        writeJSON("pc.archivedIds", archivedIds);
      }
      let manualOrder = st.manualOrder;
      if (manualOrder.includes(id)) {
        manualOrder = manualOrder.filter((x) => x !== id);
        writeJSON("pc.manualOrder", manualOrder);
      }
      return {
        sessions,
        messages,
        messageLoads,
        runs,
        backgroundTasks,
        activeId,
        usage,
        drafts,
        folderOf,
        archivedIds,
        manualOrder,
        ...projectActiveRun({ activeId, runs }),
      };
    });
    if (get().sessions.length === 0) {
      await get().newSession();
      return;
    }
    const aid = get().activeId;
    if (aid) await get().hydrateMessages(aid);
  },

  async renameSession(id, title) {
    // Rename is a desktop-local DB write (the `rename_session` Tauri command); the
    // phone has no equivalent RemoteCommand, so a remote client can't rename — bail
    // rather than desync the optimistic title against the desktop's authoritative
    // session_list frame (the Sidebar hides the affordance in remote mode anyway).
    if (get().remoteConnected) return;
    const trimmed = title.trim();
    const session = get().sessions.find((s) => s.id === id);
    if (!session) return;
    // Ignore a no-op / empty rename (an empty title would render a blank row).
    if (trimmed === "" || trimmed === session.title) return;
    const previous = session.title;
    // Optimistically apply so the row updates immediately.
    set((st) => ({
      sessions: st.sessions.map((s) => (s.id === id ? { ...s, title: trimmed } : s)),
    }));
    try {
      await ipc.renameSession(id, trimmed);
    } catch {
      // Revert on a failed write (locked DB / core not ready) — the title snapping
      // back IS the user-visible signal. Two deliberate choices: (1) revert ONLY
      // if the title is still our optimistic value, so a newer rename or a
      // send()-derived title that landed during the in-flight write isn't
      // clobbered; (2) do NOT route this through `initError` — that's the
      // full-screen "Couldn't start Portcode" panel, which would wipe a populated
      // conversation for a transient per-row failure.
      set((st) => ({
        sessions: st.sessions.map((s) =>
          s.id === id && s.title === trimmed ? { ...s, title: previous } : s,
        ),
      }));
    }
  },

  async setSessionModel(model) {
    // The picker is disabled/hidden in these states, but Command Palette can call
    // the action directly. The store is authoritative: never mutate an in-flight
    // run's identity, and never write the phone's local DB for a desktop-owned chat.
    if (get().remoteMode || get().remoteConnected) return;
    // Point the active session at the chosen model, persist that conversation's
    // identity, then mirror it into settings.model so it becomes the last-used
    // default for NEW sessions. The session write is distinct from global settings:
    // without it the selector appears to work until reload, then silently reverts.
    const activeId = get().activeId;
    const activeRun = activeId ? get().runs[runKey(activeId)] : undefined;
    if (
      activeRun?.streaming ||
      activeRun?.finalizing ||
      activeRun?.pendingPermission ||
      (!activeRun && (get().streaming || get().pendingPermission))
    )
      return;
    const pendingSession =
      activeId && get().pendingSession?.id === activeId ? get().pendingSession : null;
    let activeSession =
      pendingSession ?? (activeId ? get().sessions.find((s) => s.id === activeId) : undefined);
    if (
      pendingSession &&
      !pendingSession.accountProfileId &&
      providerForModel(model, get().openAIModels) === "openai"
    ) {
      const account = preferredOpenAIAccount(
        get().openAIAccounts,
        get().lastOpenAIAccountProfileId,
      );
      if (!account) {
        set({ settingsError: "Choose a default ChatGPT account in Settings first." });
        return;
      }
      activeSession = { ...pendingSession, accountProfileId: account.id };
    } else if (pendingSession && providerForModel(model, get().openAIModels) !== "openai") {
      activeSession = { ...pendingSession, accountProfileId: null };
    }
    const activeOpenAIModels = modelsForOpenAIProfile(
      activeSession?.accountProfileId,
      get().openAIModelCatalogs,
      get().openAIModels,
    );
    if (activeSession?.accountProfileId) {
      if (!activeOpenAIModels.some((candidate) => candidate.id === model)) {
        set({
          settingsError: "That model is not available to this conversation's ChatGPT account.",
        });
        return;
      }
    } else if (!pendingSession && providerForModel(model, activeOpenAIModels) === "openai") {
      set({
        settingsError:
          "Choose an account for this legacy conversation before selecting an OpenAI model.",
      });
      return;
    }
    if (pendingSession && activeId && activeSession) {
      set({ pendingSession: { ...activeSession, model }, settingsError: null });
      await get().updateSettings({
        model,
        reasoningEffort: reasoningEffortForModel(
          model,
          get().settings.reasoningEffort,
          activeOpenAIModels,
        ),
      });
      return;
    }
    if (activeId && activeSession) {
      // With no queued optimistic write, the visible value is the durable baseline.
      // Keep that baseline stable across a burst so every rejection returns to the
      // last model SQLite actually accepted, never to another optimistic choice.
      if (!sessionModelWriteQueues.has(activeId)) {
        persistedSessionModels.set(activeId, activeSession.model);
      }
      const persistedBeforeWrite = persistedSessionModels.get(activeId) ?? activeSession.model;
      set((st) => ({
        sessions: st.sessions.map((s) => (s.id === activeId ? { ...s, model } : s)),
        settingsError: null,
      }));
      try {
        await enqueueSessionModelWrite(activeId, model);
        persistedSessionModels.set(activeId, model);
      } catch (err) {
        // Revert only our still-current optimistic value. A faster second selection
        // may already have landed while this write was in flight; never clobber it.
        const persistedModel = persistedSessionModels.get(activeId) ?? persistedBeforeWrite;
        set((st) => {
          const failedChoiceIsCurrent =
            st.activeId === activeId &&
            st.sessions.find((session) => session.id === activeId)?.model === model;
          return {
            sessions: st.sessions.map((s) =>
              s.id === activeId && s.model === model ? { ...s, model: persistedModel } : s,
            ),
            ...(failedChoiceIsCurrent ? { settingsError: errMessage(err) } : {}),
          };
        });
        return;
      }
      // Model choices can race (native select + palette, or simply two fast clicks).
      // Only the latest still-visible choice may become the global default; a slower
      // earlier DB write must not overwrite settings after a newer selection wins.
      if (
        get().activeId !== activeId ||
        get().sessions.find((session) => session.id === activeId)?.model !== model
      ) {
        return;
      }
    }
    await get().updateSettings({
      model,
      reasoningEffort: reasoningEffortForModel(
        model,
        get().settings.reasoningEffort,
        activeOpenAIModels,
      ),
    });
  },

  async send(text) {
    const { activeId, streaming } = get();
    const activeRun = activeId ? get().runs[runKey(activeId)] : undefined;
    if (!activeId || streaming || activeRun?.finalizing || !text.trim()) return;
    const messageLoad = get().messageLoads[activeId];
    if (messageLoad && messageLoad.phase !== "ready" && messageLoad.phase !== "refreshing") return;

    // Native admission resolves the credential from the persisted session row,
    // but keep the client honest too: never clear a draft or append an optimistic
    // message for an unpinned/removed/reconnect-required OpenAI profile. Remote
    // mode delegates this check to the credential-owning desktop.
    const pendingSession = get().pendingSession?.id === activeId ? get().pendingSession : null;
    const activeSession =
      pendingSession ?? get().sessions.find((session) => session.id === activeId);
    if (!get().remoteConnected && activeSession) {
      const sessionModels = modelsForOpenAIProfile(
        activeSession.accountProfileId,
        get().openAIModelCatalogs,
        get().openAIModels,
      );
      if (providerForModel(activeSession.model, sessionModels) === "openai") {
        const account = activeSession.accountProfileId
          ? get().openAIAccounts.find(
              (candidate) => candidate.id === activeSession.accountProfileId,
            )
          : undefined;
        if (!activeSession.accountProfileId) {
          set({ openAIAuthError: "Choose a default ChatGPT account in Settings before sending." });
          return;
        }
        if (!account || account.state !== "connected") {
          set({
            openAIAuthError:
              account?.state === "reconnect_required"
                ? "Reconnect this session's ChatGPT account before sending."
                : "This session's ChatGPT account is unavailable.",
          });
          return;
        }
      }
    }

    // Trim once so the stored user bubble and the forwarded command match the
    // derived (trimmed) title — a padded draft otherwise renders odd blank lines.
    const body = text.trim();

    // A blank New chat is only local navigation state. Persist it immediately
    // before the first turn, keeping empty sessions out of history and SQLite.
    if (pendingSession && get().remoteConnected) {
      if (get().creatingSession) return;
      const requestId = uid();
      set({ creatingSession: true });
      pendingRemoteCreateRequestId = requestId;
      pendingRemoteFirstMessage = { draftId: pendingSession.id, body };
      if (pendingRemoteCreateTimer !== null) clearTimeout(pendingRemoteCreateTimer);
      pendingRemoteCreateTimer = setTimeout(() => {
        if (pendingRemoteCreateRequestId !== requestId) return;
        const queued = pendingRemoteFirstMessage;
        clearPendingRemoteCreate();
        useStore.setState((st) => ({
          creatingSession: false,
          remoteError: "Creating the conversation timed out. Please try again.",
          drafts: queued ? { ...st.drafts, [queued.draftId]: queued.body } : st.drafts,
        }));
      }, 15_000);
      await get().sendRemoteCommand({ cmd: "create_session", request_id: requestId });
      if (get().remoteDropped && pendingRemoteCreateRequestId === requestId) {
        const queued = pendingRemoteFirstMessage;
        clearPendingRemoteCreate();
        set((st) => ({
          creatingSession: false,
          drafts: queued ? { ...st.drafts, [queued.draftId]: queued.body } : st.drafts,
        }));
      }
      return;
    }
    if (pendingSession && !get().remoteConnected) {
      set({ creatingSession: true });
      try {
        const created = await ipc.createSession(
          pendingSession.id,
          pendingSession.title,
          pendingSession.workspace,
          pendingSession.model,
          pendingSession.accountProfileId,
        );
        if (!created || created.id !== pendingSession.id) {
          throw new Error("The native core did not confirm the new session.");
        }
        if (
          pendingSession.accountProfileId &&
          created.accountProfileId !== pendingSession.accountProfileId
        ) {
          throw new Error("The native core did not preserve the selected ChatGPT account.");
        }
        const session: Session = {
          ...created,
          model: created.model ?? pendingSession.model,
          accountProfileId: created.accountProfileId ?? pendingSession.accountProfileId,
        };
        set((st) => ({
          sessions: [session, ...st.sessions.filter((item) => item.id !== session.id)],
          pendingSession: null,
          creatingSession: false,
        }));
        if (session.accountProfileId) {
          writeStr("pc.lastOpenAIAccountProfileId", session.accountProfileId);
          set({
            lastOpenAIAccountProfileId: session.accountProfileId,
            openAIModels: modelsForOpenAIProfile(
              session.accountProfileId,
              get().openAIModelCatalogs,
            ),
          });
        }
        void ensureBackgroundListener(session.id);
      } catch (err) {
        set((st) => ({
          creatingSession: false,
          initError: errMessage(err),
          drafts: { ...st.drafts, [activeId]: body },
        }));
        return;
      }
    }

    // Close the open loop: the message is on its way, so clear this session's draft
    // everywhere — the in-memory map, the optimistic mirror, and (immediately,
    // cancelling any pending debounce) the durable backend — so a fast restart can't
    // restore a just-sent draft.
    set((st) => {
      if (!(activeId in st.drafts)) return {};
      const drafts = { ...st.drafts };
      delete drafts[activeId];
      writeJSON("pc.drafts", drafts);
      return { drafts };
    });
    persistDraft(activeId, "", true);

    // Turn-taking receipt (Doherty <400ms): acknowledge the send instantly ("got it
    // — reading…"); the first REAL stream event settles it to "thinking…", with a
    // 900ms fallback for a slow first byte. Honest — never padded latency.
    // Reset the tool label up front so a new turn never briefly shows the previous
    // turn's last tool before its first real event arrives.
    const provisionalTurnId = uid();
    const optimisticStartedAt = now();
    setRun(set, activeId, {
      composerPhase: "received",
      activeTool: null,
      turnId: provisionalTurnId,
      startedAt: optimisticStartedAt,
      unseenOutcome: null,
    });
    armSettleTimer(activeId, provisionalTurnId);

    // Remote mode: this device is the phone driving a paired desktop. Forward the
    // turn as a `run` command instead of running the local agent — the desktop is
    // authoritative and its reply streams back as live frames. sendRemoteCommand
    // appends both the optimistic user row and a provisional assistant turn, so a
    // terminal timeout/error has an exact target even before turn_start arrives.
    // We DO flip `streaming` optimistically
    // (rather than waiting for the desktop's turn_start frame) to close the
    // double-submit window: the round-trip can be slow or dropped, and an enabled
    // composer would let a second Enter fire a duplicate `run`. Every terminal/drop
    // path (turn_end/error, the drop listener, the send catch, disconnectRemote)
    // already clears streaming:false, so the composer can't get stranded.
    if (get().remoteConnected) {
      setRun(set, activeId, {
        streaming: true,
        turnId: provisionalTurnId,
        startedAt: optimisticStartedAt,
        finalizing: false,
        agentDurationMs: null,
        phaseRevision: 0,
        receipt: null,
        outcome: null,
      });
      // Remote idle watchdog (symmetric with the local one below). The desktop is
      // authoritative, but if its agent dies/hangs without ever emitting
      // turn_end/error AND the channel stays up (no drop fires), nothing would clear
      // `streaming` and the composer would be stranded. Arm a timer that force-ends a
      // silent remote turn; every live frame for the active session resets it (see
      // applyFrame), and every terminal/teardown path clears it (turn_end/error in
      // applyRemoteEvent, the drop listener, the send-command catch, stop(),
      // disconnectRemote).
      clearRemoteWatchdog(activeId);
      remoteLastActivity.set(activeId, now());
      const watchdog = setInterval(() => {
        // The turn already ended or was stopped elsewhere — just clean up. The
        // remote turn runs on the active session, so the active-run mirror is the
        // right "still streaming?" signal here.
        const current = get().runs[runKey(activeId)];
        if (!current?.streaming || remoteWatchdogs.get(activeId) !== watchdog) {
          clearRemoteWatchdog(activeId);
          return;
        }
        if (now() - (remoteLastActivity.get(activeId) ?? 0) < TURN_IDLE_TIMEOUT_MS) return;
        // No live frame for the whole idle window → treat the desktop as hung and
        // recover, so the composer can't stay disabled forever.
        clearRemoteWatchdog(activeId);
        clearSettleTimer(activeId);
        set((st) => ({
          ...terminalizeTurnState(
            st,
            activeId,
            TOOL_INTERRUPTED_ERROR,
            "interrupted",
            undefined,
            undefined,
            "\n\n**The desktop stopped responding (timed out).**",
          ),
        }));
      }, 1000);
      remoteWatchdogs.set(activeId, watchdog);
      await get().sendRemoteCommand({ cmd: "run", session_id: activeId, text: body });
      return;
    }

    const userMsg: Message = {
      id: uid(),
      role: "user",
      blocks: [{ kind: "text", text: body }],
      createdAt: now(),
      turnId: provisionalTurnId,
    };
    const assistant: Message = {
      id: provisionalTurnId,
      role: "assistant",
      blocks: [],
      createdAt: optimisticStartedAt,
      turnId: provisionalTurnId,
    };

    set((st) => {
      const msgs = st.messages[activeId] ?? [];
      const sessions = st.sessions.map((s) =>
        s.id === activeId
          ? {
              ...s,
              updatedAt: now(),
              title: msgs.length === 0 ? deriveTitle(body) : s.title,
            }
          : s,
      );
      return {
        sessions,
        ...runPatch(st, activeId, {
          streaming: true,
          turnId: provisionalTurnId,
          startedAt: optimisticStartedAt,
          finalizing: false,
          agentDurationMs: null,
          phaseRevision: 0,
          receipt: null,
          outcome: null,
        }),
        messages: {
          ...st.messages,
          [activeId]: [...msgs, userMsg, assistant],
        },
        transcriptScrollRequest: {
          id: uid(),
          sessionId: activeId,
          kind: "newTurn",
          targetMessageId: userMsg.id,
        },
        // Each turn's agents panel starts empty; this turn's subagents repopulate it.
        agents: { ...st.agents, [activeId]: [] },
      };
    });

    const apply = (fn: (blocks: ContentBlock[]) => ContentBlock[]) =>
      set((st) => ({
        messages: patchTurnMessage(
          st.messages,
          activeId,
          st.runs[runKey(activeId)]?.turnId ?? provisionalTurnId,
          (message) => ({ ...message, blocks: fn(message.blocks) }),
        ),
      }));

    // A turn must ALWAYS reach a terminal state. The Rust core emits turn_end/error,
    // but if it ever hangs or dies silently nothing would clear `streaming` — and
    // since send() no-ops while streaming, that would brick every future message.
    // So we (a) tear the per-turn event listener down the instant a turn ends — a
    // leaked listener folds the NEXT turn's deltas into this message — and (b) run a
    // client-side watchdog that force-ends a silent turn so the app always recovers.
    // The run-map key for this turn's session, captured up front so the watchdog
    // and the post-await Stop check read THIS run's streaming flag (the
    // authoritative source) rather than the active-session mirror — correct even
    // if the active session were to change out from under a long-running turn.
    const myKey = runKey(activeId);
    let run: Awaited<ReturnType<typeof ipc.runAgent>> | null = null;
    let settled = false;
    let lastActivity = now();
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let cancelTerminalTimer: ReturnType<typeof setTimeout> | null = null;
    let receiptTerminalTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogCancelInFlight = false;
    let awaitingCancelTerminal = false;
    let observedTurnId = provisionalTurnId;
    let nativeTurnIdKnown = false;
    // More than one tool_use can arrive in a single model turn. Track all live ids
    // so one fast result does not clear the presence label while a sibling tool is
    // still outstanding; the most recently announced pending tool wins the label.
    const pendingTools = new Map<string, string>();

    const markSettled = (): boolean => {
      if (settled) return false;
      settled = true;
      if (watchdog !== null) {
        clearInterval(watchdog);
        watchdog = null;
      }
      if (cancelTerminalTimer !== null) {
        clearTimeout(cancelTerminalTimer);
        cancelTerminalTimer = null;
      }
      if (receiptTerminalTimer !== null) {
        clearTimeout(receiptTerminalTimer);
        receiptTerminalTimer = null;
      }
      awaitingCancelTerminal = false;
      return true;
    };

    // Stop the watchdog + the per-turn listener exactly once after a terminal event.
    const settle = () => {
      if (!markSettled()) return;
      run?.dispose();
    };

    // cancel_agent returning means the abort was accepted, not that native has
    // finished its Git snapshot and emitted TurnEnd/Error. Stop the idle watchdog
    // while retaining the event listener for that authoritative receipt. Legacy
    // cores and simple test mocks may emit nothing, so dispose after a bounded wait.
    const awaitCancelledTerminal = (onGraceExpired: () => void) => {
      if (settled) return;
      awaitingCancelTerminal = true;
      if (watchdog !== null) {
        clearInterval(watchdog);
        watchdog = null;
      }
      if (cancelTerminalTimer !== null) clearTimeout(cancelTerminalTimer);
      cancelTerminalTimer = setTimeout(() => {
        cancelTerminalTimer = null;
        onGraceExpired();
        settle();
      }, CANCEL_TERMINAL_GRACE_MS);
    };

    const applyTerminalEvent = (
      toolOutput: string,
      status: TurnStatus,
      stopReason: string | undefined,
      receipt: TurnReceipt | undefined,
      terminalText?: string,
    ) => {
      const eventTurnId = receipt?.turnId ?? observedTurnId;
      const current = get().runs[myKey];
      // A successful `receiptExpected: false` turn unlocks immediately, so a
      // quick follow-up can start before this listener receives its trailing
      // authoritative terminal. Failed turns now remain subscribed through Error.
      // Distinguish an authoritative replacement of this turn's provisional ID
      // from a genuinely newer run, and never let the stale listener end that run.
      const stillOwnsCurrentRun = nativeTurnIdKnown
        ? current?.turnId === observedTurnId || current?.turnId === eventTurnId
        : current?.turnId === provisionalTurnId || current?.turnId === eventTurnId;
      const supersededByNewTurn = current?.turnId != null && !stillOwnsCurrentRun;
      stopRequestedSessions.delete(activeId);
      pendingTools.clear();
      settle();
      if (supersededByNewTurn) {
        // A quick follow-up turn started during the receipt grace window. Attach
        // this terminal receipt to the cancelled turn only; never stop or relabel
        // the newer run that now owns the session-level UI mirror.
        set((st) => ({
          messages: patchTerminalTurnMessage(
            st.messages,
            activeId,
            observedTurnId,
            toolOutput,
            receipt,
            terminalText,
          ),
        }));
        return;
      }
      clearSettleTimer(activeId);
      set((st) => ({
        ...terminalizeTurnState(
          st,
          activeId,
          toolOutput,
          status,
          stopReason,
          receipt,
          terminalText,
        ),
      }));
    };

    const applyCancelGraceFallback = (
      toolOutput: string,
      status: "cancelled" | "interrupted",
      stopReason?: string,
      terminalText?: string,
    ) => {
      pendingTools.clear();
      stopRequestedSessions.delete(activeId);
      clearSettleTimer(activeId);
      set((st) => ({
        ...terminalizeTurnState(
          st,
          activeId,
          toolOutput,
          status,
          stopReason,
          undefined,
          terminalText,
        ),
      }));
    };

    const onEvent = (e: StreamEvent) => {
      // `receiptExpected: false` means no Git finalization is needed; it does NOT
      // replace the authoritative TurnEnd/Error. Successful no-capture turns may
      // unlock immediately, but failed turns must keep this listener until Error
      // delivers the actionable provider/lifecycle message.
      if (settled) return;
      // Once cancellation is acknowledged, only this turn's terminal receipt is
      // relevant. Ignoring late deltas/turn_start also prevents this listener from
      // touching a fast follow-up turn during the bounded receipt grace window.
      if (awaitingCancelTerminal) {
        const acknowledgedOutcome = e.type === "turn_phase" && e.phase === "agent_completed";
        if (e.type !== "turn_end" && e.type !== "error" && !acknowledgedOutcome) return;
        if (acknowledgedOutcome && e.turnId !== observedTurnId) return;
        if (
          nativeTurnIdKnown &&
          (e.type === "turn_end" || e.type === "error") &&
          e.receipt &&
          e.receipt.turnId !== observedTurnId
        )
          return;
      }
      lastActivity = now();
      switch (e.type) {
        case "turn_start": {
          const currentRun = get().runs[runKey(activeId)] ?? EMPTY_RUN;
          const turnId = e.turnId ?? e.messageId;
          observedTurnId = turnId;
          nativeTurnIdKnown = true;
          const startedAt = e.startedAt ?? currentRun.startedAt ?? optimisticStartedAt;
          set((st) => ({
            ...runPatch(st, activeId, {
              turnId,
              startedAt,
              finalizing: false,
              agentDurationMs: null,
              phaseRevision: 0,
              receipt: null,
              outcome: null,
            }),
            messages: reconcileTurnMessage(
              st.messages,
              activeId,
              currentRun.turnId ?? provisionalTurnId,
              turnId,
              e.messageId,
              startedAt,
            ),
          }));
          break;
        }
        case "turn_phase": {
          const currentRun = get().runs[myKey];
          if (!currentRun || currentRun.turnId !== e.turnId) break;
          const previousRevision = currentRun.phaseRevision ?? 0;
          if (e.revision !== undefined && e.revision <= previousRevision) break;
          const phaseRevision = e.revision ?? previousRevision + 1;
          if (e.phase === "provider_started") {
            if (!currentRun.streaming || currentRun.composerPhase === "stopping") break;
            clearSettleTimer(activeId);
            setRun(set, activeId, { composerPhase: "thinking", phaseRevision });
            break;
          }

          clearSettleTimer(activeId);
          pendingTools.clear();
          const status = e.status ?? "completed";
          const toolOutput =
            status === "cancelled" ? TOOL_INTERRUPTED_CANCELLED : TOOL_INTERRUPTED_ERROR;
          set((st) => {
            const run = st.runs[myKey];
            if (!run || run.turnId !== e.turnId) return {};
            const receipt = receiptFromAgentCompletion(st, activeId, e);
            if (!receipt) return {};
            const agentStatus: TerminalAgentStatus =
              status === "completed" ? "ok" : status === "cancelled" ? "cancelled" : "error";
            return {
              messages: patchTerminalTurnMessage(
                st.messages,
                activeId,
                e.turnId,
                toolOutput,
                receipt,
              ),
              agents: terminalizeRunningAgents(st.agents, activeId, agentStatus),
              ...runPatch(st, activeId, {
                streaming: false,
                cancel: null,
                pendingPermission: null,
                finalizing: e.receiptExpected !== false || status === "error",
                agentDurationMs: receipt.agentDurationMs ?? receipt.durationMs ?? null,
                phaseRevision,
                receipt,
                outcome: status,
                composerPhase: "idle",
                activeTool: null,
                unseenOutcome: st.activeId !== activeId && status !== "completed" ? status : null,
              }),
            };
          });

          if (e.receiptExpected !== false || status === "error") {
            if (receiptTerminalTimer !== null) clearTimeout(receiptTerminalTimer);
            receiptTerminalTimer = setTimeout(() => {
              receiptTerminalTimer = null;
              const run = get().runs[myKey];
              if (!run?.finalizing || run.streaming || run.turnId !== e.turnId) return;
              applyTerminalEvent(toolOutput, status, e.stopReason, run.receipt ?? undefined);
            }, RECEIPT_TERMINAL_GRACE_MS);
          } else {
            // No Git boundary remains, so there is nothing for this per-run
            // listener to finalize. Tear it down before Send can start a follow-up
            // on the same session channel; the persisted TurnEnd is recovered on
            // reload and the provisional receipt is already complete for this UI.
            settle();
          }
          break;
        }
        case "text_delta":
          // First real byte settles the receipt into "thinking with you…" (and
          // cancels the fallback timer). Only advance from "received" so a Stop
          // in flight ("stopping…") isn't overwritten by a late delta.
          if (get().runs[myKey]?.composerPhase === "received") {
            clearSettleTimer(activeId);
            setRun(set, activeId, { composerPhase: "thinking" });
          }
          apply((blocks) => appendText(blocks, e.text));
          break;
        case "tool_use":
          if (get().runs[myKey]?.composerPhase === "received") {
            clearSettleTimer(activeId);
            setRun(set, activeId, { composerPhase: "thinking" });
          }
          // Surface the running tool in the presence line ("running <tool>…").
          pendingTools.set(e.id, e.name);
          setRun(set, activeId, { activeTool: e.name });
          apply((blocks) => [
            ...blocks,
            { kind: "tool_use", id: e.id, name: e.name, input: e.input },
          ]);
          break;
        case "tool_result":
          // The tool finished — fall back to the generic "thinking with you…".
          pendingTools.delete(e.id);
          setRun(set, activeId, { activeTool: Array.from(pendingTools.values()).pop() ?? null });
          apply((blocks) => [
            ...blocks,
            {
              kind: "tool_result",
              toolUseId: e.id,
              output: e.output,
              isError: e.isError,
            },
          ]);
          break;
        case "permission_request":
          setRun(set, activeId, {
            pendingPermission: {
              id: e.id,
              tool: e.tool,
              risk: e.risk,
              summary: e.summary,
              input: e.input,
              diff: e.diff,
            },
          });
          break;
        case "usage":
          set((st) => {
            const cur = st.usage[activeId] ?? { input: 0, output: 0 };
            return {
              usage: {
                ...st.usage,
                [activeId]: {
                  input: cur.input + e.inputTokens,
                  output: cur.output + e.outputTokens,
                },
              },
            };
          });
          break;
        case "error":
          {
            const errorMessage = sessionScopedStreamError(get(), activeId, e.message);
            applyTerminalEvent(
              TOOL_INTERRUPTED_ERROR,
              e.receipt?.status ?? "error",
              e.receipt?.stopReason,
              e.receipt,
              e.receipt?.failure ? undefined : `\n\n**Error:** ${errorMessage}`,
            );
          }
          break;
        case "turn_end":
          applyTerminalEvent(
            e.stopReason === "cancelled" ? TOOL_INTERRUPTED_CANCELLED : TOOL_INTERRUPTED_ERROR,
            e.receipt?.status ?? (e.stopReason === "cancelled" ? "cancelled" : "completed"),
            e.stopReason,
            e.receipt,
          );
          break;
        case "agent_started":
        case "agent_progress":
        case "agent_finished":
          set((st) => ({ agents: applyAgentEvent(st.agents, activeId, e) }));
          break;
      }
    };

    watchdog = setInterval(() => {
      // The turn already ended or was stopped elsewhere (e.g. Stop) — just clean up.
      const currentRun = get().runs[myKey];
      if (settled || (!currentRun?.streaming && !currentRun?.finalizing)) {
        settle();
        return;
      }
      // Provider/tool work is over. Receipt delivery has its own much shorter cap;
      // never run the agent idle-cancel path against Git finalization.
      if (currentRun.finalizing && !currentRun.streaming) return;
      // No event for the whole idle window → treat the turn as hung and recover, so
      // the composer can't stay disabled forever.
      if (now() - lastActivity < TURN_IDLE_TIMEOUT_MS) return;
      if (watchdogCancelInFlight) return;
      // Cancellation must be acknowledged before we hide the listener or claim the
      // timed-out run stopped. A rejected invoke keeps streaming locked and visible.
      if (run === null) {
        stopRequestedSessions.add(activeId);
        setRun(set, activeId, { finalizing: true });
        setRun(set, activeId, { composerPhase: "stopping" });
        return;
      }
      watchdogCancelInFlight = true;
      setRun(set, activeId, { finalizing: true });
      void run
        .cancel()
        .then(() => {
          awaitCancelledTerminal(() =>
            applyCancelGraceFallback(
              TOOL_INTERRUPTED_ERROR,
              "interrupted",
              undefined,
              "\n\n**Error:** The agent stopped responding (timed out). Please try again.",
            ),
          );
        })
        .catch((err) => {
          watchdogCancelInFlight = false;
          lastActivity = now();
          setRun(set, activeId, { finalizing: false });
          apply((blocks) =>
            appendText(
              blocks,
              `\n\n**The agent timed out, but cancellation could not be confirmed:** ${errMessage(err)}. It may still be running.`,
            ),
          );
          setRun(set, activeId, { composerPhase: "thinking" });
        });
    }, 1000);

    try {
      // Per-session model (PR #30): fall back to the global default for older rows.
      const handle = await ipc.runAgent(activeId, body, onEvent);
      run = handle;
      const cancelRun = async () => {
        await handle.cancel();
        awaitCancelledTerminal(() =>
          applyCancelGraceFallback(TOOL_INTERRUPTED_CANCELLED, "cancelled", "cancelled"),
        );
      };
      receiptAwareCancels.add(cancelRun);
      if (settled) {
        // A terminal event (or the watchdog) settled the turn before the handle
        // resolved. settle() already ran with run===null (a no-op), so the now-resolved
        // handle still needs its listener torn down. The terminal event already issued
        // any backend cancel it needed, so just dispose — no spurious cancel_agent.
        handle.dispose();
      } else if (stopRequestedSessions.has(activeId)) {
        // The user pressed Stop while runAgent was still awaiting its handle, so
        // stop() could mark finalization but could not yet reach the backend. Send
        // the deferred cancel now and keep the listener until the terminal receipt.
        try {
          await cancelRun();
        } catch (err) {
          stopRequestedSessions.delete(activeId);
          lastActivity = now();
          // Cancellation was not acknowledged. Keep streaming + listener + watchdog
          // live, arm Stop for a retry, and state the uncertainty in the transcript.
          setRun(set, activeId, { cancel: cancelRun, finalizing: false });
          apply((blocks) =>
            appendText(
              blocks,
              `\n\n**Stop could not be confirmed:** ${errMessage(err)}. The agent may still be running.`,
            ),
          );
          setRun(set, activeId, { composerPhase: "thinking" });
          return;
        }
        // Cancellation is acknowledged, but native still has to capture and emit
        // the durable terminal receipt. Keep streaming/finalizing locked until that
        // event arrives or the bounded grace fallback above expires.
      } else {
        // Stop aborts the run AND clears this turn's watchdog (owned by this closure).
        setRun(set, activeId, {
          cancel: cancelRun,
        });
      }
    } catch (err) {
      onEvent({ type: "error", message: String(err) });
    }
  },

  async stop() {
    const activeId = get().activeId;
    if (activeId) await get().stopSession(activeId);
  },

  async stopSession(activeId) {
    // Acknowledge the Stop intent in <100ms — before the backend cancel resolves —
    // by relabeling the presence to "stopping…" and stopping the settle fallback.
    clearSettleTimer(activeId);
    const targetRun = get().runs[runKey(activeId)];
    const legacyActiveStreaming = get().activeId === activeId && get().streaming;
    if (!targetRun?.streaming && !legacyActiveStreaming) {
      return;
    }
    // A prior Stop is already acknowledged and waiting for its native terminal
    // receipt. Do not send duplicate cancel commands or reset the grace handshake.
    if (targetRun?.finalizing) return;
    stopRequestedSessions.add(activeId);
    // Older restored/test state may have only the active-run mirror populated. Seed
    // the per-session source of truth from the observed assistant before patching it,
    // so Stop never clears its own cancel handle while marking finalization.
    set((st) => {
      const existing = st.runs[runKey(activeId)];
      if (existing) {
        return runPatch(st, activeId, { finalizing: true, composerPhase: "stopping" });
      }
      const assistant = [...(st.messages[activeId] ?? [])]
        .reverse()
        .find((message) => message.role === "assistant");
      return runPatch(st, activeId, {
        streaming: st.streaming,
        cancel: st.cancel,
        pendingPermission: st.pendingPermission,
        turnId: assistant?.turnId ?? assistant?.id ?? null,
        startedAt: assistant?.createdAt ?? null,
        finalizing: true,
        composerPhase: "stopping",
        activeTool: st.activeTool,
      });
    });
    // Remote mode: the turn runs on the desktop, so stop it with a Cancel command
    // over the link (there is no local `cancel` handle on the phone).
    if (get().remoteConnected) {
      clearRemoteWatchdog(activeId); // the turn is over — stop the idle watchdog
      const cancelledTurnId = get().runs[runKey(activeId)]?.turnId ?? null;
      if (activeId) await get().sendRemoteCommand({ cmd: "cancel", session_id: activeId });
      stopRequestedSessions.delete(activeId);
      if (get().remoteDropped) return;
      const current = get().runs[runKey(activeId)];
      if (!current?.streaming || current.turnId !== cancelledTurnId) return;
      clearRemoteCancelTerminalTimer(activeId);
      const timer = setTimeout(() => {
        remoteCancelTerminalTimers.delete(activeId);
        set((st) => {
          const run = st.runs[runKey(activeId)];
          if (!run?.streaming || run.turnId !== cancelledTurnId) return {};
          return {
            ...terminalizeTurnState(
              st,
              activeId,
              TOOL_INTERRUPTED_CANCELLED,
              "cancelled",
              "cancelled",
            ),
          };
        });
      }, CANCEL_TERMINAL_GRACE_MS);
      remoteCancelTerminalTimers.set(activeId, timer);
      return;
    }
    const c =
      get().runs[runKey(activeId)]?.cancel ?? (get().activeId === activeId ? get().cancel : null);
    // runAgent has not returned its handle yet. Keep streaming/stopping true; its
    // post-await branch observes this intent and performs the acknowledged cancel.
    if (!c) return;
    try {
      await c();
      stopRequestedSessions.delete(activeId);
      // Production local runs retain their listener for the native receipt and
      // keep the composer locked until it arrives (or their grace timer expires).
      // The fallback below is only for restored/legacy state with an opaque cancel
      // callback that cannot participate in that handshake.
      if (receiptAwareCancels.has(c)) return;
      set((st) => ({
        ...terminalizeTurnState(st, activeId, TOOL_INTERRUPTED_CANCELLED, "cancelled", "cancelled"),
      }));
    } catch (err) {
      stopRequestedSessions.delete(activeId);
      setRun(set, activeId, { finalizing: false });
      // The backend may still be executing. Retain the cancel handle + streaming
      // lock, keep listening for a real terminal event, and make uncertainty visible.
      set((st) => ({
        messages: patchTurnMessage(
          st.messages,
          activeId,
          st.runs[runKey(activeId)]?.turnId,
          (message) => ({
            ...message,
            blocks: appendText(
              message.blocks,
              `\n\n**Stop could not be confirmed:** ${errMessage(err)}. The agent may still be running.`,
            ),
          }),
        ),
        ...runPatch(st, activeId, { composerPhase: "thinking" }),
      }));
    }
  },

  // Stop ONE subagent (and its descendants) from the agents panel, leaving the
  // top-level turn running. The real status arrives back as an `agent_finished`
  // event (status "cancelled"), which updates the panel row.
  async cancelAgent(agentId: string) {
    if (get().remoteConnected) {
      // The subagent runs on the desktop; cancel it over the link.
      await get().sendRemoteCommand({ cmd: "cancel_agent", agent_id: agentId });
      return;
    }
    try {
      await ipc.cancelAgentById(agentId);
    } catch {
      /* best-effort: the subagent will also stop on the session-wide Stop */
    }
  },

  async resolvePermission(
    sessionOrDecision: string,
    permissionOrAlways?: string | boolean,
    decisionArg?: "allow" | "deny",
    alwaysArg?: boolean,
  ) {
    // Keep the historical `(decision, always?)` form while exposing the identity-
    // bearing form used by prompts that can remain pending in background sessions.
    const legacy = sessionOrDecision === "allow" || sessionOrDecision === "deny";
    const sessionId = legacy ? (get().activeId ?? "__legacy-active__") : sessionOrDecision;
    const p = legacy
      ? (get().runs[runKey(sessionId)]?.pendingPermission ?? get().pendingPermission)
      : get().runs[runKey(sessionId)]?.pendingPermission;
    if (!p) return;
    const permissionId = legacy ? p.id : String(permissionOrAlways ?? "");
    const decision = legacy ? sessionOrDecision : decisionArg;
    const always = legacy ? Boolean(permissionOrAlways) : alwaysArg;
    if ((decision !== "allow" && decision !== "deny") || permissionId !== p.id) return;

    // Remote mode: the permission gate belongs to the desktop's agent run, so
    // answer it as a Permission command over the link — the local
    // `resolve_permission` is desktop-only and not registered on the phone. The
    // "always" policy is a desktop-side setting the phone can't change through
    // this command, so it's ignored on the remote path. The same stale-click
    // guard applies (don't answer a request a newer one superseded).
    // A disconnected phone shell must fail closed here. It must never fall
    // through to the desktop-only IPC path (or persist a local allow rule) just
    // because its transport dropped between rendering and resolving a prompt.
    if (get().remoteMode && !get().remoteConnected) return;

    if (get().remoteConnected) {
      const current = legacy
        ? (get().runs[runKey(sessionId)]?.pendingPermission ?? get().pendingPermission)
        : get().runs[runKey(sessionId)]?.pendingPermission;
      if (current && current.id !== permissionId) return;
      setRun(set, sessionId, { pendingPermission: null });
      await get().sendRemoteCommand({ cmd: "permission", id: permissionId, decision });
      return;
    }

    // A superseding request may have replaced the prompt while we awaited
    // (or between render and click); only resolve the request we captured so a
    // stale click can't clear/answer a newer one.
    const current = legacy
      ? (get().runs[runKey(sessionId)]?.pendingPermission ?? get().pendingPermission)
      : get().runs[runKey(sessionId)]?.pendingPermission;
    if (current && current.id !== permissionId) return;
    // Persist an "Always allow" scope before releasing the backend gate. Native
    // reads permission policy live between serialized prompts, so queued calls in
    // this same task immediately observe the new rule instead of prompting again.
    // updateSettings handles failures internally and always settles, after which
    // this request is still resolved as a one-shot Allow.
    if (always && decision === "allow") {
      // "Always allow" adds a scoped rule instead of flipping the global policy.
      // Commands retain their command scope; other prompts retain their tool scope.
      const rule = scopedAllowRule(p);
      const rules = get().settings.rules;
      const nextRules = rulesWithEffectiveAllow(rules, rule);
      if (nextRules !== rules) {
        await get().updateSettings({ rules: nextRules });
      }
    }
    // The settings save above crossed an async boundary. Re-check identity before
    // clearing or answering so an impossible-but-defensive superseding request is
    // never resolved by a stale click.
    const latest = legacy
      ? (get().runs[runKey(sessionId)]?.pendingPermission ?? get().pendingPermission)
      : get().runs[runKey(sessionId)]?.pendingPermission;
    if (latest && latest.id !== permissionId) return;
    setRun(set, sessionId, { pendingPermission: null });
    await ipc.resolvePermission(permissionId, decision);
  },

  setShowSettings(v) {
    set({ showSettings: v });
  },

  setShowPalette(v) {
    set({ showPalette: v });
  },

  setWorkspaceSurface(v) {
    set({ workspaceSurface: v });
  },

  openWorkspaceReview() {
    set({ reviewTarget: { kind: "workspace" }, workspaceSurface: "review" });
  },

  openTurnReview(turnId) {
    set({ reviewTarget: { kind: "turn", turnId }, workspaceSurface: "review" });
  },

  setAmbientRain(v) {
    writePref("pc.ambientRain", v);
    set({ ambientRain: v });
  },

  setScanlines(v) {
    writePref("pc.scanlines", v);
    set({ scanlines: v });
  },

  setUiScale(n) {
    writeStr("pc.uiScale", String(n));
    applyUiScale(n);
    set({ uiScale: n });
  },

  // Persist the consent choice; the frontend SDK init/shutdown is driven by an
  // effect in App watching `crashReporting`, so the store stays free of any
  // telemetry-SDK import (keeps it pure + its tests lightweight). We ALSO mirror
  // the choice to the Rust host (best-effort: swallow errors so the mobile build —
  // where the command isn't registered — and DSN-less dev builds don't throw).
  setCrashReporting(v) {
    writePref("pc.crashReporting", v);
    set({ crashReporting: v });
    void ipc.setTelemetryConsent(v).catch(() => {});
  },

  toggleFiles() {
    set((st) => ({ showFiles: !st.showFiles }));
  },

  toggleSidebar() {
    set((st) => ({ showSidebar: !st.showSidebar }));
  },

  setShowSidebar(v) {
    set({ showSidebar: v });
  },

  setSidebarCollapsed(v) {
    writePref("pc.sidebarCollapsed", v);
    set({ sidebarCollapsed: v });
  },

  // ── Sessions sidebar organization ───────────────────────────────────────────
  setSortBy(v) {
    writeStr("pc.sortBy", v);
    set({ sortBy: v });
  },

  setGroupBy(v) {
    writeStr("pc.groupBy", v);
    set({ groupBy: v });
  },

  setManualOrder(ids) {
    // A drag-reorder switches the list to manual order: persist the order and
    // flip sortBy to "manual" so the presets visibly turn off (the handoff's
    // "in case of reordering, sort by goes off").
    writeJSON("pc.manualOrder", ids);
    writeStr("pc.sortBy", "manual");
    set({ manualOrder: ids, sortBy: "manual" });
  },

  addFolder() {
    const folder: SessionFolder = { id: uid(), name: "New folder", open: true };
    set((st) => {
      const folders = [...st.folders, folder];
      writeJSON("pc.folders", folders);
      return { folders };
    });
  },

  toggleFolder(id) {
    set((st) => {
      const folders = st.folders.map((f) => (f.id === id ? { ...f, open: !f.open } : f));
      writeJSON("pc.folders", folders);
      return { folders };
    });
  },

  renameFolder(id, name) {
    // Ignore an empty/whitespace rename so a folder can never lose its label.
    const trimmed = name.trim();
    if (!trimmed) return;
    set((st) => {
      const folders = st.folders.map((f) => (f.id === id ? { ...f, name: trimmed } : f));
      writeJSON("pc.folders", folders);
      return { folders };
    });
  },

  deleteFolder(id) {
    set((st) => {
      const folders = st.folders.filter((f) => f.id !== id);
      // Orphan the folder's members back to loose (drop their membership entries)
      // so they reappear at the root rather than vanishing into a dead folder id.
      const folderOf: Record<string, string | null> = {};
      for (const [sid, fid] of Object.entries(st.folderOf)) {
        if (fid !== id) folderOf[sid] = fid;
      }
      writeJSON("pc.folders", folders);
      writeJSON("pc.folderOf", folderOf);
      return { folders, folderOf };
    });
  },

  moveSessionToFolder(sessionId, folderId) {
    set((st) => {
      const folderOf = { ...st.folderOf };
      if (folderId === null) delete folderOf[sessionId];
      else folderOf[sessionId] = folderId;
      writeJSON("pc.folderOf", folderOf);
      return { folderOf };
    });
  },

  async toggleArchived(sessionId, force = false) {
    const alreadyArchived = get().archivedIds.includes(sessionId);
    if (alreadyArchived) {
      set((st) => {
        const archivedIds = st.archivedIds.filter((id) => id !== sessionId);
        writeJSON("pc.archivedIds", archivedIds);
        return { archivedIds };
      });
      return { outcome: "unarchived" };
    }

    if (!force) {
      const warning = await ipc.getSessionArchiveWarning(sessionId);
      // A session could disappear while Git status was in flight. Do not retain a
      // stale archived id or open a warning for an object that no longer exists.
      if (!get().sessions.some((session) => session.id === sessionId)) {
        return { outcome: "archived" };
      }
      if (warning) return { outcome: "needsConfirmation", warning };
    }

    set((st) => {
      if (st.archivedIds.includes(sessionId)) return {};
      const archivedIds = [...st.archivedIds, sessionId];
      writeJSON("pc.archivedIds", archivedIds);
      return { archivedIds };
    });
    return { outcome: "archived" };
  },

  setDraft(v) {
    const id = get().activeId;
    if (id && get().pendingSession?.id === id) {
      set((st) => {
        const drafts = { ...st.drafts };
        if (v) drafts[id] = v;
        else delete drafts[id];
        return { drafts };
      });
      return;
    }
    if (!id) return; // no active session → nowhere to key the draft
    set((st) => {
      const drafts = { ...st.drafts };
      // Keep the mirror tidy: an emptied draft drops its key (matches the backend,
      // which deletes a blank row) so a cleared draft never round-trips back.
      if (v) drafts[id] = v;
      else delete drafts[id];
      writeJSON("pc.drafts", drafts); // optimistic mirror — instant restore on reload
      return { drafts };
    });
    persistDraft(id, v, false); // debounced durable write
  },

  appendDraft(v) {
    const id = get().activeId;
    if (!id) return;
    const cur = get().drafts[id] ?? "";
    const sep = cur && !cur.endsWith(" ") ? " " : "";
    get().setDraft(cur + sep + v + " ");
  },

  async openWorkspace() {
    // Guard the picker + save: a dialog/save reject must surface in the explorer
    // instead of being a silent unhandled rejection (all callers use `void`).
    // Persist directly (not via updateSettings, which swallows into settingsError)
    // so a save failure lands in workspaceError, the explorer's own surface.
    set({ workspaceError: null });
    try {
      const dir = await ipc.openFolder();
      if (dir) {
        const next = await ipc.saveSettings({ workspace: dir });
        set({ settings: next });
      }
    } catch (err) {
      const failure = await reconcileSettingsSaveFailure(err);
      set({
        workspaceError: failure.message,
        ...(failure.authoritative ? { settings: failure.authoritative } : {}),
      });
    }
  },

  async updateSettings(s) {
    // Permission mode is shared security policy. Changing it while any session is
    // executing or waiting for approval would mutate the rules under that run.
    if ("permissionMode" in s && anyRunBusy(get())) return;
    // Fail loudly: a saveSettings reject must surface (so the controlled UI doesn't
    // silently snap back to the old value) instead of being a swallowed rejection.
    set({ settingsError: null });
    try {
      const patch: Partial<Settings> = { ...s };
      if (s.model) {
        const provider = providerForModel(s.model, get().openAIModels);
        const reasoningEffort = reasoningEffortForModel(
          s.model,
          s.reasoningEffort ?? get().settings.reasoningEffort,
          get().openAIModels,
        );
        if (provider !== get().settings.provider) patch.provider = provider;
        if (reasoningEffort !== get().settings.reasoningEffort) {
          patch.reasoningEffort = reasoningEffort;
        }
      }
      const next = await ipc.saveSettings(patch);
      set({ settings: next });
    } catch (err) {
      const failure = await reconcileSettingsSaveFailure(err);
      set({
        settingsError: failure.message,
        ...(failure.authoritative ? { settings: failure.authoritative } : {}),
      });
    }
  },

  async cyclePermissionMode() {
    // Advance through the SAFE trio only (default → acceptEdits → plan). auto and
    // bypass are deliberately excluded from the quick-cycle (Settings-only opt-in),
    // and cycling out of one of them lands back at the start (default) rather than
    // stepping deeper into a permissive mode.
    const cur = get().settings.permissionMode;
    const i = CYCLE_MODES.indexOf(cur);
    const next: PermissionMode = CYCLE_MODES[(i + 1) % CYCLE_MODES.length] ?? "default";
    await get().updateSettings({ permissionMode: next });
  },

  async refreshOAuthStatus() {
    try {
      const oauthStatus = await ipc.oauthStatus();
      set({ oauthStatus });
    } catch {
      // Transient / core not ready — keep whatever we last knew.
    }
  },

  async loginWithClaude() {
    set({ oauthError: null });
    try {
      const oauthStatus = await ipc.startOauthLogin();
      set({ oauthStatus });
    } catch (err) {
      set({ oauthError: errMessage(err) });
    }
  },

  async logoutClaude() {
    set({ oauthError: null });
    try {
      await ipc.oauthLogout();
      set({ oauthStatus: { signedIn: false, expiresAt: null, account: null, tier: null } });
    } catch (err) {
      set({ oauthError: errMessage(err) });
    }
  },

  async refreshOpenAIStatus() {
    if (typeof ipc.openaiOauthStatus !== "function" || typeof ipc.listOpenAIAccounts !== "function")
      return;
    set({ openAIAccountsLoading: true, openAIAccountsError: null });
    try {
      const [openAIAuthStatus, openAIAccounts] = await Promise.all([
        ipc.openaiOauthStatus(),
        ipc.listOpenAIAccounts(),
      ]);
      const ids = new Set(openAIAccounts.map((account) => account.id));
      const openAIModelCatalogs = Object.fromEntries(
        Object.entries(get().openAIModelCatalogs).filter(([id]) => ids.has(id)),
      );
      const preferred = preferredOpenAIAccount(openAIAccounts, get().lastOpenAIAccountProfileId);
      const defaultAccountProfileId = preferred?.id ?? null;
      writeStr("pc.lastOpenAIAccountProfileId", defaultAccountProfileId);
      set({
        openAIAuthStatus,
        openAIAccounts,
        openAIAccountsLoading: false,
        openAIAccountsError: null,
        openAIModelCatalogs,
        lastOpenAIAccountProfileId: defaultAccountProfileId,
        openAIModels:
          openAIAuthStatus.available === false
            ? []
            : preferred
              ? modelsForOpenAIProfile(preferred.id, openAIModelCatalogs)
              : OPENAI_FALLBACK_MODELS,
      });
      if (openAIAuthStatus.available !== false && preferred) {
        await get().loadOpenAIAccountModels(preferred.id, true);
      }
    } catch (error) {
      // Retain the last known summaries and profile-local catalogues; unlike the
      // old singleton path, surface that discovery is stale instead of pretending
      // a fallback catalogue came from an account.
      set({ openAIAccountsLoading: false, openAIAccountsError: errMessage(error) });
    }
  },

  async loginWithOpenAI() {
    set({ openAIAuthError: null });
    if (get().openAIAuthStatus?.available === false) {
      set({
        openAIAuthError:
          get().openAIAuthStatus?.unavailableReason ??
          "ChatGPT subscription access is unavailable in this build.",
      });
      return;
    }
    if (typeof ipc.startOpenAIAccountLogin !== "function") {
      set({ openAIAuthError: "This Portcode core does not support ChatGPT sign-in yet." });
      return;
    }
    try {
      const account = await ipc.startOpenAIAccountLogin();
      const nextAccounts = [
        account,
        ...get().openAIAccounts.filter((candidate) => candidate.id !== account.id),
      ];
      const defaultAccountProfileId =
        preferredOpenAIAccount(nextAccounts, get().lastOpenAIAccountProfileId)?.id ?? null;
      writeStr("pc.lastOpenAIAccountProfileId", defaultAccountProfileId);
      set({
        openAIAccounts: nextAccounts,
        lastOpenAIAccountProfileId: defaultAccountProfileId,
        openAIReconnectMismatch: null,
      });
      await get().loadOpenAIAccountModels(account.id, true);
    } catch (err) {
      set({ openAIAuthError: errMessage(err) });
    }
  },

  async reconnectOpenAIAccount(accountProfileId) {
    set({ openAIAuthError: null, openAIReconnectMismatch: null });
    try {
      const outcome = await ipc.reconnectOpenAIAccount(accountProfileId);
      if (outcome.status === "identity_mismatch") {
        set({
          openAIReconnectMismatch: { accountProfileId, message: outcome.message },
        });
        return;
      }
      const { account } = outcome;
      const nextAccounts = get().openAIAccounts.map((candidate) =>
        candidate.id === account.id ? account : candidate,
      );
      const defaultAccountProfileId =
        preferredOpenAIAccount(nextAccounts, get().lastOpenAIAccountProfileId)?.id ?? null;
      writeStr("pc.lastOpenAIAccountProfileId", defaultAccountProfileId);
      set({
        openAIAccounts: nextAccounts,
        lastOpenAIAccountProfileId: defaultAccountProfileId,
      });
      await get().loadOpenAIAccountModels(account.id, true);
    } catch (err) {
      set({ openAIAuthError: errMessage(err) });
    }
  },

  async setDefaultOpenAIAccount(accountProfileId) {
    set({ openAIAuthError: null });
    const account = get().openAIAccounts.find(
      (candidate) => candidate.id === accountProfileId && candidate.state === "connected",
    );
    if (!account) {
      set({ openAIAuthError: "Choose a connected ChatGPT account as the default." });
      return;
    }

    writeStr("pc.lastOpenAIAccountProfileId", accountProfileId);
    set({ lastOpenAIAccountProfileId: accountProfileId });
    try {
      const models = await get().loadOpenAIAccountModels(accountProfileId);
      set({ openAIModels: models });
      const current = get().settings;
      if (current.provider === "openai" && !models.some((model) => model.id === current.model)) {
        const fallback = models[0];
        if (fallback) {
          await get().updateSettings({
            model: fallback.id,
            reasoningEffort: fallback.defaultReasoningEffort,
          });
        }
      }
    } catch (error) {
      set({ openAIAuthError: errMessage(error) });
    }
  },

  async removeOpenAIAccount(accountProfileId) {
    set({ openAIAuthError: null });
    try {
      await ipc.removeOpenAIAccount(accountProfileId);
      openAIModelRequestVersions.set(
        accountProfileId,
        (openAIModelRequestVersions.get(accountProfileId) ?? 0) + 1,
      );
      let discoveryError: string | null = null;
      let authoritativeAccounts: OpenAIAccountSummary[] | null = null;
      try {
        authoritativeAccounts = await ipc.listOpenAIAccounts();
      } catch (error) {
        discoveryError = errMessage(error);
      }
      set((state) => {
        // A successful removal is represented as a retained safe tombstone. If
        // the follow-up registry read fails, keep the local summary but mark it
        // removed so history remains attributable and exact reconnect stays possible.
        const openAIAccounts =
          authoritativeAccounts ??
          state.openAIAccounts.map((account) =>
            account.id === accountProfileId
              ? { ...account, state: "removed" as const, expiresAt: null }
              : account,
          );
        const openAIModelCatalogs = { ...state.openAIModelCatalogs };
        delete openAIModelCatalogs[accountProfileId];
        const retainedDefaultAccountProfileId =
          state.lastOpenAIAccountProfileId === accountProfileId
            ? null
            : state.lastOpenAIAccountProfileId;
        const preferred = preferredOpenAIAccount(openAIAccounts, retainedDefaultAccountProfileId);
        const nextDefaultAccountProfileId = preferred?.id ?? null;
        writeStr("pc.lastOpenAIAccountProfileId", nextDefaultAccountProfileId);
        return {
          openAIAccounts,
          openAIAccountsError: discoveryError,
          openAIModelCatalogs,
          lastOpenAIAccountProfileId: nextDefaultAccountProfileId,
          openAIModels: preferred
            ? modelsForOpenAIProfile(preferred.id, openAIModelCatalogs)
            : state.openAIAuthStatus?.available === false
              ? []
              : OPENAI_FALLBACK_MODELS,
        };
      });
      const nextDefaultAccountProfileId = get().lastOpenAIAccountProfileId;
      if (nextDefaultAccountProfileId) {
        try {
          await get().loadOpenAIAccountModels(nextDefaultAccountProfileId);
        } catch (error) {
          set({ openAIAuthError: errMessage(error) });
        }
      }
    } catch (err) {
      set({ openAIAuthError: errMessage(err) });
    }
  },

  async loadOpenAIAccountModels(accountProfileId, force = false) {
    const account = get().openAIAccounts.find((candidate) => candidate.id === accountProfileId);
    if (!account || account.state !== "connected") {
      const message = account
        ? "Reconnect this ChatGPT account before loading models."
        : "ChatGPT account profile was not found.";
      set((state) => ({
        openAIModelCatalogs: {
          ...state.openAIModelCatalogs,
          [accountProfileId]: { status: "error", models: [], error: message },
        },
      }));
      throw new Error(message);
    }
    if (get().openAIAuthStatus?.available === false) {
      throw new Error(
        get().openAIAuthStatus?.unavailableReason ??
          "ChatGPT subscription access is unavailable in this build.",
      );
    }
    const current = get().openAIModelCatalogs[accountProfileId];
    if (!force && current?.status === "ready" && current.models.length > 0) {
      return current.models;
    }
    const requestVersion = (openAIModelRequestVersions.get(accountProfileId) ?? 0) + 1;
    openAIModelRequestVersions.set(accountProfileId, requestVersion);
    set((state) => ({
      openAIModelCatalogs: {
        ...state.openAIModelCatalogs,
        [accountProfileId]: {
          status: "loading",
          models: [],
          error: null,
        },
      },
      ...(preferredOpenAIAccount(state.openAIAccounts, state.lastOpenAIAccountProfileId)?.id ===
      accountProfileId
        ? { openAIModels: [] }
        : {}),
    }));
    try {
      const models = normalizeOpenAIModels(await ipc.openaiModels(accountProfileId));
      if (models.length === 0) {
        throw new Error("This account returned no compatible OpenAI models.");
      }
      if (openAIModelRequestVersions.get(accountProfileId) !== requestVersion) {
        return get().openAIModelCatalogs[accountProfileId]?.models ?? [];
      }
      if (!get().openAIAccounts.some((candidate) => candidate.id === accountProfileId)) {
        return [];
      }
      set((state) => {
        const preferred = preferredOpenAIAccount(
          state.openAIAccounts,
          state.lastOpenAIAccountProfileId,
        );
        return {
          openAIModelCatalogs: {
            ...state.openAIModelCatalogs,
            [accountProfileId]: { status: "ready", models, error: null },
          },
          ...(preferred?.id === accountProfileId ? { openAIModels: models } : {}),
        };
      });
      return models;
    } catch (error) {
      if (openAIModelRequestVersions.get(accountProfileId) === requestVersion) {
        set((state) => ({
          openAIModelCatalogs: {
            ...state.openAIModelCatalogs,
            [accountProfileId]: {
              status: "error",
              models: [],
              error: errMessage(error),
            },
          },
          ...(preferredOpenAIAccount(state.openAIAccounts, state.lastOpenAIAccountProfileId)?.id ===
          accountProfileId
            ? { openAIModels: [] }
            : {}),
        }));
      }
      throw error;
    }
  },

  async pinSessionOpenAIAccount(sessionId, accountProfileId) {
    set({ openAIAuthError: null });
    const session = get().sessions.find((candidate) => candidate.id === sessionId);
    const account = get().openAIAccounts.find((candidate) => candidate.id === accountProfileId);
    const run = get().runs[runKey(sessionId)];
    if (!session) return "error";
    if (session.accountProfileId === accountProfileId && account?.state === "connected") {
      return "selected";
    }
    if (run?.streaming || run?.finalizing || run?.pendingPermission) {
      set({ openAIAuthError: "Wait for this conversation's active turn to finish." });
      return "error";
    }
    if (!account || account.state !== "connected") {
      set({ openAIAuthError: "Choose a connected ChatGPT account." });
      return "error";
    }
    try {
      const models = await get().loadOpenAIAccountModels(accountProfileId);
      const selectedModel = models.find((model) => model.id === session.model) ?? models[0];
      if (!selectedModel) throw new Error("This ChatGPT account has no compatible model.");
      let pinned = await ipc.pinSessionOpenAIAccount(sessionId, accountProfileId, selectedModel.id);
      // Compatibility with a transitional native command that performed the CAS
      // but returned unit: reload and require authoritative confirmation.
      if (!pinned) {
        pinned = (await ipc.listSessions()).find((candidate) => candidate.id === sessionId)!;
      }
      if (!pinned || pinned.accountProfileId !== accountProfileId) {
        throw new Error("The native core did not confirm the selected ChatGPT account.");
      }
      set((state) => ({
        sessions: state.sessions.map((candidate) =>
          candidate.id === sessionId ? { ...candidate, ...pinned } : candidate,
        ),
        ...(state.lastOpenAIAccountProfileId === accountProfileId
          ? { openAIModels: modelsForOpenAIProfile(accountProfileId, state.openAIModelCatalogs) }
          : {}),
      }));
      return "selected";
    } catch (error) {
      const message = errMessage(error);
      set({ openAIAuthError: message });
      return message.includes("already started") ? "locked" : "error";
    }
  },

  async refreshPhoneSync() {
    try {
      const phoneSync = await ipc.phoneSyncStatus();
      set({ phoneSync });
    } catch {
      // Transient / core not ready — keep whatever we last knew.
    }
  },

  async beginPairing() {
    // Fail loudly: phoneSyncBeginPairing is fallible (lock poison / identity / begin)
    // and the Settings UI calls this via `void`, so a swallowed rejection would leave
    // the user stranded with no QR and no feedback. Surface it via pairingError.
    set({ pairingError: null });
    try {
      const pairingPayload = await ipc.phoneSyncBeginPairing();
      set({ pairingPayload });
    } catch (err) {
      set({ pairingError: errMessage(err) });
    }
  },

  async unpair(publicKey) {
    set({ pairingError: null });
    try {
      await ipc.phoneSyncUnpair(publicKey);
      await get().refreshPhoneSync();
    } catch (err) {
      set({ pairingError: errMessage(err) });
    }
  },

  clearPairing() {
    set({ pairingPayload: null });
  },

  // Subscribe to the desktop-side "a new phone wants to pair" event so the
  // Settings pairing UI can surface the SAS + Confirm/Reject. Idempotent: tears
  // down any prior subscription first so a re-open never double-registers. The
  // browser mock's listener is inert (it never fires), so this is a safe no-op
  // there too.
  async listenForPairingRequests() {
    const prev = get().pairingRequestUnlisten;
    if (prev) prev();
    set({ pairingRequestUnlisten: null });
    try {
      const unlisten = await ipc.onPhoneSyncPairingRequest((req) => {
        set({ pairingRequest: req });
      });
      set({ pairingRequestUnlisten: unlisten });
    } catch {
      // Core not ready / event unsupported — leave the gate UI dormant.
    }
  },

  async confirmPairingRequest() {
    const req = get().pairingRequest;
    if (!req) return;
    // Clear the prompt up front so a double-click can't fire two confirms; surface
    // a failure via pairingError and refresh the (now-trusted) device list.
    set({ pairingRequest: null, pairingError: null });
    try {
      await ipc.confirmPairing(req.requestId);
      await get().refreshPhoneSync();
    } catch (err) {
      set({ pairingError: errMessage(err) });
    }
  },

  async rejectPairingRequest() {
    const req = get().pairingRequest;
    if (!req) return;
    set({ pairingRequest: null, pairingError: null });
    try {
      await ipc.rejectPairing(req.requestId);
    } catch (err) {
      set({ pairingError: errMessage(err) });
    }
  },

  // ── Mobile remote client ──────────────────────────────────────────────────
  setRemoteMode(v) {
    set({ remoteMode: v });
  },

  // The user confirmed the SAS matches the desktop's — open the remote session.
  // No-op once the pairing was rejected (by this phone or the desktop): a stale
  // Confirm click must not re-open a session the reject already closed.
  confirmRemoteSas() {
    if (get().remoteRejected) return;
    set({ remoteVerified: true });
  },

  // The user decided the SAS does NOT match (or chose to cancel at the safety gate):
  // reject the pairing. When connected, send the `pairing_reject` frame to the
  // desktop (so it learns the SAS was rejected, not just that the link dropped), then
  // tear the session down exactly like disconnectRemote and mark the pairing rejected
  // so the UI shows a distinct "rejected" notice rather than the generic pair screen.
  async rejectRemoteSas() {
    clearRemoteCancelTerminalTimer();
    clearRemoteWatchdog(); // user-initiated teardown — the turn is over
    const wasConnected = get().remoteConnected;
    const unlisten = get().remoteUnlisten;
    // Mirror disconnectRemote's teardown: flip the connection flags FIRST (before the
    // async reject) so no command is dispatched onto the closing channel, forget the
    // remembered pairing, and clear turn state. Then mark the pairing rejected.
    set((st) => ({
      ...terminalizeAllRunningTurns(st, TOOL_INTERRUPTED_CANCELLED, "cancelled"),
      remoteConnected: false,
      remoteVerified: false,
      remoteSas: null,
      remotePeerKey: null,
      remoteVapidKey: null,
      remoteDropped: false,
      remoteRejected: true,
      // Locally-initiated reject carries no desktop-supplied reason.
      remoteRejectReason: null,
      lastPairingQr: null,
      remoteUnlisten: null,
      // Doubles as an abort sentinel for an in-flight connectRemote dial (same as
      // disconnectRemote): a dial resolving after this sees remoteConnecting false
      // and bails before registering listeners.
      remoteConnecting: false,
      remoteChatOpen: false,
      runs: {},
      streaming: false,
      cancel: null,
      pendingPermission: null,
      composerPhase: "idle",
      activeTool: null,
    }));
    writeStr("pc.lastPairingQr", null); // forget the remembered desktop too
    if (unlisten) unlisten();
    // Only reach for the channel if there was a live session — a reject from a
    // not-connected state just sets the flag (mirrors the idempotent disconnect).
    if (wasConnected) await ipc.phoneSyncReject();
  },

  applyFrame(frame) {
    switch (frame.t) {
      case "session_list":
        set((st) => {
          // Keep activeId sane: keep the current one if it still exists, else
          // point at the first reported session (or null).
          const ids = frame.sessions.map((s) => s.id);
          const activeId =
            st.pendingSession?.id ??
            (st.activeId && ids.includes(st.activeId)
              ? st.activeId
              : (frame.sessions[0]?.id ?? null));
          return {
            sessions: frame.sessions,
            activeId,
            messageLoads: frame.sessions.reduce<Record<string, MessageLoadState>>(
              (loads, session) => {
                loads[session.id] = st.messageLoads[session.id] ?? {
                  ...idleMessageLoad(),
                  phase: session.id in st.messages ? "ready" : "loading",
                };
                return loads;
              },
              {},
            ),
            ...projectActiveRun({ activeId, runs: st.runs }),
          };
        });
        break;
      case "session_created": {
        const matchesRequest = pendingRemoteCreateRequestId === frame.request_id;
        const queued = matchesRequest ? pendingRemoteFirstMessage : null;
        if (matchesRequest) clearPendingRemoteCreate();
        set((st) => {
          const session = frame.session;
          const sessions = [session, ...st.sessions.filter((item) => item.id !== session.id)];
          if (!matchesRequest) return { sessions };
          const runs = st.runs;
          const messages = { ...st.messages };
          const messageLoads = { ...st.messageLoads };
          const drafts = { ...st.drafts };
          if (queued) {
            delete messages[queued.draftId];
            delete messageLoads[queued.draftId];
            delete drafts[queued.draftId];
          }
          return {
            sessions,
            activeId: session.id,
            pendingSession: null,
            drafts,
            messages: { ...messages, [session.id]: [] },
            messageLoads: {
              ...messageLoads,
              [session.id]: { ...idleMessageLoad(), phase: "ready", loadedAt: now() },
            },
            creatingSession: false,
            remoteChatOpen: true,
            ...projectActiveRun({ activeId: session.id, runs }),
          };
        });
        if (queued) void get().send(queued.body);
        break;
      }
      case "command_rejected": {
        const pendingRequestId = pendingRemoteCreateRequestId;
        // The hub broadcasts frames to every paired phone. A rejection belongs
        // only to the phone that owns that exact pending request. Missing and
        // nonmatching ids are both ignored—even while idle—so another client's
        // malformed create cannot contaminate this phone's UI.
        if (pendingRequestId === null || frame.request_id !== pendingRequestId) break;
        const queued = pendingRemoteFirstMessage;
        clearPendingRemoteCreate();
        set((st) => ({
          creatingSession: false,
          remoteError: remoteCommandRejectionMessage(frame.code, frame.message),
          drafts: queued ? { ...st.drafts, [queued.draftId]: queued.body } : st.drafts,
        }));
        break;
      }
      case "message_delta":
        set((st) => {
          const activeId = st.activeId ?? frame.session_id;
          // Seed pagination for this session from the catch-up rows. `seq` is
          // contiguous from 0, so the smallest held seq tells us both the next page
          // cursor (oldestSeq) and whether older history exists (oldestSeq > 0). An
          // EMPTY delta replaces the list and leaves no seq to page from → no more.
          const seqs = frame.messages.map((m) => m.seq);
          // An empty delta leaves no seq to page from (oldestSeq 0, no more). Else the
          // smallest held seq is the page cursor, and older history exists iff it > 0.
          const oldestSeq = seqs.length === 0 ? 0 : Math.min(...seqs);
          const paging = { hasMore: oldestSeq > 0, loading: false, oldestSeq };
          return {
            // Catch-up is authoritative for this session: REPLACE its message list.
            // This is what reconciles any optimistic user message we appended.
            messages: { ...st.messages, [frame.session_id]: rowsToMessages(frame.messages) },
            messagePaging: { ...st.messagePaging, [frame.session_id]: paging },
            messageLoads: {
              ...st.messageLoads,
              [frame.session_id]: {
                ...(st.messageLoads[frame.session_id] ?? idleMessageLoad()),
                phase: "ready",
                loadedAt: now(),
                lastAccessedAt: now(),
                error: null,
                loadingOlder: false,
              },
            },
            activeId,
            ...projectActiveRun({ activeId, runs: st.runs }),
          };
        });
        break;
      case "message_page": {
        // Scroll-up pagination: an OLDER page to PREPEND (vs message_delta, which
        // replaces). Merge ahead of the held list (dedupe by seq/id, keep ascending),
        // record hasMore from the frame, advance the oldest-held cursor, and clear the
        // loading guard for this session.
        const sid = frame.session_id;
        const pageSeqs = frame.messages.map((m) => m.seq);
        set((st) => {
          const prev = st.messagePaging[sid];
          // The new oldest cursor is the smallest seq across the prepended page and
          // what we already tracked; an empty page leaves the prior cursor in place.
          const prevOldest = prev?.oldestSeq ?? Number.POSITIVE_INFINITY;
          const oldestSeq =
            pageSeqs.length === 0 ? (prev?.oldestSeq ?? 0) : Math.min(prevOldest, ...pageSeqs);
          return {
            messages: {
              ...st.messages,
              [sid]: prependMessages(st.messages[sid] ?? [], frame.messages),
            },
            messagePaging: {
              ...st.messagePaging,
              [sid]: { hasMore: frame.has_more, loading: false, oldestSeq },
            },
            messageLoads: {
              ...st.messageLoads,
              [sid]: {
                ...(st.messageLoads[sid] ?? idleMessageLoad()),
                phase: "ready",
                loadingOlder: false,
                error: null,
                lastAccessedAt: now(),
              },
            },
          };
        });
        break;
      }
      case "live":
        // Keep the remote idle watchdog alive: any live frame for the active session
        // is proof the desktop is still talking, so reset its last-activity clock.
        remoteLastActivity.set(frame.session_id, now());
        applyRemoteEvent(set, frame.session_id, frame.event);
        break;
      case "pairing_reject": {
        clearRemoteCancelTerminalTimer();
        // The desktop declined the pairing (the REACT direction: the desktop user
        // rejected the SAS). The phone must stop — drop the session and show the
        // "rejected on the other device" notice. Tear down like a disconnect: clear
        // connection/verification/SAS, stop the idle watchdog, and unsubscribe.
        clearRemoteWatchdog();
        const unlisten = get().remoteUnlisten;
        if (unlisten) unlisten();
        // Forget the remembered desktop — a rejected pairing must not offer one-tap
        // reconnect back into the desktop that just declined.
        writeStr("pc.lastPairingQr", null);
        set((st) => ({
          ...terminalizeAllRunningTurns(st, TOOL_INTERRUPTED_ERROR, "error"),
          remoteConnected: false,
          remoteVerified: false,
          remoteSas: null,
          remotePeerKey: null,
          remoteVapidKey: null,
          remoteDropped: false,
          remoteRejected: true,
          remoteRejectReason: frame.reason ?? null,
          lastPairingQr: null,
          remoteUnlisten: null,
          remoteChatOpen: false,
          runs: {},
          streaming: false,
          cancel: null,
          pendingPermission: null,
          composerPhase: "idle",
          activeTool: null,
        }));
        break;
      }
      // command / ack / hello are phone-originated or not actionable inbound.
      case "command":
      case "ack":
      case "hello":
        break;
    }
  },

  async connectRemote(qr, verified = false) {
    // Re-entry guard: two interleaved dials (e.g. Reconnect + Scan/Connect) would
    // each register a fresh onPhoneSyncFrame listener across the awaits below,
    // orphaning one subscription that keeps double-feeding applyFrame. Serialize so
    // only one dial runs at a time.
    if (get().remoteConnecting) return;
    clearPendingRemoteCreate();
    set({ remoteConnecting: true });
    // Clean reconnect: tear down any prior subscriptions before dialing so a second
    // connect can never leave two live listeners feeding the store.
    const prev = get().remoteUnlisten;
    if (prev) prev();
    // Entering remote-client mode: drop any desktop persistent background-task
    // listeners this device installed while driving its own local agent, so they
    // can't fire and re-populate the `backgroundTasks` map we reset just below (the
    // remote path tracks tasks via frames instead). A no-op on the phone, which
    // never installs them.
    teardownAllBackgroundListeners();
    // A fresh dial is unverified until the user compares the new SAS.
    // Reset connection AND turn state. A fresh dial / reconnect must never inherit a
    // stale `streaming`/`pendingPermission` from a turn the previous session left
    // mid-flight — a drop can't deliver the `turn_end` that would have cleared them,
    // so without this a reconnect lands in a disabled composer + a dead permission
    // prompt. If the desktop turn is genuinely still live, its catch-up/live frames
    // re-establish `streaming` after the dial.
    clearSettleTimer();
    set((st) => ({
      ...terminalizeAllRunningTurns(st, TOOL_INTERRUPTED_ERROR, "error"),
      remoteUnlisten: null,
      remoteError: null,
      remoteVerified: false,
      remoteChatOpen: false,
      // A fresh dial clears any prior rejection so the pair UI starts clean (the
      // "rejected on the other device" notice must not linger across a re-pair).
      remoteRejected: false,
      remoteRejectReason: null,
      // A fresh dial inherits no live runs — reset the whole map and the mirror.
      runs: {},
      // ...and no live subagents; the desktop's live frames repopulate them.
      agents: {},
      // ...and no background tasks; the desktop's live frames repopulate them.
      backgroundTasks: {},
      // ...and no pagination cursors; the desktop's catch-up reseeds them per session.
      messagePaging: {},
      streaming: false,
      cancel: null,
      pendingPermission: null,
      composerPhase: "idle",
      activeTool: null,
    }));
    let unlistenFrame: (() => void) | null = null;
    let unlistenDrop: (() => void) | null = null;
    try {
      // `verified` doubles as the reconnect flag: a pre-verified dial is a
      // remembered-desktop reconnect, which binds an empty handshake prologue to
      // match the desktop's closed pairing window. A fresh (unverified) dial is a
      // first pairing and binds the QR nonce.
      const info = await ipc.phoneSyncConnect(qr, verified);
      // A disconnectRemote that landed mid-dial cleared remoteConnecting as an abort
      // sentinel. Honor it: bail BEFORE registering the frame/drop listeners (so no
      // orphaned subscription is ever created) and tear down the native session the
      // dial just opened, otherwise connectRemote's success set() would silently
      // override the user's explicit disconnect and resurrect a connection they ended.
      // (unlistenFrame/unlistenDrop are still null here — they're only created below —
      // so there is nothing to unsubscribe, just the native channel to close.)
      if (!get().remoteConnecting) {
        await ipc.phoneSyncDisconnect().catch(() => {});
        return;
      }
      // Subscribe only after a successful dial; route every frame through
      // get().applyFrame so the latest action closure folds against live state.
      unlistenFrame = await ipc.onPhoneSyncFrame((f) => get().applyFrame(f));
      // Detect an UNEXPECTED drop (desktop closed the channel / network dropped) so
      // the UI can leave the dead session and offer a reconnect. A user-initiated
      // disconnect tears this listener down first, so it can't misfire as a drop.
      unlistenDrop = await ipc.onPhoneSyncDisconnected(() => {
        const queued = pendingRemoteFirstMessage;
        clearPendingRemoteCreate();
        clearRemoteCancelTerminalTimer();
        // The turn is dead when the channel drops — clear turn state too, not just
        // connection flags, so neither the interim nor the reconnected session is
        // stuck on a stale `streaming`/`pendingPermission`.
        clearRemoteWatchdog();
        clearSettleTimer();
        set((st) => ({
          ...terminalizeAllRunningTurns(st, TOOL_INTERRUPTED_ERROR, "error"),
          remoteConnected: false,
          remoteVerified: false,
          remoteDropped: true,
          remoteChatOpen: false,
          creatingSession: false,
          drafts: queued ? { ...st.drafts, [queued.draftId]: queued.body } : st.drafts,
          // The channel is dead — every remote-driven run is gone.
          runs: {},
          // ...and pagination cursors are stale; the reconnect's catch-up reseeds them.
          messagePaging: {},
          streaming: false,
          cancel: null,
          pendingPermission: null,
          composerPhase: "idle",
          activeTool: null,
        }));
      });
      // Remember the desktop across launches (public payload — no secret).
      writeStr("pc.lastPairingQr", qr);
      set({
        remoteConnected: true,
        // A pin-matched reconnect is pre-verified (the native pin check
        // re-authenticated the same desktop key); a first dial never is.
        remoteVerified: verified,
        remoteSas: info.sas,
        // The STABLE pinned desktop key (distinct from the SAS verification code).
        // Durable storage pins this, never the SAS.
        remotePeerKey: info.peerPublicKey,
        // The desktop's Web Push VAPID key (or null when it sent none). The web
        // lifecycle reads this to drive the installed-PWA push subscription (§5.7).
        remoteVapidKey: info.vapidPublicKey ?? null,
        remoteError: null,
        remoteDropped: false,
        lastPairingQr: qr,
        remoteUnlisten: () => {
          unlistenFrame?.();
          unlistenDrop?.();
        },
      });
    } catch (err) {
      // A listener may have registered before a later step threw (e.g. the dial
      // succeeded but onPhoneSyncDisconnected rejected). Tear down any partial
      // subscription AND the native session so nothing leaks. phoneSyncDisconnect
      // is idempotent — a no-op when the dial itself failed.
      unlistenDrop?.();
      unlistenFrame?.();
      await ipc.phoneSyncDisconnect().catch(() => {});
      set({
        remoteConnected: false,
        remoteSas: null,
        remotePeerKey: null,
        remoteVapidKey: null,
        remoteUnlisten: null,
        remoteError: errMessage(err),
      });
    } finally {
      // Release the re-entry lock whether the dial succeeded or failed, so a later
      // connect can proceed.
      set({ remoteConnecting: false });
    }
  },

  clearRemoteError() {
    set({ remoteError: null });
  },

  async sendRemoteCommand(command) {
    // Optimistic echo for `run`: show the user's message immediately and, when
    // send() has already seeded a provisional run identity, create its assistant
    // row too. That row gives pre-turn_start terminal paths (watchdog/link drop) an
    // exact message to receipt. Authoritative turn_start reconciles the provisional
    // identity; message_delta catch-up later replaces the whole list.
    if (command.cmd === "run") {
      const { session_id, text } = command;
      const provisionalTurnId = get().runs[runKey(session_id)]?.turnId ?? undefined;
      const userMsg: Message = {
        id: uid(),
        role: "user",
        blocks: [{ kind: "text", text }],
        createdAt: now(),
        ...(provisionalTurnId ? { turnId: provisionalTurnId } : {}),
      };
      set((st) => {
        const run = st.runs[runKey(session_id)];
        const assistant: Message | null =
          run?.streaming && run.turnId
            ? {
                id: run.turnId,
                role: "assistant",
                blocks: [],
                createdAt: run.startedAt ?? now(),
                turnId: run.turnId,
              }
            : null;
        return {
          messages: {
            ...st.messages,
            [session_id]: [
              ...(st.messages[session_id] ?? []),
              userMsg,
              ...(assistant ? [assistant] : []),
            ],
          },
          transcriptScrollRequest: {
            id: uid(),
            sessionId: session_id,
            kind: "newTurn",
            targetMessageId: userMsg.id,
          },
        };
      });
    }
    // The channel often drops between frames (Android kills backgrounded apps).
    // Callers swallow the rejection (`void send`/`stop`), so a dropped link would
    // silently strand the optimistic message. Handle it here: annotate the message
    // and surface the existing reconnect UI via remoteDropped.
    try {
      await ipc.phoneSyncSendCommand(command);
    } catch {
      if (command.cmd === "run") {
        const sid = command.session_id;
        set((st) => ({
          messages: patchLast(st.messages, sid, (b) =>
            appendText(b, "\n\n**Couldn't reach your desktop — the link may have dropped.**"),
          ),
        }));
      }
      clearRemoteWatchdog(); // the turn can't proceed on a dropped link
      clearRemoteCancelTerminalTimer();
      clearSettleTimer();
      set((st) => ({
        ...terminalizeAllRunningTurns(st, TOOL_INTERRUPTED_ERROR, "error"),
        remoteDropped: true,
        runs: {},
        // Drop pagination cursors/loading guards too — a reconnect's catch-up reseeds
        // them; otherwise a `loading: true` left by an in-flight fetch_messages would
        // wedge pagination for the session.
        messagePaging: {},
        streaming: false,
        cancel: null,
        pendingPermission: null,
        composerPhase: "idle",
        activeTool: null,
      }));
    }
  },

  // Request the next older page of a session's history (scroll-up pagination).
  // Guards: only over a live remote link, only when there might be more history
  // (hasMore !== false), only one fetch in flight per session, and only when we
  // actually hold a row to page back from (an empty session has no cursor). Sets
  // the loading flag synchronously so a burst of scroll events can't fire duplicate
  // requests; the matching `message_page` frame clears it (and reconnect/drop reset
  // the whole `messagePaging` map). The page size is a fixed `PAGE_SIZE`.
  async loadOlderMessages(sessionId) {
    if (!get().remoteConnected) {
      const load = get().messageLoads[sessionId];
      if (!load || load.loadingOlder || load.nextCursor === null || load.phase === "loading")
        return;
      const cursor = load.nextCursor;
      set((st) => ({
        messageLoads: {
          ...st.messageLoads,
          [sessionId]: { ...load, loadingOlder: true, error: null },
        },
      }));
      try {
        const page = await ipc.getMessagePage(sessionId, cursor);
        set((st) => {
          const current = st.messageLoads[sessionId];
          // A refresh/reload superseded this cursor request.
          if (!current?.loadingOlder || current.nextCursor !== cursor) return {};
          return {
            messages: {
              ...st.messages,
              [sessionId]: mergePersistedPrefix(page.messages, st.messages[sessionId] ?? []),
            },
            messageLoads: {
              ...st.messageLoads,
              [sessionId]: {
                ...current,
                phase: "ready",
                nextCursor: page.nextCursor,
                loadingOlder: false,
                lastAccessedAt: now(),
                error: null,
              },
            },
          };
        });
      } catch (error) {
        set((st) => {
          const current = st.messageLoads[sessionId];
          if (!current?.loadingOlder || current.nextCursor !== cursor) return {};
          return {
            messageLoads: {
              ...st.messageLoads,
              [sessionId]: {
                ...current,
                phase: "error",
                loadingOlder: false,
                error: errMessage(error),
              },
            },
          };
        });
      }
      return;
    }
    const paging = get().messagePaging[sessionId];
    // Unknown (undefined) paging means catch-up hasn't seeded it yet — nothing to
    // page from. hasMore === false means we hold the very first message already.
    if (!paging || paging.loading || paging.hasMore === false) return;
    const beforeSeq = paging.oldestSeq;
    // Defensive: seq 0 is the first message, so there's nothing strictly before it.
    if (beforeSeq <= 0) {
      set((st) => ({
        messagePaging: {
          ...st.messagePaging,
          [sessionId]: { ...paging, hasMore: false },
        },
      }));
      return;
    }
    set((st) => ({
      messagePaging: { ...st.messagePaging, [sessionId]: { ...paging, loading: true } },
      messageLoads: {
        ...st.messageLoads,
        [sessionId]: {
          ...(st.messageLoads[sessionId] ?? idleMessageLoad()),
          loadingOlder: true,
        },
      },
    }));
    await get().sendRemoteCommand({
      cmd: "fetch_messages",
      session_id: sessionId,
      before_seq: beforeSeq,
      limit: PAGE_SIZE,
    });
  },

  async disconnectRemote() {
    const queued = pendingRemoteFirstMessage;
    clearPendingRemoteCreate();
    clearRemoteCancelTerminalTimer();
    clearRemoteWatchdog(); // user-initiated teardown — the turn is over
    clearSettleTimer();
    const unlisten = get().remoteUnlisten;
    // Flip the connection flags FIRST, before the async teardown. `remoteConnected`
    // is the routing source of truth for send/stop/resolvePermission, so clearing it
    // up front guarantees no command is dispatched onto the closing channel while
    // `phoneSyncDisconnect` is in flight.
    // User-initiated, so also clear the dropped flag and forget the pairing — the
    // reconnect prompt is for an unexpected drop, not an intentional teardown.
    set((st) => ({
      ...terminalizeAllRunningTurns(st, TOOL_INTERRUPTED_CANCELLED, "cancelled"),
      remoteConnected: false,
      remoteVerified: false,
      remoteSas: null,
      remotePeerKey: null,
      remoteVapidKey: null,
      remoteDropped: false,
      lastPairingQr: null,
      remoteUnlisten: null,
      // Doubles as an abort sentinel for an in-flight connectRemote dial: a dial that
      // resolves after this re-reads remoteConnecting, sees false, and bails before
      // registering its frame/drop listeners (instead of overriding this disconnect
      // and leaking the about-to-register subscriptions onto a torn-down channel).
      // connectRemote's own finally clears this in steady state, so this is a no-op
      // when no dial is in flight.
      remoteConnecting: false,
      remoteChatOpen: false,
      creatingSession: false,
      drafts: queued ? { ...st.drafts, [queued.draftId]: queued.body } : st.drafts,
      // The turn is over — don't strand a stuck composer; drop every run too.
      runs: {},
      // Pagination cursors belong to the torn-down session; clear them.
      messagePaging: {},
      streaming: false,
      cancel: null,
      pendingPermission: null,
      composerPhase: "idle",
      activeTool: null,
    }));
    writeStr("pc.lastPairingQr", null); // forget the remembered desktop too
    if (unlisten) unlisten();
    await ipc.phoneSyncDisconnect();
  },

  async reconnectRemote() {
    const qr = get().lastPairingQr;
    if (!qr) return;
    set({ remoteDropped: false });
    // Re-dial the remembered desktop, PRE-VERIFIED: the native pin check
    // re-authenticates the same static key the user already trusted at first
    // pairing, so no fresh SAS comparison is needed.
    await get().connectRemote(qr, true);
  },

  // Open a session from the remote list. Selection commits synchronously and its
  // run is projected immediately; transcript hydration continues independently.
  async openRemoteSession(id) {
    const selecting = get().selectSession(id);
    set({ remoteChatOpen: true });
    await selecting;
  },

  // Back out of the chat view to the remote sessions list. The connection stays
  // live — this is pure in-app navigation, not a disconnect.
  closeRemoteSession() {
    set({ remoteChatOpen: false });
  },

  // Forget the remembered desktop and clear the dropped/rejected flags so the UI
  // falls back to the fresh pairing screen ("Pair a different desktop" from the drop
  // screen, or "Pair again" from the rejected screen). The channel is already down
  // here, so there's nothing to tear down.
  forgetRemotePairing() {
    writeStr("pc.lastPairingQr", null);
    set({
      lastPairingQr: null,
      remotePeerKey: null,
      remoteVapidKey: null,
      remoteDropped: false,
      remoteRejected: false,
      remoteRejectReason: null,
    });
  },

  // Network presence, driven by the browser's online/offline events (see App).
  // Remote mode shows the offline screen while this is false.
  setOnline(v) {
    set({ online: v });
  },

  // Hydrate the remembered pairing QR from durable (IndexedDB) storage on a cold
  // launch, so `reconnectRemote()` (which reads `lastPairingQr`) can one-tap dial
  // even when the localStorage mirror was evicted. Only fills an EMPTY slot — never
  // clobbers a QR the store already has (the live/localStorage value wins).
  hydrateRememberedQr(qr) {
    if (!get().lastPairingQr) set({ lastPairingQr: qr });
  },

  // ── Auto-update ───────────────────────────────────────────────────────────────
  // Every action is defensive: the update commands are desktop-only, so on a
  // phone/web client (or an older core that doesn't register them) the invoke
  // rejects. We swallow into `error` rather than throw, so a missing command never
  // crashes the app or surfaces an unhandled rejection (callers use `void`).

  async checkForUpdate(options) {
    const background = options?.background === true;
    // A periodic poll must never erase a staged update or interrupt an active
    // download merely because the six-hour timer fired.
    if (background && (get().update.phase === "downloading" || get().update.phase === "ready")) {
      return;
    }
    try {
      const info = await ipc.checkForUpdate();
      if (!info) {
        // Already up to date — keep (or return to) the idle, banner-less state.
        set({ update: IDLE_UPDATE });
        return;
      }
      set((st) => ({ update: { ...st.update, info, error: null } }));
      // Auto-update on → fetch + stage immediately (the banner then narrates the
      // download). Off → just offer it and let the user press Install.
      if (get().settings.autoUpdate) {
        await get().startUpdateDownload();
      } else {
        set((st) => ({ update: { ...st.update, phase: "available", progress: null } }));
      }
    } catch (err) {
      const error = errMessage(err);
      set((st) => ({
        // Startup/periodic network failures belong in Settings, not in a global
        // workspace banner. Explicit checks still use the visible error phase.
        update: background ? { ...st.update, error } : { ...st.update, phase: "error", error },
      }));
    }
  },

  async startUpdateDownload() {
    set((st) => ({ update: { ...st.update, phase: "downloading", progress: 0, error: null } }));
    try {
      const staged = await ipc.downloadAndInstallUpdate();
      if (staged) {
        // Resolves once downloaded AND staged. The `updater://finished` event also
        // marks ready (whichever lands first); both converge on the same state.
        set((st) => ({ update: { ...st.update, phase: "ready", progress: 100 } }));
      } else {
        // No update available (already up to date) — return to idle.
        set({ update: IDLE_UPDATE });
      }
    } catch (err) {
      set((st) => ({ update: { ...st.update, phase: "error", error: errMessage(err) } }));
    }
  },

  // Internal setter for the `updater://progress` event: turn raw byte counts into a
  // 0–100 percent (null when the total is unknown → indeterminate bar).
  applyUpdateProgress(downloaded, total) {
    const progress = total ? Math.round((downloaded / total) * 100) : null;
    set((st) => ({ update: { ...st.update, progress } }));
  },

  // Called on the `updater://finished` event — the download is staged.
  markUpdateReady() {
    set((st) => ({ update: { ...st.update, phase: "ready", progress: 100 } }));
  },

  async relaunchForUpdate() {
    try {
      await ipc.relaunchApp();
      // On the desktop the process restarts, so this never returns; the catch only
      // matters on a host where the command is unavailable.
    } catch (err) {
      set((st) => ({ update: { ...st.update, phase: "error", error: errMessage(err) } }));
    }
  },

  async setAutoUpdate(enabled) {
    await get().updateSettings({ autoUpdate: enabled });
    // Guard: if the save didn't persist (updateSettings swallows into settingsError),
    // don't proceed with auto-download on a stale preference.
    if (get().settings.autoUpdate !== enabled) return;
    // Turning it on while an update is already waiting should start the download
    // now, matching the "auto" expectation (rather than leaving it parked).
    if (enabled && get().update.phase === "available") {
      await get().startUpdateDownload();
    }
  },

  async loadUpdateChannel() {
    try {
      set({ updateChannel: await ipc.getUpdateChannel() });
    } catch {
      // Command unavailable (non-desktop / older core) — keep the default channel.
    }
  },

  // Dismiss the banner ("Later"): drop back to idle but KEEP `info` so a later
  // re-check / relaunch still knows which version was staged.
  dismissUpdateBanner() {
    set((st) => ({ update: { ...IDLE_UPDATE, info: st.update.info } }));
  },
}));

// Restore the persisted interface scale once at store creation, so a reload picks
// up the user's last choice (the initial-state read above only seeds the value;
// this is what actually applies `zoom` to the document on a cold load).
applyUiScale(useStore.getState().uiScale);

function appendText(blocks: ContentBlock[], text: string): ContentBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "text") {
    return [...blocks.slice(0, -1), { kind: "text", text: last.text + text }];
  }
  return [...blocks, { kind: "text", text }];
}

function deriveTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 42 ? t.slice(0, 42) + "…" : t || "New chat";
}

async function reconcileSettingsSaveFailure(error: unknown): Promise<{
  message: string;
  authoritative: Settings | null;
}> {
  const failure = classifySettingsSaveFailure(error);
  if (!failure.reconcileAuthoritativeSettings) {
    return { message: failure.message, authoritative: null };
  }
  try {
    return { message: failure.message, authoritative: await ipc.getSettings() };
  } catch {
    // Keep the durability warning visible even if the follow-up read also fails.
    return { message: failure.message, authoritative: null };
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Account-scoped OpenAI failures are safe, actionable copy rather than raw
 * provider payloads, which can contain request/account identifiers. The account
 * attribution comes from display-safe local state on desktop and stable ordinals
 * on remote clients, whose protocol intentionally omits account metadata. */
function sessionScopedStreamError(
  state: Pick<AppState, "sessions" | "openAIAccounts" | "remoteMode">,
  sessionId: string,
  rawMessage: string,
): string {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (!session?.accountProfileId) return rawMessage;

  const account = state.openAIAccounts.find(
    (candidate) => candidate.id === session.accountProfileId,
  );
  const label = markdownLiteralText(
    (
      (state.remoteMode
        ? remoteAccountLabel(session.accountProfileId, state.sessions)
        : openAIAccountLabel(account, state.openAIAccounts)) ?? "ChatGPT account"
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80),
  );
  const quotaFailure = /(?:\b429\b|rate[\s_-]*limit|quota|allowance)/i.test(rawMessage);
  const httpFailure = /(?:\bhttp\s*[45]\d\d\b|\bstatus\s*[45]\d\d\b)/i.test(rawMessage);
  const authFailure = /(?:\b401\b|unauthori[sz]ed|authentication|credential|token expired)/i.test(
    rawMessage,
  );
  const safeNativeProviderFailure = /^(?:OpenAI\b|The OpenAI\b|ChatGPT\b)/i.test(
    rawMessage.trimStart(),
  );
  const detail = quotaFailure
    ? "ChatGPT rate limit or quota was reached."
    : authFailure
      ? "ChatGPT authentication failed. Reconnect this account before retrying."
      : httpFailure
        ? "ChatGPT provider request failed."
        : safeNativeProviderFailure
          ? rawMessage.trim()
          : null;
  // StreamEvent.Error also carries local lifecycle failures (for example, a
  // durable-turn database write). Those details are actionable and must not be
  // misattributed to the pinned provider merely because the session is OpenAI.
  if (!detail) return rawMessage;
  // The detail is generated here rather than derived from a potentially prefixed
  // provider payload, so account attribution is applied exactly once.
  return `${label}: ${detail}`;
}

/** Keep remote rejection copy bounded and readable even when talking to a newer,
 * older, or malformed peer. The desktop normally supplies already-scrubbed text;
 * these local fallbacks make an empty/unknown frame actionable instead of invisible. */
function remoteCommandRejectionMessage(code?: string, rawMessage?: string): string {
  const message = (rawMessage ?? "")
    // eslint-disable-next-line no-control-regex -- protocol text is untrusted and must be scrubbed.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 240);
  if (message) return message;
  switch (code) {
    case "open_ai_account_selection_required":
      return "Configure a default ChatGPT account on the desktop, then try again.";
    case "invalid_desktop_configuration":
      return "Review the desktop account and model settings, then try again.";
    case "desktop_unavailable":
      return "The desktop is unavailable. Reconnect and try again.";
    case "invalid_request":
      return "The desktop could not use this request. Try again.";
    default:
      return "The desktop rejected this command.";
  }
}

// Convert a desktop catch-up row (MessageRow: carries sessionId + seq) to the
// in-memory Message shape the UI renders.
function rowToMessage(r: MessageRow): Message {
  // Phone Sync can carry OpenAI's encrypted reasoning continuation block. It is
  // protocol state, never user-visible content, so strip it before Message UI.
  const blocks = r.content.filter(
    (block): block is ContentBlock => !("type" in block && block.type === "reasoning"),
  );
  return {
    id: r.id,
    role: r.role,
    blocks,
    createdAt: r.createdAt,
    ...(r.turnId ? { turnId: r.turnId } : {}),
    ...(r.receipt ? { receipt: r.receipt } : {}),
  };
}

// Prepend an OLDER page of catch-up rows ahead of the held messages, deduping by id
// (so a page that overlaps what we already hold can't double a message) and keeping
// the result in ascending order — the page is older, so it goes in front. Used by
// the `message_page` (scroll-up pagination) path; never replaces, only extends back.
/** Fold flat Phone Sync rows into the desktop's turn-shaped message view. */
function rowsToMessages(rows: MessageRow[]): Message[] {
  const out: Message[] = [];
  const turnAssistants = new Map<string, number>();
  const ensureTurnAssistant = (row: MessageRow): Message => {
    const turnId = row.turnId!;
    const existing = turnAssistants.get(turnId);
    if (existing !== undefined) {
      if (!out[existing].receipt && row.receipt) {
        out[existing] = { ...out[existing], receipt: row.receipt };
      }
      return out[existing];
    }
    const index = out.length;
    const assistant: Message = {
      id: turnId,
      role: "assistant",
      blocks: [],
      createdAt: row.receipt?.startedAt ?? row.createdAt,
      turnId,
      ...(row.receipt ? { receipt: row.receipt } : {}),
    };
    out.push(assistant);
    turnAssistants.set(turnId, index);
    return assistant;
  };

  for (const row of rows) {
    if (!row.turnId) {
      out.push(rowToMessage(row));
      continue;
    }
    const blocks = row.content.filter(
      (block): block is ContentBlock => !("type" in block && block.type === "reasoning"),
    );
    if (row.role === "assistant") {
      ensureTurnAssistant(row).blocks.push(...blocks);
      continue;
    }

    const texts = blocks.filter((block) => block.kind === "text");
    if (texts.length > 0) {
      out.push({
        id: row.id,
        role: "user",
        blocks: texts,
        createdAt: row.createdAt,
        turnId: row.turnId,
      });
    }
    const toolResults = blocks.filter((block) => block.kind === "tool_result");
    if (toolResults.length > 0 || row.receipt) {
      ensureTurnAssistant(row).blocks.push(...toolResults);
    }
  }
  return finalizeReceiptedTurns(out);
}

const finalizeReceiptedTurns = (messages: Message[]): Message[] =>
  messages.map((message) =>
    message.role === "assistant" && message.receipt
      ? { ...message, blocks: finalizePendingTools(message.blocks, TOOL_INTERRUPTED_ERROR) }
      : message,
  );

function prependMessages(existing: Message[], older: MessageRow[]): Message[] {
  if (older.length === 0) return existing;
  const merged = rowsToMessages(older);
  const heldIds = new Set(merged.map((message) => message.id));
  const turnIndices = new Map<string, number>();
  merged.forEach((message, index) => {
    if (message.role === "assistant" && message.turnId) turnIndices.set(message.turnId, index);
  });

  for (const message of existing) {
    const turnIndex =
      message.role === "assistant" && message.turnId ? turnIndices.get(message.turnId) : undefined;
    if (turnIndex !== undefined) {
      const olderTurn = merged[turnIndex];
      merged[turnIndex] = {
        ...olderTurn,
        blocks: [...olderTurn.blocks, ...message.blocks],
        createdAt: Math.min(olderTurn.createdAt, message.createdAt),
        ...(message.receipt
          ? { receipt: message.receipt }
          : olderTurn.receipt
            ? { receipt: olderTurn.receipt }
            : {}),
      };
      continue;
    }
    if (heldIds.has(message.id)) continue;
    heldIds.add(message.id);
    if (message.role === "assistant" && message.turnId) {
      turnIndices.set(message.turnId, merged.length);
    }
    merged.push(message);
  }
  return finalizeReceiptedTurns(merged);
}

// Apply fn to the LAST message of a session, immutably. No-op when the session
// has no messages yet — the guard for a stray delta arriving before turn_start.
function patchLast(
  messages: Record<string, Message[]>,
  sessionId: string,
  fn: (blocks: ContentBlock[]) => ContentBlock[],
): Record<string, Message[]> {
  const msgs = messages[sessionId];
  if (!msgs || msgs.length === 0) return messages;
  const i = msgs.length - 1;
  const last = msgs[i];
  const updated = [...msgs];
  updated[i] = { ...last, blocks: fn(last.blocks) };
  return { ...messages, [sessionId]: updated };
}

type RemoteSetter = (fn: (st: AppState) => Partial<AppState>) => void;

// Fold one live StreamEvent (forwarded from the paired desktop) into store state
// for `sessionId`. Mirrors `send`'s local onEvent, but the phone BUILDS the
// assistant message from turn_start rather than pre-creating it. Does NOT touch
// `cancel` (that handle belongs to a local desktop run).
//
// Per-session message patching is always applied (a background session must still
// build its history). Run state (`streaming`/`pendingPermission`) is written onto
// the FRAME'S session run via `runPatch`/`setRun`; the active-run MIRROR then
// surfaces it on the visible composer/HUD/permission gate only when that session
// is the one on screen. So a background session's turn updates its own run without
// flipping the visible composer or popping a prompt the user has no context for.
function applyRemoteEvent(set: RemoteSetter, sessionId: string, e: StreamEvent): void {
  // First real byte for the on-screen session settles the receipt into "thinking…"
  // and cancels the fallback timer — mirrors the local onEvent. Background-session
  // frames never touch the visible presence.
  const settleActivePresence = (): void => {
    const st = useStore.getState();
    if (st.runs[runKey(sessionId)]?.composerPhase === "received") {
      clearSettleTimer(sessionId);
      set((current) => runPatch(current, sessionId, { composerPhase: "thinking" }));
    }
  };
  const supersededTerminal = (receipt: TurnReceipt | undefined): boolean => {
    if (!receipt) return false;
    const st = useStore.getState();
    const current = st.runs[runKey(sessionId)];
    return Boolean(
      current?.turnId &&
      current.turnId !== receipt.turnId &&
      findTurnMessage(st.messages, sessionId, receipt.turnId),
    );
  };
  switch (e.type) {
    case "turn_start":
      set((st) => {
        const previous = st.runs[runKey(sessionId)] ?? EMPTY_RUN;
        const turnId = e.turnId ?? e.messageId;
        armRemoteWatchdog(sessionId, turnId);
        const startedAt = e.startedAt ?? previous.startedAt ?? now();
        let messages = reconcileTurnMessage(
          st.messages,
          sessionId,
          previous.turnId,
          turnId,
          e.messageId,
          startedAt,
        );
        if (!findTurnMessage(messages, sessionId, turnId)) {
          const assistant: Message = {
            id: e.messageId,
            role: "assistant",
            blocks: [],
            createdAt: startedAt,
            turnId,
          };
          messages = {
            ...messages,
            [sessionId]: [...(messages[sessionId] ?? []), assistant],
          };
        }
        return {
          // Mark this session's run streaming; the mirror surfaces it only when the
          // session is active (runPatch re-projects), so a background run is now
          // representable without flipping the visible composer.
          ...runPatch(st, sessionId, {
            streaming: true,
            turnId,
            startedAt,
            finalizing: false,
            agentDurationMs: null,
            phaseRevision: 0,
            receipt: null,
            outcome: null,
            composerPhase: previous.composerPhase === "received" ? "received" : "thinking",
            activeTool: null,
            unseenOutcome: null,
          }),
          messages,
          // Each turn's agents panel starts empty. The desktop clears it in send();
          // the phone has no local send() for the turn (the desktop drives it), so
          // turn_start — the per-turn boundary where the assistant bubble is created
          // — is the symmetric place to reset it, else finished subagents from prior
          // turns would accumulate in the panel for the whole connected session.
          agents: { ...st.agents, [sessionId]: [] },
        };
      });
      break;
    case "text_delta":
      settleActivePresence();
      set((st) => ({
        messages: patchTurnMessage(
          st.messages,
          sessionId,
          st.runs[runKey(sessionId)]?.turnId,
          (message) => ({ ...message, blocks: appendText(message.blocks, e.text) }),
        ),
      }));
      break;
    case "tool_use":
      settleActivePresence();
      // Surface the running tool on the VISIBLE composer only — a background
      // session's tool must not show on screen (mirrors the presence settle).
      set((st) => ({
        ...runPatch(st, sessionId, { activeTool: e.name }),
        messages: patchTurnMessage(
          st.messages,
          sessionId,
          st.runs[runKey(sessionId)]?.turnId,
          (message) => ({
            ...message,
            blocks: [
              ...message.blocks,
              { kind: "tool_use", id: e.id, name: e.name, input: e.input },
            ],
          }),
        ),
      }));
      break;
    case "tool_result":
      set((st) => {
        const turnId = st.runs[runKey(sessionId)]?.turnId;
        const messages = patchTurnMessage(st.messages, sessionId, turnId, (message) => ({
          ...message,
          blocks: [
            ...message.blocks,
            { kind: "tool_result", toolUseId: e.id, output: e.output, isError: e.isError },
          ],
        }));
        const turnBlocks = findTurnMessage(messages, sessionId, turnId)?.blocks ?? [];
        return {
          messages,
          ...runPatch(st, sessionId, { activeTool: latestPendingToolName(turnBlocks) }),
        };
      });
      break;
    case "permission_request":
      // Store the request on its session's run; the mirror only pops the prompt
      // when that session is active, so a background permission never hijacks the
      // visible gate (the user would otherwise answer it blind).
      setRun(set, sessionId, {
        pendingPermission: {
          id: e.id,
          tool: e.tool,
          risk: e.risk,
          summary: e.summary,
          input: e.input,
          diff: e.diff,
        },
      });
      break;
    case "usage":
      set((st) => {
        const cur = st.usage[sessionId] ?? { input: 0, output: 0 };
        return {
          usage: {
            ...st.usage,
            [sessionId]: {
              input: cur.input + e.inputTokens,
              output: cur.output + e.outputTokens,
            },
          },
        };
      });
      break;
    case "error": {
      const errorMessage = sessionScopedStreamError(useStore.getState(), sessionId, e.message);
      if (supersededTerminal(e.receipt)) {
        set((st) => ({
          messages: patchTerminalTurnMessage(
            st.messages,
            sessionId,
            e.receipt!.turnId,
            TOOL_INTERRUPTED_ERROR,
            e.receipt,
            `\n\n**Error:** ${errorMessage}`,
          ),
        }));
        break;
      }
      // A terminal frame for the active session ends the turn — stop the remote idle
      // watchdog (it self-clears on its next tick once streaming is false, but clear
      // it eagerly so it can't fire a spurious timeout in the meantime).
      clearRemoteWatchdog(sessionId);
      clearRemoteCancelTerminalTimer(sessionId);
      clearSettleTimer(sessionId);
      set((st) => ({
        ...terminalizeTurnState(
          st,
          sessionId,
          TOOL_INTERRUPTED_ERROR,
          e.receipt?.status ?? "error",
          e.receipt?.stopReason,
          e.receipt,
          `\n\n**Error:** ${errorMessage}`,
        ),
      }));
      break;
    }
    case "turn_end": {
      if (supersededTerminal(e.receipt)) {
        set((st) => ({
          messages: patchTerminalTurnMessage(
            st.messages,
            sessionId,
            e.receipt!.turnId,
            e.stopReason === "cancelled" ? TOOL_INTERRUPTED_CANCELLED : TOOL_INTERRUPTED_ERROR,
            e.receipt,
          ),
        }));
        break;
      }
      clearRemoteWatchdog(sessionId);
      clearRemoteCancelTerminalTimer(sessionId);
      clearSettleTimer(sessionId);
      set((st) => ({
        ...terminalizeTurnState(
          st,
          sessionId,
          e.stopReason === "cancelled" ? TOOL_INTERRUPTED_CANCELLED : TOOL_INTERRUPTED_ERROR,
          e.receipt?.status ?? (e.stopReason === "cancelled" ? "cancelled" : "completed"),
          e.stopReason,
          e.receipt,
        ),
      }));
      break;
    }
    case "agent_started":
    case "agent_progress":
    case "agent_finished":
      set((st) => ({ agents: applyAgentEvent(st.agents, sessionId, e) }));
      break;
    case "background_task_started":
    case "background_task_finished":
      // Background tasks ride the same per-session frame path. They outlive the
      // turn, so — unlike agents — they are never cleared on a turn boundary.
      set((st) => ({
        backgroundTasks: applyBackgroundEvent(st.backgroundTasks, sessionId, e),
      }));
      break;
  }
}
