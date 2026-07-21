import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SETTINGS,
  type Message,
  type MessageRow,
  type ModelInfo,
  type OpenAIAccountSummary,
  type OpenAIModelCatalogRow,
  type PairedDevice,
  type PairingPayload,
  type PendingPermission,
  type PhoneSyncStatus,
  type RemoteCommand,
  type Session,
  type StreamEvent,
  type SyncFrame,
  type TurnReceipt,
  type TurnStatus,
  type UpdateInfo,
} from "../types";
import * as ipc from "../lib/ipc";
import { markdownLiteralText } from "../lib/sessionFormat";
import { SETTINGS_COMMITTED_DURABILITY_UNCONFIRMED_PREFIX } from "../lib/settingsPersistence";
import { modelsForOpenAIProfile, teardownAllBackgroundListeners, useStore } from "./store";

// The store is the app's brain: it orchestrates the IPC bridge and folds the
// agent's streamed events into renderable message blocks. We mock the IPC layer
// (TDD London style) so these tests assert the store's behaviour and the exact
// calls it makes, never a real backend.
vi.mock("../lib/ipc", () => ({
  getSettings: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  getMessages: vi.fn(),
  getMessagePage: vi.fn(),
  getSessionArchiveWarning: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  updateSessionModel: vi.fn(),
  saveDraft: vi.fn(),
  getDraft: vi.fn(),
  getDrafts: vi.fn(),
  getUsage: vi.fn(),
  getAllUsage: vi.fn(),
  searchMessages: vi.fn(),
  saveSettings: vi.fn(),
  resolvePermission: vi.fn(),
  setTelemetryConsent: vi.fn(),
  openFolder: vi.fn(),
  runAgent: vi.fn(),
  subscribeSessionEvents: vi.fn(),
  cancelAgentById: vi.fn(),
  oauthStatus: vi.fn(),
  startOauthLogin: vi.fn(),
  oauthLogout: vi.fn(),
  openaiOauthStatus: vi.fn(),
  listOpenAIAccounts: vi.fn(),
  startOpenAIAccountLogin: vi.fn(),
  reconnectOpenAIAccount: vi.fn(),
  removeOpenAIAccount: vi.fn(),
  pinSessionOpenAIAccount: vi.fn(),
  openaiModels: vi.fn(),
  phoneSyncStatus: vi.fn(),
  phoneSyncBeginPairing: vi.fn(),
  phoneSyncUnpair: vi.fn(),
  phoneSyncConnect: vi.fn(),
  phoneSyncSendCommand: vi.fn(),
  phoneSyncDisconnect: vi.fn(),
  phoneSyncReject: vi.fn(),
  onPhoneSyncFrame: vi.fn(),
  onPhoneSyncDisconnected: vi.fn(),
  onPhoneSyncPairingRequest: vi.fn(),
  confirmPairing: vi.fn(),
  rejectPairing: vi.fn(),
  checkForUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
  relaunchApp: vi.fn(),
  getUpdateChannel: vi.fn(),
  onUpdaterEvent: vi.fn(),
}));

const m = vi.mocked(ipc);
const initialState = useStore.getState();

// A signed-out OAuth status: init() resolves this so the store never throws on
// the OAuth bridge while these tests exercise unrelated behaviour.
const signedOut = { signedIn: false, expiresAt: null, account: null, tier: null };

const noPhoneSync: PhoneSyncStatus = { devicePublicKey: "DEVICE==", paired: [] };

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  title: "Chat",
  workspace: null,
  model: "claude-opus-4-8",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const openAIAccount = (over: Partial<OpenAIAccountSummary> = {}): OpenAIAccountSummary => ({
  id: "00000000-0000-4000-8000-000000000001",
  accountLabel: "one@chatgpt.test",
  tier: "ChatGPT Plus",
  expiresAt: 9_999,
  state: "connected",
  createdAt: 100,
  updatedAt: 100,
  lastUsedAt: null,
  ...over,
});

const runState = (
  over: Partial<{
    streaming: boolean;
    cancel: (() => Promise<void>) | null;
    pendingPermission: PendingPermission | null;
    turnId: string | null;
    startedAt: number | null;
    finalizing: boolean;
    agentDurationMs: number | null;
    phaseRevision: number;
    receipt: TurnReceipt | null;
    outcome: TurnStatus | null;
    composerPhase: "idle" | "received" | "thinking" | "stopping";
    activeTool: string | null;
    unseenOutcome: TurnStatus | null;
  }> = {},
) => ({
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
  composerPhase: "idle" as const,
  activeTool: null,
  unseenOutcome: null,
  ...over,
});

const turnReceipt = (over: Partial<TurnReceipt> = {}): TurnReceipt => ({
  turnId: "turn-1",
  status: "completed",
  stopReason: "end_turn",
  startedAt: 100,
  completedAt: 350,
  durationMs: 250,
  changedFiles: [],
  changedFileCount: 0,
  additions: 0,
  deletions: 0,
  filesTruncated: false,
  changeCertainty: "exact",
  backgroundTasksRunning: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Restore a pristine store between tests (zustand has no built-in reset).
  useStore.setState(initialState, true);

  m.getSettings.mockResolvedValue(DEFAULT_SETTINGS);
  m.listSessions.mockResolvedValue([]);
  m.getMessages.mockResolvedValue([]);
  m.getMessagePage.mockImplementation(async (sessionId) => ({
    messages: await m.getMessages(sessionId),
    nextCursor: null,
  }));
  m.getSessionArchiveWarning.mockResolvedValue(null);
  m.createSession.mockImplementation(
    async (id, title, workspace, model = DEFAULT_SETTINGS.model, accountProfileId = null) =>
      session({ id, title, workspace, model, accountProfileId }),
  );
  m.deleteSession.mockResolvedValue(undefined);
  m.renameSession.mockResolvedValue(undefined);
  m.updateSessionModel.mockResolvedValue(undefined);
  m.saveDraft.mockResolvedValue(undefined);
  m.getDraft.mockResolvedValue(null);
  m.getDrafts.mockResolvedValue([]);
  m.getUsage.mockResolvedValue({ sessionId: "s1", input: 0, output: 0 });
  m.getAllUsage.mockResolvedValue([]);
  m.searchMessages.mockResolvedValue([]);
  m.saveSettings.mockImplementation(async (s) => ({ ...DEFAULT_SETTINGS, ...s }));
  m.resolvePermission.mockResolvedValue(undefined);
  m.setTelemetryConsent.mockResolvedValue(undefined);
  m.openFolder.mockResolvedValue(null);
  m.runAgent.mockResolvedValue({ cancel: vi.fn(async () => {}), dispose: vi.fn() });
  m.subscribeSessionEvents.mockResolvedValue(() => {});
  m.cancelAgentById.mockResolvedValue(undefined);
  m.oauthStatus.mockResolvedValue(signedOut);
  m.startOauthLogin.mockResolvedValue(signedOut);
  m.oauthLogout.mockResolvedValue(undefined);
  m.openaiOauthStatus.mockResolvedValue(signedOut);
  m.listOpenAIAccounts.mockResolvedValue([]);
  m.startOpenAIAccountLogin.mockResolvedValue(openAIAccount());
  m.reconnectOpenAIAccount.mockImplementation(async (accountProfileId) => ({
    status: "reconnected" as const,
    account: openAIAccount({ id: accountProfileId }),
  }));
  m.removeOpenAIAccount.mockResolvedValue(undefined);
  m.pinSessionOpenAIAccount.mockImplementation(async (sessionId, accountProfileId) =>
    session({ id: sessionId, model: "gpt-live", accountProfileId }),
  );
  m.openaiModels.mockResolvedValue([]);
  m.phoneSyncStatus.mockResolvedValue(noPhoneSync);
  m.phoneSyncBeginPairing.mockResolvedValue({
    version: 1,
    publicKey: "DEVICE==",
    nonce: "NONCE==",
  });
  m.phoneSyncUnpair.mockResolvedValue(undefined);
  m.phoneSyncConnect.mockResolvedValue({ sas: "SAS-1", peerPublicKey: "PEER==" });
  m.phoneSyncSendCommand.mockResolvedValue(undefined);
  m.phoneSyncDisconnect.mockResolvedValue(undefined);
  m.phoneSyncReject.mockResolvedValue(undefined);
  m.onPhoneSyncFrame.mockResolvedValue(() => {});
  m.onPhoneSyncDisconnected.mockResolvedValue(() => {});
  m.onPhoneSyncPairingRequest.mockResolvedValue(() => {});
  m.confirmPairing.mockResolvedValue(undefined);
  m.rejectPairing.mockResolvedValue(undefined);
  m.checkForUpdate.mockResolvedValue(null);
  m.downloadAndInstallUpdate.mockResolvedValue(true);
  m.relaunchApp.mockResolvedValue(undefined);
  m.getUpdateChannel.mockResolvedValue("stable");
  m.onUpdaterEvent.mockResolvedValue(() => {});
});

describe("init", () => {
  it("opens an unpersisted new-chat shell when the backend has no sessions", async () => {
    await useStore.getState().init();

    const st = useStore.getState();
    expect(m.createSession).not.toHaveBeenCalled();
    expect(st.sessions).toEqual([]);
    expect(st.pendingSession?.id).toBe(st.activeId);
    expect(st.messages[st.activeId!]).toEqual([]);
  });

  it("loads existing sessions and the active session's history", async () => {
    const s1 = session({ id: "a" });
    const s2 = session({ id: "b" });
    const msg: Message = {
      id: "m1",
      role: "user",
      blocks: [{ kind: "text", text: "hi" }],
      createdAt: 1,
    };
    m.listSessions.mockResolvedValue([s1, s2]);
    m.getMessages.mockResolvedValue([msg]);

    await useStore.getState().init();

    const st = useStore.getState();
    expect(m.createSession).not.toHaveBeenCalled();
    expect(st.activeId).toBe("a");
    expect(st.sessions).toEqual([s1, s2]);
    expect(st.messages["a"]).toEqual([msg]);
  });

  it("preserves durable turn identity and receipts when hydrating history", async () => {
    const receipt = turnReceipt({ turnId: "persisted-turn" });
    const msg: Message = {
      id: "persisted-turn",
      role: "assistant",
      blocks: [{ kind: "text", text: "done" }],
      createdAt: receipt.startedAt,
      turnId: receipt.turnId,
      receipt,
    };
    m.listSessions.mockResolvedValue([session({ id: "a" })]);
    m.getMessages.mockResolvedValue([msg]);

    await useStore.getState().init();

    expect(useStore.getState().messages.a).toEqual([msg]);
  });

  it("coerces a loaded session with no model to the last-used default", async () => {
    // Old DB rows predate per-session model: listSessions yields a session whose
    // model is absent. The store must coalesce it to settings.model so
    // Session.model stays a non-null string.
    m.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, model: "claude-sonnet-4-6" });
    const legacy = { ...session({ id: "a" }), model: undefined } as unknown as Session;
    m.listSessions.mockResolvedValue([legacy]);

    await useStore.getState().init();

    expect(useStore.getState().sessions[0].model).toBe("claude-sonnet-4-6");
  });

  it("records initError when a load-bearing startup call rejects", async () => {
    // A failed core / locked DB rejects a guarded call; init must surface an error
    // instead of leaving a permanently blank welcome shell with no feedback.
    m.listSessions.mockRejectedValue(new Error("core not ready"));

    await useStore.getState().init();

    const st = useStore.getState();
    expect(st.initError).toBe("core not ready");
    expect(st.sessions).toEqual([]);
    expect(st.activeId).toBeNull();
  });

  it("retryInit clears initError and re-runs init successfully", async () => {
    m.listSessions.mockRejectedValueOnce(new Error("core not ready"));
    await useStore.getState().init();
    expect(useStore.getState().initError).toBe("core not ready");

    // The core recovers; the retry succeeds and clears the error.
    await useStore.getState().retryInit();

    const st = useStore.getState();
    expect(st.initError).toBeNull();
    expect(st.sessions).toEqual([]);
    expect(st.pendingSession?.id).toBe(st.activeId);
    expect(m.createSession).not.toHaveBeenCalled();
  });

  it("clears a prior initError on a later successful init", async () => {
    useStore.setState({ initError: "stale failure" });

    await useStore.getState().init();

    expect(useStore.getState().initError).toBeNull();
  });

  it("auto-creates only when the preferred account advertises the exact persisted OpenAI model", async () => {
    const account = openAIAccount();
    m.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      provider: "openai",
      model: "gpt-account-default",
      reasoningEffort: "high",
    });
    m.openaiOauthStatus.mockResolvedValue({
      signedIn: true,
      expiresAt: null,
      account: null,
      tier: null,
      available: true,
    });
    m.listOpenAIAccounts.mockResolvedValue([account]);
    m.openaiModels.mockResolvedValue([
      {
        id: "gpt-account-default",
        label: "GPT Account Default",
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
      },
    ]);

    await useStore.getState().init();

    expect(m.createSession).not.toHaveBeenCalled();
    expect(useStore.getState()).toMatchObject({
      settings: {
        model: "gpt-account-default",
        provider: "openai",
        reasoningEffort: "high",
      },
      sessions: [],
      pendingSession: expect.objectContaining({
        model: "gpt-account-default",
        accountProfileId: account.id,
      }),
    });
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("opens Settings instead of creating when the persisted model is disjoint from the default account", async () => {
    const account = openAIAccount();
    m.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      provider: "openai",
      model: "gpt-persisted",
      reasoningEffort: "ultra",
    });
    m.openaiOauthStatus.mockResolvedValue({
      signedIn: true,
      expiresAt: null,
      account: null,
      tier: null,
      available: true,
    });
    m.listOpenAIAccounts.mockResolvedValue([account]);
    m.openaiModels.mockResolvedValue([
      {
        id: "gpt-account-default",
        label: "GPT Account Default",
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
      },
    ]);

    await useStore.getState().init();

    expect(m.createSession).not.toHaveBeenCalled();
    expect(useStore.getState()).toMatchObject({
      settings: {
        model: "gpt-persisted",
        provider: "openai",
        reasoningEffort: "ultra",
      },
      sessions: [],
      activeId: null,
      showSettings: true,
      openAIAuthError:
        "Choose a model available to the default ChatGPT account before creating a GPT chat.",
    });
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", new Error("catalogue offline"), "catalogue offline"],
    ["empty", [], "This account returned no compatible OpenAI models."],
  ])(
    "keeps catalogue failure visible and opens Settings when discovery is %s",
    async (_case, catalogueResult, expectedError) => {
      const account = openAIAccount();
      m.getSettings.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        provider: "openai",
        model: "gpt-persisted",
      });
      m.openaiOauthStatus.mockResolvedValue({
        signedIn: true,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
      });
      m.listOpenAIAccounts.mockResolvedValue([account]);
      if (catalogueResult instanceof Error) {
        m.openaiModels.mockRejectedValue(catalogueResult);
      } else {
        m.openaiModels.mockResolvedValue(catalogueResult);
      }

      await useStore.getState().init();

      expect(m.createSession).not.toHaveBeenCalled();
      expect(useStore.getState()).toMatchObject({
        settings: { model: "gpt-persisted", provider: "openai" },
        openAIModelCatalogs: {
          [account.id]: { status: "error", models: [], error: expectedError },
        },
        sessions: [],
        activeId: null,
        showSettings: true,
        openAIAuthError: expectedError,
      });
    },
  );

  it("is a no-op for the remote client (no desktop IPCs, no stale initError)", async () => {
    // On the phone the desktop-only session/settings commands would reject and
    // strand a spurious crash panel over the connected remote session, so init()
    // bails early — remote state arrives from the desktop's frames instead.
    useStore.setState({ remoteMode: true, initError: "stale" });

    await useStore.getState().init();

    const st = useStore.getState();
    expect(st.initError).toBeNull();
    expect(m.listSessions).not.toHaveBeenCalled();
    expect(m.getSettings).not.toHaveBeenCalled();
  });
});

describe("newSession", () => {
  it("opens a fresh unpersisted chat and makes it active", async () => {
    useStore.setState({ sessions: [session({ id: "old" })] });

    await useStore.getState().newSession();

    const st = useStore.getState();
    expect(m.createSession).not.toHaveBeenCalled();
    expect(st.sessions).toHaveLength(1);
    expect(st.pendingSession?.id).toBe(st.activeId);
    expect(st.messages[st.activeId!]).toEqual([]);
  });

  it("persists the pending chat immediately before its first turn", async () => {
    useStore.setState({ sessions: [session({ id: "old" })], activeId: "old" });

    await useStore.getState().newSession();
    const pendingId = useStore.getState().activeId!;
    expect(m.createSession).not.toHaveBeenCalled();

    await useStore.getState().send("first message");

    expect(m.createSession).toHaveBeenCalledWith(
      pendingId,
      "New chat",
      null,
      DEFAULT_SETTINGS.model,
      null,
    );
    expect(useStore.getState().pendingSession).toBeNull();
    expect(useStore.getState().sessions[0].id).toBe(pendingId);
  });

  it("initializes the new session's model from the last-used settings.model", async () => {
    useStore.setState({
      sessions: [session({ id: "old" })],
      settings: { ...DEFAULT_SETTINGS, model: "claude-haiku-4-5-20251001" },
    });

    await useStore.getState().newSession();

    const st = useStore.getState();
    expect(st.pendingSession?.model).toBe("claude-haiku-4-5-20251001");
    expect(m.createSession).not.toHaveBeenCalled();
  });

  it("closes the mobile session drawer", async () => {
    useStore.setState({ showSidebar: true });
    await useStore.getState().newSession();
    expect(useStore.getState().showSidebar).toBe(false);
  });

  it("opens a pending chat while another session keeps running", async () => {
    useStore.setState({
      streaming: true,
      sessions: [session({ id: "a" })],
      activeId: "a",
      runs: { a: runState({ streaming: true }) },
    });

    await useStore.getState().newSession();

    expect(m.createSession).not.toHaveBeenCalled();
    expect(useStore.getState().activeId).not.toBe("a");
    expect(useStore.getState().sessions).toHaveLength(1);
    expect(useStore.getState().pendingSession?.id).toBe(useStore.getState().activeId);
    expect(useStore.getState().runs.a.streaming).toBe(true);
  });

  it("a rapid double-call still leaves only one pending chat", async () => {
    useStore.setState({ sessions: [session({ id: "old" })] });

    const first = useStore.getState().newSession();
    const second = useStore.getState().newSession();
    await Promise.all([first, second]);

    expect(m.createSession).not.toHaveBeenCalled();
    expect(useStore.getState().sessions).toHaveLength(1);
    expect(useStore.getState().pendingSession?.id).toBe(useStore.getState().activeId);
    expect(useStore.getState().creatingSession).toBe(false);
  });

  it("creates the desktop-owned remote session only on first send", async () => {
    // On the phone the agent-side create_session is desktop-only; calling the local
    // Tauri invoke would reject. newSession must forward a `create_session` command
    // and let the desktop's session_list frame reconcile — not optimistically insert
    // a phantom local session.
    useStore.setState({ remoteConnected: true, sessions: [session({ id: "old" })] });

    await useStore.getState().newSession();

    expect(m.phoneSyncSendCommand).not.toHaveBeenCalled();
    expect(useStore.getState().pendingSession?.id).toBe(useStore.getState().activeId);
    expect(useStore.getState().creatingSession).toBe(false);

    await useStore.getState().send("hello desktop");

    expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({
      cmd: "create_session",
      request_id: expect.any(String),
    });
    expect(m.createSession).not.toHaveBeenCalled();
    const st = useStore.getState();
    expect(st.sessions).toHaveLength(1); // no optimistic local session inserted
    expect(st.creatingSession).toBe(true); // held until the correlated acknowledgement
    expect(st.showSidebar).toBe(false); // drawer closed on navigation

    const request = m.phoneSyncSendCommand.mock.calls[0][0] as Extract<
      RemoteCommand,
      { cmd: "create_session" }
    >;
    useStore.getState().applyFrame({
      t: "session_created",
      request_id: "another-device",
      session: session({ id: "other" }),
    });
    expect(useStore.getState().activeId).not.toBe("other");
    expect(useStore.getState().creatingSession).toBe(true);

    useStore.getState().applyFrame({
      t: "session_created",
      request_id: request.request_id!,
      session: session({ id: "created" }),
    });
    expect(useStore.getState()).toMatchObject({
      activeId: "created",
      creatingSession: false,
      remoteChatOpen: true,
      pendingSession: null,
    });
    await vi.waitFor(() =>
      expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({
        cmd: "run",
        session_id: "created",
        text: "hello desktop",
      }),
    );
  });

  it("stays connected after a correlated desktop rejection and can retry successfully", async () => {
    useStore.setState({
      remoteConnected: true,
      remoteVerified: true,
      // Phone state may be stale: the desktop is authoritative and can reject this
      // apparently-Claude create because its actual default is an unpinned OpenAI account.
      settings: { ...DEFAULT_SETTINGS, model: "claude-opus-4-8", provider: "anthropic" },
    });

    await useStore.getState().newSession();
    await useStore.getState().send("first attempt");
    const first = m.phoneSyncSendCommand.mock.calls[0][0] as Extract<
      RemoteCommand,
      { cmd: "create_session" }
    >;
    useStore.getState().applyFrame({
      t: "command_rejected",
      request_id: first.request_id,
      code: "open_ai_account_selection_required",
      message: "Configure a default ChatGPT account on the desktop, then try again.",
    });

    expect(m.createSession).not.toHaveBeenCalled();
    expect(useStore.getState()).toMatchObject({
      creatingSession: false,
      remoteConnected: true,
      remoteVerified: true,
      remoteError: "Configure a default ChatGPT account on the desktop, then try again.",
    });

    useStore.getState().clearRemoteError();
    await useStore.getState().newSession();
    await useStore.getState().send("retry attempt");
    const second = m.phoneSyncSendCommand.mock.calls[1][0] as Extract<
      RemoteCommand,
      { cmd: "create_session" }
    >;
    expect(second.request_id).not.toBe(first.request_id);
    useStore.getState().applyFrame({
      t: "session_created",
      request_id: second.request_id!,
      session: session({ id: "retry-created" }),
    });
    expect(useStore.getState()).toMatchObject({
      activeId: "retry-created",
      creatingSession: false,
      remoteConnected: true,
      remoteError: null,
    });
  });

  it("ignores a broadcast rejection for another phone without cancelling the pending create", async () => {
    useStore.setState({ remoteConnected: true, remoteVerified: true });

    await useStore.getState().newSession();
    await useStore.getState().send("hello");
    const request = m.phoneSyncSendCommand.mock.calls[0][0] as Extract<
      RemoteCommand,
      { cmd: "create_session" }
    >;
    useStore.getState().applyFrame({
      t: "command_rejected",
      request_id: "another-request",
      code: "invalid_request",
      message: "Another request was rejected.",
    });

    expect(useStore.getState()).toMatchObject({
      creatingSession: true,
      remoteConnected: true,
      remoteError: null,
    });
    useStore.getState().applyFrame({
      t: "command_rejected",
      code: "unknown",
      message: "An uncorrelated rejection must not attach to this create.",
    });
    expect(useStore.getState()).toMatchObject({ creatingSession: true, remoteError: null });
    useStore.getState().applyFrame({
      t: "session_created",
      request_id: request.request_id!,
      session: session({ id: "expected" }),
    });
    expect(useStore.getState()).toMatchObject({ activeId: "expected", creatingSession: false });
  });

  it("uses generic copy when the matching rejection omits defaulted code and message", async () => {
    useStore.setState({ remoteConnected: true, remoteVerified: true });

    await useStore.getState().newSession();
    await useStore.getState().send("hello");
    const request = m.phoneSyncSendCommand.mock.calls[0][0] as Extract<
      RemoteCommand,
      { cmd: "create_session" }
    >;
    useStore.getState().applyFrame({
      t: "command_rejected",
      request_id: request.request_id,
    });

    expect(useStore.getState()).toMatchObject({
      creatingSession: false,
      remoteConnected: true,
      remoteError: "The desktop rejected this command.",
    });
  });

  it("routes unavailable or missing ChatGPT profiles to Settings without creating", async () => {
    const account = openAIAccount();
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, model: "gpt-5.6-sol", provider: "openai" },
      openAIAuthStatus: {
        signedIn: false,
        expiresAt: null,
        account: null,
        tier: null,
        available: false,
        unavailableReason: "Disabled by this build",
      },
      openAIAccounts: [account],
    });

    await useStore.getState().newSession(account.id);
    expect(useStore.getState()).toMatchObject({
      showSettings: true,
      openAIAuthError: "Disabled by this build",
      creatingSession: false,
    });

    useStore.setState({
      showSettings: false,
      openAIAuthError: null,
      openAIAuthStatus: {
        signedIn: false,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
        unavailableReason: null,
      },
      openAIAccounts: [],
    });
    await useStore.getState().newSession(account.id);
    expect(useStore.getState()).toMatchObject({
      showSettings: true,
      openAIAuthError: "Choose a default ChatGPT account in Settings first.",
      creatingSession: false,
    });
    expect(m.createSession).not.toHaveBeenCalled();
  });

  it("blocks GPT chat creation while the account registry is unavailable", async () => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, model: "gpt-5.6-sol", provider: "openai" },
      openAIAccounts: [],
      openAIAccountsError: "credential registry is locked",
    });

    await useStore.getState().newSession();

    expect(m.createSession).not.toHaveBeenCalled();
    expect(m.openaiModels).not.toHaveBeenCalled();
    expect(useStore.getState()).toMatchObject({
      sessions: [],
      showSettings: true,
      openAIAuthError:
        "ChatGPT account registry is unavailable: credential registry is locked. Retry account discovery before creating a session.",
      creatingSession: false,
    });
  });

  it("uses the configured default account for no-arg OpenAI creation", async () => {
    const account = openAIAccount();
    const models: ModelInfo[] = [
      {
        id: "gpt-live",
        label: "GPT Live",
        provider: "openai",
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
      },
    ];
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, model: "gpt-live", provider: "openai" },
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: 9_999,
        account: null,
        tier: null,
        available: true,
        unavailableReason: null,
      },
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: [...models], error: null },
      },
      openAIModels: [...models],
      lastOpenAIAccountProfileId: account.id,
    });

    await useStore.getState().newSession();

    expect(m.saveSettings).not.toHaveBeenCalled();
    expect(m.createSession).not.toHaveBeenCalled();
    expect(useStore.getState().pendingSession).toMatchObject({
      model: "gpt-live",
      accountProfileId: account.id,
    });
    expect(useStore.getState().settings.model).toBe("gpt-live");
  });

  it("blocks a model that the default account does not advertise", async () => {
    const account = openAIAccount();
    const models: ModelInfo[] = [
      {
        id: "gpt-live",
        label: "GPT Live",
        provider: "openai",
        reasoningEfforts: ["high"],
        defaultReasoningEffort: "high",
      },
    ];
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, model: "gpt-missing", provider: "openai" },
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: 9_999,
        account: null,
        tier: null,
        available: true,
        unavailableReason: null,
      },
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models, error: null },
      },
      openAIModels: models,
      lastOpenAIAccountProfileId: account.id,
    });

    await useStore.getState().newSession();

    expect(m.createSession).not.toHaveBeenCalled();
    expect(useStore.getState()).toMatchObject({
      sessions: [],
      showSettings: true,
      openAIAuthError: "Choose a model available to one@chatgpt.test before creating this session.",
      settings: { model: "gpt-missing", provider: "openai" },
      creatingSession: false,
    });
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("fails closed when an explicit account/model pair is incompatible", async () => {
    const account = openAIAccount();
    const models: ModelInfo[] = [
      {
        id: "gpt-live",
        label: "GPT Live",
        provider: "openai",
        reasoningEfforts: ["high"],
        defaultReasoningEffort: "high",
      },
    ];
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, model: "gpt-5.6-sol", provider: "openai" },
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: 9_999,
        account: null,
        tier: null,
        available: true,
        unavailableReason: null,
      },
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models, error: null },
      },
      openAIModels: models,
    });

    await useStore.getState().newSession(account.id, "gpt-5.6-sol");

    expect(m.createSession).not.toHaveBeenCalled();
    expect(m.saveSettings).not.toHaveBeenCalled();
    expect(useStore.getState()).toMatchObject({
      openAIAuthError: "Choose a model available to one@chatgpt.test before creating this session.",
      creatingSession: false,
    });
  });

  it("requires authoritative identity and account confirmation on first send", async () => {
    const account = openAIAccount();
    const models: ModelInfo[] = [
      {
        id: "gpt-live",
        label: "GPT Live",
        provider: "openai",
        reasoningEfforts: ["high"],
        defaultReasoningEffort: "high",
      },
    ];
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, model: "gpt-live", provider: "openai" },
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: 9_999,
        account: null,
        tier: null,
        available: true,
        unavailableReason: null,
      },
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: [...models], error: null },
      },
      openAIModels: [...models],
    });
    m.createSession.mockImplementationOnce(async (_id, title, workspace, model) =>
      session({ id: "different", title, workspace, model }),
    );

    await useStore.getState().newSession(account.id);
    await useStore.getState().send("hello");
    expect(useStore.getState().initError).toBe("The native core did not confirm the new session.");

    m.createSession.mockImplementationOnce(async (id, title, workspace, model) =>
      session({ id, title, workspace, model, accountProfileId: null }),
    );
    await useStore.getState().newSession(account.id);
    await useStore.getState().send("hello");
    expect(useStore.getState().initError).toBe(
      "The native core did not preserve the selected ChatGPT account.",
    );
  });

  it("releases the remote create lock when its correlated acknowledgement times out", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({
        remoteConnected: true,
        sessions: [session({ id: "old" })],
        activeId: "old",
      });

      await useStore.getState().newSession();
      const pendingId = useStore.getState().activeId;
      await useStore.getState().send("hello");
      expect(useStore.getState().creatingSession).toBe(true);

      await vi.advanceTimersByTimeAsync(15_000);

      expect(useStore.getState()).toMatchObject({
        activeId: pendingId,
        creatingSession: false,
        remoteError: "Creating the conversation timed out. Please try again.",
      });
      expect(useStore.getState().drafts[pendingId!]).toBe("hello");
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a first-send create rejection instead of an unhandled rejection", async () => {
    // The local path now wraps createSession in try/catch so a reject (locked DB /
    // core not ready) lands in the visible error surface rather than escaping as an
    // unhandled promise rejection (callers use bare onClick / void).
    m.createSession.mockRejectedValueOnce(new Error("db locked"));
    useStore.setState({ sessions: [session({ id: "old" })] });

    await useStore.getState().newSession();
    await expect(useStore.getState().send("keep this draft")).resolves.toBeUndefined();

    const st = useStore.getState();
    expect(st.initError).toBe("db locked");
    expect(st.sessions).toHaveLength(1); // no phantom session on failure
    expect(st.creatingSession).toBe(false); // lock released
    expect(st.drafts[st.activeId!]).toBe("keep this draft");
  });
});

