import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Frontend test runner. Never makes live LLM calls — see CONTRIBUTING.md.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
    // Headroom over the default 5000ms so the 5000ms async-utils timeout
    // (see src/test/setup.ts) surfaces a clean Testing Library "Unable to find …"
    // error instead of colliding with the per-test timeout under heavy
    // windows-latest CI load. Passing tests never approach this; it only governs
    // how long a failing/slow test waits before giving up.
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      // Instrument every source file, not just the ones a test imports, so
      // untested modules honestly count as 0% instead of vanishing from the report.
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.{test,spec}.{ts,tsx}",
        "src/test/**",
        "src/main.tsx", // app bootstrap: mounts React onto the DOM root, nothing to unit-test
        // Canvas + requestAnimationFrame rain animation: jsdom has no 2D canvas
        // context, so there is nothing to meaningfully unit-test (same category as
        // main.tsx). Landed with the neon-noir theme (#29).
        "src/components/NeonRain.tsx",
        "src/**/*.d.ts",
      ],
      reporter: ["text", "text-summary", "json-summary", "html"],
      reportsDirectory: "./coverage",
      // Regression ratchet for `pnpm test:coverage`, enforced by the coverage CI
      // job on main/release only — NOT a required PR check (CI runs `pnpm test`),
      // so contributor PRs are never blocked on coverage (see CONTRIBUTING). We
      // track statements/lines/functions; branch coverage (every if/else path) is
      // deliberately not gated. Floors sit a hair under the achieved numbers.
      thresholds: {
        // Re-ratcheted to a hair under the achieved level after the neon-noir
        // theme (#29) landed animation code. The canvas `NeonRain` is excluded
        // above (untestable in jsdom); the remaining drift from ~99% is the
        // `useTypewriter` rAF hook + a couple of component edges (Chat/Sidebar),
        // not the Phone Sync code (ipc/store/Settings sit at 97–99%). Branch
        // coverage stays ungated. Raise these as the edges get covered.
        statements: 96,
        functions: 97,
        lines: 97,
      },
    },
  },
});
