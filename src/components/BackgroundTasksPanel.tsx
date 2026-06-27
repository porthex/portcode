import { useStore } from "../store/store";
import type { BackgroundTaskInfo, BackgroundTaskStatus } from "../types";

/**
 * Background tasks panel — the `shell` commands the current session launched in
 * the background (the `shell` tool's `background` mode).
 *
 * Driven by the store's per-session `backgroundTasks` map, which a PERSISTENT
 * session listener populates (the `background_task_started` / `_finished`
 * lifecycle events ride the session channel and can land after the launching
 * turn ended). Unlike subagents, these tasks deliberately outlive the turn, so
 * the panel persists running and recently-finished tasks until the session is
 * gone. Renders nothing when the active session launched none.
 */
export function BackgroundTasksPanel() {
  const tasks = useStore((s) => (s.activeId ? s.backgroundTasks[s.activeId] : undefined));

  if (!tasks || tasks.length === 0) return null;

  const running = tasks.filter((t) => t.status === "running").length;

  return (
    <section
      aria-label="Background tasks"
      className="mx-3 mb-2 overflow-hidden rounded-md border border-border bg-panel"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] uppercase tracking-wide text-faint">
        <span
          className={`pc-dot ${running > 0 ? "pc-dot--ring" : "pc-dot--success"}`}
          aria-hidden="true"
        />
        {running > 0
          ? `${running} background task${running === 1 ? "" : "s"} running`
          : `${tasks.length} background task${tasks.length === 1 ? "" : "s"}`}
      </div>
      <ul className="max-h-40 overflow-auto">
        {tasks.map((t) => (
          <BackgroundTaskRow key={t.id} task={t} />
        ))}
      </ul>
    </section>
  );
}

/** Human label + colour for a background task's live/terminal state. */
function statusMeta(status: BackgroundTaskStatus): { label: string; dot: string; text: string } {
  switch (status) {
    case "running":
      return { label: "running", dot: "pc-dot--ring", text: "text-accent-2" };
    case "ok":
      return { label: "done", dot: "pc-dot--success", text: "text-success" };
    case "error":
      return { label: "error", dot: "bg-danger", text: "text-danger" };
  }
}

function BackgroundTaskRow({ task }: { task: BackgroundTaskInfo }) {
  const meta = statusMeta(task.status);
  // While running, the only thing to show is liveness; once finished, the exit
  // code (which `error` status already colours). The captured output rides the
  // row's title so it is inspectable on hover without expanding the panel.
  const detail =
    task.status === "running"
      ? meta.label
      : task.exitCode === 0
        ? meta.label
        : `exit ${task.exitCode ?? "?"}`;

  return (
    <li className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
      <span className={`pc-dot ${meta.dot}`} aria-hidden="true" />
      <span
        className="min-w-0 flex-1 truncate font-mono text-fg"
        title={task.output ? `${task.command}\n\n${task.output}` : task.command}
      >
        {task.command}
      </span>
      <span className={`font-mono text-[10px] ${meta.text}`}>{detail}</span>
    </li>
  );
}
