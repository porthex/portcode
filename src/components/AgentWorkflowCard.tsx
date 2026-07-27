import { useEffect, useMemo, useState } from "react";

import { projectAgentWorkflow } from "../lib/agentWorkflow";
import type { AgentInfo } from "../types";

export interface AgentWorkflowCardProps {
  agents: readonly AgentInfo[];
  rootActive: boolean;
  startedAt?: number | null;
  durationMs?: number | null;
}

/** Compact primary-chat summary for one exact-turn delegated workflow. */
export function AgentWorkflowCard({
  agents,
  rootActive,
  startedAt = null,
  durationMs = null,
}: AgentWorkflowCardProps) {
  const workflow = useMemo(
    () => projectAgentWorkflow(agents, { rootActive }),
    [agents, rootActive],
  );
  const live = Boolean(workflow && rootActive && startedAt !== null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live, startedAt]);

  if (!workflow) return null;

  const elapsedMs =
    durationMs ?? (live && startedAt !== null ? Math.max(0, now - startedAt) : null);
  const finished = workflow.completed + workflow.stopped + workflow.failed + workflow.unknown;
  const progress = Math.max(0, Math.min(100, Math.round((finished / workflow.total) * 100)));

  return (
    <section
      className={`pc-agent-workflow pc-agent-workflow--${workflow.phase}`}
      role="region"
      aria-label="Codex swarm workflow"
      data-phase={workflow.phase}
    >
      <div className="pc-agent-workflow__signal" aria-hidden="true">
        <span className="pc-agent-workflow__signal-core" />
      </div>
      <div className="pc-agent-workflow__body">
        <div className="pc-agent-workflow__head">
          <span className="pc-agent-workflow__eyebrow">Workflow</span>
          <span className="pc-agent-workflow__phase">{workflow.phaseLabel}</span>
        </div>
        <div className="pc-agent-workflow__title-row">
          <strong className="pc-agent-workflow__title">{workflow.title}</strong>
          <span className="pc-agent-workflow__meta">
            {workflow.total} {workflow.total === 1 ? "agent" : "agents"}
            {elapsedMs !== null && (
              <span className="pc-agent-workflow__elapsed" aria-hidden="true">
                {formatElapsed(elapsedMs)}
              </span>
            )}
          </span>
        </div>
        <div className="pc-agent-workflow__progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
        <p className="pc-agent-workflow__status">{workflow.statusLine}</p>
        <p className="pc-agent-workflow__guidance">{workflow.guidance}</p>
      </div>
      {rootActive && (
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {workflow.phaseLabel}. {workflow.statusLine}.
        </span>
      )}
    </section>
  );
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}
