import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ErrorBoundary } from "./ErrorBoundary";

// ErrorBoundary is a dependency-free class boundary: a render throw below it
// swaps in a recoverable fallback (the default Neon-Noir panel or a caller's
// custom render) instead of unmounting the whole tree. These tests drive every
// branch — happy path, default fallback + Reload, custom fallback + reset — by
// rendering a child that throws on demand.

// A child that throws on render when `boom` is set. React renders the throwing
// tree (logging the error) before getDerivedStateFromError swaps in the fallback.
function Boom({ boom = true, message = "kaboom" }: { boom?: boolean; message?: string }) {
  if (boom) throw new Error(message);
  return <div>child ok</div>;
}

// React + the boundary both log the caught render error to the console; silence
// it so the expected throw doesn't spam the test output.
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe("ErrorBoundary", () => {
  it("renders its children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Boom boom={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("child ok")).toBeInTheDocument();
    // No fallback chrome leaks into the happy path.
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("shows the default fallback panel (heading + error message + Reload) when a child throws", () => {
    render(
      <ErrorBoundary>
        <Boom message="render exploded" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("render exploded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    // componentDidCatch logged the throw.
    expect(errSpy).toHaveBeenCalled();
  });

  it("falls back to a generic message when the thrown error has no message", () => {
    render(
      <ErrorBoundary>
        <Boom message="" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("An unexpected error crashed the view.")).toBeInTheDocument();
  });

  it("reloads the window when Reload is clicked", () => {
    // location.reload isn't writable in jsdom — redefine it with a spy.
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("renders a custom fallback (with the error) instead of the default panel", () => {
    render(
      <ErrorBoundary fallback={(error) => <div>custom: {error.message}</div>}>
        <Boom message="boom-custom" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("custom: boom-custom")).toBeInTheDocument();
    // The default panel must NOT also render.
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("clears the error and re-renders children when the custom fallback's reset runs", () => {
    // After reset the boundary drops back to rendering children. We swap the
    // child to a non-throwing one between the click and the assertion via rerender
    // so the recovered tree is stable (a still-throwing child would re-trip it).
    const { rerender } = render(
      <ErrorBoundary
        onReset={() => {}}
        fallback={(_error, reset) => (
          <button type="button" onClick={reset}>
            retry
          </button>
        )}
      >
        <Boom />
      </ErrorBoundary>,
    );

    rerender(
      <ErrorBoundary
        onReset={() => {}}
        fallback={(_error, reset) => (
          <button type="button" onClick={reset}>
            retry
          </button>
        )}
      >
        <Boom boom={false} />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(screen.getByText("child ok")).toBeInTheDocument();
  });

  it("invokes onReset when reset runs", () => {
    const onReset = vi.fn();
    const { rerender } = render(
      <ErrorBoundary
        onReset={onReset}
        fallback={(_error, reset) => (
          <button type="button" onClick={reset}>
            retry
          </button>
        )}
      >
        <Boom />
      </ErrorBoundary>,
    );
    rerender(
      <ErrorBoundary
        onReset={onReset}
        fallback={(_error, reset) => (
          <button type="button" onClick={reset}>
            retry
          </button>
        )}
      >
        <Boom boom={false} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
