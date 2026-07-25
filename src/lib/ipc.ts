// IPC bridge. Talks to the Rust core when running under Tauri; otherwise falls
// back to an in-browser mock so the UI is fully runnable via `vite` alone.

import type {
  AttachmentValidationResult,
  CodexActivityEvent,
  CodexRequestResponse,
  ConnectInfo,
  DirEntry,
  DraftEntry,
  GitChangedFile,
  GitFilePatch,
  GitReviewBranch,
  GitReviewManifest,
  GitReviewScope,
  Message,
  OpenAIAccountSummary,
  OpenAIAuthStatus,
  OpenAIModelCatalogRow,
  OpenAIReconnectOutcome,
  PairingPayload,
  PairingRequest,
  PlanUsageSnapshot,
  PhoneSyncStatus,
  RemoteCommand,
  SearchHit,
  Session,
  SessionArchiveWarning,
  SessionUsage,
  Settings,
  StreamEvent,
  SyncFrame,
  TurnReceipt,
  TurnReviewManifest,
  UpdateChannel,
  UpdateInfo,
  WorkspaceSummary,
} from "../types";
import { DEFAULT_SETTINGS, providerForModel } from "../types";
import {
  webOnPhoneSyncDisconnected,
  webOnPhoneSyncFrame,
  webPhoneSyncConnect,
  webPhoneSyncDisconnect,
  webPhoneSyncReject,
  webPhoneSyncSendCommand,
} from "./webSession";

export const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  // Tauri v2 injects this on the window object.
  "__TAURI_INTERNALS__" in window;

// Web-client mode. The Vercel-hosted PWA (the iOS web client) turns this on at
// startup via {@link setWebClientMode} after injecting the WASM-backed transport
// connector (see `webSession`/iroh-in-browser). When on, the Phone Sync CLIENT
// calls — connect / send / disconnect / frame + disconnect subscriptions — route
// through the real `webSession` transport instead of the inert browser mock.
//
// Off by default, so the desktop preview (`vite` alone) keeps using the mock and
// every existing call site is unchanged. `isTauri()` always takes precedence: a
// native build uses the Tauri bridge regardless of this flag.
let webClientEnabled = false;

/** Enable/disable web-client mode (called once by the PWA entry). */
export function setWebClientMode(on: boolean): void {
  webClientEnabled = on;
}

/** True when the PWA web-client mode flag is on (set by the PWA entry). Unlike
 *  {@link webClientActive} this does NOT factor in Tauri — it is the raw flag, so
 *  the React tree can ask "are we the web client?" to gate web-only UI (the iOS
 *  install gate) without coupling to the transport-routing predicate. */
export function isWebClientMode(): boolean {
  return webClientEnabled;
}

/** True only when we should route Phone Sync client calls to the WASM transport:
 *  web-client mode is on AND we're not under Tauri. */
const webClientActive = (): boolean => webClientEnabled && !isTauri();

type Unlisten = () => void;

type QaValidationInterceptor = (
  paths: string[],
  validateNative: (paths: string[]) => Promise<AttachmentValidationResult>,
) => Promise<AttachmentValidationResult>;

let qaValidationInterceptor: QaValidationInterceptor | null = null;

type QaAgentInterceptor = (
  sessionId: string,
  text: string,
  onEvent: (event: StreamEvent) => void,
  attachmentPaths: string[],
  attachmentDisplayNames: string[],
) => Promise<AgentRunHandle>;

let qaAgentInterceptor: QaAgentInterceptor | null = null;

export function installQaValidationInterceptor(interceptor: QaValidationInterceptor): void {
  qaValidationInterceptor = interceptor;
}

export function installQaAgentInterceptor(interceptor: QaAgentInterceptor): void {
  qaAgentInterceptor = interceptor;
}

/** Lazily import the Tauri API only when actually running under Tauri. */
async function tauri() {
  const core = await import("@tauri-apps/api/core");
  const event = await import("@tauri-apps/api/event");
  return { core, event };
}

// ── Commands ────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<Settings> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<Settings>("get_settings");
  }
  return mock.getSettings();
}

function codexSettingsPatch(settings: Partial<Settings>): Partial<Settings> {
  const patch = { ...settings };
  if (patch.provider === "anthropic") patch.provider = "openai";
  if (patch.model && providerForModel(patch.model) !== "openai") {
    patch.model = DEFAULT_SETTINGS.model;
    patch.provider = "openai";
  }
  return patch;
}

export async function saveSettings(s: Partial<Settings>): Promise<Settings> {
  const settings = codexSettingsPatch(s);
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<Settings>("save_settings", { settings });
  }
  return mock.saveSettings(settings);
}

// ── Codex authentication + live model catalogue ─────────────────────────────

/** Runtime allowlist for the only ChatGPT account fields permitted to cross into
 * React state. TypeScript annotations do not erase accidental native/mock extras,
 * so clone explicitly at this boundary instead of retaining the returned object. */
function publicOpenAIAccountSummary(account: OpenAIAccountSummary): OpenAIAccountSummary {
  return {
    id: account.id,
    accountLabel: account.accountLabel,
    tier: account.tier,
    expiresAt: account.expiresAt,
    state: account.state,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastUsedAt: account.lastUsedAt,
  };
}

function publicOpenAIReconnectOutcome(outcome: OpenAIReconnectOutcome): OpenAIReconnectOutcome {
  return outcome.status === "reconnected"
    ? { status: "reconnected", account: publicOpenAIAccountSummary(outcome.account) }
    : { status: "identity_mismatch", message: outcome.message };
}

export async function openaiOauthStatus(): Promise<OpenAIAuthStatus> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<OpenAIAuthStatus>("openai_oauth_status");
  }
  return mock.openaiOauthStatus();
}

/** Authenticate the same bundled Codex engine with an OpenAI Platform API key.
 * The key is handed directly to native app-server login and is never stored in
 * frontend state. */
export async function loginCodexApiKey(apiKey: string): Promise<OpenAIAuthStatus> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<OpenAIAuthStatus>("codex_login_api_key", { apiKey });
  }
  return mock.loginCodexApiKey(apiKey);
}

/** @deprecated Use {@link loginCodexApiKey}. Kept as a source-compatible alias
 * so an older frontend cannot route a Platform key around the Codex engine. */
export async function setApiKey(key: string): Promise<void> {
  await loginCodexApiKey(key);
}

/** Display-safe summaries for every locally stored ChatGPT credential profile. */
export async function listOpenAIAccounts(): Promise<OpenAIAccountSummary[]> {
  const accounts = isTauri()
    ? await (await tauri()).core.invoke<OpenAIAccountSummary[]>("list_openai_accounts")
    : await mock.listOpenAIAccounts();
  return accounts.map(publicOpenAIAccountSummary);
}

