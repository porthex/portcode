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
  },
});
