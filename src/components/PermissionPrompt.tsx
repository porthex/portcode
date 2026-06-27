import { useEffect, useRef } from "react";

import { useStore } from "../store/store";

export function PermissionPrompt() {
  const pending = useStore((s) => s.pendingPermission);
  const resolve = useStore((s) => s.resolvePermission);
  const remoteMode = useStore((s) => s.remoteMode);
  const denyRef = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);

  // Focus the safe "Deny" action whenever a new request appears, so a reflexive
  // Enter denies rather than allows. Keyed on the request id so re-renders that
  // keep the same pending request don't steal focus back from the user.
  const pendingId = pending?.id;
  useEffect(() => {
    if (pendingId) denyRef.current?.focus();
  }, [pendingId]);

  // When the prompt clears, the focused Deny button unmounts and focus falls to
  // <body>. Answering a gate leaves the turn streaming (the agent keeps running),
  // and the Composer's refocus only fires on [streaming, remoteMode] transitions —
  // neither changes here, and its textarea is disabled mid-stream anyway. Reclaim
  // focus to the Chat scroll region (role="log", made focusable with tabIndex=-1)
  // so a keyboard user can scroll/Tab from a sensible place instead of being
  // stranded on <body> for the streaming tail. Skip on remote so the mobile
  // keyboard/viewport isn't disturbed (mirrors the Composer guard).
  useEffect(() => {
    if (pendingId) {
      wasPending.current = true;
    } else if (wasPending.current) {
      wasPending.current = false;
      if (!remoteMode && document.activeElement === document.body) {
        const log = document.querySelector<HTMLElement>('[role="log"]');
        log?.focus();
      }
    }
  }, [pendingId, remoteMode]);

  if (!pending) return null;

  return (
    <div role="alert" className="pc-gate px-6 py-3.5">
      <div className="flex flex-col gap-[11px]">
        <div className="flex items-center gap-[9px] text-[13px] text-fg">
          <span className="pc-gate__icon">!</span>
          <span>
            Portcode wants to run{" "}
            <code className="rounded bg-warn/10 px-1.5 py-0.5 font-mono text-warn">
              {pending.tool}
            </code>{" "}
            on{" "}
            <span
              className="font-mono text-fg break-words line-clamp-2 [overflow-wrap:anywhere]"
              title={pending.summary}
            >
              {pending.summary}
            </span>
          </span>
        </div>
        {pending.diff && pending.diff.trim() && <DiffView diff={pending.diff} />}
        <div className="flex flex-wrap gap-[9px]">
          <button
            onClick={() => void resolve("allow")}
            className="pc-btn-allow px-3.5 py-1.5 text-[12.5px]"
          >
            Allow
          </button>
          <button
            onClick={() => void resolve("allow", true)}
            className="pc-btn-deny pc-btn-confirm px-3.5 py-1.5 text-[12.5px]"
          >
            Always allow
          </button>
          <button
            ref={denyRef}
            onClick={() => void resolve("deny")}
            className="pc-btn-deny px-3.5 py-1.5 text-[12.5px]"
          >
            ⏎ Deny
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The pre-apply unified diff for a file write/edit, shown so the user can see
 * exactly what would change BEFORE approving. Added/removed lines are coloured;
 * the body scrolls so a large change can't push the Allow/Deny buttons offscreen.
 */
function DiffView({ diff }: { diff: string }) {
  return (
    <pre
      aria-label="Proposed change"
      className="pc-diff max-h-48 overflow-auto rounded border border-border bg-panel-2 px-2.5 py-2 font-mono text-[11px] leading-[1.5]"
    >
      {diff.split("\n").map((line, i) => {
        const cls =
          line.startsWith("+") && !line.startsWith("+++")
            ? "text-accent-2"
            : line.startsWith("-") && !line.startsWith("---")
              ? "text-danger"
              : line.startsWith("@@")
                ? "text-violet"
                : "text-muted";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