describe("setSessionModel", () => {
  it("updates a pending chat in memory and persists its chosen account only on first send", async () => {
    await useStore.getState().newSession();
    const pendingId = useStore.getState().activeId!;

    await useStore.getState().setSessionModel("gpt-live");
    expect(useStore.getState().settingsError).toBe(
      "Choose a default ChatGPT account in Settings first.",
    );

    const account = openAIAccount();
    const accountModel = {
      id: "gpt-live",
      label: "GPT Live",
      provider: "openai" as const,
      reasoningEfforts: ["high" as const],
      defaultReasoningEffort: "high" as const,
    };
    useStore.setState({
      openAIAccounts: [account],
      openAIModels: [accountModel],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: [accountModel], error: null },
      },
      lastOpenAIAccountProfileId: account.id,
      settingsError: null,
    });

    await useStore.getState().setSessionModel(accountModel.id);
    expect(useStore.getState().pendingSession).toMatchObject({
      id: pendingId,
      model: accountModel.id,
      accountProfileId: account.id,
    });
    expect(m.updateSessionModel).not.toHaveBeenCalled();

    await useStore.getState().setSessionModel("claude-sonnet-4-6");
    expect(useStore.getState().pendingSession).toMatchObject({
      id: pendingId,
      model: "claude-sonnet-4-6",
      accountProfileId: null,
    });

    await useStore.getState().setSessionModel(accountModel.id);
    await useStore.getState().send("create this chat");

    expect(useStore.getState().pendingSession).toBeNull();
    expect(useStore.getState().lastOpenAIAccountProfileId).toBe(account.id);
    expect(localStorage.getItem("pc.lastOpenAIAccountProfileId")).toBe(account.id);
  });

  it.each([
    ["a streaming turn", { streaming: true }],
    ["remote mode", { remoteMode: true }],
    ["a connected remote chat", { remoteConnected: true }],
  ])("ignores palette model changes during %s", async (_label, guardedState) => {
    useStore.setState({
      sessions: [session({ id: "a", model: "claude-opus-4-8" })],
      activeId: "a",
      ...guardedState,
    });

    await useStore.getState().setSessionModel("gpt-5.6-sol");

    expect(useStore.getState().sessions[0].model).toBe("claude-opus-4-8");
    expect(m.updateSessionModel).not.toHaveBeenCalled();
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("updates the active session's model and tracks it as the last-used default", async () => {
    useStore.setState({
      sessions: [session({ id: "a", model: "claude-opus-4-8" })],
      activeId: "a",
    });

    await useStore.getState().setSessionModel("claude-sonnet-4-6");

    const st = useStore.getState();
    expect(st.sessions[0].model).toBe("claude-sonnet-4-6");
    expect(m.updateSessionModel).toHaveBeenCalledWith("a", "claude-sonnet-4-6");
    // Last-used sync: settings.model is updated through ipc.saveSettings.
    expect(m.saveSettings).toHaveBeenCalledWith({
      model: "claude-sonnet-4-6",
      reasoningEffort: "medium",
    });
    expect(st.settings.model).toBe("claude-sonnet-4-6");
  });

  it("rejects every model outside a pinned account's ready catalogue before native write", async () => {
    const account = openAIAccount();
    const accountModel = {
      id: "gpt-live",
      label: "GPT Live",
      provider: "openai" as const,
      reasoningEfforts: ["high" as const],
      defaultReasoningEffort: "high" as const,
    };
    useStore.setState({
      sessions: [session({ id: "a", model: accountModel.id, accountProfileId: account.id })],
      activeId: "a",
      openAIAccounts: [account],
      openAIModels: [accountModel],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: [accountModel], error: null },
      },
    });

    await useStore.getState().setSessionModel("claude-sonnet-4-6");

    expect(useStore.getState().sessions[0].model).toBe(accountModel.id);
    expect(useStore.getState().settingsError).toBe(
      "That model is not available to this conversation's ChatGPT account.",
    );
    expect(m.updateSessionModel).not.toHaveBeenCalled();
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("reverts the optimistic session model when durable persistence fails", async () => {
    m.updateSessionModel.mockRejectedValueOnce(new Error("database is locked"));
    useStore.setState({
      sessions: [session({ id: "a", model: "claude-opus-4-8" })],
      activeId: "a",
    });

    await expect(useStore.getState().setSessionModel("claude-sonnet-4-6")).resolves.toBeUndefined();

    const st = useStore.getState();
    expect(st.sessions[0].model).toBe("claude-opus-4-8");
    expect(st.settingsError).toBe("database is locked");
    // The global default must not claim a selection that the active chat rejected.
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("does not let a slower earlier selection overwrite the latest global default", async () => {
    let resolveFirst!: () => void;
    m.updateSessionModel
      .mockImplementationOnce(
        async () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    useStore.setState({
      sessions: [session({ id: "a", model: "claude-opus-4-8" })],
      activeId: "a",
    });

    const first = useStore.getState().setSessionModel("claude-sonnet-4-6");
    const second = useStore.getState().setSessionModel("claude-haiku-4-5-20251001");
    // Per-session writes are serialized: the second invoke cannot overtake the
    // unresolved first and become vulnerable to the old value finishing last.
    expect(m.updateSessionModel).toHaveBeenCalledTimes(1);
    resolveFirst();
    await Promise.all([first, second]);

    expect(useStore.getState().sessions[0].model).toBe("claude-haiku-4-5-20251001");
    expect(useStore.getState().settings.model).toBe("claude-haiku-4-5-20251001");
    expect(m.saveSettings).toHaveBeenCalledTimes(1);
    expect(m.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001" }),
    );
    expect(m.updateSessionModel.mock.calls).toEqual([
      ["a", "claude-sonnet-4-6"],
      ["a", "claude-haiku-4-5-20251001"],
    ]);
  });

  it("does not surface a stale first-write error after the queued latest choice succeeds", async () => {
    m.updateSessionModel
      .mockRejectedValueOnce(new Error("old write failed"))
      .mockResolvedValueOnce(undefined);
    useStore.setState({
      sessions: [session({ id: "a", model: "claude-opus-4-8" })],
      activeId: "a",
    });

    const first = useStore.getState().setSessionModel("claude-sonnet-4-6");
    const second = useStore.getState().setSessionModel("claude-haiku-4-5-20251001");
    await Promise.all([first, second]);

    expect(useStore.getState().sessions[0].model).toBe("claude-haiku-4-5-20251001");
    expect(useStore.getState().settings.model).toBe("claude-haiku-4-5-20251001");
    expect(useStore.getState().settingsError).toBeNull();
  });

  it("returns consecutive rejected model writes to the last persisted model", async () => {
    m.updateSessionModel
      .mockRejectedValueOnce(new Error("first write failed"))
      .mockRejectedValueOnce(new Error("latest write failed"));
    useStore.setState({
      sessions: [session({ id: "a", model: "claude-opus-4-8" })],
      activeId: "a",
    });

    const first = useStore.getState().setSessionModel("claude-sonnet-4-6");
    const second = useStore.getState().setSessionModel("claude-haiku-4-5-20251001");
    await Promise.all([first, second]);

    expect(useStore.getState().sessions[0].model).toBe("claude-opus-4-8");
    expect(useStore.getState().settingsError).toBe("latest write failed");
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("still updates the last-used default when no session is active (palette safety)", async () => {
    useStore.setState({ sessions: [], activeId: null });

    await useStore.getState().setSessionModel("claude-haiku-4-5-20251001");

    expect(m.saveSettings).toHaveBeenCalledWith({
      model: "claude-haiku-4-5-20251001",
      reasoningEffort: "medium",
    });
    expect(m.updateSessionModel).not.toHaveBeenCalled();
    expect(useStore.getState().settings.model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("selectSession", () => {
  it("switches instantly while another session continues streaming", async () => {
    useStore.setState({
      streaming: true,
      activeId: "a",
      runs: { a: runState({ streaming: true }) },
    });

    await useStore.getState().selectSession("b");

    expect(useStore.getState().activeId).toBe("b");
    expect(useStore.getState().runs.a.streaming).toBe(true);
    expect(m.getMessages).toHaveBeenCalledWith("b");
  });

  it("switches active session and lazily loads its messages once", async () => {
    const msg: Message = { id: "m", role: "assistant", blocks: [], createdAt: 1 };
    m.getMessages.mockResolvedValue([msg]);

    await useStore.getState().selectSession("b");
    expect(useStore.getState().activeId).toBe("b");
    expect(useStore.getState().messages["b"]).toEqual([msg]);

    // Cached now — a re-select must not refetch.
    m.getMessages.mockClear();
    await useStore.getState().selectSession("b");
    expect(m.getMessages).not.toHaveBeenCalled();
  });

  it("commits selection + cold loading state before history resolves", async () => {
    let release!: (page: { messages: Message[]; nextCursor: string | null }) => void;
    m.getMessagePage.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    useStore.setState({ sessions: [session({ id: "a" }), session({ id: "b" })], activeId: "a" });

    const selecting = useStore.getState().selectSession("b");

    expect(useStore.getState()).toMatchObject({
      activeId: "b",
      messageLoads: { b: { phase: "loading" } },
    });
    release({ messages: [], nextCursor: null });
    await selecting;
    expect(useStore.getState().messageLoads.b.phase).toBe("ready");
  });

  it("deduplicates concurrent hydration requests for one session", async () => {
    let release!: (page: { messages: Message[]; nextCursor: string | null }) => void;
    m.getMessagePage.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    useStore.setState({ sessions: [session({ id: "b" })] });

    const first = useStore.getState().hydrateMessages("b");
    const second = useStore.getState().hydrateMessages("b");
    expect(m.getMessagePage).toHaveBeenCalledTimes(1);

    release({ messages: [], nextCursor: null });
    await Promise.all([first, second]);
  });

  it("renders a fresh cache with zero IPC and refreshes stale cache without losing live rows", async () => {
    const cached: Message = { id: "cached", role: "user", blocks: [], createdAt: 1 };
    useStore.setState({
      sessions: [session({ id: "b" })],
      messages: { b: [cached] },
      messageLoads: {
        b: {
          phase: "ready",
          loadedAt: Date.now(),
          lastAccessedAt: Date.now(),
          requestId: 1,
          error: null,
          nextCursor: "older",
          loadingOlder: false,
        },
      },
    });
    await useStore.getState().hydrateMessages("b");
    expect(m.getMessagePage).not.toHaveBeenCalled();

    let release!: (page: { messages: Message[]; nextCursor: string | null }) => void;
    m.getMessagePage.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    useStore.setState((st) => ({
      messageLoads: { ...st.messageLoads, b: { ...st.messageLoads.b, loadedAt: 0 } },
    }));
    const refreshing = useStore.getState().hydrateMessages("b");
    const live: Message = { id: "live", role: "assistant", blocks: [], createdAt: 2 };
    useStore.setState((st) => ({ messages: { ...st.messages, b: [...st.messages.b, live] } }));
    release({ messages: [cached], nextCursor: null });
    await refreshing;
    expect(useStore.getState().messages.b.map((message) => message.id)).toEqual(["cached", "live"]);
  });

  it("prepends an older desktop page and advances its opaque cursor", async () => {
    const newest: Message = { id: "new", role: "assistant", blocks: [], createdAt: 2 };
    const older: Message = { id: "old", role: "user", blocks: [], createdAt: 1 };
    useStore.setState({
      sessions: [session({ id: "b" })],
      messages: { b: [newest] },
      messageLoads: {
        b: {
          phase: "ready",
          loadedAt: 1,
          lastAccessedAt: 1,
          requestId: 1,
          error: null,
          nextCursor: "page-2",
          loadingOlder: false,
        },
      },
    });
    m.getMessagePage.mockResolvedValueOnce({ messages: [older], nextCursor: null });

    await useStore.getState().loadOlderMessages("b");

    expect(m.getMessagePage).toHaveBeenCalledWith("b", "page-2");
    expect(useStore.getState().messages.b.map((message) => message.id)).toEqual(["old", "new"]);
    expect(useStore.getState().messageLoads.b.nextCursor).toBeNull();
  });

  it("prefetches only inactive local sessions", async () => {
    useStore.setState({
      sessions: [session({ id: "active" }), session({ id: "inactive" })],
      activeId: "active",
    });

    await useStore.getState().prefetchSession("active");
    expect(m.getMessagePage).not.toHaveBeenCalled();

    await useStore.getState().prefetchSession("inactive");
    expect(m.getMessagePage).toHaveBeenCalledWith("inactive", null);
    expect(useStore.getState().messageLoads.inactive.phase).toBe("ready");

    m.getMessagePage.mockClear();
    useStore.setState({ remoteConnected: true });
    await useStore.getState().prefetchSession("another");
    expect(m.getMessagePage).not.toHaveBeenCalled();
  });

  it("evicts least-recent inactive histories while protecting active and busy sessions", async () => {
    const protectedIds = ["active", "running", "background"];
    const idleIds = Array.from({ length: 22 }, (_, index) => `idle-${index}`);
    const allIds = [...protectedIds, ...idleIds, "trigger"];
    const messages = Object.fromEntries(
      allIds.map((id) => [
        id,
        [{ id: `message-${id}`, role: "user" as const, blocks: [], createdAt: 1 }],
      ]),
    );
    const messageLoads = Object.fromEntries(
      [...protectedIds, ...idleIds].map((id, index) => [
        id,
        {
          phase: "ready" as const,
          loadedAt: 1,
          lastAccessedAt: index,
          requestId: 1,
          error: null,
          nextCursor: null,
          loadingOlder: false,
        },
      ]),
    );
    useStore.setState({
      sessions: allIds.map((id) => session({ id })),
      activeId: "active",
      messages,
      messageLoads,
      runs: { running: runState({ streaming: true }) },
      backgroundTasks: {
        background: [{ id: "task", command: "work", status: "running" }],
      },
    });
    m.getMessagePage.mockResolvedValueOnce({
      messages: [{ id: "message-trigger", role: "user", blocks: [], createdAt: 1 }],
      nextCursor: null,
    });

    await useStore.getState().hydrateMessages("trigger", { force: true });

    const state = useStore.getState();
    for (const id of protectedIds) expect(state.messages[id]).toBeDefined();
    expect(state.messages.trigger).toBeDefined();
    expect(state.messages["idle-0"]).toBeUndefined();
    expect(state.messages["idle-1"]).toBeUndefined();
    expect(state.messages["idle-2"]).toBeUndefined();
    expect(state.messageLoads["idle-0"].phase).toBe("idle");
    expect(Object.keys(state.messages)).toHaveLength(23); // 20 cached idle + 3 protected
  });

  it("closes the mobile session drawer on switch", async () => {
    useStore.setState({ showSidebar: true });
    await useStore.getState().selectSession("c");
    expect(useStore.getState().showSidebar).toBe(false);
  });

  it("flags loadErrors[id] when getMessages rejects (no silent welcome screen)", async () => {
    m.getMessages.mockRejectedValue(new Error("disk error"));

    await useStore.getState().selectSession("b");

    const st = useStore.getState();
    expect(st.activeId).toBe("b");
    expect(st.loadErrors.b).toBe(true);
    expect(st.messages.b).toBeUndefined();
  });

  it("retryLoad re-fetches and clears loadErrors[id]", async () => {
    const msg: Message = { id: "m", role: "assistant", blocks: [], createdAt: 1 };
    m.getMessages.mockRejectedValueOnce(new Error("disk error"));
    await useStore.getState().selectSession("b");
    expect(useStore.getState().loadErrors.b).toBe(true);

    m.getMessages.mockResolvedValue([msg]);
    await useStore.getState().retryLoad("b");

    const st = useStore.getState();
    expect(st.loadErrors.b).toBe(false);
    expect(st.messages.b).toEqual([msg]);
  });

  it("retryLoad keeps loadErrors[id] set when the refetch also rejects", async () => {
    m.getMessages.mockRejectedValue(new Error("still down"));

    await useStore.getState().retryLoad("b");

    expect(useStore.getState().loadErrors.b).toBe(true);
  });
});

describe("deleteSession", () => {
  it("refuses to delete a session until it has been archived", async () => {
    useStore.setState({
      sessions: [session({ id: "a" })],
      activeId: "a",
      archivedIds: [],
    });

    await useStore.getState().deleteSession("a");

    expect(m.deleteSession).not.toHaveBeenCalled();
    expect(useStore.getState().sessions.map((row) => row.id)).toEqual(["a"]);
  });

  it("removes the session and re-points activeId at the survivor", async () => {
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      messages: { a: [], b: [] },
      archivedIds: ["a"],
    });

    await useStore.getState().deleteSession("a");

    const st = useStore.getState();
    expect(m.deleteSession).toHaveBeenCalledWith("a");
    expect(st.sessions.map((s) => s.id)).toEqual(["b"]);
    expect(st.activeId).toBe("b");
    expect(st.messages.a).toBeUndefined();
  });

  it("prunes the gone session's usage + draft to stay in lockstep with the backend", () => {
    // The backend (db.rs) deletes the drafts + usage rows on delete_session; the
    // frontend must mirror that, or the deleted session's tokens keep inflating the
    // HUD workspace-total spend (and a dead draft lingers) until a restart.
    localStorage.setItem("pc.drafts", JSON.stringify({ a: "unsent a", b: "unsent b" }));
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      messages: { a: [], b: [] },
      drafts: { a: "unsent a", b: "unsent b" },
      usage: { a: { input: 1000, output: 200 }, b: { input: 50, output: 5 } },
      archivedIds: ["a"],
    });

    return useStore
      .getState()
      .deleteSession("a")
      .then(() => {
        const st = useStore.getState();
        expect(st.usage).toEqual({ b: { input: 50, output: 5 } });
        expect(st.drafts).toEqual({ b: "unsent b" });
        // The localStorage mirror is pruned too, so mergeDrafts won't resurrect it.
        expect(JSON.parse(localStorage.getItem("pc.drafts")!)).toEqual({ b: "unsent b" });
      });
  });

  it("opens a pending new chat when the last session is deleted", async () => {
    useStore.setState({
      sessions: [session({ id: "a" })],
      activeId: "a",
      messages: { a: [] },
      archivedIds: ["a"],
    });

    await useStore.getState().deleteSession("a");

    const st = useStore.getState();
    expect(st.sessions).toEqual([]);
    expect(st.pendingSession?.id).toBe(st.activeId);
    expect(st.pendingSession?.id).not.toBe("a");
    expect(m.createSession).not.toHaveBeenCalled();
  });

  it("lazily loads the surviving active session's history when it wasn't cached", async () => {
    const msg: Message = { id: "m", role: "assistant", blocks: [], createdAt: 1 };
    m.getMessages.mockResolvedValue([msg]);
    // "a" stays active but has no cached messages; deleting the *other* session
    // must trigger a lazy refetch of "a".
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      messages: {},
      archivedIds: ["b"],
    });

    await useStore.getState().deleteSession("b");

    expect(m.deleteSession).toHaveBeenCalledWith("b");
    expect(useStore.getState().activeId).toBe("a");
    expect(useStore.getState().messages.a).toEqual([msg]);
  });

  it("is a no-op while streaming", async () => {
    useStore.setState({
      sessions: [session({ id: "a" })],
      activeId: "a",
      streaming: true,
      archivedIds: ["a"],
    });

    await useStore.getState().deleteSession("a");

    expect(m.deleteSession).not.toHaveBeenCalled();
    expect(useStore.getState().sessions).toHaveLength(1);
  });

  it("flags loadErrors when the surviving session's reload rejects", async () => {
    m.getMessages.mockRejectedValue(new Error("reload failed"));
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      messages: {},
      archivedIds: ["b"],
    });

    await useStore.getState().deleteSession("b");

    const st = useStore.getState();
    expect(st.activeId).toBe("a");
    expect(st.loadErrors.a).toBe(true);
    expect(st.messages.a).toBeUndefined();
  });

  it("surfaces a deleteSession IPC rejection and leaves the list untouched", async () => {
    // A failed delete (locked DB / core not ready) must surface via initError instead
    // of escaping as an unhandled rejection (caller is a bare onClick). The guard runs
    // BEFORE the optimistic mutation, so the row correctly stays — it wasn't deleted.
    m.deleteSession.mockRejectedValue(new Error("locked"));
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      messages: { a: [], b: [] },
      archivedIds: ["a"],
    });

    await expect(useStore.getState().deleteSession("a")).resolves.toBeUndefined();

    const st = useStore.getState();
    expect(st.initError).toBe("locked");
    expect(st.sessions).toHaveLength(2); // the row stays — it wasn't deleted
    expect(st.activeId).toBe("a"); // unchanged
    expect(st.messages.a).toEqual([]); // not removed
  });

  it("drops the deleted session's run from the run map (no leak)", async () => {
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      messages: { a: [], b: [] },
      // Both sessions are idle but each has an entry in the run map.
      runs: {
        a: runState(),
        b: runState(),
      },
      archivedIds: ["b"],
    });

    await useStore.getState().deleteSession("b");

    const st = useStore.getState();
    expect(st.runs.b).toBeUndefined(); // the deleted session's run is gone
    expect(Object.keys(st.runs)).toEqual(["a"]); // only the surviving run remains
    expect(st.activeId).toBe("a"); // active unchanged (we deleted the other one)
  });
});

describe("renameSession", () => {
  it("optimistically applies the trimmed title and persists it via IPC", async () => {
    useStore.setState({ sessions: [session({ id: "a", title: "Old" })], activeId: "a" });
    await useStore.getState().renameSession("a", "  Fresh title  ");
    expect(useStore.getState().sessions[0].title).toBe("Fresh title");
    expect(m.renameSession).toHaveBeenCalledWith("a", "Fresh title");
  });

  it("ignores an empty / whitespace-only rename", async () => {
    useStore.setState({ sessions: [session({ id: "a", title: "Keep" })], activeId: "a" });
    await useStore.getState().renameSession("a", "   ");
    expect(useStore.getState().sessions[0].title).toBe("Keep");
    expect(m.renameSession).not.toHaveBeenCalled();
  });

  it("ignores a no-op rename to the same title", async () => {
    useStore.setState({ sessions: [session({ id: "a", title: "Same" })], activeId: "a" });
    await useStore.getState().renameSession("a", "Same");
    expect(m.renameSession).not.toHaveBeenCalled();
  });

  it("ignores a rename for an unknown session id", async () => {
    useStore.setState({ sessions: [session({ id: "a", title: "A" })], activeId: "a" });
    await useStore.getState().renameSession("ghost", "X");
    expect(m.renameSession).not.toHaveBeenCalled();
    expect(useStore.getState().sessions[0].title).toBe("A");
  });

  it("reverts the optimistic title on a failed write WITHOUT hijacking the init panel", async () => {
    m.renameSession.mockRejectedValueOnce(new Error("locked db"));
    useStore.setState({ sessions: [session({ id: "a", title: "Original" })], activeId: "a" });
    await useStore.getState().renameSession("a", "Doomed");
    const st = useStore.getState();
    expect(st.sessions[0].title).toBe("Original"); // reverted — the visible signal
    // A per-row rename failure must NOT route through initError (the full-screen
    // "Couldn't start Portcode" panel, which would wipe a populated conversation).
    expect(st.initError).toBeNull();
  });

  it("a failing revert does not clobber a title changed during the in-flight write", async () => {
    // The write is pending; meanwhile a newer title lands (a second rename / a
    // send()-derived title). When the write then fails, the revert must be a no-op.
    let reject!: (e: unknown) => void;
    m.renameSession.mockImplementationOnce(() => new Promise((_, rej) => (reject = rej)));
    useStore.setState({ sessions: [session({ id: "a", title: "Original" })], activeId: "a" });
    const pending = useStore.getState().renameSession("a", "Optimistic");
    // A newer write supersedes the optimistic title before the IPC settles.
    useStore.setState((st) => ({
      sessions: st.sessions.map((s) => (s.id === "a" ? { ...s, title: "Newer" } : s)),
    }));
    reject(new Error("boom"));
    await pending;
    // The revert saw the title was no longer "Optimistic", so "Newer" survives.
    expect(useStore.getState().sessions[0].title).toBe("Newer");
  });

  it("renames while a turn is in flight without disturbing that run", async () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "Busy" })],
      activeId: "a",
      streaming: true,
      runs: { a: runState({ streaming: true }) },
    });
    await useStore.getState().renameSession("a", "Nope");
    expect(m.renameSession).toHaveBeenCalledWith("a", "Nope");
    expect(useStore.getState().sessions[0].title).toBe("Nope");
    expect(useStore.getState().runs.a.streaming).toBe(true);
  });

  it("does not rename in remote mode (the phone has no rename command)", async () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "Phone" })],
      activeId: "a",
      remoteConnected: true,
    });
    await useStore.getState().renameSession("a", "Nope");
    expect(m.renameSession).not.toHaveBeenCalled();
    expect(useStore.getState().sessions[0].title).toBe("Phone");
  });
});

