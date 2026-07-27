import { describe, expect, it } from "vitest";

import type { AgentInfo } from "../types";
import { buildAgentTree, summarizeAgents, visibleAgentTree } from "./agentTree";

const agent = (overrides: Partial<AgentInfo> & Pick<AgentInfo, "id">): AgentInfo => ({
  description: overrides.id,
  status: "running",
  step: 0,
  ...overrides,
});

describe("agentTree", () => {
  it("preserves event order and nests known parents", () => {
    const forest = buildAgentTree([
      agent({ id: "root-a" }),
      agent({ id: "child-a", parentId: "root-a" }),
      agent({ id: "root-b" }),
      agent({ id: "child-b", parentId: "root-a" }),
    ]);

    expect(forest.map((branch) => branch.agent.id)).toEqual(["root-a", "root-b"]);
    expect(forest[0].children.map((branch) => branch.agent.id)).toEqual(["child-a", "child-b"]);
  });

  it("promotes orphans/self-parents and safely surfaces cycles", () => {
    const forest = buildAgentTree([
      agent({ id: "orphan", parentId: "missing" }),
      agent({ id: "self", parentId: "self" }),
      agent({ id: "a", parentId: "b" }),
      agent({ id: "b", parentId: "a" }),
    ]);
    const flattened = forest.flatMap((root) => [
      root.agent.id,
      ...root.children.map((c) => c.agent.id),
    ]);

    expect(flattened).toEqual(["orphan", "self", "a", "b"]);
  });

  it("summarizes status and root/child scale", () => {
    const agents = [
      agent({ id: "root" }),
      agent({ id: "child", parentId: "root", status: "ok" }),
      agent({ id: "stopped", status: "cancelled" }),
      agent({ id: "failed", status: "error" }),
      agent({ id: "unknown", status: "unknown" }),
    ];

    expect(summarizeAgents(agents)).toEqual({
      total: 5,
      roots: 4,
      children: 1,
      running: 1,
      completed: 1,
      stopped: 1,
      failed: 1,
      unknown: 1,
    });
  });

  it("hides finished leaves but keeps a finished ancestor of live work", () => {
    const forest = buildAgentTree([
      agent({ id: "done-root", status: "ok" }),
      agent({ id: "context", status: "ok" }),
      agent({ id: "live-child", parentId: "context" }),
      agent({ id: "failed", status: "error" }),
      agent({ id: "stopped", status: "cancelled" }),
      agent({ id: "unknown", status: "unknown" }),
    ]);

    const compact = visibleAgentTree(forest, false);
    expect(compact.map((branch) => branch.agent.id)).toEqual(["context", "failed", "unknown"]);
    expect(compact[0].children[0].agent.id).toBe("live-child");
    expect(visibleAgentTree(forest, true)).toBe(forest);
  });
});
