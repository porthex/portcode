import { isSelfDev } from "../lib/channel";
import { useStore } from "../store/store";

/**
 * The self-dev promotion control, shown beside the DEV pill ONLY in the self-dev
 * build (gated on {@link isSelfDev}). It is the at-a-glance state of the Phase-2
 * promotion gate (SLICE 1): snapshot → frontend tests → Rust tests → pass/fail.
 *
 * States:
 * - `idle`             — a "Promote" button that kicks off {@link beginPromotion}.
 * - `snapshotting`     — "Snapshotting…" + a shimmer (reuses UpdateBanner's
 *   `pc-shimmer` look).
 * - `testing_frontend` — "Testing FE…" + shimmer.
 * - `testing_rust`     — "Testing RS…" + shimmer.
 * - `done`             — "Gate passed ✓" (success).
 * - `failed`           — a warning pill carrying the failure `message`.
 *
 * NO binary swap and NO restart happen here — the gate runs and reports; the
 * restart is SLICE 2. Renders nothing in the normal (stable) build.
 */
export function PromoteBadge() {
  const phase = useStore((s) => s.promotePhase);
  const message = useStore((s) => s.promoteMessage);
  const beginPromotion = useStore((s) => s.beginPromotion);
  const cancelPromotion = useStore((s) => s.cancelPromotion);

  if (!isSelfDev()) return null;

  // Running phases share a shimmer + a Cancel affordance.
  const running =
    phase === "snapshotting" || phase === "testing_frontend" || phase === "testing_rust";

  const runningLabel =
    phase === "snapshotting"
      ? "Snapshotting…"
      : phase === "testing_frontend"
        ? "Testing FE…"
        : "Testing RS…";

  return (
    <span data-testid="promote-badge" className="flex items-center gap-1.5">
      {/* sr-only live region so AT hears the terminal states (mirrors UpdateBanner). */}
      <span className="sr-only" role="status" aria-live="polite">
        {phase === "done"
          ? "Promotion gate passed."
          : phase === "failed"
            ? `Promotion failed. ${message ?? ""}`
            : ""}
      </span>

      {phase === "idle" && (
        <button
          type="button"
          onClick={() => void beginPromotion()}
          title="Snapshot the DB, then run the test gate (pnpm test + cargo test)"
          className="pc-pill pc-pill--accent transition-colors hover:brightness-110"
        >
          <span className="pc-dot pc-dot--accent" />
          Promote
        </button>
      )}

      {running && (
        <>
          <span
            className="pc-pill pc-pill--accent"
            data-testid="promote-running"
            title="The promotion gate is running"
          >
            <span className="pc-dot pc-dot--accent pc-shimmer" />
            {runningLabel}
          </span>
          <button
            type="button"
            onClick={() => void cancelPromotion()}
            aria-label="Cancel promotion"
            title="Cancel promotion"
            className="rounded-md border border-border-2 bg-panel-2/80 px-2 py-0.5 font-mono text-[10px] text-muted transition-colors hover:border-danger/50 hover:text-danger"
          >
            ✕
          </button>
        </>
      )}

      {phase === "done" && (
        <button
          type="button"
          onClick={() => void beginPromotion()}
          title="Gate passed — tests green. Click to run again. (Restart is Slice 2.)"
          className="pc-pill pc-pill--success transition-colors hover:brightness-110"
        >
          <span className="pc-dot pc-dot--success" />
          Gate passed ✓
        </button>
      )}

      {phase === "failed" && (
        <button
          type="button"
          onClick={() => void beginPromotion()}
          title={message ?? "Promotion failed — click to retry"}
          className="pc-pill pc-pill--warn transition-colors hover:brightness-110"
        >
          <span className="pc-dot pc-dot--warn" />
          {message ?? "Promotion failed"}
        </button>
      )}
    </span>
  );
}
