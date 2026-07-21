import { channel } from "../lib/channel";

/**
 * A visible title-bar pill for tester and self-dev builds.
 *
 * Beta and self-dev each keep separate history and settings from Stable, so the
 * marker prevents accidental testing in the wrong installation.
 */
export function ChannelBadge() {
  const activeChannel = channel();
  if (activeChannel === "stable") return null;
  const isBeta = activeChannel === "beta";
  return (
    <span
      className={`pc-pill ${isBeta ? "pc-pill--warn" : "pc-pill--accent"}`}
      title={
        isBeta
          ? "Beta build — receives tester releases from the beta update channel"
          : "Self-dev build — separate history & settings from your everyday Portcode"
      }
    >
      <span className={`pc-dot ${isBeta ? "pc-dot--warn" : "pc-dot--accent"}`} />
      {isBeta ? "BETA" : "DEV"}
    </span>
  );
}