/** Start a globally serialized browser login and add/deduplicate one profile. */
export async function startOpenAIAccountLogin(): Promise<OpenAIAccountSummary> {
  const account = isTauri()
    ? await (await tauri()).core.invoke<OpenAIAccountSummary>("start_openai_account_login")
    : await mock.startOpenAIAccountLogin();
  return publicOpenAIAccountSummary(account);
}

export async function reconnectOpenAIAccount(
  accountProfileId: string,
): Promise<OpenAIReconnectOutcome> {
  const outcome = isTauri()
    ? await (
        await tauri()
      ).core.invoke<OpenAIReconnectOutcome>("reconnect_openai_account", {
        accountProfileId,
      })
    : await mock.reconnectOpenAIAccount(accountProfileId);
  return publicOpenAIReconnectOutcome(outcome);
}

export async function removeOpenAIAccount(accountProfileId: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("remove_openai_account", { accountProfileId });
    return;
  }
  return mock.removeOpenAIAccount(accountProfileId);
}

export async function openaiModels(accountProfileId: string): Promise<OpenAIModelCatalogRow[]> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<OpenAIModelCatalogRow[]>("openai_models", { accountProfileId });
  }
  return mock.openaiModels(accountProfileId);
}

/** Live quota windows for the bundled Codex engine's active OpenAI credential. */
export async function getPlanUsage(
  provider: "openai",
  accountProfileId?: string | null,
): Promise<PlanUsageSnapshot> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<PlanUsageSnapshot>("get_plan_usage", {
      provider,
      accountProfileId: accountProfileId ?? null,
    });
  }
  return mock.getPlanUsage(provider, accountProfileId);
}

// ── Auto-update (desktop only) ─────────────────────────────────────────────────
// All four commands are desktop-only — they don't exist on the phone/web client.
// The mock keeps them inert (no update offered) so the browser preview never pops a
// spurious banner, and a missing command on a non-desktop host is a harmless no-op.

/** Check the release feed for a newer build. Resolves the {@link UpdateInfo} when
 *  one is available, or null when the running build is already the latest. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<UpdateInfo | null>("update_check");
  }
  return mock.checkForUpdate();
}

/** Download AND stage the pending update for install. Emits `updater://progress`
 *  while downloading and `updater://finished` once staged; resolves `true` when
 *  an update was downloaded and staged (awaiting a relaunch), or `false` when
 *  there was no update to install (already up to date). */
export async function downloadAndInstallUpdate(): Promise<boolean> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<boolean>("update_download_and_install");
  }
  return mock.downloadAndInstallUpdate();
}

/** Relaunch the process to apply a staged update. The process restarts, so this
 *  promise effectively never resolves on the desktop. */
export async function relaunchApp(): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("update_relaunch");
    return;
  }
  return mock.relaunchApp();
}

/** Which release feed this build follows (always `stable`). */
export async function getUpdateChannel(): Promise<UpdateChannel> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<UpdateChannel>("update_channel");
  }
  return mock.getUpdateChannel();
}

/** Payload of the `updater://progress` event: bytes downloaded so far and the
 *  total (null while the server hasn't reported a content length). */
export interface UpdaterProgress {
  downloaded: number;
  total: number | null;
}

/** Subscribe to the updater's progress + finished events (desktop only). The
 *  handler is called with `{ kind: "progress", ... }` for each chunk and once with
 *  `{ kind: "finished" }` when the download is staged. Returns an unlisten cleanup
 *  fn; in the browser/non-Tauri host it's an inert no-op. */
export async function onUpdaterEvent(
  handler: (
    e: { kind: "progress"; downloaded: number; total: number | null } | { kind: "finished" },
  ) => void,
): Promise<Unlisten> {
  if (isTauri()) {
    const { event } = await tauri();
    const offProgress = await event.listen<UpdaterProgress>("updater://progress", (ev) =>
      handler({ kind: "progress", downloaded: ev.payload.downloaded, total: ev.payload.total }),
    );
    const offFinished = await event.listen<null>("updater://finished", () =>
      handler({ kind: "finished" }),
    );
    return () => {
      offProgress();
      offFinished();
    };
  }
  return mock.onUpdaterEvent(handler);
}

// ── Phone Sync ────────────────────────────────────────────────────────────────

export async function phoneSyncStatus(): Promise<PhoneSyncStatus> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<PhoneSyncStatus>("phone_sync_status");
  }
  return mock.phoneSyncStatus();
}

export async function phoneSyncBeginPairing(): Promise<PairingPayload> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<PairingPayload>("phone_sync_begin_pairing");
  }
  return mock.phoneSyncBeginPairing();
}

export async function phoneSyncUnpair(publicKey: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("phone_sync_unpair", { publicKey });
    return;
  }
  return mock.phoneSyncUnpair(publicKey);
}

/** Subscribe to the desktop-side "a new phone wants to pair" event. The handler
 *  receives the request id + the SAS to compare; the desktop user confirms or
 *  rejects via {@link confirmPairing} / {@link rejectPairing}. Returns an unlisten
 *  handle. Desktop-only event; in the browser mock it never fires. */
export async function onPhoneSyncPairingRequest(
  cb: (req: PairingRequest) => void,
): Promise<Unlisten> {
  if (isTauri()) {
    const { event } = await tauri();
    return event.listen<PairingRequest>("phone-sync://pairing-request", (ev) => cb(ev.payload));
  }
  return mock.onPhoneSyncPairingRequest(cb);
}

/** Confirm a pending new-device pairing (the desktop user compared the SAS and
 *  accepted). Persists the device as trusted and lets the connection proceed. */
export async function confirmPairing(requestId: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("confirm_pairing", { requestId });
    return;
  }
  return mock.confirmPairing(requestId);
}

/** Reject a pending new-device pairing (SAS mismatch or declined). Drops the
 *  connection without serving it. */
export async function rejectPairing(requestId: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("reject_pairing", { requestId });
    return;
  }
  return mock.rejectPairing(requestId);
}

// ── Phone Sync — mobile CLIENT (the phone drives a paired desktop) ─────────────

/** Dial + pair with a desktop from its scanned QR payload (JSON). Returns the SAS
 *  to compare out-of-band plus the pinned desktop key. `reconnect` selects the
 *  handshake prologue: `false` (a first pairing) binds the QR nonce; `true` (a
 *  remembered-desktop reconnect) binds an empty prologue to match the desktop's
 *  closed pairing window. */
