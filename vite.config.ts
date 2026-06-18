import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri expects a fixed port and ignores hmr over the network.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // Don't watch the Rust side from Vite; Tauri handles it.
      ignored: ["**/src-tauri/**"],
    },
  },
  // Produce a build the Tauri bundler can package.
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