describe("send", () => {
  it("ignores empty text, a missing session, or an in-flight turn", async () => {
    useStore.setState({ activeId: null });
    await useStore.getState().send("hi");

    useStore.setState({ activeId: "a", streaming: true });
    await useStore.getState().send("hi");

    useStore.setState({ activeId: "a", streaming: false });
    await useStore.getState().send("   ");

    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it("appends user+assistant turns, titles the first turn, and folds streamed events", async () => {
    let emit!: (e: StreamEvent) => void;
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      emit = onEvent;
      return { cancel: vi.fn(async () => {}), dispose: vi.fn() };
    });
    useStore.setState({
      sessions: [session({ id: "a", title: "New chat" })],
      activeId: "a",
      messages: { a: [] },
    });

    await useStore.getState().send("Refactor the parser");

    let st = useStore.getState();
    expect(st.streaming).toBe(true);
    expect(st.messages.a).toHaveLength(2);
    expect(st.messages.a[0].role).toBe("user");
    expect(st.sessions[0].title).toBe("Refactor the parser"); // derived from first message
    expect(m.runAgent).toHaveBeenCalledWith("a", "Refactor the parser", expect.any(Function));

    const assistant = () => useStore.getState().messages.a[1];

    // text deltas coalesce into a single text block
    emit({ type: "text_delta", text: "Hello " });
    emit({ type: "text_delta", text: "world" });
    expect(assistant().blocks).toEqual([{ kind: "text", text: "Hello world" }]);

    // tool use + result append as their own blocks
    emit({ type: "tool_use", id: "t1", name: "fs_read", input: { path: "x" } });
    emit({ type: "tool_result", id: "t1", output: "ok", isError: false });
    expect(assistant().blocks).toHaveLength(3);

    // usage accumulates per session
    emit({ type: "usage", inputTokens: 100, outputTokens: 40 });
    emit({ type: "usage", inputTokens: 10, outputTokens: 5 });
    expect(useStore.getState().usage.a).toEqual({ input: 110, output: 45 });

    // a permission request surfaces as a pending prompt, carrying its diff
    emit({
      type: "permission_request",
      id: "p1",
      tool: "fs_edit",
      risk: "configurable",
      summary: "x",
      input: {},
      diff: "-a\n+b\n",
    });
    expect(useStore.getState().pendingPermission?.id).toBe("p1");
    expect(useStore.getState().pendingPermission?.risk).toBe("configurable");
    expect(useStore.getState().pendingPermission?.diff).toBe("-a\n+b\n");

    // turn_end clears streaming + any pending prompt
    emit({ type: "turn_end", stopReason: "end_turn" });
    st = useStore.getState();
    expect(st.streaming).toBe(false);
    expect(st.pendingPermission).toBeNull();
  });

  it("reconciles the optimistic assistant to native turn identity and attaches its receipt", async () => {
    const dispose = vi.fn();
    let emit!: (e: StreamEvent) => void;
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      emit = onEvent;
      return { cancel: vi.fn(async () => {}), dispose };
    });
    useStore.setState({
      sessions: [session({ id: "a" })],
      activeId: "a",
      messages: { a: [] },
    });

    await useStore.getState().send("review this");
    const provisionalId = useStore.getState().messages.a[1].id;
    emit({
      type: "turn_start",
      messageId: "native-message",
      turnId: "native-turn",
      startedAt: 100,
    });
    const receipt = turnReceipt({
      turnId: "native-turn",
      changedFiles: [
        {
          path: "src/App.tsx",
          status: "modified",
          additions: 3,
          deletions: 1,
          binary: false,
          certainty: "exact",
        },
      ],
      changedFileCount: 1,
      additions: 3,
      deletions: 1,
    });
    emit({ type: "turn_end", stopReason: "end_turn", receipt });

    const st = useStore.getState();
    expect(provisionalId).not.toBe("native-message");
    expect(st.messages.a).toHaveLength(2);
    expect(st.messages.a[1]).toMatchObject({
      id: "native-message",
      turnId: "native-turn",
      createdAt: 100,
      receipt,
    });
    expect(st.runs.a).toMatchObject({
      streaming: false,
      turnId: "native-turn",
      startedAt: 100,
      receipt,
      outcome: "completed",
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("freezes the completed response while Git finalizes, then replaces provisional facts", async () => {
    const dispose = vi.fn();
    let emit!: (event: StreamEvent) => void;
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      emit = onEvent;
      return { cancel: vi.fn(async () => {}), dispose };
    });
    useStore.setState({
      sessions: [session({ id: "a" })],
      activeId: "a",
      messages: { a: [] },
    });

    await useStore.getState().send("change it");
    emit({
      type: "turn_start",
      messageId: "native-message",
      turnId: "native-turn",
      startedAt: 100,
    });
    emit({ type: "text_delta", text: "Done." });
    emit({
      type: "turn_phase",
      turnId: "native-turn",
      phase: "agent_completed",
      at: 1_600,
      revision: 2,
      status: "completed",
      agentDurationMs: 1_500,
      receiptExpected: true,
    });

    let st = useStore.getState();
    expect(st.streaming).toBe(false);
    expect(st.runs.a).toMatchObject({
      streaming: false,
      finalizing: true,
      cancel: null,
      pendingPermission: null,
      turnId: "native-turn",
      agentDurationMs: 1_500,
      phaseRevision: 2,
      outcome: "completed",
      composerPhase: "idle",
    });
    expect(st.messages.a[1].receipt).toMatchObject({
      turnId: "native-turn",
      agentDurationMs: 1_500,
      changeState: "unknown",
      changeCertainty: "unavailable",
      changedFileCount: 0,
    });
    expect(dispose).not.toHaveBeenCalled();

    // The store enforces the same boundary as the disabled Composer button.
    await useStore.getState().send("too soon");
    expect(m.runAgent).toHaveBeenCalledTimes(1);
    expect(useStore.getState().messages.a).toHaveLength(2);

    const nativeReceipt = turnReceipt({
      turnId: "native-turn",
      completedAt: 4_600,
      durationMs: 4_500,
      changedFiles: [
        {
          path: "src/changed.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          binary: false,
          certainty: "exact",
        },
      ],
      changedFileCount: 1,
      additions: 3,
      deletions: 1,
      changeState: "changed",
    });
    emit({ type: "turn_end", stopReason: "end_turn", receipt: nativeReceipt });

    st = useStore.getState();
    expect(st.runs.a.finalizing).toBe(false);
    expect(st.runs.a.receipt).toMatchObject({
      durationMs: 4_500,
      agentDurationMs: 1_500,
      changeState: "changed",
      changedFileCount: 1,
    });
    expect(st.messages.a[1].receipt).toEqual(st.runs.a.receipt);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("unlocks immediately without Git work and ignores the old listener after a quick follow-up", async () => {
    const emits: Array<(event: StreamEvent) => void> = [];
    const disposes: Array<ReturnType<typeof vi.fn>> = [];
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      emits.push(onEvent);
      const dispose = vi.fn();
      disposes.push(dispose);
      return { cancel: vi.fn(async () => {}), dispose };
    });
    useStore.setState({
      sessions: [session({ id: "a" })],
      activeId: "a",
      messages: { a: [] },
    });

    await useStore.getState().send("just answer");
    emits[0]({
      type: "turn_start",
      messageId: "first-message",
      turnId: "first-turn",
      startedAt: 100,
    });
    emits[0]({
      type: "turn_phase",
      turnId: "first-turn",
      phase: "agent_completed",
      at: 500,
      revision: 1,
      status: "completed",
      agentDurationMs: 400,
      receiptExpected: false,
    });

    expect(useStore.getState().runs.a).toMatchObject({
      streaming: false,
      finalizing: false,
      outcome: "completed",
      agentDurationMs: 400,
    });
    expect(useStore.getState().messages.a[1].receipt).toMatchObject({
      changeState: "none",
      changedFileCount: 0,
    });
    expect(disposes[0]).toHaveBeenCalledOnce();

    await useStore.getState().send("follow up");
    expect(m.runAgent).toHaveBeenCalledTimes(2);
    const secondTurnId = useStore.getState().runs.a.turnId;
    const secondAssistantId = useStore.getState().messages.a[3].id;
    expect(secondTurnId).not.toBe("first-turn");
    expect(useStore.getState().runs.a.streaming).toBe(true);

    // Adversarially invoke the already-disposed callback with the next turn's
    // session-channel traffic. Neither identity reconciliation nor a delta may
    // leak through the stale closure, even if unlisten had a queued delivery.
    emits[0]({
      type: "turn_start",
      messageId: "second-native-message",
      turnId: "second-native-turn",
      startedAt: 600,
    });
    emits[0]({ type: "text_delta", text: "stale duplicate" });
    expect(useStore.getState().runs.a.turnId).toBe(secondTurnId);
    expect(useStore.getState().messages.a[3]).toMatchObject({
      id: secondAssistantId,
      turnId: secondTurnId,
      blocks: [],
    });

    const firstReceipt = turnReceipt({
      turnId: "first-turn",
      startedAt: 100,
      completedAt: 500,
      durationMs: 400,
      changeState: "none",
    });
    emits[0]({ type: "turn_end", stopReason: "end_turn", receipt: firstReceipt });

    const afterStaleTerminal = useStore.getState();
    expect(afterStaleTerminal.runs.a).toMatchObject({
      streaming: true,
      turnId: secondTurnId,
      outcome: null,
    });
    expect(afterStaleTerminal.messages.a[1].receipt).toMatchObject({ turnId: "first-turn" });
    expect(afterStaleTerminal.messages.a[3].receipt).toBeUndefined();
    expect(disposes[0]).toHaveBeenCalledOnce();

    // The live listener remains the sole owner of follow-up events.
    emits[1]({
      type: "turn_start",
      messageId: "second-native-message",
      turnId: "second-native-turn",
      startedAt: 600,
    });
    emits[1]({ type: "text_delta", text: "fresh response" });
    expect(useStore.getState().messages.a[3]).toMatchObject({
      id: "second-native-message",
      turnId: "second-native-turn",
      blocks: [{ kind: "text", text: "fresh response" }],
    });
    emits[1]({ type: "turn_end", stopReason: "end_turn" });
    expect(useStore.getState().runs.a.streaming).toBe(false);
    expect(disposes[1]).toHaveBeenCalledOnce();
  });

  it("ignores stale phase revisions and bounds a lost final receipt", async () => {
    vi.useFakeTimers();
    try {
      const dispose = vi.fn();
      let emit!: (event: StreamEvent) => void;
      m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
        emit = onEvent;
        return { cancel: vi.fn(async () => {}), dispose };
      });
      useStore.setState({
        sessions: [session({ id: "a" })],
        activeId: "a",
        messages: { a: [] },
      });

      await useStore.getState().send("finish safely");
      emit({
        type: "turn_start",
        messageId: "native-turn",
        turnId: "native-turn",
        startedAt: 100,
      });
      emit({
        type: "turn_phase",
        turnId: "native-turn",
        phase: "provider_started",
        at: 110,
        revision: 2,
      });
      emit({
        type: "turn_phase",
        turnId: "native-turn",
        phase: "agent_completed",
        at: 300,
        revision: 1,
        receiptExpected: true,
      });
      expect(useStore.getState().runs.a.streaming).toBe(true);
      expect(useStore.getState().runs.a.phaseRevision).toBe(2);

      emit({
        type: "turn_phase",
        turnId: "native-turn",
        phase: "agent_completed",
        at: 700,
        revision: 3,
        agentDurationMs: 600,
        receiptExpected: true,
      });
      expect(useStore.getState().runs.a.finalizing).toBe(true);
      expect(dispose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(useStore.getState().runs.a).toMatchObject({
        streaming: false,
        finalizing: false,
        outcome: "completed",
        agentDurationMs: 600,
      });
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps listening and locked after Stop until the native cancellation receipt arrives", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async () => {});
      const dispose = vi.fn();
      let emit!: (e: StreamEvent) => void;
      m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
        emit = onEvent;
        return { cancel, dispose };
      });
      useStore.setState({
        sessions: [session({ id: "a" })],
        activeId: "a",
        messages: { a: [] },
      });

      await useStore.getState().send("make a change");
      emit({ type: "turn_start", messageId: "native-turn", startedAt: 100 });
      await useStore.getState().stop();

      let st = useStore.getState();
      expect(cancel).toHaveBeenCalledOnce();
      expect(dispose).not.toHaveBeenCalled();
      expect(st.streaming).toBe(true);
      expect(st.runs.a.finalizing).toBe(true);
      expect(st.messages.a[1].receipt).toBeUndefined();

      const receipt = turnReceipt({
        turnId: "native-turn",
        status: "cancelled",
        stopReason: "cancelled",
        changedFiles: [
          {
            path: "src/cancelled-change.ts",
            status: "modified",
            additions: 2,
            deletions: 1,
            binary: false,
            certainty: "exact",
          },
        ],
        changedFileCount: 1,
        additions: 2,
        deletions: 1,
      });
      emit({ type: "turn_end", stopReason: "cancelled", receipt });

      st = useStore.getState();
      expect(st.messages.a[1]).toMatchObject({ turnId: "native-turn", receipt });
      expect(st.runs.a).toMatchObject({ receipt, outcome: "cancelled", streaming: false });
      expect(dispose).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(31_000);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes a cancelled turn after the receipt grace window when a legacy core stays silent", async () => {
    vi.useFakeTimers();
    try {
      const dispose = vi.fn();
      m.runAgent.mockResolvedValue({ cancel: vi.fn(async () => {}), dispose });
      useStore.setState({
        sessions: [session({ id: "a" })],
        activeId: "a",
        messages: { a: [] },
      });

      await useStore.getState().send("stop this");
      await useStore.getState().stop();
      expect(useStore.getState().streaming).toBe(true);
      expect(useStore.getState().messages.a[1].receipt).toBeUndefined();
      expect(dispose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(useStore.getState().streaming).toBe(false);
      expect(useStore.getState().messages.a[1].receipt).toMatchObject({ status: "cancelled" });
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("trims surrounding whitespace from the stored user bubble and derived title", async () => {
    let emit!: (e: StreamEvent) => void;
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      emit = onEvent;
      return { cancel: vi.fn(async () => {}), dispose: vi.fn() };
    });
    useStore.setState({
      sessions: [session({ id: "a", title: "New chat" })],
      activeId: "a",
      messages: { a: [] },
    });

    await useStore.getState().send("  hi  ");
    emit({ type: "turn_end", stopReason: "end_turn" }); // end the turn so the watchdog can't leak

    const st = useStore.getState();
    expect(st.messages.a[0].blocks).toEqual([{ kind: "text", text: "hi" }]);
    expect(st.sessions[0].title).toBe("hi");
    // The local agent is also prompted with the trimmed body (not the raw padded
    // draft), so what the user sees and what the model receives stay consistent.
    expect(m.runAgent).toHaveBeenCalledWith("a", "hi", expect.any(Function));
  });

  it("trims the forwarded run text in remote mode", async () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "New chat" })],
      activeId: "a",
      messages: { a: [] },
      remoteConnected: true,
    });

    await useStore.getState().send("  do it  ");

    expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({
      cmd: "run",
      session_id: "a",
      text: "do it",
    });
    expect(useStore.getState().messages.a[0].blocks).toEqual([{ kind: "text", text: "do it" }]);
  });

  it("keeps the existing title once a session already has messages", async () => {
    let emit!: (e: StreamEvent) => void;
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      emit = onEvent;
      return { cancel: vi.fn(async () => {}), dispose: vi.fn() };
    });
    const existing: Message = { id: "m0", role: "user", blocks: [], createdAt: 1 };
    useStore.setState({
      sessions: [session({ id: "a", title: "Keep me" })],
      activeId: "a",
      messages: { a: [existing] },
    });

    await useStore.getState().send("another message");
    emit({ type: "turn_end", stopReason: "end_turn" }); // end the turn so the watchdog can't leak

    expect(useStore.getState().sessions[0].title).toBe("Keep me");
  });

  it("surfaces a runAgent rejection as an inline error and stops streaming", async () => {
    m.runAgent.mockRejectedValue(new Error("boom"));
    useStore.setState({ sessions: [session({ id: "a" })], activeId: "a", messages: { a: [] } });

    await useStore.getState().send("hi");

    const st = useStore.getState();
    expect(st.streaming).toBe(false);
    const text = st.messages.a[1].blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
    expect(text).toContain("Error");
    expect(text).toContain("boom");
  });

  it("routes through the remote command path (not the local agent) when connected", async () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "New chat" })],
      activeId: "a",
      messages: { a: [] },
      remoteConnected: true,
    });

    await useStore.getState().send("do it remotely");

    // The desktop is authoritative: we forward a `run` command and DON'T run the
    // local agent. A provisional assistant identity gives pre-turn_start failures
    // an exact receipt target and is reconciled when native turn_start arrives.
    expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({
      cmd: "run",
      session_id: "a",
      text: "do it remotely",
    });
    expect(m.runAgent).not.toHaveBeenCalled();

    const st = useStore.getState();
    expect(st.streaming).toBe(true);
    // Only the optimistic user echo from sendRemoteCommand — no assistant stub.
    expect(st.messages.a).toHaveLength(2);
    expect(st.messages.a[0].role).toBe("user");
    expect(st.messages.a[0].blocks).toEqual([{ kind: "text", text: "do it remotely" }]);
    expect(st.messages.a[1]).toMatchObject({
      role: "assistant",
      turnId: expect.any(String),
      blocks: [],
    });
  });

  it("remote send flips streaming optimistically so a second send can't double-dispatch", async () => {
    // streaming used to stay false until the desktop's turn_start frame returned,
    // leaving the composer enabled across the round-trip — a second Enter would fire
    // a duplicate `run`. Flipping streaming up front closes that window: the second
    // send() is a no-op (the streaming guard at the top of send catches it).
    useStore.setState({
      sessions: [session({ id: "a", title: "New chat" })],
      activeId: "a",
      messages: { a: [] },
      remoteConnected: true,
    });

    await useStore.getState().send("first");
    expect(useStore.getState().streaming).toBe(true);

    // A follow-up before turn_start arrives must NOT fire a second command.
    await useStore.getState().send("second");

    expect(m.phoneSyncSendCommand).toHaveBeenCalledTimes(1);
    expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({
      cmd: "run",
      session_id: "a",
      text: "first",
    });
    // Only the first optimistic user echo — no duplicate user bubble.
    expect(useStore.getState().messages.a).toHaveLength(2);
  });

  it("tears down the turn's listener on turn_end so a later turn can't edit this message", async () => {
    const handles: { cancel: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] = [];
    const emits: ((e: StreamEvent) => void)[] = [];
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      emits.push(onEvent);
      const handle = { cancel: vi.fn(async () => {}), dispose: vi.fn() };
      handles.push(handle);
      return handle;
    });
    useStore.setState({ sessions: [session({ id: "a" })], activeId: "a", messages: { a: [] } });

    // Turn 1 finishes normally.
    await useStore.getState().send("first");
    emits[0]({ type: "text_delta", text: "one" });
    emits[0]({ type: "turn_end", stopReason: "end_turn" });
    // The listener is disposed on a normal end — not merely dropped — so it can't fire again.
    expect(handles[0].dispose).toHaveBeenCalledTimes(1);

    // Turn 2's deltas land on turn 2's message, never turn 1's (the reported bug).
    await useStore.getState().send("second");
    emits[1]({ type: "text_delta", text: "two" });
    emits[1]({ type: "turn_end", stopReason: "end_turn" });

    const msgs = useStore.getState().messages.a;
    expect(msgs[1].blocks).toEqual([{ kind: "text", text: "one" }]); // turn-1 reply unchanged
    expect(msgs[3].blocks).toEqual([{ kind: "text", text: "two" }]); // turn-2 reply
    expect(handles[1].dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the listener when a turn ends in an error event", async () => {
    const dispose = vi.fn();
    let emit!: (e: StreamEvent) => void;
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      emit = onEvent;
      return { cancel: vi.fn(async () => {}), dispose };
    });
    useStore.setState({ sessions: [session({ id: "a" })], activeId: "a", messages: { a: [] } });

    await useStore.getState().send("go");
    emit({ type: "error", message: "kaboom" });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(useStore.getState().streaming).toBe(false);
  });

  it.each([
    [
      "HTTP 429",
      "one@chatgpt.test: HTTP 429 quota exceeded for acct_remote_secret",
      "ChatGPT rate limit or quota was reached.",
    ],
    ["authentication", "HTTP 401 token expired", "ChatGPT authentication failed."],
    ["other HTTP", "HTTP 503 upstream body", "ChatGPT provider request failed."],
  ])(
    "attributes a pinned account's %s error once using safe provider copy",
    async (_case, raw, copy) => {
      const account = openAIAccount();
      let emit!: (event: StreamEvent) => void;
      m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
        emit = onEvent;
        return { cancel: vi.fn(async () => {}), dispose: vi.fn() };
      });
      useStore.setState({
        sessions: [session({ id: "a", model: "gpt-live", accountProfileId: account.id })],
        activeId: "a",
        messages: { a: [] },
        openAIAccounts: [account],
      });

      await useStore.getState().send("go");
      emit({ type: "error", message: raw });

      const text = useStore
        .getState()
        .messages.a[1].blocks.map((block) => (block.kind === "text" ? block.text : ""))
        .join("");
      const label = markdownLiteralText("one@chatgpt.test");
      expect(text).toContain(`${label}: ${copy}`);
      expect(text.split(`${label}:`)).toHaveLength(2);
      expect(text).not.toContain(account.id);
      expect(text).not.toContain("acct_remote_secret");
      expect(text).not.toContain("upstream body");
    },
  );

  it("preserves a pinned session's local durable-turn failure without provider attribution", async () => {
    const account = openAIAccount();
    const localFailure = "Failed to start a durable turn: database is locked";
    let emit!: (event: StreamEvent) => void;
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      emit = onEvent;
      return { cancel: vi.fn(async () => {}), dispose: vi.fn() };
    });
    useStore.setState({
      sessions: [session({ id: "a", model: "gpt-live", accountProfileId: account.id })],
      activeId: "a",
      messages: { a: [] },
      openAIAccounts: [account],
    });

    await useStore.getState().send("go");
    emit({ type: "error", message: localFailure });

    const text = useStore
      .getState()
      .messages.a[1].blocks.map((block) => (block.kind === "text" ? block.text : ""))
      .join("");
    expect(text).toContain(localFailure);
    expect(text).not.toContain("one@chatgpt.test:");
    expect(text).not.toContain(markdownLiteralText("one@chatgpt.test"));
    expect(text).not.toContain("ChatGPT request failed");
  });

  it.each([
    "OpenAI response was incomplete. Please retry.",
    "The OpenAI response stream ended before response.completed. Please try again.",
    "ChatGPT response stream stalled. Please try again.",
  ])("attributes a display-safe native provider failure to its pinned account: %s", async (raw) => {
    const account = openAIAccount();
    let emit!: (event: StreamEvent) => void;
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      emit = onEvent;
      return { cancel: vi.fn(async () => {}), dispose: vi.fn() };
    });
    useStore.setState({
      sessions: [session({ id: "a", model: "gpt-live", accountProfileId: account.id })],
      activeId: "a",
      messages: { a: [] },
      openAIAccounts: [account],
    });

    await useStore.getState().send("go");
    emit({ type: "error", message: raw });

    const text = useStore
      .getState()
      .messages.a[1].blocks.map((block) => (block.kind === "text" ? block.text : ""))
      .join("");
    const label = markdownLiteralText("one@chatgpt.test");
    expect(text).toContain(`${label}: ${raw}`);
    expect(text.split(`${label}:`)).toHaveLength(2);
    expect(text).not.toContain(account.id);
  });

  it("escapes nested Markdown, image, autolink, and HTML syntax in root error attribution", async () => {
    const hostileLabel =
      "![root [nested]](https://evil.test/pixel) <img src=x> &lbrack;entity&rbrack;";
    const account = openAIAccount({ accountLabel: hostileLabel });
    let emit!: (event: StreamEvent) => void;
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      emit = onEvent;
      return { cancel: vi.fn(async () => {}), dispose: vi.fn() };
    });
    useStore.setState({
      sessions: [session({ id: "a", model: "gpt-live", accountProfileId: account.id })],
      activeId: "a",
      messages: { a: [] },
      openAIAccounts: [account],
    });

    await useStore.getState().send("go");
    emit({ type: "error", message: "HTTP 503 upstream body" });

    const text = useStore
      .getState()
      .messages.a[1].blocks.map((block) => (block.kind === "text" ? block.text : ""))
      .join("");
    expect(text).toContain(
      `${markdownLiteralText(hostileLabel)}: ChatGPT provider request failed.`,
    );
    expect(text).not.toContain(account.id);
  });

  it("recovers a hung turn via the idle watchdog so future sends aren't bricked", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async () => {});
      m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
        // The turn starts streaming, then the backend goes silent — no turn_end/error.
        onEvent({ type: "text_delta", text: "thinking" });
        return { cancel, dispose: vi.fn() };
      });
      useStore.setState({ sessions: [session({ id: "a" })], activeId: "a", messages: { a: [] } });

      await useStore.getState().send("hello?");
      expect(useStore.getState().streaming).toBe(true);

      // Idle past the watchdog window → the turn is force-ended and the hung run cancelled.
      await vi.advanceTimersByTimeAsync(152_000);

      expect(useStore.getState().streaming).toBe(true);
      expect(useStore.getState().runs.a.finalizing).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);

      const st = useStore.getState();
      expect(st.streaming).toBe(false);
      expect(cancel).toHaveBeenCalled();
      const text = st.messages.a[1].blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
      expect(text).toContain("timed out");

      // The composer is usable again: the next send actually runs (not a silent no-op).
      m.runAgent.mockClear();
      await useStore.getState().send("retry");
      expect(m.runAgent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a timed-out run locked when watchdog cancellation is not acknowledged", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async () => {
        throw new Error("cancel transport down");
      });
      m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
        onEvent({ type: "text_delta", text: "thinking" });
        return { cancel, dispose: vi.fn() };
      });
      useStore.setState({ sessions: [session({ id: "a" })], activeId: "a", messages: { a: [] } });

      await useStore.getState().send("hello?");
      await vi.advanceTimersByTimeAsync(152_000);

      const st = useStore.getState();
      expect(cancel).toHaveBeenCalled();
      expect(st.streaming).toBe(true);
      expect(st.composerPhase).toBe("thinking");
      const text = st.messages.a[1].blocks
        .map((block) => (block.kind === "text" ? block.text : ""))
        .join("");
      expect(text).toContain("cancellation could not be confirmed");
      expect(text).toContain("may still be running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a hung REMOTE turn via the idle watchdog so the phone composer isn't stranded", async () => {
    // Symmetric with the local watchdog: in remote mode only a desktop live frame can
    // clear `streaming`. If the channel stays up but the desktop's agent dies without
    // emitting turn_end/error (no drop), nothing would recover the composer. The
    // remote watchdog force-ends the silent turn after the idle window.
    vi.useFakeTimers();
    try {
      useStore.setState({
        sessions: [session({ id: "a", title: "New chat" })],
        activeId: "a",
        messages: { a: [] },
        remoteConnected: true,
      });

      await useStore.getState().send("do it");
      expect(useStore.getState().streaming).toBe(true);
      expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({
        cmd: "run",
        session_id: "a",
        text: "do it",
      });

      // No live frame arrives. Idle past the watchdog window → the turn force-ends.
      await vi.advanceTimersByTimeAsync(152_000);

      const st = useStore.getState();
      expect(st.streaming).toBe(false);
      expect(st.pendingPermission).toBeNull();
      const text = st.messages.a[st.messages.a.length - 1].blocks
        .map((b) => (b.kind === "text" ? b.text : ""))
        .join("");
      expect(text).toContain("timed out");
      expect(st.messages.a[st.messages.a.length - 1].receipt).toMatchObject({
        status: "interrupted",
        changeCertainty: "unavailable",
      });
      expect(st.runs.a.outcome).toBe("interrupted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a remote live frame for the active session resets the idle watchdog", async () => {
    // Activity keeps the watchdog from firing: a live frame mid-window must reset
    // last-activity so a still-streaming turn isn't falsely timed out.
    vi.useFakeTimers();
    try {
      useStore.setState({
        sessions: [session({ id: "a", title: "New chat" })],
        activeId: "a",
        messages: { a: [] },
        remoteConnected: true,
      });

      await useStore.getState().send("do it");
      expect(useStore.getState().streaming).toBe(true);

      // Just before the window elapses, a live frame arrives (the desktop is alive).
      await vi.advanceTimersByTimeAsync(149_000);
      useStore
        .getState()
        .applyFrame({ t: "live", session_id: "a", event: { type: "turn_start", messageId: "m1" } });

      // Another almost-full window passes; without the reset the watchdog would have
      // fired by now, but the live frame kept the turn alive.
      await vi.advanceTimersByTimeAsync(140_000);
      expect(useStore.getState().streaming).toBe(true);

      // Now go fully idle past the window from the last activity → it finally recovers.
      await vi.advanceTimersByTimeAsync(152_000);
      expect(useStore.getState().streaming).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a remote turn_end clears the idle watchdog so it can't fire after a clean finish", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({
        sessions: [session({ id: "a", title: "New chat" })],
        activeId: "a",
        messages: { a: [] },
        remoteConnected: true,
      });

      await useStore.getState().send("do it");
      // The desktop builds the assistant message, then finishes the turn cleanly.
      useStore
        .getState()
        .applyFrame({ t: "live", session_id: "a", event: { type: "turn_start", messageId: "m1" } });
      useStore.getState().applyFrame({
        t: "live",
        session_id: "a",
        event: { type: "turn_end", stopReason: "end_turn" },
      });
      expect(useStore.getState().streaming).toBe(false);

      // Append a fresh assistant block so a (wrongly) still-armed watchdog would be
      // detectable by a spurious timed-out note. Advancing well past the window must
      // NOT re-flip streaming or append a timeout note.
      await vi.advanceTimersByTimeAsync(200_000);

      const st = useStore.getState();
      expect(st.streaming).toBe(false);
      const text = st.messages.a
        .flatMap((msg) => msg.blocks)
        .map((b) => (b.kind === "text" ? b.text : ""))
        .join("");
      expect(text).not.toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Stop during runAgent await cancels once, then disposes on the terminal event", async () => {
    // The cancel handle is only armed AFTER runAgent resolves. If the user presses
    // Stop in that window, stop() can't invoke a (null) cancel — so the post-await
    // block must honor the already-flipped streaming:false by cancelling the
    // still-pending backend turn and disposing the listener (no stale Stop re-armed,
    // no further deltas folded in).
    const cancel = vi.fn(async () => {});
    const dispose = vi.fn();
    let resolveRun!: (h: { cancel: typeof cancel; dispose: typeof dispose }) => void;
    let emit!: (event: StreamEvent) => void;
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      emit = onEvent;
      return new Promise((res) => {
        resolveRun = res;
      });
    });
    useStore.setState({ sessions: [session({ id: "a" })], activeId: "a", messages: { a: [] } });

    // Kick off the turn; runAgent stays pending (cancel handle not yet armed).
    const sending = useStore.getState().send("hello");
    expect(useStore.getState().streaming).toBe(true);
    expect(useStore.getState().cancel).toBeNull(); // handle not armed during the await

    // User presses Stop mid-await — there's no cancel handle to invoke yet.
    await useStore.getState().stop();
    expect(useStore.getState().streaming).toBe(true);
    expect(useStore.getState().composerPhase).toBe("stopping");

    // Now the backend handle resolves. The post-await block must cancel it
    // (cancel_agent + unlisten), since Stop couldn't reach it earlier.
    resolveRun({ cancel, dispose });
    await sending;

    expect(cancel).toHaveBeenCalledTimes(1); // backend turn actually aborted
    expect(useStore.getState().streaming).toBe(true);
    expect(useStore.getState().runs.a.finalizing).toBe(true);
    emit({ type: "turn_end", stopReason: "cancelled" });
    expect(useStore.getState().streaming).toBe(false);
    expect(useStore.getState().cancel).toBeNull(); // no stale Stop re-armed
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("stop", () => {
  it("cancels the active run and clears streaming flags", async () => {
    const cancel = vi.fn(async () => {});
    useStore.setState({
      sessions: [session({ id: "a" })],
      activeId: "a",
      messages: {
        a: [
          {
            id: "assistant",
            role: "assistant",
            blocks: [{ kind: "tool_use", id: "t1", name: "shell", input: {} }],
            createdAt: 1,
          },
        ],
      },
      agents: {
        a: [{ id: "child", description: "check", status: "running", step: 1 }],
      },
      streaming: true,
      cancel,
      pendingPermission: { id: "p", tool: "t", summary: "s", input: {} },
    });

    await useStore.getState().stop();

    expect(cancel).toHaveBeenCalledTimes(1);
    const st = useStore.getState();
    expect(st.streaming).toBe(false);
    expect(st.cancel).toBeNull();
    expect(st.pendingPermission).toBeNull();
    expect(st.messages.a[0].blocks).toContainEqual(
      expect.objectContaining({
        kind: "tool_result",
        toolUseId: "t1",
        isError: true,
        output: expect.stringContaining("Interrupted:"),
      }),
    );
    expect(st.agents.a[0].status).toBe("cancelled");
    expect(st.messages.a[0].receipt).toMatchObject({
      turnId: "assistant",
      status: "cancelled",
      changeCertainty: "unavailable",
    });
  });

  it("keeps the run locked and surfaces uncertainty when cancel_agent rejects", async () => {
    // A rejected cancel is not proof the backend stopped. Keep the listener/run lock
    // alive so the user cannot start a conflicting second turn, and state uncertainty.
    const cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    useStore.setState({
      sessions: [session({ id: "a" })],
      activeId: "a",
      messages: {
        a: [
          {
            id: "assistant",
            role: "assistant",
            blocks: [{ kind: "tool_use", id: "t1", name: "shell", input: {} }],
            createdAt: 1,
          },
        ],
      },
      streaming: true,
      cancel,
      pendingPermission: { id: "p", tool: "t", summary: "s", input: {} },
    });

    await expect(useStore.getState().stop()).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledTimes(1);
    const st = useStore.getState();
    expect(st.streaming).toBe(true);
    expect(st.cancel).toBe(cancel);
    expect(st.pendingPermission).not.toBeNull();
    expect(st.composerPhase).toBe("thinking");
    expect(st.messages.a[0].blocks).not.toContainEqual(
      expect.objectContaining({ kind: "tool_result", toolUseId: "t1" }),
    );
    expect(st.messages.a[0].blocks).toContainEqual(
      expect.objectContaining({
        kind: "text",
        text: expect.stringContaining("Stop could not be confirmed"),
      }),
    );
  });

  it("stops a remote turn with a Cancel command, not the (absent) local cancel", async () => {
    const cancel = vi.fn(async () => {});
    useStore.setState({
      remoteConnected: true,
      activeId: "s1",
      streaming: true,
      cancel,
      messages: {
        s1: [
          {
            id: "remote-turn",
            role: "assistant",
            blocks: [],
            createdAt: 1,
            turnId: "remote-turn",
          },
        ],
      },
      runs: { s1: runState({ streaming: true, turnId: "remote-turn", startedAt: 1 }) },
    });

    await useStore.getState().stop();

    expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({ cmd: "cancel", session_id: "s1" });
    expect(cancel).not.toHaveBeenCalled();
    expect(useStore.getState().streaming).toBe(true);
    expect(useStore.getState().runs.s1.finalizing).toBe(true);
    useStore.getState().applyFrame({
      t: "live",
      session_id: "s1",
      event: {
        type: "turn_end",
        stopReason: "cancelled",
        receipt: turnReceipt({ turnId: "remote-turn", status: "cancelled" }),
      },
    });
    expect(useStore.getState().streaming).toBe(false);
  });

  it("a delayed remote cancellation receipt patches the old turn without stopping its successor", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({
        sessions: [session({ id: "s1" })],
        activeId: "s1",
        messages: { s1: [] },
        remoteConnected: true,
      });
      await useStore.getState().send("old turn");
      useStore.getState().applyFrame({
        t: "live",
        session_id: "s1",
        event: { type: "turn_start", messageId: "old-turn", startedAt: 100 },
      });

      await useStore.getState().stop();
      expect(useStore.getState().streaming).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(useStore.getState().streaming).toBe(false);

      await useStore.getState().send("new turn");
      useStore.getState().applyFrame({
        t: "live",
        session_id: "s1",
        event: { type: "turn_start", messageId: "new-turn", startedAt: 500 },
      });
      const oldReceipt = turnReceipt({
        turnId: "old-turn",
        status: "cancelled",
        stopReason: "cancelled",
        changedFiles: [
          {
            path: "src/old.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            binary: false,
            certainty: "exact",
          },
        ],
        changedFileCount: 1,
        additions: 1,
      });
      useStore.getState().applyFrame({
        t: "live",
        session_id: "s1",
        event: { type: "turn_end", stopReason: "cancelled", receipt: oldReceipt },
      });

      let st = useStore.getState();
      expect(st.runs.s1).toMatchObject({ streaming: true, turnId: "new-turn" });
      expect(st.messages.s1.find((message) => message.turnId === "old-turn")?.receipt).toEqual(
        oldReceipt,
      );
      expect(
        st.messages.s1.find((message) => message.turnId === "new-turn")?.receipt,
      ).toBeUndefined();

      const newReceipt = turnReceipt({ turnId: "new-turn" });
      useStore.getState().applyFrame({
        t: "live",
        session_id: "s1",
        event: { type: "turn_end", stopReason: "end_turn", receipt: newReceipt },
      });
      st = useStore.getState();
      expect(st.streaming).toBe(false);
      expect(st.messages.s1.find((message) => message.turnId === "new-turn")?.receipt).toEqual(
        newReceipt,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolvePermission", () => {
  it("does nothing when no permission is pending", async () => {
    useStore.setState({ pendingPermission: null });

    await useStore.getState().resolvePermission("allow");

    expect(m.resolvePermission).not.toHaveBeenCalled();
  });

  it("forwards the decision and clears the prompt", async () => {
    useStore.setState({
      pendingPermission: { id: "p1", tool: "fs_edit", summary: "x", input: {} },
    });

    await useStore.getState().resolvePermission("deny");

    expect(m.resolvePermission).toHaveBeenCalledWith("p1", "deny");
    expect(useStore.getState().pendingPermission).toBeNull();
  });

  it("allow-always canonicalizes a legacy file-tool rule", async () => {
    useStore.setState({
      pendingPermission: { id: "p1", tool: "fs_edit", summary: "x", input: {} },
    });

    await useStore.getState().resolvePermission("allow", true);

    // A file tool scopes to its canonical ID, not allow-everything.
    expect(m.saveSettings).toHaveBeenCalledWith({
      rules: [{ tool: "edit_file", decision: "allow" }],
    });
    expect(m.resolvePermission).toHaveBeenCalledWith("p1", "allow");
  });

  it("allow-always canonicalizes a legacy command tool and scopes it to that command", async () => {
    useStore.setState({
      pendingPermission: {
        id: "p2",
        tool: "shell",
        summary: "git status",
        input: { command: "git status" },
      },
    });

    await useStore.getState().resolvePermission("allow", true);

    expect(m.saveSettings).toHaveBeenCalledWith({
      rules: [{ tool: "run_command", command: "git status", decision: "allow" }],
    });
  });

  it.each(["shell", "dependencyInstall", "highRiskGit", "unknown", "futureRisk"] as const)(
    "refuses to remember %s approval while still resolving the one-shot gate",
    async (risk) => {
      useStore.setState({
        pendingPermission: {
          id: `protected-${risk}`,
          tool: "run_command",
          risk,
          summary: "protected action",
          input: { command: "echo safe" },
        },
      });

      await useStore.getState().resolvePermission("allow", true);

      expect(m.resolvePermission).toHaveBeenCalledWith(`protected-${risk}`, "allow");
      expect(m.saveSettings).not.toHaveBeenCalled();
      expect(useStore.getState().pendingPermission).toBeNull();
    },
  );

  it("allow-always does not add a duplicate rule if an equivalent one exists", async () => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, rules: [{ tool: "fs_edit", decision: "allow" }] },
      pendingPermission: { id: "p3", tool: "edit_file", summary: "x", input: {} },
    });

    await useStore.getState().resolvePermission("allow", true);

    // The gate is still answered, but no redundant settings save is made.
    expect(m.resolvePermission).toHaveBeenCalledWith("p3", "allow");
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("allow-always replaces a conflicting rule for the same scope", async () => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, rules: [{ tool: "fs_edit", decision: "ask" }] },
      pendingPermission: { id: "p-conflict", tool: "edit_file", summary: "x", input: {} },
    });

    await useStore.getState().resolvePermission("allow", true);

    expect(m.saveSettings).toHaveBeenCalledWith({
      rules: [{ tool: "edit_file", decision: "allow" }],
    });
  });

  it("allow-always moves a scoped command allow ahead of a broader shadowing rule", async () => {
    useStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        rules: [
          { tool: "run_command", decision: "ask" },
          { tool: "shell", command: "git status", decision: "allow" },
        ],
      },
      pendingPermission: {
        id: "p-shadowed",
        tool: "run_command",
        summary: "git status",
        input: { command: "git status" },
      },
    });

    await useStore.getState().resolvePermission("allow", true);

    expect(m.saveSettings).toHaveBeenCalledWith({
      rules: [
        { tool: "run_command", command: "git status", decision: "allow" },
        { tool: "run_command", decision: "ask" },
      ],
    });
  });

  it("treats a saved legacy command rule as equivalent to a canonical request", async () => {
    useStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        rules: [{ tool: "shell", command: "git status", decision: "allow" }],
      },
      pendingPermission: {
        id: "p4",
        tool: "run_command",
        summary: "git status",
        input: { command: "git status" },
      },
    });

    await useStore.getState().resolvePermission("allow", true);

    expect(m.resolvePermission).toHaveBeenCalledWith("p4", "allow");
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("answers the gate FIRST and persists allow-always after (ordered)", async () => {
    // The backend gate must be answered before the best-effort policy save, so a
    // failing save can never strand the prompt or leave the gate unanswered.
    const calls: string[] = [];
    m.resolvePermission.mockImplementationOnce(async () => {
      calls.push("resolve");
    });
    m.saveSettings.mockImplementationOnce(async (s) => {
      calls.push("save");
      return { ...DEFAULT_SETTINGS, ...s };
    });
    useStore.setState({
      pendingPermission: { id: "p1", tool: "fs_edit", summary: "x", input: {} },
    });

    await useStore.getState().resolvePermission("allow", true);

    expect(calls).toEqual(["resolve", "save"]);
  });

  it("still answers the gate and clears the prompt when the policy save rejects", async () => {
    // saveSettings now runs AFTER the gate is answered, so its rejection can't
    // strand the banner or leave the backend gate unanswered.
    m.saveSettings.mockRejectedValueOnce(new Error("disk full"));
    useStore.setState({
      pendingPermission: { id: "p1", tool: "fs_edit", summary: "x", input: {} },
    });

    await useStore.getState().resolvePermission("allow", true);

    expect(m.resolvePermission).toHaveBeenCalledWith("p1", "allow");
    const st = useStore.getState();
    expect(st.pendingPermission).toBeNull();
    // The failed best-effort policy save surfaces via settingsError (updateSettings).
    expect(st.settingsError).toBe("disk full");
  });

  it("does not resolve a superseding request when a stale click lands mid-await", async () => {
    // A newer permission request can arrive while we await the backend resolve.
    // A stale click must not then clear or answer the new prompt.
    const newer = { id: "p2", tool: "fs_edit", summary: "newer", input: {} };
    m.resolvePermission.mockImplementationOnce(async () => {
      useStore.setState({ pendingPermission: newer });
    });
    useStore.setState({
      pendingPermission: { id: "p1", tool: "fs_edit", summary: "stale", input: {} },
    });

    // The captured request (p1) is answered and the allow-always policy save still
    // runs; it just never touches pendingPermission, so the newer prompt that
    // arrived mid-await stays pending (the pre-await guard only blocks answering a
    // request whose id changed before the await began).
    await useStore.getState().resolvePermission("allow", true);

    // p1 was answered, but the newer prompt that arrived mid-await stays pending.
    expect(m.resolvePermission).toHaveBeenCalledWith("p1", "allow");
    expect(useStore.getState().pendingPermission).toEqual(newer);
  });

  it("answers once in remote mode and never persists an allow rule", async () => {
    useStore.setState({
      remoteConnected: true,
      pendingPermission: { id: "p1", tool: "fs_edit", summary: "x", input: {} },
    });

    await useStore.getState().resolvePermission("allow", true);

    expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({
      cmd: "permission",
      id: "p1",
      decision: "allow",
    });
    expect(m.resolvePermission).not.toHaveBeenCalled();
    expect(m.saveSettings).not.toHaveBeenCalled();
    expect(useStore.getState().pendingPermission).toBeNull();
  });

  it("fails closed when the remote shell is disconnected", async () => {
    const pending = { id: "p-disconnected", tool: "fs_edit", summary: "x", input: {} };
    useStore.setState({
      remoteMode: true,
      remoteConnected: false,
      pendingPermission: pending,
    });

    await useStore.getState().resolvePermission("allow", true);

    expect(m.phoneSyncSendCommand).not.toHaveBeenCalled();
    expect(m.resolvePermission).not.toHaveBeenCalled();
    expect(m.saveSettings).not.toHaveBeenCalled();
    expect(useStore.getState().pendingPermission).toEqual(pending);
  });
});

