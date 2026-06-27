import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

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
  renameSession: vi.fn(),
  subscribeSessionEvents: vi.fn(),
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
  m.renameSession.mockResolvedValue(undefined);
  m.subscribeSessionEvents.mockResolvedValue(() => {});
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

    // The toolbar chrome (collapse, new folder, sort, group, new session,
    // settings) is always present, but with no sessions there are no rows — so
    // none of the per-row controls exist.
    expect(screen.queryByTitle("Delete session")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Archive")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete session:/ })).not.toBeInTheDocument();
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

      // The decorative ◴ glyph is now an aria-hidden span, so the count text node
      // reads e.g. " 0 SESSIONS"; match on the count text rather than the glyph.
      useStore.setState({ sessions: [], activeId: null });
      const zero = render(<Sidebar />);
      expect(zero.getByText(/0 SESSIONS/)).toBeInTheDocument();
      zero.unmount();

      useStore.setState({ sessions: [session({ id: "a" })], activeId: "a" });
      const one = render(<Sidebar />);
      expect(one.getByText(/1 SESSION/)).toBeInTheDocument();
      one.unmount();

      useStore.setState({
        sessions: [session({ id: "a" }), session({ id: "b" }), session({ id: "c" })],
        activeId: "a",
      });
      const many = render(<Sidebar />);
      expect(many.getByText(/3 SESSIONS/)).toBeInTheDocument();
    });

    it("honestly reports whether the native core is attached", () => {
      useStore.setState({ sessions: [session()], activeId: "s1" });

      // The decorative ◉ glyph is aria-hidden in its own span, so the visible text
      // node is just "PREVIEW"/"CORE"; match on that.
      m.isTauri.mockReturnValue(false);
      const preview = render(<Sidebar />);
      expect(preview.getByText("PREVIEW")).toBeInTheDocument();
      expect(preview.queryByText("CORE")).not.toBeInTheDocument();
      preview.unmount();

      m.isTauri.mockReturnValue(true);
      const core = render(<Sidebar />);
      expect(core.getByText("CORE")).toBeInTheDocument();
      expect(core.queryByText("PREVIEW")).not.toBeInTheDocument();
    });
  });

  describe("landmarks & keyboard navigation", () => {
    it("labels the complementary and navigation landmarks", () => {
      useStore.setState({ sessions: [session()], activeId: "s1" });

      render(<Sidebar />);

      // Screen-reader users can jump to the sidebar and its session list by name.
      expect(screen.getByRole("complementary", { name: "Sessions" })).toBeInTheDocument();
      expect(screen.getByRole("navigation", { name: "Session list" })).toBeInTheDocument();
    });

    it("marks the active session row with aria-current for screen readers", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "First" }), session({ id: "b", title: "Second" })],
        activeId: "b",
      });

      render(<Sidebar />);

      // The active row's select button announces itself as current; inactive
      // rows carry no aria-current, so AT can tell which session is open.
      const active = screen.getByRole("button", { name: /^Second/ });
      const inactive = screen.getByRole("button", { name: /^First/ });
      expect(active).toHaveAttribute("aria-current", "true");
      expect(inactive).not.toHaveAttribute("aria-current");
    });

    it("makes only the active row a tab stop (roving tabindex)", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "First" }), session({ id: "b", title: "Second" })],
        activeId: "b",
      });

      render(<Sidebar />);

      const inactive = screen.getByRole("button", { name: /^First/ });
      const active = screen.getByRole("button", { name: /^Second/ });
      expect(active).toHaveAttribute("tabindex", "0");
      expect(inactive).toHaveAttribute("tabindex", "-1");

      // The per-row delete control follows the same roving scheme, so only the
      // active row exposes its controls in the Tab order (one tab stop in).
      const inactiveDelete = screen.getByRole("button", { name: "Delete session: First" });
      const activeDelete = screen.getByRole("button", { name: "Delete session: Second" });
      expect(activeDelete).toHaveAttribute("tabindex", "0");
      expect(inactiveDelete).toHaveAttribute("tabindex", "-1");
    });

    it("ArrowDown/ArrowUp move selection and follow focus", () => {
      useStore.setState({
        sessions: [
          session({ id: "a", title: "First" }),
          session({ id: "b", title: "Second" }),
          session({ id: "c", title: "Third" }),
        ],
        activeId: "a",
      });

      render(<Sidebar />);
      const nav = screen.getByRole("navigation", { name: "Session list" });

      // Focus the active row first so the keyDown mirrors the real focus-gated
      // bubbling path, then assert focus follows the selection to the new row.
      screen.getByRole("button", { name: /^First/ }).focus();

      fireEvent.keyDown(nav, { key: "ArrowDown" });
      expect(useStore.getState().activeId).toBe("b");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Second/ }));

      fireEvent.keyDown(nav, { key: "ArrowUp" });
      expect(useStore.getState().activeId).toBe("a");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /^First/ }));
    });

    it("Home/End jump to the first and last sessions", () => {
      useStore.setState({
        sessions: [
          session({ id: "a", title: "First" }),
          session({ id: "b", title: "Second" }),
          session({ id: "c", title: "Third" }),
        ],
        activeId: "b",
      });

      render(<Sidebar />);
      const nav = screen.getByRole("navigation", { name: "Session list" });

      // Focus the active row first so the keyDown mirrors the real focus-gated
      // bubbling path, then assert focus jumps with the selection.
      screen.getByRole("button", { name: /^Second/ }).focus();

      fireEvent.keyDown(nav, { key: "End" });
      expect(useStore.getState().activeId).toBe("c");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Third/ }));

      fireEvent.keyDown(nav, { key: "Home" });
      expect(useStore.getState().activeId).toBe("a");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /^First/ }));
    });

    it("clamps ArrowUp at the first row and ArrowDown at the last", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "First" }), session({ id: "b", title: "Second" })],
        activeId: "a",
      });

      render(<Sidebar />);
      const nav = screen.getByRole("navigation", { name: "Session list" });

      // Already at the top — ArrowUp keeps the first session active.
      fireEvent.keyDown(nav, { key: "ArrowUp" });
      expect(useStore.getState().activeId).toBe("a");

      // Walk to the bottom, then ArrowDown again stays on the last session.
      fireEvent.keyDown(nav, { key: "ArrowDown" });
      fireEvent.keyDown(nav, { key: "ArrowDown" });
      expect(useStore.getState().activeId).toBe("b");
    });

    it("ignores unrelated keys without changing selection", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "First" }), session({ id: "b", title: "Second" })],
        activeId: "a",
      });

      render(<Sidebar />);
      const nav = screen.getByRole("navigation", { name: "Session list" });

      fireEvent.keyDown(nav, { key: "a" });
      expect(useStore.getState().activeId).toBe("a");
    });

    it("does not navigate the list while a turn is streaming", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "First" }), session({ id: "b", title: "Second" })],
        activeId: "a",
        streaming: true,
      });

      render(<Sidebar />);
      const nav = screen.getByRole("navigation", { name: "Session list" });

      fireEvent.keyDown(nav, { key: "ArrowDown" });
      // selectSession no-ops while streaming, so the active session is unchanged.
      expect(useStore.getState().activeId).toBe("a");
    });

    it("no-ops arrow navigation when there are no sessions", () => {
      useStore.setState({ sessions: [], activeId: null });

      render(<Sidebar />);
      const nav = screen.getByRole("navigation", { name: "Session list" });

      // The empty list has no rows to move between; the handler must not throw.
      expect(() => fireEvent.keyDown(nav, { key: "ArrowDown" })).not.toThrow();
      expect(useStore.getState().activeId).toBeNull();
    });
  });

  describe("sort + group toolbar", () => {
    const threeSessions = () => ({
      sessions: [
        session({ id: "a", title: "Apple", updatedAt: 100 }),
        session({ id: "b", title: "Cherry", updatedAt: 300 }),
        session({ id: "c", title: "Banana", updatedAt: 200 }),
      ],
      activeId: "a" as string | null,
    });

    it("opens the sort menu, checks the active option, and reorders on pick", () => {
      useStore.setState(threeSessions());
      render(<Sidebar />);

      fireEvent.click(screen.getByRole("button", { name: /Sort sessions/ }));

      // Listbox-style menu: the active option (Recent) is checked via aria-checked.
      const recent = screen.getByRole("menuitemradio", { name: "Recent" });
      expect(recent).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("menuitemradio", { name: "Name" })).toHaveAttribute(
        "aria-checked",
        "false",
      );

      fireEvent.click(screen.getByRole("menuitemradio", { name: "Name" }));

      // Picking sets the sort and closes the menu.
      expect(useStore.getState().sortBy).toBe("name");
      expect(screen.queryByRole("menuitemradio", { name: "Recent" })).not.toBeInTheDocument();
    });

    it("shows the active cue on the sort button for a non-default sort", () => {
      useStore.setState({ ...threeSessions(), sortBy: "name" });
      render(<Sidebar />);

      expect(screen.getByRole("button", { name: /Sort sessions/ }).className).toContain(
        "pc-sess-ctrl--active",
      );
    });

    it("keeps only one popover open at a time (opening Group closes Sort)", () => {
      useStore.setState(threeSessions());
      render(<Sidebar />);

      fireEvent.click(screen.getByRole("button", { name: /Sort sessions/ }));
      expect(screen.getByRole("menu", { name: "Sort sessions" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /Group sessions/ }));
      expect(screen.queryByRole("menu", { name: "Sort sessions" })).not.toBeInTheDocument();
      expect(screen.getByRole("menu", { name: "Group sessions" })).toBeInTheDocument();
    });

    it("closes the open menu on an outside (click-catcher) click", () => {
      useStore.setState(threeSessions());
      render(<Sidebar />);

      fireEvent.click(screen.getByRole("button", { name: /Sort sessions/ }));
      fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
      expect(screen.queryByRole("menu", { name: "Sort sessions" })).not.toBeInTheDocument();
    });

    it("toggles the sort menu closed when its button is clicked again", () => {
      useStore.setState(threeSessions());
      render(<Sidebar />);

      const sortBtn = screen.getByRole("button", { name: /Sort sessions/ });
      fireEvent.click(sortBtn);
      expect(screen.getByRole("menu", { name: "Sort sessions" })).toBeInTheDocument();
      fireEvent.click(sortBtn);
      expect(screen.queryByRole("menu", { name: "Sort sessions" })).not.toBeInTheDocument();
    });

    it("group → status renders Active / Idle / Archived section headers in order", () => {
      useStore.setState({
        sessions: [
          session({ id: "a", title: "Running one" }),
          session({ id: "b", title: "Idle one" }),
          session({ id: "c", title: "Archived one" }),
        ],
        activeId: "a",
        streaming: true, // active + streaming ⇒ "running"
        groupBy: "status",
        archivedIds: ["c"],
      });
      render(<Sidebar />);

      expect(screen.getByText("Active")).toBeInTheDocument();
      expect(screen.getByText("Idle")).toBeInTheDocument();
      expect(screen.getByText("Archived")).toBeInTheDocument();
      // No folder UI in an automatic-grouping mode.
      expect(screen.queryByRole("button", { name: "New folder" })).not.toBeInTheDocument();
    });

    it("group → workspace buckets by the ⎇ label", () => {
      useStore.setState({
        sessions: [
          session({ id: "a", title: "One", workspace: "C:/dev/alpha" }),
          session({ id: "b", title: "Two", workspace: "C:/dev/beta" }),
        ],
        activeId: "a",
        groupBy: "workspace",
      });
      render(<Sidebar />);

      // Group headers carry the workspace basenames.
      expect(screen.getByText("alpha")).toBeInTheDocument();
      expect(screen.getByText("beta")).toBeInTheDocument();
    });

    it("switches grouping mode by picking a group option", () => {
      useStore.setState(threeSessions());
      render(<Sidebar />);

      fireEvent.click(screen.getByRole("button", { name: /Group sessions/ }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Workspace" }));

      expect(useStore.getState().groupBy).toBe("workspace");
    });
  });

  describe("folders", () => {
    it("shows the New folder button only in none mode and creates an expanded empty folder", () => {
      useStore.setState({ sessions: [session({ id: "a" })], activeId: "a", groupBy: "none" });
      render(<Sidebar />);

      fireEvent.click(screen.getByRole("button", { name: "New folder" }));

      expect(useStore.getState().folders).toHaveLength(1);
      // A fresh, expanded folder shows the empty placeholder.
      expect(screen.getByText("empty · move chats here")).toBeInTheDocument();
    });

    it("renders a folder with nested children behind a guide line", () => {
      useStore.setState({
        sessions: [
          session({ id: "loose", title: "Loose chat" }),
          session({ id: "kid", title: "Nested chat" }),
        ],
        activeId: "loose",
        folders: [{ id: "f1", name: "Work", open: true }],
        folderOf: { kid: "f1" },
      });
      render(<Sidebar />);

      const nested = screen.getByRole("button", { name: /^Nested chat/ });
      // The nested row sits inside the indentation/guide wrapper.
      expect(nested.closest(".pc-folder-children")).not.toBeNull();
      // The loose row does not.
      const loose = screen.getByRole("button", { name: /^Loose chat/ });
      expect(loose.closest(".pc-folder-children")).toBeNull();
    });

    it("collapses and expands a folder, hiding/showing its children", () => {
      useStore.setState({
        sessions: [session({ id: "kid", title: "Nested chat" })],
        activeId: null,
        folders: [{ id: "f1", name: "Work", open: true }],
        folderOf: { kid: "f1" },
      });
      render(<Sidebar />);

      expect(screen.getByText("Nested chat")).toBeInTheDocument();

      // Clicking the folder name toggles it shut.
      fireEvent.click(screen.getByText("Work"));
      expect(useStore.getState().folders[0].open).toBe(false);
      expect(screen.queryByText("Nested chat")).not.toBeInTheDocument();
    });

    it("toggles a folder from its chevron/glyph button too", () => {
      useStore.setState({
        sessions: [session({ id: "kid", title: "Nested chat" })],
        activeId: null,
        folders: [{ id: "f1", name: "Work", open: true }],
        folderOf: { kid: "f1" },
      });
      render(<Sidebar />);

      // The chevron+glyph control carries the folder's accessible name + count.
      fireEvent.click(screen.getByRole("button", { name: /Work folder/ }));
      expect(useStore.getState().folders[0].open).toBe(false);
    });

    it("renames a folder inline (double-click → edit → blur commits)", () => {
      useStore.setState({ folders: [{ id: "f1", name: "Work", open: true }] });
      render(<Sidebar />);

      fireEvent.doubleClick(screen.getByText("Work"));
      const input = screen.getByRole("textbox", { name: "Folder name" });
      fireEvent.change(input, { target: { value: "Research" } });
      fireEvent.blur(input);

      expect(useStore.getState().folders[0].name).toBe("Research");
      expect(screen.queryByRole("textbox", { name: "Folder name" })).not.toBeInTheDocument();
    });

    it("commits a rename on Enter and cancels on Escape", () => {
      useStore.setState({ folders: [{ id: "f1", name: "Work", open: true }] });
      render(<Sidebar />);

      // Enter commits.
      fireEvent.doubleClick(screen.getByText("Work"));
      const input = screen.getByRole("textbox", { name: "Folder name" });
      fireEvent.change(input, { target: { value: "Docs" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(useStore.getState().folders[0].name).toBe("Docs");

      // Escape cancels — the typed value is discarded.
      fireEvent.doubleClick(screen.getByText("Docs"));
      const input2 = screen.getByRole("textbox", { name: "Folder name" });
      fireEvent.change(input2, { target: { value: "Throwaway" } });
      fireEvent.keyDown(input2, { key: "Escape" });
      expect(useStore.getState().folders[0].name).toBe("Docs");
    });

    it("deletes a folder and orphans its chats back to the root", () => {
      useStore.setState({
        sessions: [session({ id: "kid", title: "Nested chat" })],
        activeId: null,
        folders: [{ id: "f1", name: "Work", open: true }],
        folderOf: { kid: "f1" },
      });
      render(<Sidebar />);

      fireEvent.click(screen.getByRole("button", { name: "Delete folder: Work" }));

      expect(useStore.getState().folders).toHaveLength(0);
      // The chat survives at the loose root (no longer nested).
      const orphan = screen.getByRole("button", { name: /^Nested chat/ });
      expect(orphan.closest(".pc-folder-children")).toBeNull();
    });
  });

  describe("archived rows + status indicators", () => {
    it("archives a session from its row action, dimming the row and flipping the control", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Keep" }), session({ id: "b", title: "Old chat" })],
        activeId: "a",
      });
      render(<Sidebar />);

      fireEvent.click(screen.getByRole("button", { name: "Archive session: Old chat" }));

      expect(useStore.getState().archivedIds).toEqual(["b"]);
      // The control now offers the inverse action…
      expect(
        screen.getByRole("button", { name: "Unarchive session: Old chat" }),
      ).toBeInTheDocument();
      // …and the row is dimmed.
      const row = screen.getByRole("button", { name: /^Old chat/ }).closest(".pc-row--archived");
      expect(row).not.toBeNull();
    });

    it("shows a green running dot for the streaming session and a faint dot for idle rows", () => {
      useStore.setState({
        sessions: [
          session({ id: "a", title: "Running" }),
          session({ id: "b", title: "Idle" }),
          session({ id: "c", title: "Archived" }),
        ],
        activeId: "a",
        streaming: true,
        archivedIds: ["c"],
      });
      const { container } = render(<Sidebar />);

      // running ⇒ success dot; idle inactive ⇒ faint pip; archived ⇒ box glyph.
      expect(container.querySelector(".pc-dot--success")).not.toBeNull();
      expect(container.querySelector(".pc-dot--idle")).not.toBeNull();
      expect(screen.getByText("▢")).toBeInTheDocument();
    });

    it("shows the magenta accent dot for the open, non-streaming session", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Open" })],
        activeId: "a",
        streaming: false,
      });
      const { container } = render(<Sidebar />);

      expect(container.querySelector(".pc-dot--accent")).not.toBeNull();
    });
  });

  describe("collapsible rail", () => {
    it("collapses to the slim rail and expands back", () => {
      useStore.setState({ sessions: [session({ id: "a" })], activeId: "a" });
      render(<Sidebar />);

      // Collapse from the panel header.
      fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      expect(useStore.getState().sidebarCollapsed).toBe(true);

      // The rail replaces the panel: no Sort toolbar, but an Expand affordance.
      expect(screen.queryByRole("button", { name: /Sort sessions/ })).not.toBeInTheDocument();
      const expand = screen.getByRole("button", { name: "Expand sidebar" });

      fireEvent.click(expand);
      expect(useStore.getState().sidebarCollapsed).toBe(false);
      expect(screen.getByRole("button", { name: /Sort sessions/ })).toBeInTheDocument();
    });

    it("creates a session from the rail's + button", async () => {
      useStore.setState({ sessions: [], activeId: null, sidebarCollapsed: true });
      render(<Sidebar />);

      fireEvent.click(screen.getByRole("button", { name: "New session" }));
      await Promise.resolve();
      await Promise.resolve();

      expect(m.createSession).toHaveBeenCalledTimes(1);
    });

    it("opens settings from the rail's gear", () => {
      useStore.setState({
        sessions: [],
        activeId: null,
        sidebarCollapsed: true,
        showSettings: false,
      });
      render(<Sidebar />);

      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(useStore.getState().showSettings).toBe(true);
    });

    it("ignores the collapsed flag when collapsible is false (the mobile drawer)", () => {
      useStore.setState({
        sessions: [session({ id: "a" })],
        activeId: "a",
        sidebarCollapsed: true,
      });
      render(<Sidebar collapsible={false} />);

      // The drawer always shows the full panel — toolbar present, no collapse control.
      expect(screen.getByRole("button", { name: /Sort sessions/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Collapse sidebar" })).not.toBeInTheDocument();
    });
  });

  describe("drag & drop into folders", () => {
    const dt = (id: string) => ({
      getData: vi.fn(() => id),
      setData: vi.fn(),
      effectAllowed: "",
      dropEffect: "",
    });

    it("moves a chat into a folder when dropped on it", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Drag me" })],
        activeId: "a",
        folders: [{ id: "f1", name: "Work", open: true }],
        folderOf: {},
      });
      render(<Sidebar />);

      // dragStart records the chat id on the transfer.
      const transfer = dt("a");
      const row = screen.getByRole("button", { name: /^Drag me/ }).closest('[draggable="true"]')!;
      fireEvent.dragStart(row, { dataTransfer: transfer });
      expect(transfer.setData).toHaveBeenCalledWith("text/pc-session", "a");

      const folderEl = screen.getByText("Work").closest(".pc-row")!;
      fireEvent.dragOver(folderEl, { dataTransfer: transfer });
      expect(folderEl.className).toContain("pc-droptarget");

      fireEvent.drop(folderEl, { dataTransfer: transfer });
      expect(useStore.getState().folderOf).toEqual({ a: "f1" });
    });

    // Regression: the title is a full-width <button>, so grabbing a chat by its
    // text never started the parent row's native drag in Chromium/WebView2 ("it
    // won't let you add a chat to a folder"). A non-button grip handle gives an
    // unambiguous drag surface whose own dragStart seeds the transfer.
    it("renders a non-button drag handle that seeds the transfer in none mode", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Drag me" })],
        activeId: "a",
        folders: [{ id: "f1", name: "Work", open: true }],
        folderOf: {},
        groupBy: "none",
      });
      const { container } = render(<Sidebar />);

      const handle = container.querySelector<HTMLElement>(".pc-drag-handle")!;
      expect(handle).not.toBeNull();
      // A grip — NOT a <button> — so the press can't be swallowed by an
      // interactive child, and it's hidden from the a11y tree (drag is mouse-only).
      expect(handle.tagName).toBe("SPAN");
      expect(handle.getAttribute("draggable")).toBe("true");
      expect(handle).toHaveAttribute("aria-hidden", "true");

      // The handle is its own drag source: dragStart on it records the chat id.
      const transfer = dt("a");
      fireEvent.dragStart(handle, { dataTransfer: transfer });
      expect(transfer.setData).toHaveBeenCalledWith("text/pc-session", "a");
    });

    it("moves a chat into a folder when the drag starts from the grip handle", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Drag me" })],
        activeId: "a",
        folders: [{ id: "f1", name: "Work", open: true }],
        folderOf: {},
        groupBy: "none",
      });
      const { container } = render(<Sidebar />);

      const handle = container.querySelector<HTMLElement>(".pc-drag-handle")!;
      const transfer = dt("a");
      fireEvent.dragStart(handle, { dataTransfer: transfer });

      const folderEl = screen.getByText("Work").closest(".pc-row")!;
      fireEvent.dragOver(folderEl, { dataTransfer: transfer });
      fireEvent.drop(folderEl, { dataTransfer: transfer });
      expect(useStore.getState().folderOf).toEqual({ a: "f1" });

      // dragEnd from the handle clears the transient drop-target highlight.
      fireEvent.dragEnd(handle);
      expect(folderEl.className).not.toContain("pc-droptarget");
    });

    it("omits the drag handle in an automatic grouping mode", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Drag me" })],
        activeId: "a",
        groupBy: "status",
      });
      const { container } = render(<Sidebar />);

      // Rows aren't draggable when grouped automatically, so no grip is offered.
      expect(container.querySelector(".pc-drag-handle")).toBeNull();
    });

    it("moves a chat back to loose when dropped on the list root", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Nested" })],
        activeId: "a",
        folders: [{ id: "f1", name: "Work", open: true }],
        folderOf: { a: "f1" },
      });
      render(<Sidebar />);

      const nav = screen.getByRole("navigation", { name: "Session list" });
      fireEvent.drop(nav, { dataTransfer: dt("a") });

      expect(useStore.getState().folderOf).toEqual({});
    });

    it("is a no-op when the drop carries no chat id", () => {
      useStore.setState({
        sessions: [session({ id: "a" })],
        activeId: "a",
        folders: [{ id: "f1", name: "Work", open: true }],
        folderOf: { a: "f1" },
      });
      render(<Sidebar />);

      const folderEl = screen.getByText("Work").closest(".pc-row")!;
      fireEvent.drop(folderEl, { dataTransfer: dt("") });
      // Unchanged — no id means nothing moves.
      expect(useStore.getState().folderOf).toEqual({ a: "f1" });
    });

    it("clears the drop-target highlight on drag leave", () => {
      useStore.setState({
        sessions: [session({ id: "a" })],
        activeId: "a",
        folders: [{ id: "f1", name: "Work", open: true }],
      });
      render(<Sidebar />);

      const folderEl = screen.getByText("Work").closest(".pc-row")!;
      fireEvent.dragOver(folderEl, { dataTransfer: dt("a") });
      expect(folderEl.className).toContain("pc-droptarget");
      fireEvent.dragLeave(folderEl);
      expect(folderEl.className).not.toContain("pc-droptarget");
    });
  });

  describe("branch grouping & metadata", () => {
    it("offers a Branch group option and buckets by git branch", () => {
      useStore.setState({
        sessions: [
          session({ id: "a", title: "One", branch: "main" }),
          session({ id: "b", title: "Two", branch: "feature/x" }),
        ],
        activeId: "a",
        groupBy: "branch",
      });
      render(<Sidebar />);

      expect(screen.getByText("main")).toBeInTheDocument();
      expect(screen.getByText("feature/x")).toBeInTheDocument();
    });

    it("lists Branch in the group menu and selects it", () => {
      useStore.setState({ sessions: [session({ id: "a" })], activeId: "a" });
      render(<Sidebar />);

      fireEvent.click(screen.getByRole("button", { name: /Group sessions/ }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Branch" }));

      expect(useStore.getState().groupBy).toBe("branch");
    });

    it("shows the real branch in the row's ⎇ metadata, with the workspace alongside", () => {
      useStore.setState({
        sessions: [
          session({
            id: "a",
            title: "Repo chat",
            branch: "feature/login",
            workspace: "C:/dev/proj",
          }),
        ],
        activeId: "a",
      });
      render(<Sidebar />);

      const row = screen.getByRole("button", { name: /^Repo chat/ });
      expect(row).toHaveTextContent("feature/login");
      expect(row).toHaveTextContent("proj");
    });

    it("falls back to the workspace label when a session has no branch", () => {
      useStore.setState({
        sessions: [
          session({ id: "a", title: "Local chat", branch: null, workspace: "C:/dev/proj" }),
        ],
        activeId: "a",
      });
      render(<Sidebar />);

      expect(screen.getByRole("button", { name: /^Local chat/ })).toHaveTextContent("proj");
    });
  });

  describe("drag-to-reorder (manual order)", () => {
    const dt = (id: string) => ({
      getData: vi.fn(() => id),
      setData: vi.fn(),
      effectAllowed: "",
      dropEffect: "",
    });

    it("reordering one chat onto another switches the sort to manual", () => {
      useStore.setState({
        sessions: [
          session({ id: "a", title: "Aaa", updatedAt: 200 }),
          session({ id: "b", title: "Bbb", updatedAt: 100 }),
        ],
        activeId: "a",
        sortBy: "recent",
      });
      render(<Sidebar />);

      const target = screen.getByRole("button", { name: /^Bbb/ }).closest('[draggable="true"]')!;
      fireEvent.drop(target, { dataTransfer: dt("a") });

      // The list is now in manual order and the Sort control reflects it.
      expect(useStore.getState().sortBy).toBe("manual");
      expect(useStore.getState().manualOrder).toContain("a");
      expect(screen.getByRole("button", { name: /Sort sessions \(Manual\)/ })).toBeInTheDocument();
    });

    it("dropping a chat onto itself is a no-op (sort stays)", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Aaa" }), session({ id: "b", title: "Bbb" })],
        activeId: "a",
        sortBy: "recent",
      });
      render(<Sidebar />);

      const self = screen.getByRole("button", { name: /^Aaa/ }).closest('[draggable="true"]')!;
      fireEvent.drop(self, { dataTransfer: dt("a") });

      expect(useStore.getState().sortBy).toBe("recent");
    });

    it("shows an insertion line over the row a drag would land on", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Aaa" }), session({ id: "b", title: "Bbb" })],
        activeId: "a",
      });
      render(<Sidebar />);

      const target = screen.getByRole("button", { name: /^Bbb/ }).closest('[draggable="true"]')!;
      fireEvent.dragOver(target, { dataTransfer: dt("a") });
      expect(target.className).toContain("pc-drop-line");
      fireEvent.dragLeave(target);
      expect(target.className).not.toContain("pc-drop-line");

      // dragEnd (e.g. dropping outside any target) also clears the indicator.
      fireEvent.dragOver(target, { dataTransfer: dt("a") });
      expect(target.className).toContain("pc-drop-line");
      fireEvent.dragEnd(target);
      expect(target.className).not.toContain("pc-drop-line");
    });

    it("rows are not draggable in an automatic grouping mode", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Aaa" })],
        activeId: "a",
        groupBy: "status",
      });
      render(<Sidebar />);

      const row = screen.getByRole("button", { name: /^Aaa/ }).closest("div")?.parentElement;
      expect(row).not.toHaveAttribute("draggable", "true");
    });
  });

  describe("right-click context menu", () => {
    it("opens a session menu with the common actions on right-click", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Chat A" })],
        activeId: "a",
      });
      render(<Sidebar />);

      const row = screen.getByRole("button", { name: /^Chat A/ }).closest("[draggable]")!;
      fireEvent.contextMenu(row);

      const menu = screen.getByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: "New chat" })).toBeInTheDocument();
      expect(within(menu).getByRole("menuitem", { name: "Archive" })).toBeInTheDocument();
      expect(within(menu).getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    });

    it("archives the session from its context menu", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Chat A" })],
        activeId: "a",
      });
      render(<Sidebar />);

      fireEvent.contextMenu(
        screen.getByRole("button", { name: /^Chat A/ }).closest("[draggable]")!,
      );
      fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

      expect(useStore.getState().archivedIds).toEqual(["a"]);
    });

    it("labels the archive action Unarchive for an archived session", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Chat A" })],
        activeId: null,
        archivedIds: ["a"],
      });
      render(<Sidebar />);

      fireEvent.contextMenu(
        screen.getByRole("button", { name: /^Chat A/ }).closest("[draggable]")!,
      );
      expect(screen.getByRole("menuitem", { name: "Unarchive" })).toBeInTheDocument();
    });

    it("deletes the session from its context menu", async () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Keep" }), session({ id: "b", title: "Remove" })],
        activeId: "a",
        messages: { a: [], b: [] },
      });
      render(<Sidebar />);

      fireEvent.contextMenu(
        screen.getByRole("button", { name: /^Remove/ }).closest("[draggable]")!,
      );
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      await Promise.resolve();
      await Promise.resolve();

      expect(m.deleteSession).toHaveBeenCalledWith("b");
    });

    it("marks the Delete item as destructive (danger styling)", () => {
      useStore.setState({ sessions: [session({ id: "a", title: "Chat A" })], activeId: "a" });
      render(<Sidebar />);

      fireEvent.contextMenu(
        screen.getByRole("button", { name: /^Chat A/ }).closest("[draggable]")!,
      );
      expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveClass("pc-ctx__item--danger");
    });

    it("disables mutating session actions while a turn streams", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Chat A" })],
        activeId: "a",
        streaming: true,
      });
      render(<Sidebar />);

      fireEvent.contextMenu(
        screen.getByRole("button", { name: /^Chat A/ }).closest("[draggable]")!,
      );
      expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    });

    it("offers Move to folder items and moves the chat into the picked folder", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Chat A" })],
        activeId: "a",
        folders: [{ id: "f1", name: "Work", open: true }],
        folderOf: {},
        groupBy: "none",
      });
      render(<Sidebar />);

      fireEvent.contextMenu(
        screen.getByRole("button", { name: /^Chat A/ }).closest("[draggable]")!,
      );
      // The folder appears under a "Move to folder" heading.
      expect(screen.getByText("Move to folder")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));

      expect(useStore.getState().folderOf).toEqual({ a: "f1" });
    });

    it("offers Remove from folder for a chat already in one, and disables its current folder", () => {
      useStore.setState({
        sessions: [session({ id: "a", title: "Chat A" })],
        activeId: "a",
        folders: [{ id: "f1", name: "Work", open: true }],
        folderOf: { a: "f1" },
        groupBy: "none",
      });
      render(<Sidebar />);

      fireEvent.contextMenu(
        screen.getByRole("button", { name: /^Chat A/ }).closest("[draggable]")!,
      );
      // The current folder is disabled (can't move where it already is).
      expect(screen.getByRole("menuitem", { name: "Work" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove from folder" }));

      expect(useStore.getState().folderOf).toEqual({});
    });

    it("opens a folder context menu with New folder / Rename / Delete folder", () => {
      useStore.setState({
        sessions: [],
        activeId: null,
        folders: [{ id: "f1", name: "Work", open: true }],
      });
      render(<Sidebar />);

      const folderRow = screen.getByText("Work").closest(".pc-row")!;
      fireEvent.contextMenu(folderRow);

      const menu = screen.getByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: "New folder" })).toBeInTheDocument();
      expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
      expect(within(menu).getByRole("menuitem", { name: "Delete folder" })).toBeInTheDocument();
    });

    it("triggers inline rename from the folder context menu", () => {
      useStore.setState({ folders: [{ id: "f1", name: "Work", open: true }] });
      render(<Sidebar />);

      fireEvent.contextMenu(screen.getByText("Work").closest(".pc-row")!);
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

      // The inline rename editor appears, pre-filled with the folder name.
      expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveValue("Work");
    });

    it("deletes a folder from its context menu", () => {
      useStore.setState({ folders: [{ id: "f1", name: "Work", open: true }] });
      render(<Sidebar />);

      fireEvent.contextMenu(screen.getByText("Work").closest(".pc-row")!);
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete folder" }));

      expect(useStore.getState().folders).toHaveLength(0);
    });

    it("offers New chat / New folder from the empty list background", () => {
      useStore.setState({ sessions: [], activeId: null, groupBy: "none" });
      render(<Sidebar />);

      const nav = screen.getByRole("navigation", { name: "Session list" });
      fireEvent.contextMenu(nav);

      const menu = screen.getByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: "New chat" })).toBeInTheDocument();
      expect(within(menu).getByRole("menuitem", { name: "New folder" })).toBeInTheDocument();
    });
  });

  describe("open/close animation", () => {
    it("morphs the shell width between the panel (248) and rail (52)", () => {
      useStore.setState({
        sessions: [session({ id: "a" })],
        activeId: "a",
        sidebarCollapsed: false,
      });
      const { container } = render(<Sidebar />);

      const shell = container.firstElementChild as HTMLElement;
      expect(shell).toHaveStyle({ width: "248px" });
      expect(shell.className).toContain("transition-[width]");

      fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      expect(shell).toHaveStyle({ width: "52px" });
    });
  });
});
