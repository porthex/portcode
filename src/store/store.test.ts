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
  setTelemetryConsent: vi.fn(),
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
  onPhoneSyncPairingRequest: vi.fn(),
  confirmPairing: vi.fn(),
  rejectPairing: vi.fn(),
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
  m.setTelemetryConsent.mockResolvedValue(undefined);
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
  m.onPhoneSyncPairingRequest.mockResolvedValue(() => {});
  m.confirmPairing.mockResolvedValue(undefined);
  m.rejectPairing.mockResolvedValue(undefined);
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
    expect(st.sessions).toHaveLength(1);
    expect(m.createSession).toHaveBeenCalledTimes(1);
  });

  it("clears a prior initError on a later successful init", async () => {
    useStore.setState({ initError: "stale failure" });

    await useStore.getState().init();

    expect(useStore.getState().initError).toBeNull();
  });

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
  it("prepends a fresh session and makes it active", async () => {
    useStore.setState({ sessions: [session({ id: "old" })] });

    await useStore.getState().newSession();

    const st = useStore.getState();
    expect(m.createSession).toHaveBeenCalledTimes(1);
    expect(st.sessions).toHaveLength(2);
    expect(st.sessions[0].id).toBe(st.activeId);
    expect(st.messages[st.activeId!]).toEqual([]);
  });

  it("initializes the new session's model from the last-used settings.model", async () => {
    useStore.setState({
      sessions: [session({ id: "old" })],
      settings: { ...DEFAULT_SETTINGS, model: "claude-haiku-4-5-20251001" },
    });

    await useStore.getState().newSession();

    const st = useStore.getState();
    expect(st.sessions[0].model).toBe("claude-haiku-4-5-20251001");
    // The chosen model is persisted with the new session row.
    expect(m.createSession).toHaveBeenCalledWith(
      st.sessions[0].id,
      "New chat",
      null,
      "claude-haiku-4-5-20251001",
    );
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

  it("re-entry guard: a rapid double-call creates exactly one session", async () => {
    // createSession is async; the synchronous creatingSession lock must make the
    // second same-tick call bail so two fast clicks (or Ctrl+N + click) can't create
    // two orphan empty sessions.
    let release!: () => void;
    m.createSession.mockReturnValueOnce(
      new Promise<void>((res) => {
        release = res;
      }),
    );
    useStore.setState({ sessions: [session({ id: "old" })] });

    const first = useStore.getState().newSession();
    // Second call lands while the first create is still in flight.
    const second = useStore.getState().newSession();

    release();
    await Promise.all([first, second]);

    expect(m.createSession).toHaveBeenCalledTimes(1);
    expect(useStore.getState().sessions).toHaveLength(2); // old + one new, not two new
    expect(useStore.getState().creatingSession).toBe(false); // lock released
  });

  it("routes through the remote command (not the desktop-only local create) when connected", async () => {
    // On the phone the agent-side create_session is desktop-only; calling the local
    // Tauri invoke would reject. newSession must forward a `create_session` command
    // and let the desktop's session_list frame reconcile — not optimistically insert
    // a phantom local session.
    useStore.setState({ remoteConnected: true, sessions: [session({ id: "old" })] });

    await useStore.getState().newSession();

    expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({ cmd: "create_session" });
    expect(m.createSession).not.toHaveBeenCalled();
    const st = useStore.getState();
    expect(st.sessions).toHaveLength(1); // no optimistic local session inserted
    expect(st.creatingSession).toBe(false); // lock released
    expect(st.showSidebar).toBe(false); // drawer closed on navigation
  });

  it("surfaces a local create rejection instead of an unhandled rejection", async () => {
    // The local path now wraps createSession in try/catch so a reject (locked DB /
    // core not ready) lands in the visible error surface rather than escaping as an
    // unhandled promise rejection (callers use bare onClick / void).
    m.createSession.mockRejectedValueOnce(new Error("db locked"));
    useStore.setState({ sessions: [session({ id: "old" })] });

    await expect(useStore.getState().newSession()).resolves.toBeUndefined();

    const st = useStore.getState();
    expect(st.initError).toBe("db locked");
    expect(st.sessions).toHaveLength(1); // no phantom session on failure
    expect(st.creatingSession).toBe(false); // lock released
  });
});

