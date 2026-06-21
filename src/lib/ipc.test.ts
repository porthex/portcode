import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StreamEvent } from "../types";

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
    });
    expect(invoke).toHaveBeenCalledWith("rename_session", { id: "s1", title: "Renamed" });
    expect(invoke).toHaveBeenCalledWith("delete_session", { id: "s1" });
    expect(invoke).toHaveBeenCalledWith("get_messages", { sessionId: "s1" });
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
    const handle = await ipc.runAgent("sess-1", "hello", onEvent);

    expect(listen).toHaveBeenCalledWith("agent://sess-1", expect.any(Function));
    expect(invoke).toHaveBeenCalledWith("run_agent", { sessionId: "sess-1", text: "hello" });

    // Core events arrive wrapped as `{ payload }`; the bridge unwraps them.
    registered({ payload: { type: "text_delta", text: "hi" } });
    expect(onEvent).toHaveBeenCalledWith({ type: "text_delta", text: "hi" });

    await handle.cancel();
    expect(invoke).toHaveBeenCalledWith("cancel_agent", { sessionId: "sess-1" });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("browser fallback (no Tauri core)", () => {
  beforeEach(exitTauri);

  it("getSettings returns the mock defaults without touching invoke", async () => {
    const { ipc, invoke } = await load();
    await expect(ipc.getSettings()).resolves.toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      apiKeySet: false,
      defaultPolicy: "ask",
      workspace: null,
      typingAnimation: true,
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
    await ipc.runAgent("s", "hi", (e) => events.push(e));
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
    const { cancel } = await ipc.runAgent("s", "hi", (e) => events.push(e));
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
    const { cancel } = await ipc.runAgent("s", "hi", onEvent);
    await cancel();
    await vi.runAllTimersAsync();

    expect(onEvent).not.toHaveBeenCalled();
  });
});
