// Tests for the build.sourcemap conditional introduced in Phase 2:
//   sourcemap: !!process.env.SENTRY_AUTH_TOKEN
//
// The vite config is a plain ES module whose export is evaluated at import
// time, so `process.env` must be configured BEFORE the import. We use
// vi.stubEnv + vi.resetModules + a dynamic import helper to reload the
// module fresh for each environment scenario.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserConfig } from "vite";

// Helper: reset module registry and dynamically re-import vite.config so the
// export is re-evaluated against the current process.env snapshot.
async function loadConfig(): Promise<UserConfig> {
  vi.resetModules();
  // Vite's `defineConfig` is identity for plain objects, so the default export
  // is the config object itself (or a function that returns it). Normalise both.
  const mod = await import("../vite.config.ts");
  const raw = mod.default;
  return typeof raw === "function" ? (raw({} as never) as UserConfig) : raw;
}

describe("vite.config.ts — build.sourcemap", () => {
  // Restore any stubbed env vars after each test so tests stay independent.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sourcemap is false when SENTRY_AUTH_TOKEN is not set", async () => {
    // Contributor / fork builds: no token → no sourcemaps shipped.
    // Explicitly remove the key so process.env.SENTRY_AUTH_TOKEN is truly
    // undefined (not the string "undefined"), matching a fresh checkout.
    vi.unstubAllEnvs();
    delete process.env.SENTRY_AUTH_TOKEN;
    const config = await loadConfig();
    expect(config.build?.sourcemap).toBe(false);
  });

  it("sourcemap is false when SENTRY_AUTH_TOKEN is an empty string", async () => {
    // A blank token (e.g. the secret exists but has no value) must also
    // disable sourcemaps — !!'' is false.
    vi.stubEnv("SENTRY_AUTH_TOKEN", "");
    const config = await loadConfig();
    expect(config.build?.sourcemap).toBe(false);
  });

  it("sourcemap is true when SENTRY_AUTH_TOKEN is a non-empty string", async () => {
    // Release CI: a real token enables sourcemap upload.
    vi.stubEnv("SENTRY_AUTH_TOKEN", "sntrys_test_token_abc123");
    const config = await loadConfig();
    expect(config.build?.sourcemap).toBe(true);
  });

  it("sourcemap coerces truthy/falsy consistently with !! operator", async () => {
    // Guard against a refactor that changes the expression to a ternary or
    // optional-chain: the returned value must be a boolean, not a string.
    vi.stubEnv("SENTRY_AUTH_TOKEN", "any-value");
    const config = await loadConfig();
    expect(typeof config.build?.sourcemap).toBe("boolean");
  });
});

describe("vite.config.ts — build target and minify", () => {
  // These values were not changed by the PR but are here as regression anchors
  // so an accidental change to adjacent config lines doesn't go unnoticed.
  beforeEach(() => {
    vi.stubEnv("SENTRY_AUTH_TOKEN", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("build target is es2021", async () => {
    const config = await loadConfig();
    expect(config.build?.target).toBe("es2021");
  });

  it("minify is esbuild", async () => {
    const config = await loadConfig();
    expect(config.build?.minify).toBe("esbuild");
  });
});