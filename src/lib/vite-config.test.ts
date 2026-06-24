import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Tests for the sourcemap conditional added in Phase 2:
//   `sourcemap: !!process.env.SENTRY_AUTH_TOKEN`
//
// The value is computed at module-evaluation time (it is a plain property in the
// exported config object, not a function), so we must reload the module with
// vi.resetModules() to pick up each env-stub.

async function loadViteConfig() {
  // Dynamic import so vi.resetModules() takes effect before the module is read.
  const mod = await import("../../vite.config");
  // defineConfig returns its argument as-is; the default export is the resolved config.
  return mod.default as {
    build?: { sourcemap?: boolean | "inline" | "hidden" };
    [key: string]: unknown;
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("vite.config sourcemap (Phase 2 Sentry change)", () => {
  it("is false when SENTRY_AUTH_TOKEN is absent", async () => {
    // No env var → !!undefined === false → sourcemaps are NOT emitted.
    // This is the default for dev/contributor/fork builds.
    delete process.env.SENTRY_AUTH_TOKEN;
    const config = await loadViteConfig();
    expect(config.build?.sourcemap).toBe(false);
  });

  it("is false when SENTRY_AUTH_TOKEN is an empty string", async () => {
    // An empty-string env var coerces to false: !!"" === false.
    vi.stubEnv("SENTRY_AUTH_TOKEN", "");
    const config = await loadViteConfig();
    expect(config.build?.sourcemap).toBe(false);
  });

  it("is true when SENTRY_AUTH_TOKEN is set to a non-empty value", async () => {
    // A real token → !!<non-empty string> === true → sourcemaps ARE emitted.
    // This is the CI release path where symbols are uploaded to Sentry.
    vi.stubEnv("SENTRY_AUTH_TOKEN", "sntrys_sometoken123");
    const config = await loadViteConfig();
    expect(config.build?.sourcemap).toBe(true);
  });

  it("is true for any non-empty token value (not just a specific format)", async () => {
    // The guard is a simple boolean coercion — any truthy string enables sourcemaps.
    vi.stubEnv("SENTRY_AUTH_TOKEN", "1");
    const config = await loadViteConfig();
    expect(config.build?.sourcemap).toBe(true);
  });

  it("build target and minifier are unchanged by the sourcemap change", async () => {
    // Regression guard: the Phase 2 change must not accidentally alter adjacent
    // build settings (target or minifier).
    vi.stubEnv("SENTRY_AUTH_TOKEN", "token");
    const config = await loadViteConfig();
    expect(config.build?.target).toBe("es2021");
    expect(config.build?.minify).toBe("esbuild");
  });
});