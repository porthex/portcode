import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { ChannelBadge } from "./ChannelBadge";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ChannelBadge", () => {
  it("shows a DEV pill in the self-dev build", () => {
    vi.stubEnv("VITE_PORTCODE_CHANNEL", "dev");
    render(<ChannelBadge />);
    const pill = screen.getByText("DEV");
    expect(pill).toBeInTheDocument();
    // Assert the variant class too: it's what makes the pill magenta. A swap to
    // pc-pill--warn would silently ship a yellow pill while a base-class-only
    // check stayed green.
    expect(pill).toHaveClass("pc-pill", "pc-pill--accent");
  });

  it("renders nothing in the normal build", () => {
    vi.stubEnv("VITE_PORTCODE_CHANNEL", "stable");
    const { container } = render(<ChannelBadge />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("DEV")).not.toBeInTheDocument();
  });

  it("renders nothing when the channel flag is absent (real production build)", () => {
    // No stub: the env key is undefined, matching a normal stable build where
    // .env.selfdev was never loaded — the other half of the "not dev" contract.
    const { container } = render(<ChannelBadge />);
    expect(container).toBeEmptyDOMElement();
  });
});
