import { useEffect, useMemo, useState } from "react";

import { projectAgentWorkflow } from "../lib/agentWorkflow";
import type { AgentInfo } from "../types";

export interface AgentWorkflowCardProps {
  agents: readonly AgentInfo[];
  rootActive: boolean;
  startedAt?: number | null;
  durationMs?: number | null;
}

type AgentForgeState = "launching" | "running" | "completed" | "failed" | "stopped" | "attention";

const MAX_VISIBLE_AGENTS = 6;

const forgeStateLabel: Record<AgentForgeState, string> = {
  launching: "Launching",
  running: "Working",
  completed: "Complete",
  failed: "Failed",
  stopped: "Stopped",
  attention: "Attention",
};

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
  const visibleAgents = agents.slice(0, MAX_VISIBLE_AGENTS);
  const overflowCount = Math.max(0, agents.length - visibleAgents.length);

  return (
    <section
      className={`pc-agent-workflow pc-agent-workflow--${workflow.phase}`}
      role="region"
      aria-label="Codex swarm workflow"
      data-phase={workflow.phase}
    >
      <div className="pc-agent-workflow__head">
        <div className="pc-agent-workflow__identity">
          <strong className="pc-agent-workflow__title">{workflow.title}</strong>
          <span className="pc-agent-workflow__phase">{workflow.phaseLabel}</span>
        </div>
        <span className="pc-agent-workflow__meta">
          {workflow.total} {workflow.total === 1 ? "agent" : "agents"}
          {elapsedMs !== null && (
            <span className="pc-agent-workflow__elapsed" aria-hidden="true">
              {formatElapsed(elapsedMs)}
            </span>
          )}
        </span>
      </div>
      <ul
        className="pc-agent-forge"
        aria-label={`${workflow.total} delegated ${workflow.total === 1 ? "agent" : "agents"}`}
      >
        {visibleAgents.map((agent, index) => {
          const state = forgeState(agent);
          return (
            <li className="pc-agent-forge__agent" data-agent-state={state} key={agent.id}>
              <span className="pc-agent-forge__cube" data-testid="agent-cube" aria-hidden="true">
                <span className="pc-agent-forge__face pc-agent-forge__face--top" />
                <span className="pc-agent-forge__face pc-agent-forge__face--left" />
                <span className="pc-agent-forge__face pc-agent-forge__face--right" />
                <span className="pc-agent-forge__core" />
              </span>
              <span className="pc-agent-forge__copy">
                <span className="pc-agent-forge__label">Agent {index + 1}</span>
                <span className="pc-agent-forge__state">{forgeStateLabel[state]}</span>
              </span>
            </li>
          );
        })}
        {overflowCount > 0 && (
          <li
            className="pc-agent-forge__agent pc-agent-forge__agent--overflow"
            aria-label={`${overflowCount} more delegated ${overflowCount === 1 ? "agent" : "agents"}`}
          >
            <span className="pc-agent-forge__cluster" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="pc-agent-forge__copy">
              <span className="pc-agent-forge__label">+{overflowCount}</span>
              <span className="pc-agent-forge__state">More</span>
            </span>
          </li>
        )}
      </ul>
      <p className="pc-agent-workflow__status">{workflow.statusLine}</p>
      <p className="pc-agent-workflow__guidance">{workflow.guidance}</p>
      {rootActive && (
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {workflow.phaseLabel}. {workflow.statusLine}.
        </span>
      )}
    </section>
  );
}

function forgeState(agent: AgentInfo): AgentForgeState {
  if (agent.status === "running") return agent.step === 0 ? "launching" : "running";
  if (agent.status === "ok") return "completed";
  if (agent.status === "error") return "failed";
  if (agent.status === "cancelled") return "stopped";
  return "attention";
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
