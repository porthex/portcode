import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { RemoteChatHeader } from "./RemoteChatHeader";
import { useStore } from "../store/store";
import type { Session } from "../types";

// The remote chat header: back-to-sessions, the session title + device line, and a
// switch control that raises the (real) session switcher. We override
// closeRemoteSession with a spy and assert wiring + the switcher open/close cycle.
const initial = useStore.getState();

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  title: "Rate-limit the client",
  workspace: "C:/dev/portcode",
  model: "claude-opus-4-8",
  createdAt: 1,
  updatedAt: Date.now(),
  ...over,
});

const closeRemoteSession = vi.fn();
const selectSession = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initial, true);
  useStore.setState({ closeRemoteSession, selectSession, sessions: [session()], activeId: "s1" });
});

describe("RemoteChatHeader", () => {
  it("shows the active session title and the device/workspace line", () => {
    render(<RemoteChatHeader />);

    expect(screen.getByText("Rate-limit the client")).toBeInTheDocument();
    expect(screen.getByText(/your desktop/)).toBeInTheDocument();
    expect(screen.getByText(/portcode/)).toBeInTheDocument();
  });

  it("attributes a pinned chat with a stable display-only account ordinal", () => {
    const firstProfile = "00000000-0000-4000-8000-000000000001";
    const secondProfile = "00000000-0000-4000-8000-000000000002";
    useStore.setState({
      sessions: [
        session({ id: "a", model: "gpt-live", accountProfileId: secondProfile }),
        session({ id: "b", model: "gpt-live", accountProfileId: firstProfile }),
      ],
      activeId: "a",
    });

    const { container } = render(<RemoteChatHeader />);

    expect(screen.getByText(/ChatGPT account 2/)).toBeInTheDocument();
    expect(container).not.toHaveTextContent(firstProfile);
    expect(container).not.toHaveTextContent(secondProfile);
  });

  it("falls back to 'New chat' with no active session", () => {
    useStore.setState({ sessions: [], activeId: null });
    render(<RemoteChatHeader />);
    expect(screen.getByText("New chat")).toBeInTheDocument();
  });

  it("goes back to the sessions list", () => {
    render(<RemoteChatHeader />);
    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    expect(closeRemoteSession).toHaveBeenCalledTimes(1);
  });

  it("opens the switcher from the title and closes it on Escape", () => {
    render(<RemoteChatHeader />);
    // The title button and the icon button both open the switcher; both are labelled.
    const switchButtons = screen.getAllByRole("button", { name: "Switch session" });
    expect(switchButtons.length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog", { name: "Switch session" })).not.toBeInTheDocument();

    fireEvent.click(switchButtons[0]);
    expect(screen.getByRole("dialog", { name: "Switch session" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Switch session" })).not.toBeInTheDocument();
  });

  it("opens the switcher from the swap icon button", () => {
    render(<RemoteChatHeader />);
    const switchButtons = screen.getAllByRole("button", { name: "Switch session" });
    // The last labelled control is the icon button.
    fireEvent.click(switchButtons[switchButtons.length - 1]);
    expect(screen.getByRole("dialog", { name: "Switch session" })).toBeInTheDocument();
  });
});
