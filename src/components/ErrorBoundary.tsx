import React from "react";

interface Props {
  children: React.ReactNode;
  // An optional replacement for the default Neon-Noir panel (e.g. a compact
  // per-message card). Receives the caught error and a reset callback.
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  // Notified after a recoverable reset so a parent can re-key/refetch if needed.
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

// The single React error boundary in the tree. A render throw anywhere below a
// boundary (a malformed markdown/highlight edge case, a circular tool input that
// breaks JSON.stringify, an unexpected block shape from the core) would otherwise
// unmount the whole tree and leave a blank window with no way out but restarting.
// Catch it here and render a recoverable fallback instead. Dependency-free
// (class component) so it never touches the lockfile.
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    // React catches whatever was thrown (a string/number/plain object from a
    // third-party lib, not just an Error). Normalize so the Error contract the
    // State/fallback types promise is actually honored at runtime.
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // No telemetry yet — log so the throw is at least visible in dev/devtools.
    console.error("ErrorBoundary caught a render error:", error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-bg p-6 text-fg">
          <h1 className="font-display text-lg font-semibold tracking-wide text-accent">
            Something went wrong
          </h1>
          <p className="max-w-md text-center font-mono text-[12px] text-muted">
            {error.message || "An unexpected error crashed the view."}
          </p>
          <button
            type="button"
            onClick={() => location.reload()}
            className="rounded-md border border-border-2 bg-panel-2/80 px-3 py-1.5 font-mono text-[12px] text-muted transition-colors hover:border-accent/50 hover:text-accent motion-reduce:transition-none"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
