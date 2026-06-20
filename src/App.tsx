import { useEffect } from "react";
import { useStore } from "./store/store";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { FileExplorer } from "./components/FileExplorer";
import { SettingsPanel } from "./components/Settings";
import { CommandPalette } from "./components/CommandPalette";
import { StatusHud } from "./components/StatusHud";
import { NeonRain } from "./components/NeonRain";
import { isTauri } from "./lib/ipc";

export default function App() {
  const init = useStore((s) => s.init);
  const showSettings = useStore((s) => s.showSettings);
  const showFiles = useStore((s) => s.showFiles);
  const ambientRain = useStore((s) => s.ambientRain);
  const scanlines = useStore((s) => s.scanlines);

  useEffect(() => {
    void init();
  }, [init]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const s = useStore.getState();
      if (e.key === "k") {
        e.preventDefault();
        s.setShowPalette(!s.showPalette);
      } else if (e.key === "n") {
        e.preventDefault();
        void s.newSession();
      } else if (e.key === "b") {
        e.preventDefault();
        s.toggleFiles();
      } else if (e.key === ",") {
        e.preventDefault();
        s.setShowSettings(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-bg text-fg">
      {/* Ambient layers — vignette always on; rain/scanlines are user-opt-in. */}
      {ambientRain && <NeonRain />}
      {scanlines && <div className="pc-scanlines" aria-hidden="true" />}
      <div className="pc-vignette" aria-hidden="true" />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        {showFiles && <FileExplorer />}
        <main className="flex min-w-0 flex-1 flex-col">
          <TitleBar />
          <Chat />
        </main>
      </div>

      <StatusHud />

      {showSettings && <SettingsPanel />}
      <CommandPalette />
    </div>
  );
}

function TitleBar() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const showFiles = useStore((s) => s.showFiles);
  const toggleFiles = useStore((s) => s.toggleFiles);
  const setShowPalette = useStore((s) => s.setShowPalette);
  return (
    <header className="flex h-[46px] shrink-0 items-center justify-between border-b border-border bg-panel/70 px-3.5 backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          onClick={toggleFiles}
          aria-label="Toggle file explorer (Ctrl+B)"
          title="Toggle file explorer (Ctrl+B)"
          className={`flex h-[30px] w-[30px] items-center justify-center rounded-[7px] border transition-colors ${
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
