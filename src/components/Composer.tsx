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

// Auto-grow cap; kept in sync with the textarea's inline maxHeight so the JS
// target and the CSS clip agree (otherwise the grow stops short at the smaller).
const MAX_TEXTAREA_H = 220;

export function Composer() {
  const text = useStore((s) => s.draft);
  const setText = useStore((s) => s.setDraft);
  const streaming = useStore((s) => s.streaming);
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const remoteMode = useStore((s) => s.remoteMode);
  // On the phone, a pending permission pauses the agent on the desktop; reflect
  // that in the (already disabled-mid-turn) composer placeholder so the wait reads
  // as intentional rather than a frozen input.
  const awaitingPermission = useStore((s) => s.remoteMode && s.pendingPermission !== null);
  const ref = useRef<HTMLTextAreaElement>(null);
  // The pixel height of a single, empty row. Captured lazily from a collapsed
  // textarea so the post-submit collapse has a concrete target to ease toward —
  // CSS height transitions can't interpolate to/from "auto" (the browser
  // resolves it instantly), which otherwise kills the collapse animation.
  const rowHeightRef = useRef<number | null>(null);

  // Keep the textarea height in sync when the draft changes externally
  // (e.g. a file path inserted from the explorer).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_H);
    // Memoize the single-row height the first time we see a collapsed textarea,
    // so submit() can animate down to a px value instead of snapping via "auto".
    if (rowHeightRef.current == null && !text) rowHeightRef.current = el.scrollHeight;
    el.style.height = next + "px";
  }, [text]);

  // Return focus to the composer when a turn finishes — the textarea blurs when it
  // goes disabled at turn start, which otherwise breaks the keyboard flow (you'd have
  // to click back in). Only when nothing else grabbed focus (a permission button, the
  // palette, another input), and never on mobile/remote where it would pop the keyboard.
  useEffect(() => {
    if (streaming || remoteMode) return;
    const el = ref.current;
    if (el && !el.disabled && document.activeElement === document.body) el.focus();
  }, [streaming, remoteMode]);

  const submit = async () => {
    const t = text;
    if (!t.trim() || streaming) return;
    setText("");
    // Collapse to the measured single-row height (a px target) so the declared
    // transition-[height] can ease the shrink; fall back to "auto" only if we
    // never captured a row height (e.g. submit before the first layout pass).
    if (ref.current)
      ref.current.style.height =
        rowHeightRef.current != null ? rowHeightRef.current + "px" : "auto";
    await send(t);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Don't submit on the Enter that COMMITS an IME composition (CJK/accent): the
    // native isComposing flag is still set for that keydown. A real post-commit
    // Enter has it cleared and still submits.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const autoGrow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX_TEXTAREA_H) + "px";
  };

  return (
    <div className="border-t border-border bg-panel/80 px-6 pb-3 pt-3.5">
      <div className="pc-neon-frame w-full max-w-none transition-[opacity,filter] duration-200 motion-reduce:transition-none">
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
            aria-busy={streaming}
            aria-label="Message Portcode"
            rows={1}
            placeholder={
              awaitingPermission
                ? "Agent paused — awaiting permission"
                : "Describe a task, ask a question, or give an instruction…"
            }
            style={{ maxHeight: MAX_TEXTAREA_H }}
            className="flex-1 resize-none bg-transparent text-[13.5px] leading-[1.5] text-fg outline-none transition-[height,opacity,filter] duration-150 ease-out motion-reduce:transition-none placeholder:text-faint select-text disabled:cursor-not-allowed disabled:opacity-60 disabled:saturate-[0.6]"
          />
          <ModelPicker />
          {streaming ? (
            <button
              onClick={() => void stop()}
              className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-danger/20 text-danger shadow-[0_0_16px_rgba(255,77,87,0.3)] hover:bg-danger/30 hover:shadow-[0_0_26px_rgba(255,77,87,0.55)] active:brightness-90 transition-[box-shadow,background-color,filter] duration-200 motion-reduce:transition-none"
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
      <div className="mt-[7px] flex w-full max-w-none items-center justify-between font-mono text-[10.5px] text-faint">
        <span className="min-w-0 truncate">
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
    <span className="flex shrink-0 items-center gap-1.5">
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
