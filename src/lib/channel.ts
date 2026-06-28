/**
 * Which build channel this bundle was compiled for.
 *
 * `dev` is the **self-dev build** — the one you run while working ON Portcode.
 * It carries its own separate data directory (history + settings) and shows a
 * visible "DEV" marker so you never confuse it with your everyday app. Anything
 * else is the normal `stable` build.
 *
 * Driven by the `VITE_PORTCODE_CHANNEL` env var, which the `*:self` scripts set
 * via Vite's `selfdev` mode (see `.env.selfdev`). Read at call time (not at
 * module load) so tests can stub the env with `vi.stubEnv`.
 */
export type Channel = "dev" | "stable";

/** Resolve the active build channel. Defaults to `stable` for any value that
 *  isn't exactly `"dev"`, so an unset/garbage flag can never masquerade as the
 *  self-dev build. */
export function channel(): Channel {
  return import.meta.env.VITE_PORTCODE_CHANNEL === "dev" ? "dev" : "stable";
}

/** True only in the self-dev build. */
export function isSelfDev(): boolean {
  return channel() === "dev";
}
