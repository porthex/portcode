import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/store";
import { MODELS } from "../types";
import type { SearchHit } from "../types";

interface Command {
  id: string;
  label: string;
  glyph: string;
  /** Tailwind colour class for the glyph (brand semantics: magenta = you, cyan =
   *  the agent). Defaults to cyan when unset. */
  glyphClass?: string;
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
  const searchMessages = useStore((s) => s.searchMessages);
  const jumpToMessage = useStore((s) => s.jumpToMessage);
  const sessions = useStore((s) => s.sessions);

  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);

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

  // Debounced message search: a query of 2+ chars also searches past turns. The
  // store routes to the SQLite-backed command under Tauri and an in-memory fallback
  // in web/preview mode, so results show in both runtimes.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void searchMessages(q).then((res) => {
        if (!cancelled) setHits(res);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, searchMessages]);

  // Search hits become navigable rows below the command matches. Glyph colour honors
  // the brand semantics — magenta = you, cyan = the agent — and the hint names the
  // conversation the turn lives in.
  const searchItems = useMemo<Command[]>(
    () =>
      hits.map((h) => ({
        id: `hit-${h.sessionId}-${h.messageId}`,
        label: h.snippet,
        glyph: h.role === "user" ? "›" : "◇",
        glyphClass: h.role === "user" ? "text-accent" : "text-accent-2",
        hint: sessions.find((s) => s.id === h.sessionId)?.title ?? "chat",
        run: () => void jumpToMessage(h.sessionId, h.messageId),
      })),
    [hits, sessions, jumpToMessage],
  );
  // The unified, navigable list: command matches first, then jump-to-turn results.
  const items = useMemo(() => [...filtered, ...searchItems], [filtered, searchItems]);

  const selRef = useRef<HTMLButtonElement>(null);

  // Capture the opener (the ⌘K button or composer that triggered the palette) on
  // the rising edge of `show`, during render — BEFORE the search input's autoFocus
  // runs in commit and steals document.activeElement. A passive effect would
  // capture the input instead, so the restore below would no-op (the input is gone
  // by then). The restore effect refocuses it on the falling edge.
  const openerRef = useRef<HTMLElement | null>(null);
  const wasShown = useRef(false);
  if (show && !wasShown.current) openerRef.current = document.activeElement as HTMLElement | null;
  wasShown.current = show;

  // Escape closes the palette no matter where focus is — once focus leaves the
  // input (e.g. after hovering a row), the input's own keydown wouldn't fire.
  // Active only while the palette is open.
  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setShow(false);
        setQuery("");
        setSel(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, setShow]);

  // Keep the keyboard-selected row visible when arrowing past the scroll edge.
  useEffect(() => {
    selRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [sel]);

  // Restore focus to the opener on close, mirroring SettingsPanel: on the cleanup —
  // when `show` flips false — refocus the captured opener if it's still connected.
  // Otherwise focus falls to document.body and the keyboard user loses their place.
  useEffect(() => {
    if (!show) return;
    return () => {
      const opener = openerRef.current;
      if (opener && opener.isConnected) opener.focus();
    };
  }, [show]);

  if (!show) return null;

  const close = () => {
    setShow(false);
    setQuery("");
    setSel(0);
  };

  const choose = (i: number) => {
    const cmd = items[i];
    if (cmd) {
      cmd.run();
      close();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = items.length;
      setSel((s) => (n === 0 ? 0 : (s + 1) % n));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = items.length;
      setSel((s) => (n === 0 ? 0 : (s - 1 + n) % n));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(sel);
    } else if (e.key === "Tab") {
      // Trap Tab/Shift+Tab so focus can't escape to the app chrome behind the
      // scrim; the autoFocus input stays focused, where Arrow/Enter drive the list.
      e.preventDefault();
    }
    // Escape is handled at the window level (effect above) so it closes the palette
    // even when focus has moved off the input.
  };

  return (
    <div className="pc-overlay z-[60] items-start justify-center pt-[14vh]" onClick={close}>
      <div
        className="pc-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pc-sweep pc-sweep--cyan" />
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <span className="font-mono text-accent">⌘</span>
          <input
            autoFocus
            aria-label="Command palette search"
            role="combobox"
            aria-expanded={true}
            aria-controls="pc-palette-list"
            aria-haspopup="listbox"
            aria-activedescendant={items[sel] ? `pc-cmd-${items[sel].id}` : undefined}
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
        {/* Persistent polite live region: announces "No matching commands" when the
            results vanish. Always mounted so the live region exists before its text
            changes, which AT announces more reliably than a region that appears. */}
        <span role="status" aria-live="polite" className="sr-only">
          {items.length === 0 ? "No matching commands" : ""}
        </span>
        <div
          className="max-h-[min(340px,60vh)] overflow-y-auto p-1.5"
          role="listbox"
          id="pc-palette-list"
          aria-label="Commands"
        >
          {items.length === 0 ? (
            <div className="px-5 py-5 text-center text-[13px] text-faint">No matching commands</div>
          ) : (
            items.map((c, i) => (
              <button
                key={c.id}
                ref={i === sel ? selRef : null}
                role="option"
                id={`pc-cmd-${c.id}`}
                tabIndex={-1}
                aria-label={c.hint ? `${c.label}, ${c.hint}` : c.label}
                aria-selected={i === sel}
                onMouseEnter={() => setSel(i)}
                onClick={() => choose(i)}
                className="pc-palette-row flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-[13px] text-fg"
              >
                <span className="flex min-w-0 gap-2.5">
                  <span
                    className={`inline-flex w-5 shrink-0 justify-center font-mono ${c.glyphClass ?? "text-accent-2"}`}
                  >
                    {c.glyph}
                  </span>
                  <span className="truncate">{c.label}</span>
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
