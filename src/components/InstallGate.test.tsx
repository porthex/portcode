import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { InstallGate } from "./InstallGate";

// InstallGate renders the iOS "Add to Home Screen" onboarding. It reads the
// authored guidance from installGate.getInstallState(); we stub that module so the
// component test is independent of the (separately tested) global sniff.
vi.mock("../lib/installGate", () => ({
  getInstallState: vi.fn(() => ({
    installed: false,
    ios: true,
    canPair: false,
    reason: "needs-install",
    guidance: "STUBBED-GUIDANCE-TEXT",
  })),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("InstallGate", () => {
  it("renders the install-required heading and eyebrow", () => {
    render(<InstallGate />);
    expect(screen.getByText("Add Portcode to your Home Screen")).toBeInTheDocument();
    expect(screen.getByText("⬆ INSTALL REQUIRED")).toBeInTheDocument();
  });

  it("walks the Share → Add to Home Screen → open steps", () => {
    render(<InstallGate />);
    // The three numbered steps.
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Share")).toBeInTheDocument();
    expect(screen.getByText("Add to Home Screen")).toBeInTheDocument();
  });

  it("surfaces the authored guidance string for assistive tech", () => {
    render(<InstallGate />);
    expect(screen.getByText("STUBBED-GUIDANCE-TEXT")).toBeInTheDocument();
  });
});