describe("multi-run model (runs collection)", () => {
  // Fold a live frame for an arbitrary session into the run map (the path the
  // phone uses for a desktop turn). turn_start/turn_end drive the per-run state.
  const live = (sessionId: string, event: StreamEvent) =>
    useStore.getState().applyFrame({ t: "live", session_id: sessionId, event });

  it("represents two sessions streaming concurrently, with the mirror tracking only the active one", () => {
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      runs: {},
    });

    live("a", { type: "turn_start", messageId: "ma" });
    live("b", { type: "turn_start", messageId: "mb" });

    const st = useStore.getState();
    // BOTH runs stream in the map — the capability a single global flag could
    // never represent (the foundation for a parallel-agents UI).
    expect(st.runs.a.streaming).toBe(true);
    expect(st.runs.b.streaming).toBe(true);
    // The visible mirror reflects only the active session ("a").
    expect(st.streaming).toBe(true);
  });

  it("the active-run mirror re-projects when the active session changes", async () => {
    // "a" is idle, "b" has a live background run.
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      runs: {
        a: runState(),
        b: runState({ streaming: true }),
      },
      streaming: false,
    });
    // selectSession is blocked only while the ACTIVE session streams; "a" is idle,
    // so the switch goes through and the mirror must follow "b"'s run.
    await useStore.getState().selectSession("b");
    expect(useStore.getState().streaming).toBe(true);
  });

  it("clearing one session's run leaves another's untouched", () => {
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      runs: {},
    });
    live("a", { type: "turn_start", messageId: "ma" });
    live("b", { type: "turn_start", messageId: "mb" });

    live("b", { type: "turn_end", stopReason: "end_turn" }); // end only "b"

    const st = useStore.getState();
    expect(st.runs.a.streaming).toBe(true); // "a" still streaming
    expect(st.runs.b.streaming).toBe(false); // "b" done
    expect(st.streaming).toBe(true); // mirror still reflects active "a"
  });

  it("stop() clears the ACTIVE run (and its mirror) while leaving a concurrent run untouched", async () => {
    // Both the active "a" and a background "b" are streaming in the map; stop()
    // must clear only "a" (the run on screen) and re-project, not touch "b". This
    // exercises patchActiveRun's activeId-present branch (the production path).
    const cancel = vi.fn(async () => {});
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      runs: {
        a: runState({ streaming: true, cancel, turnId: "a-turn", startedAt: 1 }),
        b: runState({ streaming: true, turnId: "b-turn", startedAt: 1 }),
      },
      streaming: true,
      cancel,
    });

    await useStore.getState().stop();

    const st = useStore.getState();
    expect(cancel).toHaveBeenCalledOnce(); // the active run's handle was aborted
    expect(st.runs.a).toEqual(
      expect.objectContaining({ streaming: false, cancel: null, pendingPermission: null }),
    );
    expect(st.streaming).toBe(false); // mirror re-projected from "a"
    expect(st.cancel).toBeNull();
    // The concurrent background run is undisturbed.
    expect(st.runs.b).toEqual(
      expect.objectContaining({ streaming: true, cancel: null, pendingPermission: null }),
    );
  });
});

describe("cyclePermissionMode", () => {
  it("advances through the safe trio default → acceptEdits → plan → default", async () => {
    const seed = (permissionMode: "default" | "acceptEdits" | "plan") =>
      useStore.setState({ settings: { ...DEFAULT_SETTINGS, permissionMode } });

    seed("default");
    await useStore.getState().cyclePermissionMode();
    expect(m.saveSettings).toHaveBeenLastCalledWith({ permissionMode: "acceptEdits" });

    seed("acceptEdits");
    await useStore.getState().cyclePermissionMode();
    expect(m.saveSettings).toHaveBeenLastCalledWith({ permissionMode: "plan" });

    seed("plan");
    await useStore.getState().cyclePermissionMode();
    expect(m.saveSettings).toHaveBeenLastCalledWith({ permissionMode: "default" });
  });

  it("never cycles INTO auto/bypass, and cycling out of one lands on default", async () => {
    // auto/bypass are Settings-only opt-in; the quick-cycle must not reach them,
    // and stepping the cycle while in one returns to the safe start.
    for (const danger of ["auto", "bypass"] as const) {
      useStore.setState({ settings: { ...DEFAULT_SETTINGS, permissionMode: danger } });
      await useStore.getState().cyclePermissionMode();
      expect(m.saveSettings).toHaveBeenLastCalledWith({ permissionMode: "default" });
    }
  });

  it("blocks a shared permission-mode change while any session is busy", async () => {
    useStore.setState({
      activeId: "idle",
      runs: { background: runState({ streaming: true }) },
      streaming: false,
      settings: { ...DEFAULT_SETTINGS, permissionMode: "default" },
    });

    await useStore.getState().cyclePermissionMode();

    expect(m.saveSettings).not.toHaveBeenCalled();
    expect(useStore.getState().settings.permissionMode).toBe("default");
  });
});

