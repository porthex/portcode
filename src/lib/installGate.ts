// iOS PWA install gate for the web remote client.
//
// Implements docs/IOS_WEB_CLIENT_PLAN.md §5.7 ("Install gate (P0)"). On iOS,
// installing the app to the Home Screen is a HARD prerequisite for pairing —
// it is not merely a nicer experience, it is load-bearing:
//
//   - Web Push only works for installed (Home-Screen) PWAs on iOS. A pairing
//     done inside Safari can never receive the "permission decision needed" /
//     "turn finished" pushes that the remote client relies on (§5.7).
//   - Durable storage: `navigator.storage.persist()` is only honored for
//     installed PWAs, so the pinned peer key + device identity we write to
//     IndexedDB at pair time would be eviction-eligible in a plain tab.
//   - Storage partitioning: Safari and the installed Home-Screen app use
//     SEPARATE storage partitions. A key pinned in Safari is invisible to the
//     installed app (and vice versa). Pairing in the browser and then "opening
//     the app" would silently lose the pinned key — so pairing MUST happen
//     inside the installed app to land in the partition the app will read from.
//
// Because of all three, on iOS we BLOCK pairing until the app is installed and
// reopened from the Home Screen, and surface guidance for the Share → Add to
// Home Screen flow. On non-iOS (desktop / Android browsers) install grants real
// benefits too, but the partition/push constraints do not make it mandatory, so
// we allow pairing and only mildly suggest installing.
//
// Everything here is a pure, side-effect-free global sniff (matchMedia +
// navigator), mirroring src/lib/platform.ts, so it is trivially unit-testable by
// stubbing `window` / `navigator`.

/**
 * True for an iOS user agent (iPhone / iPad / iPod).
 *
 * Also detects "iPadOS-as-desktop": since iPadOS 13, iPad Safari reports a
 * "Macintosh" desktop user agent by default. We disambiguate a real Mac from an
 * iPad by touch support — Macs report `maxTouchPoints === 0`, iPads report a
 * positive value. This matters because the install gate is iOS-specific.
 *
 * Tolerates a missing `navigator` (non-DOM host) by returning false.
 */
export function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPadOS-as-desktop: "Macintosh" UA but with a touchscreen.
  if (/Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1) return true;
  return false;
}

/**
 * True when the app is running as an installed (standalone) PWA rather than in a
 * browser tab.
 *
 * Two signals, because iOS predates the standard:
 *   - The spec-compliant `matchMedia("(display-mode: standalone)")`.
 *   - The legacy iOS-only `navigator.standalone === true`, which older/edge iOS
 *     versions still report and which the media query does not always cover.
 *
 * Tolerates a missing `window` / `navigator` / `matchMedia` (non-DOM host or an
 * environment without the media-query API) by returning false.
 */
export function isStandalonePwa(): boolean {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches
  ) {
    return true;
  }
  if (
    typeof navigator !== "undefined" &&
    "standalone" in navigator &&
    (navigator as unknown as { standalone?: boolean }).standalone === true
  ) {
    return true;
  }
  return false;
}

/**
 * Why pairing is (or isn't) allowed in the current host.
 *   - "ok"          installed PWA — pairing allowed.
 *   - "needs-install" iOS in a browser tab — pairing BLOCKED until installed.
 *   - "not-ios-ok"  non-iOS browser — pairing allowed, install merely suggested.
 */
export type InstallReason = "ok" | "needs-install" | "not-ios-ok";

/** Snapshot of the install gate, sufficient to drive the pairing UI. */
export interface InstallState {
  /** Running as an installed (Home-Screen / standalone) PWA. */
  installed: boolean;
  /** Running on iOS (including iPadOS-as-desktop). */
  ios: boolean;
  /** Whether pairing is permitted in the current host. */
  canPair: boolean;
  /** Machine-readable reason behind `canPair`. */
  reason: InstallReason;
  /** Human-facing guidance to show the user. */
  guidance: string;
}

const IOS_INSTALL_GUIDANCE =
  "To pair on iOS, install Portcode first: tap the Share icon, choose " +
  '"Add to Home Screen", then open Portcode from your Home Screen and pair ' +
  "from there. Installing is required so push notifications, durable storage, " +
  "and your paired key all work — a paired session in Safari can't access them.";

const NON_IOS_INSTALL_GUIDANCE =
  "Tip: install Portcode (Add to Home Screen / Install App) for the best " +
  "experience — offline launch, push notifications, and durable storage.";

const INSTALLED_GUIDANCE = "Portcode is installed. You're ready to pair.";

/**
 * Evaluate the install gate for the current host.
 *
 * Rules (see §5.7):
 *   - Installed PWA           → canPair, reason "ok".
 *   - iOS, not installed      → BLOCKED, reason "needs-install" (Share → Add to
 *                               Home Screen guidance).
 *   - Non-iOS, not installed  → canPair, reason "not-ios-ok" (mild install tip).
 */
export function getInstallState(): InstallState {
  const installed = isStandalonePwa();
  const ios = isIosSafari();

  if (installed) {
    return {
      installed: true,
      ios,
      canPair: true,
      reason: "ok",
      guidance: INSTALLED_GUIDANCE,
    };
  }

  if (ios) {
    return {
      installed: false,
      ios: true,
      canPair: false,
      reason: "needs-install",
      guidance: IOS_INSTALL_GUIDANCE,
    };
  }

  return {
    installed: false,
    ios: false,
    canPair: true,
    reason: "not-ios-ok",
    guidance: NON_IOS_INSTALL_GUIDANCE,
  };
}
