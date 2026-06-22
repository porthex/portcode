import { isTauri } from "../lib/ipc";
import { useStore } from "../store/store";
import type { Session } from "../types";

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const newSession = useStore((s) => s.newSession);
  const selectSession = useStore((s) => s.selectSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const settings = useStore((s) => s.settings);
  const oauthStatus = useStore((s) => s.oauthStatus);
  const streaming = useStore((s) => s.streaming);

  const signedInClaude = !!oauthStatus?.signedIn;
  const authed = signedInClaude || settings.apiKeySet;
  const authTitle = signedInClaude
    ? "Signed in with Claude"
    : settings.apiKeySet
      ? "API key set"
      : "Not authenticated";

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-border bg-panel">
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
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2">
        {sessions.map((s) => {
          const active = s.id === activeId;
          const meta = `⎇ ${workspaceLabel(s.workspace)} · ${relativeTime(s.updatedAt)}`;
          return (
            <div
              key={s.id}
              className={
                active
                  ? "group rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 shadow-[inset_0_0_14px_rgba(255,46,126,0.12)]"
                  : "pc-row group rounded-lg px-3 py-2"
              }
            >
              <div className="flex items-center">
                <button
                  onClick={() => selectSession(s.id)}
                  disabled={streaming}
                  className={`flex min-w-0 flex-1 flex-col text-left ${
                    streaming ? "cursor-not-allowed" : ""
                  }`}
                  title={streaming ? "Finish or stop the current turn first" : s.title}
                >
                  <span className="flex items-center gap-2">
                    {active && <span className="pc-dot pc-dot--accent" />}
                    <span
                      className={`truncate text-[13px] ${active ? "text-fg" : "pl-3 text-muted"}`}
                    >
                      {s.title}
                    </span>
                  </span>
                  <span
                    className={`truncate pl-3 font-mono text-[9.5px] ${
                      active ? "text-muted" : "text-faint"
                    }`}
                  >
                    {meta}
                  </span>
                </button>
                <button
                  onClick={() => deleteSession(s.id)}
                  disabled={streaming}
                  className={`ml-1 hidden h-6 w-6 shrink-0 items-center justify-center rounded text-faint hover:text-danger group-hover:flex ${
                    streaming ? "cursor-not-allowed opacity-50" : ""
                  }`}
                  aria-label={`Delete session: ${s.title}`}
                  title={streaming ? "Finish or stop the current turn first" : "Delete session"}
                >
                  ✕
                </button>
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
              <span className="pc-dot pc-dot--ring" />
            </span>
          )}
        </button>
        {/* Footer chrome — honest labels derived from real state, never fabricated
            telemetry: the live session count, the backend stack identity, and
            whether the native Rust core is attached vs the browser preview mock. */}
        <div className="mt-2 flex justify-between px-2 font-mono text-[9px] tracking-wide text-faint">
          <span>◴ {sessions.length === 1 ? "1 SESSION" : `${sessions.length} SESSIONS`}</span>
          <span>RUST · TOKIO</span>
          <span>◉ {isTauri() ? "CORE" : "PREVIEW"}</span>
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