export async function phoneSyncConnect(qr: string, reconnect = false): Promise<ConnectInfo> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<ConnectInfo>("phone_sync_connect", { qr, reconnect });
  }
  if (webClientActive()) return webPhoneSyncConnect(qr, reconnect);
  return mock.phoneSyncConnect(qr, reconnect);
}

/** Send one command to the live desktop session. */
export async function phoneSyncSendCommand(command: RemoteCommand): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("phone_sync_send_command", { command });
    return;
  }
  if (webClientActive()) return webPhoneSyncSendCommand(command);
  return mock.phoneSyncSendCommand(command);
}

/** Tear down the live desktop session. Idempotent. */
export async function phoneSyncDisconnect(): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("phone_sync_disconnect");
    return;
  }
  if (webClientActive()) return webPhoneSyncDisconnect();
  return mock.phoneSyncDisconnect();
}

/**
 * Decline the pairing from the phone: send a `pairing_reject` frame to the desktop
 * (so it learns the SAS was rejected, not merely that the link dropped), then tear
 * the session down. Idempotent.
 *
 * In web-client mode this routes to the wasm transport's `reject` (the carrier of
 * the new `pairing_reject` frame). On native (Tauri) the reject-frame protocol is a
 * web/wasm concern, so we fall back to the existing `phone_sync_disconnect` command,
 * which safely closes the channel.
 */
export async function phoneSyncReject(): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("phone_sync_disconnect");
    return;
  }
  if (webClientActive()) return webPhoneSyncReject();
  return mock.phoneSyncDisconnect();
}

/** Subscribe to frames forwarded from the paired desktop (live events + catch-up).
 *  Returns an unlisten handle. */
export async function onPhoneSyncFrame(cb: (frame: SyncFrame) => void): Promise<Unlisten> {
  if (isTauri()) {
    const { event } = await tauri();
    return event.listen<SyncFrame>("phone-sync://frame", (ev) => cb(ev.payload));
  }
  if (webClientActive()) return webOnPhoneSyncFrame(cb);
  return mock.onPhoneSyncFrame(cb);
}

/** Subscribe to the "session dropped unexpectedly" signal from the native client
 *  (the desktop closed the channel, or the network dropped). Returns an unlisten
 *  handle. */
export async function onPhoneSyncDisconnected(cb: () => void): Promise<Unlisten> {
  if (isTauri()) {
    const { event } = await tauri();
    return event.listen("phone-sync://disconnected", () => cb());
  }
  if (webClientActive()) return webOnPhoneSyncDisconnected(cb);
  return mock.onPhoneSyncDisconnected(cb);
}

export async function resolvePermission(
  id: string,
  decision: "allow" | "deny",
  forSession = false,
): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("resolve_permission", { id, decision, forSession });
    return;
  }
  return mock.resolvePermission(id, decision, forSession);
}

/** Answer a structured Codex app-server request. Unlike permission approvals,
 * the response envelope is method-specific and is forwarded without reshaping. */
export async function resolveCodexRequest(
  id: string,
  response: CodexRequestResponse,
): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("resolve_codex_request", { id, response });
    return;
  }
  return mock.resolveCodexRequest(id, response);
}

// ── Crash reporting consent (mirror to the Rust host) ─────────────────────────

/** Tell the Rust host the user's crash-reporting consent changed. Desktop-only on
 *  the core side; the command is absent on mobile and on DSN-less dev builds it's a
 *  no-op, so callers should swallow errors (the host gate stays the source of
 *  truth). No browser-mock fallback: in `vite`/preview there is no Rust host to
 *  inform, and the frontend SDK is driven separately by `lib/telemetry`. */
export async function setTelemetryConsent(enabled: boolean): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("telemetry_set_consent", { enabled });
  }
}

// ── sessions / history ────────────────────────────────────────────────────────

export async function listSessions(): Promise<Session[]> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<Session[]>("list_sessions");
  }
  return mock.listSessions();
}

export async function createSession(
  id: string,
  title?: string,
  workspace?: string | null,
  model?: string,
  accountProfileId?: string | null,
): Promise<Session> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<Session>("create_session", {
      id,
      title,
      workspace,
      model,
      accountProfileId: accountProfileId ?? null,
    });
  }
  return mock.createSession(id, title, workspace, model, accountProfileId);
}

/** Select a session's ChatGPT account. Native code allows replacement only
 * before the first durable turn and commits any compatible model fallback with it. */
export async function pinSessionOpenAIAccount(
  sessionId: string,
  accountProfileId: string,
  model?: string,
): Promise<Session> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<Session>("pin_session_openai_account", {
      sessionId,
      accountProfileId,
      model: model ?? null,
    });
  }
  return mock.pinSessionOpenAIAccount(sessionId, accountProfileId, model);
}

export async function renameSession(id: string, title: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("rename_session", { id, title });
  }
}

/** Persist the model selected for one existing conversation. */
export async function updateSessionModel(id: string, model: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("update_session_model", { id, model });
  }
}

export async function deleteSession(id: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("delete_session", { id });
  }
}

/**
 * Inspect the persisted workspace for one session before archiving it. `null`
 * means there is no uncommitted Git work to warn about. Native failures reject
 * so the UI fails closed instead of archiving when cleanliness is unknown.
 */
export async function getSessionArchiveWarning(
  sessionId: string,
): Promise<SessionArchiveWarning | null> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<SessionArchiveWarning | null>("get_session_archive_warning", {
      sessionId,
    });
  }
  return null;
}

export async function getMessages(sessionId: string): Promise<Message[]> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<Message[]>("get_messages", { sessionId });
  }
  return [];
}

/** Read the newest durable raw app-server activity for one Portcode session.
 * Browser/phone shells never receive this desktop-private diagnostic stream. */
export async function getCodexActivity(
  sessionId: string,
  limit = 500,
): Promise<CodexActivityEvent[]> {
  if (!isTauri()) return [];
  const { core } = await tauri();
  return core.invoke<CodexActivityEvent[]>("get_codex_activity", { sessionId, limit });
}

/** Load one display-ready page of persisted history. Cursor null/undefined loads
 * the newest page; a returned nextCursor walks toward older messages. */
export async function getMessagePage(
  sessionId: string,
  cursor?: string | null,
): Promise<import("../types").UiMessagePage> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<import("../types").UiMessagePage>("get_message_page", {
      sessionId,
      cursor: cursor ?? null,
    });
  }
  return { messages: [], nextCursor: null };
}

// ── composer drafts (open-loop persistence) ───────────────────────────────────
//
// The DURABLE store. Under Tauri these reach the SQLite `drafts` table; outside
// Tauri (web client / vite preview) the desktop DB doesn't exist, so — exactly
// like listSessions/getMessages — they no-op / return empty and the store's
// optimistic localStorage mirror IS the web-mode persistence. So a command added
// only on the Rust side can't break the browser build.

