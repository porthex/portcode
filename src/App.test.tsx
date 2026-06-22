import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

import App from "./App";
import { useStore } from "./store/store";
import { DEFAULT_SETTINGS } from "./types";
import * as ipc from "./lib/ipc";

// App's own logic is the mount-time `init()` effect, the global keyboard
// shortcut effect, and the conditional rendering of panels by store flags
// (showFiles -> FileExplorer, showSettings -> SettingsPanel) plus the TitleBar.
// We stub every heavy child to a tiny marker so the assertions target App's
// branches, and we mock the IPC layer so the *real* store `init()` resolves
// harmlessly (it calls getSettings/listSessions/createSession/getMessages).

vi.mock("./components/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));
vi.mock("./components/Chat", () => ({
  Chat: () => <div data-testid="chat" />,
}));
vi.mock("./components/FileExplorer", () => ({
  FileExplorer: () => <div data-testid="file-explorer" />,
}));
vi.mock("./components/Settings", () => ({
  SettingsPanel: () => <div data-testid="settings-panel" />,
}));
vi.mock("./components/CommandPalette", () => ({
  CommandPalette: () => <div data-testid="command-palette" />,
}));
vi.mock("./components/RemotePairing", () => ({
  RemotePairing: () => <div data-testid="remote-pairing" />,
}));

// `isTauri` is consumed by App's TitleBar; the rest of the surface is what the
// store's `init()` path invokes. A single mock of this module covers both the
// component import and the store's `import * as ipc`. The factory is hoisted, so
// it must not close over outer variables — we create the fns inline and reach
// them later through the imported (now-mocked) module.
vi.mock("./lib/ipc", () => ({
  isTauri: vi.fn(),
  getSettings: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  getMessages: vi.fn(),
  // store.init() restores subscription sign-in via ipc.oauthStatus() on mount.
  oauthStatus: vi.fn(),
  startOauthLogin: vi.fn(),
  oauthLogout: vi.fn(),
  // store.init() also fetches phone sync status.
  phoneSyncStatus: vi.fn(),
  phoneSyncBeginPairing: vi.fn(),
  phoneSyncUnpair: vi.fn(),
  // Reached when the remote-session banner's Disconnect is clicked.
  phoneSyncDisconnect: vi.fn(),
}));

const m = vi.mocked(ipc);
const initialState = useStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  // Restore a pristine store between tests (zustand has no built-in reset).
  useStore.setState(initialState, true);
  // clearAllMocks wipes mockReturnValue, so re-seed the IPC surface each test.
  m.isTauri.mockReturnValue(false);
  m.getSettings.mockResolvedValue(DEFAULT_SETTINGS);
  m.listSessions.mockResolvedValue([]);
  m.createSession.mockResolvedValue(undefined);
  m.getMessages.mockResolvedValue([]);
  m.oauthStatus.mockResolvedValue({ signedIn: false, expiresAt: null, account: null, tier: null });
  m.phoneSyncStatus.mockResolvedValue({ devicePublicKey: "DEVICE==", paired: [] });
  m.phoneSyncDisconnect.mockResolvedValue(undefined);
});

