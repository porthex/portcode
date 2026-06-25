// App Badging for the iOS web client (docs/IOS_WEB_CLIENT_PLAN.md §5.7).
//
// The installed PWA shows a numeric badge on its Home-Screen icon for the count of
// PENDING PERMISSION DECISIONS — the same in-app queue that is the source of truth
// (§5.7). When a desktop turn pauses on a permission gate, the badge nudges the user
// back even if the (best-effort) push didn't fire. When the queue clears, the badge
// clears.
//
// `navigator.setAppBadge` / `clearAppBadge` are absent on most hosts (no support in
// the Tauri webview, jsdom, or Safari tabs — only installed PWAs on supporting
// platforms). So this is a tiny GUARDED, INJECTABLE helper: it resolves the badge
// API from the global navigator by default, no-ops when it's missing, and never
// throws (the spec'd methods return promises that we swallow). Fully unit-testable
// with a fake navigator.

/** The subset of the App Badging API we use. Both methods are optional on the real
 *  `Navigator`, so callers/tests can supply a partial object. */
export interface AppBadgeApi {
  setAppBadge?(contents?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
}

/** Resolve the badge API from the global navigator, or `undefined` when there is no
 *  navigator (non-DOM host). The methods themselves may still be absent. */
function defaultBadgeApi(): AppBadgeApi | undefined {
  return typeof navigator === "undefined" ? undefined : (navigator as AppBadgeApi);
}

/**
 * Reflect a pending-decision `count` onto the Home-Screen icon badge.
 *
 * - `count > 0` → `setAppBadge(count)` (a numeric badge).
 * - `count <= 0` → `clearAppBadge()` (no badge).
 *
 * No-ops (returns without throwing) when the badge API — or the specific method —
 * is unavailable, so it's safe to call unconditionally from the store subscription
 * on every host. The underlying promise is fire-and-forget and its rejection is
 * swallowed: a badge is cosmetic re-engagement, never allowed to break the app.
 */
export function setPendingBadge(
  count: number,
  api: AppBadgeApi | undefined = defaultBadgeApi(),
): void {
  if (!api) return;
  if (count > 0) {
    // Guard the method too: `setAppBadge` can be absent even when navigator exists.
    void api.setAppBadge?.(count)?.catch(() => {});
  } else {
    void api.clearAppBadge?.()?.catch(() => {});
  }
}