/** Persist (or clear, when blank) a session's unsent draft. Debounced by the store. */
export async function saveDraft(sessionId: string, text: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("save_draft", { sessionId, text });
  }
}

/** The durably-stored draft for a session, or null when none / not under Tauri. */
export async function getDraft(sessionId: string): Promise<string | null> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<string | null>("get_draft", { sessionId });
  }
  return null;
}

/** Every durably-stored draft — the authoritative startup hydration for the
 *  per-session draft map. Empty outside Tauri (the localStorage mirror restores). */
export async function getDrafts(): Promise<DraftEntry[]> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<DraftEntry[]>("get_drafts");
  }
  return [];
}

// ── usage (cumulative per-session token spend) ────────────────────────────────

/** Cumulative usage for one session (zeros when none / not under Tauri). */
export async function getUsage(sessionId: string): Promise<SessionUsage> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<SessionUsage>("get_usage", { sessionId });
  }
  return { sessionId, input: 0, output: 0 };
}

/** Every session's cumulative usage — restores per-session meters and the
 *  workspace-total spend across a restart. Empty outside Tauri. */
export async function getAllUsage(): Promise<SessionUsage[]> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<SessionUsage[]>("get_all_usage");
  }
  return [];
}

// ── message search (⌘K jump to a past turn) ───────────────────────────────────

/** Search message text across sessions (newest first), via the SQLite-backed
 *  `search_messages`. Empty outside Tauri — the store falls back to an in-memory
 *  search over loaded messages so ⌘K still works in web/preview mode. */
export async function searchMessages(query: string): Promise<SearchHit[]> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<SearchHit[]>("search_messages", { query });
  }
  return [];
}

// ── workspace / files ─────────────────────────────────────────────────────────

/** Read-only Git/workspace facts for the directory native agent runs currently use. */
export async function getWorkspaceSummary(): Promise<WorkspaceSummary> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<WorkspaceSummary>("get_workspace_summary");
  }
  return mock.getWorkspaceSummary();
}

/** Read-only, workspace-scoped Git manifest. The repository root is native-owned. */
export async function getGitReviewManifest(scope: GitReviewScope): Promise<GitReviewManifest> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<GitReviewManifest>("get_git_review_manifest", { scope });
  }
  return mock.getGitReviewManifest(scope);
}

/** Branches from the repository that owns the native settings workspace. */
export async function getGitReviewBranches(): Promise<GitReviewBranch[]> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<GitReviewBranch[]>("get_git_review_branches");
  }
  return mock.getGitReviewBranches();
}

/** Lazily load one typed patch, guarded by the manifest snapshot id. */
export async function getGitReviewFile(
  scope: GitReviewScope,
  snapshotId: string,
  path: string,
): Promise<GitFilePatch> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<GitFilePatch>("get_git_review_file", { scope, snapshotId, path });
  }
  return mock.getGitReviewFile(scope, snapshotId, path);
}

/** Load the durable changed-file manifest captured for one completed turn. */
export async function getTurnReviewManifest(turnId: string): Promise<TurnReviewManifest> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<TurnReviewManifest>("get_turn_review_manifest", { turnId });
  }
  return mock.getTurnReviewManifest(turnId);
}

/** Load a historical patch for one file from a turn receipt, when retained. */
export async function getTurnReviewFile(turnId: string, path: string): Promise<GitFilePatch> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<GitFilePatch>("get_turn_review_file", { turnId, path });
  }
  return mock.getTurnReviewFile(turnId, path);
}

export async function listDir(sub?: string): Promise<DirEntry[]> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<DirEntry[]>("list_dir", { sub });
  }
  return mock.listDir(sub);
}

/** Open a native folder picker. Returns the chosen absolute path, or null. */
export async function openFolder(): Promise<string | null> {
  if (isTauri()) {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const res = await dialog.open({ directory: true, multiple: false });
    return typeof res === "string" ? res : null;
  }
  return "C:/dev/porthex/portcode"; // preview mock
}

const ATTACHMENT_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "rst",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "xml",
  "csv",
  "tsv",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "cs",
  "rb",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "sql",
  "graphql",
  "gql",
  "proto",
  "ini",
  "cfg",
  "conf",
  "env",
  "log",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
];

/** Open the desktop's native multi-file picker. Native validation still decides
 * what is accepted; the filter only makes supported choices easier to find. */
export async function pickAttachmentPaths(): Promise<string[]> {
  if (!isTauri()) return [];
  const dialog = await import("@tauri-apps/plugin-dialog");
  const result = await dialog.open({
    directory: false,
    multiple: true,
    filters: [{ name: "Text, code, and images", extensions: ATTACHMENT_EXTENSIONS }],
  });
  if (Array.isArray(result))
    return result.filter((path): path is string => typeof path === "string");
  return typeof result === "string" ? [result] : [];
}

export type NativeFileDropEvent =
  | { type: "enter"; paths: string[]; x: number; y: number }
  | { type: "over"; x: number; y: number }
  | { type: "drop"; paths: string[]; x: number; y: number }
  | { type: "leave" };

/** Subscribe to Tauri's OS-level file-drop stream. Tauri reports physical
 * pixels, while DOM hit-testing uses logical CSS pixels, so normalize once at
 * this boundary before a component compares the pointer with its client rect. */
export async function onNativeFileDrop(
  handler: (event: NativeFileDropEvent) => void,
): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  const [{ getCurrentWebview }, { getCurrentWindow }] = await Promise.all([
    import("@tauri-apps/api/webview"),
    import("@tauri-apps/api/window"),
  ]);
  const scaleFactor = await getCurrentWindow().scaleFactor();
  return getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "leave") {
      handler({ type: "leave" });
      return;
    }
    const position = payload.position.toLogical(scaleFactor);
    if (payload.type === "enter" || payload.type === "drop") {
      handler({
        type: payload.type,
        paths: payload.paths,
        x: position.x,
        y: position.y,
      });
      return;
    }
    handler({ type: "over", x: position.x, y: position.y });
  });
}

/** Canonicalize, deduplicate, read-check, and limit local files in Rust. */
export async function validateAttachments(paths: string[]): Promise<AttachmentValidationResult> {
  if (__PORTCODE_QA_CONTROLS__) {
    if (!qaValidationInterceptor) throw new Error("QA validation controls are not installed");
    return qaValidationInterceptor(paths, validateAttachmentsNative);
  }
  return validateAttachmentsNative(paths);
}

