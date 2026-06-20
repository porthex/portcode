import { useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Glyph set — module constant so it isn't re-allocated on every render
// ---------------------------------------------------------------------------
const GLYPHS = "01<>{}[]/=+*#ABCDEF0123456789アイウエオカキクケコ";
const GLYPH_COUNT = GLYPHS.length;

// ---------------------------------------------------------------------------
// Color constants — single source; tweak here, not scattered in draw()
// ---------------------------------------------------------------------------
const COLOR_CYAN = "rgba(33,230,255,0.42)";
const COLOR_MAGENTA = "rgba(255,46,126,0.5)";

// ---------------------------------------------------------------------------
// Physics / performance
// ---------------------------------------------------------------------------
const FONT_SIZE = 14; // logical pixels, per-glyph cell height
const COL_GAP = 18; // logical pixels between columns
const TRAIL_ALPHA = 0.14; // fade speed (higher = shorter trails)
const FALL_SPEED = 80; // logical pixels per second (frame-rate independent)
const TARGET_FPS = 30; // cap render rate — backdrop needs no more than 30fps
const FRAME_BUDGET_MS = 1000 / TARGET_FPS;
const RESIZE_DEBOUNCE_MS = 120;

/**
 * NeonRain — ambient cyberpunk "digital rain" backdrop for Portcode.
 *
 * Ships OFF by default: the parent should only mount this when the user
 * enables it in Settings (e.g. `{settings.ambientRain && <NeonRain />}`).
 * Purely decorative — pointer-events:none, fixed behind the app, and it
 * bails out entirely under prefers-reduced-motion.
 *
 * Stability note: this is the ONLY large-scale motion in the product, and
 * it lives behind the UI as a backdrop — it never moves interface geometry.
 */
export function NeonRain({ opacity = 0.45 }: { opacity?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;

    // -----------------------------------------------------------------------
    // Respect prefers-reduced-motion — also react to OS-level toggles
    // -----------------------------------------------------------------------
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motionQuery.matches) return;

    const ctx = cv.getContext("2d");
    if (!ctx) return;

    // -----------------------------------------------------------------------
    // Device pixel ratio — capped at 2 to avoid oversized buffers on 3x
    // -----------------------------------------------------------------------
    const dpr = Math.min(window.devicePixelRatio ?? 1, 2);

    // -----------------------------------------------------------------------
    // Canvas dimensions and column state
    //
    // Each entry in `columns` is the PIXEL Y-position (logical, not row index)
    // of the leading glyph for that column.  Starts at a random negative offset
    // so columns stagger their entrance rather than all appearing at once.
    // -----------------------------------------------------------------------
    let width = 0; // canvas buffer width (physical px)
    let height = 0; // canvas buffer height (physical px)
    let logicalHeight = 0; // window height (logical px) — reset threshold
    let columns: number[] = [];

    const applyResize = () => {
      width = cv.width = Math.floor(window.innerWidth * dpr);
      height = cv.height = Math.floor(window.innerHeight * dpr);
      cv.style.width = `${window.innerWidth}px`;
      cv.style.height = `${window.innerHeight}px`;
      logicalHeight = window.innerHeight;
      const n = Math.ceil(window.innerWidth / COL_GAP);
      // Preserve existing column positions where possible; add fresh staggered
      // offsets only for newly created columns.
      const prev = columns;
      columns = Array.from({ length: n }, (_, i) => prev[i] ?? Math.random() * -logicalHeight);
    };

    // Debounced resize: avoid thrashing the canvas on every pixel of a drag
    let resizeTimer = 0;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(applyResize, RESIZE_DEBOUNCE_MS);
    };
    applyResize();
    window.addEventListener("resize", onResize);

    // -----------------------------------------------------------------------
    // Reduced-motion toggle while the component is mounted
    // -----------------------------------------------------------------------
    const onMotionChange = (e: MediaQueryListEvent) => {
      if (e.matches) stopLoop();
      else startLoop();
    };
    motionQuery.addEventListener("change", onMotionChange);

    // -----------------------------------------------------------------------
    // Visibility — pause the loop when the window is hidden/minimised
    // -----------------------------------------------------------------------
    const onVisibility = () => {
      if (document.hidden) stopLoop();
      else if (!motionQuery.matches) startLoop();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // -----------------------------------------------------------------------
    // Draw loop — delta-time based, capped at TARGET_FPS
    // -----------------------------------------------------------------------
    let raf = 0;
    let lastTs = 0; // DOMHighResTimeStamp of last rendered frame
    let mounted = true;

    const draw = (ts: DOMHighResTimeStamp) => {
      if (!mounted) return;

      // Frame-rate cap: skip this rAF tick if the budget hasn't elapsed
      const elapsed = ts - lastTs;
      if (elapsed < FRAME_BUDGET_MS) {
        raf = requestAnimationFrame(draw);
        return;
      }
      // Clamp delta to avoid a huge jump after a tab becomes visible again
      const dt = Math.min(elapsed, 100) / 1000; // seconds, max 0.1s
      lastTs = ts;

      // Translucent fill leaves fading trails — alpha determines trail length
      ctx.fillStyle = `rgba(6,7,11,${TRAIL_ALPHA})`;
      ctx.fillRect(0, 0, width, height);

      ctx.font = `${FONT_SIZE * dpr}px "JetBrains Mono", monospace`;

      const delta = FALL_SPEED * dt; // logical pixels to advance this frame

      for (let i = 0; i < columns.length; i++) {
        const ch = GLYPHS[(Math.random() * GLYPH_COUNT) | 0];
        const x = i * COL_GAP * dpr;
        const y = columns[i] * dpr; // convert logical -> physical px

        // Every 6th column glows magenta; the rest cyan
        ctx.fillStyle = i % 6 === 0 ? COLOR_MAGENTA : COLOR_CYAN;
        ctx.fillText(ch, x, y);

        // Advance column; reset once off-screen (with a small random delay
        // so columns don't all reset in the same frame)
        columns[i] += delta;
        if (columns[i] * dpr > height && Math.random() > 0.975) {
          columns[i] = Math.random() * -logicalHeight * 0.5;
        }
      }

      raf = requestAnimationFrame(draw);
    };

    const startLoop = () => {
      if (raf !== 0) return; // already running
      lastTs = 0; // reset so first frame delta doesn't overshoot
      raf = requestAnimationFrame(draw);
    };

    const stopLoop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    startLoop();

    // -----------------------------------------------------------------------
    // Cleanup — cancel rAF + remove all listeners, no work after unmount
    // -----------------------------------------------------------------------
    return () => {
      mounted = false;
      stopLoop();
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      motionQuery.removeEventListener("change", onMotionChange);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        opacity,
        mixBlendMode: "screen",
      }}
    />
  );
}
