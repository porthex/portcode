import { memo, useMemo, useState } from "react";
import type { ContentBlock } from "../types";

type ResultBlock = Extract<ContentBlock, { kind: "tool_result" }>;

export const ToolCall = memo(function ToolCall({
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
  const output = result?.output;
  // Scanning the output for diff markers and tallying +/- counts is O(n) over
  // potentially large tool output. Memoize so toggling open/collapse (or any
  // unrelated re-render) doesn't re-scan unchanged output.
  const { isDiff, counts } = useMemo(() => {
    const diff = !error && output != null && looksLikeDiff(output);
    return { isDiff: diff, counts: diff ? diffCounts(output) : null };
  }, [output, error]);
  // Pretty-printing the input is pure on `input`; memoize so unrelated
  // re-renders (e.g. toggling open/collapse) don't re-stringify it.
  const inputJson = useMemo(() => JSON.stringify(input, null, 2), [input]);
  // summarize() falls back to the tool name when there's no summarizable input,
  // so only fold the summary into the spoken label when it adds a distinct
  // target — otherwise a screen reader hears the name twice.
  const target = summary === name ? "" : ` ${summary}`;

  return (
    <div className="pc-toolcall">
      <button
        onClick={() => setOpen((o) => !o)}
        className="pc-toolcall__head"
        aria-expanded={open}
        aria-label={`${name}${target}${
          error ? ", failed" : pending ? ", running" : ", completed"
        }, ${open ? "collapse" : "expand"} output`}
      >
        <StatusDot pending={pending} error={error} />
        <span className="pc-toolcall__name">{name}</span>
        {summary !== name && <span className="pc-toolcall__path min-w-0 flex-1">{summary}</span>}
        <span className="ml-auto flex items-center gap-2">
          {counts && (counts.adds > 0 || counts.dels > 0) && (
            <>
              {counts.adds > 0 && (
                <span className="font-mono text-[10px] text-success">+{counts.adds}</span>
              )}
              {counts.dels > 0 && (
                <span className="font-mono text-[10px] text-danger">-{counts.dels}</span>
              )}
            </>
          )}
          <span className="text-faint">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {/* Smooth expand/collapse via a grid 0fr->1fr accordion (the overflow-hidden
          child can shrink to 0). Body stays mounted so it animates both ways. */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="pc-toolcall__body" aria-hidden={!open}>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Input</div>
            <pre className="mb-2 overflow-x-auto font-mono text-[11.5px] text-fg select-text">
              {inputJson}
            </pre>
            {result && (
              <>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">
                  {error ? "Error" : "Result"}
                </div>
                {isDiff ? (
                  <DiffView text={result.output} />
                ) : (
                  <pre
                    className={`max-h-72 overflow-auto font-mono text-[11.5px] select-text ${
                      error ? "text-danger" : "text-muted"
                    }`}
                  >
                    {result.output}
                  </pre>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

function StatusDot({ pending, error }: { pending: boolean; error?: boolean }) {
  // done → success, running → warn (pulsing), pending input → accent.
  const variant = pending ? "pc-dot--warn" : "pc-dot--success";
  if (error) {
    return (
      <span
        aria-hidden="true"
        className="pc-dot bg-danger"
        style={{ boxShadow: "0 0 8px var(--color-danger)" }}
      />
    );
  }
  return <span aria-hidden="true" className={`pc-dot ${variant}`} />;
}

function looksLikeDiff(text: string): boolean {
  return /(^|\n)@@ /.test(text) || /(^|\n)\+\+\+ /.test(text);
}

function diffCounts(text: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) adds++;
    else if (line.startsWith("-")) dels++;
  }
  return { adds, dels };
}

// Cap the synchronous DOM node count so a huge tool diff can't jank the
// thread — render the first MAX_DIFF_LINES lines plus a static footer.
const MAX_DIFF_LINES = 500;

// memo: DiffView's only prop is `text`, so skip re-building the line tree
// when an unrelated parent re-render leaves the diff text unchanged.
const DiffView = memo(function DiffView({ text }: { text: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const shown = lines.length > MAX_DIFF_LINES ? lines.slice(0, MAX_DIFF_LINES) : lines;
  const hidden = lines.length - shown.length;
  return (
    <div className="pc-diff max-h-72 overflow-auto select-text">
      {shown.map((line, i) => {
        let cls = "pc-diff-ctx";
        if (line.startsWith("@@")) cls = "pc-diff-hunk";
        else if (line.startsWith("+++") || line.startsWith("---")) cls = "pc-diff-file";
        else if (line.startsWith("+")) cls = "pc-diff-add";
        else if (line.startsWith("-")) cls = "pc-diff-del";
        return (
          <div key={i} className={`pc-diff-line ${cls}`}>
            {line || " "}
          </div>
        );
      })}
      {hidden > 0 && (
        <div className="pc-diff-line pc-diff-file">… {hidden} more lines (truncated)</div>
      )}
    </div>
  );
});

function summarize(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.path === "string") return o.path;
    if (typeof o.command === "string") return o.command;
    if (typeof o.pattern === "string") return o.pattern;
  }
  return name;
}
