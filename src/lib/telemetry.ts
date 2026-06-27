// Opt-in crash & performance reporting. The whole pipeline is INERT unless two
// conditions hold: the user has explicitly consented (`crashReporting === true`)
// AND a DSN was injected at build time (`VITE_SENTRY_DSN`). Dev builds, contributor
// builds, and forks ship no DSN, so reporting is physically impossible there —
// preserving Portcode's "zero telemetry by default" promise. See docs/SENTRY_PLAN.md.
//
// Sentry's `init` installs the global `window.onerror` / `unhandledrejection`
// handlers and browser performance tracing for us; `beforeSend` routes every event
// through the allowlist scrubber in `lib/scrub` before it can leave the machine.

import * as Sentry from "@sentry/react";
import { scrubEvent, scrubTransaction } from "./scrub";

// Two flags, on purpose:
//   `initialized` — has Sentry.init() run this session (one-way; can't cleanly undo).
//   `consentLive` — the user's CURRENT consent, checked at send time in beforeSend.
// Enforcing consent at the edge (not via Sentry.close()) means: opt-out is instant
// and total — every event is dropped, including ones Sentry's own global handlers
// and tracing auto-capture outside any caller guard — and opt-in-again just flips
// the flag instead of trying to re-init a permanently-closed client.
let initialized = false;
let consentLive = false;

/** Build-time DSN, or undefined when absent/blank (dev/contributor/fork builds). */
export function readDsn(): string | undefined {
  const d = (import.meta.env.VITE_SENTRY_DSN as string | undefined)?.trim();
  return d ? d : undefined;
}

/** True when a DSN was baked in — i.e. this build is *capable* of reporting if the
 *  user opts in. Used to decide whether to even offer the consent prompt. */
export function telemetryConfigured(): boolean {
  return readDsn() !== undefined;
}

/** True when reporting is currently live (consented this session). */
export function isTelemetryActive(): boolean {
  return consentLive;
}

/**
 * Turn reporting ON iff consent is granted AND a DSN exists. Initializes Sentry
 * exactly once per session; subsequent opt-ins just re-arm the consent flag. Safe
 * to call repeatedly (e.g. from a settings-change effect). Returns whether
 * reporting is now live.
 */
export function initTelemetry(consent: boolean | null): boolean {
  if (consent !== true) {
    consentLive = false; // off by default / declined / not-yet-asked
    return false;
  }
  const dsn = readDsn();
  if (!dsn) return false; // no DSN → permanent no-op (dev/contributor/fork builds)

  consentLive = true;
  if (initialized) return true; // already wired this session; the flag flip is enough

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: (import.meta.env.VITE_APP_VERSION as string | undefined) || undefined,
    // Never let Sentry attach IP/cookies/headers or other default PII.
    sendDefaultPii: false,
    // Sample performance transactions to cap volume/cost.
    tracesSampleRate: 0.15,
    integrations: [Sentry.browserTracingIntegration()],
    maxBreadcrumbs: 30,
    // The privacy gate, enforced at the edge: when consent isn't live, return null
    // to DROP the event — this catches errors/transactions captured by Sentry's own
    // global handlers + tracing, not just the manual `reportError` path. When live,
    // every event is rebuilt + redacted by the scrubber before it can leave.
    beforeSend: (event) => (consentLive ? scrubEvent(event) : null),
    beforeSendTransaction: (event) => (consentLive ? scrubTransaction(event) : null),
  });
  initialized = true;
  return true;
}

/** Turn reporting OFF (the consent toggle going off). We do NOT `Sentry.close()`:
 *  closing is permanent and leaves the global handlers installed, so a later opt-in
 *  couldn't cleanly re-init. Flipping the flag makes `beforeSend` drop everything —
 *  instant, total, and reversible. */
export function shutdownTelemetry(): void {
  consentLive = false;
}

/** Report a caught error (e.g. from the React error boundary). No-op unless
 *  reporting is live; the event is scrubbed by `beforeSend` like any other. */
export function reportError(error: unknown): void {
  if (!consentLive) return;
  Sentry.captureException(error);
}
