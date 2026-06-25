import { getInstallState } from "../lib/installGate";

// iOS PWA install-gate onboarding screen (docs/IOS_WEB_CLIENT_PLAN.md §5.7).
//
// On iOS, pairing in a plain Safari tab is load-bearing-broken: Web Push, durable
// storage (`navigator.storage.persist()`), and the storage PARTITION the installed
// app reads from are all gated on being installed to the Home Screen. So in the
// web client we BLOCK pairing behind this screen until the user has added Portcode
// to their Home Screen and reopened it from there — at which point `getInstallState`
// flips to "ok" and `App` renders the pairing flow instead.
//
// This component is mounted by `App` ONLY when running as the web client AND the
// install state is "needs-install" (iOS, not yet installed). It is a pure render of
// the Share → Add to Home Screen guidance in the app's dark Neon-Noir language,
// mirroring the OfflineState/DisconnectedState edge screens; the install state it
// shows is read once from `getInstallState()` (a static global sniff — a reopened
// Home-Screen launch is a fresh document, so there is nothing to re-poll live).

/** A single numbered step in the install walkthrough. */
function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-left">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/10 font-mono text-[12px] font-bold text-accent">
        {n}
      </span>
      <span className="text-[13px] leading-[1.55] text-muted">{children}</span>
    </li>
  );
}

/** Full-screen "Add to Home Screen" onboarding shown to iOS users who opened the
 *  web client in a Safari tab. Pairing is blocked until they install + reopen. */
export function InstallGate() {
  // Read once: the guidance string is authored in installGate and stays the source
  // of truth for the copy, so a screen reader hears the same text the gate logic uses.
  const { guidance } = getInstallState();

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg p-[22px] text-fg">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 text-center">
        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-[22px] border border-accent/[0.32] bg-accent/[0.06] shadow-glow-accent">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 3v11M12 3l-3.5 3.5M12 3l3.5 3.5"
              stroke="var(--color-accent)"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"
              stroke="var(--color-accent)"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <p className="font-mono text-[10px] tracking-[3px] text-accent">⬆ INSTALL REQUIRED</p>
        <h1 className="mt-2 font-display text-[22px] font-bold text-fg">
          Add Portcode to your Home Screen
        </h1>
        <p className="mt-2 text-[13px] leading-[1.55] text-muted">
          On iOS, pairing needs the installed app — that's what unlocks push notifications, durable
          storage, and your paired key. Install first, then pair from the Home-Screen app.
        </p>

        <ol className="mt-6 flex max-w-[300px] flex-col gap-3.5">
          <Step n={1}>
            Tap the <span className="font-mono text-fg/90">Share</span> icon in Safari's toolbar.
          </Step>
          <Step n={2}>
            Choose <span className="font-mono text-fg/90">Add to Home Screen</span>.
          </Step>
          <Step n={3}>
            Open <span className="font-mono text-fg/90">Portcode</span> from your Home Screen, then
            pair from there.
          </Step>
        </ol>
      </div>

      {/* The authored guidance string, available to assistive tech as the canonical
          explanation (also drives the gate logic in installGate). */}
      <p className="sr-only">{guidance}</p>
    </div>
  );
}
