import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Tests for the build-time sourcemap flag in vite.config.ts.
//
// The ONLY change this PR makes to vite.config.ts is:
//   sourcemap: !!process.env.SENTRY_AUTH_TOKEN
//
// Sourcemaps are emitted ONLY when SENTRY_AUTH_TOKEN is present so that release
// CI can upload them to Sentry for readable webview stack traces and they are
// not accidentally shipped inside the bundle. Dev/contributor builds (no token)
// emit none.
//
// Because the config is evaluated at module-load time we use vi.stubEnv +
// vi.resetModules so each test gets a fresh evaluation of the module with the
// correct env state.

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadViteConfig() {
  // Dynamic import after stubbing env so the module re-evaluates
  // `!!process.env.SENTRY_AUTH_TOKEN` with the new value.
  const mod = await import("../../vite.config.ts");
  // Vite's `defineConfig` can return a UserConfig directly or wrap it; unwrap.
  return typeof mod.default === "function" ? mod.default({}) : mod.default;
}

describe("vite.config sourcemap setting", () => {
  it("sourcemap is false when SENTRY_AUTH_TOKEN is absent", async () => {
    // No env var at all — the default dev/contributor build.
    vi.stubEnv("SENTRY_AUTH_TOKEN", "");
    const config = await loadViteConfig();
    expect(config.build?.sourcemap).toBe(false);
  });

  it("sourcemap is false when SENTRY_AUTH_TOKEN is an empty string", async () => {
    // Explicit empty string is falsy → no sourcemaps.
    vi.stubEnv("SENTRY_AUTH_TOKEN", "");
    const config = await loadViteConfig();
    expect(config.build?.sourcemap).toBe(false);
  });

  it("sourcemap is true when SENTRY_AUTH_TOKEN is a non-empty string", async () => {
    // Release CI injects the real token; sourcemaps must be emitted for upload.
    vi.stubEnv("SENTRY_AUTH_TOKEN", "sntrys_abc123");
    const config = await loadViteConfig();
    expect(config.build?.sourcemap).toBe(true);
  });

  it("sourcemap is true for any non-empty token value", async () => {
    // The check is `!!value` — only the truthiness matters, not the format.
    vi.stubEnv("SENTRY_AUTH_TOKEN", "1");
    const config = await loadViteConfig();
    expect(config.build?.sourcemap).toBe(true);
  });

  it("other build settings are unaffected by SENTRY_AUTH_TOKEN presence", async () => {
    // Regression: setting the token must not disturb target or minify.
    vi.stubEnv("SENTRY_AUTH_TOKEN", "sntrys_abc123");
    const config = await loadViteConfig();
    expect(config.build?.target).toBe("es2021");
    expect(config.build?.minify).toBe("esbuild");
  });

  it("build target and minify are stable when token is absent", async () => {
    vi.stubEnv("SENTRY_AUTH_TOKEN", "");
    const config = await loadViteConfig();
    expect(config.build?.target).toBe("es2021");
    expect(config.build?.minify).toBe("esbuild");
  });
});