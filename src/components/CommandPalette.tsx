import { useMemo, useState } from "react";
import { useStore } from "../store/store";
import { MODELS } from "../types";

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const show = useStore((s) => s.showPalette);
  const setShow = useStore((s) => s.setShowPalette);
  const newSession = useStore((s) => s.newSession);
  const toggleFiles = useStore((s) => s.toggleFiles);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const openWorkspace = useStore((s) => s.openWorkspace);
  const updateSettings = useStore((s) => s.updateSettings);

  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const commands = useMemo<Command[]>(
    () => [
      { id: "new", label: "New chat", hint: "Ctrl+N", run: () => void newSession() },
      { id: "files", label: "Toggle file explorer", hint: "Ctrl+B", run: toggleFiles },
      { id: "open", label: "Open folder…", run: () => void openWorkspace() },
      { id: "settings", label: "Open settings", hint: "Ctrl+,", run: () => setShowSettings(true) },
      ...MODELS.map((m) => ({
        id: "model-" + m.id,
        label: `Model: ${m.label}`,
        run: () => void updateSettings({ model: m.id }),
      })),
    ],
    [newSession, toggleFiles, openWorkspace, setShowSettings, updateSettings]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  if (!show) return null;

  const close = () => {
    setShow(false);
    setQuery("");
    setSel(0);
  };

  const choose = (i: number) => {
    const cmd = filtered[i];
    if (cmd) {
      cmd.run();
      close();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(sel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      onClick={close}
    >
      <div
        className="w-[560px] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Type a command…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted select-text"
        />
        <div className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted">
              No matching commands
            </div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                onMouseEnter={() => setSel(i)}
                onClick={() => choose(i)}
                className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${
                  i === sel ? "bg-accent-dim text-fg" : "text-muted"
                }`}
              >
                <span>{c.label}</span>
                {c.hint && (
                  <span className="font-mono text-[11px] text-muted">{c.hint}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
