import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/store";
import { estimateCost } from "../types";

// Auto-grow cap; kept in sync with the textarea's inline maxHeight so the JS
// target and the CSS clip agree (otherwise the grow stops short at the smaller).
const MAX_TEXTAREA_H = 220;

// The live presence phrases, derived from REAL turn/stream state (never padded
// latency). The dot color honors the brand semantics: cyan = the agent at work,
// danger = a Stop in flight, faint = at rest.
function presenceFor(
  streaming: boolean,
  phase: "idle" | "received" | "thinking" | "stopping",
): { text: string; dot: string } {
  if (phase === "stopping") return { text: "stopping…", dot: "pc-dot pc-dot--danger" };
  if (!streaming) return { text: "ready when you are", dot: "pc-dot--idle" };
  if (phase === "received") return { text: "got it — reading…", dot: "pc-dot pc-dot--cyan" };
  return { text: "thinking with you…", dot: "pc-dot pc-dot--cyan" };
}

export function Composer() {
  // Per-session draft: read the ACTIVE session's draft so a half-written message
  // can't bleed across sessions (the old single global `draft` did exactly that).
  const activeId = useStore((s) => s.activeId);
  const text = useStore((s) => (s.activeId ? (s.drafts[s.activeId] ?? "") : ""));
  const setText = useStore((s) => s.setDraft);
  const streaming = useStore((s) => s.streaming);
  const composerPhase = useStore((s) => s.composerPhase);
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const remoteMode = useStore((s) => s.remoteMode);
  const ref = useRef<HTMLTextAreaElement>(null);
  // The pixel height of a single, empty row. Captured lazily from a collapsed
  // textarea so the post-submit collapse has a concrete target to ease toward —
  // CSS height transitions can't interpolate to/from "auto" (the browser
  // resolves it instantly), which otherwise kills the collapse animation.
  const rowHeightRef = useRef<number | null>(null);

  // Send is fireable only with non-whitespace content and no turn in flight.
  const canSend = text.trim().length > 0 && !streaming;
  // Armed cue (motor anticipation): a one-shot pulse the moment Send becomes
  // fireable. Seeded from the initial value so a restored draft doesn't pulse on
  // mount — only a genuine disabled→enabled transition arms it.
  const [armed, setArmed] = useState(false);
  const prevCanSend = useRef(canSend);
  const prevActiveId = useRef(activeId);
  useEffect(() => {
    // A session switch flips canSend without any typing (the new session just has a
    // different draft) — that's a non-event, so don't fire the pulse for it. Only a
    // genuine in-session disabled→enabled transition (the user typed) arms it.
    if (activeId !== prevActiveId.current) {
      prevActiveId.current = activeId;
      prevCanSend.current = canSend;
      return;
    }
    if (canSend && !prevCanSend.current) setArmed(true);
    prevCanSend.current = canSend;
  }, [canSend, activeId]);
  // One-shot: drop the pulse class shortly after it plays (slightly past the 0.3s
  // animation) so a later disabled→enabled transition can re-trigger it.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 320);
    return () => clearTimeout(t);
  }, [armed]);

  const stopping = composerPhase === "stopping";
  const presence = presenceFor(streaming, composerPhase);
  // Honest hint (only when it applies): Shift+Enter inserts a newline, so we only
  // claim it once the draft is actually multi-line.
  const multiline = text.includes("\n");

  // Keep the textarea height in sync when the draft changes externally
  // (e.g. a file path inserted from the explorer, or switching sessions).
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
      {/* State-bearing neon frame: still + glowing at rest, FLOWING only while a turn
          streams (data-busy) — motion encodes state instead of perpetual wallpaper. */}
      <div
        data-busy={streaming ? "true" : undefined}
        className="pc-neon-frame w-full max-w-none transition-[opacity,filter] duration-200 motion-reduce:transition-none"
      >
        <div className="flex items-end gap-2.5 rounded-[12px] bg-panel px-3 py-2.5">
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autoGrow();
            }}
            onKeyDown={onKeyDown}
            // Disabled while a turn streams, and when there's no active session to
            // draft into — an enabled field whose keystrokes silently go nowhere
            // (setDraft no-ops without an activeId) would be a dead-end, not honest.
            disabled={streaming || !activeId}
            aria-busy={streaming}
            aria-label="Message Portcode"
            rows={1}
            placeholder="Describe a task, ask a question, or give an instruction…"
            style={{ maxHeight: MAX_TEXTAREA_H }}
            className="flex-1 resize-none bg-transparent text-[13.5px] leading-[1.5] text-fg outline-none transition-[height,opacity,filter] duration-150 ease-out motion-reduce:transition-none placeholder:text-faint select-text disabled:cursor-not-allowed disabled:opacity-60 disabled:saturate-[0.6]"
          />
          {/* Send and Stop are STACKED in one slot and cross-fade (~130ms) rather than
              swapping instantly — a change-blindness-safe transition (Norman gulf of
              evaluation). The hidden control leaves the tab order and is unclickable. */}
          <div className="relative h-[34px] w-[34px] shrink-0">
            <button
              onClick={() => void submit()}
              disabled={!canSend}
              tabIndex={streaming ? -1 : 0}
              aria-hidden={streaming || undefined}
              className={`pc-send pc-action ${streaming ? "pc-action--hidden" : "pc-action--shown"}${armed ? " pc-armed" : ""}`}
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
            <button
              onClick={() => void stop()}
              disabled={!streaming || stopping}
              tabIndex={streaming ? 0 : -1}
              aria-hidden={!streaming || undefined}
              className={`pc-stop pc-action ${streaming ? "pc-action--shown" : "pc-action--hidden"}${stopping ? " pc-stop--stopping" : ""}`}
              title="Stop"
              aria-label={stopping ? "Stopping…" : "Stop generating"}
            >
              <span className="block h-3 w-3 rounded-sm bg-danger" />
            </button>
          </div>
        </div>
      </div>
      <div className="mt-[7px] flex w-full max-w-none items-center justify-between gap-3 font-mono text-[10.5px]">
        <div className="flex min-w-0 items-center gap-2.5">
          {/* Live status region (para-social presence + WCAG status): the presence
              phrase is announced politely; the per-tick token counter is kept OUT of
              this region (it lives in UsageMeter, aria-hidden) so AT isn't spammed. */}
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="flex min-w-0 items-center gap-1.5 text-muted"
          >
            <span className={presence.dot} aria-hidden="true" />
            <span className="truncate">{presence.text}</span>
          </span>
          {multiline && (
            <span className="hidden whitespace-nowrap text-muted sm:inline" aria-hidden="true">
              Shift+Enter for a new line
            </span>
          )}
        </div>
        <UsageMeter />
      </div>
    </div>
  );
}

function UsageMeter() {
  const model = useStore((s) => s.settings.model);
  const usage = useStore((s) => (s.activeId ? s.usage[s.activeId] : undefined));
  const total = usage ? usage.input + usage.output : 0;
  const cost = usage ? estimateCost(model, usage) : 0;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-muted">
      {total > 0 && (
        // aria-hidden: the token/cost numbers tick on every streaming delta, so they
        // stay out of the assistive-tech announcement stream (the presence region is
        // the spoken channel). tabular-nums keeps the counter from reflowing as digits
        // change width.
        <span
          className="flex items-center gap-1.5 tabular-nums"
          aria-hidden="true"
          title={`${usage!.input.toLocaleString()} in · ${usage!.output.toLocaleString()} out`}
        >
          <span className="text-accent-2">{fmtTokens(total)} tok</span>
          <span>·</span>
          <span className="text-success">${cost.toFixed(cost < 0.01 ? 4 : 2)}</span>
          <span>·</span>
        </span>
      )}
      <span>{model}</span>
    </span>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
