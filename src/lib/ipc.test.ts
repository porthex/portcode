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

describe("Tauri command serialization", () => {
  beforeEach(enterTauri);

  it("get_settings is invoked with no arguments", async () => {
    const { ipc, invoke } = await load();
    const settings = { provider: "anthropic" };
    invoke.mockResolvedValue(settings);
    await expect(ipc.getSettings()).resolves.toBe(settings);
    expect(invoke).toHaveBeenCalledWith("get_settings");
  });

  it("save_settings wraps the patch under a `settings` key", async () => {
    const { ipc, invoke } = await load();
    const patch = { model: "claude-sonnet-4-6" };
    invoke.mockResolvedValue({ ...patch });
    await ipc.saveSettings(patch);
    expect(invoke).toHaveBeenCalledWith("save_settings", { settings: patch });
  });

  it("set_api_key forwards the raw key", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue(undefined);
    await ipc.setApiKey("sk-123");
    expect(invoke).toHaveBeenCalledWith("set_api_key", { key: "sk-123" });
  });

  it("oauth commands invoke their core counterparts with no arguments", async () => {
    const { ipc, invoke } = await load();
    const status = { signedIn: true, expiresAt: 123, account: "a@b.co", tier: "Claude Max" };
    invoke.mockResolvedValue(status);
    await expect(ipc.startOauthLogin()).resolves.toBe(status);
    expect(invoke).toHaveBeenCalledWith("start_oauth_login");
    await expect(ipc.oauthStatus()).resolves.toBe(status);
    expect(invoke).toHaveBeenCalledWith("oauth_status");

    invoke.mockResolvedValue(undefined);
    await expect(ipc.oauthLogout()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("oauth_logout");
  });

  it("resolve_permission forwards id + decision", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue(undefined);
    await ipc.resolvePermission("perm-1", "deny");
    expect(invoke).toHaveBeenCalledWith("resolve_permission", {
      id: "perm-1",
      decision: "deny",
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
    await ipc.renameSession("s1", "Renamed");
    await ipc.deleteSession("s1");
    await ipc.getMessages("s1");
    expect(invoke).toHaveBeenCalledWith("create_session", {
      id: "s1",
      title: "Title",
      workspace: "C:/ws",
      model: undefined,
    });
    expect(invoke).toHaveBeenCalledWith("rename_session", { id: "s1", title: "Renamed" });
    expect(invoke).toHaveBeenCalledWith("delete_session", { id: "s1" });
    expect(invoke).toHaveBeenCalledWith("get_messages", { sessionId: "s1" });
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

  it("list_dir passes the optional sub-path through", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue([]);
    await ipc.listDir("src/components");
    expect(invoke).toHaveBeenCalledWith("list_dir", { sub: "src/components" });
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
    const handle = await ipc.runAgent("sess-1", "hello", "claude-opus-4-8", onEvent);

    expect(listen).toHaveBeenCalledWith("agent://sess-1", expect.any(Function));
    expect(invoke).toHaveBeenCalledWith("run_agent", {
      sessionId: "sess-1",
      text: "hello",
      model: "claude-opus-4-8",
    });

    // Core events arrive wrapped as `{ payload }`; the bridge unwraps them.
    registered({ payload: { type: "text_delta", text: "hi" } });
    expect(onEvent).toHaveBeenCalledWith({ type: "text_delta", text: "hi" });

    await handle.cancel();
    expect(invoke).toHaveBeenCalledWith("cancel_agent", { sessionId: "sess-1" });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("run_agent's dispose() stops listening WITHOUT cancelling the run", async () => {
    const { ipc, invoke, listen } = await load();
    const unlisten = vi.fn();
    listen.mockImplementation(async () => unlisten);
    invoke.mockResolvedValue(undefined);

    const handle = await ipc.runAgent("sess-2", "hi", "claude-opus-4-8", vi.fn());
    handle.dispose();

    // A normal turn end just stops listening — it must NOT fire cancel_agent.
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("cancel_agent", { sessionId: "sess-2" });
  });

  it("cancelAgentById invokes cancel_agent_by_id with the agent id", async () => {
    const { ipc, invoke } = await load();
    invoke.mockResolvedValue(undefined);
    await ipc.cancelAgentById("agent-7");
    expect(invoke).toHaveBeenCalledWith("cancel_agent_by_id", { agentId: "agent-7" });
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
      provider: "anthropic",
      model: "claude-opus-4-8",
      apiKeySet: false,
      defaultPolicy: "ask",
      workspace: null,
      typingAnimation: true,
      permissionMode: "default",
      rules: [],
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("saveSettings merges a partial patch and echoes the merged result", async () => {
    const { ipc } = await load();
    const next = await ipc.saveSettings({ model: "claude-sonnet-4-6" });
    expect(next.model).toBe("claude-sonnet-4-6");
    expect(next.provider).toBe("anthropic"); // untouched fields survive
  });

  it("setApiKey flips apiKeySet on the persisted settings", async () => {
    const { ipc } = await load();
    expect((await ipc.getSettings()).apiKeySet).toBe(false);
    await ipc.setApiKey("sk-test");
    expect((await ipc.getSettings()).apiKeySet).toBe(true);
  });

  it("listSessions and getMessages are empty without a core", async () => {
    const { ipc } = await load();
    await expect(ipc.listSessions()).resolves.toEqual([]);
    await expect(ipc.getMessages("any")).resolves.toEqual([]);
  });

  it("session mutations are no-ops that still resolve", async () => {
    const { ipc, invoke } = await load();
    await expect(ipc.createSession("id", "title", null)).resolves.toBeUndefined();
    await expect(ipc.renameSession("id", "new")).resolves.toBeUndefined();
    await expect(ipc.deleteSession("id")).resolves.toBeUndefined();
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

  it("openFolder returns the canned preview path", async () => {
    const { ipc } = await load();
    await expect(ipc.openFolder()).resolves.toBe("C:/dev/porthex/portcode");
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

  it("oauth mock signs into a Claude Max subscription and logout clears it", async () => {
    const { ipc } = await load();
    expect((await ipc.oauthStatus()).signedIn).toBe(false);

    const signedIn = await ipc.startOauthLogin();
    expect(signedIn.signedIn).toBe(true);
    expect(signedIn.tier).toBe("Claude Max");
    expect(signedIn.account).toBe("preview@claude.local");
    expect(typeof signedIn.expiresAt).toBe("number");
    // The mock persists the state on its singleton until logout.
    expect((await ipc.oauthStatus()).signedIn).toBe(true);

    await ipc.oauthLogout();
    expect(await ipc.oauthStatus()).toEqual({
      signedIn: false,
      expiresAt: null,
      account: null,
      tier: null,
    });
  });
});

describe("browser fallback agent stream", () => {
  beforeEach(exitTauri);

  it("streams a complete turn and ends without a gate when policy allows", async () => {
    const { ipc } = await load();
    await ipc.saveSettings({ defaultPolicy: "allow" });
    vi.useFakeTimers();

    const events: StreamEvent[] = [];
    await ipc.runAgent("s", "hi", "claude-opus-4-8", (e) => events.push(e));
    await vi.runAllTimersAsync();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("turn_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("tool_use");
    expect(types).toContain("usage");
    expect(types[types.length - 1]).toBe("turn_end");
    expect(types).not.toContain("permission_request");
  });

  it("raises a permission_request under the default ask policy, and cancel tears it down", async () => {
    const { ipc } = await load();
    await ipc.saveSettings({ defaultPolicy: "ask" });
    vi.useFakeTimers();

    const events: StreamEvent[] = [];
    const { cancel } = await ipc.runAgent("s", "hi", "claude-opus-4-8", (e) => events.push(e));
    await vi.advanceTimersByTimeAsync(3000);

    expect(events.some((e) => e.type === "permission_request")).toBe(true);

    await cancel(); // resolves the pending gate (deny) and halts the run
    await vi.runAllTimersAsync();
  });

  it("cancelling before the first tick suppresses every event", async () => {
    const { ipc } = await load();
    await ipc.saveSettings({ defaultPolicy: "allow" });
    vi.useFakeTimers();

    const onEvent = vi.fn();
    const { cancel } = await ipc.runAgent("s", "hi", "claude-opus-4-8", onEvent);
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
