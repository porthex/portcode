import { useEffect, useRef } from "react";

import { useStore } from "../store/store";

export function PermissionPrompt() {
  const pending = useStore((s) => s.pendingPermission);
  const resolve = useStore((s) => s.resolvePermission);
  const denyRef = useRef<HTMLButtonElement>(null);

  // Focus the safe "Deny" action whenever a new request appears, so a reflexive
  // Enter denies rather than allows. Keyed on the request id so re-renders that
  // keep the same pending request don't steal focus back from the user.
  const pendingId = pending?.id;
  useEffect(() => {
    if (pendingId) denyRef.current?.focus();
  }, [pendingId]);

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
        <div className="flex gap-[9px]">
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
