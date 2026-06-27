import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { isTauri } from "../lib/ipc";
import { useStore } from "../store/store";
import type { Session } from "../types";

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const newSession = useStore((s) => s.newSession);
  const selectSession = useStore((s) => s.selectSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const renameSession = useStore((s) => s.renameSession);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const settings = useStore((s) => s.settings);
  const oauthStatus = useStore((s) => s.oauthStatus);
  const streaming = useStore((s) => s.streaming);
  const remoteConnected = useStore((s) => s.remoteConnected);

  // Inline rename state. A row enters edit mode (the title becomes an input) via
  // its pencil button or a double-click; Enter / blur commits, Escape cancels.
  // Rename is a desktop-local DB write, so the affordance is offered only when not
  // streaming and not driving a remote desktop (which has no rename command).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const canRename = !streaming && !remoteConnected;
  // Synchronous "which row owns the editor" mirror, cleared the INSTANT the editor
  // closes. The input fires a trailing blur as it unmounts after Enter/Escape;
  // gating the close on this ref makes that stray blur a no-op instead of a second
  // (or, after Escape, an unwanted) commit.
  const editingRef = useRef<string | null>(null);
  // The row to refocus once the editor unmounts (set at close, consumed by the
  // effect) — otherwise commit/cancel drops focus to <body> and keyboard users
  // lose their place in the list.
  const refocusRef = useRef<string | null>(null);

  const beginEdit = (s: Session) => {
    if (!canRename) return;
    editingRef.current = s.id;
    setEditingId(s.id);
    setDraft(s.title);
  };
  // Close the editor exactly once (the ref guard absorbs the unmount blur),
  // optionally committing the draft, and queue focus back to the edited row.
  const closeEditor = (commit: boolean) => {
    const id = editingRef.current;
    if (id === null) return; // already closed → ignore a trailing blur
    editingRef.current = null;
    refocusRef.current = id;
    if (commit) void renameSession(id, draft);
    setEditingId(null);
  };
  const commitEdit = () => closeEditor(true);
  const cancelEdit = () => closeEditor(false);

  // When the editor closes, return focus to the edited row's select button (the
  // input has unmounted by now, so this runs post-render). Keyed on editingId so it
  // fires exactly on the edit→view transition.
  useEffect(() => {
    if (editingId !== null || refocusRef.current === null) return;
    const idx = sessions.findIndex((s) => s.id === refocusRef.current);
    refocusRef.current = null;
    if (idx >= 0) rowRefs.current[idx]?.focus();
  }, [editingId, sessions]);
  const onEditKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
    // Don't let arrow/Home/End bubble to the list's roving-nav while editing.
    e.stopPropagation();
  };

  const signedInClaude = !!oauthStatus?.signedIn;
  const authed = signedInClaude || settings.apiKeySet;
  const authTitle = signedInClaude
    ? "Signed in with Claude"
    : settings.apiKeySet
      ? "API key set"
      : "Not authenticated";

  // Roving-tabindex stops for arrow-key navigation through the session list: each
  // select button registers itself here so the nav handler can move focus.
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Up/Down/Home/End move selection through the session list and follow focus to
  // the newly active row. No-ops while a turn is streaming (selectSession is
  // disabled then) or when there are no sessions.
  const onListKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (streaming || sessions.length === 0) return;
    const current = sessions.findIndex((s) => s.id === activeId);
    const from = current === -1 ? 0 : current;
    let next: number;
    switch (e.key) {
      case "ArrowDown":
        next = Math.min(from + 1, sessions.length - 1);
        break;
      case "ArrowUp":
        next = Math.max(from - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = sessions.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    void selectSession(sessions[next].id);
    rowRefs.current[next]?.focus();
  };

  return (
    <aside
      aria-label="Sessions"
      className="flex h-full w-[248px] shrink-0 flex-col border-r border-border bg-panel"
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-accent/60 bg-gradient-to-br from-accent/30 to-accent-2/25 shadow-[0_0_14px_rgba(255,46,126,0.4)]">
          <Logo />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="pc-wordmark pc-wordmark--glitch">PORTCODE</span>
          <span className="pc-eyebrow-mono text-[8.5px]">PORTHEX · v0.3.1-α</span>
        </div>
      </div>

      {/* New session */}
      <div className="px-3 pb-2">
        <button
          onClick={newSession}
          disabled={streaming}
          title={streaming ? "Finish or stop the current turn first" : undefined}
          className={`pc-newsession ${streaming ? "cursor-not-allowed opacity-50" : ""}`}
        >
          <span className="text-[15px] leading-none">+</span>
          NEW SESSION
        </button>
      </div>

      {/* Sessions label */}
      <div className="px-4 pb-2 pt-1">
        <span className="font-mono text-[9.5px] uppercase tracking-[2px] text-faint">Sessions</span>
      </div>

      {/* Session rows */}
      <nav
        aria-label="Session list"
        onKeyDown={onListKeyDown}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2"
      >
        {sessions.map((s, i) => {
          const active = s.id === activeId;
          return (
            <div
              key={s.id}
              className={
                active
                  ? "group rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 shadow-[inset_0_0_14px_rgba(255,46,126,0.12)] transition-[background-color,border-color,box-shadow,color] duration-150 ease-out motion-reduce:transition-none"
                  : "pc-row group rounded-lg px-3 py-2"
              }
            >
              <div className="flex items-center">
                {editingId === s.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onEditKeyDown}
                    onBlur={commitEdit}
                    aria-label={`Rename session: ${s.title}`}
                    className="min-w-0 flex-1 rounded border border-accent/40 bg-panel-2 px-2 py-1 text-[13px] text-fg outline-none focus:border-accent"
                  />
                ) : (
                  <>
                    <button
                      ref={(el) => {
                        rowRefs.current[i] = el;
                      }}
                      onClick={() => selectSession(s.id)}
                      onDoubleClick={() => beginEdit(s)}
                      disabled={streaming}
                      tabIndex={active ? 0 : -1}
                      aria-current={active ? "true" : undefined}
                      className={`flex min-w-0 flex-1 flex-col text-left ${
                        streaming ? "cursor-not-allowed" : ""
                      }`}
                      title={streaming ? "Finish or stop the current turn first" : s.title}
                    >
                      <span className="relative flex items-center">
                        {active && (
                          <span
                            className="pc-dot pc-dot--accent absolute left-[3px] top-1/2 -translate-y-1/2"
                            aria-hidden="true"
                          />
                        )}
                        <span
                          className={`truncate pl-3 text-[13px] ${active ? "text-fg" : "text-muted"}`}
                        >
                          {s.title}
                        </span>
                      </span>
                      <span
                        className={`truncate pl-3 font-mono text-[9.5px] ${
                          active ? "text-muted" : "text-faint"
                        }`}
                      >
                        <span aria-hidden="true">⎇</span> {workspaceLabel(s.workspace)} ·{" "}
                        {relativeTime(s.updatedAt)}
                      </span>
                    </button>
                    {canRename && (
                      <button
                        onClick={() => beginEdit(s)}
                        tabIndex={active ? 0 : -1}
                        className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint opacity-0 transition-opacity hover:bg-accent/10 hover:text-accent group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
                        aria-label={`Rename session: ${s.title}`}
                        title="Rename session"
                      >
                        ✎
                      </button>
                    )}
                    <button
                      onClick={() => deleteSession(s.id)}
                      disabled={streaming}
                      tabIndex={active ? 0 : -1}
                      className={`ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none ${
                        streaming ? "cursor-not-allowed opacity-50" : ""
                      }`}
                      aria-label={`Delete session: ${s.title}`}
                      title={streaming ? "Finish or stop the current turn first" : "Delete session"}
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-border p-3">
        <button
          onClick={() => setShowSettings(true)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted transition-colors hover:bg-panel-2 hover:text-fg"
        >
          <GearIcon />
          Settings
          {authed && (
            <span className="ml-auto flex items-center gap-1.5" title={authTitle}>
              <span className="font-mono text-[9px] tracking-wide text-success">
                {signedInClaude ? "CLAUDE" : "KEY SET"}
              </span>
              <span className="pc-dot pc-dot--ring" aria-hidden="true" />
            </span>
          )}
        </button>
        {/* Footer chrome — honest labels derived from real state, never fabricated
            telemetry: the live session count, the backend stack identity, and
            whether the native Rust core is attached vs the browser preview mock. */}
        <div className="mt-2 flex justify-between px-2 font-mono text-[9px] tracking-wide text-faint">
          <span>
            <span aria-hidden="true">◴</span>{" "}
            {sessions.length === 1 ? "1 SESSION" : `${sessions.length} SESSIONS`}
          </span>
          <span>RUST · TOKIO</span>
          <span>
            <span aria-hidden="true">◉</span> {isTauri() ? "CORE" : "PREVIEW"}
          </span>
        </div>
      </div>
    </aside>
  );
}

/** Basename of a workspace path, or "local" when none is set. */
function workspaceLabel(workspace: Session["workspace"]): string {
  if (!workspace) return "local";
  const parts = workspace.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "local";
}

/** Compact relative time from an epoch-ms timestamp: now / Nh / yest / Nd. */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "now";
  const hr = Math.floor(min / 60);
  if (hr < 1) return `${min}m`;
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yest";
  return `${day}d`;
}

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 9l3 3-3 3M13 15h4"
        stroke="var(--color-accent-hi)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
