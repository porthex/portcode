import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { DEFAULT_SETTINGS, type Session, type Settings } from "../types";
import { useStore } from "../store/store";
import { Sidebar } from "./Sidebar";

// Sidebar renders the session list and triggers store actions that ultimately
// reach the IPC bridge (newSession -> createSession, selectSession ->
// getMessages, deleteSession -> deleteSession/createSession). We drive the REAL
// store and mock only the IPC layer so clicks update state without touching a
// backend. We assert observable behaviour: rendered titles, the active-session
// highlight branch, and the state/IPC effects of each button.
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
}));

import * as ipc from "../lib/ipc";

const m = vi.mocked(ipc);
const initialState = useStore.getState();

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  title: "Chat",
  workspace: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // zustand has no built-in reset; restore the pristine snapshot each test.
  useStore.setState(initialState, true);

  m.getMessages.mockResolvedValue([]);
  m.createSession.mockResolvedValue(undefined);
  m.deleteSession.mockResolvedValue(undefined);
});

describe("Sidebar", () => {
  it("renders the brand chrome", () => {
    render(<Sidebar />);

    expect(screen.getByText("Portcode")).toBeInTheDocument();
    expect(screen.getByText("Porthex")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New chat/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Settings/ })).toBeInTheDocument();
  });

  it("renders no session rows when there are zero sessions", () => {
    useStore.setState({ sessions: [], activeId: null });

    render(<Sidebar />);

    // Only the always-present "New chat" + "Settings" buttons exist; no rows.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByTitle("Delete chat")).not.toBeInTheDocument();
  });

  it("renders a single session's title", () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "Only chat" })],
      activeId: "a",
    });

    render(<Sidebar />);

    expect(screen.getByText("Only chat")).toBeInTheDocument();
    // one select button + one delete button for the row
    expect(screen.getAllByTitle("Delete chat")).toHaveLength(1);
  });

  it("lists several sessions in order", () => {
    useStore.setState({
      sessions: [
        session({ id: "a", title: "First" }),
        session({ id: "b", title: "Second" }),
        session({ id: "c", title: "Third" }),
      ],
      activeId: "b",
    });

    render(<Sidebar />);

    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(screen.getByText("Third")).toBeInTheDocument();
    expect(screen.getAllByTitle("Delete chat")).toHaveLength(3);
  });

  it("highlights only the active session row (both branches of the highlight)", () => {
    useStore.setState({
      sessions: [
        session({ id: "a", title: "Active one" }),
        session({ id: "b", title: "Inactive one" }),
      ],
      activeId: "a",
    });

    render(<Sidebar />);

    // The clickable title buttons live inside the highlighted row container.
    const activeRow = screen.getByText("Active one").closest("div");
    const inactiveRow = screen.getByText("Inactive one").closest("div");

    expect(activeRow).not.toBeNull();
    expect(inactiveRow).not.toBeNull();
    // active branch -> bg-accent-dim; inactive branch -> hover:bg-panel-2
    expect(activeRow?.className).toContain("bg-accent-dim");
    expect(inactiveRow?.className).not.toContain("bg-accent-dim");
    expect(inactiveRow?.className).toContain("hover:bg-panel-2");
  });

  it("creates a new session when New chat is clicked", async () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "Existing" })],
      activeId: "a",
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));

    // newSession is async; flush microtasks before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(m.createSession).toHaveBeenCalledTimes(1);
    const st = useStore.getState();
    expect(st.sessions).toHaveLength(2);
    // freshly created session is prepended and made active
    expect(st.sessions[0].id).toBe(st.activeId);
  });

  it("selects a session when its title is clicked", async () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "First" }), session({ id: "b", title: "Second" })],
      activeId: "a",
      messages: { a: [] },
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByText("Second"));

    await Promise.resolve();
    await Promise.resolve();

    expect(useStore.getState().activeId).toBe("b");
    expect(m.getMessages).toHaveBeenCalledWith("b");
  });

  it("deletes a session when its delete button is clicked", async () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "Keep" }), session({ id: "b", title: "Remove" })],
      activeId: "a",
      messages: { a: [], b: [] },
    });

    render(<Sidebar />);
    // Delete the second (inactive) row.
    const deleteButtons = screen.getAllByTitle("Delete chat");
    fireEvent.click(deleteButtons[1]);

    await Promise.resolve();
    await Promise.resolve();

    expect(m.deleteSession).toHaveBeenCalledWith("b");
    expect(useStore.getState().sessions.map((s) => s.id)).toEqual(["a"]);
  });

  it("opens settings when the Settings button is clicked", () => {
    useStore.setState({ showSettings: false });

    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));

    expect(useStore.getState().showSettings).toBe(true);
  });

  it("shows the API-key-set status dot when a key is configured", () => {
    useStore.setState({ settings: settings({ apiKeySet: true }) });

    render(<Sidebar />);

    const dot = screen.getByTitle("API key set");
    expect(dot).toBeInTheDocument();
    expect(dot.className).toContain("bg-success");
    expect(screen.queryByTitle("No API key")).not.toBeInTheDocument();
  });

  it("shows the missing-API-key status dot when no key is configured", () => {
    useStore.setState({ settings: settings({ apiKeySet: false }) });

    render(<Sidebar />);

    const dot = screen.getByTitle("No API key");
    expect(dot).toBeInTheDocument();
    expect(dot.className).toContain("bg-warn");
    expect(screen.queryByTitle("API key set")).not.toBeInTheDocument();
  });
});