describe("setSessionModel", () => {
  it("updates the active session's model and tracks it as the last-used default", async () => {
    useStore.setState({
      sessions: [session({ id: "a", model: "claude-opus-4-8" })],
      activeId: "a",
    });

    await useStore.getState().setSessionModel("claude-sonnet-4-6");

    const st = useStore.getState();
    expect(st.sessions[0].model).toBe("claude-sonnet-4-6");
    // Last-used sync: settings.model is updated through ipc.saveSettings.
    expect(m.saveSettings).toHaveBeenCalledWith({ model: "claude-sonnet-4-6" });
    expect(st.settings.model).toBe("claude-sonnet-4-6");
  });

  it("still updates the last-used default when no session is active (palette safety)", async () => {
    useStore.setState({ sessions: [], activeId: null });

    await useStore.getState().setSessionModel("claude-haiku-4-5-20251001");

    expect(m.saveSettings).toHaveBeenCalledWith({ model: "claude-haiku-4-5-20251001" });
    expect(useStore.getState().settings.model).toBe("claude-haiku-4-5-20251001");
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

  it("flags loadErrors when the surviving session's reload rejects", async () => {
    m.getMessages.mockRejectedValue(new Error("reload failed"));
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      messages: {},
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
    });

    await expect(useStore.getState().deleteSession("a")).resolves.toBeUndefined();

    const st = useStore.getState();
    expect(st.initError).toBe("locked");
    expect(st.sessions).toHaveLength(2); // the row stays — it wasn't deleted
    expect(st.activeId).toBe("a"); // unchanged
    expect(st.messages.a).toEqual([]); // not removed
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
    m.runAgent.mockImplementation(async (_id, _text, _model, onEvent) => {
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
    expect(m.runAgent).toHaveBeenCalledWith(
      "a",
      "Refactor the parser",
      "claude-opus-4-8",
      expect.any(Function),
    );

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

  it("trims surrounding whitespace from the stored user bubble and derived title", async () => {
    let emit!: (e: StreamEvent) => void;
    m.runAgent.mockImplementation(async (_id, _text, _model, onEvent) => {
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
    expect(m.runAgent).toHaveBeenCalledWith("a", "hi", "claude-opus-4-8", expect.any(Function));
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
    m.runAgent.mockImplementation(async (_id, _text, _model, onEvent) => {
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
    // local agent or pre-create an assistant message. We DO flip streaming
    // optimistically (closing the double-submit window) rather than waiting for the
    // desktop's turn_start frame.
    expect(m.phoneSyncSendCommand).toHaveBeenCalledWith({
      cmd: "run",
      session_id: "a",
      text: "do it remotely",
    });
    expect(m.runAgent).not.toHaveBeenCalled();

    const st = useStore.getState();
    expect(st.streaming).toBe(true);
    // Only the optimistic user echo from sendRemoteCommand — no assistant stub.
    expect(st.messages.a).toHaveLength(1);
    expect(st.messages.a[0].role).toBe("user");
    expect(st.messages.a[0].blocks).toEqual([{ kind: "text", text: "do it remotely" }]);
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
    expect(useStore.getState().messages.a).toHaveLength(1);
  });

  it("tears down the turn's listener on turn_end so a later turn can't edit this message", async () => {
    const handles: { cancel: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] = [];
    const emits: ((e: StreamEvent) => void)[] = [];
    m.runAgent.mockImplementation(async (_id, _text, _model, onEvent) => {
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
    m.runAgent.mockImplementation(async (_id, _text, _model, onEvent) => {
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
      m.runAgent.mockImplementation(async (_id, _text, _model, onEvent) => {
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

  it("Stop pressed during the runAgent await window aborts the backend and disposes the listener", async () => {
    // The cancel handle is only armed AFTER runAgent resolves. If the user presses
    // Stop in that window, stop() can't invoke a (null) cancel — so the post-await
    // block must honor the already-flipped streaming:false by cancelling the
    // still-pending backend turn and disposing the listener (no stale Stop re-armed,
    // no further deltas folded in).
    const cancel = vi.fn(async () => {});
    const dispose = vi.fn();
    let resolveRun!: (h: { cancel: typeof cancel; dispose: typeof dispose }) => void;
    m.runAgent.mockImplementation(
      async () =>
        new Promise((res) => {
          resolveRun = res;
        }),
    );
    useStore.setState({ sessions: [session({ id: "a" })], activeId: "a", messages: { a: [] } });

    // Kick off the turn; runAgent stays pending (cancel handle not yet armed).
    const sending = useStore.getState().send("hello");
    expect(useStore.getState().streaming).toBe(true);
    expect(useStore.getState().cancel).toBeNull(); // handle not armed during the await

    // User presses Stop mid-await — there's no cancel handle to invoke yet.
    await useStore.getState().stop();
    expect(useStore.getState().streaming).toBe(false);

    // Now the backend handle resolves. The post-await block must cancel it
    // (cancel_agent + unlisten), since Stop couldn't reach it earlier.
    resolveRun({ cancel, dispose });
    await sending;

    expect(cancel).toHaveBeenCalledTimes(1); // backend turn actually aborted
    expect(useStore.getState().cancel).toBeNull(); // no stale Stop re-armed
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

  it("clears the composer even when the cancel_agent IPC rejects (never bricks the UI)", async () => {
    // A rejecting cancel (core busy/locked/dead) must not strand the composer: stop()
    // wraps the cancel call so streaming/cancel/pendingPermission are always cleared
    // and the rejection never escapes as an unhandled promise rejection.
    const cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    useStore.setState({
      streaming: true,
      cancel,
      pendingPermission: { id: "p", tool: "t", summary: "s", input: {} },
    });

    await expect(useStore.getState().stop()).resolves.toBeUndefined();

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

    it("permission_request surfaces a pending prompt for the active session", () => {
      useStore.setState({ activeId: "s1" });

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

    describe("background-session frames don't hijack the visible UI", () => {
      // The user is looking at "active"; frames for a different (background)
      // session must still build that session's history, but must NOT flip the
      // visible composer/HUD or pop a permission prompt with no context.
      const bgLive = (event: StreamEvent) =>
        useStore.getState().applyFrame({ t: "live", session_id: "bg", event });

      it("turn_start for a background session appends its message but doesn't flip streaming", () => {
        useStore.setState({ activeId: "active", streaming: false });

        bgLive({ type: "turn_start", messageId: "b1" });

        const st = useStore.getState();
        expect(st.streaming).toBe(false); // visible composer untouched
        expect(st.messages.bg).toEqual([
          { id: "b1", role: "assistant", blocks: [], createdAt: expect.any(Number) },
        ]);
      });

      it("permission_request for a background session does NOT pop a prompt", () => {
        useStore.setState({ activeId: "active", pendingPermission: null });

        bgLive({ type: "permission_request", id: "p9", tool: "fs_edit", summary: "x", input: {} });

        expect(useStore.getState().pendingPermission).toBeNull();
      });

      it("text_delta still folds into the background session's message", () => {
        useStore.setState({ activeId: "active" });
        bgLive({ type: "turn_start", messageId: "b1" });

        bgLive({ type: "text_delta", text: "hi" });

        expect(useStore.getState().messages.bg[0].blocks).toEqual([{ kind: "text", text: "hi" }]);
      });

      it("turn_end / error for a background session leave the visible turn flags alone", () => {
        useStore.setState({
          activeId: "active",
          streaming: true,
          pendingPermission: { id: "p", tool: "t", summary: "s", input: {} },
        });
        bgLive({ type: "turn_start", messageId: "b1" });

        bgLive({ type: "error", message: "boom" });
        let st = useStore.getState();
        // The visible turn flags belong to the active session, not the background one.
        expect(st.streaming).toBe(true);
        expect(st.pendingPermission).not.toBeNull();
        // ...but the background message still got the inline error.
        const text = st.messages.bg[0].blocks
          .map((b) => (b.kind === "text" ? b.text : ""))
          .join("");
        expect(text).toContain("boom");

        bgLive({ type: "turn_end", stopReason: "end_turn" });
        st = useStore.getState();
        expect(st.streaming).toBe(true);
        expect(st.pendingPermission).not.toBeNull();
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
