import { useStore } from "../store/store";
import type { Session } from "../types";
import { relativeTime, workspaceLabel } from "../lib/sessionFormat";

// The remote sessions list — shown after the SAS is confirmed and before a
// session is opened (design_handoff_mobile_remote, screen 3/4). A connected
// banner (with END), the list of the desktop's sessions as tappable cards, and a
// "new session on desktop" action. Picking a card opens the chat view.
export function RemoteSessions() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const streaming = useStore((s) => s.streaming);
  const creatingSession = useStore((s) => s.creatingSession);
  const openRemoteSession = useStore((s) => s.openRemoteSession);
  const newSession = useStore((s) => s.newSession);

  // Mid-stream, switching to a DIFFERENT session is blocked (selectSession is a
  // no-op then), so a tap on a non-active card must not open the chat — it would
  // reveal the wrong session. Mirror RemoteSessionSwitcher.pick()'s guard: only
  // open when not streaming or when tapping the already-active session.
  const open = (id: string): void => {
    if (streaming && id !== activeId) return;
    void openRemoteSession(id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg text-fg">
      <ConnectedBanner />

      {sessions.length === 0 ? (
        <EmptyState onNew={() => void newSession()} creating={creatingSession} />
      ) : (
        <>
          <div className="px-5 pb-2 pt-[18px]">
            <h1 className="font-display text-[24px] font-bold tracking-[0.4px] text-fg">
              Sessions
            </h1>
          </div>
          <div
            aria-label="Sessions"
            className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-3 pt-1"
          >
            {sessions.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                active={s.id === activeId}
                running={s.id === activeId && streaming}
                onOpen={() => open(s.id)}
              />
            ))}
          </div>
          <div className="border-t border-[#141a29] px-4 py-3">
            <button
              onClick={() => void newSession()}
              disabled={creatingSession}
              title={creatingSession ? "Creating a session…" : undefined}
              className="flex h-[50px] w-full items-center justify-center gap-2 rounded-[13px] border border-accent-2/30 bg-accent-2/[0.07] font-display text-[14px] font-semibold tracking-[0.4px] text-accent-2 transition hover:bg-accent-2/[0.14] hover:shadow-glow-cyan disabled:opacity-40"
            >
              <span className="-mt-0.5 text-[17px] leading-none">+</span> New session on desktop
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Cyan pulse = live socket. END tears the connection down entirely. */
function ConnectedBanner() {
  const disconnectRemote = useStore((s) => s.disconnectRemote);
  return (
    <div className="flex shrink-0 items-center gap-[9px] border-b border-[#141a29] bg-[rgba(9,10,16,.6)] px-5 py-[11px]">
      <span className="pc-dot pc-dot--cyan" aria-hidden="true" />
      <span className="min-w-0 truncate text-[12.5px] text-fg/90">
        Connected to <span className="font-mono text-accent-2">your desktop</span>
      </span>
      <button
        onClick={() => void disconnectRemote()}
        aria-label="End connection"
        title="End connection"
        className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-border-2 bg-panel-2/60 px-2.5 py-1.5 font-mono text-[10px] tracking-[1px] text-muted transition hover:border-danger/50 hover:text-danger"
      >
        <span aria-hidden="true">⏻</span> END
      </button>
    </div>
  );
}

/** A tappable row in the sessions list. Active = magenta; running shows a pulse. */
function SessionCard({
  session,
  active,
  running,
  onOpen,
}: {
  session: Session;
  active: boolean;
  running: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      className={
        active
          ? "flex flex-col gap-[7px] rounded-[13px] border border-accent/[0.32] bg-[linear-gradient(120deg,rgba(255,46,126,.1),rgba(255,46,126,.02))] p-3.5 text-left shadow-[inset_0_0_18px_rgba(255,46,126,.05)] transition hover:shadow-[inset_0_0_18px_rgba(255,46,126,.08),0_0_22px_rgba(255,46,126,.12)]"
          : "flex flex-col gap-[7px] rounded-[13px] border border-border bg-panel p-3.5 text-left transition hover:border-accent-2/[0.42] hover:shadow-[0_0_22px_rgba(33,230,255,.12)]"
      }
    >
      <div className="flex items-center gap-2">
        {active ? (
          <span className="pc-dot pc-dot--accent" aria-hidden="true" />
        ) : (
          <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-faint" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate text-[15px] font-semibold text-fg">{session.title}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[11px] text-faint">
          <span aria-hidden="true">⎇</span> {workspaceLabel(session.workspace)}
        </span>
        {running ? (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tracking-[1px] text-success">
            <span
              className="h-[5px] w-[5px] rounded-full bg-success shadow-[0_0_7px_#34ff9e] motion-safe:animate-[pcDot_1.4s_ease-in-out_infinite]"
              aria-hidden="true"
            />
            RUNNING
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[10px] text-faint">
            idle · {relativeTime(session.updatedAt)}
          </span>
        )}
      </div>
    </button>
  );
}

/** Connected, but the desktop has no sessions yet. */
function EmptyState({ onNew, creating }: { onNew: () => void; creating: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-[34px] py-6 text-center">
      <div className="mb-3.5 flex h-[74px] w-[74px] items-center justify-center rounded-[20px] border border-border bg-accent-2/[0.05]">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="4" width="18" height="13" rx="2" stroke="#5d6679" strokeWidth="1.5" />
          <path d="M8 21h8M12 17v4" stroke="#5d6679" strokeWidth="1.5" strokeLinecap="round" />
          <path
            d="M7 9l2.5 2.5L7 14"
            stroke="#21e6ff"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h1 className="font-display text-[20px] font-bold text-fg">No sessions yet</h1>
      <p className="mt-1.5 text-[13px] leading-[1.55] text-muted">
        Start a coding session on <span className="font-mono text-fg/90">your desktop</span>, or
        spin one up from here.
      </p>
      <button
        onClick={onNew}
        disabled={creating}
        className="mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-[13px] border border-accent bg-accent font-display text-[14.5px] font-bold tracking-[0.6px] text-bg shadow-glow-accent transition hover:shadow-[0_0_34px_rgba(255,46,126,.7)] hover:brightness-110 disabled:opacity-40 disabled:shadow-none"
      >
        <span className="-mt-0.5 text-[18px] leading-none">+</span> New session
      </button>
    </div>
  );
}
