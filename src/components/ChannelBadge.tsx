import { isSelfDev } from "../lib/channel";

/**
 * A small magenta "DEV" pill in the title bar, shown only in the self-dev build.
 *
 * It's the at-a-glance answer to "which Portcode am I in?" — the self-dev build
 * keeps its own separate history & settings from your everyday app, so the
 * marker matters. Renders nothing in the normal (stable) build.
 */
export function ChannelBadge() {
  if (!isSelfDev()) return null;
  return (
    <span
      className="pc-pill pc-pill--accent"
      title="Self-dev build — separate history & settings from your everyday Portcode"
    >
      <span className="pc-dot pc-dot--accent" />
      DEV
    </span>
  );
}
