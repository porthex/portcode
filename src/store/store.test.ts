import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, type Message, type Session, type StreamEvent } from "../types";
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
}));

const m = vi.mocked(ipc);
const initialState = useStore.getState();

// A signed-out OAuth status: init() resolves this so the store never throws on
// the OAuth bridge while these tests exercise unrelated behaviour.
const signedOut = { signedIn: false, expiresAt: null, account: null, tier: null };

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
  m.runAgent.mockResolvedValue({ cancel: vi.fn(async () => {}) });
  m.oauthStatus.mockResolvedValue(signedOut);
  m.startOauthLogin.mockResolvedValue(signedOut);
  m.oauthLogout.mockResolvedValue(undefined);
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
      return { cancel: vi.fn(async () => {}) };
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
    const existing: Message = { id: "m0", role: "user", blocks: [], createdAt: 1 };
    useStore.setState({
      sessions: [session({ id: "a", title: "Keep me" })],
      activeId: "a",
      messages: { a: [existing] },
    });

    await useStore.getState().send("another message");

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
