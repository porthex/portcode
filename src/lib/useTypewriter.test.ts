import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useTypewriter } from "./useTypewriter";

// The reveal is driven by requestAnimationFrame. We stub it with a manual queue
// so the animation is fully deterministic: each `tick(ts)` runs the frame that
// the hook most recently scheduled, at an absolute timestamp in milliseconds.
let frame: ((ts: number) => void) | null = null;

beforeEach(() => {
  frame = null;
  vi.stubGlobal("requestAnimationFrame", (cb: (ts: number) => void) => {
    frame = cb;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frame = null;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function tick(ts: number) {
  const cb = frame;
  frame = null;
  if (cb) act(() => cb(ts));
}

describe("useTypewriter", () => {
  it("returns the full text immediately when disabled", () => {
    const { result } = renderHook(() => useTypewriter("hello world", false));
    expect(result.current).toBe("hello world");
  });

  it("reveals progressively when enabled and catches up to the end", () => {
    const text = "x".repeat(300);
    const { result } = renderHook(() => useTypewriter(text, true));

    // Nothing is revealed until the first frame runs.
    expect(result.current).toBe("");

    // The first frame seeds the clock (dt = 0 → the +1 minimum advance).
    tick(1000);
    expect(result.current.length).toBeGreaterThanOrEqual(1);
    expect(result.current.length).toBeLessThan(text.length);

    // ~1s later at 140 cps reveals ~140 more chars, never overshooting.
    tick(2000);
    expect(result.current.length).toBeGreaterThan(100);
    expect(result.current.length).toBeLessThanOrEqual(text.length);

    // Enough elapsed time fully reveals the text and stops scheduling frames.
    tick(5000);
    expect(result.current).toBe(text);
    expect(frame).toBeNull();
  });

  it("snaps to the full text when toggled from enabled to disabled", () => {
    const text = "abcdefghij";
    const { result, rerender } = renderHook(({ enabled }) => useTypewriter(text, enabled), {
      initialProps: { enabled: true },
    });

    expect(result.current).toBe("");
    rerender({ enabled: false });
    expect(result.current).toBe(text);
  });
});
