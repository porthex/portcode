import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// Build config for the Vercel-hosted static PWA (the iOS web client).
//
// Distinct from vite.config.ts (the Tauri build → dist/, packaged into the native
// app). This one:
//   - roots at web/ (its own index.html with PWA manifest + Apple meta tags),
//   - reuses the app source under ../src via the web/entry.tsx bootstrap,
//   - emits a plain static bundle to web-dist/ for Vercel to serve as a CDN.
//
// No relay or backend is built or hosted here — only static files. The live
// browser↔desktop connection (iroh-in-browser over a relay WebSocket) is made
// client-side at runtime; Vercel never sees it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: resolve(__dirname, "web"),
  // Static assets (manifest, icons) live at the repo-level public/ dir.
  publicDir: resolve(__dirname, "public"),
  // The entry bootstrap imports from ../src, which is outside the web/ root; allow
  // the dev server to read it (build/rollup already follows imports anywhere).
  server: {
    fs: { allow: [resolve(__dirname)] },
  },
  build: {
    outDir: resolve(__dirname, "web-dist"),
    emptyOutDir: true,
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
