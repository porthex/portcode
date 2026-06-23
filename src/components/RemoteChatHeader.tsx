import { useState } from "react";
import { useStore } from "../store/store";
import { workspaceLabel } from "../lib/sessionFormat";
import { RemoteSessionSwitcher } from "./RemoteSessionSwitcher";

// Header for the remote chat view (design_handoff_mobile_remote, screen 5): a back
// chevron to the sessions list (the connection stays live), the session title with
// a ▾ that raises the session switcher, the live-link/device line, and a switch
// icon. Owns the bottom-sheet switcher's open state. Render inside a `relative`
// container so the switcher's scrim/sheet position against the chat view.
export function RemoteChatHeader() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const closeRemoteSession = useStore((s) => s.closeRemoteSession);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const title = session?.title ?? "New chat";

  return (
    <>
      <header className="shrink-0 border-b border-[#141a29] bg-[rgba(9,10,16,.72)] backdrop-blur-sm">
        <div className="flex items-center gap-2.5 py-[9px] pl-3 pr-3.5">
          <button
            onClick={closeRemoteSession}
            aria-label="Back to sessions"
            title="Back to sessions"
            className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] text-muted transition-colors hover:text-fg"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M15 6l-6 6 6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <button
            onClick={() => setSwitcherOpen(true)}
            aria-label="Switch session"
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex items-center gap-[7px]">
              <span className="min-w-0 truncate text-[14.5px] font-semibold text-fg">{title}</span>
              <span className="shrink-0 text-[11px] text-faint" aria-hidden="true">
                ▾
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="pc-dot pc-dot--cyan" aria-hidden="true" />
              <span className="truncate font-mono text-[10px] tracking-[0.5px] text-[#21899a]">
                your desktop · <span aria-hidden="true">⎇</span>{" "}
                {workspaceLabel(session?.workspace)}
              </span>
            </div>
          </button>

          <button
            onClick={() => setSwitcherOpen(true)}
            aria-label="Switch session"
            title="Switch session"
            className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] border border-accent-2/30 bg-accent-2/[0.07] text-accent-2 transition hover:bg-accent-2/[0.14]"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 7h11M4 7l3-3M4 7l3 3M20 17H9M20 17l-3-3M20 17l-3 3"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </header>

      {switcherOpen && <RemoteSessionSwitcher onClose={() => setSwitcherOpen(false)} />}
    </>
  );
}
