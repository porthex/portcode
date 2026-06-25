import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { RemoteSessions } from "./RemoteSessions";
import { useStore } from "../store/store";
import type { Session } from "../types";

// RemoteSessions is the remote sessions list shown after the SAS is confirmed. It
// reads sessions/activeId/streaming from the real store and drives navigation
// through openRemoteSession / newSession / disconnectRemote. We override those
// store actions with spies so we assert the component's wiring + DOM, not the
// store internals (those are covered in store.test).
const initial = useStore.getState();

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  title: "Rate-limit the client",
  workspace: "C:/dev/portcode",
  createdAt: 1,
  updatedAt: Date.now(),
  ...over,
});

const openRemoteSession = vi.fn();
const newSession = vi.fn();
const disconnectRemote = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initial, true);
  useStore.setState({ openRemoteSession, newSession, disconnectRemote });
});

describe("RemoteSessions — list", () => {
  it("renders a connected banner with an END control", () => {
    useStore.setState({ sessions: [session()], activeId: "s1" });
    render(<RemoteSessions />);

    expect(screen.getByText(/Connected to/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End connection" })).toBeInTheDocument();
  });

  it("lists each session with its title and workspace", () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "Alpha" }), session({ id: "b", title: "Beta" })],
      activeId: "a",
    });
    render(<RemoteSessions />);

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    // The workspace basename is shown on each card (⎇ portcode).
    expect(screen.getAllByText(/portcode/).length).toBeGreaterThan(0);
  });

  it("marks the active session with aria-current", () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "Alpha" }), session({ id: "b", title: "Beta" })],
      activeId: "b",
    });
    render(<RemoteSessions />);

    const beta = screen.getByRole("button", { name: /Beta/ });
    expect(beta).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /Alpha/ })).not.toHaveAttribute("aria-current");
  });

  it("shows RUNNING only for the active session while streaming", () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "Alpha" }), session({ id: "b", title: "Beta" })],
      activeId: "a",
      streaming: true,
    });
    render(<RemoteSessions />);

    // The active+streaming card shows RUNNING; the idle one shows a relative time.
    expect(screen.getByText("RUNNING")).toBeInTheDocument();
    expect(screen.getByText(/^idle ·/)).toBeInTheDocument();
  });

  it("opens a session when its card is tapped", () => {
    useStore.setState({ sessions: [session({ id: "a", title: "Alpha" })], activeId: "a" });
    render(<RemoteSessions />);

    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    expect(openRemoteSession).toHaveBeenCalledWith("a");
  });

  it("ends the connection from the banner", () => {
    useStore.setState({ sessions: [session()], activeId: "s1" });
    render(<RemoteSessions />);

    fireEvent.click(screen.getByRole("button", { name: "End connection" }));
    expect(disconnectRemote).toHaveBeenCalledTimes(1);
  });

  it("starts a new desktop session from the footer", () => {
    useStore.setState({ sessions: [session()], activeId: "s1" });
    render(<RemoteSessions />);

    fireEvent.click(screen.getByRole("button", { name: /New session on desktop/ }));
    expect(newSession).toHaveBeenCalledTimes(1);
  });

  it("disables the new-session footer while a turn is streaming", () => {
    useStore.setState({ sessions: [session()], activeId: "s1", streaming: true });
    render(<RemoteSessions />);

    expect(screen.getByRole("button", { name: /New session on desktop/ })).toBeDisabled();
  });
});

describe("RemoteSessions — empty", () => {
  it("shows the empty state with a New session CTA when the desktop has no sessions", () => {
    useStore.setState({ sessions: [], activeId: null });
    render(<RemoteSessions />);

    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New session/ }));
    expect(newSession).toHaveBeenCalledTimes(1);
  });

  it("still renders the connected banner over the empty state", () => {
    useStore.setState({ sessions: [], activeId: null });
    render(<RemoteSessions />);
    expect(screen.getByRole("button", { name: "End connection" })).toBeInTheDocument();
  });
});
