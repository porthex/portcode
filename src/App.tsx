import { useEffect } from "react";
import { useStore } from "./store/store";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { FileExplorer } from "./components/FileExplorer";
import { SettingsPanel } from "./components/Settings";
import { CommandPalette } from "./components/CommandPalette";
import { isTauri } from "./lib/ipc";

export default function App() {
  const init = useStore((s) => s.init);
  const showSettings = useStore((s) => s.showSettings);
  const showFiles = useStore((s) => s.showFiles);

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
    <div className="flex h-full w-full overflow-hidden bg-bg text-fg">
      <Sidebar />
      {showFiles && <FileExplorer />}
      <main className="flex min-w-0 flex-1 flex-col">
        <TitleBar />
        <Chat />
      </main>
      {showSettings && <SettingsPanel />}
      <CommandPalette />
    </div>
  );
}

function TitleBar() {
  const session = useStore((s) =>
    s.sessions.find((x) => x.id === s.activeId)
  );
  const showFiles = useStore((s) => s.showFiles);
  const toggleFiles = useStore((s) => s.toggleFiles);
  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-panel px-3">
      <div className="flex items-center gap-1 truncate">
        <button
          onClick={toggleFiles}
          className={`flex h-7 w-7 items-center justify-center rounded-md text-sm transition-colors ${
            showFiles
              ? "bg-accent-dim text-accent"
              : "text-muted hover:bg-panel-2 hover:text-fg"
          }`}
          title="Toggle file explorer"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className="ml-1 truncate text-sm font-medium">
          {session?.title ?? "Portcode"}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted">
        {!isTauri() && (
          <span className="rounded bg-accent-dim px-2 py-0.5 text-accent">
            preview mode
          </span>
        )}
      </div>
    </header>
  );
}
