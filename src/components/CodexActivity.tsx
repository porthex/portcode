import { useId, useMemo, useState, type ReactNode } from "react";

import {
  CODEX_UNKNOWN_ACTIVITY_LIMIT,
  isRecognizedCodexActivityMethod,
  projectCodexActivity,
  sanitizeCodexInspectorValue,
  type CodexActivityProjection,
  type CodexCommandActivity,
  type CodexFileChangeActivity,
  type CodexMcpActivity,
  type CodexPlanStep,
  type CodexReasoningSummary,
  type CodexTurnActivity,
} from "../lib/codexActivity";
import type { CodexActivityEvent } from "../types";
import { DiffView, PlainOutput } from "./ToolCall";

export function CodexTurnActivityView({
  activity,
  onReviewChanges,
  reviewAvailable = false,
  remoteSafe = false,
}: {
  activity: CodexTurnActivity;
  onReviewChanges?: () => void;
  reviewAvailable?: boolean;
  remoteSafe?: boolean;
}) {
  const terminalStatus =
    activity.status === "completed" ||
    activity.status === "failed" ||
    activity.status === "interrupted"
      ? activity.status
      : null;
  if (activity.visibleCount === 0 && !(remoteSafe && terminalStatus)) return null;

  const itemActivities: Array<
    | { kind: "command"; value: CodexCommandActivity }
    | { kind: "fileChange"; value: CodexFileChangeActivity }
    | { kind: "mcp"; value: CodexMcpActivity }
  > = [
    ...Object.values(activity.commands).map((value) => ({
      kind: "command" as const,
      value,
    })),
    ...Object.values(activity.fileChanges).map((value) => ({
      kind: "fileChange" as const,
      value,
    })),
    ...Object.values(activity.mcpCalls).map((value) => ({
      kind: "mcp" as const,
      value,
    })),
  ].sort((left, right) => left.value.sequence - right.value.sequence);

  return (
    <section
      className="pc-codex-activity"
      role="region"
      aria-label="Codex turn activity"
      aria-live="off"
    >
      {remoteSafe && terminalStatus && (
        <div className="pc-codex-compaction">
          <span
            className={
              "pc-dot " + (terminalStatus === "completed" ? "pc-dot--success" : "pc-dot--danger")
            }
            aria-hidden="true"
          />
          Turn {terminalStatus}
        </div>
      )}
      {activity.notices.map((notice) => (
        <div
          className={"pc-codex-notice pc-codex-notice--" + notice.kind}
          key={notice.id}
          role={notice.kind === "warning" ? "note" : "alert"}
        >
          <span className="pc-codex-notice__label">
            {notice.kind === "retry" ? "Retrying" : notice.kind === "error" ? "Error" : "Warning"}
          </span>
          <span>{notice.message}</span>
        </div>
      ))}
      {activity.plan && <PlanActivity plan={activity.plan} />}
      {Object.values(activity.reasoning)
        .sort((left, right) => left.sequence - right.sequence)
        .map((reasoning) => (
          <ReasoningActivity reasoning={reasoning} key={reasoning.itemId} />
        ))}
      {Object.values(activity.compactions)
        .sort((left, right) => left.sequence - right.sequence)
        .map((compaction) => (
          <div className="pc-codex-compaction" key={compaction.itemId}>
            <span className="pc-dot pc-dot--success" aria-hidden="true" />
            {compaction.status === "completed" ? "Context compacted." : "Compacting context…"}
          </div>
        ))}
      {itemActivities.map((item) => {
        if (item.kind === "command") {
          return <CommandActivity command={item.value} key={"command:" + item.value.itemId} />;
        }
        if (item.kind === "fileChange") {
          return <FileChangeActivity fileChange={item.value} key={"file:" + item.value.itemId} />;
        }
        return <McpActivity mcpCall={item.value} key={"mcp:" + item.value.itemId} />;
      })}
      {activity.turnDiff && (
        <ActivityDisclosure title="Live changes" status="updated" action="diff">
          {activity.turnDiff.uncertainty && (
            <p className="pc-codex-activity__truncated">
              {activity.turnDiff.uncertainty === "oversized"
                ? "This oversized diff was bounded and may be incomplete."
                : activity.turnDiff.uncertainty === "malformed"
                  ? "This diff was malformed and cannot be counted reliably."
                  : "This diff was truncated and may be incomplete."}
            </p>
          )}
          <DiffView text={activity.turnDiff.text} />
          {activity.turnDiff.uncertainty && reviewAvailable && onReviewChanges && (
            <button type="button" onClick={onReviewChanges}>
              Review exact turn changes
            </button>
          )}
        </ActivityDisclosure>
      )}
    </section>
  );
}

