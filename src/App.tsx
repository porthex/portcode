import { useEffect, useRef } from "react";
import { useStore } from "./store/store";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { FileExplorer } from "./components/FileExplorer";
import { SettingsPanel } from "./components/Settings";
import { CommandPalette } from "./components/CommandPalette";
import { StatusHud } from "./components/StatusHud";
import { NeonRain } from "./components/NeonRain";
import { RemotePairing } from "./components/RemotePairing";
import { isTauri } from "./lib/ipc";

export default function App() {
  const init = useStore((s) => s.init);
  const showSettings = useStore((s) => s.showSettings);
  const showFiles = useStore((s) => s.showFiles);
  const showSidebar = useStore((s) => s.showSidebar);
  const ambientRain = useStore((s) => s.ambientRain);
  const scanlines = useStore((s) => s.scanlines);
  const remoteMode = useStore((s) => s.remoteMode);
  const remoteConnected = useStore((s) => s.remoteConnected);
  const remoteVerified = useStore((s) => s.remoteVerified);
  const remoteDropped = useStore((s) => s.remoteDropped);

  useEffect(() => {
    void init();
  }, [init]);

  // Release the live remote frame subscription if the app tree unmounts (HMR, a
  // root remount) so a stale native listener can't survive into a new store
  // instance and double-feed applyFrame.
  useEffect(() => () => useStore.getState().remoteUnlisten?.(), []);

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

  // Remote mode (the phone, or any client that opted in): until a desktop session
  // is connected AND its SAS verified, the pairing screen takes over the shell.
  const remoteGate = remoteMode && !(remoteConnected && remoteVerified);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-bg text-fg">
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
          {remoteDropped ? "Connection to desktop lost. Reconnect available." : ""}
        </span>
      )}

      {remoteGate ? (
        <RemotePairing />
      ) : (
        <>
          {remoteMode && <RemoteBanner />}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* Desktop: the session list is an inline rail. On the phone that rail
                would eat the narrow viewport, so there it becomes a drawer (below)
                and the chat takes the full width. */}
            {!remoteMode && <Sidebar />}
            {/* The file rail stays mounted and animates its inline width (0fr<->1fr
                grid accordion, the same pattern ToolCall uses on rows) so toggling
                it slides instead of jumping the main column sideways. The inner
                overflow-hidden clips the 236px-wide content to zero; reduced-motion
                users get the instant swap they had before. Collapsed, the rail is
                inert + aria-hidden so its tree stays out of the tab order and AT. */}
            {!remoteMode && (
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
            )}
            <main className="flex min-w-0 flex-1 flex-col">
              <TitleBar />
              <Chat />
            </main>
          </div>

          {remoteMode && showSidebar && <SidebarDrawer />}

          <StatusHud />

          {showSettings && <SettingsPanel />}
          <CommandPalette />
        </>
      )}
    </div>
  );
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** The session list as a slide-in overlay — the phone's equivalent of the
 *  desktop's inline sidebar rail. Tapping the backdrop closes it; selecting or
 *  creating a session closes it too (handled in the store). Behaves as a modal
 *  dialog: focus moves in on open, Tab is trapped, and focus returns to the
 *  opener on close. */
function SidebarDrawer() {
  const setShowSidebar = useStore((s) => s.setShowSidebar);
  const drawerRef = useRef<HTMLDivElement>(null);
  // Escape closes the drawer (the App keydown effect only handles modified keys,
  // so plain Escape would otherwise strand focus inside the overlay).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowSidebar(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setShowSidebar]);
  // Treat the drawer as a modal dialog: move focus into it on open (onto the
  // container, a non-input element, so the phone soft keyboard doesn't pop) and
  // restore focus to the opener (the TitleBar hamburger) on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    drawerRef.current?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);
  // Trap Tab within the drawer so it can't walk into the chat behind the backdrop.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const container = drawerRef.current;
    if (!container) return;
    const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) {
      // Nothing tabbable inside — keep focus pinned to the container.
      e.preventDefault();
      container.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === container)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      ref={drawerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Sessions"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex outline-none"
    >
      <div className="pc-drawer h-full shrink-0">
        <Sidebar />
      </div>
      <button
        type="button"
        aria-label="Close sessions"
        onClick={() => setShowSidebar(false)}
        className="h-full flex-1 bg-black/60 backdrop-blur-[1px]"
      />
    </div>
  );
}

/** A slim banner atop the remote session: shows the live link and lets the user
 *  drop it. Only rendered in remote mode once connected + verified. */
function RemoteBanner() {
  const disconnectRemote = useStore((s) => s.disconnectRemote);
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-accent-2/25 bg-accent-2/5 px-4 py-2">
      <span className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[1.5px] text-accent-2">
        <span className="pc-dot pc-dot--cyan" />
        Remote · connected
      </span>
      <button
        onClick={() => void disconnectRemote()}
        className="rounded-md border border-border-2 bg-panel-2/80 px-2.5 py-1 font-mono text-[11px] text-muted transition-colors hover:border-danger/50 hover:text-danger"
        aria-label="Disconnect from desktop"
        title="Disconnect from desktop"
      >
        Disconnect
      </button>
    </div>
  );
}

function TitleBar() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const showFiles = useStore((s) => s.showFiles);
  const toggleFiles = useStore((s) => s.toggleFiles);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setShowPalette = useStore((s) => s.setShowPalette);
  // The file explorer browses the desktop's workspace (`list_dir` is desktop-only),
  // so the phone hides the toggle.
  const remoteMode = useStore((s) => s.remoteMode);
  return (
    <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-border bg-panel/70 px-3.5 backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-2.5">
        {remoteMode && (
          <button
            onClick={toggleSidebar}
            aria-label="Toggle sessions"
            title="Sessions"
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px] border border-transparent text-muted transition-colors hover:text-accent-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 6h16M4 12h16M4 18h16"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
        <button
          onClick={toggleFiles}
          aria-label="Toggle file explorer (Ctrl+B)"
          title="Toggle file explorer (Ctrl+B)"
          className={`${remoteMode ? "hidden " : ""}flex h-[30px] w-[30px] items-center justify-center rounded-[7px] border transition-colors ${
            showFiles
              ? "border-accent-2/30 bg-accent-2/10 text-accent-2"
              : "border-transparent text-muted hover:text-accent-2"
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
        {!isTauri() && (
          <span className="pc-pill pc-pill--warn">
            <span className="pc-dot pc-dot--warn" />
            PREVIEW MODE
          </span>
        )}
        {!remoteMode && (
          <button
            onClick={() => setShowPalette(true)}
            aria-label="Open command palette (Ctrl+K)"
            title="Command palette (Ctrl+K)"
            className="flex items-center gap-1.5 rounded-md border border-border-2 bg-panel-2/80 px-2.5 py-1 font-mono text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-accent"
          >
            ⌘K <span className="text-faint">palette</span>
          </button>
        )}
      </div>
    </header>
  );
}
