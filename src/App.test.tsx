import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import App from "./App";
import { useStore } from "./store/store";
import {
  DEFAULT_SETTINGS,
  OPENAI_FALLBACK_MODELS,
  type OpenAIAccountSummary,
  type OpenAIModelCatalogRow,
  type OpenAIModelCatalogState,
} from "./types";
import * as ipc from "./lib/ipc";
import { getInstallState } from "./lib/installGate";

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
  Chat: ({
    transcriptAside,
    transcriptAsideOpen,
  }: {
    transcriptAside?: React.ReactNode;
    transcriptAsideOpen?: boolean;
  }) => (
    <div data-testid="chat" data-transcript-aside-open={String(!!transcriptAsideOpen)}>
      {transcriptAside}
    </div>
  ),
}));
vi.mock("./components/FileExplorer", () => ({
  FileExplorer: () => <div data-testid="file-explorer" />,
}));
vi.mock("./components/review/ReviewWorkspace", async () => {
  const { useState } = await vi.importActual<typeof import("react")>("react");
  return {
    ReviewWorkspace: ({ active }: { active?: boolean }) => {
      const [controllerState, setControllerState] = useState("initial");
      return (
        <div data-testid="review-workspace" data-active={String(!!active)}>
          <output aria-label="Review controller state">{controllerState}</output>
          <button type="button" onClick={() => setControllerState("preserved")}>
            Change review controller state
          </button>
        </div>
      );
    },
  };
});
vi.mock("./components/CodexMarketplace", () => ({
  CodexMarketplace: () => <div data-testid="codex-marketplace" />,
}));
vi.mock("./components/EnvironmentPanel", () => ({
  EnvironmentPanelProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
  EnvironmentPanelTrigger: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <button
      type="button"
      aria-label="Environment and agents"
      aria-expanded={open}
      onClick={() => onOpenChange(!open)}
    >
      Environment
    </button>
  ),
  EnvironmentPanelDock: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="environment-panel">
      <button type="button" onClick={onClose}>
        Close environment
      </button>
    </div>
  ),
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
vi.mock("./components/RemoteSessions", () => ({
  RemoteSessions: () => <div data-testid="remote-sessions" />,
}));
vi.mock("./components/RemoteChatHeader", () => ({
  RemoteChatHeader: () => <div data-testid="remote-chat-header" />,
}));
vi.mock("./components/RemoteEdgeStates", () => ({
  DisconnectedState: () => <div data-testid="disconnected-state" />,
  OfflineState: () => <div data-testid="offline-state" />,
}));
vi.mock("./components/InstallGate", () => ({
  InstallGate: () => <div data-testid="install-gate" />,
}));

// The install gate is gated on the web-client flag (ipc.isWebClientMode) AND the
// iOS install state (installGate.getInstallState). Stub the install state module so
// these App tests can drive the gate branch; default to "not-ios-ok" (a desktop
// browser) so the existing tests fall through to pairing exactly as before.
vi.mock("./lib/installGate", () => ({
  getInstallState: vi.fn(() => ({
    installed: false,
    ios: false,
    canPair: true,
    reason: "not-ios-ok",
    guidance: "",
  })),
}));

vi.mock("./components/CrashConsentPrompt", () => ({
  CrashConsentPrompt: () => <div data-testid="crash-consent-prompt" />,
}));

// App calls telemetry on mount (main.tsx-style pre-init is separate) and from the
// crashReporting sync effect. Stub it so this suite never depends on a build-time
// DSN (`telemetryConfigured`) or touches the real Sentry client.
vi.mock("./lib/telemetry", () => ({
  initTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(),
  telemetryConfigured: vi.fn(() => false),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(),
}));

// `isTauri` is consumed by App's TitleBar; the rest of the surface is what the
// store's `init()` path invokes. A single mock of this module covers both the
// component import and the store's `import * as ipc`. The factory is hoisted, so
// it must not close over outer variables — we create the fns inline and reach
// them later through the imported (now-mocked) module.
vi.mock("./lib/ipc", () => ({
  isTauri: vi.fn(),
  // App uses this to gate the iOS install screen to the web-client path only.
  isWebClientMode: vi.fn(),
  getSettings: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  getMessages: vi.fn(),
  // store.init() hydrates per-session drafts + cumulative usage on mount.
  getDrafts: vi.fn(),
  getAllUsage: vi.fn(),
  openaiOauthStatus: vi.fn(),
  listOpenAIAccounts: vi.fn(),
  openaiModels: vi.fn(),
  getPlanUsage: vi.fn(),
  subscribeSessionEvents: vi.fn(),
  // store.init() also fetches phone sync status.
  phoneSyncStatus: vi.fn(),
  phoneSyncBeginPairing: vi.fn(),
  phoneSyncUnpair: vi.fn(),
  // Reached when the remote-session banner's Disconnect is clicked.
  phoneSyncDisconnect: vi.fn(),
  // store.init() (desktop) subscribes to inbound pairing-confirm requests.
  onPhoneSyncPairingRequest: vi.fn(),
  // Auto-update: App's desktop-only mount effect subscribes to updater events and
  // kicks off a channel load + check. Only reached when isTauri() is true.
  onUpdaterEvent: vi.fn(),
  getUpdateChannel: vi.fn(),
  checkForUpdate: vi.fn(),
}));

const m = vi.mocked(ipc);
const currentWindow = vi.mocked(getCurrentWindow);
const initialState = useStore.getState();
const CODEX_PRIMARY_ACCOUNT: OpenAIAccountSummary = {
  id: "codex-primary",
  accountLabel: "OpenAI Platform API key",
  tier: null,
  expiresAt: null,
  state: "connected",
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: 1,
};
const CODEX_PRIMARY_MODEL_ROWS: OpenAIModelCatalogRow[] = OPENAI_FALLBACK_MODELS.map((model) => ({
  id: model.id,
  label: model.label,
  reasoningEfforts: model.reasoningEfforts ?? ["medium"],
  defaultReasoningEffort: model.defaultReasoningEffort ?? "medium",
  serviceTiers: model.serviceTiers ?? [],
}));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  // Restore a pristine store between tests (zustand has no built-in reset).
  useStore.setState(initialState, true);
  // clearAllMocks wipes mockReturnValue, so re-seed the IPC surface each test.
  m.isTauri.mockReturnValue(false);
  m.getSettings.mockResolvedValue(DEFAULT_SETTINGS);
  m.listSessions.mockResolvedValue([]);
  m.createSession.mockImplementation(
    async (
      id,
      title = "New chat",
      workspace = null,
      model = DEFAULT_SETTINGS.model,
      accountProfileId = null,
    ) => ({
      id,
      title,
      workspace,
      branch: null,
      model,
      accountProfileId,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  m.getMessages.mockResolvedValue([]);
  m.getDrafts.mockResolvedValue([]);
  m.getAllUsage.mockResolvedValue([]);
  m.openaiOauthStatus.mockResolvedValue({
    signedIn: true,
    expiresAt: null,
    account: CODEX_PRIMARY_ACCOUNT.accountLabel,
    tier: null,
    available: true,
  });
  m.openaiModels.mockResolvedValue(CODEX_PRIMARY_MODEL_ROWS);
  m.listOpenAIAccounts.mockResolvedValue([CODEX_PRIMARY_ACCOUNT]);
  m.getPlanUsage.mockImplementation(async (provider) => ({
    provider,
    plan: null,
    updatedAt: 1,
    windows: [],
  }));
  m.subscribeSessionEvents.mockResolvedValue(() => {});
  m.phoneSyncStatus.mockResolvedValue({ devicePublicKey: "DEVICE==", paired: [] });
  m.phoneSyncDisconnect.mockResolvedValue(undefined);
  m.onPhoneSyncPairingRequest.mockResolvedValue(() => {});
  // Default: NOT the web client (desktop preview / native), so the install gate
  // never intercepts. The install-gate tests below flip these per-test.
  m.isWebClientMode.mockReturnValue(false);
  vi.mocked(getInstallState).mockReturnValue({
    installed: false,
    ios: false,
    canPair: true,
    reason: "not-ios-ok",
    guidance: "",
  });
  // Auto-update mocks: harmless resolved values so the desktop mount effect (when
  // isTauri() is true) settles without touching a real updater.
  m.onUpdaterEvent.mockResolvedValue(() => {});
  m.getUpdateChannel.mockResolvedValue("stable");
  m.checkForUpdate.mockResolvedValue(null);
  currentWindow.mockReturnValue({
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as never);
});

describe("App layout", () => {
  it("checks for updates when the stable desktop app mounts", async () => {
    m.isTauri.mockReturnValue(true);

    render(<App />);

    await waitFor(() => {
      expect(m.onUpdaterEvent).toHaveBeenCalledTimes(1);
      expect(m.getUpdateChannel).toHaveBeenCalledTimes(1);
      expect(m.checkForUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it("checks the beta feed when the beta desktop app mounts", async () => {
    vi.stubEnv("VITE_PORTCODE_CHANNEL", "beta");
    m.isTauri.mockReturnValue(true);
    m.getUpdateChannel.mockResolvedValue("beta");

    render(<App />);

    await waitFor(() => {
      expect(m.onUpdaterEvent).toHaveBeenCalledTimes(1);
      expect(m.getUpdateChannel).toHaveBeenCalledTimes(1);
      expect(m.checkForUpdate).toHaveBeenCalledTimes(1);
      expect(useStore.getState().updateChannel).toBe("beta");
    });
  });

  it("folds native updater events into store progress and tears down the listener", async () => {
    m.isTauri.mockReturnValue(true);
    const off = vi.fn();
    let handler:
      | ((
          event:
            { kind: "progress"; downloaded: number; total: number | null } | { kind: "finished" },
        ) => void)
      | undefined;
    m.onUpdaterEvent.mockImplementation(async (next) => {
      handler = next;
      return off;
    });

    const view = render(<App />);
    await waitFor(() => expect(handler).toBeTypeOf("function"));

    act(() => handler?.({ kind: "progress", downloaded: 4, total: 10 }));
    expect(useStore.getState().update.progress).toBe(40);
    act(() => handler?.({ kind: "finished" }));
    expect(useStore.getState().update).toMatchObject({ phase: "ready", progress: 100 });

    view.unmount();
    expect(off).toHaveBeenCalledOnce();
  });

  it("drops a native updater listener that resolves after unmount", async () => {
    m.isTauri.mockReturnValue(true);
    const off = vi.fn();
    let resolveListener!: (off: () => void) => void;
    m.onUpdaterEvent.mockReturnValue(
      new Promise((resolve) => {
        resolveListener = resolve;
      }),
    );

    const view = render(<App />);
    await waitFor(() => expect(m.onUpdaterEvent).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => resolveListener(off));

    expect(off).toHaveBeenCalledOnce();
  });

  it("keeps a background update-check failure out of the workspace chrome", async () => {
    m.isTauri.mockReturnValue(true);
    m.checkForUpdate.mockRejectedValue(new Error("offline"));

    render(<App />);

    await waitFor(() => expect(useStore.getState().update.error).toBe("offline"));
    expect(useStore.getState().update.phase).toBe("idle");
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
  });

  it("keeps self-dev builds isolated from the production updater", async () => {
    vi.stubEnv("VITE_PORTCODE_CHANNEL", "dev");
    m.isTauri.mockReturnValue(true);

    render(<App />);
    await waitFor(() => expect(useStore.getState().pendingSession).not.toBeNull());

    expect(m.onUpdaterEvent).not.toHaveBeenCalled();
    expect(m.getUpdateChannel).not.toHaveBeenCalled();
    expect(m.checkForUpdate).not.toHaveBeenCalled();
  });

  it("runs init() on mount: opens a pending new chat and renders the core shell", async () => {
    render(<App />);

    // The real init() resolves through the mocked IPC and, with no existing
    // sessions, creates exactly one.
    await waitFor(() => {
      expect(useStore.getState().pendingSession).not.toBeNull();
    });
    expect(useStore.getState().sessions).toEqual([]);
    expect(m.createSession).not.toHaveBeenCalled();

    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("chat")).toBeInTheDocument();
    // CommandPalette is always mounted (it self-gates on showPalette internally).
    expect(screen.getByTestId("command-palette")).toBeInTheDocument();
  });

  it("routes the environment dock into Chat without resizing the shell", () => {
    render(<App />);

    const chat = screen.getByTestId("chat");
    const trigger = screen.getByRole("button", { name: "Environment and agents" });

    expect(chat).toHaveAttribute("data-transcript-aside-open", "false");
    expect(chat).toContainElement(screen.getByTestId("environment-panel"));
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);

    expect(chat).toHaveAttribute("data-transcript-aside-open", "true");
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Close environment" }));
    expect(chat).toHaveAttribute("data-transcript-aside-open", "false");
  });

  it("routes the center surface to Review and collapses the unrelated file rail", () => {
    useStore.setState({ workspaceSurface: "review", showFiles: true });
    render(<App />);

    expect(screen.getByTestId("review-surface")).toBeVisible();
    expect(screen.getByTestId("review-workspace")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("chat-surface")).not.toBeVisible();
    expect(screen.getByTestId("chat-surface")).toHaveAttribute("inert");
    expect(screen.getByTestId("file-rail")).toHaveStyle({ gridTemplateColumns: "0fr" });
    expect(screen.getByTestId("file-rail")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Review changes")).toBeInTheDocument();
    const fileToggle = screen.getByRole("button", { name: "Toggle file explorer (Ctrl+B)" });
    expect(fileToggle).toHaveAttribute("aria-pressed", "false");
    expect(useStore.getState().showFiles).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(useStore.getState().workspaceSurface).toBe("chat");
    expect(screen.getByTestId("chat-surface")).toBeVisible();
    expect(screen.getByTestId("review-surface")).not.toBeVisible();
    expect(screen.getByTestId("review-surface")).toHaveAttribute("inert");
    expect(screen.getByTestId("review-workspace")).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("file-rail")).toHaveStyle({ gridTemplateColumns: "1fr" });
    expect(screen.getByTestId("file-rail")).not.toHaveAttribute("aria-hidden");
    expect(fileToggle).toHaveAttribute("aria-pressed", "true");
    expect(useStore.getState().showFiles).toBe(true);
  });

  it("routes the center surface to Marketplace while keeping chat and review inert", () => {
    useStore.setState({ workspaceSurface: "marketplace", showFiles: true });
    render(<App />);

    expect(screen.getByTestId("marketplace-surface")).toBeVisible();
    expect(screen.getByTestId("codex-marketplace")).toBeVisible();
    expect(screen.getByTestId("chat-surface")).not.toBeVisible();
    expect(screen.getByTestId("chat-surface")).toHaveAttribute("inert");
    expect(screen.getByTestId("review-surface")).not.toBeVisible();
    expect(screen.getByTestId("review-surface")).toHaveAttribute("inert");
    expect(screen.getByTestId("file-rail")).toHaveStyle({ gridTemplateColumns: "0fr" });
    expect(screen.getByText("Plugin marketplace")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(useStore.getState().workspaceSurface).toBe("chat");
    expect(screen.getByTestId("chat-surface")).toBeVisible();
    expect(screen.getByTestId("marketplace-surface")).not.toBeVisible();
    expect(screen.getByTestId("marketplace-surface")).toHaveAttribute("inert");
  });

  it("preserves review controller state when leaving and reopening the surface", () => {
    useStore.setState({ workspaceSurface: "review" });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Change review controller state" }));
    expect(screen.getByRole("status", { name: "Review controller state" })).toHaveTextContent(
      "preserved",
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.getByTestId("review-surface")).not.toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Open review workspace" }));
    expect(screen.getByTestId("review-surface")).toBeVisible();
    expect(screen.getByRole("status", { name: "Review controller state" })).toHaveTextContent(
      "preserved",
    );
  });

  it("opens the title-bar Review action on the live workspace instead of a stale turn target", () => {
    useStore.setState({
      workspaceSurface: "chat",
      reviewTarget: { kind: "turn", turnId: "turn-old" },
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open review workspace" }));

    expect(useStore.getState().workspaceSurface).toBe("review");
    expect(useStore.getState().reviewTarget).toEqual({ kind: "workspace" });
  });

  it("releases the remote frame subscription when the app unmounts", async () => {
    const unlisten = vi.fn();
    const { unmount } = render(<App />);
    // Let init() settle so its async setState can't race the teardown assertion.
    await waitFor(() => expect(useStore.getState().pendingSession).not.toBeNull());
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
  it("renders the desktop layout (no remote screens) when remoteMode is off", () => {
    useStore.setState({ remoteMode: false });

    render(<App />);

    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.queryByTestId("remote-pairing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("remote-sessions")).not.toBeInTheDocument();
  });

  it("shows the pairing screen (and hides the desktop layout) when not connected", () => {
    useStore.setState({ remoteMode: true, remoteConnected: false, remoteVerified: false });

    render(<App />);

    expect(screen.getByTestId("remote-pairing")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
  });

  it("keeps showing the pairing screen while connected but not yet SAS-verified", () => {
    // The SAS gate: a live connection alone isn't enough to reveal the sessions.
    useStore.setState({ remoteMode: true, remoteConnected: true, remoteVerified: false });

    render(<App />);

    expect(screen.getByTestId("remote-pairing")).toBeInTheDocument();
    expect(screen.queryByTestId("remote-sessions")).not.toBeInTheDocument();
  });

  it("shows the sessions list once verified, before a session is opened", () => {
    useStore.setState({
      remoteMode: true,
      remoteConnected: true,
      remoteVerified: true,
      remoteChatOpen: false,
    });

    render(<App />);

    expect(screen.getByTestId("remote-sessions")).toBeInTheDocument();
    expect(screen.queryByTestId("remote-pairing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("remote-chat-header")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat")).not.toBeInTheDocument();
    // No desktop chrome on the phone (the inline session rail is desktop-only).
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
  });

  it("opens the chat view (header + chat) when a session is open", () => {
    useStore.setState({
      remoteMode: true,
      remoteConnected: true,
      remoteVerified: true,
      remoteChatOpen: true,
    });

    render(<App />);

    expect(screen.getByTestId("remote-chat-header")).toBeInTheDocument();
    expect(screen.getByTestId("chat")).toBeInTheDocument();
    expect(screen.queryByTestId("remote-sessions")).not.toBeInTheDocument();
    // The desktop command-palette button is a keyboard affordance — gone on the phone.
    expect(
      screen.queryByRole("button", { name: "Open command palette (Ctrl+K)" }),
    ).not.toBeInTheDocument();
  });

  it("shows the disconnected screen when the link dropped", () => {
    useStore.setState({ remoteMode: true, remoteDropped: true });

    render(<App />);

    expect(screen.getByTestId("disconnected-state")).toBeInTheDocument();
    expect(screen.queryByTestId("remote-pairing")).not.toBeInTheDocument();
  });

  it("shows the offline screen, taking precedence over a drop, when the device is offline", () => {
    useStore.setState({ remoteMode: true, remoteDropped: true, online: false });

    render(<App />);

    expect(screen.getByTestId("offline-state")).toBeInTheDocument();
    expect(screen.queryByTestId("disconnected-state")).not.toBeInTheDocument();
  });

  it("gates pairing behind the install screen in web-client mode on uninstalled iOS", () => {
    m.isWebClientMode.mockReturnValue(true);
    vi.mocked(getInstallState).mockReturnValue({
      installed: false,
      ios: true,
      canPair: false,
      reason: "needs-install",
      guidance: "install me",
    });
    useStore.setState({ remoteMode: true, remoteConnected: false, remoteVerified: false });

    render(<App />);

    expect(screen.getByTestId("install-gate")).toBeInTheDocument();
    expect(screen.queryByTestId("remote-pairing")).not.toBeInTheDocument();
  });

  it("does NOT gate when not in web-client mode (native path), even on iOS", () => {
    // Native/Tauri path: the install gate must never intercept the desktop/mobile
    // app, no matter what the install sniff would say.
    m.isWebClientMode.mockReturnValue(false);
    vi.mocked(getInstallState).mockReturnValue({
      installed: false,
      ios: true,
      canPair: false,
      reason: "needs-install",
      guidance: "install me",
    });
    useStore.setState({ remoteMode: true, remoteConnected: false, remoteVerified: false });

    render(<App />);

    expect(screen.queryByTestId("install-gate")).not.toBeInTheDocument();
    expect(screen.getByTestId("remote-pairing")).toBeInTheDocument();
  });

  it("proceeds to pairing in web-client mode when install state is ok (installed iOS)", () => {
    m.isWebClientMode.mockReturnValue(true);
    vi.mocked(getInstallState).mockReturnValue({
      installed: true,
      ios: true,
      canPair: true,
      reason: "ok",
      guidance: "",
    });
    useStore.setState({ remoteMode: true, remoteConnected: false, remoteVerified: false });

    render(<App />);

    expect(screen.queryByTestId("install-gate")).not.toBeInTheDocument();
    expect(screen.getByTestId("remote-pairing")).toBeInTheDocument();
  });

  it("proceeds to pairing in web-client mode on a non-iOS browser (not-ios-ok)", () => {
    m.isWebClientMode.mockReturnValue(true); // reason defaults to "not-ios-ok"
    useStore.setState({ remoteMode: true, remoteConnected: false, remoteVerified: false });

    render(<App />);

    expect(screen.queryByTestId("install-gate")).not.toBeInTheDocument();
    expect(screen.getByTestId("remote-pairing")).toBeInTheDocument();
  });

  it("recovers from the offline screen when the network returns", () => {
    useStore.setState({
      remoteMode: true,
      remoteConnected: true,
      remoteVerified: true,
      remoteChatOpen: true,
      online: false,
    });

    render(<App />);
    expect(screen.getByTestId("offline-state")).toBeInTheDocument();

    // App's online/offline listener re-reads navigator.onLine (true in jsdom) on the
    // browser 'online' event, flipping the store flag and revealing the chat again.
    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect(screen.queryByTestId("offline-state")).not.toBeInTheDocument();
    expect(screen.getByTestId("remote-chat-header")).toBeInTheDocument();
  });
});

describe("TitleBar", () => {
  it("mounts the compact environment overview in the desktop title bar", () => {
    render(<App />);

    expect(screen.getByTestId("environment-panel")).toBeInTheDocument();
  });

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

  it("shows the active ChatGPT account label without exposing its local profile id", async () => {
    const accountProfileId = "00000000-0000-4000-8000-000000000001";
    const activeSession = {
      id: "openai-session",
      title: "OpenAI work",
      workspace: null,
      branch: null,
      model: "gpt-5.6-sol",
      accountProfileId,
      createdAt: 1,
      updatedAt: 1,
    };
    const account = {
      id: accountProfileId,
      accountLabel: "one@chatgpt.test",
      tier: "ChatGPT Plus",
      expiresAt: null,
      state: "connected" as const,
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
    };
    m.listSessions.mockResolvedValue([activeSession]);
    m.listOpenAIAccounts.mockResolvedValue([account]);
    useStore.setState({
      sessions: [activeSession],
      activeId: activeSession.id,
      openAIAccounts: [account],
    });

    const { container } = render(<App />);

    expect((await screen.findAllByText("one@chatgpt.test")).length).toBeGreaterThan(0);
    expect(container).toHaveTextContent("one@chatgpt.test");
    expect(container).not.toHaveTextContent(accountProfileId);
    const titlebarAccount = screen.getByRole("banner").querySelector(".pc-titlebar__account-pill");
    expect(titlebarAccount).toHaveAttribute("title", "Codex authentication: one@chatgpt.test");
    expect(titlebarAccount?.querySelector(".pc-titlebar__account-label")).toHaveTextContent(
      "one@chatgpt.test",
    );
  });

  it.each(["ready", "absent", "loading", "error"] as const)(
    "shows the pinned account pill for a catalog-only model when its catalog is %s",
    (catalogState) => {
      const accountProfileId = "00000000-0000-4000-8000-000000000002";
      const accountModel = {
        id: "account-exclusive-model",
        label: "Account exclusive model",
        provider: "openai" as const,
        reasoningEfforts: ["medium" as const],
        defaultReasoningEffort: "medium" as const,
      };
      const activeSession = {
        id: "catalog-only-openai-session",
        title: "Catalog-only OpenAI work",
        workspace: null,
        branch: null,
        model: accountModel.id,
        accountProfileId,
        createdAt: 1,
        updatedAt: 1,
      };
      const account = {
        id: accountProfileId,
        accountLabel: "catalog@chatgpt.test",
        tier: "ChatGPT Plus",
        expiresAt: null,
        state: "connected" as const,
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
      };
      m.listSessions.mockResolvedValue([activeSession]);
      m.listOpenAIAccounts.mockResolvedValue([account]);
      m.openaiModels.mockResolvedValue([accountModel]);
      const openAIModelCatalogs: Record<string, OpenAIModelCatalogState> =
        catalogState === "absent"
          ? {}
          : {
              [accountProfileId]:
                catalogState === "ready"
                  ? { status: "ready" as const, models: [accountModel], error: null }
                  : catalogState === "loading"
                    ? { status: "loading" as const, models: [], error: null }
                    : { status: "error" as const, models: [], error: "catalog unavailable" },
            };
      useStore.setState({
        sessions: [activeSession],
        activeId: activeSession.id,
        openAIAccounts: [account],
        openAIModels: [accountModel],
        openAIModelCatalogs,
      });

      render(<App />);

      expect(screen.getByRole("banner")).toHaveTextContent("catalog@chatgpt.test");
    },
  );

  it("uses a safe tombstone badge when the active ChatGPT profile is gone", async () => {
    const accountProfileId = "00000000-0000-4000-8000-000000000099";
    const activeSession = {
      id: "removed-account-session",
      title: "Old OpenAI work",
      workspace: null,
      branch: null,
      model: "gpt-5.6-sol",
      accountProfileId,
      createdAt: 1,
      updatedAt: 1,
    };
    m.listSessions.mockResolvedValue([activeSession]);
    m.listOpenAIAccounts.mockResolvedValue([]);
    useStore.setState({ sessions: [activeSession], activeId: activeSession.id });

    const { container } = render(<App />);

    await waitFor(() => expect(screen.getByRole("banner")).toHaveTextContent("ACCOUNT REMOVED"));
    expect(container).not.toHaveTextContent(accountProfileId);
  });

  it("does not call a pinned ChatGPT profile removed while account discovery is unavailable", async () => {
    const accountProfileId = "00000000-0000-4000-8000-000000000098";
    const activeSession = {
      id: "unavailable-account-session",
      title: "Pinned OpenAI work",
      workspace: null,
      branch: null,
      model: "gpt-5.6-sol",
      accountProfileId,
      createdAt: 1,
      updatedAt: 1,
    };
    m.listSessions.mockResolvedValue([activeSession]);
    m.listOpenAIAccounts.mockRejectedValue(new Error("credential registry is locked"));
    useStore.setState({
      sessions: [activeSession],
      activeId: activeSession.id,
      openAIAccounts: [],
      openAIAccountsError: "credential registry is locked",
    });

    const { container } = render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("banner")).toHaveTextContent("ACCOUNT UNAVAILABLE"),
    );
    expect(screen.getByRole("banner")).not.toHaveTextContent("ACCOUNT REMOVED");
    expect(container).not.toHaveTextContent(accountProfileId);
  });

  it("shows the active session title in the title-bar breadcrumb (not as a competing heading)", () => {
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

    // The breadcrumb shows the title as plain text. It is deliberately NOT a
    // heading, so it never competes with Chat's single empty-state/error <h1>.
    expect(screen.getByText("Refactor the parser")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Refactor the parser" })).not.toBeInTheDocument();
  });

  it("renders the preview-mode badge outside Tauri", () => {
    m.isTauri.mockReturnValue(false);

    render(<App />);

    expect(screen.getByText("PREVIEW MODE")).toBeInTheDocument();
    expect(screen.queryByTestId("window-drag-rail")).not.toBeInTheDocument();
  });

  it("hides the preview-mode badge when running inside Tauri", () => {
    m.isTauri.mockReturnValue(true);

    render(<App />);

    expect(screen.queryByText("PREVIEW MODE")).not.toBeInTheDocument();
  });

  it("uses inline Portcode window controls in the desktop title bar", () => {
    m.isTauri.mockReturnValue(true);

    render(<App />);

    expect(screen.getByRole("button", { name: "Minimize window" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize or restore window" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close window" })).toBeInTheDocument();
  });

  it("runs inline window controls and makes the non-interactive title bar draggable", () => {
    m.isTauri.mockReturnValue(true);
    const nativeWindow = {
      minimize: vi.fn().mockResolvedValue(undefined),
      toggleMaximize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    currentWindow.mockReturnValue(nativeWindow as never);

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize or restore window" }));
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));

    expect(nativeWindow.minimize).toHaveBeenCalledOnce();
    expect(nativeWindow.toggleMaximize).toHaveBeenCalledOnce();
    expect(nativeWindow.close).toHaveBeenCalledOnce();
    expect(screen.getByTestId("window-drag-rail")).toHaveClass("pc-window-drag-rail");
    expect(screen.getByTestId("window-drag-rail")).toHaveAttribute(
      "data-tauri-drag-region",
      "deep",
    );
    expect(screen.getByText("New chat").closest("header")).toHaveAttribute(
      "data-tauri-drag-region",
      "deep",
    );
    expect(screen.getByRole("button", { name: "Minimize window" })).toHaveAttribute(
      "data-tauri-drag-region",
      "false",
    );
  });

  it("keeps desktop window controls out of the browser preview", () => {
    m.isTauri.mockReturnValue(false);

    render(<App />);

    expect(screen.queryByRole("button", { name: "Minimize window" })).not.toBeInTheDocument();
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

    const palette = screen.getByRole("button", { name: "Open command palette (Ctrl+K)" });
    expect(palette).toBeInTheDocument();
    expect(palette).toHaveTextContent("Ctrl K palette");
    expect(palette).not.toHaveTextContent("⌘");
    fireEvent.click(palette);
    expect(useStore.getState().showPalette).toBe(true);
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
    await waitFor(() => expect(useStore.getState().pendingSession).not.toBeNull());
    const firstId = useStore.getState().activeId;

    fireEvent.keyDown(window, { key: "n", metaKey: true });

    await waitFor(() => expect(useStore.getState().activeId).not.toBe(firstId));
    expect(useStore.getState().sessions).toEqual([]);
    expect(m.createSession).not.toHaveBeenCalled();
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

  it("rescues focus when Review hides an otherwise-open file rail", () => {
    useStore.setState({ showFiles: true, workspaceSurface: "chat" });
    render(<App />);
    const toggle = screen.getByRole("button", { name: "Toggle file explorer (Ctrl+B)" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    act(() => (document.body as HTMLElement).focus());
    expect(document.activeElement).toBe(document.body);
    act(() => useStore.setState({ workspaceSurface: "review" }));

    expect(useStore.getState().showFiles).toBe(true);
    expect(screen.getByTestId("file-rail")).toHaveAttribute("inert");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveFocus();
  });

  it("Ctrl+N resolves the guarded OpenAI default to its preferred account", async () => {
    const accountProfileId = "00000000-0000-4000-8000-000000000001";
    const model = {
      id: "gpt-live",
      label: "GPT Live",
      provider: "openai" as const,
      reasoningEfforts: ["high" as const],
      defaultReasoningEffort: "high" as const,
    };
    useStore.setState({
      init: vi.fn(async () => {}),
      sessions: [],
      activeId: null,
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: model.id },
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
      },
      openAIAccounts: [
        {
          id: accountProfileId,
          accountLabel: "one@chatgpt.test",
          tier: "ChatGPT Plus",
          expiresAt: null,
          state: "connected",
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        },
      ],
      openAIModelCatalogs: {
        [accountProfileId]: { status: "ready", models: [model], error: null },
      },
      openAIModels: [model],
      lastOpenAIAccountProfileId: accountProfileId,
    });
    render(<App />);

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });

    await waitFor(() =>
      expect(useStore.getState().pendingSession).toMatchObject({
        model: model.id,
        accountProfileId,
      }),
    );
    expect(m.createSession).not.toHaveBeenCalled();
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
