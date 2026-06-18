import { useState } from "react";
import type { ContentBlock } from "../types";

type ResultBlock = Extract<ContentBlock, { kind: "tool_result" }>;

export function ToolCall({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result?: ResultBlock;
}) {
  const [open, setOpen] = useState(false);
  const summary = summarize(name, input);
  const pending = !result;
  const error = result?.isError;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-panel">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-panel-2"
      >
        <StatusDot pending={pending} error={error} />
        <span className="font-mono text-accent">{name}</span>
        <span className="truncate text-muted">{summary}</span>
        <span className="ml-auto text-muted">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">
            Input
          </div>
          <pre className="mb-2 overflow-x-auto rounded bg-bg p-2 font-mono text-[12px] text-fg select-text">
            {JSON.stringify(input, null, 2)}
          </pre>
          {result && (
            <>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">
                {error ? "Error" : "Result"}
              </div>
              {!error && looksLikeDiff(result.output) ? (
                <DiffView text={result.output} />
              ) : (
                <pre
                  className={`max-h-72 overflow-auto rounded bg-bg p-2 font-mono text-[12px] select-text ${
                    error ? "text-danger" : "text-fg"
                  }`}
                >
                  {result.output}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StatusDot({ pending, error }: { pending: boolean; error?: boolean }) {
  const color = error ? "bg-danger" : pending ? "bg-warn" : "bg-success";
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${color} ${
        pending ? "animate-pulse" : ""
      }`}
    />
  );
}

function looksLikeDiff(text: string): boolean {
  return /(^|\n)@@ /.test(text) || /(^|\n)\+\+\+ /.test(text);
}

function DiffView({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <pre className="max-h-72 overflow-auto rounded bg-bg p-2 font-mono text-[12px] leading-[1.5] select-text">
      {lines.map((line, i) => {
        let cls = "text-muted";
        if (line.startsWith("@@")) cls = "text-accent";
        else if (line.startsWith("+++") || line.startsWith("---")) cls = "text-muted";
        else if (line.startsWith("+")) cls = "bg-success/10 text-success";
        else if (line.startsWith("-")) cls = "bg-danger/10 text-danger";
        else cls = "text-fg";
        return (
          <div key={i} className={`${cls} -mx-2 px-2`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function summarize(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.path === "string") return o.path;
    if (typeof o.command === "string") return o.command;
    if (typeof o.pattern === "string") return o.pattern;
  }
  return name;
}
