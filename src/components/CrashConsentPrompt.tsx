import { useStore } from "../store/store";

// One-time, first-run consent for crash reporting. Rendered only when the choice
// is still unmade (`crashReporting === null`) AND this build can actually report
// (a DSN was baked in). Default-decline posture: there's no pre-checked box and
// dismissing without choosing leaves it null, so nothing is ever sent until the
// user actively says yes. Re-toggleable later in Settings → Privacy.
export function CrashConsentPrompt() {
  const setCrashReporting = useStore((s) => s.setCrashReporting);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pc-consent-title"
    >
      <div className="pc-neon-frame w-full max-w-[440px]">
        <div className="rounded-[13px] bg-panel p-6">
          <div id="pc-consent-title" className="pc-eyebrow pc-eyebrow--accent">
            HELP FIX CRASHES?
          </div>
          <p className="mb-3 mt-1 text-[13px] leading-[1.55] text-muted">
            Portcode can send{" "}
            <span className="text-fg">anonymous crash &amp; performance reports</span> when
            something breaks or runs slow — the error, a scrubbed stack trace, and basic timing.
          </p>
          <ul className="mb-4 space-y-1.5 text-[12px] leading-[1.5] text-muted">
            <li>
              <span className="text-accent-2">✓</span> Never your prompts, code, files, or API keys
            </li>
            <li>
              <span className="text-accent-2">✓</span> Off unless you turn it on — change it anytime
              in Settings
            </li>
          </ul>
          <button
            onClick={() => setCrashReporting(true)}
            className="pc-btn-accent w-full px-3 py-2.5 text-[13px]"
          >
            Enable crash reports
          </button>
          <button
            onClick={() => setCrashReporting(false)}
            className="mt-2 w-full rounded-lg border border-border bg-panel px-3 py-2.5 text-[12.5px] text-muted transition-colors hover:border-accent/40 hover:text-fg"
          >
            No thanks
          </button>
        </div>
      </div>
    </div>
  );
}
