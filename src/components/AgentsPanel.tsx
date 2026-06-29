import { useEffect, useState } from "react";
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
 *
 * The panel is collapsible (accordion, grid 0fr→1fr) so it doesn't push the
 * composer down when many subagents are active. It auto-opens whenever any agent
 * is running and can be collapsed manually by the user.
 */
export function AgentsPanel() {
  const agents = useStore((s) => (s.activeId ? s.agents[s.activeId] : undefined));
  const cancelAgent = useStore((s) => s.cancelAgent);

  const [open, setOpen] = useState(false);

  const running = agents ? agents.filter((a) => a.status === "running").length : 0;

  // Auto-open when subagents start running; leave user's choice alone when all
  // are terminal.
  useEffect(() => {
    if (running > 0) setOpen(true);
  }, [running]);

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
          className={`pc-dot ${running > 0 ? "pc-dot--ring" : "pc-dot--success"}`}
          aria-hidden="true"
        />
        <span className="flex-1 text-left">
          {running > 0
            ? `${running} subagent${running === 1 ? "" : "s"} running`
            : `${agents.length} subagent${agents.length === 1 ? "" : "s"}`}
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
          <ul className="max-h-40 overflow-auto" aria-hidden={!open}>
            {agents.map((a) => (
              <AgentRow key={a.id} agent={a} onStop={() => void cancelAgent(a.id)} />
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
