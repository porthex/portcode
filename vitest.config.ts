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
        statements: 98,
        functions: 99,
        lines: 99,
      },
    },
  },
});
