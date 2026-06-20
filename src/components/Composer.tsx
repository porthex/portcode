import { useEffect, useRef } from "react";
import { useStore } from "../store/store";
import { estimateCost, PROVIDERS } from "../types";

/** Read the active session's model, falling back to the global default. */
function useActiveModel(): string {
  return useStore((s) => {
    const sess = s.activeId ? s.sessions.find((x) => x.id === s.activeId) : undefined;
    return sess?.model ?? s.settings.model;
  });
}

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
    <div className="border-t border-border bg-panel/80 px-6 pb-3 pt-3.5">
      <div className="pc-neon-frame mx-auto w-full max-w-[760px]">
        <div className="flex items-end gap-2.5 rounded-[12px] bg-panel px-3 py-2.5">
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autoGrow();
            }}
            onKeyDown={onKeyDown}
            disabled={streaming}
            rows={1}
            placeholder="Describe a task, ask a question, or give an instruction…"
            className="max-h-[120px] flex-1 resize-none bg-transparent text-[13.5px] leading-[1.5] text-fg outline-none placeholder:text-faint select-text disabled:cursor-not-allowed disabled:opacity-60"
          />
          <ModelPicker />
          {streaming ? (
            <button
              onClick={() => void stop()}
              className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-danger/20 text-danger hover:bg-danger/30 transition-colors"
              title="Stop"
              aria-label="Stop generating"
            >
              <span className="block h-3 w-3 rounded-sm bg-danger" />
            </button>
          ) : (
            <button
              onClick={() => void submit()}
              disabled={!text.trim()}
              className="pc-send"
              title="Send (Enter)"
              aria-label="Send message"
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
      </div>
      <div className="mx-auto mt-[7px] flex w-full max-w-[760px] items-center justify-between font-mono text-[10.5px] text-faint">
        <span>
          <span className="text-muted">ENTER</span> send ·{" "}
          <span className="text-muted">SHIFT+ENTER</span> newline
        </span>
        <UsageMeter />
      </div>
    </div>
  );
}

/** Compact, provider-grouped picker for the ACTIVE session's model. */
function ModelPicker() {
  const model = useActiveModel();
  const setSessionModel = useStore((s) => s.setSessionModel);
  const activeId = useStore((s) => s.activeId);
  const streaming = useStore((s) => s.streaming);
  return (
    <select
      aria-label="Model"
      value={model}
      onChange={(e) => void setSessionModel(e.target.value)}
      disabled={streaming || !activeId}
      className="shrink-0 rounded-lg border border-border bg-panel-2 px-2.5 py-1.5 text-[12px] text-fg outline-none disabled:opacity-50"
    >
      {PROVIDERS.map((p) => (
        <optgroup key={p.id} label={p.label}>
          {p.models.map((mdl) => (
            <option key={mdl.id} value={mdl.id}>
              {mdl.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function UsageMeter() {
  const model = useActiveModel();
  const usage = useStore((s) => (s.activeId ? s.usage[s.activeId] : undefined));
  const total = usage ? usage.input + usage.output : 0;
  const cost = usage ? estimateCost(model, usage) : 0;
  return (
    <span className="flex items-center gap-1.5">
      {total > 0 && (
        <span
          className="flex items-center gap-1.5"
          title={`${usage!.input.toLocaleString()} in · ${usage!.output.toLocaleString()} out`}
        >
          <span className="text-accent-2">{fmtTokens(total)} tok</span>
          <span>·</span>
          <span className="text-success">${cost.toFixed(cost < 0.01 ? 4 : 2)}</span>
          <span>·</span>
        </span>
      )}
      <span className="text-muted">{model}</span>
    </span>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
