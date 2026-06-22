import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { STEP_MS, usePrefersReducedMotion, useScramble } from "./useScramble";

// useScramble drives a per-word decode off requestAnimationFrame. We replace rAF
// with a manual queue so the animation advances by an exact number of frames and
// the glyph output is deterministic to assert against. The hook schedules exactly
// one callback per tick, so each `tick` consumes the latest one and the loop
// re-arms itself.
let rafQueue: FrameRequestCallback[] = [];
const T0 = 1000;
let elapsed = 0;

beforeEach(() => {
  rafQueue = [];
  elapsed = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function tick(ts: number) {
  const cbs = rafQueue;
  rafQueue = [];
  act(() => {
    cbs.forEach((cb) => cb(ts));
  });
}

/** Prime the frame clock (first tick records the baseline, advances nothing). */
function prime() {
  tick(T0);
}

/** Advance `n` whole frames since priming (timestamps stay monotonic). */
function step(n = 1) {
  elapsed += n;
  tick(T0 + elapsed * STEP_MS);
}

describe("useScramble", () => {
  it("returns the full text immediately when disabled", () => {
    const { result } = renderHook(() => useScramble("Hello World", false));
    expect(result.current.display).toBe("Hello World");
    expect(result.current.scrambleStart).toBe(11);
  });

  it("starts empty when enabled and nothing has been revealed yet", () => {
    const { result } = renderHook(() => useScramble("Hello World", true));
    expect(result.current.display).toBe("");
    expect(result.current.scrambleStart).toBe(0);
  });

  it("scrambles the first word with case-matched glyphs on the first frame", () => {
    const { result } = renderHook(() => useScramble("Hello World", true));
    prime();
    step(1);
    // The whole word is still decoding: glyphs match the case of "Hello".
    expect(result.current.scrambleStart).toBe(0);
    expect(result.current.display).toHaveLength(5);
    expect(result.current.display).toMatch(/^[A-Z][a-z]{4}$/);
  });

  it("matches uppercase, lowercase and digits, and passes punctuation through", () => {
    const { result } = renderHook(() => useScramble("Ab9-z end", true));
    prime();
    step(1);
    // "Ab9-z": A->upper, b->lower, 9->digit, '-' unchanged, z->lower.
    expect(result.current.display).toMatch(/^[A-Z][a-z][0-9]-[a-z]$/);
  });

  it("resolves a word and settles the trailing space, then waits on the last word", () => {
    const { result } = renderHook(() => useScramble("Hello World", true));
    prime();
    step(16);
    // "Hello" has decoded and the space settled; "World" is the final token with
    // no boundary after it, so it waits (would snap in via Markdown when done).
    expect(result.current.display).toBe("Hello ");
    expect(result.current.scrambleStart).toBe(6);
  });

  it("eventually settles to the full text when it ends on a boundary", () => {
    const { result } = renderHook(() => useScramble("Hi there ", true));
    prime();
    step(60);
    expect(result.current.display).toBe("Hi there ");
    expect(result.current.scrambleStart).toBe(9);
  });

  it("decodes a word only once more text proves it is complete", () => {
    const { result, rerender } = renderHook(({ t, e }) => useScramble(t, e), {
      initialProps: { t: "Hello", e: true },
    });
    prime();
    step(20);
    // "Hello" is the trailing token of the chunk so far — it waits.
    expect(result.current.display).toBe("");

    rerender({ t: "Hello World", e: true });
    step(20);
    // Now a boundary follows "Hello", so it decodes; "World" waits in turn.
    expect(result.current.display).toBe("Hello ");
  });

  it("snaps to the full text when disabled mid-decode", () => {
    const { result, rerender } = renderHook(({ e }) => useScramble("Hello World", e), {
      initialProps: { e: true },
    });
    prime();
    step(1);
    expect(result.current.display).not.toBe("Hello World");

    rerender({ e: false });
    expect(result.current.display).toBe("Hello World");
    expect(result.current.scrambleStart).toBe(11);
  });

  it("drops the active word when the text shrinks under it (reset)", () => {
    const { result, rerender } = renderHook(({ t }) => useScramble(t, true), {
      initialProps: { t: "Hello World" },
    });
    prime();
    step(1); // "Hello" decoding
    rerender({ t: "He" }); // the word being decoded no longer fits
    step(1);
    expect(result.current.display).toBe(""); // "He" is now the trailing token; it waits
    expect(result.current.scrambleStart).toBe(0);
  });

  it("clamps settled progress back into range when the text shrinks after settling", () => {
    const { result, rerender } = renderHook(({ t }) => useScramble(t, true), {
      initialProps: { t: "Hi there " },
    });
    prime();
    step(60); // fully settled at 9
    rerender({ t: "Hi" }); // shorter than what we'd settled
    step(1);
    expect(result.current.display).toBe("Hi");
    expect(result.current.scrambleStart).toBe(2);
  });

  it("snaps to the final text after a long pause instead of grinding catch-up frames", () => {
    // A backgrounded tab pauses rAF, then resumes with a huge timestamp jump. Without
    // the snap, the one tick would grind tens of thousands of catch-up frames and
    // freeze the UI. Instead it jumps straight to the finished text.
    const text = "aa bb cc dd ee ff gg hh ii jj ";
    const { result } = renderHook(() => useScramble(text, true));
    prime();
    tick(T0 + 10 * 60 * 1000); // ~10 minutes later
    expect(result.current.display).toBe(text);
    expect(result.current.scrambleStart).toBe(text.length);
  });
});

describe("usePrefersReducedMotion", () => {
  it("returns false when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it("reflects the setting, reacts to changes, and unsubscribes on unmount", () => {
    let handler: (() => void) | null = null;
    const removeEventListener = vi.fn();
    const mq = {
      matches: true,
      addEventListener: (_type: string, h: () => void) => {
        handler = h;
      },
      removeEventListener,
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mq),
    );

    const { result, unmount } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);

    act(() => {
      mq.matches = false;
      handler?.();
    });
    expect(result.current).toBe(false);

    unmount();
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });
});
