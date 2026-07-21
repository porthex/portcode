/**
 * Which build channel this bundle was compiled for.
 *
 * `dev` is the self-dev build; `beta` is the tester build promoted from `main`.
 * Both have separate app identities and visible markers so they can run next to
 * the normal `stable` app without sharing state or being mistaken for it.
 *
 * Driven by the `VITE_PORTCODE_CHANNEL` env var, which the `*:self` scripts set
 * via Vite's `selfdev` mode (see `.env.selfdev`). Read at call time (not at
 * module load) so tests can stub the env with `vi.stubEnv`.
 */
export type Channel = "beta" | "dev" | "stable";

/** Resolve the active build channel. Unknown or missing flags default to stable,
 *  so a production build can never masquerade as beta or self-dev. */
export function channel(): Channel {
  const value = import.meta.env.VITE_PORTCODE_CHANNEL;
  return value === "beta" || value === "dev" ? value : "stable";
}

/** True only in the self-dev build. */
export function isSelfDev(): boolean {
  return channel() === "dev";
}

/** True only in the tester-facing beta build. */
export function isBeta(): boolean {
  return channel() === "beta";
}