describe("draft + UI setters", () => {
  const draftOf = (id: string) => useStore.getState().drafts[id];

  // setDraft schedules a ~400ms debounced backend write; fake timers keep that
  // pending timer from firing into a later test's saveDraft assertions.
  it("appendDraft inserts a single separating space only when needed", () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ activeId: "s1" });
      const { setDraft, appendDraft } = useStore.getState();

      setDraft("");
      appendDraft("@a.ts"); // empty draft -> no leading space
      expect(draftOf("s1")).toBe("@a.ts ");

      setDraft("foo"); // no trailing space -> separator added
      appendDraft("bar");
      expect(draftOf("s1")).toBe("foo bar ");

      setDraft("foo "); // already trailing space -> no double space
      appendDraft("bar");
      expect(draftOf("s1")).toBe("foo bar ");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps drafts isolated per session and mirrors them to localStorage", () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ activeId: "a" });
      useStore.getState().setDraft("draft for a");
      useStore.setState({ activeId: "b" });
      useStore.getState().setDraft("draft for b");

      // A draft typed in one session never bleeds into another (the bug per-session
      // drafts fix). Each is keyed by its own session id.
      expect(useStore.getState().drafts).toEqual({ a: "draft for a", b: "draft for b" });
      // Optimistic localStorage mirror is written synchronously for instant restore.
      expect(JSON.parse(localStorage.getItem("pc.drafts")!)).toEqual({
        a: "draft for a",
        b: "draft for b",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clearing a draft drops its key from the map and the mirror", () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ activeId: "a" });
      useStore.getState().setDraft("something");
      useStore.getState().setDraft("");
      expect(useStore.getState().drafts).toEqual({});
      expect(JSON.parse(localStorage.getItem("pc.drafts")!)).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounces the durable draft save (~400ms), coalescing keystrokes", () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ activeId: "a" });
      useStore.getState().setDraft("h");
      useStore.getState().setDraft("he");
      useStore.getState().setDraft("hel");
      // No backend write yet — the debounce coalesces the burst.
      expect(m.saveDraft).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
      // Exactly one durable write, carrying the latest value.
      expect(m.saveDraft).toHaveBeenCalledTimes(1);
      expect(m.saveDraft).toHaveBeenCalledWith("a", "hel");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("composer drafts on send", () => {
  beforeEach(() => {
    useStore.setState({
      sessions: [session({ id: "a" })],
      activeId: "a",
      messages: { a: [] },
    });
  });

  it("clears the sent session's draft everywhere, flushing the backend immediately", async () => {
    vi.useFakeTimers();
    try {
      useStore.getState().setDraft("a half-written thought");
      expect(useStore.getState().drafts.a).toBe("a half-written thought");

      await useStore.getState().send("ship it");

      // The open loop is closed: in-memory map + localStorage mirror cleared, and the
      // durable backend cleared IMMEDIATELY (not waiting on the debounce) so a fast
      // restart can't restore a just-sent draft.
      expect(useStore.getState().drafts.a).toBeUndefined();
      expect(JSON.parse(localStorage.getItem("pc.drafts")!)).toEqual({});
      expect(m.saveDraft).toHaveBeenLastCalledWith("a", "");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("composer presence phase", () => {
  // Start a real local turn and hand back the captured stream-event emitter so each
  // test can drive presence transitions from real events.
  const startTurn = async (): Promise<(e: StreamEvent) => void> => {
    let emit!: (e: StreamEvent) => void;
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      emit = onEvent;
      return { cancel: vi.fn(async () => {}), dispose: vi.fn() };
    });
    useStore.setState({ sessions: [session({ id: "a" })], activeId: "a", messages: { a: [] } });
    await useStore.getState().send("do a thing");
    return emit;
  };

  it("acknowledges the send instantly with the received phase", async () => {
    const emit = await startTurn();
    // Turn-taking receipt: the phase flips to "received" the moment the turn is sent.
    expect(useStore.getState().composerPhase).toBe("received");
    emit({ type: "turn_end", stopReason: "end_turn" });
  });

  it("settles received → thinking on the first real stream event", async () => {
    const emit = await startTurn();
    expect(useStore.getState().composerPhase).toBe("received");
    emit({ type: "text_delta", text: "Hi" });
    expect(useStore.getState().composerPhase).toBe("thinking");
    emit({ type: "turn_end", stopReason: "end_turn" });
  });

  it("falls back to thinking after ~900ms when the first byte is slow", async () => {
    vi.useFakeTimers();
    try {
      const emit = await startTurn();
      expect(useStore.getState().composerPhase).toBe("received");
      // No real event yet — the fallback timer (NOT padded latency) advances the
      // phase so the presence doesn't sit on "reading…" forever.
      vi.advanceTimersByTime(900);
      expect(useStore.getState().composerPhase).toBe("thinking");
      emit({ type: "turn_end", stopReason: "end_turn" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns to idle on turn_end and on a turn error", async () => {
    const emit = await startTurn();
    emit({ type: "text_delta", text: "x" });
    emit({ type: "turn_end", stopReason: "end_turn" });
    expect(useStore.getState().composerPhase).toBe("idle");

    const emit2 = await startTurn();
    emit2({ type: "error", message: "boom" });
    expect(useStore.getState().composerPhase).toBe("idle");
  });

  it("relabels to stopping the instant Stop is pressed, then idle once it resolves", async () => {
    const emit = await startTurn();
    emit({ type: "text_delta", text: "x" });
    expect(useStore.getState().composerPhase).toBe("thinking");
    // stop() sets "stopping" synchronously, before awaiting the backend cancel — so
    // the intent is acknowledged immediately (the <100ms relabel).
    const stopping = useStore.getState().stop();
    expect(useStore.getState().composerPhase).toBe("stopping");
    await stopping;
    expect(useStore.getState().composerPhase).toBe("stopping");
    expect(useStore.getState().streaming).toBe(true);
    emit({ type: "turn_end", stopReason: "cancelled" });
    expect(useStore.getState().composerPhase).toBe("idle");
    expect(useStore.getState().streaming).toBe(false);
  });

  it("keeps the remaining parallel tool visible until its own result arrives", async () => {
    const emit = await startTurn();
    emit({ type: "tool_use", id: "t1", name: "grep", input: { pattern: "x" } });
    expect(useStore.getState().activeTool).toBe("grep");
    // A tool is a real first event, so the phase also settles to thinking.
    expect(useStore.getState().composerPhase).toBe("thinking");
    emit({ type: "tool_use", id: "t2", name: "shell", input: { command: "pwd" } });
    expect(useStore.getState().activeTool).toBe("shell");
    emit({ type: "tool_result", id: "t1", output: "ok", isError: false });
    expect(useStore.getState().activeTool).toBe("shell");
    emit({ type: "tool_result", id: "t2", output: "ok", isError: false });
    expect(useStore.getState().activeTool).toBeNull();
    emit({ type: "turn_end", stopReason: "end_turn" });
  });

  it("resets a residual tool label when the next turn starts", async () => {
    const emit = await startTurn();
    emit({ type: "tool_use", id: "t1", name: "shell", input: {} });
    expect(useStore.getState().activeTool).toBe("shell");
    // The turn ends mid-tool (no tool_result): terminalize the card immediately so
    // it cannot pulse forever, and reset the presence label.
    emit({ type: "turn_end", stopReason: "cancelled" });
    const toolResult = useStore
      .getState()
      .messages.a[1].blocks.find((block) => block.kind === "tool_result");
    expect(toolResult).toMatchObject({
      kind: "tool_result",
      toolUseId: "t1",
      isError: true,
      output: expect.stringContaining("Interrupted:"),
    });
    const emit2 = await startTurn();
    expect(useStore.getState().activeTool).toBeNull();
    emit2({ type: "turn_end", stopReason: "end_turn" });
  });
});

describe("message search + jump", () => {
  it("returns the backend hits under Tauri (ipc path)", async () => {
    m.searchMessages.mockResolvedValue([
      { sessionId: "a", messageId: "m1", seq: 2, role: "user", snippet: "hello parser" },
    ]);
    const hits = await useStore.getState().searchMessages("parser");
    expect(m.searchMessages).toHaveBeenCalledWith("parser");
    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe("a");
  });

  it("falls back to an in-memory search when the backend returns nothing", async () => {
    m.searchMessages.mockResolvedValue([]);
    useStore.setState({
      messages: {
        a: [
          {
            id: "m1",
            role: "user",
            blocks: [{ kind: "text", text: "refactor the PARSER" }],
            createdAt: 10,
          },
          {
            id: "m2",
            role: "assistant",
            blocks: [{ kind: "text", text: "unrelated reply" }],
            createdAt: 20,
          },
        ],
      },
    });
    const hits = await useStore.getState().searchMessages("parser");
    expect(hits).toHaveLength(1);
    expect(hits[0].messageId).toBe("m1");
    expect(hits[0].snippet.toLowerCase()).toContain("parser");
  });

  it("ignores an empty/whitespace query without hitting the backend", async () => {
    const hits = await useStore.getState().searchMessages("   ");
    expect(hits).toEqual([]);
    expect(m.searchMessages).not.toHaveBeenCalled();
  });

  it("jumpToMessage switches while another session continues running", async () => {
    useStore.setState({
      sessions: [session({ id: "b" })],
      activeId: "a",
      messages: { a: [] },
      streaming: true,
      runs: { a: runState({ streaming: true }) },
    });
    await useStore.getState().jumpToMessage("b", "m7");
    expect(useStore.getState().activeId).toBe("b");
    expect(useStore.getState().scrollTargetId).toBe("m7");
    expect(useStore.getState().runs.a.streaming).toBe(true);
  });

  it("jumpToMessage selects the session and sets the scroll target", async () => {
    useStore.setState({ sessions: [session({ id: "b" })], activeId: "a", messages: { a: [] } });
    await useStore.getState().jumpToMessage("b", "m7");
    expect(useStore.getState().activeId).toBe("b");
    expect(useStore.getState().scrollTargetId).toBe("m7");
  });

  it("clearScrollTarget resets the scroll target", () => {
    useStore.setState({ scrollTargetId: "m7" });
    useStore.getState().clearScrollTarget();
    expect(useStore.getState().scrollTargetId).toBeNull();
  });
});

describe("init draft + usage hydration", () => {
  it("merges backend drafts under the localStorage mirror and restores usage", async () => {
    // The optimistic mirror (already in state from the synchronous load) holds a
    // FRESHER draft for `a`; the backend has a stale `a` plus `b` the mirror lacks.
    useStore.setState({ drafts: { a: "fresh local a" } });
    m.listSessions.mockResolvedValue([session({ id: "a" }), session({ id: "b" })]);
    m.getDrafts.mockResolvedValue([
      { sessionId: "a", text: "stale backend a" },
      { sessionId: "b", text: "backend b" },
    ]);
    m.getAllUsage.mockResolvedValue([{ sessionId: "a", input: 1000, output: 200 }]);

    await useStore.getState().init();

    const st = useStore.getState();
    // Mirror wins for `a` (never staler than the debounced backend); backend fills `b`.
    expect(st.drafts).toEqual({ a: "fresh local a", b: "backend b" });
    // Cumulative usage restored so the per-session meter + HUD spend survive restart.
    expect(st.usage).toEqual({ a: { input: 1000, output: 200 } });
  });

  it("survives a core that predates the draft/usage commands (no init error)", async () => {
    m.getDrafts.mockRejectedValue(new Error("unknown command"));
    m.getAllUsage.mockRejectedValue(new Error("unknown command"));
    m.listSessions.mockResolvedValue([session({ id: "a" })]);

    await useStore.getState().init();

    // The resilient .catch(() => []) keeps startup green; no spurious init error panel.
    expect(useStore.getState().initError).toBeNull();
  });
});

describe("UI setters", () => {
  it("toggleFiles flips and the show* setters take explicit values", () => {
    const before = useStore.getState().showFiles;
    useStore.getState().toggleFiles();
    expect(useStore.getState().showFiles).toBe(!before);

    useStore.getState().setShowSettings(true);
    useStore.getState().setShowPalette(true);
    useStore.getState().setWorkspaceSurface("review");
    expect(useStore.getState().showSettings).toBe(true);
    expect(useStore.getState().showPalette).toBe(true);
    expect(useStore.getState().workspaceSurface).toBe("review");
  });

  it("opens workspace or turn-scoped review without surface changes resetting the target", () => {
    useStore.getState().openTurnReview("turn-42");
    expect(useStore.getState()).toMatchObject({
      workspaceSurface: "review",
      reviewTarget: { kind: "turn", turnId: "turn-42" },
    });

    useStore.getState().setWorkspaceSurface("chat");
    expect(useStore.getState().reviewTarget).toEqual({ kind: "turn", turnId: "turn-42" });

    useStore.getState().openWorkspaceReview();
    expect(useStore.getState()).toMatchObject({
      workspaceSurface: "review",
      reviewTarget: { kind: "workspace" },
    });
  });

  it("toggleSidebar flips the mobile drawer and setShowSidebar sets it", () => {
    expect(useStore.getState().showSidebar).toBe(false);
    useStore.getState().toggleSidebar();
    expect(useStore.getState().showSidebar).toBe(true);
    useStore.getState().toggleSidebar();
    expect(useStore.getState().showSidebar).toBe(false);

    useStore.getState().setShowSidebar(true);
    expect(useStore.getState().showSidebar).toBe(true);
  });

  it("setAmbientRain / setScanlines flip the decorative flags and persist them", () => {
    localStorage.clear();

    useStore.getState().setAmbientRain(true);
    expect(useStore.getState().ambientRain).toBe(true);
    expect(localStorage.getItem("pc.ambientRain")).toBe("1");

    useStore.getState().setScanlines(true);
    expect(useStore.getState().scanlines).toBe(true);
    expect(localStorage.getItem("pc.scanlines")).toBe("1");
  });
});

describe("uiScale (interface scale)", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the document zoom that prior tests / the module init may have set.
    document.documentElement.style.zoom = "";
  });

  it("defaults to 1 (no zoom applied) until set", () => {
    expect(useStore.getState().uiScale).toBe(1);
  });

  it("setUiScale updates state, persists a string number, and applies document zoom", () => {
    useStore.getState().setUiScale(1.25);

    expect(useStore.getState().uiScale).toBe(1.25);
    // Persisted as a plain string number under the documented key.
    expect(localStorage.getItem("pc.uiScale")).toBe("1.25");
    // Applied to the whole document via the `zoom` property (Chromium/WebView2).
    expect(document.documentElement.style.zoom).toBe("1.25");
  });

  it("stays resilient when localStorage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    expect(() => useStore.getState().setUiScale(0.9)).not.toThrow();
    // In-memory state + the applied zoom still update even if persistence fails.
    expect(useStore.getState().uiScale).toBe(0.9);
    expect(document.documentElement.style.zoom).toBe("0.9");

    spy.mockRestore();
  });

  it("hydrates the persisted scale on init and applies it to the document", async () => {
    localStorage.setItem("pc.uiScale", "1.1");
    document.documentElement.style.zoom = "";

    vi.resetModules();
    const fresh = await import("./store");

    expect(fresh.useStore.getState().uiScale).toBe(1.1);
    // The module applies the restored scale once at creation.
    expect(document.documentElement.style.zoom).toBe("1.1");
  });

  it("falls back to 1 for a missing or garbage persisted value", async () => {
    localStorage.setItem("pc.uiScale", "not-a-number");

    vi.resetModules();
    const fresh = await import("./store");

    expect(fresh.useStore.getState().uiScale).toBe(1);
  });
});

describe("crashReporting (telemetry consent)", () => {
  it("setCrashReporting persists the consent choice as a tri-state pref", () => {
    useStore.getState().setCrashReporting(true);
    expect(useStore.getState().crashReporting).toBe(true);
    expect(localStorage.getItem("pc.crashReporting")).toBe("1");

    useStore.getState().setCrashReporting(false);
    expect(useStore.getState().crashReporting).toBe(false);
    expect(localStorage.getItem("pc.crashReporting")).toBe("0");
  });

  it("setCrashReporting mirrors the consent choice to the Rust host (both ways)", () => {
    useStore.getState().setCrashReporting(true);
    expect(m.setTelemetryConsent).toHaveBeenCalledWith(true);

    useStore.getState().setCrashReporting(false);
    expect(m.setTelemetryConsent).toHaveBeenCalledWith(false);
  });

  it("setCrashReporting still applies the choice when the host mirror rejects", () => {
    // DSN-less dev builds / the mobile build (command unregistered) reject the
    // invoke; the consent choice must still persist (the host gate is authoritative).
    m.setTelemetryConsent.mockRejectedValueOnce(new Error("command not found"));
    expect(() => useStore.getState().setCrashReporting(true)).not.toThrow();
    expect(useStore.getState().crashReporting).toBe(true);
    expect(localStorage.getItem("pc.crashReporting")).toBe("1");
  });
});

describe("oauth (Claude subscription sign-in)", () => {
  const signedIn = { signedIn: true, expiresAt: 9999, account: "me@x", tier: "Claude Max" };

  it("init keeps oauthStatus null when the oauth bridge rejects", async () => {
    m.oauthStatus.mockRejectedValue(new Error("core not ready"));
    await useStore.getState().init();
    expect(useStore.getState().oauthStatus).toBeNull();
  });

  it("init stores the signed-in subscription status", async () => {
    m.oauthStatus.mockResolvedValue(signedIn);
    await useStore.getState().init();
    expect(useStore.getState().oauthStatus).toEqual(signedIn);
  });

  it("refreshOAuthStatus updates state and swallows a transient failure", async () => {
    m.oauthStatus.mockResolvedValue(signedIn);
    await useStore.getState().refreshOAuthStatus();
    expect(useStore.getState().oauthStatus).toEqual(signedIn);

    // A later failure must not clobber the last-known status.
    m.oauthStatus.mockRejectedValue(new Error("blip"));
    await useStore.getState().refreshOAuthStatus();
    expect(useStore.getState().oauthStatus).toEqual(signedIn);
  });

  it("loginWithClaude stores the status and clears any prior error", async () => {
    m.startOauthLogin.mockResolvedValue(signedIn);
    useStore.setState({ oauthError: "old failure" });

    await useStore.getState().loginWithClaude();

    expect(m.startOauthLogin).toHaveBeenCalledTimes(1);
    expect(useStore.getState().oauthStatus).toEqual(signedIn);
    expect(useStore.getState().oauthError).toBeNull();
  });

  it("loginWithClaude records an Error's message on failure", async () => {
    m.startOauthLogin.mockRejectedValue(new Error("oauth denied"));
    await useStore.getState().loginWithClaude();
    expect(useStore.getState().oauthError).toBe("oauth denied");
  });

  it("loginWithClaude stringifies a non-Error rejection", async () => {
    m.startOauthLogin.mockRejectedValue("plain failure");
    await useStore.getState().loginWithClaude();
    expect(useStore.getState().oauthError).toBe("plain failure");
  });

  it("logoutClaude clears the subscription on success", async () => {
    useStore.setState({ oauthStatus: signedIn });

    await useStore.getState().logoutClaude();

    expect(m.oauthLogout).toHaveBeenCalledTimes(1);
    expect(useStore.getState().oauthStatus).toEqual({
      signedIn: false,
      expiresAt: null,
      account: null,
      tier: null,
    });
  });

  it("logoutClaude records a failure message", async () => {
    m.oauthLogout.mockRejectedValue(new Error("logout failed"));
    await useStore.getState().logoutClaude();
    expect(useStore.getState().oauthError).toBe("logout failed");
  });
});

describe("OpenAI account registry and scoped catalogues", () => {
  const signedIn = {
    signedIn: true,
    expiresAt: 9_999,
    account: null,
    tier: null,
    available: true,
    unavailableReason: null,
  };
  const liveRows: OpenAIModelCatalogRow[] = [
    {
      id: "gpt-live",
      label: "GPT Live",
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    },
  ];
  const liveModels = (): ModelInfo[] =>
    liveRows.map((row) => ({
      ...row,
      provider: "openai",
      reasoningEfforts: [...row.reasoningEfforts],
    }));

  it("hydrates summaries and a profile-scoped live catalogue", async () => {
    const account = openAIAccount();
    m.openaiOauthStatus.mockResolvedValue(signedIn);
    m.listOpenAIAccounts.mockResolvedValue([account]);
    m.openaiModels.mockResolvedValue(liveRows);

    await useStore.getState().init();

    expect(m.openaiModels).toHaveBeenCalledWith(account.id);
    expect(useStore.getState()).toMatchObject({
      openAIAuthStatus: signedIn,
      openAIAccounts: [account],
      openAIAccountsError: null,
    });
    expect(useStore.getState().openAIModelCatalogs[account.id]).toMatchObject({
      status: "ready",
      models: [{ id: "gpt-live", provider: "openai" }],
    });
  });

  it("refreshes capability, prunes stale catalogues, and surfaces later discovery failures", async () => {
    const account = openAIAccount();
    const staleAccountId = "00000000-0000-4000-8000-000000000099";
    useStore.setState({
      openAIAccounts: [account],
      openAIAuthStatus: signedIn,
      lastOpenAIAccountProfileId: account.id,
      openAIModelCatalogs: {
        [staleAccountId]: { status: "ready", models: liveModels(), error: null },
      },
    });
    m.openaiOauthStatus.mockResolvedValue(signedIn);
    m.listOpenAIAccounts.mockResolvedValue([account]);
    m.openaiModels.mockResolvedValue(liveRows);

    await useStore.getState().refreshOpenAIStatus();

    expect(useStore.getState()).toMatchObject({
      openAIAccounts: [account],
      openAIAccountsLoading: false,
      openAIAccountsError: null,
    });
    expect(useStore.getState().openAIModelCatalogs[staleAccountId]).toBeUndefined();
    expect(useStore.getState().openAIModelCatalogs[account.id]).toMatchObject({
      status: "ready",
      models: [{ id: "gpt-live" }],
    });

    m.listOpenAIAccounts.mockRejectedValueOnce(new Error("registry temporarily unavailable"));
    await useStore.getState().refreshOpenAIStatus();
    expect(useStore.getState()).toMatchObject({
      openAIAccounts: [account],
      openAIAccountsLoading: false,
      openAIAccountsError: "registry temporarily unavailable",
    });

    m.openaiModels.mockClear();
    m.openaiOauthStatus.mockResolvedValueOnce({
      ...signedIn,
      signedIn: false,
      available: false,
      unavailableReason: "Disabled",
    });
    m.listOpenAIAccounts.mockResolvedValueOnce([account]);
    await useStore.getState().refreshOpenAIStatus();
    expect(useStore.getState().openAIModels).toEqual([]);
    expect(m.openaiModels).not.toHaveBeenCalled();
  });

  it("surfaces registry discovery failure without blocking app init or treating it as empty", async () => {
    m.listOpenAIAccounts.mockRejectedValue(new Error("credential registry is locked"));

    await useStore.getState().init();

    const state = useStore.getState();
    expect(state.initError).toBeNull();
    expect(state.sessions).toEqual([]);
    expect(state.pendingSession?.id).toBe(state.activeId);
    expect(state.openAIAccounts).toEqual([]);
    expect(state.openAIAccountsError).toBe("credential registry is locked");
  });

  it("represents a successful empty registry as signed out without an error", async () => {
    m.listOpenAIAccounts.mockResolvedValue([]);

    await useStore.getState().init();

    expect(useStore.getState().openAIAccounts).toEqual([]);
    expect(useStore.getState().openAIAccountsError).toBeNull();
  });

  it("falls back to the backend's most recently used connected profile", async () => {
    const older = openAIAccount({
      id: "00000000-0000-4000-8000-000000000001",
      lastUsedAt: 100,
    });
    const newer = openAIAccount({
      id: "00000000-0000-4000-8000-000000000002",
      accountLabel: "two@chatgpt.test",
      lastUsedAt: 200,
    });
    m.listOpenAIAccounts.mockResolvedValue([older, newer]);
    m.openaiModels.mockResolvedValue(liveRows);
    useStore.setState({ lastOpenAIAccountProfileId: null });

    await useStore.getState().init();

    expect(m.openaiModels).toHaveBeenCalledWith(newer.id);
  });

  it("keeps catalogues isolated by account, including errors", async () => {
    const one = openAIAccount();
    const two = openAIAccount({
      id: "00000000-0000-4000-8000-000000000002",
      accountLabel: "two@chatgpt.test",
    });
    useStore.setState({ openAIAccounts: [one, two], openAIAuthStatus: signedIn });
    m.openaiModels.mockImplementation(async (accountProfileId) => {
      if (accountProfileId === two.id) throw new Error("second account failed");
      return liveRows;
    });

    await useStore.getState().loadOpenAIAccountModels(one.id);
    await expect(useStore.getState().loadOpenAIAccountModels(two.id)).rejects.toThrow(
      "second account failed",
    );

    expect(useStore.getState().openAIModelCatalogs[one.id]).toMatchObject({
      status: "ready",
      models: [{ id: "gpt-live" }],
    });
    expect(useStore.getState().openAIModelCatalogs[two.id]).toMatchObject({
      status: "error",
      models: [],
      error: "second account failed",
    });
  });

  it("does not expose stale profile models while refresh is loading or after it fails", async () => {
    const account = openAIAccount();
    const stale = liveModels();
    useStore.setState({
      openAIAccounts: [account],
      openAIAuthStatus: signedIn,
      lastOpenAIAccountProfileId: account.id,
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: stale, error: null },
      },
      openAIModels: stale,
    });
    let rejectRefresh!: (error: Error) => void;
    m.openaiModels.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRefresh = reject;
        }),
    );

    const refresh = useStore.getState().loadOpenAIAccountModels(account.id, true);
    expect(useStore.getState().openAIModelCatalogs[account.id]).toEqual({
      status: "loading",
      models: [],
      error: null,
    });
    expect(modelsForOpenAIProfile(account.id, useStore.getState().openAIModelCatalogs)).toEqual([]);
    expect(useStore.getState().openAIModels).toEqual([]);

    rejectRefresh(new Error("catalogue offline"));
    await expect(refresh).rejects.toThrow("catalogue offline");
    expect(useStore.getState().openAIModelCatalogs[account.id]).toEqual({
      status: "error",
      models: [],
      error: "catalogue offline",
    });
    expect(
      modelsForOpenAIProfile(account.id, useStore.getState().openAIModelCatalogs, stale),
    ).toEqual([]);
  });

  it("fails closed when the capability envelope disables ChatGPT access", async () => {
    m.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, model: "gpt-5.6-sol" });
    m.openaiOauthStatus.mockResolvedValue({
      signedIn: false,
      expiresAt: null,
      account: null,
      tier: null,
      available: false,
      unavailableReason: "Disabled in this build",
    });
    m.listOpenAIAccounts.mockResolvedValue([openAIAccount()]);

    await useStore.getState().init();

    expect(useStore.getState().settings).toMatchObject({
      model: "gpt-5.6-sol",
      provider: "openai",
    });
    expect(useStore.getState().openAIModels).toEqual([]);
    expect(m.openaiModels).not.toHaveBeenCalled();
    expect(m.createSession).not.toHaveBeenCalled();
    expect(useStore.getState()).toMatchObject({
      sessions: [],
      activeId: null,
      showSettings: true,
      openAIAuthError: "Disabled in this build",
    });
  });

  it("adds an account, scopes its catalogue, and reports login failure", async () => {
    const account = openAIAccount();
    const other = openAIAccount({
      id: "00000000-0000-4000-8000-000000000002",
      accountLabel: "two@chatgpt.test",
    });
    m.startOpenAIAccountLogin.mockResolvedValue(account);
    m.openaiModels.mockResolvedValue(liveRows);
    useStore.setState({
      openAIAuthStatus: signedIn,
      openAIAuthError: "old error",
      openAIAccounts: [other, account],
    });

    await useStore.getState().loginWithOpenAI();

    expect(useStore.getState().openAIAccounts).toEqual([account, other]);
    expect(m.openaiModels).toHaveBeenCalledWith(account.id);
    expect(useStore.getState().openAIAuthError).toBeNull();

    m.startOpenAIAccountLogin.mockRejectedValueOnce(new Error("browser login denied"));
    await useStore.getState().loginWithOpenAI();
    expect(useStore.getState().openAIAuthError).toBe("browser login denied");
  });

  it("blocks account login when the capability envelope is unavailable", async () => {
    useStore.setState({
      openAIAuthStatus: {
        ...signedIn,
        signedIn: false,
        available: false,
        unavailableReason: "ChatGPT accounts are disabled",
      },
    });

    await useStore.getState().loginWithOpenAI();

    expect(m.startOpenAIAccountLogin).not.toHaveBeenCalled();
    expect(useStore.getState().openAIAuthError).toBe("ChatGPT accounts are disabled");
  });

  it("retains an authoritative removal tombstone, excludes it from selection, and reconnects the exact id", async () => {
    const account = openAIAccount();
    const removed = openAIAccount({
      state: "removed",
      expiresAt: null,
      updatedAt: 200,
    });
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, model: "gpt-live", provider: "openai" },
      openAIAuthStatus: signedIn,
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: {
          status: "ready",
          models: [
            {
              ...liveRows[0],
              reasoningEfforts: [...liveRows[0].reasoningEfforts],
              provider: "openai",
            },
          ],
          error: null,
        },
      },
      openAIModels: [
        { ...liveRows[0], reasoningEfforts: [...liveRows[0].reasoningEfforts], provider: "openai" },
      ],
      lastOpenAIAccountProfileId: account.id,
    });
    m.listOpenAIAccounts.mockResolvedValue([removed]);

    await useStore.getState().removeOpenAIAccount(account.id);

    expect(m.removeOpenAIAccount).toHaveBeenCalledWith(account.id);
    expect(useStore.getState().openAIAccounts).toEqual([removed]);
    expect(useStore.getState().openAIModelCatalogs[account.id]).toBeUndefined();
    expect(useStore.getState().lastOpenAIAccountProfileId).toBeNull();

    await useStore.getState().newSession(account.id);
    expect(m.createSession).not.toHaveBeenCalled();
    expect(useStore.getState().showSettings).toBe(true);

    const reconnected = { ...removed, state: "connected" as const, updatedAt: 300 };
    m.reconnectOpenAIAccount.mockResolvedValue({
      status: "reconnected",
      account: reconnected,
    });
    m.openaiModels.mockResolvedValue(liveRows);
    await useStore.getState().reconnectOpenAIAccount(account.id);
    expect(m.reconnectOpenAIAccount).toHaveBeenCalledWith(account.id);
    expect(useStore.getState().openAIAccounts).toEqual([reconnected]);

    m.reconnectOpenAIAccount.mockRejectedValueOnce(new Error("reconnect cancelled"));
    await useStore.getState().reconnectOpenAIAccount(account.id);
    expect(useStore.getState().openAIAuthError).toBe("reconnect cancelled");
  });

  it("retains a typed identity mismatch and adds the new sign-in as a separate profile", async () => {
    const original = openAIAccount({
      accountLabel: "original@chatgpt.test",
      state: "reconnect_required",
      expiresAt: null,
    });
    const separate = openAIAccount({
      id: "00000000-0000-4000-8000-000000000002",
      accountLabel: "different@chatgpt.test",
    });
    useStore.setState({
      openAIAuthStatus: { ...signedIn, signedIn: false },
      openAIAccounts: [original],
    });
    m.reconnectOpenAIAccount.mockResolvedValue({
      status: "identity_mismatch",
      message: "That sign-in belongs to a different ChatGPT account.",
    });

    await useStore.getState().reconnectOpenAIAccount(original.id);

    expect(useStore.getState().openAIAccounts).toEqual([original]);
    expect(useStore.getState().openAIReconnectMismatch).toEqual({
      accountProfileId: original.id,
      message: "That sign-in belongs to a different ChatGPT account.",
    });
    expect(m.openaiModels).not.toHaveBeenCalled();

    m.startOpenAIAccountLogin.mockResolvedValue(separate);
    m.openaiModels.mockResolvedValue(liveRows);
    await useStore.getState().loginWithOpenAI();

    expect(useStore.getState().openAIAccounts).toEqual([separate, original]);
    expect(useStore.getState().openAIReconnectMismatch).toBeNull();
    expect(m.openaiModels).toHaveBeenCalledWith(separate.id);
  });

  it("keeps a safe local tombstone when post-removal discovery fails", async () => {
    const account = openAIAccount();
    useStore.setState({
      openAIAuthStatus: signedIn,
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: liveModels(), error: null },
      },
      openAIModels: liveModels(),
      lastOpenAIAccountProfileId: account.id,
    });
    m.listOpenAIAccounts.mockRejectedValueOnce(new Error("registry read failed"));

    await useStore.getState().removeOpenAIAccount(account.id);

    expect(useStore.getState().openAIAccounts).toEqual([
      expect.objectContaining({ id: account.id, state: "removed", expiresAt: null }),
    ]);
    expect(useStore.getState()).toMatchObject({
      openAIAccountsError: "registry read failed",
      lastOpenAIAccountProfileId: null,
    });
    expect(useStore.getState().openAIModelCatalogs[account.id]).toBeUndefined();

    useStore.setState({ openAIAccounts: [account], openAIAuthError: null });
    m.removeOpenAIAccount.mockRejectedValueOnce(new Error("credential delete failed"));
    await useStore.getState().removeOpenAIAccount(account.id);
    expect(useStore.getState().openAIAuthError).toBe("credential delete failed");
  });

  it("promotes another connected account when the default account is removed", async () => {
    const current = openAIAccount({ accountLabel: "current@chatgpt.test" });
    const fallback = openAIAccount({
      id: "00000000-0000-4000-8000-000000000002",
      accountLabel: "fallback@chatgpt.test",
    });
    const removed = { ...current, state: "removed" as const, expiresAt: null };
    const models = liveModels();
    useStore.setState({
      openAIAuthStatus: signedIn,
      openAIAccounts: [current, fallback],
      openAIModelCatalogs: {
        [current.id]: { status: "ready", models, error: null },
        [fallback.id]: { status: "ready", models, error: null },
      },
      openAIModels: models,
      lastOpenAIAccountProfileId: current.id,
    });
    m.listOpenAIAccounts.mockResolvedValue([removed, fallback]);

    await useStore.getState().removeOpenAIAccount(current.id);

    expect(useStore.getState()).toMatchObject({
      openAIAccounts: [removed, fallback],
      lastOpenAIAccountProfileId: fallback.id,
      openAIModels: models,
    });
  });

  it("changes the Settings-managed default and reconciles an incompatible GPT model", async () => {
    const first = openAIAccount({ accountLabel: "first@chatgpt.test" });
    const second = openAIAccount({
      id: "00000000-0000-4000-8000-000000000002",
      accountLabel: "second@chatgpt.test",
    });
    const firstModels = liveModels();
    const secondModels: ModelInfo[] = [
      {
        id: "gpt-second",
        label: "GPT Second",
        provider: "openai",
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
      },
    ];
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: firstModels[0].id },
      openAIAuthStatus: signedIn,
      openAIAccounts: [first, second],
      openAIModelCatalogs: {
        [first.id]: { status: "ready", models: firstModels, error: null },
        [second.id]: { status: "ready", models: secondModels, error: null },
      },
      openAIModels: firstModels,
      lastOpenAIAccountProfileId: first.id,
    });

    await useStore.getState().setDefaultOpenAIAccount(second.id);

    expect(useStore.getState()).toMatchObject({
      lastOpenAIAccountProfileId: second.id,
      openAIModels: secondModels,
      settings: { model: "gpt-second", reasoningEffort: "high" },
    });
    expect(m.saveSettings).toHaveBeenCalledWith({
      model: "gpt-second",
      reasoningEffort: "high",
    });

    await useStore.getState().setDefaultOpenAIAccount("missing-profile");
    expect(useStore.getState().lastOpenAIAccountProfileId).toBe(second.id);
    expect(useStore.getState().openAIAuthError).toBe(
      "Choose a connected ChatGPT account as the default.",
    );
  });

  it("fails profile catalogue loads closed and reuses a confirmed cache", async () => {
    const account = openAIAccount();
    const missingProfileId = "00000000-0000-4000-8000-000000000099";
    useStore.setState({ openAIAuthStatus: signedIn, openAIAccounts: [] });

    await expect(useStore.getState().loadOpenAIAccountModels(missingProfileId)).rejects.toThrow(
      /not found/i,
    );
    expect(useStore.getState().openAIModelCatalogs[missingProfileId]).toMatchObject({
      status: "error",
      models: [],
    });

    useStore.setState({
      openAIAccounts: [{ ...account, state: "removed", expiresAt: null }],
    });
    await expect(useStore.getState().loadOpenAIAccountModels(account.id)).rejects.toThrow(
      /Reconnect/i,
    );

    useStore.setState({
      openAIAccounts: [account],
      openAIAuthStatus: {
        ...signedIn,
        available: false,
        unavailableReason: "Capability unavailable",
      },
    });
    await expect(useStore.getState().loadOpenAIAccountModels(account.id)).rejects.toThrow(
      "Capability unavailable",
    );

    useStore.setState({
      openAIAuthStatus: signedIn,
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: liveModels(), error: null },
      },
    });
    m.openaiModels.mockClear();
    await expect(useStore.getState().loadOpenAIAccountModels(account.id)).resolves.toEqual(
      liveModels(),
    );
    expect(m.openaiModels).not.toHaveBeenCalled();

    useStore.setState({ openAIModelCatalogs: {} });
    m.openaiModels.mockResolvedValueOnce([]);
    await expect(useStore.getState().loadOpenAIAccountModels(account.id)).rejects.toThrow(
      /no compatible OpenAI models/i,
    );
    expect(useStore.getState().openAIModelCatalogs[account.id]).toMatchObject({
      status: "error",
      models: [],
      error: "This account returned no compatible OpenAI models.",
    });
  });

  it("pins explicit new sessions without changing the Settings-managed default", async () => {
    const account = openAIAccount();
    const models = [
      {
        ...liveRows[0],
        reasoningEfforts: [...liveRows[0].reasoningEfforts],
        provider: "openai" as const,
      },
    ];
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, model: "gpt-live", provider: "openai" },
      openAIAuthStatus: signedIn,
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models, error: null },
      },
      openAIModels: models,
      lastOpenAIAccountProfileId: null,
    });

    await useStore.getState().newSession(account.id);

    expect(m.createSession).not.toHaveBeenCalled();
    expect(useStore.getState().pendingSession?.accountProfileId).toBe(account.id);
    expect(useStore.getState().lastOpenAIAccountProfileId).toBeNull();

    const previous = openAIAccount({ id: "00000000-0000-4000-8000-000000000002" });
    useStore.setState({ lastOpenAIAccountProfileId: previous.id });
    m.createSession.mockRejectedValueOnce(new Error("database locked"));
    await useStore.getState().newSession(account.id);
    await useStore.getState().send("hello");
    expect(useStore.getState().lastOpenAIAccountProfileId).toBe(previous.id);
  });

  it("pins a legacy session using the authoritative result and supports a void compatibility response", async () => {
    const account = openAIAccount();
    const legacy = session({ model: "gpt-live", accountProfileId: null });
    const pinned = { ...legacy, accountProfileId: account.id };
    useStore.setState({
      sessions: [legacy],
      activeId: legacy.id,
      openAIAuthStatus: signedIn,
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: {
          status: "ready",
          models: [
            {
              ...liveRows[0],
              reasoningEfforts: [...liveRows[0].reasoningEfforts],
              provider: "openai",
            },
          ],
          error: null,
        },
      },
    });
    m.pinSessionOpenAIAccount.mockResolvedValueOnce(pinned);

    await useStore.getState().pinSessionOpenAIAccount(legacy.id, account.id);
    expect(useStore.getState().sessions[0].accountProfileId).toBe(account.id);

    useStore.setState({ sessions: [legacy] });
    m.pinSessionOpenAIAccount.mockResolvedValueOnce(undefined as unknown as Session);
    m.listSessions.mockResolvedValueOnce([pinned]);
    await useStore.getState().pinSessionOpenAIAccount(legacy.id, account.id);
    expect(m.listSessions).toHaveBeenCalled();
    expect(useStore.getState().sessions[0].accountProfileId).toBe(account.id);
  });

  it("keeps a legacy draft and transcript untouched until native pin confirmation", async () => {
    const account = openAIAccount();
    const legacy = session({ id: "legacy", model: "gpt-live", accountProfileId: null });
    const existing: Message = {
      id: "existing",
      role: "assistant",
      blocks: [{ kind: "text", text: "Existing history" }],
      createdAt: 1,
    };
    let confirmPin!: (value: Session) => void;
    m.pinSessionOpenAIAccount.mockImplementationOnce(
      () =>
        new Promise<Session>((resolve) => {
          confirmPin = resolve;
        }),
    );
    useStore.setState({
      sessions: [legacy],
      activeId: legacy.id,
      drafts: { [legacy.id]: "Keep this unsent draft" },
      messages: { [legacy.id]: [existing] },
      openAIAuthStatus: signedIn,
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: liveModels(), error: null },
      },
    });

    const pinning = useStore.getState().pinSessionOpenAIAccount(legacy.id, account.id);
    await vi.waitFor(() => expect(m.pinSessionOpenAIAccount).toHaveBeenCalledOnce());

    await useStore.getState().send("Keep this unsent draft");
    expect(useStore.getState().drafts[legacy.id]).toBe("Keep this unsent draft");
    expect(useStore.getState().messages[legacy.id]).toEqual([existing]);
    expect(useStore.getState().runs[legacy.id]).toBeUndefined();
    expect(m.runAgent).not.toHaveBeenCalled();
    expect(m.saveDraft).not.toHaveBeenCalled();

    confirmPin({ ...legacy, accountProfileId: account.id });
    await pinning;
    expect(useStore.getState().sessions[0].accountProfileId).toBe(account.id);
    expect(useStore.getState().drafts[legacy.id]).toBe("Keep this unsent draft");
    expect(useStore.getState().messages[legacy.id]).toEqual([existing]);
  });

  it("blocks unsafe account selection, uses a visible compatible fallback, and requires native confirmation", async () => {
    const account = openAIAccount();
    const legacy = session({ model: "gpt-live", accountProfileId: null });
    useStore.setState({
      sessions: [legacy],
      activeId: legacy.id,
      openAIAuthStatus: signedIn,
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: liveModels(), error: null },
      },
      runs: { [legacy.id]: runState({ streaming: true }) },
    });

    await useStore.getState().pinSessionOpenAIAccount(legacy.id, account.id);
    expect(useStore.getState().openAIAuthError).toMatch(/active turn/i);
    expect(m.pinSessionOpenAIAccount).not.toHaveBeenCalled();

    useStore.setState({
      runs: {},
      openAIAccounts: [{ ...account, state: "removed", expiresAt: null }],
      openAIAuthError: null,
    });
    await useStore.getState().pinSessionOpenAIAccount(legacy.id, account.id);
    expect(useStore.getState().openAIAuthError).toBe("Choose a connected ChatGPT account.");

    useStore.setState({
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: {
          status: "ready",
          models: [
            {
              id: "gpt-other",
              label: "GPT Other",
              provider: "openai",
              reasoningEfforts: ["high"],
              defaultReasoningEffort: "high",
            },
          ],
          error: null,
        },
      },
      openAIAuthError: null,
    });
    await useStore.getState().pinSessionOpenAIAccount(legacy.id, account.id);
    expect(useStore.getState().openAIAuthError).toBeNull();
    expect(m.pinSessionOpenAIAccount).toHaveBeenCalledWith(legacy.id, account.id, "gpt-other");

    useStore.setState({
      sessions: [legacy],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: liveModels(), error: null },
      },
      openAIAuthError: null,
    });
    m.pinSessionOpenAIAccount.mockClear();
    m.pinSessionOpenAIAccount.mockResolvedValueOnce(legacy);
    await useStore.getState().pinSessionOpenAIAccount(legacy.id, account.id);
    expect(useStore.getState().openAIAuthError).toMatch(/did not confirm/i);

    m.pinSessionOpenAIAccount.mockRejectedValueOnce(new Error("compare-and-set failed"));
    await useStore.getState().pinSessionOpenAIAccount(legacy.id, account.id);
    expect(useStore.getState().openAIAuthError).toBe("compare-and-set failed");
  });
});

