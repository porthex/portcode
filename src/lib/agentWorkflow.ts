import { summarizeAgents } from "./agentTree";
import type { AgentInfo } from "../types";

export type AgentWorkflowPhase =
  | "launching"
  | "running"
  | "converging"
  | "collecting"
  | "completed"
  | "failed"
  | "stopped"
  | "attention";

export interface AgentWorkflowSummary {
  title: "Codex swarm";
  phase: AgentWorkflowPhase;
  phaseLabel: string;
  statusLine: string;
  guidance: string;
  total: number;
  running: number;
  completed: number;
  stopped: number;
  failed: number;
  unknown: number;
}

export interface AgentWorkflowOptions {
  rootActive?: boolean;
}

const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Project exact child lifecycle into bounded, user-facing workflow copy.
 * Raw descriptions/results intentionally stay out of this primary-chat summary.
 */
export function projectAgentWorkflow(
  agents: readonly AgentInfo[],
  options: AgentWorkflowOptions = {},
): AgentWorkflowSummary | undefined {
  if (agents.length === 0) return undefined;

  const counts = summarizeAgents([...agents]);
  const terminal = counts.completed + counts.stopped + counts.failed + counts.unknown;
  let phase: AgentWorkflowPhase;

  if (counts.running > 0) {
    phase =
      terminal > 0
        ? "converging"
        : agents.every((agent) => agent.step === 0)
          ? "launching"
          : "running";
  } else if (
    options.rootActive &&
    counts.failed === 0 &&
    counts.stopped === 0 &&
    counts.unknown === 0
  ) {
    phase = "collecting";
  } else if (counts.failed > 0) {
    phase = "failed";
  } else if (counts.unknown > 0) {
    phase = "attention";
  } else if (counts.completed > 0) {
    phase = counts.stopped > 0 ? "stopped" : "completed";
  } else {
    phase = "stopped";
  }

  const phaseCopy: Record<
    AgentWorkflowPhase,
    Pick<AgentWorkflowSummary, "phaseLabel" | "statusLine" | "guidance">
  > = {
    launching: {
      phaseLabel: "Launching",
      statusLine: `Launching ${countLabel(counts.total, "agent")}`,
      guidance: "The swarm is starting in the background. Portcode will update this card live.",
    },
    running: {
      phaseLabel: "Running",
      statusLine: `${counts.running} of ${countLabel(counts.total, "agent")} running`,
      guidance: "The swarm is running in the background. Portcode will report when results land.",
    },
    converging: {
      phaseLabel: "Converging",
      statusLine: `${terminal} of ${countLabel(counts.total, "agent")} finished`,
      guidance: "Results are landing while the remaining agents continue in the background.",
    },
    collecting: {
      phaseLabel: "Collecting results",
      statusLine: `${countLabel(counts.total, "agent")} finished · preparing response`,
      guidance:
        "The swarm has finished. Portcode is collecting the results for the final response.",
    },
    completed: {
      phaseLabel: "Completed",
      statusLine: `All ${countLabel(counts.total, "agent")} completed`,
      guidance: "The swarm finished successfully.",
    },
    failed: {
      phaseLabel: "Failed",
      statusLine: `${counts.failed} of ${countLabel(counts.total, "agent")} failed`,
      guidance: "The swarm finished with failures. Open the agent inspector for details.",
    },
    stopped: {
      phaseLabel: "Stopped",
      statusLine: "Swarm stopped",
      guidance: "The swarm stopped before every agent completed.",
    },
    attention: {
      phaseLabel: "Needs attention",
      statusLine: "Swarm status needs attention",
      guidance: "One or more agent outcomes are unknown. Open the agent inspector for details.",
    },
  };

  return {
    title: "Codex swarm",
    phase,
    ...phaseCopy[phase],
    total: counts.total,
    running: counts.running,
    completed: counts.completed,
    stopped: counts.stopped,
    failed: counts.failed,
    unknown: counts.unknown,
  };
}
