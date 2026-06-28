import { useEffect, useRef, useState } from "react";
import { useStore } from "./store/store";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { FileExplorer } from "./components/FileExplorer";
import { SettingsPanel } from "./components/Settings";
import { CommandPalette } from "./components/CommandPalette";
import { StatusHud } from "./components/StatusHud";
import { NeonRain } from "./components/NeonRain";
import { RemotePairing } from "./components/RemotePairing";
import { RemoteSessions } from "./components/RemoteSessions";
import { RemoteChatHeader } from "./components/RemoteChatHeader";
import { DisconnectedState, OfflineState } from "./components/RemoteEdgeStates";
import { InstallGate } from "./components/InstallGate";
import { CrashConsentPrompt } from "./components/CrashConsentPrompt";
import { ChannelBadge } from "./components/ChannelBadge";
import { isTauri, isWebClientMode } from "./lib/ipc";
import { getInstallState } from "./lib/installGate";
import { initTelemetry, shutdownTelemetry, telemetryConfigured } from "./lib/telemetry";

export default function App() {
  const init = useStore((s) => s.init);
  const showSettings = useStore((s) => s.showSettings);
  const showFiles = useStore((s) => s.showFiles);
  const ambientRain = useStore((s) => s.ambientRain);
  const scanlines = useStore((s) => s.scanlines);
  const remoteMode = useStore((s) => s.remoteMode);
  const remoteConnected = useStore((s) => s.remoteConnected);
  const remoteVerified = useStore((s) => s.remoteVerified);
  const remoteDropped = useStore((s) => s.remoteDropped);
  const remoteChatOpen = useStore((s) => s.remoteChatOpen);
  const online = useStore((s) => s.online);
  const crashReporting = useStore((s) => s.crashReporting);

  // A stable target for keyboard focus after the file rail collapses: the
  // TitleBar file-toggle button stays visible and tabbable, so it's where a
  // keyboard user who was inside the (now-inert) tree should land.
  const fileToggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void init();
  }, [init]);

  // Keep the store's `online` flag live. Remote mode shows the offline screen while
  // the device has no network; auto-recovers when the connection returns.
  useEffect(() => {
    const update = () => useStore.getState().setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Collapsing the file rail makes it inert, which blurs any focused tree row
  // and drops focus to <body> (Ctrl+B / the toggle both fire over a focused
  // <button> tree row — they're not caught by the typing guard). Mirror the
  // PermissionPrompt focus-restore: on the open->closed edge, rescue focus to
  // the still-visible toggle so the user keeps their place instead of being
  // stranded on <body>. Gated on the transition so it never grabs focus on the
  // initial collapsed mount.
  const wasFilesOpen = useRef(showFiles);
  useEffect(() => {
    if (wasFilesOpen.current && !showFiles && document.activeElement === document.body) {
      fileToggleRef.current?.focus();
    }
    wasFilesOpen.current = showFiles;
  }, [showFiles]);

  // Announce a successful remote pairing, mirroring the remoteDropped case. The
  // confirm-SAS path flips remoteVerified true and unmounts the pairing screen with
  // no spoken feedback; track the prior connected+verified value and, on the
  // false->true edge, set a transient message so the empty->message change is
  // announced by AT, then clear it. No animation, so no reduced-motion concern.
  const remoteLive = remoteConnected && remoteVerified;
  const prevRemoteLive = useRef(remoteLive);
  const [remoteConnectedMsg, setRemoteConnectedMsg] = useState("");
  useEffect(() => {
    if (remoteLive && !prevRemoteLive.current) {
      setRemoteConnectedMsg("Connected to your desktop.");
      const id = setTimeout(() => setRemoteConnectedMsg(""), 4000);
      prevRemoteLive.current = remoteLive;
      return () => clearTimeout(id);
    }
    prevRemoteLive.current = remoteLive;
  }, [remoteLive]);

  // Keep the crash-reporting SDK in sync with the consent toggle. `initTelemetry`
  // is idempotent and a no-op without consent+DSN, so this safely covers opting in
  // (start) and opting out (flush + disable).
  useEffect(() => {
    if (crashReporting === true) initTelemetry(true);
    else shutdownTelemetry();
  }, [crashReporting]);

  // Release the live remote frame subscription if the app tree unmounts (HMR, a
  // root remount) so a stale native listener can't survive into a new store
  // instance and double-feed applyFrame. The desktop's pairing-request listener
  // (device-trust gate) is torn down the same way so it can't leak across remounts.
  useEffect(
    () => () => {
      useStore.getState().remoteUnlisten?.();
      useStore.getState().pairingRequestUnlisten?.();
    },
    [],
  );

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Don't hijack keystrokes while the user is typing in a field (Settings
      // API-key input, the pairing textarea, the palette search, etc.).
      const t = e.target as HTMLElement | null;
      const inField =
        t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable === true;
      // Ctrl/Cmd+K stays live even from a field — it's the advertised palette
      // toggle (e.g. straight from the composer textarea). The other shortcuts
      // stay suppressed while typing so they don't hijack keystrokes.
      if (inField && e.key !== "k") return;
      const s = useStore.getState();
      // Don't stack shortcuts on top of an open modal. Ctrl+K stays live as the
      // advertised palette toggle, but is a no-op over Settings (no stacking).
      const modalOpen = s.showSettings || s.showPalette;
      if (e.key === "k") {
        if (s.showSettings) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        s.setShowPalette(!s.showPalette);
        return;
      } else if (e.key === "n") {
        if (modalOpen) return;
        e.preventDefault();
        void s.newSession();
      } else if (e.key === "b") {
        if (modalOpen) return;
        e.preventDefault();
        s.toggleFiles();
      } else if (e.key === ",") {
        if (modalOpen) return;
        e.preventDefault();
        s.setShowSettings(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="pc-safe-area relative flex h-full w-full flex-col overflow-hidden bg-bg text-fg">
      {/* Ambient layers — vignette always on; rain/scanlines are user-opt-in. */}
      {ambientRain && <NeonRain />}
      {scanlines && <div className="pc-scanlines" aria-hidden="true" />}
      <div className="pc-vignette" aria-hidden="true" />

      {/* Persistent live region for the remote link status. It must stay mounted
          across the connected<->pairing transition so a drop is announced as an
          empty->message change — a region that mounts with its text already set
          is never announced by screen readers. */}
      {remoteMode && (
        <span className="sr-only" role="status" aria-live="polite">
          {remoteDropped ? "Connection to desktop lost. Reconnect available." : remoteConnectedMsg}
        </span>
      )}

      {remoteMode ? (
        <RemoteShell
          online={online}
          remoteDropped={remoteDropped}
          remoteConnected={remoteConnected}
          remoteVerified={remoteVerified}
          remoteChatOpen={remoteChatOpen}
        />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <Sidebar />
            {/* The file rail stays mounted and animates its inline width (0fr<->1fr
                grid accordion, the same pattern ToolCall uses on rows) so toggling
                it slides instead of jumping the main column sideways. The inner
                overflow-hidden clips the 236px-wide content to zero; reduced-motion
                users get the instant swap they had before. Collapsed, the rail is
                inert + aria-hidden so its tree stays out of the tab order and AT. */}
            <div
              data-testid="file-rail"
              className="grid shrink-0 transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none"
              style={{ gridTemplateColumns: showFiles ? "1fr" : "0fr" }}
              aria-hidden={!showFiles || undefined}
              inert={!showFiles}
            >
              <div className="overflow-hidden">
                <FileExplorer />
              </div>
            </div>
            <main className="flex min-w-0 flex-1 flex-col">
              <TitleBar fileToggleRef={fileToggleRef} />
              <Chat />
            </main>
          </div>

          <StatusHud />

          {showSettings && <SettingsPanel />}
          <CommandPalette />
        </>
      )}

      {/* First-run crash-reporting consent — only when the choice is unmade AND
          this build can actually report (a DSN was baked in). Off-by-default: no
          choice means nothing is ever sent. */}
      {crashReporting === null && telemetryConfigured() && <CrashConsentPrompt />}
    </div>
  );
}

/** The remote (phone) shell. Walks the design flow: offline → disconnected →
 *  pair/safety → sessions list → open session (chat). The connection-state gates
 *  come from the store; pairing+safety both live inside RemotePairing. */
function RemoteShell({
  online,
  remoteDropped,
  remoteConnected,
  remoteVerified,
  remoteChatOpen,
}: {
  online: boolean;
  remoteDropped: boolean;
  remoteConnected: boolean;
  remoteVerified: boolean;
  remoteChatOpen: boolean;
}) {
  if (!online) return <OfflineState />;
  if (remoteDropped) return <DisconnectedState />;
  // Web-client (iOS PWA) install gate (§5.7): block pairing until the app is
  // installed to the Home Screen on iOS, since install is what grants push, durable
  // storage, and the correct storage partition. Only gates in web-client mode and
  // only when the reason is "needs-install" (iOS in a Safari tab); desktop/Android
  // browsers ("not-ios-ok") and an already-installed iOS PWA ("ok") fall through to
  // pairing. The Tauri/native path never enters this branch (isWebClientMode is off).
  if (isWebClientMode() && getInstallState().reason === "needs-install") return <InstallGate />;
  if (!(remoteConnected && remoteVerified)) return <RemotePairing />;
  if (!remoteChatOpen) return <RemoteSessions />;
  // Open session — the chat view. `relative` so the session switcher's scrim/sheet
  // (raised from the header) position against this view.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <RemoteChatHeader />
      <Chat />
    </div>
  );
}

function TitleBar({ fileToggleRef }: { fileToggleRef?: React.Ref<HTMLButtonElement> }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const showFiles = useStore((s) => s.showFiles);
  const toggleFiles = useStore((s) => s.toggleFiles);
  const setShowPalette = useStore((s) => s.setShowPalette);
  return (
    <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-border bg-panel/70 px-3.5 backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          ref={fileToggleRef}
          onClick={toggleFiles}
          aria-label="Toggle file explorer (Ctrl+B)"
          aria-pressed={showFiles}
          title="Toggle file explorer (Ctrl+B)"
          className={`flex h-[30px] w-[30px] items-center justify-center rounded-[7px] border transition-[background-color,border-color,box-shadow,color] duration-150 motion-reduce:transition-none ${
            showFiles
              ? "border-accent-2/50 bg-accent-2/12 text-accent-2 shadow-[0_0_14px_rgba(33,230,255,0.25)]"
              : "border-border-2 bg-panel-2/60 text-muted hover:border-accent-2/30 hover:text-accent-2"
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path
              d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className="truncate font-mono text-[12px] text-muted">
          portcode<span className="text-faint"> / </span>
          <span className="text-fg">{session?.title ?? "New chat"}</span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <ChannelBadge />
        {!isTauri() && (
          <span className="pc-pill pc-pill--warn">
            <span className="pc-dot pc-dot--warn" />
            PREVIEW MODE
          </span>
        )}
        <button
          onClick={() => setShowPalette(true)}
          aria-label="Open command palette (Ctrl+K)"
          title="Command palette (Ctrl+K)"
          className="flex items-center gap-1.5 rounded-md border border-border-2 bg-panel-2/80 px-2.5 py-1 font-mono text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-accent"
        >
          ⌘K <span className="text-faint">palette</span>
        </button>
      </div>
    </header>
  );
}