describe("settings + workspace", () => {
  it("updateSettings persists through ipc and stores the echoed result", async () => {
    m.saveSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, model: "claude-haiku-4-5-20251001" });

    await useStore.getState().updateSettings({ model: "claude-haiku-4-5-20251001" });

    expect(m.saveSettings).toHaveBeenCalledWith({ model: "claude-haiku-4-5-20251001" });
    expect(useStore.getState().settings.model).toBe("claude-haiku-4-5-20251001");
  });

  it("openWorkspace stores a picked folder and ignores a cancelled picker", async () => {
    m.openFolder.mockResolvedValueOnce("C:/work/repo");
    await useStore.getState().openWorkspace();
    expect(m.saveSettings).toHaveBeenCalledWith({ workspace: "C:/work/repo" });

    m.saveSettings.mockClear();
    m.openFolder.mockResolvedValueOnce(null);
    await useStore.getState().openWorkspace();
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("updateSettings records settingsError and preserves prior settings when the save rejects", async () => {
    const prior = useStore.getState().settings;
    m.saveSettings.mockRejectedValueOnce(new Error("keyring locked"));

    await useStore.getState().updateSettings({ model: "claude-sonnet-4-6" });

    const st = useStore.getState();
    expect(st.settingsError).toBe("keyring locked");
    expect(st.settings).toEqual(prior); // controlled UI doesn't silently corrupt
  });

  it("updateSettings reconciles a committed value when durability is unconfirmed", async () => {
    const committed = { ...DEFAULT_SETTINGS, model: "claude-sonnet-4-6" };
    m.saveSettings.mockRejectedValueOnce(
      new Error(`${SETTINGS_COMMITTED_DURABILITY_UNCONFIRMED_PREFIX} Directory sync failed.`),
    );
    m.getSettings.mockResolvedValueOnce(committed);

    await useStore.getState().updateSettings({ model: committed.model });

    const st = useStore.getState();
    expect(m.getSettings).toHaveBeenCalledTimes(1);
    expect(st.settings).toEqual(committed);
    expect(st.settingsError).toBe("Directory sync failed.");
  });

  it("updateSettings clears a prior settingsError on a successful save", async () => {
    useStore.setState({ settingsError: "old failure" });

    await useStore.getState().updateSettings({ model: "claude-sonnet-4-6" });

    expect(useStore.getState().settingsError).toBeNull();
  });

  it("openWorkspace records workspaceError when the picker rejects", async () => {
    m.openFolder.mockRejectedValueOnce(new Error("dialog failed"));

    await useStore.getState().openWorkspace();

    expect(useStore.getState().workspaceError).toBe("dialog failed");
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("openWorkspace records workspaceError when persisting the folder rejects", async () => {
    m.openFolder.mockResolvedValueOnce("C:/work/repo");
    m.saveSettings.mockRejectedValueOnce(new Error("save failed"));

    await useStore.getState().openWorkspace();

    expect(useStore.getState().workspaceError).toBe("save failed");
  });

  it("openWorkspace reconciles a committed folder when durability is unconfirmed", async () => {
    const committed = { ...DEFAULT_SETTINGS, workspace: "C:/work/repo" };
    m.openFolder.mockResolvedValueOnce(committed.workspace);
    m.saveSettings.mockRejectedValueOnce(
      new Error(`${SETTINGS_COMMITTED_DURABILITY_UNCONFIRMED_PREFIX} Metadata sync failed.`),
    );
    m.getSettings.mockResolvedValueOnce(committed);

    await useStore.getState().openWorkspace();

    const st = useStore.getState();
    expect(st.settings.workspace).toBe(committed.workspace);
    expect(st.workspaceError).toBe("Metadata sync failed.");
  });
});

describe("phone sync", () => {
  const paired = (): PairedDevice => ({
    publicKey: "PHONE==",
    name: "My Phone",
    pairedAt: 1000,
    lastSeen: 2000,
    confirmed: true,
  });

  it("init fetches phone sync status alongside settings", async () => {
    const status: PhoneSyncStatus = { devicePublicKey: "DEVICE==", paired: [paired()] };
    m.phoneSyncStatus.mockResolvedValue(status);

    await useStore.getState().init();

    expect(m.phoneSyncStatus).toHaveBeenCalledTimes(1);
    expect(useStore.getState().phoneSync).toEqual(status);
  });

  it("init keeps phoneSync null when the phone sync bridge rejects", async () => {
    m.phoneSyncStatus.mockRejectedValue(new Error("core not ready"));

    await useStore.getState().init();

    expect(useStore.getState().phoneSync).toBeNull();
  });

  it("refreshPhoneSync updates state and swallows a transient failure", async () => {
    const status: PhoneSyncStatus = { devicePublicKey: "DEVICE==", paired: [] };
    m.phoneSyncStatus.mockResolvedValue(status);

    await useStore.getState().refreshPhoneSync();

    expect(useStore.getState().phoneSync).toEqual(status);

    // A later failure must not clobber the last-known status.
    m.phoneSyncStatus.mockRejectedValue(new Error("blip"));
    await useStore.getState().refreshPhoneSync();
    expect(useStore.getState().phoneSync).toEqual(status);
  });

  it("beginPairing calls ipc and stores the resulting payload", async () => {
    const payload: PairingPayload = { version: 1, publicKey: "DEVICE==", nonce: "NONCE==" };
    m.phoneSyncBeginPairing.mockResolvedValue(payload);

    await useStore.getState().beginPairing();

    expect(m.phoneSyncBeginPairing).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pairingPayload).toEqual(payload);
  });

  it("beginPairing surfaces a rejection via pairingError and shows no QR", async () => {
    // phoneSyncBeginPairing is fallible; the Settings UI calls it via `void`, so a
    // swallowed rejection would leave the user with no QR and no feedback.
    m.phoneSyncBeginPairing.mockRejectedValueOnce(new Error("lock poisoned"));
    useStore.setState({ pairingError: "stale" });

    await useStore.getState().beginPairing();

    const st = useStore.getState();
    expect(st.pairingError).toBe("lock poisoned");
    expect(st.pairingPayload).toBeNull(); // no QR shown on failure
  });

  it("beginPairing clears a prior pairingError on a successful pairing", async () => {
    useStore.setState({ pairingError: "old failure" });

    await useStore.getState().beginPairing();

    expect(useStore.getState().pairingError).toBeNull();
  });

  it("unpair surfaces a rejection via pairingError", async () => {
    m.phoneSyncUnpair.mockRejectedValueOnce(new Error("db remove failed"));

    await useStore.getState().unpair("PHONE==");

    expect(useStore.getState().pairingError).toBe("db remove failed");
  });

  it("clearPairing removes the pairing payload from state", () => {
    useStore.setState({ pairingPayload: { version: 1, publicKey: "DEVICE==", nonce: "NONCE==" } });

    useStore.getState().clearPairing();

    expect(useStore.getState().pairingPayload).toBeNull();
  });

  it("unpair calls ipc with the publicKey then refreshes phone sync state", async () => {
    const refreshed: PhoneSyncStatus = { devicePublicKey: "DEVICE==", paired: [] };
    m.phoneSyncUnpair.mockResolvedValue(undefined);
    m.phoneSyncStatus.mockResolvedValue(refreshed);

    await useStore.getState().unpair("PHONE==");

    expect(m.phoneSyncUnpair).toHaveBeenCalledWith("PHONE==");
    expect(m.phoneSyncStatus).toHaveBeenCalledTimes(1);
    expect(useStore.getState().phoneSync).toEqual(refreshed);
  });

  // ── device-trust gate (desktop-side confirm flow) ──────────────────────────

  it("listenForPairingRequests surfaces an inbound request into state", async () => {
    let fire!: (req: { requestId: string; sas: string; peerKeyHex: string }) => void;
    m.onPhoneSyncPairingRequest.mockImplementation(async (cb) => {
      fire = cb;
      return () => {};
    });

    await useStore.getState().listenForPairingRequests();
    expect(useStore.getState().pairingRequest).toBeNull();

    // The desktop server emitted a "new phone wants to pair" event.
    fire({ requestId: "req-9", sas: "GOLF-77", peerKeyHex: "PHONE==" });
    expect(useStore.getState().pairingRequest).toEqual({
      requestId: "req-9",
      sas: "GOLF-77",
      peerKeyHex: "PHONE==",
    });
  });

  it("listenForPairingRequests tears down a prior subscription before re-subscribing", async () => {
    const prev = vi.fn();
    m.onPhoneSyncPairingRequest.mockResolvedValueOnce(prev);
    await useStore.getState().listenForPairingRequests();

    m.onPhoneSyncPairingRequest.mockResolvedValueOnce(() => {});
    await useStore.getState().listenForPairingRequests();

    expect(prev).toHaveBeenCalledTimes(1);
  });

  it("confirmPairingRequest confirms via ipc, clears the prompt, and refreshes", async () => {
    useStore.setState({
      pairingRequest: { requestId: "req-1", sas: "GOLF-77", peerKeyHex: "PHONE==" },
    });
    m.phoneSyncStatus.mockResolvedValue({ devicePublicKey: "DEVICE==", paired: [] });

    await useStore.getState().confirmPairingRequest();

    expect(m.confirmPairing).toHaveBeenCalledWith("req-1");
    expect(m.phoneSyncStatus).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pairingRequest).toBeNull();
  });

  it("rejectPairingRequest rejects via ipc and clears the prompt", async () => {
    useStore.setState({
      pairingRequest: { requestId: "req-1", sas: "GOLF-77", peerKeyHex: "PHONE==" },
    });

    await useStore.getState().rejectPairingRequest();

    expect(m.rejectPairing).toHaveBeenCalledWith("req-1");
    expect(useStore.getState().pairingRequest).toBeNull();
  });

  it("confirmPairingRequest is a no-op with no pending request", async () => {
    useStore.setState({ pairingRequest: null });
    await useStore.getState().confirmPairingRequest();
    expect(m.confirmPairing).not.toHaveBeenCalled();
  });

  it("confirmPairingRequest surfaces an ipc failure via pairingError", async () => {
    useStore.setState({
      pairingRequest: { requestId: "req-1", sas: "GOLF-77", peerKeyHex: "PHONE==" },
    });
    m.confirmPairing.mockRejectedValueOnce(new Error("gate poisoned"));

    await useStore.getState().confirmPairingRequest();

    expect(useStore.getState().pairingError).toBe("gate poisoned");
  });
});

