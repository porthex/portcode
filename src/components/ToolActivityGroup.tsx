import { memo, useId, useMemo, useState } from "react";
import { canonicalToolName } from "../lib/toolNames";
import type { ContentBlock } from "../types";
import { ToolCall } from "./ToolCall";

type ToolUseBlock = Extract<ContentBlock, { kind: "tool_use" }>;
type ResultBlock = Extract<ContentBlock, { kind: "tool_result" }>;

export interface ActivityCall {
  tool: ToolUseBlock;
  result?: ResultBlock;
}

export { isRoutineToolName } from "../lib/toolNames";

export const ToolActivityGroup = memo(function ToolActivityGroup({
  calls,
  active = false,
}: {
  calls: ActivityCall[];
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const pending = calls.some(({ result }) => !result);
  const running = active || pending;
  const { label, detail } = useMemo(() => describeActivity(calls, running), [calls, running]);
  const state = running ? "running" : "completed";

  return (
    <div className={`pc-toolcall ${running ? "pc-toolcall--active" : ""}`}>
      <button
        type="button"
        className="pc-toolcall__head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={`${label}, ${detail}, ${state}, ${open ? "collapse" : "expand"} details`}
      >
        <span
          aria-hidden="true"
          className={`pc-dot ${running ? "pc-dot--warn" : "pc-dot--success"}`}
        />
        <span className="text-[13px] font-medium text-fg">{label}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-faint">{detail}</span>
        <span className="ml-auto text-faint" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {/* Raw calls only enter the DOM on demand. This is the main scalability
          win for read-heavy agent turns: one compact row replaces dozens of
          cards, serialized inputs, and potentially huge hidden result nodes. */}
      {open && (
        <div
          id={detailsId}
          className="border-t border-border bg-[#050609] p-2"
          role="region"
          aria-label="Raw activity details"
        >
          <div className="mb-2 flex items-center justify-between px-1 text-[10px] uppercase tracking-wide text-faint">
            <span>Raw activity</span>
            <span>
              {calls.length} {calls.length === 1 ? "operation" : "operations"}
            </span>
          </div>
          <div className="space-y-1.5">
            {calls.map(({ tool, result }) => (
              <ToolCall key={tool.id} name={tool.name} input={tool.input} result={result} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

function describeActivity(
  calls: ActivityCall[],
  running: boolean,
): { label: string; detail: string } {
  if (calls.length === 1) return describeSingle(calls[0].tool, running);

  let reads = 0;
  let searches = 0;
  let listings = 0;
  for (const { tool } of calls) {
    const name = canonicalToolName(tool.name);
    if (name === "read_file") reads++;
    else if (name === "list_directory") listings++;
    else searches++;
  }

  const parts = [
    reads > 0 ? `${reads} ${plural(reads, "file")} read` : "",
    searches > 0 ? `${searches} ${plural(searches, "search", "searches")}` : "",
    listings > 0 ? `${listings} ${plural(listings, "folder")} listed` : "",
  ].filter(Boolean);

  return { label: running ? "Exploring project" : "Explored project", detail: parts.join(" · ") };
}

function describeSingle(tool: ToolUseBlock, running: boolean): { label: string; detail: string } {
  const target = targetOf(tool.input);
  switch (canonicalToolName(tool.name)) {
    case "read_file":
      return { label: running ? "Reading file" : "Read file", detail: target ?? "1 file read" };
    case "list_directory":
      return {
        label: running ? "Browsing folder" : "Browsed folder",
        detail: target ?? "Workspace",
      };
    case "find_files":
      return {
        label: running ? "Finding files" : "Found files",
        detail: target ?? "1 file search",
      };
    case "search_text":
      return {
        label: running ? "Searching project" : "Searched project",
        detail: target ?? "1 content search",
      };
    default:
      // The component is only called with allow-listed names; retain a safe,
      // readable fallback for forward-compatible callers.
      return {
        label: running ? "Exploring project" : "Explored project",
        detail: "1 read-only operation",
      };
  }
}

function targetOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (typeof value.path === "string" && value.path.trim()) return value.path;
  if (typeof value.pattern === "string" && value.pattern.trim()) return value.pattern;
  return null;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}
