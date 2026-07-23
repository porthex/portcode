import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  GitChangeStatus,
  TurnChangeCertainty,
  TurnChangedFile,
  TurnReceipt as TurnReceiptData,
} from "../types";

const INITIAL_FILE_LIMIT = 3;
const EXPANDED_FILE_LIMIT = 20;

export interface TurnReceiptProps {
  /** Durable terminal facts. Absent while a new turn is still live. */
  receipt?: TurnReceiptData | null;
  /** True from turn acceptance until the provider reaches a terminal state. */
  active?: boolean;
  /** Provider-neutral start time from `turn_start`; null while startup is acknowledged. */
  startedAt?: number | null;
  /** A permission request is currently blocking progress. */
  waiting?: boolean;
  /** Provider work ended, while durable receipt/Git facts are still being assembled. */
  finalizing?: boolean;
  /** Observable tool/subagent UI only. Never pass hidden provider reasoning here. */
  activity?: ReactNode;
  activityCount?: number;
}

type VisiblePhase =
  | "starting"
  | "working"
  | "waiting"
  | "finalizing"
  | "completed"
  | "cancelled"
  | "error"
  | "interrupted";

/**
 * Stable, provider-independent completion chrome for one assistant turn.
 *
 * The strip is always before the assistant's result. Its disclosure contains
 * observable tool/subagent activity only; the assistant's Markdown remains the
 * visible work summary outside this component. Terminal Git facts are append-only
 * below that summary via {@link TurnChangesCard}.
 */
