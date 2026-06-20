import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

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

  it("hides FileExplorer and SettingsPanel when their flags are false", () => {
    useStore.setState({ showFiles: false, showSettings: false });

    render(<App />);

    expect(screen.queryByTestId("file-explorer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-panel")).not.toBeInTheDocument();
  });

  it("shows FileExplorer only when showFiles is true", () => {
    useStore.setState({ showFiles: true });

    render(<App />);

    expect(screen.getByTestId("file-explorer")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-panel")).not.toBeInTheDocument();
  });

  it("shows SettingsPanel only when showSettings is true", () => {
    useStore.setState({ showSettings: true });

    render(<App />);

    expect(screen.getByTestId("settings-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("file-explorer")).not.toBeInTheDocument();
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

    expect(screen.queryByTestId("file-explorer")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Toggle file explorer (Ctrl+B)"));

    expect(screen.getByTestId("file-explorer")).toBeInTheDocument();
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

  it("removes its keydown listener on unmount", () => {
    const { unmount } = render(<App />);
    unmount();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    // With the listener cleaned up, the shortcut no longer mutates the store.
    expect(useStore.getState().showPalette).toBe(false);
  });
});
