import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";

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

afterEach(() => {
  // Tear down any role="log" stand-in mounted by the focus-restore tests so it
  // doesn't leak into sibling tests (jsdom doesn't reset document.body).
  document.getElementById("log-stub")?.remove();
});

// Mount a focusable stand-in for the Chat scroll region (role="log", tabIndex=-1),
// the focus target the prompt reaches for when it clears mid-turn.
const mountLogRegion = () => {
  const log = document.createElement("div");
  log.id = "log-stub";
  log.setAttribute("role", "log");
  log.tabIndex = -1;
  document.body.appendChild(log);
  return log;
};

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
    // The Allow label must not claim the Enter affordance, and Deny advertises
    // it only via the ⏎ label — native focused-button Enter needs no ARIA.
    expect(screen.getByRole("button", { name: "Allow" })).not.toHaveFocus();
  });

  it("preserves the full path in a title attribute and keeps all three actions in order", () => {
    const summary = "/very/long/" + "deep/".repeat(40) + "path/to/file.ts";
    useStore.setState({ pendingPermission: pending({ summary }) });

    render(<PermissionPrompt />);

    // The full path is preserved in a title for hover/inspection. The visual
    // two-line clamp / overflow guard lives in CSS (line-clamp-2, break-words,
    // overflow-wrap:anywhere) and jsdom does no layout, so we only assert the
    // class-presence proxy here — the rendered height is checked in the preview
    // harness, not jsdom.
    const span = screen.getByText(summary);
    expect(span).toHaveAttribute("title", summary);
    expect(span).toHaveClass("line-clamp-2", "break-words");

    // All three actions still render, in DOM order, anchored below the summary.
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

  it("Always allow adds a scoped allow-rule for the tool (not a global policy flip)", async () => {
    useStore.setState({ pendingPermission: pending() });

    render(<PermissionPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));

    await flush();

    expect(m.saveSettings).toHaveBeenCalledWith({
      rules: [{ tool: "fs_edit", decision: "allow" }],
    });
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

  it("renders the pre-apply diff when one is attached to the request", () => {
    useStore.setState({
      pendingPermission: pending({ diff: "--- a\n+++ b\n-old line\n+new line\n" }),
    });

    render(<PermissionPrompt />);

    expect(screen.getByLabelText("Proposed change")).toBeInTheDocument();
    expect(screen.getByText("-old line")).toBeInTheDocument();
    expect(screen.getByText("+new line")).toBeInTheDocument();
  });

  it("shows no diff block when the request has no diff (e.g. a shell command)", () => {
    useStore.setState({ pendingPermission: pending() });

    render(<PermissionPrompt />);

    expect(screen.queryByLabelText("Proposed change")).not.toBeInTheDocument();
  });

  it("restores focus to the Chat log region when the prompt clears mid-turn", () => {
    const log = mountLogRegion();
    useStore.setState({ pendingPermission: pending(), remoteMode: false });

    render(<PermissionPrompt />);
    // The prompt grabbed focus onto Deny; simulate it unmounting (focus would
    // otherwise fall to <body>, where the keyboard user gets stranded).
    expect(screen.getByRole("button", { name: "⏎ Deny" })).toHaveFocus();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.body).toHaveFocus();

    // The gate is answered but the turn keeps streaming — only pendingPermission
    // clears. The effect should rescue focus to the log region, not leave <body>.
    act(() => {
      useStore.setState({ pendingPermission: null });
    });

    expect(document.activeElement).toBe(log);
    expect(document.body).not.toHaveFocus();
  });

  it("does not move focus on clear when in remote mode (keeps the mobile keyboard down)", () => {
    const log = mountLogRegion();
    useStore.setState({ pendingPermission: pending(), remoteMode: true });

    render(<PermissionPrompt />);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.body).toHaveFocus();

    act(() => {
      useStore.setState({ pendingPermission: null });
    });

    // Remote/phone: leave focus alone so the soft keyboard doesn't pop.
    expect(document.activeElement).not.toBe(log);
    expect(document.body).toHaveFocus();
  });

  it("leaves a deliberately-moved focus alone when the prompt clears", () => {
    const log = mountLogRegion();
    // Something else (e.g. the user clicking into the composer) holds focus on a
    // still-mounted element outside the prompt before the gate clears.
    const elsewhere = document.createElement("button");
    elsewhere.id = "focus-elsewhere";
    document.body.appendChild(elsewhere);
    useStore.setState({ pendingPermission: pending(), remoteMode: false });

    render(<PermissionPrompt />);
    elsewhere.focus();
    expect(elsewhere).toHaveFocus();

    act(() => {
      useStore.setState({ pendingPermission: null });
    });

    // The rescue only fires when focus fell to <body>; focus held elsewhere must
    // not be hijacked into the log region.
    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(log);
    elsewhere.remove();
  });

  it("wraps the action row so the buttons reflow instead of clipping at narrow widths", () => {
    useStore.setState({ pendingPermission: pending() });

    render(<PermissionPrompt />);

    // The three actions share a flex row; flex-wrap is the only fallback that
    // keeps "Deny" reachable below ~320px (the panel is overflow-hidden).
    const row = screen.getByRole("button", { name: "Allow" }).parentElement;
    expect(row).toHaveClass("flex", "flex-wrap");
  });
});
