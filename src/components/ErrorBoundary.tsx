import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "../lib/telemetry";

// A render error anywhere below this boundary would otherwise blank the whole
// webview (the "white screen" failure mode that read as a crash). This catches it,
// shows a recoverable fallback, and — ONLY when crash reporting is active —
// forwards the error to Sentry (scrubbed by `beforeSend`). The fallback itself is
// shown regardless of consent: it's a UX safety net, not telemetry.

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // `reportError` is a no-op unless reporting is active; never throws.
    reportError(error);
    // Surface in the dev console too (no PII concern locally).
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg px-6 text-center text-fg"
      >
        <div className="pc-neon-frame w-full max-w-[420px]">
          <div className="rounded-[13px] bg-panel p-6">
            <div className="pc-eyebrow pc-eyebrow--accent">SOMETHING WENT WRONG</div>
            <p className="mb-4 mt-1 text-[13px] leading-[1.55] text-muted">
              Portcode hit an unexpected error and couldn’t render this screen. Reloading usually
              fixes it.
            </p>
            <button onClick={this.reset} className="pc-btn-accent w-full px-3 py-2.5 text-[13px]">
              Reload view
            </button>
          </div>
        </div>
      </div>
    );
  }
}
