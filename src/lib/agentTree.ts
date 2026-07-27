import type { AgentInfo } from "../types";

export interface AgentBranchInfo {
  agent: AgentInfo;
  children: AgentBranchInfo[];
}

export interface AgentSummary {
  total: number;
  roots: number;
  children: number;
  running: number;
  completed: number;
  stopped: number;
  failed: number;
  unknown: number;
}

/**
 * Convert the event-order agent list into a stable forest. Orphans remain
 * visible as roots and the ancestry guard prevents malformed parent cycles from
 * taking down an activity surface.
 */
export function buildAgentTree(agents: AgentInfo[]): AgentBranchInfo[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const children = new Map<string, AgentInfo[]>();
  const roots: AgentInfo[] = [];

  for (const agent of agents) {
    const hasParent =
      agent.parentId !== undefined && agent.parentId !== agent.id && byId.has(agent.parentId);
    if (!hasParent) {
      roots.push(agent);
      continue;
    }
    const siblings = children.get(agent.parentId!) ?? [];
    siblings.push(agent);
    children.set(agent.parentId!, siblings);
  }

  const visited = new Set<string>();
  const expand = (agent: AgentInfo, ancestry: Set<string>): AgentBranchInfo | null => {
    if (ancestry.has(agent.id) || visited.has(agent.id)) return null;
    visited.add(agent.id);
    const nextAncestry = new Set(ancestry).add(agent.id);
    return {
      agent,
      children: (children.get(agent.id) ?? [])
        .map((child) => expand(child, nextAncestry))
        .filter((child): child is AgentBranchInfo => child !== null),
    };
  };

  const forest = roots
    .map((agent) => expand(agent, new Set()))
    .filter((branch): branch is AgentBranchInfo => branch !== null);

  // A parent cycle has no natural root. Surface each still-unvisited member at
  // top level once instead of hiding the whole malformed branch.
  for (const agent of agents) {
    if (visited.has(agent.id)) continue;
    const branch = expand(agent, new Set());
    if (branch) forest.push(branch);
  }
  return forest;
}

/** Counts used by both the detailed panel and the compact title-bar overview. */
export function summarizeAgents(
  agents: AgentInfo[],
  forest: AgentBranchInfo[] = buildAgentTree(agents),
): AgentSummary {
  const status = { running: 0, completed: 0, stopped: 0, failed: 0, unknown: 0 };
  for (const agent of agents) {
    if (agent.status === "running") status.running += 1;
    else if (agent.status === "ok") status.completed += 1;
    else if (agent.status === "cancelled") status.stopped += 1;
    else if (agent.status === "error") status.failed += 1;
    else status.unknown += 1;
  }
  return {
    total: agents.length,
    roots: forest.length,
    children: Math.max(0, agents.length - forest.length),
    ...status,
  };
}

/**
 * Keep live and failed work visible. Successful/cancelled leaf branches are
 * omitted until requested, while terminal ancestors stay when they provide
 * context for a visible descendant.
 */
export function visibleAgentTree(
  forest: AgentBranchInfo[],
  includeFinished: boolean,
): AgentBranchInfo[] {
  if (includeFinished) return forest;

  const filterBranch = (branch: AgentBranchInfo): AgentBranchInfo | null => {
    const children = branch.children
      .map(filterBranch)
      .filter((child): child is AgentBranchInfo => child !== null);
    const visible =
      branch.agent.status === "running" ||
      branch.agent.status === "error" ||
      branch.agent.status === "unknown";
    return visible || children.length > 0 ? { agent: branch.agent, children } : null;
  };

  return forest.map(filterBranch).filter((branch): branch is AgentBranchInfo => branch !== null);
}
