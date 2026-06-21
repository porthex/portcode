import { useEffect, useRef, useState } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia(REDUCED_MOTION_QUERY).matches;

/** Tracks the OS "reduce motion" accessibility setting, reactively. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

// A per-word "decode" reveal for the in-flight assistant turn. The reply streams
// in as `text_delta` chunks; this hook reveals it one WORD at a time, each word
// flickering through random glyphs that resolve left-to-right into the real
// characters — a terminal "decode" feel. It mirrors useTypewriter's contract: it
// lags slightly behind the live stream and catches up, and when `enabled` is
// false the full text is returned at once (finished turn / "off" / reduced
// motion all render instantly).

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";

// Frame cadence + per-character speed, tuned to the "fastest" decode from the
// design mock: a word resolves in a few short frames. Exported for the tests so
// they can advance an exact number of frames.
export const STEP_MS = 22;
const FRAMES_PER_CHAR = 1.5;
const MIN_FRAMES = 3;

const isSpace = (c: string): boolean => c === " " || c === "\n" || c === "\t" || c === "\r";

/**
 * A random glyph that matches the KIND of `c`: uppercase→uppercase,
 * lowercase→lowercase, digit→digit. Spaces, punctuation and any other symbol
 * pass through unchanged, so only real letters/digits flicker while a word
 * decodes and the word keeps its shape and case.
 */
function randGlyph(c: string): string {
  if (c >= "A" && c <= "Z") return UPPER[Math.floor(Math.random() * 26)];
  if (c >= "a" && c <= "z") return LOWER[Math.floor(Math.random() * 26)];
  if (c >= "0" && c <= "9") return DIGITS[Math.floor(Math.random() * 10)];
  return c;
}

interface ActiveWord {
  start: number;
  end: number;
  frame: number;
  duration: number;
}

interface Progress {
  settled: number;
  active: ActiveWord | null;
}

/**
 * Advance the decode by exactly one frame, mutating `p`. Returns whether
 * anything changed, so the caller can skip redundant re-renders while idle.
 */
function stepFrame(full: string, p: Progress): boolean {
  const len = full.length;
  let changed = false;
  // A shorter `full` than we've consumed means a reset / replaced message —
  // clamp back into range so we never slice past the end (and re-render to it).
  if (p.settled > len) {
    p.settled = len;
    p.active = null;
    changed = true;
  }

  if (p.active) {
    if (p.active.end > len) {
      // The text shrank out from under the word being decoded — drop it.
      p.active = null;
      return true;
    }
    p.active.frame += 1;
    if (p.active.frame >= p.active.duration) {
      p.settled = p.active.end;
      p.active = null;
    }
    return true;
  }

  let i = p.settled;
  while (i < len && isSpace(full[i])) i += 1; // whitespace settles instantly
  if (i !== p.settled) {
    p.settled = i;
    changed = true;
  }
  if (i >= len) return changed;

  let j = i;
  while (j < len && !isSpace(full[j])) j += 1;
  // Only decode a word once it is fully present (a whitespace boundary follows
  // it). The trailing word of a still-streaming chunk waits for more text, so we
  // never scramble half a word.
  if (j >= len) return changed;

  p.active = {
    start: i,
    end: j,
    frame: 0,
    duration: Math.max(MIN_FRAMES, Math.ceil((j - i) * FRAMES_PER_CHAR)),
  };
  return true;
}

export interface ScrambleView {
  /** The text to render: real characters up to `scrambleStart`, random glyphs after. */
  display: string;
  /** Index in `display` where the still-decoding (glowing) tail begins. */
  scrambleStart: number;
}

/** Project the current progress into the visible string + the glow boundary. */
function view(full: string, p: Progress): ScrambleView {
  const a = p.active;
  if (!a) return { display: full.slice(0, p.settled), scrambleStart: p.settled };
  const wordLen = a.end - a.start;
  const revealed = Math.min(wordLen, Math.floor((a.frame / a.duration) * wordLen));
  const realEnd = a.start + revealed;
  let glyphs = "";
  for (let k = realEnd; k < a.end; k += 1) glyphs += randGlyph(full[k]);
  return { display: full.slice(0, realEnd) + glyphs, scrambleStart: realEnd };
}

/**
 * Per-word decode reveal. As `full` grows with stream deltas, each newly-complete
 * word flickers through case-matched glyphs and resolves left-to-right. When
 * `enabled` is false the full text is returned immediately with nothing decoding.
 */
export function useScramble(full: string, enabled: boolean): ScrambleView {
  const fullRef = useRef(full);
  fullRef.current = full;
  const progressRef = useRef<Progress>({ settled: enabled ? 0 : full.length, active: null });
  const [v, setV] = useState<ScrambleView>(() =>
    enabled ? { display: "", scrambleStart: 0 } : { display: full, scrambleStart: full.length },
  );

  useEffect(() => {
    if (!enabled) {
      progressRef.current = { settled: fullRef.current.length, active: null };
      setV({ display: fullRef.current, scrambleStart: fullRef.current.length });
      return;
    }
    // (Re)start the decode from the top of the current text when a turn begins.
    progressRef.current = { settled: 0, active: null };
    setV({ display: "", scrambleStart: 0 });

    let raf = 0;
    let lastTs = 0;
    const tick = (ts: number) => {
      if (lastTs === 0) lastTs = ts;
      let changed = false;
      // Advance whole frames for the elapsed time so the cadence stays steady
      // regardless of the display's refresh rate (and so a paused tab catches up).
      while (ts - lastTs >= STEP_MS) {
        lastTs += STEP_MS;
        if (stepFrame(fullRef.current, progressRef.current)) changed = true;
      }
      if (changed) setV(view(fullRef.current, progressRef.current));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);

  return v;
}
