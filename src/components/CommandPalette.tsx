import { useMemo, useState } from "react";
import { useStore } from "../store/store";
import { MODELS } from "../types";

interface Command {
  id: string;
  label: string;
  glyph: string;
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
  const setSessionModel = useStore((s) => s.setSessionModel);

  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const commands = useMemo<Command[]>(
    () => [
      { id: "new", label: "New chat", glyph: "+", hint: "Ctrl+N", run: () => void newSession() },
      { id: "files", label: "Toggle file explorer", glyph: "◤", hint: "Ctrl+B", run: toggleFiles },
      { id: "open", label: "Open folder…", glyph: "◈", run: () => void openWorkspace() },
      {
        id: "settings",
        label: "Open settings",
        glyph: "⚙",
        hint: "Ctrl+,",
        run: () => setShowSettings(true),
      },
      ...MODELS.map((m) => ({
        id: "model-" + m.id,
        label: `Model: ${m.label}`,
        glyph: "◉",
        run: () => void setSessionModel(m.id),
      })),
    ],
    [newSession, toggleFiles, openWorkspace, setShowSettings, setSessionModel],
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
      const n = filtered.length;
      setSel((s) => (n === 0 ? 0 : (s + 1) % n));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = filtered.length;
      setSel((s) => (n === 0 ? 0 : (s - 1 + n) % n));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(sel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="pc-overlay z-[60] items-start justify-center pt-[14vh]" onClick={close}>
      <div className="pc-palette" onClick={(e) => e.stopPropagation()}>
        <div className="pc-sweep pc-sweep--cyan" />
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <span className="font-mono text-accent">⌘</span>
          <input
            autoFocus
            aria-label="Command palette search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command…"
            className="flex-1 border-0 bg-transparent text-[14px] text-fg outline-none placeholder:text-faint select-text"
          />
          <span className="rounded border border-border-2 px-1.5 py-0.5 font-mono text-[10px] text-faint">
            ESC
          </span>
        </div>
        <div className="max-h-[340px] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <div className="px-5 py-5 text-center text-[13px] text-faint">No matching commands</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                aria-label={c.hint ? `${c.label}, ${c.hint}` : c.label}
                aria-selected={i === sel}
                onMouseEnter={() => setSel(i)}
                onClick={() => choose(i)}
                className="pc-palette-row flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-[13px] text-fg"
              >
                <span className="flex gap-2.5">
                  <span className="font-mono text-accent-2">{c.glyph}</span>
                  {c.label}
                </span>
                {c.hint && <span className="font-mono text-[10.5px] text-faint">{c.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