describe("App layout", () => {
  it("runs init() on mount: creates a first session and renders the core shell", async () => {
    render(<App />);

    // The real init() resolves through the mocked IPC and, with no existing
    // sessions, creates exactly one.
    await waitFor(() => {
      expect(useStore.getState().sessions).toHaveLength(1);
    });

    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("chat")).toBeInTheDocument();
    // CommandPalette is always mounted (it self-gates on showPalette internally).
    expect(screen.getByTestId("command-palette")).toBeInTheDocument();
  });

  it("releases the remote frame subscription when the app unmounts", async () => {
    const unlisten = vi.fn();
    const { unmount } = render(<App />);
    // Let init() settle so its async setState can't race the teardown assertion.
    await waitFor(() => expect(useStore.getState().sessions).toHaveLength(1));
    useStore.setState({ remoteUnlisten: unlisten });

    unmount();

    // App's unmount effect tears the live native frame listener down so it can't
    // survive into a fresh store instance (HMR / root remount) and double-feed.
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("collapses the file rail and hides SettingsPanel when their flags are false", () => {
    useStore.setState({ showFiles: false, showSettings: false });

    render(<App />);

    // The rail stays mounted (so its width can animate) but collapses to a 0fr
    // grid column and goes inert/aria-hidden so it's out of the tab order and AT.
    const rail = screen.getByTestId("file-rail");
    expect(rail).toHaveStyle({ gridTemplateColumns: "0fr" });
    expect(rail).toHaveAttribute("aria-hidden", "true");
    expect(rail).toHaveAttribute("inert");
    expect(screen.queryByTestId("settings-panel")).not.toBeInTheDocument();
  });

  it("expands the file rail (1fr, not inert) when showFiles is true", () => {
    useStore.setState({ showFiles: true });

    render(<App />);

    const rail = screen.getByTestId("file-rail");
    expect(screen.getByTestId("file-explorer")).toBeInTheDocument();
    expect(rail).toHaveStyle({ gridTemplateColumns: "1fr" });
    // Open: it's reachable — no inert, no aria-hidden masking the tree.
    expect(rail).not.toHaveAttribute("inert");
    expect(rail).not.toHaveAttribute("aria-hidden");
    expect(screen.queryByTestId("settings-panel")).not.toBeInTheDocument();
  });

  it("shows SettingsPanel only when showSettings is true", () => {
    useStore.setState({ showSettings: true, showFiles: false });

    render(<App />);

    expect(screen.getByTestId("settings-panel")).toBeInTheDocument();
    // The file rail is mounted but collapsed when showFiles is false.
    expect(screen.getByTestId("file-rail")).toHaveStyle({ gridTemplateColumns: "0fr" });
  });
});

describe("remote mode shell", () => {
  it("renders the desktop layout (no pairing screen) when remoteMode is off", () => {
    useStore.setState({ remoteMode: false });

    render(<App />);

    expect(screen.queryByTestId("remote-pairing")).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.queryByText("Remote · connected")).not.toBeInTheDocument();
  });

  it("shows the pairing screen (and hides the session) when in remote mode but not connected", () => {
    useStore.setState({ remoteMode: true, remoteConnected: false, remoteVerified: false });

    render(<App />);

    expect(screen.getByTestId("remote-pairing")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
  });

  it("keeps showing the pairing screen while connected but not yet SAS-verified", () => {
    // The SAS gate: a live connection alone isn't enough to reveal the session.
    useStore.setState({ remoteMode: true, remoteConnected: true, remoteVerified: false });

    render(<App />);

    expect(screen.getByTestId("remote-pairing")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
  });

  it("renders the remote session with a connected banner once verified", () => {
    useStore.setState({ remoteMode: true, remoteConnected: true, remoteVerified: true });

    render(<App />);

    expect(screen.queryByTestId("remote-pairing")).not.toBeInTheDocument();
    // On the phone the session list is a drawer, not an inline rail — reached via
    // the TitleBar "Sessions" menu button.
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle sessions" })).toBeInTheDocument();
    expect(screen.getByTestId("chat")).toBeInTheDocument();
    expect(screen.getByText("Remote · connected")).toBeInTheDocument();
  });

  it("opens the session drawer from the menu button and closes it on the backdrop", () => {
    useStore.setState({ remoteMode: true, remoteConnected: true, remoteVerified: true });

    render(<App />);
    // Drawer closed initially: the sidebar isn't mounted.
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle sessions" }));
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(useStore.getState().showSidebar).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close sessions" }));
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
    expect(useStore.getState().showSidebar).toBe(false);
  });

  it("closes the session drawer with Escape", () => {
    useStore.setState({ remoteMode: true, remoteConnected: true, remoteVerified: true });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle sessions" }));
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();

    // Plain Escape isn't caught by App's modified-key shortcut effect; the drawer
    // installs its own handler so focus isn't stranded inside the overlay.
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
    expect(useStore.getState().showSidebar).toBe(false);
  });

  it("Escape closes only the topmost layer when Settings stacks over the drawer", () => {
    useStore.setState({ remoteMode: true, remoteConnected: true, remoteVerified: true });

    render(<App />);
    const opener = screen.getByRole("button", { name: "Toggle sessions" });
    opener.focus();
    fireEvent.click(opener);
    // Both overlays are open: the drawer renders <Sidebar/>, whose footer Settings
    // button opens Settings without closing the drawer (it stacks on top, z-58 > z-50).
    // SettingsPanel is stubbed here, so its own unconditional Escape handler isn't
    // present — this case targets the drawer's new bail branch, leaving the topmost
    // layer (Settings) to dismiss itself (covered in Settings.test).
    act(() => useStore.setState({ showSettings: true }));
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("settings-panel")).toBeInTheDocument();

    // First Escape: the drawer's handler bails while Settings is open, so the drawer
    // stays mounted instead of collapsing both layers at once.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().showSidebar).toBe(true);
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();

    // Once the top layer (Settings) is gone, focus returns to the drawer and a
    // second Escape closes it, restoring focus to the hamburger.
    act(() => useStore.setState({ showSettings: false }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().showSidebar).toBe(false);
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it("Escape closes only the topmost layer when the command palette stacks over the drawer", () => {
    useStore.setState({ remoteMode: true, remoteConnected: true, remoteVerified: true });

    render(<App />);
    const opener = screen.getByRole("button", { name: "Toggle sessions" });
    opener.focus();
    fireEvent.click(opener);
    // The palette (z-60) stacks above the drawer (z-50) and is reachable in remote
    // mode via Ctrl+K. With both open, the drawer's Escape handler must bail so a
    // single Escape dismisses only the palette layer, not the drawer underneath.
    act(() => useStore.setState({ showPalette: true }));
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().showSidebar).toBe(true);
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();

    // Once the palette layer is gone, a second Escape collapses the drawer.
    act(() => useStore.setState({ showPalette: false }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().showSidebar).toBe(false);
  });

  it("moves focus into the drawer on open and restores it to the opener on close", () => {
    useStore.setState({ remoteMode: true, remoteConnected: true, remoteVerified: true });

    render(<App />);
    const opener = screen.getByRole("button", { name: "Toggle sessions" });
    // The opener is the focused trigger when the drawer opens.
    opener.focus();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);

    // Focus moves onto the dialog container (a non-input element, so the phone
    // soft keyboard doesn't pop), not left on the now-occluded hamburger.
    const dialog = screen.getByRole("dialog", { name: "Sessions" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.activeElement).toBe(dialog);

    // Closing restores focus to the opener that launched the drawer.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it("traps Tab within the drawer (wraps from the last focusable back to the first)", () => {
    useStore.setState({ remoteMode: true, remoteConnected: true, remoteVerified: true });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle sessions" }));

    const dialog = screen.getByRole("dialog", { name: "Sessions" });
    // With the Sidebar stubbed, the only tabbable descendant is the backdrop
    // Close button — it's both the first and last focusable in the trap.
    const close = screen.getByRole("button", { name: "Close sessions" });
    close.focus();
    expect(document.activeElement).toBe(close);

    // Tab from the last focusable wraps to the first (still the Close button),
    // so focus never escapes the modal into the chat behind the backdrop.
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    // Shift+Tab from the first focusable wraps back to the last (also Close).
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it("hides the desktop command-palette button on the phone", () => {
    useStore.setState({ remoteMode: true, remoteConnected: true, remoteVerified: true });

    render(<App />);

    // ⌘K is a desktop keyboard affordance — gone on the phone.
    expect(
      screen.queryByRole("button", { name: "Open command palette (Ctrl+K)" }),
    ).not.toBeInTheDocument();
  });

  it("disconnects from the desktop via the banner button", async () => {
    useStore.setState({ remoteMode: true, remoteConnected: true, remoteVerified: true });

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Disconnect from desktop" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.phoneSyncDisconnect).toHaveBeenCalledTimes(1);
    const st = useStore.getState();
    expect(st.remoteConnected).toBe(false);
    expect(st.remoteVerified).toBe(false);
  });
});

describe("TitleBar", () => {
  it("falls back to 'New chat' when there is no active session", () => {
    useStore.setState({ sessions: [], activeId: null });

    render(<App />);

    // The breadcrumb is "portcode / {title}"; with no active session the title
    // segment falls back to "New chat".
    expect(screen.getByText("New chat")).toBeInTheDocument();
  });

  it("shows the active session's title when one is active", () => {
    useStore.setState({
      sessions: [
        {
          id: "a",
          title: "Refactor the parser",
          workspace: null,
          model: "claude-opus-4-8",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeId: "a",
    });

    render(<App />);

    expect(screen.getByText("Refactor the parser")).toBeInTheDocument();
  });

  it("shows the active session title in the title-bar breadcrumb (not as a competing heading)", () => {
    useStore.setState({
      sessions: [
        {
          id: "a",
          title: "Refactor the parser",
          workspace: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeId: "a",
    });

    render(<App />);

    // The breadcrumb shows the title as plain text. It is deliberately NOT a
    // heading, so it never competes with Chat's single empty-state/error <h1>.
    expect(screen.getByText("Refactor the parser")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Refactor the parser" })).not.toBeInTheDocument();
  });

  it("renders the preview-mode badge outside Tauri", () => {
    m.isTauri.mockReturnValue(false);

    render(<App />);

    expect(screen.getByText("PREVIEW MODE")).toBeInTheDocument();
  });

  it("hides the preview-mode badge when running inside Tauri", () => {
    m.isTauri.mockReturnValue(true);

    render(<App />);

    expect(screen.queryByText("PREVIEW MODE")).not.toBeInTheDocument();
  });

  it("toggles the file explorer via the TitleBar button", () => {
    render(<App />);

    // The rail is mounted but collapsed (0fr / inert) before the toggle, and the
    // toggle button reports its off state to assistive tech via aria-pressed.
    const rail = screen.getByTestId("file-rail");
    expect(rail).toHaveStyle({ gridTemplateColumns: "0fr" });
    expect(rail).toHaveAttribute("inert");
    const toggle = screen.getByRole("button", { name: "Toggle file explorer (Ctrl+B)" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);

    // After the toggle it expands to 1fr, drops inert, and flips aria-pressed on.
    expect(screen.getByTestId("file-rail")).toHaveStyle({ gridTemplateColumns: "1fr" });
    expect(screen.getByTestId("file-rail")).not.toHaveAttribute("inert");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(useStore.getState().showFiles).toBe(true);
  });

  it("exposes an accessible name on the toggle-files button", () => {
    render(<App />);

    expect(
      screen.getByRole("button", { name: "Toggle file explorer (Ctrl+B)" }),
    ).toBeInTheDocument();
  });

  it("exposes an accessible name on the command-palette button", () => {
    render(<App />);

    expect(
      screen.getByRole("button", { name: "Open command palette (Ctrl+K)" }),
    ).toBeInTheDocument();
  });
});

describe("global keyboard shortcuts", () => {
  it("ignores keys pressed without ctrl/meta", () => {
    render(<App />);
    const before = useStore.getState().showPalette;

    fireEvent.keyDown(window, { key: "k" });

    expect(useStore.getState().showPalette).toBe(before);
  });

  it("Ctrl+K toggles the command palette flag", () => {
    render(<App />);
    expect(useStore.getState().showPalette).toBe(false);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(useStore.getState().showPalette).toBe(true);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(useStore.getState().showPalette).toBe(false);
  });

  it("Meta+N starts a new session", async () => {
    render(<App />);
    await waitFor(() => expect(useStore.getState().sessions).toHaveLength(1));
    const firstId = useStore.getState().activeId;

    fireEvent.keyDown(window, { key: "n", metaKey: true });

    await waitFor(() => expect(useStore.getState().sessions).toHaveLength(2));
    expect(useStore.getState().activeId).not.toBe(firstId);
  });

  it("Ctrl+B toggles the file explorer", () => {
    render(<App />);
    expect(useStore.getState().showFiles).toBe(false);

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });

    expect(useStore.getState().showFiles).toBe(true);
    expect(screen.getByTestId("file-explorer")).toBeInTheDocument();
    // Toggling on expands the rail's grid column from 0fr to 1fr.
    expect(screen.getByTestId("file-rail")).toHaveStyle({ gridTemplateColumns: "1fr" });
  });

  it("rescues focus to the file-toggle button when Ctrl+B collapses the rail", () => {
    // Open the rail first so the toggle is a true->false (collapse) transition.
    useStore.setState({ showFiles: true });
    render(<App />);

    // Simulate the inert-collapse blur: when the rail goes inert the browser
    // blurs the focused tree row and focus falls to <body>. We can't focus a
    // real treeitem (FileExplorer is stubbed), so we reproduce the end state.
    act(() => (document.body as HTMLElement).focus());
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });

    // The collapse-edge effect rescues focus to the still-visible, still-tabbable
    // toggle button instead of leaving the keyboard user stranded on <body>.
    expect(useStore.getState().showFiles).toBe(false);
    const toggle = screen.getByRole("button", { name: "Toggle file explorer (Ctrl+B)" });
    expect(document.activeElement).toBe(toggle);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("Ctrl+, opens settings", () => {
    render(<App />);
    expect(useStore.getState().showSettings).toBe(false);

    fireEvent.keyDown(window, { key: ",", ctrlKey: true });

    expect(useStore.getState().showSettings).toBe(true);
    expect(screen.getByTestId("settings-panel")).toBeInTheDocument();
  });

  it("ignores an unmapped modifier key", () => {
    render(<App />);

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    const st = useStore.getState();
    expect(st.showPalette).toBe(false);
    expect(st.showFiles).toBe(false);
    expect(st.showSettings).toBe(false);
  });

  it("ignores shell shortcuts (except Ctrl+K) while typing in an input", () => {
    render(<App />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    // A real event so e.target is the focused input (fireEvent.keyDown(window)
    // would target window, defeating the guard). Ctrl+, must NOT open Settings
    // while the user is typing.
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true }));
    });

    const st = useStore.getState();
    expect(st.showPalette).toBe(false);
    expect(st.showSettings).toBe(false);
    document.body.removeChild(input);
  });

  it("ignores shell shortcuts while typing in a textarea", () => {
    render(<App />);
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    act(() => {
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true }));
    });

    expect(useStore.getState().showSettings).toBe(false);
    document.body.removeChild(ta);
  });

  it("keeps Ctrl+K live from a focused field (it's the advertised palette toggle)", () => {
    render(<App />);
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    act(() => {
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    });

    // Unlike the other shortcuts, Ctrl+K is not suppressed while typing — it must
    // open the command palette straight from the composer textarea.
    expect(useStore.getState().showPalette).toBe(true);
    document.body.removeChild(ta);
  });

  it("announces a dropped remote link via a persistent App-level live region", () => {
    useStore.setState({
      remoteMode: true,
      remoteConnected: true,
      remoteVerified: true,
      remoteDropped: false,
    });
    render(<App />);

    // No drop message while the link is healthy — the region is mounted but empty.
    expect(screen.queryByText(/Connection to desktop lost/)).not.toBeInTheDocument();

    act(() => useStore.setState({ remoteDropped: true }));

    // The persistent region (mounted before the drop) now carries the message, so
    // the empty->message change is announced (role=status / aria-live=polite).
    const status = screen.getByText(/Connection to desktop lost/);
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("announces a successful remote pairing on the connected+verified edge", () => {
    vi.useFakeTimers();
    try {
      // Start in remote mode on the pairing screen (not yet connected/verified),
      // so the live region is mounted empty and the success message is announced
      // as an empty->message change once the SAS is confirmed.
      useStore.setState({ remoteMode: true, remoteConnected: false, remoteVerified: false });
      render(<App />);

      expect(screen.queryByText(/Connected to your desktop/)).not.toBeInTheDocument();

      // Confirm-SAS path: connected + verified flip true together, clearing the
      // gate. The false->true edge sets the transient success announcement.
      act(() => useStore.setState({ remoteConnected: true, remoteVerified: true }));

      const status = screen.getByText(/Connected to your desktop/);
      expect(status).toHaveAttribute("role", "status");
      expect(status).toHaveAttribute("aria-live", "polite");

      // The message is transient: it clears so a later re-announcement can fire.
      act(() => vi.advanceTimersByTime(4000));
      expect(screen.queryByText(/Connected to your desktop/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not stack the palette over open Settings (Ctrl+K is a no-op)", () => {
    useStore.setState({ showSettings: true });
    render(<App />);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    // Settings is open: Ctrl+K must not open the palette on top of it.
    expect(useStore.getState().showPalette).toBe(false);
    expect(useStore.getState().showSettings).toBe(true);
  });

  it("ignores Ctrl+N/B/, while Settings is open", () => {
    useStore.setState({ showSettings: true });
    render(<App />);
    const before = useStore.getState().sessions.length;

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });

    const st = useStore.getState();
    expect(st.sessions).toHaveLength(before);
    expect(st.showFiles).toBe(false);
  });

  it("ignores Ctrl+N/B/, while the palette is open", () => {
    useStore.setState({ showPalette: true });
    render(<App />);
    const before = useStore.getState().sessions.length;

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });

    const st = useStore.getState();
    expect(st.sessions).toHaveLength(before);
    expect(st.showFiles).toBe(false);
    expect(st.showSettings).toBe(false);
  });

  it("removes its keydown listener on unmount", () => {
    const { unmount } = render(<App />);
    unmount();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    // With the listener cleaned up, the shortcut no longer mutates the store.
    expect(useStore.getState().showPalette).toBe(false);
  });
});
