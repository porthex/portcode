import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { type PendingPermission } from "../types";
import { useStore } from "../store/store";
import { PermissionPrompt } from "./PermissionPrompt";

// PermissionPrompt is a thin, store-driven banner: it reads `pendingPermission`
// and dispatches `resolvePermission`. We drive it with the REAL store and mock
// only the IPC functions that the resolvePermission action can reach, so a click
// exercises the real action wiring without touching a backend.
vi.mock("../lib/ipc", () => ({
  resolvePermission: vi.fn(),
  saveSettings: vi.fn(),
}));

import * as ipc from "../lib/ipc";

const m = vi.mocked(ipc);
const initialState = useStore.getState();

// The buttons fire-and-forget the async action (`void resolve(...)`). The
// allow-always path awaits saveSettings *then* resolvePermission, so we drain
// the whole microtask queue (a single Promise.resolve only clears one await).
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const pending = (over: Partial<PendingPermission> = {}): PendingPermission => ({
  id: "p1",
  tool: "fs_edit",
  summary: "src/app.ts",
  input: {},
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Zustand has no built-in reset; restore the captured pristine state.
  useStore.setState(initialState, true);
  m.resolvePermission.mockResolvedValue(undefined);
  m.saveSettings.mockResolvedValue({ ...initialState.settings, defaultPolicy: "allow" });
});

describe("PermissionPrompt", () => {
  it("renders nothing when no permission is pending", () => {
    useStore.setState({ pendingPermission: null });

    const { container } = render(<PermissionPrompt />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the requested tool and summary when a permission is pending", () => {
    useStore.setState({ pendingPermission: pending({ tool: "fs_read", summary: "README.md" }) });

    render(<PermissionPrompt />);

    expect(screen.getByText("fs_read")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    // All three actions are offered. The ⏎ hint lives on Deny (the focused,
    // safe default) so the affordance matches what Enter actually does.
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Always allow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "⏎ Deny" })).toBeInTheDocument();
  });

  it("announces the banner via role='alert' including the tool and summary", () => {
    useStore.setState({
      pendingPermission: pending({ tool: "fs_write", summary: "src/secret.ts" }),
    });

    render(<PermissionPrompt />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("fs_write");
    expect(alert).toHaveTextContent("src/secret.ts");
  });

  it("puts the ⏎ keyboard hint on the focused Deny action, not Allow", () => {
    useStore.setState({ pendingPermission: pending() });

    render(<PermissionPrompt />);

    const deny = screen.getByRole("button", { name: "⏎ Deny" });
    expect(deny).toHaveFocus();
    expect(deny).toHaveAttribute("aria-keyshortcuts", "Enter");
    // The Allow label must not claim the Enter affordance.
    expect(screen.getByRole("button", { name: "Allow" })).not.toHaveFocus();
  });

  it("wraps a pathological summary without dropping the action row", () => {
    const summary = "/very/long/" + "deep/".repeat(40) + "path/to/file.ts";
    useStore.setState({ pendingPermission: pending({ summary }) });

    render(<PermissionPrompt />);

    // The full path is preserved in a title for hover/inspection even though
    // it is visually clamped to two lines.
    const span = screen.getByText(summary);
    expect(span).toHaveAttribute("title", summary);

    // All three actions still render, in order, anchored below the summary.
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Allow", "Always allow", "⏎ Deny"]);
  });

  it("auto-focuses the safe Deny action so a reflexive Enter denies", () => {
    useStore.setState({ pendingPermission: pending() });

    render(<PermissionPrompt />);

    expect(screen.getByRole("button", { name: "⏎ Deny" })).toHaveFocus();
  });

  it("Allow forwards an allow decision to the IPC layer and clears the prompt", async () => {
    useStore.setState({ pendingPermission: pending() });

    render(<PermissionPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await flush();

    expect(m.resolvePermission).toHaveBeenCalledWith("p1", "allow");
    expect(m.saveSettings).not.toHaveBeenCalled();
    expect(useStore.getState().pendingPermission).toBeNull();
  });

  it("Always allow persists the allow-always policy as well", async () => {
    useStore.setState({ pendingPermission: pending() });

    render(<PermissionPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));

    await flush();

    expect(m.saveSettings).toHaveBeenCalledWith({ defaultPolicy: "allow" });
    expect(m.resolvePermission).toHaveBeenCalledWith("p1", "allow");
    expect(useStore.getState().pendingPermission).toBeNull();
  });

  it("Deny forwards a deny decision and clears the prompt", async () => {
    useStore.setState({ pendingPermission: pending({ id: "p9" }) });

    render(<PermissionPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "⏎ Deny" }));

    await flush();

    expect(m.resolvePermission).toHaveBeenCalledWith("p9", "deny");
    expect(m.saveSettings).not.toHaveBeenCalled();
    expect(useStore.getState().pendingPermission).toBeNull();
  });
});
