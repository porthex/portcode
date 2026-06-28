import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CrashConsentPrompt } from "./CrashConsentPrompt";
import { useStore } from "../store/store";

// The first-run prompt persists the consent choice through the store. It must
// default-decline: choosing "No thanks" records false (not null), and "Enable"
// records true — nothing is implied.
beforeEach(() => {
  useStore.setState({ crashReporting: null });
  localStorage.clear();
});

describe("CrashConsentPrompt", () => {
  it("renders as a labelled modal dialog", () => {
    render(<CrashConsentPrompt />);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("HELP FIX CRASHES?")).toBeInTheDocument();
  });

  it("Enable crash reports sets consent true", () => {
    render(<CrashConsentPrompt />);
    fireEvent.click(screen.getByText("Enable crash reports"));
    expect(useStore.getState().crashReporting).toBe(true);
    expect(localStorage.getItem("pc.crashReporting")).toBe("1");
  });

  it("No thanks sets consent false (declined, not unset)", () => {
    render(<CrashConsentPrompt />);
    fireEvent.click(screen.getByText("No thanks"));
    expect(useStore.getState().crashReporting).toBe(false);
    expect(localStorage.getItem("pc.crashReporting")).toBe("0");
  });
});
