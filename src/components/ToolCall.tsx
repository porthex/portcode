import { memo, useId, useMemo, useState } from "react";
import { toolLabel } from "../lib/toolNames";
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
  const [hasOpened, setHasOpened] = useState(false);
  const detailsId = useId();
  const label = toolLabel(name);
  const summary = summarize(input);
  const pending = !result;
  const error = result?.isError;
  const output = result?.output;
  const interrupted = Boolean(error && output?.startsWith("Interrupted:"));
  // Scanning the output for diff markers and tallying +/- counts is O(n) over
  // potentially large tool output. Memoize so toggling open/collapse (or any
  // unrelated re-render) doesn't re-scan unchanged output.
  const { isDiff, counts } = useMemo(() => {
    if (!hasOpened) return { isDiff: false, counts: null };
    const diff = !error && output != null && looksLikeDiff(output);
    return { isDiff: diff, counts: diff ? diffCounts(output) : null };
  }, [output, error, hasOpened]);
  const target = summary ? ` ${summary}` : "";

  return (
    <div
      className={`pc-toolcall ${pending ? "pc-toolcall--active" : ""} ${
        interrupted ? "pc-toolcall--interrupted" : ""
      }`}
    >
      <button
        onClick={() =>
          setOpen((current) => {
            if (!current) setHasOpened(true);
            return !current;
          })
        }
        className="pc-toolcall__head"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={`${label}${target}${
          interrupted ? ", interrupted" : error ? ", failed" : pending ? ", running" : ", completed"
        }, ${open ? "collapse" : "expand"} output`}
      >
        <StatusDot pending={pending} error={error} interrupted={interrupted} />
        <span className="pc-toolcall__name">{label}</span>
        {summary && <span className="pc-toolcall__path min-w-0 flex-1">{summary}</span>}
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
      {/* Collapsed tool payloads are intentionally unmounted. A single read can
          return megabytes, and keeping dozens of hidden JSON/result trees alive
          made tool-heavy turns pay their full DOM/layout cost forever. */}
      {open && (
        <ToolCallDetails
          id={detailsId}
          name={name}
          label={label}
          input={input}
          result={result}
          error={error}
          interrupted={interrupted}
          isDiff={isDiff}
        />
      )}
    </div>
  );
});

const ToolCallDetails = memo(function ToolCallDetails({
  id,
  name,
  label,
  input,
  result,
  error,
  interrupted,
  isDiff,
}: {
  id: string;
  name: string;
  label: string;
  input: unknown;
  result?: ResultBlock;
  error?: boolean;
  interrupted: boolean;
  isDiff: boolean;
}) {
  // Both operations are deferred until disclosure. In particular, inputs may
  // include large command payloads that should not be serialized while hidden.
  const inputJson = useMemo(() => JSON.stringify(input, null, 2), [input]);

  return (
    <div id={id} className="pc-toolcall__body" role="region" aria-label={`${label} details`}>
      <div className="mb-2 text-[10px] text-faint">
        Tool ID <code className="ml-1 select-text text-muted">{name}</code>
      </div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Input</div>
      <pre className="mb-2 overflow-x-auto font-mono text-[11.5px] text-fg select-text">
        {inputJson}
      </pre>
      {result && (
        <>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">
            {interrupted ? "Interrupted" : error ? "Error" : "Result"}
          </div>
          {isDiff ? (
            <DiffView text={result.output} />
          ) : (
            <PlainOutput text={result.output} error={error} interrupted={interrupted} />
          )}
        </>
      )}
    </div>
  );
});

// Plain output is a single text node rather than one node per line, but very
// large strings still carry a substantial layout/copy cost in WebView. Keep a
// generous readable prefix and reveal the complete output only on explicit ask.
const MAX_PLAIN_OUTPUT_CHARS = 40_000;

export const PlainOutput = memo(function PlainOutput({
  text,
  error,
  interrupted,
}: {
  text: string;
  error?: boolean;
  interrupted?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const { shown, hidden } = useMemo(() => {
    if (text.length <= MAX_PLAIN_OUTPUT_CHARS) return { shown: text, hidden: 0 };
    return {
      shown: text.slice(0, MAX_PLAIN_OUTPUT_CHARS),
      hidden: text.length - MAX_PLAIN_OUTPUT_CHARS,
    };
  }, [text]);

  return (
    <div>
      <pre
        className={`max-h-72 overflow-auto font-mono text-[11.5px] select-text ${
          interrupted ? "text-warn" : error ? "text-danger" : "text-muted"
        }`}
      >
        {showAll ? text : shown}
        {!showAll &&
          hidden > 0 &&
          `\n\n… ${hidden.toLocaleString("en-US")} more characters (truncated)`}
      </pre>
      {!showAll && hidden > 0 && (
        <button
          type="button"
          className="mt-2 text-[11px] text-accent-2 hover:underline"
          onClick={() => setShowAll(true)}
        >
          Show full output
        </button>
      )}
    </div>
  );
});

function StatusDot({
  pending,
  error,
  interrupted,
}: {
  pending: boolean;
  error?: boolean;
  interrupted?: boolean;
}) {
  // done → success, running → warn (pulsing), pending input → accent.
  const variant = pending ? "pc-dot--warn" : "pc-dot--success";
  if (interrupted) {
    return (
      <span
        aria-hidden="true"
        className="pc-dot"
        style={{
          background: "var(--color-warn)",
          boxShadow: "0 0 8px color-mix(in srgb, var(--color-warn) 75%, transparent)",
        }}
      />
    );
  }
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
export const DiffView = memo(function DiffView({ text }: { text: string }) {
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

function summarize(input: unknown): string | null {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.path === "string") return o.path;
    if (typeof o.command === "string") return o.command;
    if (typeof o.pattern === "string") return o.pattern;
  }
  return null;
}
