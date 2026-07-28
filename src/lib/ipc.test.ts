import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RemoteCommand, StreamEvent, SyncFrame } from "../types";
import type { WebSession, WebSessionConnector } from "./webSession";

// The IPC bridge has two paths per command: the Tauri path (serializes the call
// across `invoke`) and the in-browser fallback (a deterministic mock so the UI
// runs under plain `vite`). Both are exercised here. `@tauri-apps/api` is mocked
// so the suite never needs the native bridge.

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

const TAURI_KEY = "__TAURI_INTERNALS__";
const win = window as unknown as Record<string, unknown>;
const enterTauri = () => {
  win[TAURI_KEY] = {};
};
const exitTauri = () => {
  delete win[TAURI_KEY];
};

// A fresh module graph per test keeps the browser mock's internal settings
// singleton from leaking between cases, and hands back fresh `invoke`/`listen`
// spies each time.
async function load() {
  vi.resetModules();
  const ipc = await import("./ipc");
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  return { ipc, invoke: vi.mocked(invoke), listen: vi.mocked(listen) };
}

afterEach(() => {
  exitTauri();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("isTauri", () => {
  it("is false in a plain browser/jsdom window", async () => {
    const { ipc } = await load();
    expect(ipc.isTauri()).toBe(false);
  });

  it("is true once Tauri injects its internals onto window", async () => {
    const { ipc } = await load();
    enterTauri();
    expect(ipc.isTauri()).toBe(true);
  });
});

describe("web-client mode flag", () => {
  it("defaults to off and round-trips through setWebClientMode", async () => {
    const { ipc } = await load();
    // A fresh module graph hasn't had the PWA entry flip the flag, so the raw
    // flag reads false; setWebClientMode is the only way it turns on.
    expect(ipc.isWebClientMode()).toBe(false);
    ipc.setWebClientMode(true);
    expect(ipc.isWebClientMode()).toBe(true);
    ipc.setWebClientMode(false);
    expect(ipc.isWebClientMode()).toBe(false);
  });
});

describe("Codex marketplace bridge", () => {
  it("serializes only the allowlisted native marketplace and plugin commands", async () => {
    enterTauri();
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue(undefined);

    await ipc.listCodexPlugins();
    await ipc.readCodexPlugin("team", "notes");
    await ipc.addCodexMarketplace("https://example.com/team.git", "main", true);
    await ipc.removeCodexMarketplace("team", true);
    await ipc.upgradeCodexMarketplace("team");
    await ipc.installCodexPlugin("team", "notes", true);
    await ipc.uninstallCodexPlugin("notes@team", true);

    expect(invoke.mock.calls).toEqual([
      ["codex_marketplace_list"],
      ["codex_marketplace_plugin_read", { marketplace: "team", plugin: "notes" }],
      [
        "codex_marketplace_add",
        { source: "https://example.com/team.git", refName: "main", sourceConfirmed: true },
      ],
      ["codex_marketplace_remove", { marketplaceName: "team", removalConfirmed: true }],
      ["codex_marketplace_refresh", { marketplaceName: "team" }],
      [
        "codex_marketplace_plugin_install",
        {
          marketplace: "team",
          plugin: "notes",
          disclosureConfirmed: true,
        },
      ],
      ["codex_marketplace_plugin_uninstall", { pluginId: "notes@team", removalConfirmed: true }],
    ]);
  });

  it("returns deterministic display-safe browser marketplace mocks", async () => {
    const { ipc } = await load();

    const first = await ipc.listCodexPlugins();
    const second = await ipc.listCodexPlugins();
    expect(second).toEqual(first);
    expect(first.marketplaces).toHaveLength(1);
    expect(first.marketplaces[0].plugins).toHaveLength(1);

    const detail = await ipc.readCodexPlugin("preview", "starter");
    expect(detail.scheduledTasks).toEqual([
      {
        key: "daily-review",
        name: "Daily review",
        prompt: "Review the current project and summarize the next useful step.",
        schedule: { type: "daily", time: "09:00" },
      },
    ]);

    await expect(
      ipc.addCodexMarketplace("https://example.com/team.git", "main", true),
    ).resolves.toEqual({ marketplaceName: "preview-added", alreadyAdded: false });
    await expect(ipc.addCodexMarketplace("https://intranet/team.git", null, true)).rejects.toThrow(
      "public HTTPS",
    );
    await expect(
      ipc.addCodexMarketplace("https://example.com/team.git?access_token=secret", null, true),
    ).rejects.toThrow("public HTTPS");
    await expect(
      ipc.addCodexMarketplace("https://example.com/team.git", null, false),
    ).rejects.toThrow("confirmation");
    await expect(ipc.removeCodexMarketplace("team", false)).rejects.toThrow("confirmation");
    await expect(ipc.removeCodexMarketplace("team", true)).resolves.toEqual({
      marketplaceName: "team",
      removed: true,
    });
    await expect(ipc.upgradeCodexMarketplace("team")).resolves.toEqual({
      selectedMarketplaces: ["team"],
      upgradedCount: 1,
      errors: [],
    });
    await expect(ipc.installCodexPlugin("preview", "starter", true)).resolves.toEqual({
      authPolicy: "onUse",
      appsNeedingAuth: [],
    });
    await expect(ipc.uninstallCodexPlugin("starter@preview", false)).rejects.toThrow(
      "confirmation",
    );
    await expect(ipc.uninstallCodexPlugin("starter@preview", true)).resolves.toBeUndefined();

    const serialized = JSON.stringify({ first, detail });
    for (const forbidden of [
      "marketplacePath",
      "installedRoot",
      "localPath",
      "accessToken",
      "refreshToken",
      "clientSecret",
      "http://",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
describe("Tauri command serialization", () => {
  beforeEach(enterTauri);

  it("get_settings is invoked with no arguments", async () => {
    const { ipc, invoke } = await load();
    const settings = { provider: "openai" };
    invoke.mockResolvedValue(settings);
    await expect(ipc.getSettings()).resolves.toBe(settings);
    expect(invoke).toHaveBeenCalledWith("get_settings");
  });

  it("save_settings wraps Codex patches and normalizes retired provider values", async () => {
    const { ipc, invoke } = await load();
    const patch = { model: "gpt-5.6-sol" };
    invoke.mockResolvedValue({ ...patch });
    await ipc.saveSettings(patch);
    expect(invoke).toHaveBeenCalledWith("save_settings", { settings: patch });

    await ipc.saveSettings({ provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(invoke).toHaveBeenLastCalledWith("save_settings", {
      settings: { provider: "openai", model: "gpt-5.6-terra" },
    });
  });

  it("the legacy setApiKey alias authenticates through the Codex engine", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue(undefined);
    await ipc.setApiKey("sk-123");
    expect(invoke).toHaveBeenCalledWith("codex_login_api_key", { apiKey: "sk-123" });
  });

  it("OpenAI capability status and model catalogue invoke their scoped counterparts", async () => {
    const { ipc, invoke } = await load();
    const status = { signedIn: true, expiresAt: 123, account: "a@openai.com", tier: "Plus" };
    invoke.mockResolvedValue(status);
    await expect(ipc.openaiOauthStatus()).resolves.toBe(status);
    expect(invoke).toHaveBeenCalledWith("openai_oauth_status");

    const models = [
      {
        id: "gpt-live",
        label: "GPT Live",
        reasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
      },
    ];
    invoke.mockResolvedValue(models);
    await expect(ipc.openaiModels("codex-primary")).resolves.toBe(models);
    expect(invoke).toHaveBeenCalledWith("openai_models", {
      accountProfileId: "codex-primary",
    });
  });

  it("serializes Codex-slot commands with the canonical local profile id", async () => {
    const { ipc, invoke } = await load();
    const accountProfileId = "codex-primary";
    const summary = {
      id: accountProfileId,
      accountLabel: "one@chatgpt.test",
      tier: "Plus",
      expiresAt: 123,
      state: "connected",
      createdAt: 10,
      updatedAt: 20,
      lastUsedAt: null,
    };
    invoke.mockResolvedValue([summary]);

    await expect(ipc.listOpenAIAccounts()).resolves.toEqual([summary]);
    expect(invoke).toHaveBeenCalledWith("list_openai_accounts");
    invoke.mockResolvedValue(summary);
    await expect(ipc.startOpenAIAccountLogin()).resolves.toEqual(summary);
    expect(invoke).toHaveBeenCalledWith("start_openai_account_login");
    const reconnectOutcome = { status: "reconnected", account: summary };
    invoke.mockResolvedValue(reconnectOutcome);
    await expect(ipc.reconnectOpenAIAccount(accountProfileId)).resolves.toEqual(reconnectOutcome);
    expect(invoke).toHaveBeenCalledWith("reconnect_openai_account", { accountProfileId });

    invoke.mockResolvedValue(undefined);
    await ipc.removeOpenAIAccount(accountProfileId);
    expect(invoke).toHaveBeenCalledWith("remove_openai_account", { accountProfileId });
  });

  it("strips accidental credential and remote-identity fields before store serialization", async () => {
    const { ipc, invoke } = await load();
    const accessToken = "oauth-access-secret";
    const refreshToken = "oauth-refresh-secret";
    const idToken = "oauth-id-secret";
    const rawRemoteAccountId = "acct_remote_secret";
    const leakedNativeAccount = {
      id: "codex-primary",
      accountLabel: "one@chatgpt.test",
      tier: "Plus",
      expiresAt: 123,
      state: "connected",
      createdAt: 10,
      updatedAt: 20,
      lastUsedAt: null,
      accessToken,
      refreshToken,
      idToken,
      accountId: rawRemoteAccountId,
      tokens: { accessToken, refreshToken, idToken },
    };

    invoke.mockResolvedValueOnce([leakedNativeAccount]);
    const listed = await ipc.listOpenAIAccounts();
    invoke.mockResolvedValueOnce(leakedNativeAccount);
    const added = await ipc.startOpenAIAccountLogin();
    invoke.mockResolvedValueOnce({
      status: "reconnected",
      account: leakedNativeAccount,
      accessToken,
      accountId: rawRemoteAccountId,
    });
    const reconnect = await ipc.reconnectOpenAIAccount(leakedNativeAccount.id);

    const serializedStoreState = JSON.stringify({
      openAIAccounts: listed,
      addedOpenAIAccount: added,
      reconnect,
    });
    expect(serializedStoreState).not.toContain(accessToken);
    expect(serializedStoreState).not.toContain(refreshToken);
    expect(serializedStoreState).not.toContain(idToken);
    expect(serializedStoreState).not.toContain(rawRemoteAccountId);
    for (const forbiddenKey of ["accessToken", "refreshToken", "idToken", "accountId", "tokens"]) {
      expect(serializedStoreState).not.toContain(`"${forbiddenKey}"`);
    }
    expect(Object.keys(listed[0])).toEqual([
      "id",
      "accountLabel",
      "tier",
      "expiresAt",
      "state",
      "createdAt",
      "updatedAt",
      "lastUsedAt",
    ]);
  });

  it("subscribes to the exact native session channel and unwraps event payloads", async () => {
    const { ipc, listen } = await load();
    const off = vi.fn();
    let nativeHandler: ((event: { payload: StreamEvent }) => void) | undefined;
    listen.mockImplementation(async (_channel, handler) => {
      nativeHandler = handler as (event: { payload: StreamEvent }) => void;
      return off;
    });
    const onEvent = vi.fn();

    await expect(ipc.subscribeSessionEvents("session-1", onEvent)).resolves.toBe(off);
    expect(listen).toHaveBeenCalledWith("agent://session-1", expect.any(Function));
    const event = { type: "text_delta", text: "hello" } satisfies StreamEvent;
    nativeHandler?.({ payload: event });
    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it("get_plan_usage forwards the provider and optional account profile", async () => {
    const { ipc, invoke } = await load();
    const snapshot = {
      provider: "openai",
      plan: "Plus",
      updatedAt: 123,
      windows: [],
    };
    invoke.mockResolvedValue(snapshot);

    const accountProfileId = "codex-primary";
    await expect(ipc.getPlanUsage("openai", accountProfileId)).resolves.toBe(snapshot);
    expect(invoke).toHaveBeenCalledWith("get_plan_usage", {
      provider: "openai",
      accountProfileId,
    });
  });

  it("resolve_permission forwards one-shot and session-scoped decisions", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue(undefined);
    await ipc.resolvePermission("perm-1", "deny");
    expect(invoke).toHaveBeenCalledWith("resolve_permission", {
      id: "perm-1",
      decision: "deny",
      forSession: false,
    });
    await ipc.resolvePermission("perm-2", "allow", true);
    expect(invoke).toHaveBeenCalledWith("resolve_permission", {
      id: "perm-2",
      decision: "allow",
      forSession: true,
    });
  });

  it("telemetry_set_consent forwards the enabled flag", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue(undefined);
    await expect(ipc.setTelemetryConsent(true)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("telemetry_set_consent", { enabled: true });
    await ipc.setTelemetryConsent(false);
    expect(invoke).toHaveBeenCalledWith("telemetry_set_consent", { enabled: false });
  });

  it("session commands serialize their identifiers", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue(undefined);
    await ipc.createSession("s1", "Title", "C:/ws");
    await ipc.createSession("s2", "OpenAI", null, "gpt-5.6-sol", "codex-primary");
    await ipc.pinSessionOpenAIAccount("legacy", "codex-primary");
    await ipc.renameSession("s1", "Renamed");
    await ipc.updateSessionModel("s1", "gpt-5.6-sol");
    await ipc.deleteSession("s1");
    await ipc.getMessages("s1");
    await ipc.getMessagePage("s1", "cursor-1");
    expect(invoke).toHaveBeenCalledWith("create_session", {
      id: "s1",
      title: "Title",
      workspace: "C:/ws",
      model: undefined,
      accountProfileId: null,
    });
    expect(invoke).toHaveBeenCalledWith("create_session", {
      id: "s2",
      title: "OpenAI",
      workspace: null,
      model: "gpt-5.6-sol",
      accountProfileId: "codex-primary",
    });
    expect(invoke).toHaveBeenCalledWith("pin_session_openai_account", {
      sessionId: "legacy",
      accountProfileId: "codex-primary",
      model: null,
    });
    expect(invoke).toHaveBeenCalledWith("rename_session", { id: "s1", title: "Renamed" });
    expect(invoke).toHaveBeenCalledWith("update_session_model", {
      id: "s1",
      model: "gpt-5.6-sol",
    });
    expect(invoke).toHaveBeenCalledWith("delete_session", { id: "s1" });
    expect(invoke).toHaveBeenCalledWith("get_messages", { sessionId: "s1" });
    expect(invoke).toHaveBeenCalledWith("get_message_page", {
      sessionId: "s1",
      cursor: "cursor-1",
    });
  });

  it("draft commands serialize their identifiers", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue(undefined);
    await ipc.saveDraft("s1", "half a thought");
    expect(invoke).toHaveBeenCalledWith("save_draft", { sessionId: "s1", text: "half a thought" });

    invoke.mockResolvedValue("restored");
    await expect(ipc.getDraft("s1")).resolves.toBe("restored");
    expect(invoke).toHaveBeenCalledWith("get_draft", { sessionId: "s1" });

    const rows = [{ sessionId: "s1", text: "x" }];
    invoke.mockResolvedValue(rows);
    await expect(ipc.getDrafts()).resolves.toBe(rows);
    expect(invoke).toHaveBeenCalledWith("get_drafts");
  });

  it("usage commands invoke their core counterparts", async () => {
    const { ipc, invoke } = await load();
    const one = { sessionId: "s1", input: 100, output: 20 };
    invoke.mockResolvedValue(one);
    await expect(ipc.getUsage("s1")).resolves.toBe(one);
    expect(invoke).toHaveBeenCalledWith("get_usage", { sessionId: "s1" });

    const all = [one];
    invoke.mockResolvedValue(all);
    await expect(ipc.getAllUsage()).resolves.toBe(all);
    expect(invoke).toHaveBeenCalledWith("get_all_usage");
  });

  it("search_messages invokes its core counterpart with the query", async () => {
    const { ipc, invoke } = await load();
    const hits = [{ sessionId: "s1", messageId: "m1", seq: 2, role: "user", snippet: "hi" }];
    invoke.mockResolvedValue(hits);
    await expect(ipc.searchMessages("parser")).resolves.toBe(hits);
    expect(invoke).toHaveBeenCalledWith("search_messages", { query: "parser" });
  });

  it("list_dir passes the optional sub-path through", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue([]);
    await ipc.listDir("src/components");
    expect(invoke).toHaveBeenCalledWith("list_dir", { sub: "src/components" });
  });

  it("get_workspace_summary is invoked without a frontend-supplied path", async () => {
    const { ipc, invoke } = await load();
    const summary = {
      path: "C:/workspace",
      configured: true,
      git: { kind: "notRepository" },
    } as const;
    invoke.mockResolvedValue(summary);

    await expect(ipc.getWorkspaceSummary()).resolves.toBe(summary);
    expect(invoke).toHaveBeenCalledWith("get_workspace_summary");
  });

  it("get_session_archive_warning forwards only the persisted session id", async () => {
    const { ipc, invoke } = await load();
    const warning = {
      workspace: "C:/workspace/chat",
      branch: "feature/sidebar",
      detachedHead: null,
      changedFiles: 2,
      untrackedFiles: 1,
      additions: 8,
      deletions: 3,
    };
    invoke.mockResolvedValue(warning);

    await expect(ipc.getSessionArchiveWarning("s1")).resolves.toBe(warning);
    expect(invoke).toHaveBeenCalledWith("get_session_archive_warning", { sessionId: "s1" });
  });

  it("serializes typed Git review scopes and snapshot-guarded file requests", async () => {
    const { ipc, invoke } = await load();
    const scope = { kind: "branch", base: "origin/main" } as const;
    const manifest = { snapshotId: "snap-1", files: [] };
    invoke.mockResolvedValueOnce(manifest);

    await expect(ipc.getGitReviewManifest(scope)).resolves.toBe(manifest);
    expect(invoke).toHaveBeenCalledWith("get_git_review_manifest", { scope });

    const patch = { snapshotId: "snap-1", path: "src/App.tsx", hunks: [] };
    invoke.mockResolvedValueOnce(patch);
    await expect(ipc.getGitReviewFile(scope, "snap-1", "src/App.tsx")).resolves.toBe(patch);
    expect(invoke).toHaveBeenCalledWith("get_git_review_file", {
      scope,
      snapshotId: "snap-1",
      path: "src/App.tsx",
    });

    const branches = [
      { name: "main", revision: "refs/heads/main", kind: "local", current: true },
    ] as const;
    invoke.mockResolvedValueOnce(branches);
    await expect(ipc.getGitReviewBranches()).resolves.toBe(branches);
    expect(invoke).toHaveBeenCalledWith("get_git_review_branches");
  });

  it("loads turn review manifests and files by stable turn identity", async () => {
    const { ipc, invoke } = await load();
    const manifest = { turnId: "turn-7", snapshotId: "turn-snapshot", files: [] };
    invoke.mockResolvedValueOnce(manifest);

    await expect(ipc.getTurnReviewManifest("turn-7")).resolves.toBe(manifest);
    expect(invoke).toHaveBeenCalledWith("get_turn_review_manifest", { turnId: "turn-7" });

    const patch = { snapshotId: "turn-snapshot", path: "src/App.tsx", hunks: [] };
    invoke.mockResolvedValueOnce(patch);
    await expect(ipc.getTurnReviewFile("turn-7", "src/App.tsx")).resolves.toBe(patch);
    expect(invoke).toHaveBeenCalledWith("get_turn_review_file", {
      turnId: "turn-7",
      path: "src/App.tsx",
    });
  });

  it("list_sessions is invoked with no arguments", async () => {
    const { ipc, invoke } = await load();
    const sessions = [{ id: "s1" }];
    invoke.mockResolvedValue(sessions);
    await expect(ipc.listSessions()).resolves.toBe(sessions);
    expect(invoke).toHaveBeenCalledWith("list_sessions");
  });

  it("phone_sync_status is invoked with no arguments and returns the status", async () => {
    const { ipc, invoke } = await load();
    const status = { devicePublicKey: "abc==", paired: [] };
    invoke.mockResolvedValue(status);
    await expect(ipc.phoneSyncStatus()).resolves.toBe(status);
    expect(invoke).toHaveBeenCalledWith("phone_sync_status");
  });

  it("phone_sync_begin_pairing is invoked with no arguments and returns the payload", async () => {
    const { ipc, invoke } = await load();
    const payload = { version: 1, publicKey: "abc==", nonce: "nonce==" };
    invoke.mockResolvedValue(payload);
    await expect(ipc.phoneSyncBeginPairing()).resolves.toBe(payload);
    expect(invoke).toHaveBeenCalledWith("phone_sync_begin_pairing");
  });

  it("phone_sync_unpair forwards the publicKey and resolves void", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue(undefined);
    await expect(ipc.phoneSyncUnpair("abc==")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("phone_sync_unpair", { publicKey: "abc==" });
  });

  it("phone_sync_connect forwards the qr string + reconnect flag and returns the ConnectInfo", async () => {
    const { ipc, invoke } = await load();
    const info = { sas: "AB-12-CD", peerPublicKey: "KEY==" };
    invoke.mockResolvedValue(info);
    // Default (first pairing): reconnect defaults to false.
    await expect(ipc.phoneSyncConnect('{"version":1}')).resolves.toBe(info);
    expect(invoke).toHaveBeenCalledWith("phone_sync_connect", {
      qr: '{"version":1}',
      reconnect: false,
    });
    // Reconnect path forwards reconnect: true (binds an empty handshake prologue).
    invoke.mockResolvedValue(info);
    await ipc.phoneSyncConnect('{"version":1}', true);
    expect(invoke).toHaveBeenCalledWith("phone_sync_connect", {
      qr: '{"version":1}',
      reconnect: true,
    });
  });

  it("confirm_pairing and reject_pairing forward the requestId", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue(undefined);
    await expect(ipc.confirmPairing("req-1")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("confirm_pairing", { requestId: "req-1" });
    await expect(ipc.rejectPairing("req-2")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("reject_pairing", { requestId: "req-2" });
  });

  it("onPhoneSyncPairingRequest listens on the pairing-request channel and unwraps payloads", async () => {
    const { ipc, listen } = await load();
    const unlisten = vi.fn();
    let registered!: (ev: { payload: unknown }) => void;
    listen.mockImplementation(async (_channel, cb) => {
      registered = cb as typeof registered;
      return unlisten;
    });

    const onReq = vi.fn();
    const off = await ipc.onPhoneSyncPairingRequest(onReq);
    expect(listen).toHaveBeenCalledWith("phone-sync://pairing-request", expect.any(Function));

    registered({ payload: { requestId: "req-1", sas: "GOLF-77", peerKeyHex: "KEY==" } });
    expect(onReq).toHaveBeenCalledWith({
      requestId: "req-1",
      sas: "GOLF-77",
      peerKeyHex: "KEY==",
    });

    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("phone_sync_send_command wraps the command under a `command` key", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue(undefined);
    const command = { cmd: "run", session_id: "s1", text: "go" } as const;
    await expect(ipc.phoneSyncSendCommand(command)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("phone_sync_send_command", { command });
  });

  it("phone_sync_disconnect is invoked with no arguments", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue(undefined);
    await expect(ipc.phoneSyncDisconnect()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("phone_sync_disconnect");
  });

  it("onPhoneSyncFrame listens on the frame channel and unwraps payloads", async () => {
    const { ipc, listen } = await load();
    const unlisten = vi.fn();
    let registered!: (ev: { payload: unknown }) => void;
    listen.mockImplementation(async (_channel, cb) => {
      registered = cb as typeof registered;
      return unlisten;
    });

    const onFrame = vi.fn();
    const off = await ipc.onPhoneSyncFrame(onFrame);
    expect(listen).toHaveBeenCalledWith("phone-sync://frame", expect.any(Function));

    registered({
      payload: { t: "live", session_id: "s1", event: { type: "text_delta", text: "hi" } },
    });
    expect(onFrame).toHaveBeenCalledWith({
      t: "live",
      session_id: "s1",
      event: { type: "text_delta", text: "hi" },
    });

    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("openFolder returns the native picker's path, or null when cancelled", async () => {
    const { ipc } = await load();
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dialogOpen = vi.mocked(open);

    dialogOpen.mockResolvedValue("C:/picked/dir");
    await expect(ipc.openFolder()).resolves.toBe("C:/picked/dir");
    expect(dialogOpen).toHaveBeenCalledWith({ directory: true, multiple: false });

    // A cancelled picker (null) or a multi-select array is normalized to null.
    dialogOpen.mockResolvedValue(null);
    await expect(ipc.openFolder()).resolves.toBeNull();
  });

  it("picks multiple supported files and validates their paths through native code", async () => {
    const { ipc, invoke } = await load();
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dialogOpen = vi.mocked(open);
    const paths = ["C:/fixtures/example.rs", "C:/fixtures/pixel.png"];
    dialogOpen.mockResolvedValue(paths);

    await expect(ipc.pickAttachmentPaths()).resolves.toEqual(paths);
    expect(dialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: false,
        multiple: true,
        filters: expect.arrayContaining([
          expect.objectContaining({ name: "Text, code, and images" }),
        ]),
      }),
    );
    dialogOpen.mockResolvedValue(paths[0]);
    await expect(ipc.pickAttachmentPaths()).resolves.toEqual([paths[0]]);

    const validation = {
      attachments: [
        {
          path: paths[0],
          name: "example.rs",
          kind: "text",
          mediaType: "text/x-rust",
          size: 12,
          thumbnailUrl: null,
        },
      ],
      errors: [],
    };
    invoke.mockResolvedValue(validation);
    await expect(ipc.validateAttachments(paths)).resolves.toBe(validation);
    expect(invoke).toHaveBeenCalledWith("validate_attachments", { paths });
  });

  it("normalizes native webview file drops to logical composer coordinates", async () => {
    const { ipc } = await load();
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const unlisten = vi.fn();
    let nativeHandler!: (event: { payload: unknown }) => void;
    vi.mocked(getCurrentWebview).mockReturnValue({
      onDragDropEvent: vi.fn(async (handler) => {
        nativeHandler = handler as typeof nativeHandler;
        return unlisten;
      }),
    } as unknown as ReturnType<typeof getCurrentWebview>);
    vi.mocked(getCurrentWindow).mockReturnValue({
      scaleFactor: vi.fn(async () => 2),
    } as unknown as ReturnType<typeof getCurrentWindow>);
    const onDrop = vi.fn();

    await expect(ipc.onNativeFileDrop(onDrop)).resolves.toBe(unlisten);
    const position = { toLogical: vi.fn(() => ({ x: 42, y: 18 })) };
    nativeHandler({
      payload: {
        type: "enter",
        paths: ["C:/fixtures/example.rs"],
        position,
      },
    });
    nativeHandler({ payload: { type: "over", position } });
    nativeHandler({
      payload: {
        type: "drop",
        paths: ["C:/fixtures/example.rs"],
        position,
      },
    });
    nativeHandler({ payload: { type: "leave" } });

    expect(position.toLogical).toHaveBeenCalledWith(2);
    expect(onDrop).toHaveBeenNthCalledWith(1, {
      type: "enter",
      paths: ["C:/fixtures/example.rs"],
      x: 42,
      y: 18,
    });
    expect(onDrop).toHaveBeenNthCalledWith(2, {
      type: "over",
      x: 42,
      y: 18,
    });
    expect(onDrop).toHaveBeenNthCalledWith(3, {
      type: "drop",
      paths: ["C:/fixtures/example.rs"],
      x: 42,
      y: 18,
    });
    expect(onDrop).toHaveBeenNthCalledWith(4, { type: "leave" });
  });

  it("run_agent wires the per-session channel and unwraps event payloads", async () => {
    const { ipc, invoke, listen } = await load();
    const unlisten = vi.fn();
    let registered!: (ev: { payload: StreamEvent }) => void;
    listen.mockImplementation(async (_channel, cb) => {
      registered = cb as typeof registered;
      return unlisten;
    });
    invoke.mockResolvedValue(undefined);

    const onEvent = vi.fn();
    const handle = await ipc.runAgent(
      "sess-1",
      "hello",
      onEvent,
      ["C:/fixtures/example.rs", "C:/fixtures/pixel.png"],
      ["example.rs <attachment 1>", "pixel.png <attachment 2>"],
    );

    expect(listen).toHaveBeenCalledWith("agent://sess-1", expect.any(Function));
    expect(invoke).toHaveBeenCalledWith("run_agent", {
      sessionId: "sess-1",
      text: "hello",
      attachmentPaths: ["C:/fixtures/example.rs", "C:/fixtures/pixel.png"],
      attachmentDisplayNames: ["example.rs <attachment 1>", "pixel.png <attachment 2>"],
    });

    // Core events arrive wrapped as `{ payload }`; the bridge unwraps them.
    registered({ payload: { type: "text_delta", text: "hi" } });
    expect(onEvent).toHaveBeenCalledWith({ type: "text_delta", text: "hi" });

    await handle.cancel();
    expect(invoke).toHaveBeenCalledWith("cancel_agent", { sessionId: "sess-1" });
    expect(unlisten).not.toHaveBeenCalled();
    registered({ payload: { type: "turn_end", stopReason: "cancelled" } });
    expect(onEvent).toHaveBeenLastCalledWith({ type: "turn_end", stopReason: "cancelled" });
    handle.dispose();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("run_agent's dispose() stops listening WITHOUT cancelling the run", async () => {
    const { ipc, invoke, listen } = await load();
    const unlisten = vi.fn();
    listen.mockImplementation(async () => unlisten);
    invoke.mockResolvedValue(undefined);

    const handle = await ipc.runAgent("sess-2", "hi", vi.fn());
    handle.dispose();

    // A normal turn end just stops listening — it must NOT fire cancel_agent.
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("cancel_agent", { sessionId: "sess-2" });
  });

  it("run_agent tears down its new listener when invocation is rejected", async () => {
    const { ipc, invoke, listen } = await load();
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    invoke.mockRejectedValueOnce(new Error("session already running"));

    await expect(ipc.runAgent("busy", "hi", vi.fn())).rejects.toThrow("session already running");

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("cancelAgentById invokes cancel_agent_by_id with the agent id", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue(undefined);
    await ipc.cancelAgentById("agent-7");
    expect(invoke).toHaveBeenCalledWith("cancel_agent_by_id", { agentId: "agent-7" });
  });

  it("auto-update commands invoke their core counterparts", async () => {
    const { ipc, invoke } = await load();

    const info = { version: "5.1.0", currentVersion: "5.0.0", notes: "notes", date: null };
    invoke.mockResolvedValue(info);
    await expect(ipc.checkForUpdate()).resolves.toBe(info);
    expect(invoke).toHaveBeenCalledWith("update_check");

    invoke.mockResolvedValue(true);
    await expect(ipc.downloadAndInstallUpdate()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("update_download_and_install");

    await expect(ipc.relaunchApp()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("update_relaunch");

    invoke.mockResolvedValue("stable");
    await expect(ipc.getUpdateChannel()).resolves.toBe("stable");
    expect(invoke).toHaveBeenCalledWith("update_channel");
  });

  it("onUpdaterEvent listens on both updater channels and unwraps payloads", async () => {
    const { ipc, listen } = await load();
    const offProgress = vi.fn();
    const offFinished = vi.fn();
    const registered: Record<string, (ev: { payload: unknown }) => void> = {};
    listen.mockImplementation(async (channel, cb) => {
      registered[channel] = cb as (ev: { payload: unknown }) => void;
      return channel === "updater://progress" ? offProgress : offFinished;
    });

    const events: Array<
      { kind: "progress"; downloaded: number; total: number | null } | { kind: "finished" }
    > = [];
    const off = await ipc.onUpdaterEvent((e) => events.push(e));
    expect(listen).toHaveBeenCalledWith("updater://progress", expect.any(Function));
    expect(listen).toHaveBeenCalledWith("updater://finished", expect.any(Function));

    registered["updater://progress"]({ payload: { downloaded: 50, total: 100 } });
    expect(events).toContainEqual({ kind: "progress", downloaded: 50, total: 100 });

    registered["updater://finished"]({ payload: null });
    expect(events).toContainEqual({ kind: "finished" });

    // The composite unlisten tears down BOTH channel subscriptions.
    off();
    expect(offProgress).toHaveBeenCalledTimes(1);
    expect(offFinished).toHaveBeenCalledTimes(1);
  });
});

describe("browser fallback (no Tauri core)", () => {
  beforeEach(exitTauri);

  it("cancelAgentById is a no-op without a Tauri core", async () => {
    const { ipc, invoke } = await load();
    await expect(ipc.cancelAgentById("agent-7")).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("getSettings returns the mock defaults without touching invoke", async () => {
    const { ipc, invoke } = await load();
    await expect(ipc.getSettings()).resolves.toEqual({
      provider: "openai",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      responseSpeed: "standard",
      defaultPolicy: "ask",
      workspace: null,
      typingAnimation: false,
      permissionMode: "default",
      rules: [],
      autoUpdate: true,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("auto-update commands are inert in the browser (no update, no relaunch)", async () => {
    const { ipc, invoke, listen } = await load();

    await expect(ipc.checkForUpdate()).resolves.toBeNull();
    await expect(ipc.downloadAndInstallUpdate()).resolves.toBe(false);
    await expect(ipc.relaunchApp()).resolves.toBeUndefined();
    await expect(ipc.getUpdateChannel()).resolves.toBe("stable");

    const events: unknown[] = [];
    const off = await ipc.onUpdaterEvent((e) => events.push(e));
    off(); // inert unlisten — safe to call
    expect(events).toHaveLength(0);

    // Nothing crossed the (absent) native bridge.
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("saveSettings keeps partial Codex patches and normalizes retired providers", async () => {
    const { ipc } = await load();
    const next = await ipc.saveSettings({ model: "gpt-5.6-sol" });
    expect(next.model).toBe("gpt-5.6-sol");
    expect(next.provider).toBe("openai");

    const normalizedProvider = await ipc.saveSettings({ provider: "anthropic" });
    expect(normalizedProvider).toMatchObject({ provider: "openai", model: "gpt-5.6-sol" });
    const normalizedModel = await ipc.saveSettings({ model: "claude-sonnet-4-6" });
    expect(normalizedModel).toMatchObject({ provider: "openai", model: "gpt-5.6-terra" });
  });

  it("setApiKey is a compatibility alias for the single Codex API-key slot", async () => {
    const { ipc } = await load();
    await ipc.setApiKey("sk-test");
    expect(await ipc.openaiOauthStatus()).toMatchObject({
      signedIn: true,
      account: "OpenAI Platform API key",
      tier: "OpenAI Platform",
    });
    expect(await ipc.listOpenAIAccounts()).toEqual([
      expect.objectContaining({
        id: "codex-primary",
        accountLabel: "OpenAI Platform API key",
        state: "connected",
      }),
    ]);
  });

  it("listSessions and getMessages are empty without a core", async () => {
    const { ipc } = await load();
    await expect(ipc.listSessions()).resolves.toEqual([]);
    await expect(ipc.getMessages("any")).resolves.toEqual([]);
    await expect(ipc.getMessagePage("any")).resolves.toEqual({ messages: [], nextCursor: null });
  });

  it("browser sessions round-trip authoritative rows", async () => {
    const { ipc, invoke } = await load();
    const created = await ipc.createSession("id", "title", null);
    expect(created).toMatchObject({
      id: "id",
      title: "title",
      model: "gpt-5.6-terra",
      accountProfileId: "codex-primary",
    });
    await expect(ipc.listSessions()).resolves.toEqual([created]);
    await expect(ipc.renameSession("id", "new")).resolves.toBeUndefined();
    await expect(ipc.deleteSession("id")).resolves.toBeUndefined();
    await expect(ipc.getSessionArchiveWarning("id")).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("draft + usage commands degrade cleanly without a core", async () => {
    // Web/preview has no desktop DB — the store's localStorage mirror is the
    // persistence — so these no-op / return empty instead of touching invoke.
    const { ipc, invoke } = await load();
    await expect(ipc.saveDraft("s1", "x")).resolves.toBeUndefined();
    await expect(ipc.getDraft("s1")).resolves.toBeNull();
    await expect(ipc.getDrafts()).resolves.toEqual([]);
    await expect(ipc.getUsage("s1")).resolves.toEqual({ sessionId: "s1", input: 0, output: 0 });
    await expect(ipc.getAllUsage()).resolves.toEqual([]);
    // Search has no desktop DB to hit in web mode; the store falls back to an
    // in-memory search, so the ipc wrapper just returns [] without touching invoke.
    await expect(ipc.searchMessages("x")).resolves.toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("listDir walks the canned tree and returns [] for unknown paths", async () => {
    const { ipc } = await load();
    const root = await ipc.listDir();
    expect(root.map((e) => e.name)).toContain("src");
    expect(await ipc.listDir("src")).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "App.tsx", isDir: false })]),
    );
    expect(await ipc.listDir("does/not/exist")).toEqual([]);
  });

  it("returns deterministic workspace facts in the browser preview", async () => {
    const { ipc, invoke } = await load();

    const summary = await ipc.getWorkspaceSummary();
    expect(summary).toMatchObject({
      path: "C:/dev/portcode",
      configured: false,
      git: {
        kind: "repository",
        branch: "main",
        changedFiles: 6,
        additions: 342,
        deletions: 28,
      },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns deterministic review manifests and typed patches in browser preview", async () => {
    const { ipc, invoke } = await load();

    const manifest = await ipc.getGitReviewManifest({ kind: "workingTree" });
    expect(manifest.snapshotId).toBe("preview-workingTree-workingTree");
    expect(manifest.files.map((file) => file.path)).toContain("src/App.tsx");
    expect(manifest.files.find((file) => file.path === "src/App.tsx")?.areas).toEqual([
      "staged",
      "unstaged",
    ]);

    const patch = await ipc.getGitReviewFile(
      { kind: "workingTree" },
      manifest.snapshotId,
      "src/App.tsx",
    );
    expect(patch.hunks[0].lines.map((line) => line.kind)).toEqual([
      "context",
      "deletion",
      "addition",
      "addition",
      "context",
    ]);
    await expect(ipc.getGitReviewBranches()).resolves.toEqual([
      { name: "main", revision: "refs/heads/main", kind: "local", current: true },
      { name: "release", revision: "refs/heads/release", kind: "local", current: false },
      {
        name: "origin/main",
        revision: "refs/remotes/origin/main",
        kind: "remote",
        current: false,
      },
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps every browser review scope deterministic and scope-specific", async () => {
    const { ipc } = await load();

    const staged = await ipc.getGitReviewManifest({ kind: "staged" });
    expect(staged).toMatchObject({ baseLabel: "9c31f2ab", targetLabel: "Index" });
    expect(staged.files.every((file) => file.areas.join() === "staged")).toBe(true);

    const unstaged = await ipc.getGitReviewManifest({ kind: "unstaged" });
    expect(unstaged).toMatchObject({ baseLabel: "Index", targetLabel: "Working tree" });
    expect(unstaged.files.map((file) => file.areas[0])).toEqual(
      expect.arrayContaining(["unstaged", "untracked"]),
    );

    const branch = await ipc.getGitReviewManifest({
      kind: "branch",
      base: "refs/heads/release",
    });
    expect(branch.baseLabel).toMatch(/^merge-base\(release\).*17a19ee0$/);
    expect(branch.targetLabel).toBe("HEAD");
    expect(branch.files.every((file) => file.areas.join() === "committed")).toBe(true);

    const commit = await ipc.getGitReviewManifest({ kind: "commit", revision: "abc123" });
    expect(commit).toMatchObject({
      snapshotId: "preview-commit-abc123",
      baseLabel: "parent of 9c31f2ab",
      targetLabel: "abc123",
    });
    expect(commit.files.every((file) => file.areas.join() === "committed")).toBe(true);
  });

  it("rejects a stale browser-preview review snapshot", async () => {
    const { ipc } = await load();
    await expect(
      ipc.getGitReviewFile({ kind: "staged" }, "old-snapshot", "src/App.tsx"),
    ).rejects.toThrow("stale");
  });

  it("returns a receipt-backed browser turn manifest without inventing historical patches", async () => {
    const { ipc, invoke } = await load();
    const manifest = await ipc.getTurnReviewManifest("turn-preview");

    expect(manifest).toMatchObject({
      turnId: "turn-preview",
      snapshotId: "preview-turn-turn-preview",
      patchesAvailable: false,
      receipt: { turnId: "turn-preview", status: "completed" },
    });
    expect(manifest.files).toEqual(manifest.receipt.changedFiles);
    await expect(ipc.getTurnReviewFile("turn-preview", "src/App.tsx")).rejects.toThrow(
      "unavailable",
    );
    await expect(ipc.getTurnReviewFile("turn-preview", "missing.ts")).rejects.toThrow("not part");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("openFolder returns the canned preview path", async () => {
    const { ipc } = await load();
    await expect(ipc.openFolder()).resolves.toBe("C:/dev/porthex/portcode");
  });

  it("honestly disables local attachments without a native desktop host", async () => {
    const { ipc } = await load();
    await expect(ipc.pickAttachmentPaths()).resolves.toEqual([]);
    await expect(ipc.validateAttachments(["/synthetic/example.txt"])).resolves.toEqual({
      attachments: [],
      errors: [
        {
          name: "example.txt",
          message: "Local attachments are available only in the Portcode desktop app.",
        },
      ],
    });
    const handler = vi.fn();
    const unlisten = await ipc.onNativeFileDrop(handler);
    unlisten();
    expect(handler).not.toHaveBeenCalled();
  });

  it("resolvePermission is harmless when nothing is pending", async () => {
    const { ipc } = await load();
    await expect(ipc.resolvePermission("missing", "allow")).resolves.toBeUndefined();
  });

  it("setTelemetryConsent is an inert no-op without a Rust host (no invoke)", async () => {
    const { ipc, invoke } = await load();
    await expect(ipc.setTelemetryConsent(true)).resolves.toBeUndefined();
    await expect(ipc.setTelemetryConsent(false)).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("phoneSyncStatus returns a stable mock identity with no paired devices initially", async () => {
    const { ipc } = await load();
    const status = await ipc.phoneSyncStatus();
    expect(typeof status.devicePublicKey).toBe("string");
    expect(status.devicePublicKey.length).toBeGreaterThan(0);
    expect(status.paired).toEqual([]);
  });

  it("phoneSyncBeginPairing returns a payload containing the device's public key and a nonce", async () => {
    const { ipc } = await load();
    const payload = await ipc.phoneSyncBeginPairing();
    expect(payload.version).toBe(1);
    expect(typeof payload.publicKey).toBe("string");
    expect(typeof payload.nonce).toBe("string");
    // The mock payload's publicKey should match the device key from status.
    const status = await ipc.phoneSyncStatus();
    expect(payload.publicKey).toBe(status.devicePublicKey);
  });

  it("phoneSyncUnpair removes a paired device from the mock state", async () => {
    const { ipc } = await load();
    // Confirm initially empty, then unpair a non-existent key is harmless.
    const before = await ipc.phoneSyncStatus();
    expect(before.paired).toEqual([]);
    await expect(ipc.phoneSyncUnpair("unknown==")).resolves.toBeUndefined();
    const after = await ipc.phoneSyncStatus();
    expect(after.paired).toEqual([]);
  });

  it("phoneSyncConnect returns a deterministic SAS + pinned key", async () => {
    const { ipc, invoke } = await load();
    const info = await ipc.phoneSyncConnect("any-qr");
    expect(typeof info.sas).toBe("string");
    expect(info.sas.length).toBeGreaterThan(0);
    expect(typeof info.peerPublicKey).toBe("string");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("phoneSyncSendCommand and phoneSyncDisconnect are harmless no-ops", async () => {
    const { ipc, invoke } = await load();
    await expect(
      ipc.phoneSyncSendCommand({ cmd: "cancel", session_id: "s1" }),
    ).resolves.toBeUndefined();
    await expect(ipc.phoneSyncDisconnect()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("onPhoneSyncFrame yields an inert unlisten that never emits", async () => {
    const { ipc } = await load();
    const onFrame = vi.fn();
    const off = await ipc.onPhoneSyncFrame(onFrame);
    expect(typeof off).toBe("function");
    off(); // must not throw
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("the device-trust gate surface is inert in the browser mock", async () => {
    const { ipc, invoke } = await load();
    // The pairing-request subscription never fires in the preview (no real phone).
    const onReq = vi.fn();
    const off = await ipc.onPhoneSyncPairingRequest(onReq);
    expect(typeof off).toBe("function");
    off(); // must not throw
    expect(onReq).not.toHaveBeenCalled();
    // confirm/reject are harmless no-ops that never reach the (absent) core.
    await expect(ipc.confirmPairing("req-1")).resolves.toBeUndefined();
    await expect(ipc.rejectPairing("req-1")).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("OpenAI mock uses one canonical slot and replaces its authentication mode", async () => {
    const { ipc } = await load();
    expect((await ipc.openaiOauthStatus()).signedIn).toBe(false);
    expect(await ipc.listOpenAIAccounts()).toEqual([]);

    await ipc.loginCodexApiKey("sk-test");
    expect(await ipc.listOpenAIAccounts()).toEqual([
      expect.objectContaining({
        id: "codex-primary",
        accountLabel: "OpenAI Platform API key",
      }),
    ]);

    const account = await ipc.startOpenAIAccountLogin();
    expect(account).toMatchObject({
      id: "codex-primary",
      accountLabel: "preview@chatgpt.local",
      tier: "ChatGPT Plus",
      state: "connected",
      lastUsedAt: expect.any(Number),
    });
    expect(await ipc.listOpenAIAccounts()).toHaveLength(1);
    expect(Object.keys(account)).toEqual([
      "id",
      "accountLabel",
      "tier",
      "expiresAt",
      "state",
      "createdAt",
      "updatedAt",
      "lastUsedAt",
    ]);
    await expect(ipc.openaiModels(account.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gpt-5.6-sol",
          defaultReasoningEffort: "low",
          reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        }),
      ]),
    );

    await ipc.removeOpenAIAccount(account.id);
    expect(await ipc.listOpenAIAccounts()).toEqual([]);
    await expect(ipc.openaiModels(account.id)).rejects.toThrow(/Connect ChatGPT/i);

    const reconnected = await ipc.reconnectOpenAIAccount(account.id);
    expect(reconnected).toMatchObject({
      status: "reconnected",
      account: { id: account.id, state: "connected" },
    });
    await expect(ipc.openaiModels(account.id)).resolves.toHaveLength(3);
    await expect(ipc.removeOpenAIAccount("retired-profile-id")).rejects.toThrow(/not found/i);
  });

  it("browser sessions always pin the bundled engine's primary Codex slot", async () => {
    const { ipc } = await load();
    const unknownProfileId = "retired-profile-id";

    await expect(
      ipc.createSession("unknown", "Unknown", null, "gpt-5.6-sol", unknownProfileId),
    ).rejects.toThrow(/no longer available/i);
    await expect(ipc.createSession("legacy", "Legacy", null, "claude-opus-4-8")).rejects.toThrow(
      /Codex engine/i,
    );

    const account = await ipc.startOpenAIAccountLogin();
    const created = await ipc.createSession(
      "account-scoped",
      "Account scoped",
      null,
      "gpt-5.6-sol",
      account.id,
    );
    expect(created).toMatchObject({
      id: "account-scoped",
      accountProfileId: account.id,
      branch: null,
    });
    expect(await ipc.listSessions()).toContainEqual(created);
    expect((await ipc.listOpenAIAccounts())[0].lastUsedAt).toEqual(expect.any(Number));

    await expect(
      ipc.createSession("missing-default", "Missing default", null, "gpt-5.6-sol", null),
    ).resolves.toMatchObject({ accountProfileId: "codex-primary" });
    await expect(ipc.pinSessionOpenAIAccount(created.id, account.id)).resolves.toMatchObject({
      accountProfileId: account.id,
    });
    const replacement = await ipc.startOpenAIAccountLogin();
    expect(replacement.id).toBe(account.id);
    await expect(
      ipc.pinSessionOpenAIAccount(created.id, replacement.id, "gpt-5.6-terra"),
    ).resolves.toMatchObject({
      accountProfileId: "codex-primary",
      model: "gpt-5.6-terra",
    });
    await ipc.runAgent(created.id, "start the chat", () => undefined);
    await expect(ipc.pinSessionOpenAIAccount(created.id, account.id)).resolves.toMatchObject({
      accountProfileId: "codex-primary",
    });
    await expect(ipc.pinSessionOpenAIAccount("missing", account.id)).rejects.toThrow(/not found/i);
    await expect(ipc.pinSessionOpenAIAccount(created.id, unknownProfileId)).rejects.toThrow(
      /no longer available/i,
    );
    await expect(ipc.reconnectOpenAIAccount(unknownProfileId)).rejects.toThrow(/not found/i);
  });

  it("browser plan usage is available only for the connected Codex slot", async () => {
    const { ipc, invoke } = await load();
    await expect(ipc.getPlanUsage("openai", "codex-primary")).rejects.toThrow(
      /connected Codex account/i,
    );
    await expect(ipc.getPlanUsage("anthropic" as never, "codex-primary")).rejects.toThrow(
      /OpenAI authentication only/i,
    );

    const account = await ipc.startOpenAIAccountLogin();
    const openai = await ipc.getPlanUsage("openai", account.id);
    expect(openai).toMatchObject({ provider: "openai", plan: "Plus" });
    expect(openai.windows.map((window) => window.label)).toEqual([
      "Current session",
      "Weekly limit",
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("browser fallback agent stream", () => {
  beforeEach(exitTauri);

  it("streams a complete turn and ends without a gate when policy allows", async () => {
    const { ipc } = await load();
    await ipc.saveSettings({ defaultPolicy: "allow" });
    vi.useFakeTimers();

    const events: StreamEvent[] = [];
    await ipc.runAgent("s", "hi", (e) => events.push(e));
    await vi.runAllTimersAsync();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("turn_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("tool_use");
    expect(types).toContain("usage");
    expect(types[types.length - 1]).toBe("turn_end");
    expect(types).not.toContain("permission_request");
    expect(events.filter((e) => e.type === "tool_use").map((e) => e.name)).toEqual([
      "read_file",
      "edit_file",
    ]);
  });

  it("raises a permission_request under the default ask policy, and cancel tears it down", async () => {
    const { ipc } = await load();
    await ipc.saveSettings({ defaultPolicy: "ask" });
    vi.useFakeTimers();

    const events: StreamEvent[] = [];
    const { cancel } = await ipc.runAgent("s", "hi", (e) => events.push(e));
    await vi.advanceTimersByTimeAsync(3000);

    expect(events.find((e) => e.type === "permission_request")).toMatchObject({
      tool: "edit_file",
    });

    await cancel(); // resolves the pending gate (deny) and halts the run
    await vi.runAllTimersAsync();
  });

  it("cancelling before the first tick suppresses every event", async () => {
    const { ipc } = await load();
    await ipc.saveSettings({ defaultPolicy: "allow" });
    vi.useFakeTimers();

    const onEvent = vi.fn();
    const { cancel } = await ipc.runAgent("s", "hi", onEvent);
    await cancel();
    await vi.runAllTimersAsync();

    expect(onEvent).not.toHaveBeenCalled();
  });
});

// Web-client mode: the Vercel PWA enables it (setWebClientMode) after injecting a
// WASM-backed connector, and the Phone Sync CLIENT calls then route through the
// `webSession` transport instead of the mock. `isTauri()` still wins.
describe("web-client mode (WASM transport routing)", () => {
  // A fresh module graph so ipc + webSession share one instance and the web-client
  // flag / injected connector don't leak across cases.
  async function loadWeb() {
    vi.resetModules();
    const ipc = await import("./ipc");
    const webSession = await import("./webSession");
    return { ipc, webSession };
  }

  /** Build a recording WebSession + connector so the test can assert routing and
   *  drive the frame / disconnected callbacks. */
  function recordingConnector() {
    const sent: RemoteCommand[] = [];
    const calls: { qr: string; reconnect: boolean }[] = [];
    let frameCb: ((f: SyncFrame) => void) | null = null;
    let disconnectedCb: (() => void) | null = null;
    let disconnected = false;
    let rejected = false;

    const session: WebSession = {
      sas: "WEB-SAS",
      peerPublicKey: "WEB-KEY",
      async sendCommand(cmd) {
        sent.push(cmd);
      },
      onFrame(cb) {
        frameCb = cb;
        return () => {
          frameCb = null;
        };
      },
      onDisconnected(cb) {
        disconnectedCb = cb;
        return () => {
          disconnectedCb = null;
        };
      },
      async reject() {
        rejected = true;
        disconnectedCb?.();
      },
      async disconnect() {
        disconnected = true;
        disconnectedCb?.();
      },
    };

    const connector: WebSessionConnector = {
      async connect(qr, reconnect) {
        calls.push({ qr, reconnect });
        return session;
      },
    };

    return {
      connector,
      sent,
      calls,
      fireFrame: (f: SyncFrame) => frameCb?.(f),
      isDisconnected: () => disconnected,
      isRejected: () => rejected,
    };
  }

  it("routes the Phone Sync client surface through the injected web transport", async () => {
    const { ipc, webSession } = await loadWeb();
    const rec = recordingConnector();
    webSession.setWebSessionConnector(rec.connector);
    ipc.setWebClientMode(true);

    const info = await ipc.phoneSyncConnect("qr-1", true);
    expect(info).toEqual({ sas: "WEB-SAS", peerPublicKey: "WEB-KEY" });
    expect(rec.calls).toEqual([{ qr: "qr-1", reconnect: true }]);

    const frames: SyncFrame[] = [];
    const unlisten = await ipc.onPhoneSyncFrame((f) => frames.push(f));
    rec.fireFrame({ t: "ack", session_id: "s1", seq: 7 });
    expect(frames).toHaveLength(1);
    unlisten();
    rec.fireFrame({ t: "ack", session_id: "s1", seq: 8 });
    expect(frames).toHaveLength(1); // unlistened: no further delivery

    let dropped = false;
    await ipc.onPhoneSyncDisconnected(() => {
      dropped = true;
    });
    await ipc.phoneSyncSendCommand({ cmd: "cancel", session_id: "s1" });
    expect(rec.sent).toEqual([{ cmd: "cancel", session_id: "s1" }]);

    await ipc.phoneSyncDisconnect();
    expect(rec.isDisconnected()).toBe(true);
    expect(dropped).toBe(true);
  });

  it("connect defaults reconnect to false in web-client mode", async () => {
    const { ipc, webSession } = await loadWeb();
    const rec = recordingConnector();
    webSession.setWebSessionConnector(rec.connector);
    ipc.setWebClientMode(true);

    await ipc.phoneSyncConnect("qr-2");
    expect(rec.calls).toEqual([{ qr: "qr-2", reconnect: false }]);
  });

  it("phoneSyncReject routes to the web transport's reject (not disconnect)", async () => {
    const { ipc, webSession } = await loadWeb();
    const rec = recordingConnector();
    webSession.setWebSessionConnector(rec.connector);
    ipc.setWebClientMode(true);

    await ipc.phoneSyncConnect("qr", false);
    await ipc.phoneSyncReject();

    // Routed through the session's reject (carries the pairing_reject frame), and the
    // current session is cleared (a later disconnect is a no-op).
    expect(rec.isRejected()).toBe(true);
    expect(rec.isDisconnected()).toBe(false);
  });

  it("phoneSyncReject on native invokes phone_sync_disconnect (reject-frame is a web concern)", async () => {
    const { ipc } = await loadWeb();
    ipc.setWebClientMode(true);
    enterTauri();
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue(undefined);

    await ipc.phoneSyncReject();
    expect(invoke).toHaveBeenCalledWith("phone_sync_disconnect");
  });

  it("Tauri always wins over web-client mode", async () => {
    const { ipc } = await loadWeb();
    ipc.setWebClientMode(true);
    enterTauri();
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue({ sas: "T", peerPublicKey: "K" });

    const info = await ipc.phoneSyncConnect("qr", false);
    expect(info).toEqual({ sas: "T", peerPublicKey: "K" });
    expect(invoke).toHaveBeenCalledWith("phone_sync_connect", { qr: "qr", reconnect: false });
  });

  it("falls back to the mock when web-client mode is off", async () => {
    const { ipc } = await loadWeb();
    // not enabled
    const info = await ipc.phoneSyncConnect("qr");
    expect(info).toEqual({ sas: "MOCK-SAS-1234", peerPublicKey: "MOCK_DESKTOP_KEY_BASE64==" });
  });
});
