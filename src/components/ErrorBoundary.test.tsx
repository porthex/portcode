import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";
import * as telemetry from "../lib/telemetry";

// The boundary must (1) catch a child render throw and show a recoverable
// fallback instead of a blank screen, and (2) forward the error to reportError
// (which is itself a no-op unless reporting is active).
vi.mock("../lib/telemetry", () => ({ reportError: vi.fn() }));

const Boom = (): never => {
  throw new Error("kaboom");
};

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  // React logs caught render errors to console.error; silence it for clean output.
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <div>healthy</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy")).toBeInTheDocument();
  });

  it("shows the fallback and reports when a child throws", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("SOMETHING WENT WRONG")).toBeInTheDocument();
    expect(vi.mocked(telemetry.reportError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(telemetry.reportError).mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("recovers after Reload view clears the error", () => {
    function Flaky({ crash }: { crash: boolean }) {
      if (crash) throw new Error("once");
      return <div>recovered</div>;
    }
    const { rerender } = render(
      <ErrorBoundary>
        <Flaky crash />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Provide a non-throwing tree, then click reset.
    rerender(
      <ErrorBoundary>
        <Flaky crash={false} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByText("Reload view"));
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });
});