type CodexActivityHistoryInspectorProps = {
  events: readonly CodexActivityEvent[];
  scopeKey?: string;
  unknownOnly?: boolean;
  renderTurns?: boolean;
  emptyMessage?: string;
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  hasMore?: boolean;
  archiveLimited?: boolean;
  metadataOnly?: boolean;
};

type ActivityHistoryWindow = {
  events: CodexActivityEvent[];
  total: number;
  start: number;
  end: number;
  atOldest: boolean;
  atNewest: boolean;
  firstSequence: number;
  lastSequence: number;
  oldestAnchor: number;
  olderAnchor: number;
  newerAnchor: number | null;
};

/** Projects only one bounded retained range. The full in-memory archive remains
 * capped by the store, while detailed projection and mounted DOM stay capped at
 * the same 200-record limit used by the generic inspector. */
export function CodexActivityHistoryInspector({
  events,
  scopeKey = "default",
  unknownOnly = false,
  renderTurns = false,
  emptyMessage,
  onLoadOlder,
  loadingOlder = false,
  hasMore = false,
  archiveLimited = false,
  metadataOnly = false,
}: CodexActivityHistoryInspectorProps) {
  const [selection, setSelection] = useState<{ scopeKey: string; anchorSequence: number | null }>({
    scopeKey,
    anchorSequence: null,
  });
  const anchorSequence = selection.scopeKey === scopeKey ? selection.anchorSequence : null;
  const setAnchorSequence = (value: number | null) => {
    setSelection({ scopeKey, anchorSequence: value });
  };
  const retained = useMemo(() => {
    const seen = new Set<number>();
    const ordered: CodexActivityEvent[] = [];
    for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
      if (seen.has(event.sequence)) continue;
      seen.add(event.sequence);
      if (unknownOnly && isRecognizedCodexActivityMethod(event.method)) continue;
      ordered.push(event);
    }
    return ordered;
  }, [events, unknownOnly]);
  const historyWindow = useMemo<ActivityHistoryWindow | null>(() => {
    if (retained.length === 0) return null;
    const latestStart = Math.max(0, retained.length - CODEX_UNKNOWN_ACTIVITY_LIMIT);
    const anchoredIndex =
      anchorSequence === null
        ? latestStart
        : retained.findIndex((event) => event.sequence >= anchorSequence);
    const start =
      anchoredIndex < 0 ? latestStart : Math.min(Math.max(0, anchoredIndex), latestStart);
    const end = Math.min(retained.length, start + CODEX_UNKNOWN_ACTIVITY_LIMIT);
    const olderStart = Math.max(0, start - CODEX_UNKNOWN_ACTIVITY_LIMIT);
    const newerStart = Math.min(latestStart, start + CODEX_UNKNOWN_ACTIVITY_LIMIT);
    return {
      events: retained.slice(start, end),
      total: retained.length,
      start,
      end,
      atOldest: start === 0,
      atNewest: start === latestStart,
      firstSequence: retained[start].sequence,
      lastSequence: retained[end - 1].sequence,
      oldestAnchor: retained[0].sequence,
      olderAnchor: retained[olderStart].sequence,
      newerAnchor: newerStart === latestStart ? null : retained[newerStart].sequence,
    };
  }, [anchorSequence, retained]);
  const projection = useMemo(
    () => projectCodexActivity(historyWindow?.events ?? [], { hasMore }),
    [hasMore, historyWindow],
  );
  const navigation = historyWindow ? (
    <ActivityHistoryNavigation
      historyWindow={historyWindow}
      unknownOnly={unknownOnly}
      onOldest={() => setAnchorSequence(historyWindow.oldestAnchor)}
      onOlder={() => setAnchorSequence(historyWindow.olderAnchor)}
      onNewer={() => setAnchorSequence(historyWindow.newerAnchor)}
      onNewest={() => setAnchorSequence(null)}
    />
  ) : null;
  const empty = historyWindow === null && !projection.hasMore && !archiveLimited;
  if (empty) return emptyMessage ? <p className="text-[10px] text-faint">{emptyMessage}</p> : null;

  return (
    <>
      {!unknownOnly && navigation}
      {renderTurns &&
        projection.turnOrder.map((key) => {
          const turn = projection.turns[key];
          return turn ? (
            <div key={key}>
              <div className="font-mono text-[8px] uppercase text-muted">Turn {turn.status}</div>
              <CodexTurnActivityView activity={turn} remoteSafe={metadataOnly} />
            </div>
          ) : null;
        })}
      <CodexUnknownActivityInspector
        projection={projection}
        loadingOlder={loadingOlder}
        archiveLimited={archiveLimited}
        metadataOnly={metadataOnly}
        onLoadOlder={onLoadOlder}
        rangeNavigation={unknownOnly ? navigation : undefined}
      />
    </>
  );
}

