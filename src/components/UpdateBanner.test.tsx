import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { UpdateBanner } from "./UpdateBanner";
import { useStore, type UpdateState } from "../store/store";
import { type UpdateInfo } from "../types";

// UpdateBanner is a thin, store-driven banner: it renders by `update.phase` and
// its buttons fan out to store actions. We don't need a real updater, so we spy on
// the relevant store actions (replacing them via setState) and assert wiring +
// copy. No ipc mock is required because we never let the real actions run.

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  version: "5.1.0",
  currentVersion: "5.0.0",
  notes: "Fixes.",
  date: "2026-06-28",
  ...over,
});

const initial = useStore.getState();

/** Put a specific update phase on the real store, then render the banner. */
function renderBanner(update: UpdateState) {
  useStore.setState({ update });
  return render(<UpdateBanner />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initial, true);
});

describe("UpdateBanner — visibility", () => {
  it("renders nothing while idle", () => {
    const { container } = renderBanner({
      phase: "idle",
      info: null,
      progress: null,
      error: null,
    });
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
  });
});

describe("UpdateBanner — available", () => {
  it("shows the version and triggers startUpdateDownload on Install", () => {
    const startUpdateDownload = vi.fn();
    useStore.setState({ startUpdateDownload });
    renderBanner({ phase: "available", info: info(), progress: null, error: null });

    expect(screen.getByText(/Update available · v5\.1\.0/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(startUpdateDownload).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'latest' when no info version is present", () => {
    renderBanner({ phase: "available", info: null, progress: null, error: null });
    expect(screen.getByText(/Update available · vlatest/)).toBeInTheDocument();
  });
});

describe("UpdateBanner — downloading", () => {
  it("renders a determinate progress bar with the percent", () => {
    renderBanner({ phase: "downloading", info: info(), progress: 42, error: null });

    expect(screen.getByText(/Downloading update… 42%/)).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Update download progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    const fill = screen.getByTestId("update-progress-fill");
    expect(fill).toHaveStyle({ width: "42%" });
    // The indeterminate shimmer is not shown when a percent is known.
    expect(screen.queryByTestId("update-progress-shimmer")).not.toBeInTheDocument();
  });

  it("renders an indeterminate shimmer (no aria-valuenow) when progress is null", () => {
    renderBanner({ phase: "downloading", info: info(), progress: null, error: null });

    // "Downloading update…" with no trailing percent.
    expect(screen.getByText(/Downloading update…/)).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Update download progress" });
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByTestId("update-progress-shimmer")).toBeInTheDocument();
    expect(screen.queryByTestId("update-progress-fill")).not.toBeInTheDocument();
  });
});

describe("UpdateBanner — ready", () => {
  it("announces the ready state in a polite live region", () => {
    renderBanner({ phase: "ready", info: info(), progress: 100, error: null });

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent(/Update ready\. Relaunch to install version 5\.1\.0\./);
    // Visible chrome also shows the version.
    expect(screen.getByText(/Update ready · v5\.1\.0/)).toBeInTheDocument();
  });

  it("relaunches on 'Relaunch now'", () => {
    const relaunchForUpdate = vi.fn();
    useStore.setState({ relaunchForUpdate });
    renderBanner({ phase: "ready", info: info(), progress: 100, error: null });

    fireEvent.click(screen.getByRole("button", { name: "Relaunch now" }));
    expect(relaunchForUpdate).toHaveBeenCalledTimes(1);
  });

  it("dismisses the banner on 'Later'", () => {
    const dismissUpdateBanner = vi.fn();
    useStore.setState({ dismissUpdateBanner });
    renderBanner({ phase: "ready", info: info(), progress: 100, error: null });

    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(dismissUpdateBanner).toHaveBeenCalledTimes(1);
  });
});

describe("UpdateBanner — error", () => {
  it("shows the failure copy and announces it", () => {
    renderBanner({ phase: "error", info: null, progress: null, error: "boom" });

    expect(screen.getByText("Update failed")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Update failed.");
  });

  it("retries via checkForUpdate", () => {
    const checkForUpdate = vi.fn();
    useStore.setState({ checkForUpdate });
    renderBanner({ phase: "error", info: null, progress: null, error: "boom" });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("is dismissible via the ✕ button", () => {
    const dismissUpdateBanner = vi.fn();
    useStore.setState({ dismissUpdateBanner });
    renderBanner({ phase: "error", info: null, progress: null, error: "boom" });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(dismissUpdateBanner).toHaveBeenCalledTimes(1);
  });
});
