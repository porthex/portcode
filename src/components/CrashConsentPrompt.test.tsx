import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

  it("discloses the desktop minidump caveat", () => {
    render(<CrashConsentPrompt />);
    expect(screen.getByText(/memory snapshot \(minidump\)/i)).toBeInTheDocument();
  });

  it("Enable crash reports sets consent true", async () => {
    render(<CrashConsentPrompt />);
    fireEvent.click(screen.getByText("Enable crash reports"));
    // setCrashReporting tells the Rust host FIRST and only flips state/pref once it
    // acknowledges (a microtask later), so await the resulting state change.
    await waitFor(() => expect(useStore.getState().crashReporting).toBe(true));
    expect(localStorage.getItem("pc.crashReporting")).toBe("1");
  });

  it("No thanks sets consent false (declined, not unset)", async () => {
    render(<CrashConsentPrompt />);
    fireEvent.click(screen.getByText("No thanks"));
    await waitFor(() => expect(useStore.getState().crashReporting).toBe(false));
    expect(localStorage.getItem("pc.crashReporting")).toBe("0");
  });
});
