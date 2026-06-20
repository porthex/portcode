import { useEffect, useRef, useState } from "react";

// A tiny, dependency-free "typewriter" reveal. The agent's reply already streams
// in as `text_delta` chunks (irregular bursts); this hook smooths that into a
// steady character-by-character reveal so a turn reads like it's being typed in a
// terminal. It only ever lags slightly behind the real stream and always catches
// up — when a turn ends the caller disables it and the full text snaps in.

const QUERY = "(prefers-reduced-motion: reduce)";

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia(QUERY).matches;

/** Tracks the OS "reduce motion" accessibility setting, reactively. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(QUERY);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/** Characters per second the reveal advances. Fast enough to stay near a live
 *  token stream, slow enough to read as deliberate "typing". */
const CHARS_PER_SECOND = 140;

/**
 * Returns a progressively revealed slice of `full`, advancing a cursor toward
 * the end at a steady rate. As `full` grows with new stream deltas the cursor
 * keeps catching up. When `enabled` is false the full text is returned
 * immediately — so completed messages, the "off" setting, and reduced-motion all
 * render instantly with no animation.
 */
export function useTypewriter(full: string, enabled: boolean): string {
  const [count, setCount] = useState(() => (enabled ? 0 : full.length));
  const countRef = useRef(count);
  countRef.current = count;

  useEffect(() => {
    if (!enabled) {
      countRef.current = full.length;
      setCount(full.length);
      return;
    }
    // A shorter `full` than what we've already revealed means a fresh/reset
    // message — clamp back so we don't slice past the end.
    if (countRef.current > full.length) {
      countRef.current = full.length;
      setCount(full.length);
    }
    if (countRef.current >= full.length) return; // already caught up

    let raf = 0;
    let last = 0;
    const step = (ts: number) => {
      if (last === 0) last = ts;
      const dt = ts - last;
      last = ts;
      const advance = Math.max(1, Math.round((CHARS_PER_SECOND * dt) / 1000));
      const next = Math.min(full.length, countRef.current + advance);
      countRef.current = next;
      setCount(next);
      if (next < full.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [full, enabled]);

  return enabled ? full.slice(0, count) : full;
}
