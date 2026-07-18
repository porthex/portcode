import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/store";
import { buildAgentTree, type AgentBranchInfo } from "../lib/agentTree";
import type { AgentInfo, AgentStatus } from "../types";

/**
 * Live agents panel — the subagents (`delegate_task`) the current turn launched.
 *
 * Driven entirely by the store's per-session `agents` map (populated by the
 * `agent_started` / `agent_progress` / `agent_finished` lifecycle events). Each
 * row shows the subagent's description, a live status, and — while it is still
 * running — a Stop button that cancels just that subagent (and its descendants),
 * leaving the rest of the turn alone. Renders nothing when the active session has
 * no subagents, so it costs nothing on an ordinary turn.
 *
 * The panel is collapsible (accordion, grid 0fr→1fr) so it doesn't push the
 * composer down when many subagents are active. It auto-opens whenever any agent
 * is running and can be collapsed manually by the user.
 */
export function AgentsPanel() {
  const activeId = useStore((s) => s.activeId);
  const agents = useStore((s) => (s.activeId ? s.agents[s.activeId] : undefined));
  const cancelAgent = useStore((s) => s.cancelAgent);

  const [open, setOpen] = useState(false);
  const previousRun = useRef<{ activeId: string | null; running: number }>({
    activeId: null,
    running: 0,
  });

  const running = agents ? agents.filter((a) => a.status === "running").length : 0;
  const failed = agents ? agents.filter((a) => a.status === "error").length : 0;
  const completed = agents ? agents.filter((a) => a.status === "ok").length : 0;
  const stopped = agents ? agents.filter((a) => a.status === "cancelled").length : 0;
  const agentTree = useMemo(() => buildAgentTree(agents ?? []), [agents]);

  // Open for a newly selected live run and when a run transitions from idle to
  // active. Do not reopen merely because another sibling starts: once the user
  // has collapsed a busy panel, that choice should remain stable.
  useEffect(() => {
    const sessionChanged = previousRun.current.activeId !== activeId;
    const runStarted = previousRun.current.running === 0 && running > 0;
    if (sessionChanged) setOpen(running > 0);
    else if (runStarted) setOpen(true);
    previousRun.current = { activeId, running };
  }, [activeId, running]);

  if (!agents || agents.length === 0) return null;

  return (
    <section
      aria-label="Subagents"
      className="mx-3 mb-2 overflow-hidden rounded-md border border-border bg-panel"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] uppercase tracking-wide text-faint transition-colors hover:text-fg motion-reduce:transition-none"
      >
        <span
          className={`pc-dot ${
            running > 0 ? "pc-dot--ring" : failed > 0 ? "bg-danger" : "pc-dot--success"
          }`}
          aria-hidden="true"
        />
        <span className="flex-1 text-left">
          {running > 0
            ? `${running} subagent${running === 1 ? "" : "s"} running`
            : `${agents.length} subagent${agents.length === 1 ? "" : "s"}`}
        </span>
        <span className="font-mono text-[9px] normal-case tracking-normal text-muted">
          {running > 0
            ? `${agents.length} total`
            : failed > 0
              ? `${failed} failed`
              : stopped > 0
                ? `${completed} done · ${stopped} stopped`
                : "all done"}
        </span>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {/* Smooth expand/collapse via a grid 0fr->1fr accordion (the overflow-hidden
          child can shrink to 0). The ul stays mounted so it animates both ways. */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <ul
            className="max-h-48 overflow-auto py-0.5"
            aria-label="Agent activity"
            aria-hidden={!open}
            inert={!open}
          >
            {agentTree.map((branch) => (
              <AgentBranch key={branch.agent.id} branch={branch} depth={0} onStop={cancelAgent} />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** Human label + colour for a subagent's terminal/live state. */
function statusMeta(status: AgentStatus): { label: string; dot: string; text: string } {
  switch (status) {
    case "running":
      return { label: "working", dot: "pc-dot--ring", text: "text-accent-2" };
    case "ok":
      return { label: "completed", dot: "pc-dot--success", text: "text-success" };
    case "cancelled":
      return { label: "stopped", dot: "pc-dot--success", text: "text-faint" };
    case "error":
      return { label: "failed", dot: "bg-danger", text: "text-danger" };
  }
}

function AgentBranch({
  branch,
  depth,
  onStop,
}: {
  branch: AgentBranchInfo;
  depth: number;
  onStop: (agentId: string) => Promise<void>;
}) {
  return (
    <li>
      <AgentRow agent={branch.agent} depth={depth} onStop={() => onStop(branch.agent.id)} />
      {branch.children.length > 0 && (
        <ul aria-label={`Subagents of ${branch.agent.description}`}>
          {branch.children.map((child) => (
            <AgentBranch key={child.agent.id} branch={child} depth={depth + 1} onStop={onStop} />
          ))}
        </ul>
      )}
    </li>
  );
}

type StopFeedback = "idle" | "stopping" | "retry";

function AgentRow({
  agent,
  depth,
  onStop,
}: {
  agent: AgentInfo;
  depth: number;
  onStop: () => Promise<void>;
}) {
  const running = agent.status === "running";
  const meta = statusMeta(agent.status);
  const [stopFeedback, setStopFeedback] = useState<StopFeedback>("idle");
  const retryTimer = useRef<number | null>(null);
  const runningRef = useRef(running);

  useEffect(() => {
    runningRef.current = running;
    if (!running) {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
      setStopFeedback("idle");
    }
  }, [running]);

  useEffect(
    () => () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    },
    [],
  );

  const requestStop = async () => {
    if (stopFeedback === "stopping") return;
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    retryTimer.current = null;
    setStopFeedback("stopping");
    try {
      await onStop();
      // The lifecycle event is authoritative. If it never arrives, return the
      // affordance after a short acknowledgement window so cancellation can be
      // retried instead of leaving a permanently disabled button.
      if (runningRef.current) {
        retryTimer.current = window.setTimeout(() => {
          if (runningRef.current) setStopFeedback("retry");
        }, 5_000);
      }
    } catch {
      setStopFeedback("retry");
    }
  };

  // While running, show liveness (the turn count); once finished, the outcome.
  const detail = !running
    ? meta.label
    : stopFeedback === "stopping"
      ? "stopping"
      : stopFeedback === "retry"
        ? "still running"
        : agent.step > 0
          ? `step ${agent.step}`
          : "starting";

  return (
    <div
      className="group flex min-h-8 items-center gap-2 py-1 pr-2 text-[12px]"
      style={{ paddingLeft: 12 + depth * 14 }}
      aria-label={`${agent.description}, ${detail}`}
    >
      {depth > 0 && (
        <span className="w-2 shrink-0 text-center text-[10px] text-border" aria-hidden="true">
          ↳
        </span>
      )}
      <span className={`pc-dot ${meta.dot}`} aria-hidden="true" />
      <span
        className={`min-w-0 flex-1 truncate ${agent.status === "cancelled" ? "text-muted" : "text-fg"}`}
        title={agent.description}
      >
        {agent.description}
      </span>
      <span className={`font-mono text-[10px] ${meta.text}`} aria-live="polite">
        {detail}
      </span>
      {running && (
        <button
          type="button"
          onClick={() => void requestStop()}
          disabled={stopFeedback === "stopping"}
          aria-label={`${
            stopFeedback === "stopping"
              ? "Stopping"
              : stopFeedback === "retry"
                ? "Retry stop"
                : "Stop"
          } subagent: ${agent.description}`}
          title={stopFeedback === "retry" ? "Stop was not confirmed. Try again." : undefined}
          className="rounded border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-faint transition-colors hover:border-danger hover:text-danger disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
        >
          {stopFeedback === "stopping"
            ? "Stopping…"
            : stopFeedback === "retry"
              ? "Retry stop"
              : "Stop"}
        </button>
      )}
    </div>
  );
}