export function TurnReceipt({
  receipt,
  active = false,
  startedAt = null,
  waiting = false,
  finalizing = false,
  activity,
  activityCount = 0,
}: TurnReceiptProps) {
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const hasActivity = activityCount > 0 && activity != null;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const lifecycleLive = active || finalizing;
  const lifecycleWasLive = useRef(lifecycleLive);
  const finalizingWasAnnounced = useRef(false);
  const announceTerminal =
    Boolean(receipt) &&
    !lifecycleLive &&
    lifecycleWasLive.current &&
    !finalizingWasAnnounced.current;
  useEffect(() => {
    if (lifecycleLive) {
      lifecycleWasLive.current = true;
      if (finalizing) finalizingWasAnnounced.current = true;
    } else if (receipt) {
      lifecycleWasLive.current = false;
      finalizingWasAnnounced.current = false;
    }
  }, [finalizing, lifecycleLive, receipt]);
  // The visible response timer stops as soon as provider/tool work ends. A
  // provisional receipt normally supplies the exact frozen duration; retaining
  // the last live tick is the defensive fallback if that payload is absent.
  const now = useElapsedClock(active && !finalizing, startedAt, receipt);
  const phase = visiblePhase({ receipt, active, waiting, finalizing, startedAt });
  const announcePhase = lifecycleLive || announceTerminal;
  const durationMs = receipt
    ? (receipt.agentDurationMs ?? receipt.durationMs ?? null)
    : startedAt === null
      ? null
      : Math.max(0, now - startedAt);
  const copy = phaseCopy(phase, durationMs);

  // A disclosure is controlled only by the person reading it. In particular,
  // terminal receipt arrival must not surprise-collapse a log they opened or
  // reopen one they deliberately closed.
  const toggle = () => setOpen((value) => !value);

  const collapse = () => {
    if (!open) return;
    if (detailsRef.current?.contains(document.activeElement)) toggleRef.current?.focus();
    setOpen(false);
  };

  if (!active && !finalizing && !receipt) return null;

  const action = hasActivity ? `${open ? "collapse" : "expand"} work activity` : null;
  const visibleAccessibleCopy = [copy.label, receipt && durationMs !== null ? copy.duration : null]
    .filter(Boolean)
    .join(" ");
  const accessibleDuration =
    receipt && durationMs !== null ? `${formatAccessibleDuration(durationMs)} elapsed` : null;
  const accessibleLabel = [visibleAccessibleCopy, accessibleDuration, copy.accessible, action]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      className={`pc-turn-receipt pc-turn-receipt--${phase}`}
      data-phase={phase}
      data-has-activity={hasActivity ? "true" : "false"}
      aria-live="off"
    >
      {hasActivity ? (
        <button
          ref={toggleRef}
          type="button"
          className="pc-turn-receipt__strip"
          aria-label={accessibleLabel}
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={toggle}
        >
          <ReceiptStripContent phase={phase} copy={copy} open={open} />
        </button>
      ) : (
        <div className="pc-turn-receipt__strip" role="group" aria-label={accessibleLabel}>
          <ReceiptStripContent phase={phase} copy={copy} />
        </div>
      )}

      {receipt?.failure && (
        <div className="pc-turn-receipt__failure" aria-label="Failure diagnostics">
          <div className="pc-turn-receipt__failure-message">{receipt.failure.message}</div>
          <div className="pc-turn-receipt__failure-meta">
            {failureDiagnosticLabel(receipt.failure)}
          </div>
        </div>
      )}

      {/* The visible timer is excluded from AT, so the transcript's parent live
          region cannot announce a new number every second. Mount this nested
          status while the lifecycle is live and for its same-mounted terminal
          transition; settled history keeps its strip label without replaying
          completion announcements on pagination. */}
      {announcePhase && (
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {phaseAnnouncement(phase)}
        </span>
      )}

      {hasActivity && (
        <div
          className="pc-turn-receipt__details-grid"
          data-open={open ? "true" : "false"}
          aria-hidden={!open}
          inert={!open}
        >
          <div className="min-h-0 overflow-hidden">
            <div
              ref={detailsRef}
              id={detailsId}
              className="pc-turn-receipt__details"
              role="region"
              aria-label="Observable work activity"
              onKeyDown={(event) => {
                if (event.key === "Escape") collapse();
              }}
            >
              {activity}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function failureDiagnosticLabel(failure: NonNullable<TurnReceiptData["failure"]>): string {
  const parts = [failure.code.replaceAll("_", " ")];
  const providerModel = [failure.provider, failure.model].filter(Boolean).join(" / ");
  if (providerModel) parts.push(providerModel);
  if (failure.httpStatus !== undefined) parts.push(`HTTP ${failure.httpStatus}`);
  if (failure.transcriptMessages !== undefined) {
    parts.push(`${failure.transcriptMessages.toLocaleString()} transcript messages`);
  }
  if (failure.transcriptBytes !== undefined) {
    parts.push(`${formatDiagnosticBytes(failure.transcriptBytes)} transcript`);
  }
  return `Diagnostic: ${parts.join(" · ")}`;
}

function formatDiagnosticBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function ReceiptStripContent({
  phase,
  copy,
  open,
}: {
  phase: VisiblePhase;
  copy: PhaseCopy;
  open?: boolean;
}) {
  return (
    <>
      <span className="pc-turn-receipt__state-mark" aria-hidden="true">
        {phaseMark(phase)}
      </span>
      <span className="pc-turn-receipt__label">{copy.label}</span>
      {copy.duration && (
        <span className="pc-turn-receipt__time" aria-hidden="true">
          {copy.duration}
        </span>
      )}
      {open !== undefined && (
        <span className="pc-turn-receipt__chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      )}
    </>
  );
}

/** Terminal change provenance shown after the assistant's normal Markdown. */
export function TurnChangesCard({
  receipt,
  onReview,
  reviewAvailable = true,
}: {
  receipt: TurnReceiptData;
  onReview?: (receipt: TurnReceiptData) => void;
  reviewAvailable?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const changedFiles = receipt.changedFiles;
  const reportedCount = Math.max(receipt.changedFileCount, changedFiles.length);
  const hasLineChanges = receipt.additions > 0 || receipt.deletions > 0;
  const hasChangeEvidence = reportedCount > 0 || hasLineChanges;
  // Certainty, truncation, and background activity only qualify a delta that is
  // already present; none of them proves that an otherwise empty turn touched a
  // file. This also keeps legacy/synthetic non-Git `unavailable` receipts quiet.
  const explicitlyNoChanges =
    receipt.changeState === "none" || receipt.changeState === "not_applicable";
  const shouldRender = hasChangeEvidence && !explicitlyNoChanges;

  const boundedFiles = useMemo(
    () => changedFiles.slice(0, expanded ? EXPANDED_FILE_LIMIT : INITIAL_FILE_LIMIT),
    [changedFiles, expanded],
  );
  const expandableCount = Math.max(
    0,
    Math.min(changedFiles.length, EXPANDED_FILE_LIMIT) - INITIAL_FILE_LIMIT,
  );
  const unlistedCount = Math.max(
    0,
    reportedCount - Math.min(changedFiles.length, EXPANDED_FILE_LIMIT),
  );

  if (!shouldRender) return null;

  const title = changeCardTitle(receipt.changeCertainty, reportedCount, receipt.filesTruncated);
  const canReview = changedFiles.length > 0 && receipt.changeCertainty !== "unavailable";
  const reviewLabel =
    reportedCount > 0
      ? `Review ${receipt.filesTruncated ? "at least " : ""}${reportedCount} changed ${
          reportedCount === 1 ? "file" : "files"
        }`
      : "Review workspace changes";

  const requestReview = () => {
    if (onReview) {
      onReview(receipt);
      return;
    }
    // Temporary provider-independent seam for hosts that have not wired the store
    // action yet. It is deliberately an explicit user action, never automatic.
    window.dispatchEvent(
      new CustomEvent("portcode:review-turn", { detail: { turnId: receipt.turnId } }),
    );
  };

  return (
    <section
      className="pc-turn-changes"
      aria-label={changeCardAccessibleLabel(title, receipt)}
      data-certainty={receipt.changeCertainty}
    >
      <div className="pc-turn-changes__head">
        <div className="min-w-0 flex-1">
          <div className="pc-turn-changes__title">{title}</div>
          <ChangeProvenance receipt={receipt} />
        </div>
        {hasLineChanges && (
          <div
            className="pc-turn-changes__totals"
            aria-label={lineTotalsLabel(receipt.additions, receipt.deletions)}
          >
            {receipt.additions > 0 && (
              <span className="text-success" aria-hidden="true">
                +{receipt.additions}
              </span>
            )}
            {receipt.deletions > 0 && (
              <span className="text-danger" aria-hidden="true">
                −{receipt.deletions}
              </span>
            )}
          </div>
        )}
        {reviewAvailable && canReview ? (
          <button
            type="button"
            className="pc-turn-changes__review"
            aria-label={reviewLabel}
            onClick={requestReview}
          >
            Review
          </button>
        ) : !reviewAvailable && canReview ? (
          <span className="pc-turn-changes__review-note">Review on desktop</span>
        ) : null}
      </div>

      {boundedFiles.length > 0 && (
        <ul className="pc-turn-changes__files" aria-label="Changed files">
          {boundedFiles.map((file, index) => (
            <ChangedFileRow key={`${file.oldPath ?? ""}:${file.path}:${index}`} file={file} />
          ))}
        </ul>
      )}

      {(expandableCount > 0 || expanded || unlistedCount > 0 || receipt.filesTruncated) && (
        <div className="pc-turn-changes__foot">
          {expandableCount > 0 && !expanded && (
            <button
              type="button"
              className="pc-turn-changes__more"
              onClick={() => setExpanded(true)}
            >
              Show {expandableCount} more
            </button>
          )}
          {expanded && changedFiles.length > INITIAL_FILE_LIMIT && (
            <button
              type="button"
              className="pc-turn-changes__more"
              onClick={() => setExpanded(false)}
            >
              Show less
            </button>
          )}
          <span className="ml-auto text-faint">
            {receipt.filesTruncated
              ? "File list truncated"
              : unlistedCount > 0
                ? `${unlistedCount} additional ${unlistedCount === 1 ? "file" : "files"} not listed`
                : ""}
          </span>
        </div>
      )}
    </section>
  );
}

function ChangedFileRow({ file }: { file: TurnChangedFile }) {
  const path =
    file.oldPath && (file.status === "renamed" || file.status === "copied")
      ? `${file.oldPath} → ${file.path}`
      : file.path;
  const hasLineChanges = (file.additions ?? 0) > 0 || (file.deletions ?? 0) > 0;
  return (
    <li className="pc-turn-changes__file">
      <StatusGlyph status={file.status} />
      <span
        className={`pc-turn-changes__path ${file.status === "deleted" ? "line-through" : ""}`}
        title={path}
      >
        {path}
      </span>
      <FileCertainty certainty={file.certainty} />
      {file.binary ? (
        <span className="pc-turn-changes__binary">binary</span>
      ) : hasLineChanges ? (
        <span
          className="pc-turn-changes__file-counts"
          aria-label={lineTotalsLabel(file.additions ?? 0, file.deletions ?? 0)}
        >
          {(file.additions ?? 0) > 0 && (
            <span className="text-success" aria-hidden="true">
              +{file.additions}
            </span>
          )}
          {(file.deletions ?? 0) > 0 && (
            <span className="text-danger" aria-hidden="true">
              −{file.deletions}
            </span>
          )}
        </span>
      ) : null}
    </li>
  );
}

function StatusGlyph({ status }: { status: GitChangeStatus }) {
  const glyph: Record<GitChangeStatus, string> = {
    added: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
    copied: "C",
    unmerged: "U",
  };
  return (
    <span className={`pc-turn-changes__status pc-turn-changes__status--${status}`}>
      <span aria-hidden="true">{glyph[status]}</span>
      <span className="sr-only">{status}</span>
    </span>
  );
}

function FileCertainty({ certainty }: { certainty: TurnChangeCertainty }) {
  if (certainty === "exact") return null;
  return (
    <span className={`pc-turn-changes__certainty pc-turn-changes__certainty--${certainty}`}>
      {certainty}
    </span>
  );
}

function ChangeProvenance({ receipt }: { receipt: TurnReceiptData }) {
  const parts: string[] = [];
  if (receipt.changeCertainty === "observed") parts.push("Observed during this turn");
  if (receipt.changeCertainty === "ambiguous") parts.push("Attribution is ambiguous");
  if (receipt.changeCertainty === "unavailable") parts.push("Git attribution unavailable");
  if (receipt.backgroundTasksRunning) parts.push("Background tasks are still running");
  if (receipt.status === "cancelled") parts.push("Changes remain from a stopped turn");
  if (receipt.status === "error" || receipt.status === "interrupted") {
    parts.push("Changes may remain from an incomplete turn");
  }
  if (parts.length === 0) return null;
  return <div className="pc-turn-changes__provenance">{parts.join(" · ")}</div>;
}

function changeCardAccessibleLabel(title: string, receipt: TurnReceiptData) {
  const parts = [title];
  const totals = lineTotalsLabel(receipt.additions, receipt.deletions);
  if (totals) parts.push(...totals.split(", "));
  if (receipt.changeCertainty !== "exact") parts.push(`${receipt.changeCertainty} attribution`);
  if (receipt.filesTruncated) parts.push("file list truncated");
  return parts.join(", ");
}

function lineTotalsLabel(additions: number, deletions: number) {
  const parts: string[] = [];
  if (additions > 0) parts.push(`${additions} additions`);
  if (deletions > 0) parts.push(`${deletions} deletions`);
  return parts.join(", ");
}

function changeCardTitle(certainty: TurnChangeCertainty, count: number, filesTruncated: boolean) {
  if (certainty === "unavailable") return "Git changes could not be verified";
  if (count === 0) return "File changes detected";
  const files = `${count} ${count === 1 ? "file" : "files"}`;
  if (filesTruncated) return `At least ${files} changed`;
  if (certainty === "ambiguous") {
    return `${files} changed while this turn ran`;
  }
  if (certainty === "observed") {
    return `${files} changed during this turn`;
  }
  return `Edited ${files}`;
}

function useElapsedClock(
  live: boolean,
  startedAt: number | null,
  receipt: TurnReceiptData | null | undefined,
) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!live || startedAt === null || receipt) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live, receipt, startedAt]);
  return receipt ? receipt.completedAt : clock;
}

function visiblePhase({
  receipt,
  active,
  waiting,
  finalizing,
  startedAt,
}: Pick<
  TurnReceiptProps,
  "receipt" | "active" | "waiting" | "finalizing" | "startedAt"
>): VisiblePhase {
  if (finalizing) return "finalizing";
  if (active && waiting) return "waiting";
  if (active && startedAt === null) return "starting";
  if (active) return "working";
  return receipt?.status ?? "interrupted";
}

interface PhaseCopy {
  label: string;
  duration: string;
  accessible: string;
}

function phaseCopy(phase: VisiblePhase, durationMs: number | null): PhaseCopy {
  const formatted = formatDuration(durationMs);
  switch (phase) {
    case "starting":
      return { label: "Starting", duration: "…", accessible: "Turn is starting" };
    case "working":
      return { label: "Working", duration: formatted, accessible: "Turn is in progress" };
    case "waiting":
      return {
        label: "Waiting for approval",
        duration: formatted,
        accessible: "Turn is waiting for approval",
      };
    case "finalizing":
      return {
        label: "Response complete · Checking file changes…",
        duration: formatted,
        accessible: "Response is complete and file changes are being checked",
      };
    case "completed":
      return {
        label: durationMs === null ? "Done" : "Done in",
        duration: durationMs === null ? "" : formatted,
        accessible: "Turn completed",
      };
    case "cancelled":
      return {
        label: durationMs === null ? "Stopped" : "Stopped after",
        duration: formatted,
        accessible: "Turn stopped",
      };
    case "error":
      return {
        label: durationMs === null ? "Failed" : "Failed after",
        duration: formatted,
        accessible: "Turn failed",
      };
    case "interrupted":
      return {
        label: durationMs === null ? "Interrupted" : "Interrupted after",
        duration: formatted,
        accessible: "Turn interrupted",
      };
  }
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "—";
  if (durationMs < 1_000) return "<1s";
  const totalSeconds = Math.floor(durationMs / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds}s`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds}s`;
}

function formatAccessibleDuration(durationMs: number): string {
  if (durationMs < 1_000) return "less than 1 second";
  const totalSeconds = Math.floor(durationMs / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const minuteCopy = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  if (hours > 0) {
    return `${hours} ${hours === 1 ? "hour" : "hours"} ${minuteCopy}`;
  }
  return `${minuteCopy} ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function phaseAnnouncement(phase: VisiblePhase) {
  if (phase === "starting") return "Turn started";
  if (phase === "working") return "Turn in progress";
  if (phase === "waiting") return "Turn is waiting for approval";
  if (phase === "finalizing") return "Response complete. Checking file changes.";
  if (phase === "completed") return "Turn completed";
  if (phase === "cancelled") return "Turn stopped";
  if (phase === "error") return "Turn failed";
  return "Turn interrupted";
}

function phaseMark(phase: VisiblePhase) {
  if (phase === "completed" || phase === "finalizing") return "✓";
  if (phase === "cancelled") return "■";
  if (phase === "error") return "!";
  if (phase === "interrupted") return "×";
  return "·";
}
