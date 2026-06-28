// Entry point for the Vercel-hosted static PWA (the iOS web client).
//
// This is the web sibling of `src/main.tsx` (the Tauri bootstrap). The only
// behavioral difference is `setWebClientMode(true)`: it flips the IPC bridge so
// the Phone Sync CLIENT calls route through the WASM-backed `webSession`
// transport (iroh-in-browser) instead of the inert browser mock. Everything
// else — the React tree, store, and UI — is reused unchanged.
//
// Kept deliberately tiny (like main.tsx) and outside `src/` so it is not part of
// the Tauri type-check/coverage surface; it is exercised end-to-end by the
// `vite.web.config.ts` build, not by unit tests.
import React from "react";
import ReactDOM from "react-dom/client";

import App from "../src/App";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { setWebClientMode } from "../src/lib/ipc";
import { useStore } from "../src/store/store";
import { registerServiceWorker, startWebClientLifecycle } from "../src/lib/webClientLifecycle";
import { createWasmConnector, setWebSessionConnector } from "../src/lib/webSession";
import "../src/index.css";

// Install the real WASM-backed connector. It lazily `import()`s the `portcode-wasm`
// iroh-in-browser package on first connect and SELF-FALLS-BACK to the deterministic
// mock when that package is absent (it is built by CI per §6 and may not be present
// yet). This is the sole reference to the real transport; `webSession` stays free of
// wasm-bindgen glue.
setWebSessionConnector(createWasmConnector());

// Route Phone Sync client calls through the connector installed above. The real
// WASM connector dials iroh-in-browser; until the wasm exists it transparently
// uses the inert browser mock.
setWebClientMode(true);

// Force the mobile/remote shell even in a desktop preview browser. The PWA is the
// phone client, but `isMobilePlatform()` is false in a desktop Vercel preview, so
// without this the app would boot into the desktop layout instead of the remote
// pairing flow.
useStore.getState().setRemoteMode(true);

// Session persistence (§5.8): reconnect-on-resume + durable pinned-peer storage.
// Wires pwaLifecycle + webStorage to the store. Started once; lives for the whole
// document, so we never tear it down (the document dies on a real iOS suspend).
startWebClientLifecycle();

// Register the offline-shell service worker + push scaffolding (§5.7), guarded so
// it's a no-op where unsupported. Fire-and-forget — the app runs without it online.
void registerServiceWorker();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