describe("remote client", () => {
  const row = (over: Partial<MessageRow> = {}): MessageRow => ({
    id: "r1",
    sessionId: "s1",
    seq: 1,
    role: "user",
    content: [{ kind: "text", text: "hi" }],
    createdAt: 7,
    ...over,
  });

  // Seed a live assistant message so the per-event reducer has a "last" message
  // to fold into (the dual of send pre-creating the assistant message). The seeded
  // session is made active so the global turn flags (streaming/pendingPermission)
  // apply — those are now gated on the frame's session being the active one.
  const seedTurn = (sid = "s1", id = "a1") => {
    useStore.setState({ activeId: sid });
    useStore.getState().applyFrame({
      t: "live",
      session_id: sid,
      event: { type: "turn_start", messageId: id },
    });
  };

  describe("applyFrame", () => {
    it("session_list replaces sessions and seeds activeId when none is set", () => {
      const s1 = session({ id: "a" });
      const s2 = session({ id: "b" });

      useStore.getState().applyFrame({ t: "session_list", sessions: [s1, s2] });

      const st = useStore.getState();
      expect(st.sessions).toEqual([s1, s2]);
      expect(st.activeId).toBe("a");
    });

    it("session_list keeps a still-present activeId", () => {
      useStore.setState({ activeId: "b" });

      useStore
        .getState()
        .applyFrame({ t: "session_list", sessions: [session({ id: "a" }), session({ id: "b" })] });

      expect(useStore.getState().activeId).toBe("b");
    });

    it("session_list re-points activeId to the first session when the active one vanished", () => {
      useStore.setState({ activeId: "gone" });

      useStore.getState().applyFrame({ t: "session_list", sessions: [session({ id: "a" })] });

      expect(useStore.getState().activeId).toBe("a");
    });

    it("session_list re-points activeId to null when the list is empty", () => {
      useStore.setState({ activeId: "gone" });

      useStore.getState().applyFrame({ t: "session_list", sessions: [] });

      const st = useStore.getState();
      expect(st.sessions).toEqual([]);
      expect(st.activeId).toBeNull();
    });

    it("message_delta converts rows and replaces the session's message list", () => {
      useStore.setState({
        messages: { s1: [{ id: "stale", role: "user", blocks: [], createdAt: 1 }] },
      });

      useStore.getState().applyFrame({
        t: "message_delta",
        session_id: "s1",
        messages: [row({ id: "r1", role: "assistant", content: [{ kind: "text", text: "ok" }] })],
      });

      const msgs = useStore.getState().messages.s1;
      expect(msgs).toEqual([
        { id: "r1", role: "assistant", blocks: [{ kind: "text", text: "ok" }], createdAt: 7 },
      ]);
    });

    it("message_delta preserves optional turn identity and receipts while legacy rows stay bare", () => {
      const receipt = turnReceipt({ turnId: "remote-turn" });
      useStore.getState().applyFrame({
        t: "message_delta",
        session_id: "s1",
        messages: [
          row({ id: "legacy", seq: 0 }),
          row({
            id: "remote-turn",
            seq: 1,
            role: "assistant",
            turnId: "remote-turn",
            receipt,
          }),
        ],
      });

      const [legacy, completed] = useStore.getState().messages.s1;
      expect(legacy).not.toHaveProperty("turnId");
      expect(legacy).not.toHaveProperty("receipt");
      expect(completed).toMatchObject({ turnId: "remote-turn", receipt });
    });

    it("groups raw catch-up rows into one receipt-bearing assistant turn", () => {
      const receipt = turnReceipt({ turnId: "grouped-turn" });
      useStore.getState().applyFrame({
        t: "message_delta",
        session_id: "s1",
        messages: [
          row({
            id: "user-row",
            seq: 0,
            turnId: "grouped-turn",
            content: [{ kind: "text", text: "inspect this" }],
          }),
          row({
            id: "assistant-row",
            seq: 1,
            role: "assistant",
            turnId: "grouped-turn",
            content: [
              { kind: "text", text: "Checking." },
              { kind: "tool_use", id: "tool-1", name: "fs_read", input: { path: "x" } },
            ],
          }),
          row({
            id: "tool-row",
            seq: 2,
            turnId: "grouped-turn",
            content: [{ kind: "tool_result", toolUseId: "tool-1", output: "ok", isError: false }],
            receipt,
          }),
        ],
      });

      const messages = useStore.getState().messages.s1;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ id: "user-row", role: "user" });
      expect(messages[1]).toEqual({
        id: "grouped-turn",
        role: "assistant",
        blocks: [
          { kind: "text", text: "Checking." },
          { kind: "tool_use", id: "tool-1", name: "fs_read", input: { path: "x" } },
          { kind: "tool_result", toolUseId: "tool-1", output: "ok", isError: false },
        ],
        createdAt: 7,
        turnId: "grouped-turn",
        receipt,
      });
    });

    it("drops encrypted OpenAI reasoning metadata before messages reach rendering", () => {
      useStore.getState().applyFrame({
        t: "message_delta",
        session_id: "s1",
        messages: [
          row({
            content: [
              { type: "reasoning", id: "r", encrypted_content: "secret", summary: [] },
              { kind: "text", text: "safe answer" },
            ],
          }),
        ],
      });

      expect(useStore.getState().messages.s1[0].blocks).toEqual([
        { kind: "text", text: "safe answer" },
      ]);
    });

    it("message_delta seeds activeId when none is set", () => {
      useStore.setState({ activeId: null });

      useStore.getState().applyFrame({ t: "message_delta", session_id: "s1", messages: [] });

      expect(useStore.getState().activeId).toBe("s1");
    });

    it("ignores command / ack / hello frames", () => {
      const before = useStore.getState();

      useStore
        .getState()
        .applyFrame({ t: "command", command: { cmd: "cancel", session_id: "s1" } });
      useStore.getState().applyFrame({ t: "ack", session_id: "s1", seq: 3 });
      useStore.getState().applyFrame({ t: "hello", device_id: "d1", cursors: [] });

      const after = useStore.getState();
      expect(after.sessions).toBe(before.sessions);
      expect(after.messages).toBe(before.messages);
      expect(after.activeId).toBe(before.activeId);
    });

    it("ignores minimal and other-client rejections while idle", () => {
      useStore.setState({ remoteConnected: true, remoteError: null });

      useStore.getState().applyFrame({
        t: "command_rejected",
        request_id: "another-phone",
        code: "invalid_request",
        message: "This belongs to another client.",
      });
      expect(useStore.getState().remoteError).toBeNull();

      useStore.getState().applyFrame({ t: "command_rejected" });

      expect(useStore.getState()).toMatchObject({
        remoteConnected: true,
        remoteError: null,
      });
    });

    it("pairing_reject drops the session and marks it rejected (REACT: desktop declined)", () => {
      const unlisten = vi.fn();
      useStore.setState({
        remoteConnected: true,
        remoteVerified: true,
        remoteSas: "SAS-1",
        remotePeerKey: "PEER==",
        remoteChatOpen: true,
        lastPairingQr: "QR",
        remoteUnlisten: unlisten,
        streaming: true,
      });

      useStore.getState().applyFrame({ t: "pairing_reject", reason: "Codes didn't match" });

      // The frame subscription is torn down (the desktop closed the door).
      expect(unlisten).toHaveBeenCalledTimes(1);
      const st = useStore.getState();
      expect(st.remoteRejected).toBe(true);
      expect(st.remoteRejectReason).toBe("Codes didn't match");
      expect(st.remoteConnected).toBe(false);
      expect(st.remoteVerified).toBe(false);
      expect(st.remoteSas).toBeNull();
      expect(st.remoteChatOpen).toBe(false);
      expect(st.streaming).toBe(false);
      // A rejected desktop is forgotten (no one-tap reconnect into it).
      expect(st.lastPairingQr).toBeNull();
    });

    it("pairing_reject with no reason sets a null reason", () => {
      useStore.setState({ remoteConnected: true, remoteSas: "SAS-1" });

      useStore.getState().applyFrame({ t: "pairing_reject" });

      const st = useStore.getState();
      expect(st.remoteRejected).toBe(true);
      expect(st.remoteRejectReason).toBeNull();
    });

    it("message_delta seeds pagination (hasMore + oldestSeq) from the window", () => {
      // The catch-up window starts at seq 5 (older history exists), so the smallest
      // held seq is the page cursor and hasMore is true.
      useStore.getState().applyFrame({
        t: "message_delta",
        session_id: "s1",
        messages: [row({ id: "r5", seq: 5 }), row({ id: "r6", seq: 6 })],
      });
      expect(useStore.getState().messagePaging.s1).toEqual({
        hasMore: true,
        loading: false,
        oldestSeq: 5,
      });
    });

    it("message_delta with the first message (seq 0) reports no more history", () => {
      useStore.getState().applyFrame({
        t: "message_delta",
        session_id: "s1",
        messages: [row({ id: "r0", seq: 0 }), row({ id: "r1", seq: 1 })],
      });
      expect(useStore.getState().messagePaging.s1.hasMore).toBe(false);
      expect(useStore.getState().messagePaging.s1.oldestSeq).toBe(0);
    });

    it("message_page PREPENDS older rows (doesn't replace), keeps ascending order", () => {
      // Hold the recent window (seq 5,6); a page brings seq 3,4 to PREPEND.
      useStore.setState({
        messages: {
          s1: [
            { id: "r5", role: "user", blocks: [{ kind: "text", text: "five" }], createdAt: 5 },
            { id: "r6", role: "user", blocks: [{ kind: "text", text: "six" }], createdAt: 6 },
          ],
        },
        messagePaging: { s1: { hasMore: true, loading: true, oldestSeq: 5 } },
      });

      useStore.getState().applyFrame({
        t: "message_page",
        session_id: "s1",
        messages: [row({ id: "r3", seq: 3 }), row({ id: "r4", seq: 4 })],
        has_more: true,
      });

      const ids = useStore.getState().messages.s1.map((m) => m.id);
      expect(ids).toEqual(["r3", "r4", "r5", "r6"]); // prepended, ascending
      const paging = useStore.getState().messagePaging.s1;
      expect(paging.hasMore).toBe(true);
      expect(paging.loading).toBe(false); // the page clears the loading guard
      expect(paging.oldestSeq).toBe(3); // cursor advanced to the new oldest
    });

    it("merges one turn split across the message_page boundary", () => {
      const receipt = turnReceipt({ turnId: "split-turn" });
      // The bounded tail begins with the terminal tool-result row, so catch-up can
      // only synthesize the assistant fragment carrying that result + receipt.
      useStore.getState().applyFrame({
        t: "message_delta",
        session_id: "s1",
        messages: [
          row({
            id: "result-row",
            seq: 2,
            turnId: "split-turn",
            content: [{ kind: "tool_result", toolUseId: "tool-1", output: "done", isError: false }],
            receipt,
          }),
        ],
      });

      useStore.getState().applyFrame({
        t: "message_page",
        session_id: "s1",
        messages: [
          row({
            id: "prompt-row",
            seq: 0,
            turnId: "split-turn",
            content: [{ kind: "text", text: "do it" }],
          }),
          row({
            id: "assistant-row",
            seq: 1,
            role: "assistant",
            turnId: "split-turn",
            content: [
              { kind: "text", text: "Working." },
              { kind: "tool_use", id: "tool-1", name: "fs_read", input: {} },
            ],
          }),
        ],
        has_more: false,
      });

      const messages = useStore.getState().messages.s1;
      expect(messages.map((message) => message.id)).toEqual(["prompt-row", "split-turn"]);
      expect(messages[1]).toMatchObject({
        receipt,
        blocks: [
          { kind: "text", text: "Working." },
          { kind: "tool_use", id: "tool-1", name: "fs_read", input: {} },
          { kind: "tool_result", toolUseId: "tool-1", output: "done", isError: false },
        ],
      });
    });

    it("message_page dedupes rows already held (no duplicates) and sets hasMore false at the start", () => {
      useStore.setState({
        messages: {
          s1: [{ id: "r2", role: "user", blocks: [{ kind: "text", text: "two" }], createdAt: 2 }],
        },
        messagePaging: { s1: { hasMore: true, loading: true, oldestSeq: 2 } },
      });

      // The page overlaps r2 (already held) and adds r0,r1; has_more=false (start).
      useStore.getState().applyFrame({
        t: "message_page",
        session_id: "s1",
        messages: [row({ id: "r0", seq: 0 }), row({ id: "r1", seq: 1 }), row({ id: "r2", seq: 2 })],
        has_more: false,
      });

      const ids = useStore.getState().messages.s1.map((m) => m.id);
      expect(ids).toEqual(["r0", "r1", "r2"]); // r2 not duplicated
      expect(useStore.getState().messagePaging.s1.hasMore).toBe(false);
      expect(useStore.getState().messagePaging.s1.oldestSeq).toBe(0);
    });
  });

  describe("loadOlderMessages", () => {
    const setPaged = (over: Partial<{ hasMore: boolean; loading: boolean; oldestSeq: number }>) =>
      useStore.setState({
        remoteConnected: true,
        activeId: "s1",
        messagePaging: { s1: { hasMore: true, loading: false, oldestSeq: 5, ...over } },
      });

    it("sends fetch_messages with the smallest held seq and flips loading true", async () => {
      setPaged({ oldestSeq: 5 });

      await useStore.getState().loadOlderMessages("s1");

      expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({
        cmd: "fetch_messages",
        session_id: "s1",
        before_seq: 5,
        limit: 100,
      });
      expect(useStore.getState().messagePaging.s1.loading).toBe(true);
    });

    it("does nothing when not remote-connected", async () => {
      setPaged({ oldestSeq: 5 });
      useStore.setState({ remoteConnected: false });

      await useStore.getState().loadOlderMessages("s1");

      expect(m.phoneSyncSendCommand).not.toHaveBeenCalled();
    });

    it("does nothing when there is no more history (hasMore false)", async () => {
      setPaged({ hasMore: false });

      await useStore.getState().loadOlderMessages("s1");

      expect(m.phoneSyncSendCommand).not.toHaveBeenCalled();
    });

    it("does nothing when a fetch is already loading", async () => {
      setPaged({ loading: true });

      await useStore.getState().loadOlderMessages("s1");

      expect(m.phoneSyncSendCommand).not.toHaveBeenCalled();
    });

    it("does nothing when pagination is unseeded for the session", async () => {
      useStore.setState({ remoteConnected: true, activeId: "s1", messagePaging: {} });

      await useStore.getState().loadOlderMessages("s1");

      expect(m.phoneSyncSendCommand).not.toHaveBeenCalled();
    });

    it("does not request before seq 0 (the first message) — marks hasMore false instead", async () => {
      setPaged({ oldestSeq: 0 });

      await useStore.getState().loadOlderMessages("s1");

      expect(m.phoneSyncSendCommand).not.toHaveBeenCalled();
      expect(useStore.getState().messagePaging.s1.hasMore).toBe(false);
    });
  });

  describe("live stream reducer", () => {
    it("turn_start pushes an empty assistant message and starts streaming", () => {
      seedTurn("s1", "a1");

      const st = useStore.getState();
      expect(st.streaming).toBe(true);
      expect(st.messages.s1).toEqual([
        {
          id: "a1",
          role: "assistant",
          blocks: [],
          createdAt: expect.any(Number),
          turnId: "a1",
        },
      ]);
    });

    it("text_delta / tool_use / tool_result fold into the last message", () => {
      seedTurn("s1", "a1");

      const live = (event: StreamEvent) =>
        useStore.getState().applyFrame({ t: "live", session_id: "s1", event });

      live({ type: "text_delta", text: "Hello " });
      live({ type: "text_delta", text: "world" });
      live({ type: "tool_use", id: "t1", name: "fs_read", input: { path: "x" } });
      live({ type: "tool_result", id: "t1", output: "ok", isError: false });

      const blocks = useStore.getState().messages.s1[0].blocks;
      expect(blocks).toEqual([
        { kind: "text", text: "Hello world" },
        { kind: "tool_use", id: "t1", name: "fs_read", input: { path: "x" } },
        { kind: "tool_result", toolUseId: "t1", output: "ok", isError: false },
      ]);
    });

    it("a stray delta before any turn_start is a no-op (empty-session guard)", () => {
      useStore.getState().applyFrame({
        t: "live",
        session_id: "s1",
        event: { type: "text_delta", text: "lost" },
      });

      expect(useStore.getState().messages.s1).toBeUndefined();
    });

    it("permission_request surfaces a pending prompt (with its diff) for the active session", () => {
      useStore.setState({ activeId: "s1" });

      useStore.getState().applyFrame({
        t: "live",
        session_id: "s1",
        event: {
          type: "permission_request",
          id: "p1",
          tool: "fs_edit",
          risk: "highRiskGit",
          summary: "x",
          input: {},
          diff: "-a\n+b\n",
        },
      });

      expect(useStore.getState().pendingPermission).toEqual({
        id: "p1",
        tool: "fs_edit",
        risk: "highRiskGit",
        summary: "x",
        input: {},
        diff: "-a\n+b\n",
      });
    });

    it("usage accumulates per session across frames", () => {
      const live = (event: StreamEvent) =>
        useStore.getState().applyFrame({ t: "live", session_id: "s1", event });

      live({ type: "usage", inputTokens: 100, outputTokens: 40 });
      live({ type: "usage", inputTokens: 10, outputTokens: 5 });

      expect(useStore.getState().usage.s1).toEqual({ input: 110, output: 45 });
    });

    it("turn_end clears streaming and any pending prompt for the active session", () => {
      useStore.setState({
        activeId: "s1",
        streaming: true,
        pendingPermission: { id: "p", tool: "t", summary: "s", input: {} },
      });

      useStore.getState().applyFrame({
        t: "live",
        session_id: "s1",
        event: { type: "turn_end", stopReason: "end_turn" },
      });

      const st = useStore.getState();
      expect(st.streaming).toBe(false);
      expect(st.pendingPermission).toBeNull();
    });

    it("error appends an inline error to the last message and stops streaming", () => {
      seedTurn("s1", "a1");
      useStore.setState({ streaming: true });

      useStore.getState().applyFrame({
        t: "live",
        session_id: "s1",
        event: { type: "error", message: "boom" },
      });

      const st = useStore.getState();
      expect(st.streaming).toBe(false);
      const text = st.messages.s1[0].blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
      expect(text).toContain("Error");
      expect(text).toContain("boom");
    });

    it("uses a safe remote account ordinal for a pinned HTTP 429 error", () => {
      const firstProfile = "00000000-0000-4000-8000-000000000001";
      const secondProfile = "00000000-0000-4000-8000-000000000002";
      useStore.setState({
        remoteMode: true,
        sessions: [
          session({ id: "s1", model: "gpt-live", accountProfileId: secondProfile }),
          session({ id: "s2", model: "gpt-live", accountProfileId: firstProfile }),
        ],
      });
      seedTurn("s1", "a1");

      useStore.getState().applyFrame({
        t: "live",
        session_id: "s1",
        event: {
          type: "error",
          message: `HTTP 429 for ${secondProfile} / acct_remote_secret`,
        },
      });

      const text = useStore
        .getState()
        .messages.s1[0].blocks.map((block) => (block.kind === "text" ? block.text : ""))
        .join("");
      const label = markdownLiteralText("ChatGPT account 2");
      expect(text).toContain(`${label}: ChatGPT rate limit or quota was reached.`);
      expect(text.split(`${label}:`)).toHaveLength(2);
      expect(text).not.toContain(firstProfile);
      expect(text).not.toContain(secondProfile);
      expect(text).not.toContain("acct_remote_secret");
      expect(text).not.toContain("HTTP 429");
    });

    it("escapes a hostile desktop account label in the frame-folded terminal error path", () => {
      const hostileLabel = "[outer ![nested](https://evil.test/pixel)](https://evil.test) <svg>";
      const account = openAIAccount({ accountLabel: hostileLabel });
      useStore.setState({
        remoteMode: false,
        sessions: [session({ id: "s1", model: "gpt-live", accountProfileId: account.id })],
        openAIAccounts: [account],
      });
      seedTurn("s1", "a1");

      useStore.getState().applyFrame({
        t: "live",
        session_id: "s1",
        event: { type: "error", message: "OpenAI response was incomplete. Please retry." },
      });

      const text = useStore
        .getState()
        .messages.s1[0].blocks.map((block) => (block.kind === "text" ? block.text : ""))
        .join("");
      expect(text).toContain(
        `${markdownLiteralText(hostileLabel)}: OpenAI response was incomplete`,
      );
      expect(text).not.toContain(account.id);
    });

    it("attaches an authoritative error receipt to its exact remote turn", () => {
      seedTurn("s1", "a1");
      const receipt = turnReceipt({
        turnId: "a1",
        status: "error",
        stopReason: "provider_error",
      });

      useStore.getState().applyFrame({
        t: "live",
        session_id: "s1",
        event: { type: "error", message: "boom", receipt },
      });

      const st = useStore.getState();
      expect(st.messages.s1[0].receipt).toEqual(receipt);
      expect(st.runs.s1).toMatchObject({ outcome: "error", receipt, streaming: false });
    });

    describe("background-session frames don't hijack the visible UI", () => {
      // The user is looking at "active"; frames for a different (background)
      // session must still build that session's history, but must NOT flip the
      // visible composer/HUD or pop a permission prompt with no context.
      const bgLive = (event: StreamEvent) =>
        useStore.getState().applyFrame({ t: "live", session_id: "bg", event });

      it("times out a silent background run without terminalizing an active run with fresh activity", async () => {
        vi.useFakeTimers();
        try {
          useStore.setState({ activeId: "active", remoteConnected: true, runs: {}, messages: {} });
          useStore.getState().applyFrame({
            t: "live",
            session_id: "active",
            event: { type: "turn_start", messageId: "active-turn", turnId: "active-turn" },
          });
          bgLive({ type: "turn_start", messageId: "bg-turn", turnId: "bg-turn" });

          await vi.advanceTimersByTimeAsync(149_000);
          useStore.getState().applyFrame({
            t: "live",
            session_id: "active",
            event: { type: "text_delta", text: "still working" },
          });
          await vi.advanceTimersByTimeAsync(2_000);

          const st = useStore.getState();
          expect(st.runs.bg.streaming).toBe(false);
          expect(st.runs.bg.outcome).toBe("interrupted");
          expect(st.runs.active.streaming).toBe(true);
          expect(st.streaming).toBe(true);

          useStore.getState().applyFrame({
            t: "live",
            session_id: "active",
            event: { type: "turn_end", stopReason: "end_turn" },
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it("turn_start for a background session appends its message and tracks its own run, without flipping the visible composer", () => {
        useStore.setState({ activeId: "active", runs: {}, streaming: false });

        bgLive({ type: "turn_start", messageId: "b1" });

        const st = useStore.getState();
        expect(st.streaming).toBe(false); // visible composer (mirror = active run) untouched
        // ...but the background run IS now streaming in the run map — the whole
        // point of the multi-run model: N runs are independently representable.
        expect(st.runs.bg.streaming).toBe(true);
        expect(st.messages.bg).toEqual([
          {
            id: "b1",
            role: "assistant",
            blocks: [],
            createdAt: expect.any(Number),
            turnId: "b1",
          },
        ]);
      });

      it("permission_request for a background session is recorded on its run but does NOT pop the visible prompt", () => {
        useStore.setState({ activeId: "active", runs: {}, pendingPermission: null });

        bgLive({
          type: "permission_request",
          id: "p9",
          tool: "fs_edit",
          risk: "unknown",
          summary: "x",
          input: {},
        });

        const st = useStore.getState();
        expect(st.pendingPermission).toBeNull(); // the visible gate stays closed
        expect(st.runs.bg.pendingPermission?.id).toBe("p9"); // but the bg run holds it
        expect(st.runs.bg.pendingPermission?.risk).toBe("unknown");
      });

      it("text_delta still folds into the background session's message", () => {
        useStore.setState({ activeId: "active", runs: {} });
        bgLive({ type: "turn_start", messageId: "b1" });

        bgLive({ type: "text_delta", text: "hi" });

        expect(useStore.getState().messages.bg[0].blocks).toEqual([{ kind: "text", text: "hi" }]);
      });

      it("turn_end / error for a background session leave the ACTIVE session's visible flags alone but end the bg run", () => {
        // Seed the ACTIVE session as a live turn IN THE RUN MAP — the visible
        // mirror derives from it, so a background turn ending must not disturb it.
        useStore.setState({
          activeId: "active",
          runs: {
            active: runState({
              streaming: true,
              turnId: "active-turn",
              startedAt: 1,
              pendingPermission: { id: "p", tool: "t", summary: "s", input: {} },
            }),
          },
          streaming: true,
          pendingPermission: { id: "p", tool: "t", summary: "s", input: {} },
        });
        bgLive({ type: "turn_start", messageId: "b1" });

        bgLive({ type: "error", message: "boom" });
        let st = useStore.getState();
        // The visible turn flags belong to the active session, not the background one.
        expect(st.streaming).toBe(true);
        expect(st.pendingPermission).not.toBeNull();
        // ...the background run has ended, and its message got the inline error.
        expect(st.runs.bg.streaming).toBe(false);
        const text = st.messages.bg[0].blocks
          .map((b) => (b.kind === "text" ? b.text : ""))
          .join("");
        expect(text).toContain("boom");

        bgLive({ type: "turn_end", stopReason: "end_turn" });
        st = useStore.getState();
        expect(st.streaming).toBe(true);
        expect(st.pendingPermission).not.toBeNull();
      });

      it("attaches a background turn receipt without changing the active session's run", () => {
        useStore.setState({
          activeId: "active",
          messages: {
            active: [
              {
                id: "active-turn",
                role: "assistant",
                blocks: [{ kind: "text", text: "still running" }],
                createdAt: 1,
                turnId: "active-turn",
              },
            ],
          },
          runs: {
            active: runState({ streaming: true, turnId: "active-turn", startedAt: 1 }),
          },
          streaming: true,
        });
        bgLive({ type: "turn_start", messageId: "bg-turn", startedAt: 100 });
        const receipt = turnReceipt({ turnId: "bg-turn" });
        bgLive({ type: "turn_end", stopReason: "end_turn", receipt });

        const st = useStore.getState();
        expect(st.streaming).toBe(true);
        expect(st.runs.active).toMatchObject({ streaming: true, turnId: "active-turn" });
        expect(st.messages.active[0]).not.toHaveProperty("receipt");
        expect(st.messages.bg[0]).toMatchObject({ turnId: "bg-turn", receipt });
        expect(st.runs.bg).toMatchObject({ streaming: false, outcome: "completed", receipt });
      });
    });
  });

  describe("remote mode + SAS verification", () => {
    it("setRemoteMode toggles the remote-shell flag", () => {
      useStore.getState().setRemoteMode(true);
      expect(useStore.getState().remoteMode).toBe(true);

      useStore.getState().setRemoteMode(false);
      expect(useStore.getState().remoteMode).toBe(false);
    });

    it("confirmRemoteSas marks the connection verified", () => {
      expect(useStore.getState().remoteVerified).toBe(false);

      useStore.getState().confirmRemoteSas();

      expect(useStore.getState().remoteVerified).toBe(true);
    });

    it("confirmRemoteSas is a no-op once the pairing was rejected", () => {
      // A stale Confirm click (e.g. an inbound desktop reject landed first) must not
      // re-open a session the reject already closed.
      useStore.setState({ remoteRejected: true, remoteVerified: false });

      useStore.getState().confirmRemoteSas();

      expect(useStore.getState().remoteVerified).toBe(false);
    });
  });

  describe("rejectRemoteSas", () => {
    it("rejects a live connection: sends the reject, tears down, and marks rejected", async () => {
      const unlisten = vi.fn();
      useStore.setState({
        remoteConnected: true,
        remoteVerified: true,
        remoteSas: "SAS-1",
        remotePeerKey: "PEER==",
        remoteChatOpen: true,
        lastPairingQr: "QR",
        remoteUnlisten: unlisten,
      });

      await useStore.getState().rejectRemoteSas();

      // The reject frame goes out over the link (not a bare disconnect).
      expect(m.phoneSyncReject).toHaveBeenCalledTimes(1);
      expect(m.phoneSyncDisconnect).not.toHaveBeenCalled();
      // The frame subscription was torn down.
      expect(unlisten).toHaveBeenCalledTimes(1);
      const st = useStore.getState();
      expect(st.remoteRejected).toBe(true);
      expect(st.remoteConnected).toBe(false);
      expect(st.remoteVerified).toBe(false);
      expect(st.remoteSas).toBeNull();
      expect(st.remotePeerKey).toBeNull();
      expect(st.remoteChatOpen).toBe(false);
      // The remembered pairing is forgotten — a rejected desktop isn't offered reconnect.
      expect(st.lastPairingQr).toBeNull();
    });

    it("from a not-connected state, just sets rejected without reaching the channel", async () => {
      useStore.setState({ remoteConnected: false });

      await useStore.getState().rejectRemoteSas();

      expect(m.phoneSyncReject).not.toHaveBeenCalled();
      expect(useStore.getState().remoteRejected).toBe(true);
    });
  });

  describe("connectRemote", () => {
    it("connects, stores the SAS, and routes frames through applyFrame", async () => {
      let cb!: (frame: SyncFrame) => void;
      m.onPhoneSyncFrame.mockImplementation(async (fn) => {
        cb = fn;
        return () => {};
      });

      await useStore.getState().connectRemote("QR-PAYLOAD");

      const st = useStore.getState();
      // A first dial is NOT a reconnect, so it binds the QR nonce (reconnect=false).
      expect(m.phoneSyncConnect).toHaveBeenCalledWith("QR-PAYLOAD", false);
      expect(st.remoteConnected).toBe(true);
      expect(st.remoteSas).toBe("SAS-1");
      // The STABLE pinned desktop key is captured separately from the SAS.
      expect(st.remotePeerKey).toBe("PEER==");
      expect(st.remoteError).toBeNull();

      // The captured callback must drive applyFrame.
      cb({ t: "session_list", sessions: [session({ id: "x" })] });
      expect(useStore.getState().sessions.map((s) => s.id)).toEqual(["x"]);
    });

    it("tears down a prior subscription before reconnecting", async () => {
      const prev = vi.fn();
      useStore.setState({ remoteUnlisten: prev });

      await useStore.getState().connectRemote("QR");

      expect(prev).toHaveBeenCalledTimes(1);
      expect(useStore.getState().remoteConnected).toBe(true);
    });

    it("clears a prior SAS verification on a fresh dial", async () => {
      // A re-pair must force the user to compare the NEW SAS — a stale verified
      // flag can't carry over and silently trust a different desktop.
      useStore.setState({ remoteVerified: true });

      await useStore.getState().connectRemote("QR");

      expect(useStore.getState().remoteVerified).toBe(false);
    });

    it("clears a prior rejection on a fresh dial", async () => {
      // A re-pair must start clean — a lingering "rejected" notice can't carry over
      // into a new connection attempt.
      useStore.setState({ remoteRejected: true, remoteRejectReason: "old reason" });

      await useStore.getState().connectRemote("QR");

      const st = useStore.getState();
      expect(st.remoteRejected).toBe(false);
      expect(st.remoteRejectReason).toBeNull();
      expect(st.remoteConnected).toBe(true);
    });

    it("records the error and stays disconnected when the dial fails", async () => {
      m.phoneSyncConnect.mockRejectedValue(new Error("dial failed"));

      await useStore.getState().connectRemote("QR");

      const st = useStore.getState();
      expect(st.remoteConnected).toBe(false);
      expect(st.remoteSas).toBeNull();
      expect(st.remoteUnlisten).toBeNull();
      expect(st.remoteError).toBe("dial failed");
      expect(m.onPhoneSyncFrame).not.toHaveBeenCalled();
    });

    it("serializes concurrent dials so only one frame listener is registered", async () => {
      // Two interleaved dials (Reconnect + Scan/Connect) must not each register a
      // frame listener and orphan one that keeps double-feeding applyFrame.
      let release!: () => void;
      m.phoneSyncConnect.mockReturnValueOnce(
        new Promise((res) => {
          release = () => res({ sas: "SAS-1", peerPublicKey: "PEER==" });
        }),
      );

      const first = useStore.getState().connectRemote("QR-A");
      // Second call lands while the first dial is still in flight — the re-entry
      // guard makes it a no-op.
      const second = useStore.getState().connectRemote("QR-B");

      release();
      await Promise.all([first, second]);

      expect(m.phoneSyncConnect).toHaveBeenCalledTimes(1);
      expect(m.onPhoneSyncFrame).toHaveBeenCalledTimes(1);
      expect(useStore.getState().remoteConnecting).toBe(false);
    });

    it("clears the re-entry lock so a later dial can proceed", async () => {
      await useStore.getState().connectRemote("QR-1");
      expect(useStore.getState().remoteConnecting).toBe(false);

      m.phoneSyncConnect.mockClear();
      await useStore.getState().connectRemote("QR-2");

      expect(m.phoneSyncConnect).toHaveBeenCalledWith("QR-2", false);
    });

    it("releases the re-entry lock even when the dial fails", async () => {
      m.phoneSyncConnect.mockRejectedValueOnce(new Error("dial failed"));

      await useStore.getState().connectRemote("QR");

      expect(useStore.getState().remoteConnecting).toBe(false);
    });

    it("honors a disconnect that lands mid-dial: stays disconnected, leaks no listener", async () => {
      // disconnectRemote during an in-flight dial clears remoteConnecting as an abort
      // sentinel. When the (slow) dial finally resolves, connectRemote must bail
      // BEFORE registering its frame/drop listeners and tear down the native session,
      // instead of overriding the user's disconnect and resurrecting the connection.
      const unlistenFrame = vi.fn();
      let release!: () => void;
      m.phoneSyncConnect.mockReturnValueOnce(
        new Promise((res) => {
          release = () => res({ sas: "SAS-1", peerPublicKey: "PEER==" });
        }),
      );
      m.onPhoneSyncFrame.mockResolvedValue(unlistenFrame);

      const connecting = useStore.getState().connectRemote("QR");
      // The user disconnects while the dial is still pending.
      await useStore.getState().disconnectRemote();
      expect(useStore.getState().remoteConnecting).toBe(false); // abort sentinel set

      // The dial resolves late — connectRemote must NOT register listeners or connect.
      release();
      await connecting;

      const st = useStore.getState();
      expect(st.remoteConnected).toBe(false); // disconnect honored, not overridden
      expect(st.remoteUnlisten).toBeNull(); // no live subscription stored
      // No frame listener was registered (we bailed before subscribing), so the only
      // leak risk — an orphaned subscription — is avoided, and the native session the
      // dial opened was torn down.
      expect(m.onPhoneSyncFrame).not.toHaveBeenCalled();
      expect(unlistenFrame).not.toHaveBeenCalled();
      // phoneSyncDisconnect ran once for the user's disconnect and once for the
      // abort-path teardown of the just-opened native session.
      expect(m.phoneSyncDisconnect).toHaveBeenCalledTimes(2);
    });
  });

  describe("drop detection + reconnect", () => {
    it("remembers the pairing payload and clears the dropped flag on connect", async () => {
      await useStore.getState().connectRemote("QR-XYZ");
      const st = useStore.getState();
      expect(st.lastPairingQr).toBe("QR-XYZ");
      expect(st.remoteDropped).toBe(false);
    });

    it("flags a dropped session when the native disconnect event fires", async () => {
      let dropCb!: () => void;
      m.onPhoneSyncDisconnected.mockImplementation(async (cb) => {
        dropCb = cb;
        return () => {};
      });
      await useStore.getState().connectRemote("QR");
      expect(useStore.getState().remoteConnected).toBe(true);

      // The desktop closed the channel / the network dropped.
      dropCb();

      const st = useStore.getState();
      expect(st.remoteConnected).toBe(false);
      expect(st.remoteVerified).toBe(false);
      expect(st.remoteDropped).toBe(true);
      expect(st.lastPairingQr).toBe("QR"); // kept so a reconnect is possible
    });

    it("reconnectRemote re-dials the remembered pairing, pre-verified", async () => {
      await useStore.getState().connectRemote("QR-1");
      useStore.setState({ remoteConnected: false, remoteVerified: false, remoteDropped: true });
      m.phoneSyncConnect.mockClear();

      await useStore.getState().reconnectRemote();

      // A reconnect binds an empty prologue (reconnect=true) to match the desktop's
      // closed pairing window.
      expect(m.phoneSyncConnect).toHaveBeenCalledWith("QR-1", true);
      const st = useStore.getState();
      expect(st.remoteConnected).toBe(true);
      // A pin-matched reconnect skips the SAS re-comparison.
      expect(st.remoteVerified).toBe(true);
      expect(st.remoteDropped).toBe(false);
    });

    it("reconnectRemote is a no-op without a remembered pairing", async () => {
      expect(useStore.getState().lastPairingQr).toBeNull();
      await useStore.getState().reconnectRemote();
      expect(m.phoneSyncConnect).not.toHaveBeenCalled();
    });

    it("disconnectRemote forgets the pairing and clears the dropped flag", async () => {
      await useStore.getState().connectRemote("QR");
      useStore.setState({ remoteDropped: true });

      await useStore.getState().disconnectRemote();

      const st = useStore.getState();
      expect(st.remoteDropped).toBe(false);
      expect(st.lastPairingQr).toBeNull();
      // The pinned peer key is cleared too — no stale identity left behind.
      expect(st.remotePeerKey).toBeNull();
    });

    it("hydrateRememberedQr fills an empty lastPairingQr but never clobbers an existing one", async () => {
      // Cold launch: nothing remembered yet → the durable QR hydrates the slot so
      // reconnectRemote (which reads lastPairingQr) can dial.
      expect(useStore.getState().lastPairingQr).toBeNull();
      useStore.getState().hydrateRememberedQr("QR-FROM-IDB");
      expect(useStore.getState().lastPairingQr).toBe("QR-FROM-IDB");

      // A QR already in the store (the localStorage mirror) wins — hydration is a no-op.
      useStore.getState().hydrateRememberedQr("QR-STALE");
      expect(useStore.getState().lastPairingQr).toBe("QR-FROM-IDB");
    });

    it("tears down a partial subscription if the disconnect listener fails to register", async () => {
      const unlistenFrame = vi.fn();
      m.onPhoneSyncFrame.mockResolvedValue(unlistenFrame);
      m.onPhoneSyncDisconnected.mockRejectedValue(new Error("listen failed"));

      await useStore.getState().connectRemote("QR");

      // The already-registered frame listener is cleaned up and the native session
      // is torn down, so nothing leaks on the partial-failure path.
      expect(unlistenFrame).toHaveBeenCalledTimes(1);
      expect(m.phoneSyncDisconnect).toHaveBeenCalled();
      const st = useStore.getState();
      expect(st.remoteConnected).toBe(false);
      expect(st.remoteError).toBe("listen failed");
    });

    it("persists the remembered pairing across launches and forgets it on disconnect", async () => {
      await useStore.getState().connectRemote("QR-PERSIST");
      expect(localStorage.getItem("pc.lastPairingQr")).toBe("QR-PERSIST");

      await useStore.getState().disconnectRemote();
      expect(localStorage.getItem("pc.lastPairingQr")).toBeNull();
    });

    it("clears stuck turn state (streaming + pendingPermission) on a mid-turn drop + reconnect", async () => {
      let dropCb!: () => void;
      m.onPhoneSyncDisconnected.mockImplementation(async (cb) => {
        dropCb = cb;
        return () => {};
      });
      await useStore.getState().connectRemote("QR");
      // A turn is in flight when the channel dies.
      useStore.setState({
        streaming: true,
        pendingPermission: { id: "p1", tool: "fs_edit", summary: "x", input: {} },
      });

      dropCb();

      // The dead turn is cleared, not just the connection flags.
      expect(useStore.getState().streaming).toBe(false);
      expect(useStore.getState().pendingPermission).toBeNull();

      // Reconnecting must NOT resurrect the stale turn (disabled composer / dead prompt).
      await useStore.getState().reconnectRemote();
      const st = useStore.getState();
      expect(st.remoteConnected).toBe(true);
      expect(st.streaming).toBe(false);
      expect(st.pendingPermission).toBeNull();
    });

    it("clears stuck turn state when the user disconnects mid-turn", async () => {
      await useStore.getState().connectRemote("QR");
      useStore.setState({
        streaming: true,
        pendingPermission: { id: "p1", tool: "x", summary: "y", input: {} },
      });

      await useStore.getState().disconnectRemote();

      expect(useStore.getState().streaming).toBe(false);
      expect(useStore.getState().pendingPermission).toBeNull();
    });
  });

  describe("disconnectRemote", () => {
    it("clears the connection flags before awaiting the channel teardown", async () => {
      // remoteConnected is the routing source of truth for send/stop/permission, so
      // it (and the listener) must be cleared SYNCHRONOUSLY, before the awaited
      // phoneSyncDisconnect, so a command can't route onto the closing channel.
      let release!: () => void;
      m.phoneSyncDisconnect.mockReturnValue(
        new Promise<void>((res) => {
          release = res;
        }),
      );
      const unlisten = vi.fn();
      useStore.setState({
        remoteConnected: true,
        remoteVerified: true,
        remoteSas: "SAS-1",
        remoteUnlisten: unlisten,
      });

      const pending = useStore.getState().disconnectRemote();

      // Synchronously after the call, before the teardown promise resolves:
      const mid = useStore.getState();
      expect(mid.remoteConnected).toBe(false);
      expect(mid.remoteVerified).toBe(false);
      expect(mid.remoteSas).toBeNull();
      expect(mid.remoteUnlisten).toBeNull();
      expect(unlisten).toHaveBeenCalledTimes(1);

      release();
      await pending;
      expect(m.phoneSyncDisconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendRemoteCommand", () => {
    it("optimistically appends the user message for a run command and forwards it", async () => {
      const command: RemoteCommand = { cmd: "run", session_id: "s1", text: "do it" };

      await useStore.getState().sendRemoteCommand(command);

      const msgs = useStore.getState().messages.s1;
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe("user");
      expect(msgs[0].blocks).toEqual([{ kind: "text", text: "do it" }]);
      expect(m.phoneSyncSendCommand).toHaveBeenCalledWith(command);
    });

    it("does not echo a non-run command but still forwards it", async () => {
      const command: RemoteCommand = { cmd: "cancel", session_id: "s1" };

      await useStore.getState().sendRemoteCommand(command);

      expect(useStore.getState().messages.s1).toBeUndefined();
      expect(m.phoneSyncSendCommand).toHaveBeenCalledWith(command);
    });

    it("annotates the optimistic message and flags remoteDropped when a run send rejects", async () => {
      m.phoneSyncSendCommand.mockRejectedValueOnce(new Error("link down"));
      useStore.setState({ streaming: true });

      // Must not throw (callers swallow the rejection).
      await expect(
        useStore.getState().sendRemoteCommand({ cmd: "run", session_id: "s1", text: "do it" }),
      ).resolves.toBeUndefined();

      const st = useStore.getState();
      const text = st.messages.s1[0].blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
      expect(text).toContain("do it");
      expect(text).toContain("Couldn't reach your desktop");
      expect(st.remoteDropped).toBe(true);
      expect(st.streaming).toBe(false);
    });

    it("clears streaming on a rejecting cancel (stop) without annotating any message", async () => {
      m.phoneSyncSendCommand.mockRejectedValueOnce(new Error("link down"));
      useStore.setState({ streaming: true });

      await expect(
        useStore.getState().sendRemoteCommand({ cmd: "cancel", session_id: "s1" }),
      ).resolves.toBeUndefined();

      const st = useStore.getState();
      expect(st.streaming).toBe(false);
      expect(st.remoteDropped).toBe(true);
      expect(st.messages.s1).toBeUndefined(); // nothing optimistic to annotate
    });
  });

  describe("disconnectRemote", () => {
    it("tears down the subscription and resets connection flags", async () => {
      const unlisten = vi.fn();
      useStore.setState({
        remoteConnected: true,
        remoteVerified: true,
        remoteSas: "SAS-1",
        remoteUnlisten: unlisten,
      });

      await useStore.getState().disconnectRemote();

      expect(unlisten).toHaveBeenCalledTimes(1);
      expect(m.phoneSyncDisconnect).toHaveBeenCalledTimes(1);
      const st = useStore.getState();
      expect(st.remoteConnected).toBe(false);
      expect(st.remoteVerified).toBe(false);
      expect(st.remoteSas).toBeNull();
      expect(st.remoteUnlisten).toBeNull();
    });

    it("still disconnects when there is no stored subscription", async () => {
      useStore.setState({ remoteUnlisten: null });

      await useStore.getState().disconnectRemote();

      expect(m.phoneSyncDisconnect).toHaveBeenCalledTimes(1);
      expect(useStore.getState().remoteConnected).toBe(false);
    });
  });

  describe("remote navigation + presence", () => {
    it("openRemoteSession switches to the session and opens the chat view", async () => {
      const msg: Message = { id: "m", role: "assistant", blocks: [], createdAt: 1 };
      m.getMessages.mockResolvedValue([msg]);

      await useStore.getState().openRemoteSession("z");

      const st = useStore.getState();
      expect(st.activeId).toBe("z");
      expect(st.remoteChatOpen).toBe(true);
      expect(st.messages.z).toEqual([msg]);
    });

    it("openRemoteSession switches while the prior session continues streaming", async () => {
      useStore.setState({
        activeId: "a",
        streaming: true,
        remoteChatOpen: false,
        runs: { a: runState({ streaming: true }) },
      });

      await useStore.getState().openRemoteSession("b");

      const st = useStore.getState();
      expect(st.activeId).toBe("b");
      expect(st.remoteChatOpen).toBe(true);
      expect(st.runs.a.streaming).toBe(true);
    });

    it("openRemoteSession still enters the already-active session while streaming", async () => {
      const msg: Message = { id: "m", role: "assistant", blocks: [], createdAt: 1 };
      useStore.setState({
        activeId: "a",
        streaming: true,
        remoteChatOpen: false,
        messages: { a: [msg] },
      });

      await useStore.getState().openRemoteSession("a");

      const st = useStore.getState();
      expect(st.activeId).toBe("a");
      expect(st.remoteChatOpen).toBe(true); // tapping the active running session enters it
    });

    it("closeRemoteSession returns to the sessions list without disconnecting", () => {
      useStore.setState({ remoteChatOpen: true, remoteConnected: true });

      useStore.getState().closeRemoteSession();

      const st = useStore.getState();
      expect(st.remoteChatOpen).toBe(false);
      expect(st.remoteConnected).toBe(true); // the link stays live
    });

    it("forgetRemotePairing clears the remembered desktop and the dropped flag", () => {
      useStore.setState({ lastPairingQr: "QR", remoteDropped: true });
      localStorage.setItem("pc.lastPairingQr", "QR");

      useStore.getState().forgetRemotePairing();

      const st = useStore.getState();
      expect(st.lastPairingQr).toBeNull();
      expect(st.remoteDropped).toBe(false);
      expect(localStorage.getItem("pc.lastPairingQr")).toBeNull();
    });

    it("forgetRemotePairing also clears remote identity metadata", () => {
      useStore.setState({
        lastPairingQr: "QR",
        remotePeerKey: "PEER==",
        remoteVapidKey: "VAPID==",
        remoteDropped: true,
        remoteRejected: true,
        remoteRejectReason: "mismatch",
      });

      useStore.getState().forgetRemotePairing();

      expect(useStore.getState()).toMatchObject({
        lastPairingQr: null,
        remotePeerKey: null,
        remoteVapidKey: null,
        remoteDropped: false,
        remoteRejected: false,
        remoteRejectReason: null,
      });
    });

    it("setOnline reflects network presence", () => {
      useStore.getState().setOnline(false);
      expect(useStore.getState().online).toBe(false);

      useStore.getState().setOnline(true);
      expect(useStore.getState().online).toBe(true);
    });

    it("a fresh dial resets the chat view to the sessions list", async () => {
      useStore.setState({ remoteChatOpen: true });

      await useStore.getState().connectRemote("QR");

      expect(useStore.getState().remoteChatOpen).toBe(false);
    });

    it("disconnect closes the chat view", async () => {
      useStore.setState({ remoteConnected: true, remoteChatOpen: true });

      await useStore.getState().disconnectRemote();

      expect(useStore.getState().remoteChatOpen).toBe(false);
    });

    it("an unexpected drop closes the chat view", async () => {
      let dropCb!: () => void;
      m.onPhoneSyncDisconnected.mockImplementation(async (cb) => {
        dropCb = cb;
        return () => {};
      });
      await useStore.getState().connectRemote("QR");
      useStore.setState({ remoteChatOpen: true });

      dropCb();

      expect(useStore.getState().remoteChatOpen).toBe(false);
    });
  });

  // ── Sessions sidebar organization (frontend-only overlay) ───────────────────
  describe("sidebar organization", () => {
    beforeEach(() => {
      // These assert on the persisted slice, so isolate localStorage per test.
      localStorage.clear();
    });

    it("setSortBy / setGroupBy update state and persist the choice", () => {
      useStore.getState().setSortBy("name");
      useStore.getState().setGroupBy("status");

      expect(useStore.getState().sortBy).toBe("name");
      expect(useStore.getState().groupBy).toBe("status");
      expect(localStorage.getItem("pc.sortBy")).toBe("name");
      expect(localStorage.getItem("pc.groupBy")).toBe("status");
    });

    it("addFolder appends an expanded 'New folder' and persists it", () => {
      useStore.getState().addFolder();

      const { folders } = useStore.getState();
      expect(folders).toHaveLength(1);
      expect(folders[0]).toMatchObject({ name: "New folder", open: true });
      expect(typeof folders[0].id).toBe("string");
      expect(JSON.parse(localStorage.getItem("pc.folders")!)).toHaveLength(1);
    });

    it("toggleFolder flips a folder's open flag", () => {
      useStore.setState({ folders: [{ id: "f1", name: "Work", open: true }] });

      useStore.getState().toggleFolder("f1");
      expect(useStore.getState().folders[0].open).toBe(false);

      useStore.getState().toggleFolder("f1");
      expect(useStore.getState().folders[0].open).toBe(true);
      // Untouched ids are left alone.
      useStore.getState().toggleFolder("nope");
      expect(useStore.getState().folders[0].open).toBe(true);
    });

    it("renameFolder trims a new name but ignores an empty/whitespace one", () => {
      useStore.setState({ folders: [{ id: "f1", name: "Work", open: true }] });

      useStore.getState().renameFolder("f1", "  Research  ");
      expect(useStore.getState().folders[0].name).toBe("Research");

      // A blank rename is a no-op so a folder can never lose its label.
      useStore.getState().renameFolder("f1", "   ");
      expect(useStore.getState().folders[0].name).toBe("Research");
    });

    it("deleteFolder removes the folder and orphans its members back to loose", () => {
      useStore.setState({
        folders: [
          { id: "f1", name: "Work", open: true },
          { id: "f2", name: "Personal", open: true },
        ],
        folderOf: { a: "f1", b: "f1", c: "f2" },
      });

      useStore.getState().deleteFolder("f1");

      const st = useStore.getState();
      expect(st.folders.map((f) => f.id)).toEqual(["f2"]);
      // a + b drop their membership (back to loose); c (in f2) is untouched.
      expect(st.folderOf).toEqual({ c: "f2" });
      expect(JSON.parse(localStorage.getItem("pc.folderOf")!)).toEqual({ c: "f2" });
    });

    it("moveSessionToFolder sets membership, and null moves a chat back to loose", () => {
      useStore.getState().moveSessionToFolder("a", "f1");
      expect(useStore.getState().folderOf).toEqual({ a: "f1" });

      useStore.getState().moveSessionToFolder("a", null);
      expect(useStore.getState().folderOf).toEqual({});
      expect(JSON.parse(localStorage.getItem("pc.folderOf")!)).toEqual({});
    });

    it("toggleArchived checks the worktree, then adds and removes the id", async () => {
      useStore.setState({ sessions: [session({ id: "a" })] });

      await useStore.getState().toggleArchived("a");
      expect(m.getSessionArchiveWarning).toHaveBeenCalledWith("a");
      expect(useStore.getState().archivedIds).toEqual(["a"]);
      expect(JSON.parse(localStorage.getItem("pc.archivedIds")!)).toEqual(["a"]);

      await useStore.getState().toggleArchived("a");
      expect(useStore.getState().archivedIds).toEqual([]);
    });

    it("returns a confirmation requirement without archiving a dirty session", async () => {
      const warning = {
        workspace: "C:/work/portcode",
        branch: "feature/sidebar",
        detachedHead: null,
        changedFiles: 3,
        untrackedFiles: 1,
        additions: 18,
        deletions: 4,
      };
      useStore.setState({ sessions: [session({ id: "a" })] });
      m.getSessionArchiveWarning.mockResolvedValueOnce(warning);

      await expect(useStore.getState().toggleArchived("a")).resolves.toEqual({
        outcome: "needsConfirmation",
        warning,
      });
      expect(useStore.getState().archivedIds).toEqual([]);

      await expect(useStore.getState().toggleArchived("a", true)).resolves.toEqual({
        outcome: "archived",
      });
      expect(useStore.getState().archivedIds).toEqual(["a"]);
      expect(m.getSessionArchiveWarning).toHaveBeenCalledTimes(1);
    });

    it("does not archive a session removed while its worktree check is in flight", async () => {
      let resolveWarning!: (warning: null) => void;
      m.getSessionArchiveWarning.mockImplementationOnce(
        () => new Promise((resolve) => (resolveWarning = resolve)),
      );
      useStore.setState({ sessions: [session({ id: "a" })] });

      const pending = useStore.getState().toggleArchived("a");
      await vi.waitFor(() => expect(m.getSessionArchiveWarning).toHaveBeenCalledWith("a"));
      useStore.setState({ sessions: [] });
      resolveWarning(null);

      await expect(pending).resolves.toEqual({ outcome: "archived" });
      expect(useStore.getState().archivedIds).toEqual([]);
    });

    it("keeps a concurrent forced archive when a prior clean check completes", async () => {
      let resolveWarning!: (warning: null) => void;
      m.getSessionArchiveWarning.mockImplementationOnce(
        () => new Promise((resolve) => (resolveWarning = resolve)),
      );
      useStore.setState({ sessions: [session({ id: "a" })] });

      const checkedArchive = useStore.getState().toggleArchived("a");
      await vi.waitFor(() => expect(m.getSessionArchiveWarning).toHaveBeenCalledWith("a"));
      await useStore.getState().toggleArchived("a", true);
      resolveWarning(null);

      await expect(checkedArchive).resolves.toEqual({ outcome: "archived" });
      expect(useStore.getState().archivedIds).toEqual(["a"]);
    });

    it("setSidebarCollapsed toggles the rail flag and persists it", () => {
      useStore.getState().setSidebarCollapsed(true);
      expect(useStore.getState().sidebarCollapsed).toBe(true);
      expect(localStorage.getItem("pc.sidebarCollapsed")).toBe("1");

      useStore.getState().setSidebarCollapsed(false);
      expect(useStore.getState().sidebarCollapsed).toBe(false);
      expect(localStorage.getItem("pc.sidebarCollapsed")).toBe("0");
    });

    it("setManualOrder records the order and flips sortBy to manual (sort off)", () => {
      expect(useStore.getState().sortBy).toBe("recent");

      useStore.getState().setManualOrder(["c", "a", "b"]);

      const st = useStore.getState();
      expect(st.manualOrder).toEqual(["c", "a", "b"]);
      expect(st.sortBy).toBe("manual");
      expect(JSON.parse(localStorage.getItem("pc.manualOrder")!)).toEqual(["c", "a", "b"]);
      expect(localStorage.getItem("pc.sortBy")).toBe("manual");
    });

    it("deleteSession prunes the gone session's folder, archived, and manual-order entries", async () => {
      useStore.setState({
        sessions: [session({ id: "a" }), session({ id: "b" })],
        activeId: "a",
        messages: { a: [] },
        folders: [{ id: "f1", name: "Work", open: true }],
        folderOf: { b: "f1" },
        archivedIds: ["b"],
        manualOrder: ["a", "b"],
      });

      await useStore.getState().deleteSession("b");

      const st = useStore.getState();
      expect(st.sessions.map((s) => s.id)).toEqual(["a"]);
      expect(st.folderOf).toEqual({});
      expect(st.archivedIds).toEqual([]);
      expect(st.manualOrder).toEqual(["a"]);
      expect(JSON.parse(localStorage.getItem("pc.folderOf")!)).toEqual({});
      expect(JSON.parse(localStorage.getItem("pc.archivedIds")!)).toEqual([]);
      expect(JSON.parse(localStorage.getItem("pc.manualOrder")!)).toEqual(["a"]);
    });

    it("write actions stay resilient when localStorage throws", () => {
      const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("quota");
      });

      // The action must still update in-memory state even if persistence fails.
      expect(() => useStore.getState().addFolder()).not.toThrow();
      expect(useStore.getState().folders).toHaveLength(1);

      spy.mockRestore();
    });

    it("hydrates the sidebar prefs from localStorage on init", async () => {
      localStorage.setItem("pc.sortBy", "name");
      localStorage.setItem("pc.groupBy", "status");
      localStorage.setItem("pc.folders", JSON.stringify([{ id: "f1", name: "Work", open: false }]));
      localStorage.setItem("pc.folderOf", JSON.stringify({ s1: "f1" }));
      localStorage.setItem("pc.archivedIds", JSON.stringify(["s2"]));
      localStorage.setItem("pc.manualOrder", JSON.stringify(["s3", "s1"]));
      localStorage.setItem("pc.sidebarCollapsed", "1");

      vi.resetModules();
      const fresh = await import("./store");
      const st = fresh.useStore.getState();

      expect(st.sortBy).toBe("name");
      expect(st.groupBy).toBe("status");
      expect(st.folders).toEqual([{ id: "f1", name: "Work", open: false }]);
      expect(st.folderOf).toEqual({ s1: "f1" });
      expect(st.archivedIds).toEqual(["s2"]);
      expect(st.manualOrder).toEqual(["s3", "s1"]);
      expect(st.sidebarCollapsed).toBe(true);
    });

    it("hydrates sortBy=manual and groupBy=branch", async () => {
      localStorage.setItem("pc.sortBy", "manual");
      localStorage.setItem("pc.groupBy", "branch");

      vi.resetModules();
      const fresh = await import("./store");

      expect(fresh.useStore.getState().sortBy).toBe("manual");
      expect(fresh.useStore.getState().groupBy).toBe("branch");
    });

    it("falls back to defaults when localStorage throws on init read", async () => {
      const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });

      vi.resetModules();
      const fresh = await import("./store");
      const st = fresh.useStore.getState();

      expect(st.sortBy).toBe("recent");
      expect(st.groupBy).toBe("none");
      expect(st.folders).toEqual([]);
      expect(st.folderOf).toEqual({});
      expect(st.archivedIds).toEqual([]);
      expect(st.manualOrder).toEqual([]);
      expect(st.sidebarCollapsed).toBe(false);

      spy.mockRestore();
    });
  });
});

describe("live subagents (agents panel)", () => {
  // Drive the desktop event path: send() wires onEvent, which we capture and feed
  // the agent lifecycle events the Rust spawner emits on the session channel.
  const startTurn = async (id = "a") => {
    let emit!: (e: StreamEvent) => void;
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      emit = onEvent;
      return { cancel: vi.fn(async () => {}), dispose: vi.fn() };
    });
    useStore.setState({
      sessions: [session({ id, title: "New chat" })],
      activeId: id,
      messages: { [id]: [] },
    });
    await useStore.getState().send("go");
    return emit;
  };

  it("tracks a subagent's lifecycle: started → progress → finished", async () => {
    const emit = await startTurn();

    emit({ type: "agent_started", agentId: "g1", description: "audit deps" });
    let a = useStore.getState().agents.a;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ id: "g1", description: "audit deps", status: "running", step: 0 });

    emit({ type: "agent_progress", agentId: "g1", step: 3 });
    expect(useStore.getState().agents.a[0].step).toBe(3);

    emit({ type: "agent_finished", agentId: "g1", status: "ok" });
    a = useStore.getState().agents.a;
    expect(a[0].status).toBe("ok");
    expect(a[0].step).toBe(3); // progress preserved
  });

  it("keeps multiple subagents in start order and records parentage", async () => {
    const emit = await startTurn();

    emit({ type: "agent_started", agentId: "g1", description: "first" });
    emit({ type: "agent_started", agentId: "g2", description: "second", parentId: "g1" });

    const a = useStore.getState().agents.a;
    expect(a.map((x) => x.id)).toEqual(["g1", "g2"]);
    expect(a[1].parentId).toBe("g1");
  });

  it("maps the finish status string, defaulting an unknown value to ok", async () => {
    const emit = await startTurn();
    emit({ type: "agent_started", agentId: "c", description: "x" });
    emit({ type: "agent_finished", agentId: "c", status: "cancelled" });
    expect(useStore.getState().agents.a[0].status).toBe("cancelled");

    emit({ type: "agent_started", agentId: "e", description: "y" });
    emit({ type: "agent_finished", agentId: "e", status: "kaboom" });
    expect(useStore.getState().agents.a.find((x) => x.id === "e")?.status).toBe("ok");
  });

  it("clears the previous turn's subagents when a new turn starts", async () => {
    const emit = await startTurn();
    emit({ type: "agent_started", agentId: "g1", description: "old" });
    expect(useStore.getState().agents.a).toHaveLength(1);
    emit({ type: "turn_end", stopReason: "end_turn" });

    // The next turn on the same session starts with an empty panel.
    await useStore.getState().send("again");
    expect(useStore.getState().agents.a).toEqual([]);
  });

  it("ignores a progress/finished event for an agent it never saw start", async () => {
    const emit = await startTurn();
    emit({ type: "agent_progress", agentId: "ghost", step: 2 });
    emit({ type: "agent_finished", agentId: "ghost", status: "ok" });
    expect(useStore.getState().agents.a).toEqual([]);
  });

  it("folds agent events from a phone live frame onto their session", () => {
    useStore.setState({ activeId: "a", agents: {} });
    const frame = (event: StreamEvent): SyncFrame => ({ t: "live", session_id: "a", event });

    useStore
      .getState()
      .applyFrame(frame({ type: "agent_started", agentId: "g1", description: "remote" }));
    useStore.getState().applyFrame(frame({ type: "agent_progress", agentId: "g1", step: 2 }));
    expect(useStore.getState().agents.a[0]).toMatchObject({ description: "remote", step: 2 });
  });

  it("clears the prior turn's subagents at the start of a new remote turn (phone path)", () => {
    // The phone has no local send() for the turn — the desktop drives it — so the
    // per-turn reset must happen on the turn_start frame, symmetric to the desktop.
    useStore.setState({
      activeId: "a",
      agents: { a: [{ id: "old", description: "prior turn", status: "ok", step: 4 }] },
    });
    const frame = (event: StreamEvent): SyncFrame => ({ t: "live", session_id: "a", event });

    useStore.getState().applyFrame(frame({ type: "turn_start", messageId: "m2" }));
    // The stale finished subagent from the previous turn is gone.
    expect(useStore.getState().agents.a).toEqual([]);

    // This turn's subagents repopulate the now-empty panel (no accumulation).
    useStore
      .getState()
      .applyFrame(frame({ type: "agent_started", agentId: "new", description: "fresh" }));
    expect(useStore.getState().agents.a.map((x) => x.id)).toEqual(["new"]);
  });

  it("cancelAgent calls the per-agent IPC on the desktop", async () => {
    await useStore.getState().cancelAgent("g1");
    expect(m.cancelAgentById).toHaveBeenCalledWith("g1");
    expect(m.phoneSyncSendCommand).not.toHaveBeenCalled();
  });

  it("cancelAgent sends a cancel_agent command in remote mode", async () => {
    useStore.setState({ remoteConnected: true });
    await useStore.getState().cancelAgent("g1");
    expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({ cmd: "cancel_agent", agent_id: "g1" });
    expect(m.cancelAgentById).not.toHaveBeenCalled();
  });

  it("cancelAgent swallows an IPC failure so the panel never throws", async () => {
    m.cancelAgentById.mockRejectedValueOnce(new Error("ipc boom"));
    await expect(useStore.getState().cancelAgent("g1")).resolves.toBeUndefined();
  });
});

