import { useEffect, useRef } from "react";
import { useStore } from "../store/store";
import { estimateCost } from "../types";

export function Composer() {
  const text = useStore((s) => s.draft);
  const setText = useStore((s) => s.setDraft);
  const streaming = useStore((s) => s.streaming);
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Keep the textarea height in sync when the draft changes externally
  // (e.g. a file path inserted from the explorer).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [text]);

  const submit = async () => {
    const t = text;
    if (!t.trim() || streaming) return;
    setText("");
    if (ref.current) ref.current.style.height = "auto";
    await send(t);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const autoGrow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  };

  return (
    <div className="border-t border-border bg-panel px-5 py-3">
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-xl border border-border bg-panel-2 px-3 py-2 focus-within:border-accent transition-colors">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autoGrow();
          }}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Describe a task, ask a question, or give an instruction…"
          className="max-h-56 flex-1 resize-none bg-transparent text-sm leading-6 text-fg outline-none placeholder:text-muted select-text"
        />
        {streaming ? (
          <button
            onClick={() => void stop()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-danger/20 text-danger hover:bg-danger/30 transition-colors"
            title="Stop"
          >
            <span className="block h-3 w-3 rounded-sm bg-danger" />
          </button>
        ) : (
          <button
            onClick={() => void submit()}
            disabled={!text.trim()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-bg disabled:opacity-30 hover:opacity-90 transition-opacity"
            title="Send (Enter)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M5 12h14M13 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
      <div className="mx-auto mt-1.5 flex w-full max-w-3xl items-center justify-between px-1 text-[11px] text-muted">
        <span>Enter to send · Shift+Enter for newline</span>
        <UsageMeter />
      </div>
    </div>
  );
}

function UsageMeter() {
  const model = useStore((s) => s.settings.model);
  const usage = useStore((s) =>
    s.activeId ? s.usage[s.activeId] : undefined
  );
  const total = usage ? usage.input + usage.output : 0;
  const cost = usage ? estimateCost(model, usage) : 0;
  return (
    <span className="flex items-center gap-2 font-mono">
      {total > 0 && (
        <span title={`${usage!.input.toLocaleString()} in · ${usage!.output.toLocaleString()} out`}>
          {fmtTokens(total)} tok · ${cost.toFixed(cost < 0.01 ? 4 : 2)}
        </span>
      )}
      <span className="text-muted/70">{model}</span>
    </span>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
