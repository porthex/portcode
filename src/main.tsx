import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initTelemetry } from "./lib/telemetry";
import { useStore } from "./store/store";
import "./index.css";

// Start crash reporting from the persisted consent BEFORE first render, so an
// error during initial mount is captured. No-op unless the user previously opted
// in and a DSN was baked into this build (App re-syncs on later toggles).
initTelemetry(useStore.getState().crashReporting);

async function bootstrap(): Promise<void> {
  if (__PORTCODE_QA_CONTROLS__) {
    await import("./qa/install").then(({ installQaControls }) => installQaControls());
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();