async function validateAttachmentsNative(paths: string[]): Promise<AttachmentValidationResult> {
  if (!isTauri()) {
    return {
      attachments: [],
      errors: paths.map((path) => ({
        name: path.split(/[\\/]/).pop() || "Selected file",
        message: "Local attachments are available only in the Portcode desktop app.",
      })),
    };
  }
  const { core } = await tauri();
  return core.invoke<AttachmentValidationResult>("validate_attachments", { paths });
}

/**
 * A handle to a single running agent turn.
 *
 * `dispose()` stops listening for this turn's events WITHOUT cancelling the run —
 * call it the instant a turn reaches a terminal state (turn_end/error) so the
 * per-turn listener can't leak. A leaked listener keeps folding the NEXT turn's
 * deltas into this turn's message (the "second reply edits the first" bug).
 *
 * `cancel()` tells the Rust core to abort an in-flight turn but keeps listening:
 * native emits the authoritative receipt after cancellation. The owner calls
 * `dispose()` after that terminal event or a bounded grace timeout.
 */
export interface AgentRunHandle {
  cancel: () => Promise<void>;
  dispose: () => void;
}

/**
 * Send a user message and stream the agent run. Returns a handle to stop the run
 * (`cancel`) or just stop listening on a normal end (`dispose`). Events arrive
 * via `onEvent`.
 */
export async function runAgent(
  sessionId: string,
  text: string,
  onEvent: (e: StreamEvent) => void,
  attachmentPaths: string[] = [],
  attachmentDisplayNames: string[] = [],
): Promise<AgentRunHandle> {
  if (__PORTCODE_QA_CONTROLS__) {
    if (!qaAgentInterceptor) throw new Error("QA agent controls are not installed");
    return qaAgentInterceptor(sessionId, text, onEvent, attachmentPaths, attachmentDisplayNames);
  }
  if (isTauri()) {
    const { core, event } = await tauri();
    const channel = `agent://${sessionId}`;
    const unlisten: Unlisten = await event.listen<StreamEvent>(channel, (ev) =>
      onEvent(ev.payload),
    );
    try {
      await core.invoke("run_agent", { sessionId, text, attachmentPaths, attachmentDisplayNames });
    } catch (error) {
      // Listener installation precedes the invoke so no first event is missed. If
      // reservation/invocation is rejected, tear it back down immediately.
      unlisten();
      throw error;
    }
    return {
      // cancel_agent acknowledges the abort request before the native turn has
      // captured/emitted its terminal receipt. The store owns bounded disposal.
      cancel: async () => core.invoke("cancel_agent", { sessionId }),
      dispose: unlisten,
    };
  }
  return mock.runAgent(sessionId, text, onEvent);
}

/**
 * Subscribe to a session's agent channel PERSISTENTLY — across turns — for the
 * background-task lifecycle events (`background_task_started` /
 * `background_task_finished`) that can land after the launching turn's per-turn
 * listener was torn down. Returns an unlisten handle. The handler receives every
 * event on the channel; the caller filters to the background events it cares about
 * (the per-turn listener owns the turn's own deltas). Inert in the browser mock —
 * the preview launches no real background tasks.
 */
export async function subscribeSessionEvents(
  sessionId: string,
  onEvent: (e: StreamEvent) => void,
): Promise<Unlisten> {
  if (isTauri()) {
    const { event } = await tauri();
    return event.listen<StreamEvent>(`agent://${sessionId}`, (ev) => onEvent(ev.payload));
  }
  return mock.subscribeSessionEvents();
}

/** Stop ONE subagent (and its descendants) by id, leaving the rest of the turn
 *  running. Mirrors `cancel_agent`, but targets the live agents registry. A no-op
 *  in the browser mock (no real subagents run there). */
export async function cancelAgentById(agentId: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("cancel_agent_by_id", { agentId });
  }
}

// ── Browser mock ──────────────────────────────────────────────────────────────
// A deterministic fake agent so the UI is alive without the Rust core.

const PREVIEW_REVIEW_FILES: GitChangedFile[] = [
  {
    path: "src/App.tsx",
    oldPath: null,
    status: "modified",
    areas: ["staged", "unstaged"],
    additions: 12,
    deletions: 3,
    binary: false,
  },
  {
    path: "src/components/ReviewWorkspace.tsx",
    oldPath: null,
    status: "added",
    areas: ["untracked"],
    additions: 84,
    deletions: 0,
    binary: false,
  },
  {
    path: "README.md",
    oldPath: null,
    status: "modified",
    areas: ["staged"],
    additions: 6,
    deletions: 1,
    binary: false,
  },
  {
    path: "assets/reviewer.png",
    oldPath: null,
    status: "modified",
    areas: ["unstaged"],
    additions: null,
    deletions: null,
    binary: true,
  },
];

const PREVIEW_REVIEW_BRANCHES: GitReviewBranch[] = [
  { name: "main", revision: "refs/heads/main", kind: "local", current: true },
  { name: "release", revision: "refs/heads/release", kind: "local", current: false },
  {
    name: "origin/main",
    revision: "refs/remotes/origin/main",
    kind: "remote",
    current: false,
  },
];

function previewReviewManifest(scope: GitReviewScope): GitReviewManifest {
  let files: GitChangedFile[];
  let baseLabel: string;
  let targetLabel: string;
  if (scope.kind === "staged") {
    files = PREVIEW_REVIEW_FILES.filter((file) => file.areas.includes("staged")).map((file) => ({
      ...file,
      areas: ["staged"],
    }));
    baseLabel = "9c31f2ab";
    targetLabel = "Index";
  } else if (scope.kind === "unstaged") {
    files = PREVIEW_REVIEW_FILES.filter(
      (file) => file.areas.includes("unstaged") || file.areas.includes("untracked"),
    ).map((file) => ({
      ...file,
      areas: file.areas.includes("untracked") ? ["untracked"] : ["unstaged"],
    }));
    baseLabel = "Index";
    targetLabel = "Working tree";
  } else if (scope.kind === "branch") {
    files = PREVIEW_REVIEW_FILES.slice(0, 2).map((file) => ({
      ...file,
      areas: ["committed"],
    }));
    baseLabel = `merge-base(${scope.base.replace(/^refs\/(?:heads|remotes)\//, "")}) · 17a19ee0`;
    targetLabel = "HEAD";
  } else if (scope.kind === "commit") {
    files = PREVIEW_REVIEW_FILES.slice(0, 2).map((file) => ({
      ...file,
      areas: ["committed"],
    }));
    baseLabel = "parent of 9c31f2ab";
    targetLabel = scope.revision;
  } else {
    files = PREVIEW_REVIEW_FILES.map((file) => ({ ...file, areas: [...file.areas] }));
    baseLabel = "9c31f2ab";
    targetLabel = "Working tree";
  }
  const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0);
  const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0);
  const detail =
    scope.kind === "branch" ? scope.base : scope.kind === "commit" ? scope.revision : scope.kind;
  return {
    snapshotId: `preview-${scope.kind}-${detail}`,
    repositoryRoot: "C:/dev/portcode",
    scope,
    baseLabel,
    targetLabel,
    headOid: "9c31f2ab16f0a5c9",
    files,
    additions,
    deletions,
    truncated: false,
  };
}

