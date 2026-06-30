import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { PromoteBadge } from "./PromoteBadge";
import { useStore } from "../store/store";
import type { PromotePhase } from "../types";

// PromoteBadge is a thin, store-driven control gated on the self-dev build. It
// renders by `promotePhase` and its buttons fan out to store actions. We stub the
// channel env to enter self-dev, spy on the store actions, and assert wiring + copy
// per state. No ipc mock is needed — we never let the real actions run.

const initial = useStore.getState();

/** Put a promotion phase (+ optional message/progress) on the store, then render. */
function renderBadge(phase: PromotePhase, message: string | null = null, progress = 0) {
  useStore.setState({ promotePhase: phase, promoteMessage: message, promoteProgress: progress });
  return render(<PromoteBadge />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initial, true);
  // Default into the self-dev build for the per-state tests.
  vi.stubEnv("VITE_PORTCODE_CHANNEL", "dev");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PromoteBadge — visibility gating", () => {
  it("renders nothing in the normal (stable) build", () => {
    vi.stubEnv("VITE_PORTCODE_CHANNEL", "stable");
    const { container } = renderBadge("idle");
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("promote-badge")).not.toBeInTheDocument();
  });

  it("renders nothing when the channel flag is absent", () => {
    vi.unstubAllEnvs(); // no VITE_PORTCODE_CHANNEL → not self-dev
    const { container } = renderBadge("idle");
    expect(container).toBeEmptyDOMElement();
  });

  it("renders in the self-dev build", () => {
    renderBadge("idle");
    expect(screen.getByTestId("promote-badge")).toBeInTheDocument();
  });
});

describe("PromoteBadge — idle", () => {
  it("shows a Promote button that triggers beginPromotion", () => {
    const beginPromotion = vi.fn();
    useStore.setState({ beginPromotion });
    renderBadge("idle");

    const btn = screen.getByRole("button", { name: "Promote" });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveClass("pc-pill", "pc-pill--accent");

    fireEvent.click(btn);
    expect(beginPromotion).toHaveBeenCalledTimes(1);
  });
});

describe("PromoteBadge — running phases", () => {
  it.each([
    ["snapshotting", "Snapshotting…"],
    ["testing_frontend", "Testing FE…"],
    ["testing_rust", "Testing RS…"],
  ] as const)("shows %s as a shimmering running pill with the right label", (phase, label) => {
    renderBadge(phase);
    const pill = screen.getByTestId("promote-running");
    expect(pill).toHaveTextContent(label);
    // The shimmer (reused from the UpdateBanner download style) marks it as live.
    expect(pill.querySelector(".pc-shimmer")).not.toBeNull();
  });

  it("offers a Cancel that triggers cancelPromotion while running", () => {
    const cancelPromotion = vi.fn();
    useStore.setState({ cancelPromotion });
    renderBadge("testing_frontend");

    fireEvent.click(screen.getByRole("button", { name: "Cancel promotion" }));
    expect(cancelPromotion).toHaveBeenCalledTimes(1);
  });
});

describe("PromoteBadge — done", () => {
  it("shows the success pill and announces it to AT", () => {
    renderBadge("done", "Gate passed — tests green.");
    expect(screen.getByText("Gate passed ✓")).toBeInTheDocument();
    expect(screen.getByText("Gate passed ✓")).toHaveClass("pc-pill--success");

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Promotion gate passed.");
  });

  it("re-runs the gate when the success pill is clicked", () => {
    const beginPromotion = vi.fn();
    useStore.setState({ beginPromotion });
    renderBadge("done");

    fireEvent.click(screen.getByRole("button", { name: /Gate passed/ }));
    expect(beginPromotion).toHaveBeenCalledTimes(1);
  });
});

describe("PromoteBadge — failed", () => {
  it("shows the failure message as a warn pill and announces it", () => {
    renderBadge("failed", "Frontend tests: exit code 1");
    const pill = screen.getByText("Frontend tests: exit code 1");
    expect(pill).toHaveClass("pc-pill--warn");

    expect(screen.getByRole("status")).toHaveTextContent(
      "Promotion failed. Frontend tests: exit code 1",
    );
  });

  it("falls back to a generic label when no message is present", () => {
    renderBadge("failed", null);
    expect(screen.getByText("Promotion failed")).toBeInTheDocument();
  });

  it("retries the gate when the failed pill is clicked", () => {
    const beginPromotion = vi.fn();
    useStore.setState({ beginPromotion });
    renderBadge("failed", "boom");

    fireEvent.click(screen.getByRole("button", { name: /boom/ }));
    expect(beginPromotion).toHaveBeenCalledTimes(1);
  });
});
