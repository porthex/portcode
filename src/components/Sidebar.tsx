import { useStore } from "../store/store";

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const newSession = useStore((s) => s.newSession);
  const selectSession = useStore((s) => s.selectSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const settings = useStore((s) => s.settings);
  const oauthStatus = useStore((s) => s.oauthStatus);

  const signedInClaude = !!oauthStatus?.signedIn;
  const authed = signedInClaude || settings.apiKeySet;
  const authTitle = signedInClaude
    ? "Signed in with Claude"
    : settings.apiKeySet
      ? "API key set"
      : "Not authenticated";

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-panel">
      <div className="flex items-center gap-2 px-4 py-3">
        <Logo />
        <span className="font-semibold tracking-tight">Portcode</span>
        <span className="ml-auto text-[10px] text-muted">Porthex</span>
      </div>

      <div className="px-3 pb-2">
        <button
          onClick={newSession}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-2 text-sm hover:border-accent hover:text-accent transition-colors"
        >
          <span className="text-base leading-none">+</span> New chat
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`group mb-1 flex items-center rounded-md transition-colors ${
              s.id === activeId
                ? "bg-accent-dim text-fg"
                : "text-muted hover:bg-panel-2 hover:text-fg"
            }`}
          >
            <button
              onClick={() => selectSession(s.id)}
              className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm"
              title={s.title}
            >
              {s.title}
            </button>
            <button
              onClick={() => deleteSession(s.id)}
              className="mr-1 hidden h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-bg hover:text-danger group-hover:flex"
              title="Delete chat"
            >
              ✕
            </button>
          </div>
        ))}
      </nav>

      <div className="border-t border-border p-3">
        <button
          onClick={() => setShowSettings(true)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted hover:bg-panel-2 hover:text-fg transition-colors"
        >
          <GearIcon />
          Settings
          <span
            className={`ml-auto h-2 w-2 rounded-full ${authed ? "bg-success" : "bg-warn"}`}
            title={authTitle}
          />
        </button>
      </div>
    </aside>
  );
}

function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="3" width="20" height="18" rx="4" fill="var(--color-accent-dim)" />
      <path
        d="M7 9l3 3-3 3M13 15h4"
        stroke="var(--color-accent)"
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
