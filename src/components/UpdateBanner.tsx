import { useStore } from "../store/store";

/**
 * A slim banner atop the app announcing the in-app auto-update flow. Mounted in
 * App.tsx alongside the other banners; renders nothing while `update.phase` is
 * "idle" (no update offered / banner dismissed). Neon-Noir styled — its own
 * accent-magenta strip, visually distinct from the cyan RemoteBanner — and driven
 * entirely by the store's update slice.
 *
 * Phases: "available" (offer Install) → "downloading" (progress bar) → "ready"
 * (Relaunch / Later) ; "error" offers Retry. The whole thing is desktop-only in
 * practice (the update commands don't exist elsewhere), but it stays render-safe on
 * any host because the store actions it calls are all defensive no-ops there.
 */
export function UpdateBanner() {
  const update = useStore((s) => s.update);
  const startUpdateDownload = useStore((s) => s.startUpdateDownload);
  const relaunchForUpdate = useStore((s) => s.relaunchForUpdate);
  const dismissUpdateBanner = useStore((s) => s.dismissUpdateBanner);
  const checkForUpdate = useStore((s) => s.checkForUpdate);

  const { phase, info, progress } = update;
  if (phase === "idle") return null;

  const version = info?.version ?? "latest";

  return (
    <div
      data-testid="update-banner"
      className="relative flex shrink-0 flex-col gap-1 border-b border-accent/25 bg-accent/5 px-4 py-2"
    >
      {/* sr-only live region: announce the ready (and error) states for AT, mirroring
          App.tsx's remote-link region. The visible copy below is decorative chrome. */}
      <span className="sr-only" role="status" aria-live="polite">
        {phase === "ready"
          ? `Update ready. Relaunch to install version ${version}.`
          : phase === "error"
            ? "Update failed."
            : ""}
      </span>

      <div className="flex items-center justify-between gap-3">
        {phase === "available" && (
          <>
            <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-accent">
              <span className="pc-dot" />
              Update available · v{version}
            </span>
            <button
              type="button"
              onClick={() => void startUpdateDownload()}
              className="pc-btn-accent shrink-0 px-3 py-1 text-[11px]"
            >
              Install
            </button>
          </>
        )}

        {phase === "downloading" && (
          <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-accent">
            <span className="pc-dot" />
            Downloading update… {progress ?? ""}
            {progress !== null && "%"}
          </span>
        )}

        {phase === "ready" && (
          <>
            <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-success">
              <span className="pc-dot pc-dot--success" />
              Update ready · v{version}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void relaunchForUpdate()}
                className="pc-btn-accent px-3 py-1 text-[11px]"
              >
                Relaunch now
              </button>
              <button
                type="button"
                onClick={dismissUpdateBanner}
                className="rounded-md border border-border-2 bg-panel-2/80 px-2.5 py-1 font-mono text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-fg"
              >
                Later
              </button>
            </div>
          </>
        )}

        {phase === "error" && (
          <>
            <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[1.5px] text-warn">
              <span className="pc-dot pc-dot--warn" />
              Update failed
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void checkForUpdate()}
                className="rounded-md border border-border-2 bg-panel-2/80 px-2.5 py-1 font-mono text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-fg"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={dismissUpdateBanner}
                aria-label="Dismiss update notice"
                className="rounded-md border border-border-2 bg-panel-2/80 px-2.5 py-1 font-mono text-[11px] text-muted transition-colors hover:border-danger/50 hover:text-danger"
              >
                ✕
              </button>
            </div>
          </>
        )}
      </div>

      {/* Progress bar lives below the row so the indeterminate shimmer spans the
          full banner width. A thin accent track; the fill is determinate when we
          know the percent and an animated shimmer when we don't. */}
      {phase === "downloading" && (
        <div
          className="mt-1 h-1 w-full overflow-hidden rounded-full bg-panel-2"
          role="progressbar"
          aria-label="Update download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(progress !== null ? { "aria-valuenow": progress } : {})}
        >
          {progress !== null ? (
            <div
              data-testid="update-progress-fill"
              className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
              style={{ width: `${progress}%` }}
            />
          ) : (
            <div
              data-testid="update-progress-shimmer"
              className="pc-shimmer h-full w-1/3 rounded-full bg-accent"
            />
          )}
        </div>
      )}
    </div>
  );
}
