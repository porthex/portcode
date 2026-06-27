import { useStore } from "../store/store";
import type { AgentInfo, AgentStatus } from "../types";

/**
 * Live agents panel — the subagents (the `task` tool) the current turn launched.
 *
 * Driven entirely by the store's per-session `agents` map (populated by the
 * `agent_started` / `agent_progress` / `agent_finished` lifecycle events). Each
 * row shows the subagent's description, a live status, and — while it is still
 * running — a Stop button that cancels just that subagent (and its descendants),
 * leaving the rest of the turn alone. Renders nothing when the active session has
 * no subagents, so it costs nothing on an ordinary turn.
 */
export function AgentsPanel() {
  const agents = useStore((s) => (s.activeId ? s.agents[s.activeId] : undefined));
  const cancelAgent = useStore((s) => s.cancelAgent);

  if (!agents || agents.length === 0) return null;

  const running = agents.filter((a) => a.status === "running").length;

  return (
    <section
      aria-label="Subagents"
      className="mx-3 mb-2 overflow-hidden rounded-md border border-border bg-panel"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] uppercase tracking-wide text-faint">
        <span
          className={`pc-dot ${running > 0 ? "pc-dot--ring" : "pc-dot--success"}`}
          aria-hidden="true"
        />
        {running > 0
          ? `${running} subagent${running === 1 ? "" : "s"} running`
          : `${agents.length} subagent${agents.length === 1 ? "" : "s"}`}
      </div>
      <ul className="max-h-40 overflow-auto">
        {agents.map((a) => (
          <AgentRow key={a.id} agent={a} onStop={() => void cancelAgent(a.id)} />
        ))}
      </ul>
    </section>
  );
}

/** Human label + colour for a subagent's terminal/live state. */
function statusMeta(status: AgentStatus): { label: string; dot: string; text: string } {
  switch (status) {
    case "running":
      return { label: "running", dot: "pc-dot--ring", text: "text-accent-2" };
    case "ok":
      return { label: "done", dot: "pc-dot--success", text: "text-success" };
    case "cancelled":
      return { label: "stopped", dot: "pc-dot--success", text: "text-faint" };
    case "error":
      return { label: "error", dot: "bg-danger", text: "text-danger" };
  }
}

function AgentRow({ agent, onStop }: { agent: AgentInfo; onStop: () => void }) {
  const running = agent.status === "running";
  const meta = statusMeta(agent.status);
  // While running, show liveness (the turn count); once finished, the outcome.
  const detail = running ? (agent.step > 0 ? `step ${agent.step}` : "starting") : meta.label;

  return (
    <li className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
      <span className={`pc-dot ${meta.dot}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-fg" title={agent.description}>
        {agent.description}
      </span>
      <span className={`font-mono text-[10px] ${meta.text}`}>{detail}</span>
      {running && (
        <button
          type="button"
          onClick={onStop}
          aria-label={`Stop subagent: ${agent.description}`}
          className="rounded border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-faint transition-colors hover:border-danger hover:text-danger motion-reduce:transition-none"
        >
          Stop
        </button>
      )}
    </li>
  );
}
