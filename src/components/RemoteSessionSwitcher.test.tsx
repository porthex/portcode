import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { RemoteSessionSwitcher } from "./RemoteSessionSwitcher";
import { useStore } from "../store/store";
import type { Session } from "../types";

// The bottom-sheet session switcher: a modal dialog with a focus trap, Escape /
// scrim close, focus restore, and tap-to-switch. We override selectSession with a
// spy and assert the component's behaviour + a11y; onClose is a prop spy.
const initial = useStore.getState();

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  title: "Alpha",
  workspace: "C:/dev/portcode",
  createdAt: 1,
  updatedAt: Date.now(),
  ...over,
});

const selectSession = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initial, true);
  useStore.setState({
    selectSession,
    sessions: [session({ id: "a", title: "Alpha" }), session({ id: "b", title: "Beta" })],
    activeId: "a",
  });
});

describe("RemoteSessionSwitcher", () => {
  it("renders the sessions and tags the active one", () => {
    render(<RemoteSessionSwitcher onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: "Switch session" })).toBeInTheDocument();
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Alpha/ })).toHaveAttribute("aria-current", "true");
  });

  it("switches session and closes when a row is picked", () => {
    render(<RemoteSessionSwitcher onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
    expect(selectSession).toHaveBeenCalledWith("b");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("blocks a mid-stream switch: keeps the sheet open and attempts no switch", () => {
    // selectSession no-ops while a turn streams (switching would strand it), so
    // tapping a different session can't take effect — the sheet must stay open
    // rather than close as if it had switched.
    useStore.setState({ streaming: true, activeId: "a" });
    render(<RemoteSessionSwitcher onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
    expect(selectSession).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Re-selecting the already-active session is a no-op switch, so it still closes.
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    expect(selectSession).toHaveBeenCalledWith("a");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on the scrim and on Escape", () => {
    render(<RemoteSessionSwitcher onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Close session switcher" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("moves focus into the sheet on open and restores it to the opener on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(<RemoteSessionSwitcher onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Switch session" })).toHaveFocus();

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("traps Tab within the sheet", () => {
    render(<RemoteSessionSwitcher onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Switch session" });
    const rows = screen.getAllByRole("button", { name: /Alpha|Beta/ });
    const last = rows[rows.length - 1];

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    // Wraps from the last focusable back to the first row.
    expect(document.activeElement).toBe(rows[0]);

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("pins focus to the sheet when it has no rows to tab through", () => {
    useStore.setState({ sessions: [], activeId: null });
    render(<RemoteSessionSwitcher onClose={onClose} />);

    const dialog = screen.getByRole("dialog", { name: "Switch session" });
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    // With nothing focusable inside, the trap keeps focus on the container.
    expect(document.activeElement).toBe(dialog);
  });
});
