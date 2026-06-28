import { useEffect, useRef } from "react";
import { useStore } from "../store/store";
import { relativeTime, workspaceLabel } from "../lib/sessionFormat";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Bottom-sheet session switcher raised from the chat header (title tap or the
// swap icon) — thumb-reachable, and switching never leaves the chat context
// (design_handoff_mobile_remote, screen 5). Behaves as a modal dialog: focus moves
// in on open, Tab is trapped, Escape / scrim-tap close it, and focus returns to the
// opener. Picking a session switches in place via the store, then closes.
export function RemoteSessionSwitcher({ onClose }: { onClose: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const streaming = useStore((s) => s.streaming);
  const selectSession = useStore((s) => s.selectSession);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Escape closes the sheet wherever focus sits (the App keydown effect only
  // handles modified keys, so plain Escape would otherwise be swallowed).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Move focus into the sheet on open (onto the container — a non-input element,
  // so the phone soft keyboard doesn't pop) and restore it to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  // Trap Tab within the sheet so it can't walk into the chat behind the scrim.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const container = sheetRef.current;
    if (!container) return;
    const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) {
      e.preventDefault();
      container.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === container)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const pick = (id: string) => {
    // selectSession is a no-op mid-stream (switching activeId would strand the
    // streaming turn). Closing the sheet then would falsely imply the session
    // changed, so when a switch can't take effect, keep the sheet open instead.
    if (streaming && id !== activeId) return;
    void selectSession(id);
    onClose();
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close session switcher"
        onClick={onClose}
        className="absolute inset-0 z-[8] bg-[rgba(3,4,8,.62)] backdrop-blur-[2px]"
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Switch session"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="absolute inset-x-0 bottom-0 z-[9] rounded-t-[20px] border-t border-border-2 bg-panel px-4 pb-[22px] pt-2.5 shadow-[0_-16px_50px_rgba(0,0,0,.6)] outline-none motion-safe:animate-[pc-sheet_0.26s_cubic-bezier(0.2,0.8,0.2,1)_both]"
      >
        <div
          className="mx-auto mb-3.5 mt-0.5 h-1 w-[38px] rounded-[3px] bg-border-2"
          aria-hidden="true"
        />
        <div className="mb-3 flex items-center justify-between">
          <span className="font-display text-[16px] font-bold text-fg">Switch session</span>
          <span className="font-mono text-[10px] tracking-[1px] text-[#21899a]">your desktop</span>
        </div>
        <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
          {sessions.map((s) => {
            const active = s.id === activeId;
            const running = active && streaming;
            return (
              <button
                key={s.id}
                onClick={() => pick(s.id)}
                aria-current={active ? "true" : undefined}
                className={
                  active
                    ? "flex items-center gap-2.5 rounded-xl border border-accent/[0.35] bg-[linear-gradient(120deg,rgba(255,46,126,.12),rgba(255,46,126,.02))] p-3.5 text-left"
                    : "flex items-center gap-2.5 rounded-xl border border-border bg-[#0d0f17] p-3.5 text-left transition hover:border-accent-2/40"
                }
              >
                <span
                  className={`h-[7px] w-[7px] shrink-0 rounded-full ${active ? "bg-accent shadow-[0_0_8px_#ff2e7e]" : "bg-faint"}`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold text-fg">{s.title}</div>
                  <div className="mt-0.5 font-mono text-[10.5px] text-faint">
                    <span aria-hidden="true">⎇</span> {workspaceLabel(s.workspace)} ·{" "}
                    {running ? "running" : `idle ${relativeTime(s.updatedAt)}`}
                  </div>
                </div>
                {active && (
                  <span className="shrink-0 font-mono text-[10.5px] text-success">ACTIVE</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