function ActivityHistoryNavigation({
  historyWindow,
  unknownOnly,
  onOldest,
  onOlder,
  onNewer,
  onNewest,
}: {
  historyWindow: ActivityHistoryWindow;
  unknownOnly: boolean;
  onOldest: () => void;
  onOlder: () => void;
  onNewer: () => void;
  onNewest: () => void;
}) {
  const number = (value: number) => value.toLocaleString("en-US");
  return (
    <nav className="pc-codex-history" aria-label="Retained activity ranges">
      <p role="status" aria-live="polite" aria-atomic="true" className="pc-codex-history__status">
        Showing {unknownOnly ? "unrecognized " : ""}retained records{" "}
        {number(historyWindow.start + 1)}–{number(historyWindow.end)} of{" "}
        {number(historyWindow.total)}; sequences {number(historyWindow.firstSequence)}–
        {number(historyWindow.lastSequence)}. {historyWindow.atNewest ? "Newest" : "Older"} retained
        range.
      </p>
      <div className="pc-codex-history__controls">
        <button type="button" disabled={historyWindow.atOldest} onClick={onOldest}>
          <span aria-hidden="true">⇤</span>
          <span className="sr-only">Show oldest retained activity</span>
        </button>
        <button type="button" disabled={historyWindow.atOldest} onClick={onOlder}>
          Older
        </button>
        <button type="button" disabled={historyWindow.atNewest} onClick={onNewer}>
          Newer
        </button>
        <button type="button" disabled={historyWindow.atNewest} onClick={onNewest}>
          <span aria-hidden="true">⇥</span>
          <span className="sr-only">Show newest retained activity</span>
        </button>
      </div>
    </nav>
  );
}