const PRIMARY_CODEX_ACCOUNT_ID = "codex-primary";

const mock = (() => {
  let settings: Settings = { ...DEFAULT_SETTINGS, rules: [...DEFAULT_SETTINGS.rules] };

  // One fake Codex credential slot, matching the native app-server. Signing in
  // with ChatGPT or a Platform key replaces this same slot.
  let openaiOauth: OpenAIAuthStatus = {
    signedIn: false,
    expiresAt: null,
    account: null,
    tier: null,
    available: true,
    unavailableReason: null,
  };
  let openaiAccounts: OpenAIAccountSummary[] = [];
  const mockSessions = new Map<string, Session>();
  const openaiCatalogue: OpenAIModelCatalogRow[] = [
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "low",
      serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, more usage" }],
    },
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "medium",
      serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, more usage" }],
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, more usage" }],
    },
  ];

  // Fake phone sync state: a stable mock identity + no paired phones by default.
  let phoneSyncState: PhoneSyncStatus = {
    devicePublicKey: "MOCK_DEVICE_PUBLIC_KEY_BASE64==",
    paired: [],
  };

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const resolvers = new Map<string, (d: "allow" | "deny") => void>();

  const connectCodexAccount = (
    accountLabel: string,
    tier: string,
    expiresAt: number | null,
  ): OpenAIAccountSummary => {
    const timestamp = Math.floor(Date.now() / 1000);
    const account: OpenAIAccountSummary = {
      id: PRIMARY_CODEX_ACCOUNT_ID,
      accountLabel,
      tier,
      expiresAt,
      state: "connected",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastUsedAt: timestamp,
    };
    openaiAccounts = [account];
    openaiOauth = {
      signedIn: true,
      expiresAt,
      account: accountLabel,
      tier,
      available: true,
      unavailableReason: null,
    };
    return account;
  };

  return {
    async getSettings() {
      return { ...settings };
    },
    async saveSettings(s: Partial<Settings>) {
      const candidate = { ...settings, ...s };
      settings =
        candidate.provider === "openai" && providerForModel(candidate.model) === "openai"
          ? candidate
          : { ...candidate, provider: "openai", model: DEFAULT_SETTINGS.model };
      return { ...settings };
    },
    async openaiOauthStatus() {
      return { ...openaiOauth };
    },
    async loginCodexApiKey(_apiKey: string) {
      connectCodexAccount("OpenAI Platform API key", "OpenAI Platform", null);
      return { ...openaiOauth };
    },
    async listOpenAIAccounts() {
      return openaiAccounts.map((account) => ({ ...account }));
    },
    async startOpenAIAccountLogin() {
      const timestamp = Math.floor(Date.now() / 1000);
      const account = connectCodexAccount(
        "preview@chatgpt.local",
        "ChatGPT Plus",
        timestamp + 8 * 60 * 60,
      );
      return { ...account };
    },
    async reconnectOpenAIAccount(accountProfileId: string) {
      if (accountProfileId !== PRIMARY_CODEX_ACCOUNT_ID) {
        throw new Error("Codex account profile was not found.");
      }
      const timestamp = Math.floor(Date.now() / 1000);
      const account = connectCodexAccount(
        "preview@chatgpt.local",
        "ChatGPT Plus",
        timestamp + 8 * 60 * 60,
      );
      return { status: "reconnected" as const, account: { ...account } };
    },
    async removeOpenAIAccount(accountProfileId: string) {
      if (accountProfileId !== PRIMARY_CODEX_ACCOUNT_ID) {
        throw new Error("Codex account profile was not found.");
      }
      openaiAccounts = [];
      openaiOauth = {
        signedIn: false,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
        unavailableReason: null,
      };
    },
    async openaiModels(accountProfileId: string) {
      const account = openaiAccounts.find((item) => item.id === accountProfileId);
      if (!account || account.state !== "connected") {
        throw new Error("Connect ChatGPT or an OpenAI Platform API key before loading models.");
      }
      return openaiCatalogue.map((model) => ({
        ...model,
        reasoningEfforts: [...model.reasoningEfforts],
      }));
    },
    async getPlanUsage(
      provider: "openai",
      accountProfileId?: string | null,
    ): Promise<PlanUsageSnapshot> {
      if ((provider as string) !== "openai") {
        throw new Error("Codex usage is available for OpenAI authentication only.");
      }
      const now = Math.floor(Date.now() / 1000);
      const openAIAccount = openaiAccounts.find(
        (account) => account.id === accountProfileId && account.state === "connected",
      );
      if (!openAIAccount) {
        throw new Error("Choose the connected Codex account before loading usage.");
      }
      return {
        provider: "openai",
        plan: openAIAccount.tier?.replace(/^(?:ChatGPT|OpenAI)\s+/i, "") ?? null,
        updatedAt: now,
        windows: [
          {
            id: "primary",
            label: "Current session",
            usedPercent: 18,
            resetsAt: String(now + 3 * 60 * 60),
            windowMinutes: 300,
          },
          {
            id: "secondary",
            label: "Weekly limit",
            usedPercent: 34,
            resetsAt: String(now + 4 * 24 * 60 * 60),
            windowMinutes: 10_080,
          },
        ],
      };
    },
    async listSessions() {
      return [...mockSessions.values()].map((session) => ({ ...session }));
    },
    async createSession(
      id: string,
      title = "New chat",
      workspace: string | null = null,
      model = DEFAULT_SETTINGS.model,
      accountProfileId?: string | null,
    ): Promise<Session> {
      const timestamp = Date.now();
      if (providerForModel(model) !== "openai") {
        throw new Error("Portcode conversations now run through the Codex engine.");
      }
      const codexAccountProfileId = accountProfileId ?? PRIMARY_CODEX_ACCOUNT_ID;
      if (codexAccountProfileId !== PRIMARY_CODEX_ACCOUNT_ID) {
        throw new Error("The selected Codex account is no longer available.");
      }
      const account = openaiAccounts.find(
        (candidate) => candidate.id === codexAccountProfileId && candidate.state === "connected",
      );
      if (account) {
        const usedAt = Math.floor(timestamp / 1000);
        openaiAccounts = openaiAccounts.map((candidate) =>
          candidate.id === codexAccountProfileId
            ? { ...candidate, lastUsedAt: usedAt, updatedAt: usedAt }
            : candidate,
        );
      }
      const session: Session = {
        id,
        title,
        workspace,
        branch: null,
        model,
        accountProfileId: codexAccountProfileId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      mockSessions.set(id, session);
      return { ...session };
    },
    async pinSessionOpenAIAccount(
      sessionId: string,
      accountProfileId: string,
      model?: string,
    ): Promise<Session> {
      const session = mockSessions.get(sessionId);
      if (!session) throw new Error("Session was not found.");
      if (accountProfileId !== PRIMARY_CODEX_ACCOUNT_ID) {
        throw new Error("The selected Codex account is no longer available.");
      }
      const nextModel = model ?? session.model;
      if (providerForModel(nextModel) !== "openai") {
        throw new Error("Portcode conversations now run through the Codex engine.");
      }
      const pinned = { ...session, accountProfileId, model: nextModel };
      mockSessions.set(sessionId, pinned);
      return { ...pinned };
    },
    // Auto-update — inert in the preview: never offer an update, never relaunch,
    // never emit progress/finished. The desktop preview shows no update banner.
    async checkForUpdate(): Promise<UpdateInfo | null> {
      return null;
    },
    async downloadAndInstallUpdate(): Promise<boolean> {
      // no update in the browser preview — return false (nothing staged).
      return false;
    },
    async relaunchApp() {
      // no-op: the preview can't relaunch the (nonexistent) native process.
    },
    async getUpdateChannel(): Promise<UpdateChannel> {
      return "stable";
    },
    async onUpdaterEvent(
      _handler: (
        e: { kind: "progress"; downloaded: number; total: number | null } | { kind: "finished" },
      ) => void,
    ): Promise<Unlisten> {
      return () => {}; // inert: the preview never downloads an update.
    },
    async phoneSyncStatus() {
      return { ...phoneSyncState, paired: [...phoneSyncState.paired] };
    },
    async phoneSyncBeginPairing(): Promise<PairingPayload> {
      return {
        version: 1,
        publicKey: phoneSyncState.devicePublicKey,
        nonce: "MOCK_NONCE_BASE64==",
        // Mirrors the real desktop payload: an opaque iroh node address the phone
        // would dial. Shaped like iroh's EndpointAddr serialization.
        nodeAddr: { id: "mock-endpoint-id", addrs: [] },
      };
    },
    async phoneSyncUnpair(publicKey: string) {
      phoneSyncState = {
        ...phoneSyncState,
        paired: phoneSyncState.paired.filter((d) => d.publicKey !== publicKey),
      };
    },
    // Desktop pairing-confirm surface — inert in the preview (no real phone dials
    // in, so the pairing-request event never fires and confirm/reject are no-ops).
    async onPhoneSyncPairingRequest(_cb: (req: PairingRequest) => void): Promise<Unlisten> {
      return () => {};
    },
    async confirmPairing(_requestId: string) {
      // no-op: the preview has no pending pairing to confirm.
    },
    async rejectPairing(_requestId: string) {
      // no-op: the preview has no pending pairing to reject.
    },
    // Mobile remote client — no real desktop in the browser preview, so connect
    // returns a deterministic SAS and the frame stream is inert. `reconnect` is
    // accepted for signature parity but unused in the preview.
    async phoneSyncConnect(_qr: string, _reconnect = false): Promise<ConnectInfo> {
      return { sas: "MOCK-SAS-1234", peerPublicKey: "MOCK_DESKTOP_KEY_BASE64==" };
    },
    async phoneSyncSendCommand(_command: RemoteCommand) {
      // no-op: the preview has no paired desktop to receive commands.
    },
    async phoneSyncDisconnect() {
      // no-op: nothing to tear down in the preview.
    },
    async onPhoneSyncFrame(_cb: (frame: SyncFrame) => void): Promise<Unlisten> {
      return () => {}; // inert subscription; the preview never emits frames.
    },
    async onPhoneSyncDisconnected(_cb: () => void): Promise<Unlisten> {
      return () => {}; // inert: the preview never drops a (nonexistent) session.
    },
    async subscribeSessionEvents(): Promise<Unlisten> {
      return () => {}; // inert: the preview launches no real background tasks.
    },
    async resolvePermission(id: string, decision: "allow" | "deny", _forSession = false) {
      resolvers.get(id)?.(decision);
      resolvers.delete(id);
    },
    async resolveCodexRequest(_id: string, _response: CodexRequestResponse) {
      // Browser preview has no app-server request waiting on the other side.
    },
    async listDir(sub?: string) {
      const tree: Record<string, { name: string; path: string; isDir: boolean }[]> = {
        "": [
          { name: "src", path: "src", isDir: true },
          { name: "src-tauri", path: "src-tauri", isDir: true },
          { name: "docs", path: "docs", isDir: true },
          { name: "README.md", path: "README.md", isDir: false },
          { name: "package.json", path: "package.json", isDir: false },
        ],
        src: [
          { name: "components", path: "src/components", isDir: true },
          { name: "App.tsx", path: "src/App.tsx", isDir: false },
          { name: "main.tsx", path: "src/main.tsx", isDir: false },
        ],
        "src/components": [
          { name: "Chat.tsx", path: "src/components/Chat.tsx", isDir: false },
          { name: "Sidebar.tsx", path: "src/components/Sidebar.tsx", isDir: false },
        ],
        "src-tauri": [
          { name: "src", path: "src-tauri/src", isDir: true },
          { name: "Cargo.toml", path: "src-tauri/Cargo.toml", isDir: false },
        ],
        docs: [{ name: "ROADMAP.md", path: "docs/ROADMAP.md", isDir: false }],
      };
      return tree[sub ?? ""] ?? [];
    },
    async getWorkspaceSummary(): Promise<WorkspaceSummary> {
      return {
        path: settings.workspace ?? "C:/dev/portcode",
        configured: settings.workspace !== null,
        git: {
          kind: "repository",
          branch: "main",
          detachedHead: null,
          upstream: "origin/main",
          ahead: 0,
          behind: 0,
          changedFiles: 6,
          untrackedFiles: 1,
          additions: 342,
          deletions: 28,
        },
      };
    },
    async getGitReviewManifest(scope: GitReviewScope): Promise<GitReviewManifest> {
      return previewReviewManifest(scope);
    },
    async getGitReviewBranches(): Promise<GitReviewBranch[]> {
      return PREVIEW_REVIEW_BRANCHES.map((branch) => ({ ...branch }));
    },
    async getGitReviewFile(
      scope: GitReviewScope,
      snapshotId: string,
      path: string,
    ): Promise<GitFilePatch> {
      const manifest = previewReviewManifest(scope);
      if (manifest.snapshotId !== snapshotId) throw new Error("Review snapshot is stale.");
      const file = manifest.files.find((candidate) => candidate.path === path);
      if (!file) throw new Error("File is not part of this review.");
      const binary = file.binary;
      return {
        snapshotId,
        path,
        oldPath: file.oldPath,
        status: file.status,
        binary,
        filePatchHash: `preview-patch-${path}-${scope.kind}`,
        truncated: false,
        hunks: binary
          ? []
          : [
              {
                header: "@@ -12,3 +12,4 @@ export function preview() {",
                oldStart: 12,
                oldLines: 3,
                newStart: 12,
                newLines: 4,
                lines: [
                  { kind: "context", content: "  const mode = current;", oldLine: 12, newLine: 12 },
                  { kind: "deletion", content: "  return oldValue;", oldLine: 13, newLine: null },
                  {
                    kind: "addition",
                    content: "  const reviewed = true;",
                    oldLine: null,
                    newLine: 13,
                  },
                  { kind: "addition", content: "  return newValue;", oldLine: null, newLine: 14 },
                  { kind: "context", content: "}", oldLine: 14, newLine: 15 },
                ],
              },
            ],
      };
    },
    async getTurnReviewManifest(turnId: string): Promise<TurnReviewManifest> {
      const startedAt = Date.now() - 18_000;
      const changedFiles = [
        {
          path: "src/App.tsx",
          status: "modified",
          additions: 8,
          deletions: 2,
          binary: false,
          certainty: "exact",
        },
      ] satisfies TurnReviewManifest["files"];
      const receipt: TurnReceipt = {
        turnId,
        status: "completed",
        stopReason: "end_turn",
        startedAt,
        completedAt: startedAt + 18_000,
        durationMs: 18_000,
        changedFiles,
        changedFileCount: changedFiles.length,
        additions: 8,
        deletions: 2,
        filesTruncated: false,
        changeCertainty: "exact",
        backgroundTasksRunning: false,
      };
      return {
        turnId,
        snapshotId: `preview-turn-${turnId}`,
        repositoryRoot: settings.workspace ?? "C:/dev/portcode",
        receipt,
        files: changedFiles,
        additions: receipt.additions,
        deletions: receipt.deletions,
        truncated: receipt.filesTruncated,
        patchesAvailable: false,
      };
    },
    async getTurnReviewFile(turnId: string, path: string): Promise<GitFilePatch> {
      const manifest = await this.getTurnReviewManifest(turnId);
      if (!manifest.files.some((file) => file.path === path)) {
        throw new Error("File is not part of this turn review.");
      }
      throw new Error("Historical turn patches are unavailable in preview mode.");
    },
    async runAgent(_sessionId: string, text: string, onEvent: (e: StreamEvent) => void) {
      let cancelled = false;
      (async () => {
        await delay(120);
        if (cancelled) return;
        const turnId = crypto.randomUUID();
        const startedAt = Date.now();
        onEvent({ type: "turn_start", messageId: turnId, turnId, startedAt });

        const reply =
          "Running in **preview mode** (browser, no Rust core yet).\n\n" +
          "Once the Tauri core is running, this turn streams from the bundled Codex engine and " +
          "runs tools. You said:\n\n> " +
          text +
          "\n\nLet me read a file and then write one:";

        for (const chunk of reply.match(/.{1,3}/gs) ?? []) {
          if (cancelled) return;
          onEvent({ type: "text_delta", text: chunk });
          await delay(6);
        }

        // read-only tool — runs immediately
        await delay(200);
        if (cancelled) return;
        const readId = crypto.randomUUID();
        onEvent({
          type: "tool_use",
          id: readId,
          name: "read_file",
          input: { path: "src/App.tsx" },
        });
        await delay(350);
        onEvent({
          type: "tool_result",
          id: readId,
          output: "// (preview) file contents would appear here",
          isError: false,
        });

        // mutating tool — goes through the permission gate
        await delay(250);
        if (cancelled) return;
        const writeId = crypto.randomUUID();
        const decision = settings.defaultPolicy;
        let approved = decision !== "deny";
        if (decision === "ask") {
          const permId = crypto.randomUUID();
          onEvent({
            type: "permission_request",
            id: permId,
            tool: "edit_file",
            summary: "src/App.tsx",
            input: { path: "src/App.tsx", old_string: "return x;", new_string: "return x + 1;" },
          });
          approved = await new Promise<boolean>((resolve) => {
            resolvers.set(permId, (d) => resolve(d === "allow"));
          }).then((v) => v);
        }
        if (cancelled) return;
        onEvent({
          type: "tool_use",
          id: writeId,
          name: "edit_file",
          input: { path: "src/App.tsx" },
        });
        await delay(250);
        onEvent({
          type: "tool_result",
          id: writeId,
          output: approved
            ? "Edited src/App.tsx (1 replacement(s))\n\n@@ -8,5 +8,5 @@\n function compute() {\n   const x = 1;\n-  return x;\n+  return x + 1;\n }\n"
            : "Denied: the user did not approve this action.",
          isError: !approved,
        });

        await delay(120);
        onEvent({ type: "usage", inputTokens: 1840, outputTokens: 720 });
        const completedAt = Date.now();
        const receipt: TurnReceipt = {
          turnId,
          status: "completed",
          stopReason: "end_turn",
          startedAt,
          completedAt,
          durationMs: Math.max(0, completedAt - startedAt),
          changedFiles: approved
            ? [
                {
                  path: "src/App.tsx",
                  status: "modified",
                  additions: 1,
                  deletions: 1,
                  binary: false,
                  certainty: "exact",
                },
              ]
            : [],
          changedFileCount: approved ? 1 : 0,
          additions: approved ? 1 : 0,
          deletions: approved ? 1 : 0,
          filesTruncated: false,
          changeCertainty: "exact",
          backgroundTasksRunning: false,
        };
        onEvent({ type: "turn_end", stopReason: "end_turn", receipt });
      })();

      return {
        cancel: async () => {
          cancelled = true;
          resolvers.forEach((r) => r("deny"));
          resolvers.clear();
        },
        // Stop delivering this turn's events without the cancel/deny side effects.
        dispose: () => {
          cancelled = true;
        },
      };
    },
  };
})();
