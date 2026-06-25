// Small, pure formatters for presenting a Session in the UI. Shared by the mobile
// remote screens (sessions list, switcher, chat header) so the "⎇ workspace · time"
// label reads identically everywhere. Kept dependency-free and easily unit-tested.

/** Basename of a workspace path, or "local" when none is set. Handles both
 *  POSIX and Windows separators and trailing slashes. Accepts undefined so it can
 *  be called with an optional session's workspace (`session?.workspace`). */
export function workspaceLabel(workspace: string | null | undefined): string {
  if (!workspace) return "local";
  const parts = workspace.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "local";
}

/** Compact relative time from an epoch-ms timestamp: now / Nm / Nh / yest / Nd. */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "now";
  const hr = Math.floor(min / 60);
  if (hr < 1) return `${min}m`;
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yest";
  return `${day}d`;
}