export function CodexUnknownActivityInspector({
  projection,
  onLoadOlder,
  loadingOlder = false,
  archiveLimited = false,
  metadataOnly = false,
  rangeNavigation,
}: {
  projection: CodexActivityProjection;
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  archiveLimited?: boolean;
  metadataOnly?: boolean;
  rangeNavigation?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  if (projection.unknown.length === 0 && !projection.hasMore && !archiveLimited) return null;
  const title = "Unrecognized Codex activity (" + projection.unknown.length + ")";

  return (
    <section className="pc-codex-unknown" aria-live="off">
      <button
        type="button"
        className="pc-codex-unknown__head"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={title + ", " + (open ? "collapse" : "expand")}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{title}</span>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div
          id={detailsId}
          className="pc-codex-unknown__body"
          role="region"
          aria-label="Unrecognized Codex activity details"
        >
          {rangeNavigation}
          {projection.hasMore && (
            <div className="pc-codex-unknown__window">
              <p>Older persisted activity is available.</p>
              {onLoadOlder && (
                <button type="button" disabled={loadingOlder} onClick={onLoadOlder}>
                  {loadingOlder ? "Loading older activity…" : "Load older activity"}
                </button>
              )}
            </div>
          )}
          {archiveLimited && (
            <p className="pc-codex-unknown__window">
              The bounded activity archive limit was reached. Reload to navigate from the newest
              durable page again.
            </p>
          )}
          {projection.unknownTruncated > 0 && (
            <p className="pc-codex-unknown__window">
              {projection.unknownTruncated.toLocaleString("en-US")} earlier unrecognized records
              omitted from this view.
            </p>
          )}
          <ul className="pc-codex-unknown__list">
            {projection.unknown.map((record) => (
              <li className="pc-codex-unknown__row" key={record.sequence}>
                <div className="pc-codex-unknown__method">{record.method}</div>
                <div className="pc-codex-unknown__meta">
                  <span>Sequence {record.sequence}</span>
                  {record.turnId && <span>Turn {record.turnId}</span>}
                  {record.itemId && <span>Item {record.itemId}</span>}
                  <time dateTime={new Date(record.emittedAtMs).toISOString()}>
                    {new Date(record.emittedAtMs).toLocaleTimeString()}
                  </time>
                </div>
                <RecordedParameters
                  method={record.method}
                  value={record.params}
                  metadataOnly={metadataOnly}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function RecordedParameters({
  method,
  value,
  metadataOnly = false,
}: {
  method: string;
  value: unknown;
  metadataOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <div className="pc-codex-unknown__parameters">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={
          method +
          (metadataOnly ? " safe metadata, " : " recorded parameters, ") +
          (open ? "collapse" : "expand")
        }
        onClick={() => setOpen((current) => !current)}
      >
        {metadataOnly ? "Safe metadata" : "Recorded parameters"}
      </button>
      {open && (
        <pre
          id={detailsId}
          role="region"
          aria-label={method + (metadataOnly ? " safe metadata" : " recorded parameters")}
        >
          {safeJson(sanitizeCodexInspectorValue(value))}
        </pre>
      )}
    </div>
  );
}

function ReasoningActivity({ reasoning }: { reasoning: CodexReasoningSummary }) {
  return (
    <ActivityDisclosure
      title="Reasoning summary"
      status={activityStatusLabel(reasoning.status)}
      action="summary"
    >
      <ol className="pc-codex-reasoning__parts">
        {reasoning.parts.map((part, index) => (
          <li key={index}>{part}</li>
        ))}
      </ol>
    </ActivityDisclosure>
  );
}

function CommandActivity({ command }: { command: CodexCommandActivity }) {
  const title = command.command ?? "Command";
  const status = activityStatusLabel(command.status);
  return (
    <ActivityDisclosure title={title} status={status} action="output">
      <div className="pc-codex-activity__meta">
        {command.cwd && <span>Working directory: {command.cwd}</span>}
        {command.exitCode !== undefined && <span>Exit code: {command.exitCode}</span>}
        {command.durationMs !== undefined && <span>Duration: {command.durationMs} ms</span>}
        {command.terminalInteractionCount > 0 && (
          <span>Terminal input sent {command.terminalInteractionCount} time(s)</span>
        )}
      </div>
      {command.truncatedChars > 0 && (
        <p className="pc-codex-activity__truncated">
          {command.truncatedChars.toLocaleString("en-US")} earlier output characters omitted.
        </p>
      )}
      <PlainOutput
        text={command.output}
        error={command.status === "failed"}
        interrupted={command.status === "interrupted"}
      />
    </ActivityDisclosure>
  );
}

function FileChangeActivity({ fileChange }: { fileChange: CodexFileChangeActivity }) {
  const count = fileChange.changes.length;
  const title = "Changed " + count + " " + (count === 1 ? "file" : "files");
  return (
    <ActivityDisclosure
      title={title}
      status={activityStatusLabel(fileChange.status)}
      action="changes"
    >
      <div className="pc-codex-file-changes">
        {fileChange.changes.map((change, index) => (
          <section className="pc-codex-file-change" key={change.path + ":" + index}>
            <div className="pc-codex-file-change__path">
              {change.path}
              {change.kind && <span>{change.kind}</span>}
            </div>
            {change.diff && <DiffView text={change.diff} />}
          </section>
        ))}
      </div>
    </ActivityDisclosure>
  );
}

function McpActivity({ mcpCall }: { mcpCall: CodexMcpActivity }) {
  const title = [mcpCall.server, mcpCall.tool].filter(Boolean).join(" / ") || "MCP tool call";
  return (
    <div className="pc-codex-mcp">
      {mcpCall.progress && <div className="pc-codex-mcp__progress">{mcpCall.progress}</div>}
      <ActivityDisclosure
        title={title}
        status={activityStatusLabel(mcpCall.status)}
        action="details"
      >
        {mcpCall.durationMs !== undefined && (
          <div className="pc-codex-activity__meta">Duration: {mcpCall.durationMs} ms</div>
        )}
        {mcpCall.arguments !== undefined && (
          <RecordedValue label="Arguments" value={mcpCall.arguments} />
        )}
        {mcpCall.result !== undefined && <RecordedValue label="Result" value={mcpCall.result} />}
        {mcpCall.error !== undefined && <RecordedValue label="Error" value={mcpCall.error} error />}
      </ActivityDisclosure>
    </div>
  );
}

function RecordedValue({
  label,
  value,
  error = false,
}: {
  label: string;
  value: unknown;
  error?: boolean;
}) {
  return (
    <div className="pc-codex-recorded-value">
      <div className="pc-codex-activity__title">{label}</div>
      <PlainOutput text={safeJson(sanitizeCodexInspectorValue(value))} error={error} />
    </div>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "Unable to display recorded parameters.";
  }
}

function ActivityDisclosure({
  title,
  status,
  action,
  children,
}: {
  title: string;
  status: string;
  action: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <div className={"pc-toolcall " + (status === "running" ? "pc-toolcall--active" : "")}>
      <button
        type="button"
        className="pc-toolcall__head"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={title + ", " + status + ", " + (open ? "collapse " : "expand ") + action}
        onClick={() => setOpen((current) => !current)}
      >
        <span
          aria-hidden="true"
          className={
            "pc-dot " +
            (status === "running"
              ? "pc-dot--warn"
              : status === "failed"
                ? "pc-dot--danger"
                : status === "unknown"
                  ? "pc-dot--warn"
                  : "pc-dot--success")
          }
        />
        <span className="pc-toolcall__name min-w-0">{title}</span>
        <span className="pc-codex-activity__status shrink-0 whitespace-nowrap">{status}</span>
        <span className="ml-auto shrink-0 text-faint" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div
          id={detailsId}
          className="pc-toolcall__body"
          role="region"
          aria-label={title + " details"}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function activityStatusLabel(status: string): string {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  if (status === "running") return "running";
  if (status === "updated") return "updated";
  return "unknown";
}

function PlanActivity({ plan }: { plan: NonNullable<CodexTurnActivity["plan"]> }) {
  const titleId = useId();

  return (
    <section className="pc-codex-plan" aria-labelledby={titleId}>
      <div id={titleId} className="pc-codex-activity__title">
        {plan.finalText ? "Last structured plan update" : "Plan"}
      </div>
      {plan.explanation && <p className="pc-codex-plan__explanation">{plan.explanation}</p>}
      <ol className="pc-codex-plan__steps">
        {plan.steps.map((step, index) => (
          <li className="pc-codex-plan__step" key={index}>
            <span className={"pc-codex-plan__marker pc-codex-plan__marker--" + step.status} />
            <span className="min-w-0 flex-1">{step.text}</span>
            <span className="pc-codex-plan__status">{planStatusLabel(step)}</span>
          </li>
        ))}
      </ol>
      {plan.draftText && !plan.finalText && (
        <div className="pc-codex-plan__final">
          <div className="pc-codex-activity__title">Plan draft</div>
          <p>{plan.draftText}</p>
        </div>
      )}
      {plan.finalText !== undefined && (
        <div className="pc-codex-plan__final">
          <div className="pc-codex-activity__title">Final plan</div>
          <p>{plan.finalText}</p>
        </div>
      )}
    </section>
  );
}

function planStatusLabel(step: CodexPlanStep): string {
  if (step.status === "inProgress") return "In progress";
  if (step.status === "completed") return "Completed";
  return "Pending";
}
