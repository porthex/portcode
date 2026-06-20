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
  // `isTauri` is consumed by the footer chrome to honestly report whether the
  // native Rust core is attached (CORE) or the browser preview mock (PREVIEW).
  isTauri: vi.fn(() => false),
  getSettings: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  getMessages: vi.fn(),
  deleteSession: vi.fn(),
  saveSettings: vi.fn(),
  resolvePermission: vi.fn(),
  openFolder: vi.fn(),
  runAgent: vi.fn(),
  // Subscription sign-in surface, reached transitively via the store.
  startOauthLogin: vi.fn(),
  oauthLogout: vi.fn(),
  oauthStatus: vi.fn(),
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

    // The Neon-Noir redesign renders the wordmark uppercase and the eyebrow as
    // "PORTHEX · v0.3.1-α" in a single text node; match accordingly.
    expect(screen.getByText("PORTCODE")).toBeInTheDocument();
    expect(screen.getByText(/PORTHEX/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /NEW SESSION/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Settings/ })).toBeInTheDocument();
  });

  it("renders no session rows when there are zero sessions", () => {
    useStore.setState({ sessions: [], activeId: null });

    render(<Sidebar />);

    // Only the always-present "NEW SESSION" + "Settings" buttons exist; no rows.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByTitle("Delete session")).not.toBeInTheDocument();
  });

  it("renders a single session's title", () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "Only chat" })],
      activeId: "a",
    });

    render(<Sidebar />);

    expect(screen.getByText("Only chat")).toBeInTheDocument();
    // one select button + one delete button for the row
    expect(screen.getAllByTitle("Delete session")).toHaveLength(1);
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
    expect(screen.getAllByTitle("Delete session")).toHaveLength(3);
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

    // The clickable title button sits two divs up from the title span: the row
    // container (with the highlight branch classes) wraps a flex row that wraps
    // the button. Walk from the title button to that outer row container.
    // The title button's accessible name leads with the title (then the
    // metadata line), so anchor at the start to match the title button without
    // also matching the row's "Delete session: <title>" button.
    const rowOf = (title: RegExp): HTMLElement | null => {
      const titleButton = screen.getByRole("button", { name: title });
      return titleButton.closest("div")?.parentElement ?? null;
    };
    const activeRow = rowOf(/^Active one/);
    const inactiveRow = rowOf(/^Inactive one/);

    expect(activeRow).not.toBeNull();
    expect(inactiveRow).not.toBeNull();
    // active branch -> bg-accent/10 highlight; inactive branch -> .pc-row
    expect(activeRow?.className).toContain("bg-accent/10");
    expect(activeRow?.className).not.toContain("pc-row");
    expect(inactiveRow?.className).not.toContain("bg-accent/10");
    expect(inactiveRow?.className).toContain("pc-row");
  });

  it("creates a new session when NEW SESSION is clicked", async () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "Existing" })],
      activeId: "a",
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /NEW SESSION/ }));

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
    const deleteButtons = screen.getAllByTitle("Delete session");
    fireEvent.click(deleteButtons[1]);

    await Promise.resolve();
    await Promise.resolve();

    expect(m.deleteSession).toHaveBeenCalledWith("b");
    expect(useStore.getState().sessions.map((s) => s.id)).toEqual(["a"]);
  });

  it("gives each delete button a screen-reader label naming its session", () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "Keep" }), session({ id: "b", title: "Remove" })],
      activeId: "a",
    });

    render(<Sidebar />);

    // Each delete control exposes an accessible name that names its target
    // session, so screen-reader users know which session a click would remove.
    expect(screen.getByRole("button", { name: "Delete session: Keep" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete session: Remove" })).toBeInTheDocument();
  });

  it("opens settings when the Settings button is clicked", () => {
    useStore.setState({ showSettings: false });

    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));

    expect(useStore.getState().showSettings).toBe(true);
  });

  it("shows the KEY SET indicator when a key is configured", () => {
    useStore.setState({ settings: settings({ apiKeySet: true }) });

    const { container } = render(<Sidebar />);

    // The redesign surfaces a configured key as a "KEY SET" label plus a
    // pulsing ring dot (.pc-dot--ring), both gated on settings.apiKeySet.
    expect(screen.getByText("KEY SET")).toBeInTheDocument();
    expect(container.querySelector(".pc-dot--ring")).not.toBeNull();
  });

  it("hides the KEY SET indicator when no key is configured", () => {
    useStore.setState({ settings: settings({ apiKeySet: false }) });

    const { container } = render(<Sidebar />);

    // With no key, neither the label nor the ring dot render.
    expect(screen.queryByText("KEY SET")).not.toBeInTheDocument();
    expect(container.querySelector(".pc-dot--ring")).toBeNull();
  });

  it("shows the CLAUDE indicator when signed in via subscription (no API key)", () => {
    useStore.setState({
      settings: settings({ apiKeySet: false }),
      oauthStatus: {
        signedIn: true,
        expiresAt: null,
        account: "you@claude.ai",
        tier: "Claude Max",
      },
    });

    const { container } = render(<Sidebar />);

    // Signed in with Claude still surfaces the auth indicator, labelled CLAUDE
    // (subscription) rather than KEY SET, with the same pulsing ring dot.
    expect(screen.getByText("CLAUDE")).toBeInTheDocument();
    expect(screen.queryByText("KEY SET")).not.toBeInTheDocument();
    expect(container.querySelector(".pc-dot--ring")).not.toBeNull();
  });

  // The footer used to render hardcoded fake telemetry ("◴ 32 MB RAM", "◉ 6 MB")
  // that masqueraded as live system stats. Those numbers were static placeholders
  // and there is no backend command to source them. The chrome now shows only
  // honest, real-state labels — mirroring the StatusHud honesty fix.
  describe("footer chrome (honest, no fabricated telemetry)", () => {
    it("never renders the old hardcoded RAM/MB telemetry but keeps the stack label", () => {
      m.isTauri.mockReturnValue(false);
      useStore.setState({ sessions: [session()], activeId: "s1" });

      render(<Sidebar />);

      expect(screen.queryByText(/MB RAM/)).not.toBeInTheDocument();
      expect(screen.queryByText(/32 MB/)).not.toBeInTheDocument();
      expect(screen.queryByText(/\d+ MB/)).not.toBeInTheDocument();
      // The honest backend stack-identity label is retained.
      expect(screen.getByText("RUST · TOKIO")).toBeInTheDocument();
    });

    it("surfaces the live session count with correct pluralization", () => {
      m.isTauri.mockReturnValue(false);

      useStore.setState({ sessions: [], activeId: null });
      const zero = render(<Sidebar />);
      expect(zero.getByText(/^◴ 0 SESSIONS$/)).toBeInTheDocument();
      zero.unmount();

      useStore.setState({ sessions: [session({ id: "a" })], activeId: "a" });
      const one = render(<Sidebar />);
      expect(one.getByText(/^◴ 1 SESSION$/)).toBeInTheDocument();
      one.unmount();

      useStore.setState({
        sessions: [session({ id: "a" }), session({ id: "b" }), session({ id: "c" })],
        activeId: "a",
      });
      const many = render(<Sidebar />);
      expect(many.getByText(/^◴ 3 SESSIONS$/)).toBeInTheDocument();
    });

    it("honestly reports whether the native core is attached", () => {
      useStore.setState({ sessions: [session()], activeId: "s1" });

      m.isTauri.mockReturnValue(false);
      const preview = render(<Sidebar />);
      expect(preview.getByText("◉ PREVIEW")).toBeInTheDocument();
      expect(preview.queryByText("◉ CORE")).not.toBeInTheDocument();
      preview.unmount();

      m.isTauri.mockReturnValue(true);
      const core = render(<Sidebar />);
      expect(core.getByText("◉ CORE")).toBeInTheDocument();
      expect(core.queryByText("◉ PREVIEW")).not.toBeInTheDocument();
    });
  });
});