describe("background shell tasks (background-tasks panel)", () => {
  // Drain microtasks AND macrotasks so a `void`-ed (fire-and-forget) background
  // subscription has finished installing its unlisten before we assert on it.
  const flush = () => new Promise((r) => setTimeout(r, 0));

  // Background events ride a per-session frame on the phone and a persistent
  // session listener on the desktop, both folding through the same reducer. The
  // phone `applyFrame` path is the cleanest way to exercise that reducer — it
  // never touches the module-scoped desktop listener registry.
  const bgFrame = (session_id: string, event: StreamEvent): SyncFrame => ({
    t: "live",
    session_id,
    event,
  });

  // The desktop listener registry (`bgListeners`) is module-scoped, so it leaks
  // across tests; clear it before each so subscribe/idempotency assertions start
  // from a clean slate (mirrors the store reset in the global beforeEach).
  beforeEach(() => teardownAllBackgroundListeners());

  it("tracks a background task's lifecycle: started → finished (ok)", () => {
    useStore.setState({ activeId: "a", backgroundTasks: {} });
    const f = useStore.getState().applyFrame;
    f(bgFrame("a", { type: "background_task_started", id: "t1", command: "npm run dev" }));
    let t = useStore.getState().backgroundTasks.a;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ id: "t1", command: "npm run dev", status: "running" });
    expect(t[0].exitCode).toBeUndefined();

    f(
      bgFrame("a", {
        type: "background_task_finished",
        id: "t1",
        command: "npm run dev",
        exitCode: 0,
        output: "served",
      }),
    );
    t = useStore.getState().backgroundTasks.a;
    expect(t[0]).toMatchObject({ status: "ok", exitCode: 0, output: "served" });
  });

  it("maps a non-zero exit code to an error status", () => {
    useStore.setState({ activeId: "a", backgroundTasks: {} });
    const f = useStore.getState().applyFrame;
    f(bgFrame("a", { type: "background_task_started", id: "t1", command: "make" }));
    f(
      bgFrame("a", {
        type: "background_task_finished",
        id: "t1",
        command: "make",
        exitCode: 2,
        output: "boom",
      }),
    );
    expect(useStore.getState().backgroundTasks.a[0]).toMatchObject({
      status: "error",
      exitCode: 2,
    });
  });

  it("keeps multiple tasks in launch order and replaces a duplicate start", () => {
    useStore.setState({ activeId: "a", backgroundTasks: {} });
    const f = useStore.getState().applyFrame;
    f(bgFrame("a", { type: "background_task_started", id: "t1", command: "first" }));
    f(bgFrame("a", { type: "background_task_started", id: "t2", command: "second" }));
    f(bgFrame("a", { type: "background_task_started", id: "t1", command: "first-again" }));
    const t = useStore.getState().backgroundTasks.a;
    expect(t.map((x) => x.id)).toEqual(["t1", "t2"]);
    expect(t[0].command).toBe("first-again");
  });

  it("upserts a finished event whose start it never saw", () => {
    useStore.setState({ activeId: "a", backgroundTasks: {} });
    useStore.getState().applyFrame(
      bgFrame("a", {
        type: "background_task_finished",
        id: "orphan",
        command: "probe",
        exitCode: 0,
        output: "ok",
      }),
    );
    const t = useStore.getState().backgroundTasks.a;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ id: "orphan", command: "probe", status: "ok" });
  });

  it("keeps background tasks across a turn boundary (they outlive the turn)", () => {
    // Unlike subagents (cleared on turn_start), a background task must survive into
    // the next turn — its finish can land turns after it was launched.
    useStore.setState({
      activeId: "a",
      backgroundTasks: { a: [{ id: "t1", command: "npm run dev", status: "running" }] },
      agents: { a: [{ id: "g", description: "x", status: "running", step: 1 }] },
    });
    useStore.getState().applyFrame(bgFrame("a", { type: "turn_start", messageId: "m2" }));
    // The subagent panel resets...
    expect(useStore.getState().agents.a).toEqual([]);
    // ...but the running background task is untouched.
    expect(useStore.getState().backgroundTasks.a).toHaveLength(1);
    expect(useStore.getState().backgroundTasks.a[0].id).toBe("t1");
  });

  it("records a background task on its OWN session even when another is active", () => {
    useStore.setState({ activeId: "active", backgroundTasks: {} });
    useStore
      .getState()
      .applyFrame(bgFrame("other", { type: "background_task_started", id: "t1", command: "bg" }));
    expect(useStore.getState().backgroundTasks.other).toHaveLength(1);
    expect(useStore.getState().backgroundTasks.active).toBeUndefined();
  });

  // ── desktop persistent-listener wiring ──────────────────────────────────────
  it("subscribes a persistent session listener and folds its background events", async () => {
    let emit!: (e: StreamEvent) => void;
    m.subscribeSessionEvents.mockImplementation(async (_sid, onEvent) => {
      emit = onEvent;
      return () => {};
    });
    useStore.setState({
      sessions: [session({ id: "bgt-desk" })],
      activeId: "bgt-desk",
      messages: { "bgt-desk": [] },
    });
    await useStore.getState().selectSession("bgt-desk");
    expect(m.subscribeSessionEvents).toHaveBeenCalledWith("bgt-desk", expect.any(Function));

    emit({ type: "background_task_started", id: "t1", command: "serve" });
    expect(useStore.getState().backgroundTasks["bgt-desk"]).toHaveLength(1);
    emit({ type: "background_task_finished", id: "t1", command: "serve", exitCode: 0, output: "" });
    expect(useStore.getState().backgroundTasks["bgt-desk"][0].status).toBe("ok");
  });

  it("subscribes a background listener for every session on init", async () => {
    m.listSessions.mockResolvedValue([
      session({ id: "bgt-init-1" }),
      session({ id: "bgt-init-2" }),
    ]);
    m.getMessages.mockResolvedValue([]);
    await useStore.getState().init();
    expect(m.subscribeSessionEvents).toHaveBeenCalledWith("bgt-init-1", expect.any(Function));
    expect(m.subscribeSessionEvents).toHaveBeenCalledWith("bgt-init-2", expect.any(Function));
  });

  it("subscribes a background listener after a pending session is first sent", async () => {
    useStore.setState({ sessions: [], activeId: null, messages: {} });
    await useStore.getState().newSession();
    const newId = useStore.getState().activeId;
    expect(newId).toBeTruthy();
    expect(m.subscribeSessionEvents).not.toHaveBeenCalledWith(newId, expect.any(Function));
    await useStore.getState().send("hello");
    expect(m.subscribeSessionEvents).toHaveBeenCalledWith(newId, expect.any(Function));
  });

  it("does not delete a session with running background work", async () => {
    const unlisten = vi.fn();
    m.subscribeSessionEvents.mockResolvedValue(unlisten);
    useStore.setState({
      sessions: [session({ id: "bgt-del" }), session({ id: "bgt-keep" })],
      activeId: "bgt-del",
      messages: { "bgt-del": [], "bgt-keep": [] },
      backgroundTasks: { "bgt-del": [{ id: "t1", command: "x", status: "running" }] },
      archivedIds: ["bgt-del"],
    });
    await useStore.getState().selectSession("bgt-del"); // installs the listener
    await flush(); // let the fire-and-forget subscription finish installing
    await useStore.getState().deleteSession("bgt-del");
    expect(unlisten).not.toHaveBeenCalled();
    expect(useStore.getState().backgroundTasks["bgt-del"]).toHaveLength(1);
  });

  it("resets background tasks on a fresh remote dial", async () => {
    useStore.setState({
      backgroundTasks: { a: [{ id: "t", command: "x", status: "running" }] },
    });
    await useStore.getState().connectRemote("qr");
    expect(useStore.getState().backgroundTasks).toEqual({});
  });

  it("survives a failed background subscription and can retry it later", async () => {
    m.subscribeSessionEvents.mockRejectedValueOnce(new Error("listen boom"));
    useStore.setState({
      sessions: [session({ id: "bgt-fail" })],
      activeId: "bgt-fail",
      messages: { "bgt-fail": [] },
    });
    // The subscribe is fire-and-forget; a rejected one must be swallowed (no
    // unhandled rejection) and must not break selecting the session.
    await expect(useStore.getState().selectSession("bgt-fail")).resolves.toBeUndefined();
    await flush(); // let the rejected subscribe settle (the reservation is dropped)

    // Because the failed reservation was released, a later select retries the
    // subscribe rather than treating the session as already-listening.
    m.subscribeSessionEvents.mockResolvedValueOnce(() => {});
    await useStore.getState().selectSession("bgt-fail");
    await flush();
    const calls = m.subscribeSessionEvents.mock.calls.filter((c) => c[0] === "bgt-fail");
    expect(calls).toHaveLength(2);
  });

  it("installs at most one persistent listener per session (idempotent)", async () => {
    m.subscribeSessionEvents.mockResolvedValue(() => {});
    useStore.setState({
      sessions: [session({ id: "bgt-idem" })],
      activeId: "bgt-idem",
      messages: { "bgt-idem": [] },
    });
    await useStore.getState().selectSession("bgt-idem");
    await flush();
    await useStore.getState().selectSession("bgt-idem");
    await flush();
    const calls = m.subscribeSessionEvents.mock.calls.filter((c) => c[0] === "bgt-idem");
    expect(calls).toHaveLength(1);
  });

  it("never installs a desktop listener in remote mode (the phone uses frames)", async () => {
    useStore.setState({
      remoteMode: true,
      sessions: [session({ id: "bgt-remote" })],
      activeId: "bgt-remote",
      messages: { "bgt-remote": [] },
    });
    await useStore.getState().selectSession("bgt-remote");
    await flush();
    const calls = m.subscribeSessionEvents.mock.calls.filter((c) => c[0] === "bgt-remote");
    expect(calls).toHaveLength(0);
  });

  it("honours a teardown that lands while the subscribe is still in flight", async () => {
    // The subscribe stays pending until we resolve it by hand, so we can interleave
    // a teardown (deleteSession) in the gap — the documented race. The just-resolved
    // listener must tear itself down (its reservation is gone), not leak.
    let resolveSub!: (un: () => void) => void;
    m.subscribeSessionEvents.mockImplementation(
      () => new Promise<() => void>((r) => (resolveSub = r)),
    );
    useStore.setState({
      sessions: [session({ id: "bgt-race" }), session({ id: "bgt-keep" })],
      activeId: "bgt-race",
      messages: { "bgt-race": [], "bgt-keep": [] },
      archivedIds: ["bgt-race"],
    });
    void useStore.getState().selectSession("bgt-race"); // starts the (pending) subscribe
    await flush();
    await useStore.getState().deleteSession("bgt-race"); // teardown before it resolves

    const unlisten = vi.fn();
    resolveSub(unlisten); // the subscribe finally resolves...
    await flush();
    expect(unlisten).toHaveBeenCalled(); // ...and the orphaned listener tore itself down
  });

  it("tears down desktop listeners when the device dials into remote mode", async () => {
    const unlisten = vi.fn();
    m.subscribeSessionEvents.mockResolvedValue(unlisten);
    useStore.setState({
      sessions: [session({ id: "bgt-conn" })],
      activeId: "bgt-conn",
      messages: { "bgt-conn": [] },
    });
    await useStore.getState().selectSession("bgt-conn"); // desktop installs the listener
    await flush();
    await useStore.getState().connectRemote("qr");
    expect(unlisten).toHaveBeenCalled(); // the persistent path is dropped on going remote
  });

  it("the per-turn listener ignores background events (the persistent listener owns them)", async () => {
    // During a turn BOTH listeners receive every `agent://{session}` event; only the
    // persistent one must act on background events. Drive a background event through
    // the per-turn onEvent and assert it changes nothing — no double-count.
    let perTurn!: (e: StreamEvent) => void;
    m.runAgent.mockImplementation(async (_id, _text, onEvent) => {
      perTurn = onEvent;
      return { cancel: vi.fn(async () => {}), dispose: vi.fn() };
    });
    useStore.setState({
      sessions: [session({ id: "bgt-turn" })],
      activeId: "bgt-turn",
      messages: { "bgt-turn": [] },
    });
    await useStore.getState().send("go");

    perTurn({ type: "background_task_started", id: "t1", command: "serve" });
    perTurn({
      type: "background_task_finished",
      id: "t1",
      command: "serve",
      exitCode: 0,
      output: "",
    });
    // The per-turn listener has no background case → background state is untouched.
    expect(useStore.getState().backgroundTasks["bgt-turn"]).toBeUndefined();
  });
});

describe("auto-update", () => {
  const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
    version: "5.1.0",
    currentVersion: "5.0.0",
    notes: "Bug fixes.",
    date: "2026-06-28",
    ...over,
  });

  describe("checkForUpdate", () => {
    it("stays idle when the core reports no update (null)", async () => {
      m.checkForUpdate.mockResolvedValue(null);
      // Seed a non-idle phase to prove a null check resets the banner away.
      useStore.setState({ update: { phase: "error", info: info(), progress: 50, error: "x" } });

      await useStore.getState().checkForUpdate();

      expect(m.checkForUpdate).toHaveBeenCalledTimes(1);
      expect(useStore.getState().update).toEqual({
        phase: "idle",
        info: null,
        progress: null,
        error: null,
      });
    });

    it("auto-downloads when an update exists and autoUpdate is on → ready", async () => {
      m.checkForUpdate.mockResolvedValue(info());
      m.downloadAndInstallUpdate.mockResolvedValue(true);
      useStore.setState({ settings: { ...DEFAULT_SETTINGS, autoUpdate: true } });

      await useStore.getState().checkForUpdate();

      // autoUpdate on → it kicked the download, which resolved → ready @ 100%.
      expect(m.downloadAndInstallUpdate).toHaveBeenCalledTimes(1);
      const st = useStore.getState();
      expect(st.update.phase).toBe("ready");
      expect(st.update.progress).toBe(100);
      expect(st.update.info).toEqual(info());
    });

    it("only offers (phase available) when autoUpdate is off", async () => {
      m.checkForUpdate.mockResolvedValue(info());
      useStore.setState({ settings: { ...DEFAULT_SETTINGS, autoUpdate: false } });

      await useStore.getState().checkForUpdate();

      expect(m.downloadAndInstallUpdate).not.toHaveBeenCalled();
      const st = useStore.getState();
      expect(st.update.phase).toBe("available");
      expect(st.update.info).toEqual(info());
    });

    it("swallows a failing check into the error phase (never throws)", async () => {
      m.checkForUpdate.mockRejectedValue(new Error("no updater here"));

      await expect(useStore.getState().checkForUpdate()).resolves.toBeUndefined();

      const st = useStore.getState();
      expect(st.update.phase).toBe("error");
      expect(st.update.error).toBe("no updater here");
    });

    it("records a background check failure without raising the global banner", async () => {
      m.checkForUpdate.mockRejectedValue(new Error("offline"));

      await useStore.getState().checkForUpdate({ background: true });

      expect(useStore.getState().update).toEqual({
        phase: "idle",
        info: null,
        progress: null,
        error: "offline",
      });
    });

    it("does not let a background poll displace a staged update", async () => {
      useStore.setState({
        update: { phase: "ready", info: info(), progress: 100, error: null },
      });

      await useStore.getState().checkForUpdate({ background: true });

      expect(m.checkForUpdate).not.toHaveBeenCalled();
      expect(useStore.getState().update.phase).toBe("ready");
    });
  });

  describe("startUpdateDownload", () => {
    it("transitions to downloading then ready on success (staged=true)", async () => {
      m.downloadAndInstallUpdate.mockResolvedValue(true);
      useStore.setState({
        update: { phase: "available", info: info(), progress: null, error: null },
      });

      await useStore.getState().startUpdateDownload();

      expect(m.downloadAndInstallUpdate).toHaveBeenCalledTimes(1);
      const st = useStore.getState();
      expect(st.update.phase).toBe("ready");
      expect(st.update.progress).toBe(100);
      // info is preserved across the download.
      expect(st.update.info).toEqual(info());
    });

    it("resets to idle when ipc reports no update was staged (staged=false)", async () => {
      m.downloadAndInstallUpdate.mockResolvedValue(false);
      useStore.setState({
        update: { phase: "available", info: info(), progress: null, error: null },
      });

      await useStore.getState().startUpdateDownload();

      const st = useStore.getState();
      expect(st.update.phase).toBe("idle");
      expect(st.update.info).toBeNull();
    });

    it("records an error and message when the download rejects", async () => {
      m.downloadAndInstallUpdate.mockRejectedValue(new Error("network down"));
      useStore.setState({
        update: { phase: "available", info: info(), progress: null, error: null },
      });

      await useStore.getState().startUpdateDownload();

      const st = useStore.getState();
      expect(st.update.phase).toBe("error");
      expect(st.update.error).toBe("network down");
    });
  });

  describe("applyUpdateProgress", () => {
    it("computes a rounded percent from downloaded/total", () => {
      useStore.getState().applyUpdateProgress(50, 200);
      expect(useStore.getState().update.progress).toBe(25);

      // Rounds rather than truncates.
      useStore.getState().applyUpdateProgress(1, 3);
      expect(useStore.getState().update.progress).toBe(33);
    });

    it("yields null (indeterminate) when the total is null or zero", () => {
      useStore.getState().applyUpdateProgress(10, null);
      expect(useStore.getState().update.progress).toBeNull();

      useStore.getState().applyUpdateProgress(10, 0);
      expect(useStore.getState().update.progress).toBeNull();
    });
  });

  describe("markUpdateReady", () => {
    it("sets phase ready at 100% (driven by the finished event)", () => {
      useStore.setState({
        update: { phase: "downloading", info: info(), progress: 40, error: null },
      });

      useStore.getState().markUpdateReady();

      const st = useStore.getState();
      expect(st.update.phase).toBe("ready");
      expect(st.update.progress).toBe(100);
      expect(st.update.info).toEqual(info());
    });
  });

  describe("relaunchForUpdate", () => {
    it("calls ipc.relaunchApp", async () => {
      m.relaunchApp.mockResolvedValue(undefined);

      await useStore.getState().relaunchForUpdate();

      expect(m.relaunchApp).toHaveBeenCalledTimes(1);
    });

    it("surfaces an error if relaunch is unavailable", async () => {
      m.relaunchApp.mockRejectedValue(new Error("no relaunch"));
      useStore.setState({ update: { phase: "ready", info: info(), progress: 100, error: null } });

      await expect(useStore.getState().relaunchForUpdate()).resolves.toBeUndefined();

      const st = useStore.getState();
      expect(st.update.phase).toBe("error");
      expect(st.update.error).toBe("no relaunch");
    });
  });

  describe("setAutoUpdate", () => {
    it("persists the preference via ipc.saveSettings", async () => {
      useStore.setState({ settings: { ...DEFAULT_SETTINGS, autoUpdate: true } });
      m.saveSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, autoUpdate: false });

      await useStore.getState().setAutoUpdate(false);

      expect(m.saveSettings).toHaveBeenCalledWith({ autoUpdate: false });
      expect(useStore.getState().settings.autoUpdate).toBe(false);
    });

    it("starts the download when enabled while an update is already available", async () => {
      m.downloadAndInstallUpdate.mockResolvedValue(true);
      m.saveSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, autoUpdate: true });
      useStore.setState({
        settings: { ...DEFAULT_SETTINGS, autoUpdate: false },
        update: { phase: "available", info: info(), progress: null, error: null },
      });

      await useStore.getState().setAutoUpdate(true);

      expect(m.saveSettings).toHaveBeenCalledWith({ autoUpdate: true });
      expect(m.downloadAndInstallUpdate).toHaveBeenCalledTimes(1);
      expect(useStore.getState().update.phase).toBe("ready");
    });

    it("does not start a download when enabled but no update is waiting", async () => {
      m.saveSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, autoUpdate: true });
      useStore.setState({
        settings: { ...DEFAULT_SETTINGS, autoUpdate: false },
        update: { phase: "idle", info: null, progress: null, error: null },
      });

      await useStore.getState().setAutoUpdate(true);

      expect(m.downloadAndInstallUpdate).not.toHaveBeenCalled();
    });

    it("does not start a download when the save failed (guard passes on mismatch)", async () => {
      // saveSettings rejects — updateSettings swallows into settingsError, settings unchanged.
      m.saveSettings.mockRejectedValueOnce(new Error("disk full"));
      useStore.setState({
        settings: { ...DEFAULT_SETTINGS, autoUpdate: false },
        update: { phase: "available", info: info(), progress: null, error: null },
      });

      await useStore.getState().setAutoUpdate(true);

      // The guard `if (get().settings.autoUpdate !== enabled) return;` short-circuits.
      expect(m.downloadAndInstallUpdate).not.toHaveBeenCalled();
      // The update phase is untouched because startUpdateDownload was never called.
      expect(useStore.getState().update.phase).toBe("available");
    });
  });

  describe("loadUpdateChannel", () => {
    it("stores the channel reported by the core", async () => {
      m.getUpdateChannel.mockResolvedValue("stable");

      await useStore.getState().loadUpdateChannel();

      expect(m.getUpdateChannel).toHaveBeenCalledTimes(1);
      expect(useStore.getState().updateChannel).toBe("stable");
    });

    it("stores the beta channel reported by the core", async () => {
      m.getUpdateChannel.mockResolvedValue("beta");

      await useStore.getState().loadUpdateChannel();

      expect(useStore.getState().updateChannel).toBe("beta");
    });

    it("keeps the default channel when the command is unavailable", async () => {
      m.getUpdateChannel.mockRejectedValue(new Error("unknown command"));

      await expect(useStore.getState().loadUpdateChannel()).resolves.toBeUndefined();

      expect(useStore.getState().updateChannel).toBe("stable");
    });
  });

  describe("dismissUpdateBanner", () => {
    it("returns to idle but keeps the staged info", () => {
      useStore.setState({
        update: { phase: "ready", info: info(), progress: 100, error: null },
      });

      useStore.getState().dismissUpdateBanner();

      const st = useStore.getState();
      expect(st.update.phase).toBe("idle");
      expect(st.update.progress).toBeNull();
      expect(st.update.error).toBeNull();
      // info is preserved so a later relaunch/re-check still knows the version.
      expect(st.update.info).toEqual(info());
    });
  });
});
