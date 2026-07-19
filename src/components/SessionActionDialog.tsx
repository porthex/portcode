import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { Session, SessionArchiveWarning } from "../types";

export type SessionDialogState =
  | { kind: "archive"; session: Session; warning: SessionArchiveWarning }
  | { kind: "archiveError"; session: Session; message: string }
  | { kind: "delete"; session: Session };

interface SessionActionDialogProps {
  state: SessionDialogState;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * A focused confirmation surface for the two lifecycle boundaries that deserve
 * friction: hiding a session with uncommitted work and permanently deleting an
 * already-archived transcript. Archive itself stays instant for clean worktrees.
 */
export function SessionActionDialog({
  state,
  busy = false,
  onCancel,
  onConfirm,
}: SessionActionDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, [state]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable =
      dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const archive = state.kind === "archive" ? state.warning : null;
  const isDelete = state.kind === "delete";
  const isError = state.kind === "archiveError";
  const branch = archive?.branch ?? archive?.detachedHead ?? "detached HEAD";
  const title = isDelete
    ? "Delete archived session?"
    : isError
      ? "Couldn’t check the worktree"
      : "Uncommitted work on this branch";

  return createPortal(
    <div
      className="pc-session-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={onKeyDown}
        className="pc-session-dialog"
      >
        <div className={`pc-session-dialog__icon ${isDelete ? "is-danger" : "is-warn"}`}>
          <span aria-hidden="true">{isDelete ? "×" : "!"}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="pc-eyebrow-mono mb-1 text-[9.5px]">
            {isDelete ? "PERMANENT ACTION" : isError ? "ARCHIVE PAUSED" : "WORKTREE CHECK"}
          </div>
          <h2 id={titleId} className="text-[16px] font-semibold text-fg">
            {title}
          </h2>

          {archive && (
            <div
              id={descriptionId}
              className="mt-3 space-y-3 text-[12.5px] leading-[1.55] text-muted"
            >
              <p>
                <strong className="text-fg">{state.session.title}</strong> is working on branch{" "}
                <span className="pc-session-dialog__branch">{branch}</span> with changes that are
                not committed yet.
              </p>
              <div className="pc-session-dialog__facts" aria-label="Uncommitted change summary">
                <span>{archive.changedFiles} changed</span>
                <span>{archive.untrackedFiles} untracked</span>
                <span className="text-success">+{archive.additions}</span>
                <span className="text-danger">−{archive.deletions}</span>
              </div>
              <p>
                Archiving only hides the session; it does not delete these files. Commit or review
                them first if you do not want to lose track of the work.
              </p>
            </div>
          )}

          {isDelete && (
            <p id={descriptionId} className="mt-3 text-[12.5px] leading-[1.55] text-muted">
              The transcript and draft for{" "}
              <strong className="text-fg">{state.session.title}</strong> will be permanently
              removed. Files in its workspace will stay on disk.
            </p>
          )}

          {isError && (
            <p id={descriptionId} className="mt-3 text-[12.5px] leading-[1.55] text-muted">
              {state.message}. Portcode has not archived{" "}
              <strong className="text-fg">{state.session.title}</strong> because the worktree state
              could not be verified.
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button
              ref={cancelRef}
              type="button"
              disabled={busy}
              onClick={onCancel}
              className="pc-session-dialog__button"
            >
              {isDelete ? "Keep session" : "Cancel"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onConfirm}
              className={`pc-session-dialog__button ${isDelete ? "is-danger" : "is-primary"}`}
            >
              {busy
                ? "Working…"
                : isDelete
                  ? "Delete forever"
                  : isError
                    ? "Try again"
                    : "Archive anyway"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
