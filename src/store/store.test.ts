import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SETTINGS,
  type Message,
  type MessageRow,
  type PairedDevice,
  type PairingPayload,
  type PhoneSyncStatus,
  type RemoteCommand,
  type Session,
  type StreamEvent,
  type SyncFrame,
} from "../types";
import * as ipc from "../lib/ipc";
import { useStore } from "./store";

// The store is the app's brain: it orchestrates the IPC bridge and folds the
// agent's streamed events into renderable message blocks. We mock the IPC layer
// (TDD London style) so these tests assert the store's behaviour and the exact
// calls it makes, never a real backend.
vi.mock("../lib/ipc", () => ({
  getSettings: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  getMessages: vi.fn(),
  deleteSession: vi.fn(),
  saveSettings: vi.fn(),
  resolvePermission: vi.fn(),
  openFolder: vi.fn(),
  runAgent: vi.fn(),
  oauthStatus: vi.fn(),
  startOauthLogin: vi.fn(),
  oauthLogout: vi.fn(),
  phoneSyncStatus: vi.fn(),
  phoneSyncBeginPairing: vi.fn(),
  phoneSyncUnpair: vi.fn(),
  phoneSyncConnect: vi.fn(),
  phoneSyncSendCommand: vi.fn(),
  phoneSyncDisconnect: vi.fn(),
  onPhoneSyncFrame: vi.fn(),
  onPhoneSyncDisconnected: vi.fn(),
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
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Restore a pristine store between tests (zustand has no built-in reset).
  useStore.setState(initialState, true);

  m.getSettings.mockResolvedValue(DEFAULT_SETTINGS);
  m.listSessions.mockResolvedValue([]);
  m.getMessages.mockResolvedValue([]);
  m.createSession.mockResolvedValue(undefined);
  m.deleteSession.mockResolvedValue(undefined);
  m.saveSettings.mockImplementation(async (s) => ({ ...DEFAULT_SETTINGS, ...s }));
  m.resolvePermission.mockResolvedValue(undefined);
  m.openFolder.mockResolvedValue(null);
  m.runAgent.mockResolvedValue({ cancel: vi.fn(async () => {}), dispose: vi.fn() });
  m.oauthStatus.mockResolvedValue(signedOut);
  m.startOauthLogin.mockResolvedValue(signedOut);
  m.oauthLogout.mockResolvedValue(undefined);
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
  m.onPhoneSyncFrame.mockResolvedValue(() => {});
  m.onPhoneSyncDisconnected.mockResolvedValue(() => {});
});

describe("init", () => {
  it("creates a first session when the backend has none", async () => {
    await useStore.getState().init();

    const st = useStore.getState();
    expect(m.createSession).toHaveBeenCalledTimes(1);
    expect(st.sessions).toHaveLength(1);
    expect(st.activeId).toBe(st.sessions[0].id);
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
});

describe("newSession", () => {
  it("prepends a fresh session and makes it active", async () => {
    useStore.setState({ sessions: [session({ id: "old" })] });

    await useStore.getState().newSession();

    const st = useStore.getState();
    expect(m.createSession).toHaveBeenCalledTimes(1);
    expect(st.sessions).toHaveLength(2);
    expect(st.sessions[0].id).toBe(st.activeId);
    expect(st.messages[st.activeId!]).toEqual([]);
  });

  it("closes the mobile session drawer", async () => {
    useStore.setState({ showSidebar: true });
    await useStore.getState().newSession();
    expect(useStore.getState().showSidebar).toBe(false);
  });

  it("does nothing while a turn is streaming", async () => {
    useStore.setState({
      streaming: true,
      sessions: [session({ id: "a" })],
      activeId: "a",
    });

    await useStore.getState().newSession();

    expect(m.createSession).not.toHaveBeenCalled();
    expect(useStore.getState().activeId).toBe("a");
    expect(useStore.getState().sessions).toHaveLength(1);
  });
});

describe("selectSession", () => {
  it("does nothing while a turn is streaming", async () => {
    useStore.setState({ streaming: true, activeId: "a" });

    await useStore.getState().selectSession("b");

    expect(useStore.getState().activeId).toBe("a");
    expect(m.getMessages).not.toHaveBeenCalled();
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

  it("closes the mobile session drawer on switch", async () => {
    useStore.setState({ showSidebar: true });
    await useStore.getState().selectSession("c");
    expect(useStore.getState().showSidebar).toBe(false);
  });
});

describe("deleteSession", () => {
  it("removes the session and re-points activeId at the survivor", async () => {
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      messages: { a: [], b: [] },
    });

    await useStore.getState().deleteSession("a");

    const st = useStore.getState();
    expect(m.deleteSession).toHaveBeenCalledWith("a");
    expect(st.sessions.map((s) => s.id)).toEqual(["b"]);
    expect(st.activeId).toBe("b");
    expect(st.messages.a).toBeUndefined();
  });

  it("spawns a fresh session when the last one is deleted", async () => {
    useStore.setState({ sessions: [session({ id: "a" })], activeId: "a", messages: { a: [] } });

    await useStore.getState().deleteSession("a");

    const st = useStore.getState();
    expect(st.sessions).toHaveLength(1);
    expect(st.sessions[0].id).not.toBe("a");
    expect(m.createSession).toHaveBeenCalledTimes(1);
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
    });

    await useStore.getState().deleteSession("a");

    expect(m.deleteSession).not.toHaveBeenCalled();
    expect(useStore.getState().sessions).toHaveLength(1);
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

    // a permission request surfaces as a pending prompt
    emit({ type: "permission_request", id: "p1", tool: "fs_edit", summary: "x", input: {} });
    expect(useStore.getState().pendingPermission?.id).toBe("p1");

    // turn_end clears streaming + any pending prompt
    emit({ type: "turn_end", stopReason: "end_turn" });
    st = useStore.getState();
    expect(st.streaming).toBe(false);
    expect(st.pendingPermission).toBeNull();
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
    // local agent or pre-create an assistant message / flip streaming.
    expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({
      cmd: "run",
      session_id: "a",
      text: "do it remotely",
    });
    expect(m.runAgent).not.toHaveBeenCalled();

    const st = useStore.getState();
    expect(st.streaming).toBe(false);
    // Only the optimistic user echo from sendRemoteCommand — no assistant stub.
    expect(st.messages.a).toHaveLength(1);
    expect(st.messages.a[0].role).toBe("user");
    expect(st.messages.a[0].blocks).toEqual([{ kind: "text", text: "do it remotely" }]);
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
});

describe("stop", () => {
  it("cancels the active run and clears streaming flags", async () => {
    const cancel = vi.fn(async () => {});
    useStore.setState({
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
  });

  it("stops a remote turn with a Cancel command, not the (absent) local cancel", async () => {
    const cancel = vi.fn(async () => {});
    useStore.setState({ remoteConnected: true, activeId: "s1", streaming: true, cancel });

    await useStore.getState().stop();

    expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({ cmd: "cancel", session_id: "s1" });
    expect(cancel).not.toHaveBeenCalled();
    expect(useStore.getState().streaming).toBe(false);
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

  it("persists allow-always as the new default policy", async () => {
    useStore.setState({
      pendingPermission: { id: "p1", tool: "fs_edit", summary: "x", input: {} },
    });

    await useStore.getState().resolvePermission("allow", true);

    expect(m.saveSettings).toHaveBeenCalledWith({ defaultPolicy: "allow" });
    expect(m.resolvePermission).toHaveBeenCalledWith("p1", "allow");
  });

  it("does not resolve a superseding request when a stale click lands mid-await", async () => {
    // allow-always awaits updateSettings; a newer permission request can arrive
    // during that await. A stale click must not clear or answer the new prompt.
    const newer = { id: "p2", tool: "fs_edit", summary: "newer", input: {} };
    m.saveSettings.mockImplementationOnce(async (s) => {
      useStore.setState({ pendingPermission: newer });
      return { ...DEFAULT_SETTINGS, ...s };
    });
    useStore.setState({
      pendingPermission: { id: "p1", tool: "fs_edit", summary: "stale", input: {} },
    });

    await useStore.getState().resolvePermission("allow", true);

    // The stale p1 click is dropped; the newer prompt stays pending and unanswered.
    expect(m.resolvePermission).not.toHaveBeenCalled();
    expect(useStore.getState().pendingPermission).toEqual(newer);
  });

  it("answers as a Permission command in remote mode (not the desktop-only local resolve)", async () => {
    useStore.setState({
      remoteConnected: true,
      pendingPermission: { id: "p1", tool: "fs_edit", summary: "x", input: {} },
    });

    await useStore.getState().resolvePermission("allow");

    expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({
      cmd: "permission",
      id: "p1",
      decision: "allow",
    });
    expect(m.resolvePermission).not.toHaveBeenCalled();
    expect(useStore.getState().pendingPermission).toBeNull();
  });
});

describe("draft + UI setters", () => {
  it("appendDraft inserts a single separating space only when needed", () => {
    const { setDraft, appendDraft } = useStore.getState();

    setDraft("");
    appendDraft("@a.ts"); // empty draft -> no leading space
    expect(useStore.getState().draft).toBe("@a.ts ");

    setDraft("foo"); // no trailing space -> separator added
    appendDraft("bar");
    expect(useStore.getState().draft).toBe("foo bar ");

    setDraft("foo "); // already trailing space -> no double space
    appendDraft("bar");
    expect(useStore.getState().draft).toBe("foo bar ");
  });

  it("toggleFiles flips and the show* setters take explicit values", () => {
    const before = useStore.getState().showFiles;
    useStore.getState().toggleFiles();
    expect(useStore.getState().showFiles).toBe(!before);

    useStore.getState().setShowSettings(true);
    useStore.getState().setShowPalette(true);
    expect(useStore.getState().showSettings).toBe(true);
    expect(useStore.getState().showPalette).toBe(true);
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

  it("setCrashReporting persists the consent choice as a tri-state pref", () => {
    useStore.getState().setCrashReporting(true);
    expect(useStore.getState().crashReporting).toBe(true);
    expect(localStorage.getItem("pc.crashReporting")).toBe("1");

    useStore.getState().setCrashReporting(false);
    expect(useStore.getState().crashReporting).toBe(false);
    expect(localStorage.getItem("pc.crashReporting")).toBe("0");
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
});

describe("phone sync", () => {
  const paired = (): PairedDevice => ({
    publicKey: "PHONE==",
    name: "My Phone",
    pairedAt: 1000,
    lastSeen: 2000,
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
  // to fold into (the dual of send pre-creating the assistant message).
  const seedTurn = (sid = "s1", id = "a1") => {
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
  });

  describe("live stream reducer", () => {
    it("turn_start pushes an empty assistant message and starts streaming", () => {
      seedTurn("s1", "a1");

      const st = useStore.getState();
      expect(st.streaming).toBe(true);
      expect(st.messages.s1).toEqual([
        { id: "a1", role: "assistant", blocks: [], createdAt: expect.any(Number) },
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

    it("permission_request surfaces a pending prompt", () => {
      useStore.getState().applyFrame({
        t: "live",
        session_id: "s1",
        event: { type: "permission_request", id: "p1", tool: "fs_edit", summary: "x", input: {} },
      });

      expect(useStore.getState().pendingPermission).toEqual({
        id: "p1",
        tool: "fs_edit",
        summary: "x",
        input: {},
      });
    });

    it("usage accumulates per session across frames", () => {
      const live = (event: StreamEvent) =>
        useStore.getState().applyFrame({ t: "live", session_id: "s1", event });

      live({ type: "usage", inputTokens: 100, outputTokens: 40 });
      live({ type: "usage", inputTokens: 10, outputTokens: 5 });

      expect(useStore.getState().usage.s1).toEqual({ input: 110, output: 45 });
    });

    it("turn_end clears streaming and any pending prompt", () => {
      useStore.setState({
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
      expect(m.phoneSyncConnect).toHaveBeenCalledWith("QR-PAYLOAD");
      expect(st.remoteConnected).toBe(true);
      expect(st.remoteSas).toBe("SAS-1");
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

      expect(m.phoneSyncConnect).toHaveBeenCalledWith("QR-1");
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
});
