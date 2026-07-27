import { describe, expect, it } from "vitest";

import { projectAgentWorkflow } from "./agentWorkflow";
import type { AgentInfo } from "../types";

const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "agent-1",
  description: "Build the requested feature",
  status: "running",
  step: 0,
  ...over,
});

describe("projectAgentWorkflow", () => {
  it("returns no workflow for an ordinary turn", () => {
    expect(projectAgentWorkflow([])).toBeUndefined();
  });

  it("projects an honest launching phase before any child turn starts", () => {
    expect(
      projectAgentWorkflow([
        agent(),
        agent({ id: "agent-2", description: "Review the implementation" }),
      ]),
    ).toMatchObject({
      title: "Codex swarm",
      phase: "launching",
      phaseLabel: "Launching",
      total: 2,
      running: 2,
      completed: 0,
      statusLine: "Launching 2 agents",
    });
  });

  it("moves from running to converging from observable child lifecycle only", () => {
    expect(
      projectAgentWorkflow([agent({ step: 1 }), agent({ id: "agent-2", step: 2 })]),
    ).toMatchObject({
      phase: "running",
      phaseLabel: "Running",
      statusLine: "2 of 2 agents running",
    });

    expect(
      projectAgentWorkflow([agent({ status: "ok", step: 2 }), agent({ id: "agent-2", step: 1 })]),
    ).toMatchObject({
      phase: "converging",
      phaseLabel: "Converging",
      running: 1,
      completed: 1,
      statusLine: "1 of 2 agents finished",
    });
  });

  it("shows collecting only when every child is terminal and the root remains active", () => {
    const finished = [
      agent({ status: "ok", step: 2 }),
      agent({ id: "agent-2", status: "ok", step: 1 }),
    ];

    expect(projectAgentWorkflow(finished, { rootActive: true })).toMatchObject({
      phase: "collecting",
      phaseLabel: "Collecting results",
      statusLine: "2 agents finished · preparing response",
    });
    expect(projectAgentWorkflow(finished, { rootActive: false })).toMatchObject({
      phase: "completed",
      phaseLabel: "Completed",
      statusLine: "All 2 agents completed",
      guidance: "The swarm finished successfully.",
    });
  });

  it("never infers success across failed, stopped, or unknown terminal states", () => {
    expect(
      projectAgentWorkflow([agent({ status: "ok" }), agent({ id: "failed", status: "error" })]),
    ).toMatchObject({
      phase: "failed",
      failed: 1,
      statusLine: "1 of 2 agents failed",
      guidance: "The swarm finished with failures. Open the agent inspector for details.",
    });

    expect(
      projectAgentWorkflow([agent({ status: "cancelled" })], { rootActive: true }),
    ).toMatchObject({
      phase: "stopped",
      stopped: 1,
      statusLine: "Swarm stopped",
    });

    expect(projectAgentWorkflow([agent({ status: "unknown" })])).toMatchObject({
      phase: "attention",
      unknown: 1,
      statusLine: "Swarm status needs attention",
      guidance: "One or more agent outcomes are unknown. Open the agent inspector for details.",
    });
  });

  it("keeps untrusted child descriptions out of the primary workflow copy", () => {
    const privatePrompt = "SECRET child prompt at C:\\private\\repo";
    const workflow = projectAgentWorkflow([agent({ description: privatePrompt, step: 1 })]);
    const serialized = JSON.stringify(workflow);

    expect(serialized).not.toContain(privatePrompt);
    expect(serialized).not.toContain("C:\\private\\repo");
  });
});
