// Small, pure formatters for presenting a Session in the UI. Shared by the mobile
// remote screens (sessions list, switcher, chat header) so the "⎇ workspace · time"
// label reads identically everywhere. Kept dependency-free and easily unit-tested.

import type { Session } from "../types";

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

/**
 * Display-safe account attribution for remote screens, which intentionally never
 * receive account metadata. Stable ordinals are derived locally from the opaque
 * profile ids, but the ids themselves are never rendered.
 */
export function remoteAccountLabel(
  accountProfileId: string | null | undefined,
  sessions: Pick<Session, "accountProfileId">[],
): string | null {
  if (!accountProfileId) return null;
  const profileIds = [
    ...new Set([
      accountProfileId,
      ...sessions.flatMap((session) =>
        session.accountProfileId ? [session.accountProfileId] : [],
      ),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  return `ChatGPT account ${profileIds.indexOf(accountProfileId) + 1}`;
}

/** Isolate normalized, untrusted display text in a CommonMark code span before
 * embedding it in Markdown. The fence is longer than every backtick run in the
 * value, so even hostile backticks cannot close it. The surrounding spaces are
 * removed by code-span normalization and preserve the visible value exactly,
 * while nested links/images, GFM autolinks, entities, and HTML stay literal. */
export function markdownLiteralText(value: string): string {
  if (!value) return "";
  let longestBacktickRun = 0;
  let currentBacktickRun = 0;
  for (const character of value) {
    if (character === "`") {
      currentBacktickRun += 1;
      longestBacktickRun = Math.max(longestBacktickRun, currentBacktickRun);
    } else {
      currentBacktickRun = 0;
    }
  }
  const fence = "`".repeat(longestBacktickRun + 1);
  return `${fence} ${value} ${fence}`;
}
