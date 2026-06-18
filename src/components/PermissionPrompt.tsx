import { useStore } from "../store/store";

export function PermissionPrompt() {
  const pending = useStore((s) => s.pendingPermission);
  const resolve = useStore((s) => s.resolvePermission);
  if (!pending) return null;

  return (
    <div className="border-t border-warn/40 bg-warn/10 px-5 py-3">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2.5">
        <div className="flex items-center gap-2 text-sm">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-warn/20 text-warn">
            !
          </span>
          <span>
            Portcode wants to run{" "}
            <code className="rounded bg-bg px-1.5 py-0.5 font-mono text-warn">{pending.tool}</code>{" "}
            on <span className="font-mono text-fg">{pending.summary}</span>
          </span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => void resolve("allow")}
            className="rounded-md bg-success/90 px-3 py-1.5 text-sm font-medium text-bg hover:bg-success"
          >
            Allow
          </button>
          <button
            onClick={() => void resolve("allow", true)}
            className="rounded-md border border-border bg-panel-2 px-3 py-1.5 text-sm hover:border-success hover:text-success"
          >
            Always allow
          </button>
          <button
            onClick={() => void resolve("deny")}
            className="rounded-md border border-border bg-panel-2 px-3 py-1.5 text-sm hover:border-danger hover:text-danger"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
