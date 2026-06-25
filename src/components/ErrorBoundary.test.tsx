import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ErrorBoundary } from "./ErrorBoundary";
import * as telemetry from "../lib/telemetry";

// ErrorBoundary is a dependency-free class boundary: a render throw below it
// swaps in a recoverable fallback (the default Neon-Noir panel or a caller's
// custom render) instead of unmounting the whole tree, and forwards the error to
// crash reporting (a no-op unless reporting is active). These tests drive every
// branch — happy path, default fallback + Reload, custom fallback + reset, and
// the telemetry hand-off — by rendering a child that throws on demand.

// `reportError` is mocked so we can assert the boundary forwards the caught error
// without standing up Sentry.
vi.mock("../lib/telemetry", () => ({ reportError: vi.fn() }));

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
    // And nothing is forwarded to telemetry when nothing threw.
    expect(vi.mocked(telemetry.reportError)).not.toHaveBeenCalled();
  });

  it("shows the default fallback panel (heading + error message + Reload) when a child throws", () => {
    render(
      <ErrorBoundary>
        <Boom message="render exploded" />
      </ErrorBoundary>,
    );
    // The fallback is an assertive live region so AT announces the crash.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    const message = screen.getByText("render exploded");
    expect(message).toBeInTheDocument();
    // A long unbroken error token (path/URL/serialized object) must wrap inside
    // max-w-md instead of overflowing the crash card horizontally.
    expect(message).toHaveClass("break-words", "[overflow-wrap:anywhere]");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    // componentDidCatch logged the throw.
    expect(errSpy).toHaveBeenCalled();
  });

  it("forwards the caught error to crash reporting (reportError)", () => {
    render(
      <ErrorBoundary>
        <Boom message="report me" />
      </ErrorBoundary>,
    );
    // The boundary always calls reportError; reportError itself is the gate that
    // no-ops unless reporting is active, so the call is unconditional here.
    expect(vi.mocked(telemetry.reportError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(telemetry.reportError).mock.calls[0][0]).toBeInstanceOf(Error);
    expect((vi.mocked(telemetry.reportError).mock.calls[0][0] as Error).message).toBe("report me");
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
    // location.reload isn't writable in jsdom — redefine it with a spy. Capture
    // the original descriptor and restore it afterward so this swap is scoped to
    // the test and can't hand a stale plain object to a later location read.
    const original = Object.getOwnPropertyDescriptor(window, "location");
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });

    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Object.defineProperty(window, "location", original);
    }
  });

  it("normalizes a non-Error throw to a message in the default panel", () => {
    // React catches whatever was thrown; getDerivedStateFromError normalizes a
    // non-Error value to a real Error so the panel still renders a sane message.
    function ThrowString(): ReactElement {
      throw "plain string";
    }
    render(
      <ErrorBoundary>
        <ThrowString />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("plain string")).toBeInTheDocument();
    // The panel normalizes a non-Error throw to an Error for display, but
    // componentDidCatch forwards the *raw* thrown value to reportError (which
    // does its own scrubbing/normalization on the telemetry side).
    expect(vi.mocked(telemetry.reportError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(telemetry.reportError).mock.calls[0][0]).toBe("plain string");
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
    // Reporting still fires even with a custom fallback in play.
    expect(vi.mocked(telemetry.reportError)).toHaveBeenCalledTimes(1);
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

  it("re-shows the fallback when the child still throws after reset", () => {
    // Drive the re-catch path: reset clears the error and re-renders children,
    // but a still-throwing child immediately re-trips getDerivedStateFromError so
    // the fallback returns rather than leaving a blank tree. (The per-message-card
    // use case where the underlying bad block hasn't changed.)
    render(
      <ErrorBoundary
        fallback={(_error, reset) => (
          <button type="button" onClick={reset}>
            retry
          </button>
        )}
      >
        <Boom message="still broken" />
      </ErrorBoundary>,
    );

    // First trip: the fallback (retry button) is shown.
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
    // Click reset WITHOUT swapping the child — children still throw on re-render.
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    // Boundary re-catches and re-renders the fallback instead of a blank tree.
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
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

  it("recovers after a non-throwing rerender when the default panel's Reload-free reset path is exercised", () => {
    // Telemetry-side coverage: a child that crashes once then renders cleanly.
    // The default panel's button reloads, but a custom fallback lets us drive the
    // in-place reset + recovery the telemetry suite asserted, while still proving
    // the report fired on the original catch.
    function Flaky({ crash }: { crash: boolean }) {
      if (crash) throw new Error("once");
      return <div>recovered</div>;
    }
    const { rerender } = render(
      <ErrorBoundary
        fallback={(_error, reset) => (
          <button type="button" onClick={reset}>
            reset
          </button>
        )}
      >
        <Flaky crash />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: "reset" })).toBeInTheDocument();
    expect(vi.mocked(telemetry.reportError)).toHaveBeenCalledTimes(1);
    rerender(
      <ErrorBoundary
        fallback={(_error, reset) => (
          <button type="button" onClick={reset}>
            reset
          </button>
        )}
      >
        <Flaky crash={false} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "reset" }));
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });
});
