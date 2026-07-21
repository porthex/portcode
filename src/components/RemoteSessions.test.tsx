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
  model: "claude-opus-4-8",
  createdAt: 1,
  updatedAt: Date.now(),
  ...over,
});

const run = (over: Partial<(typeof initial.runs)[string]> = {}): (typeof initial.runs)[string] => ({
  streaming: false,
  cancel: null,
  pendingPermission: null,
  turnId: null,
  startedAt: null,
  finalizing: false,
  receipt: null,
  outcome: null,
  composerPhase: "idle",
  activeTool: null,
  unseenOutcome: null,
  ...over,
});

const openRemoteSession = vi.fn();
const newSession = vi.fn();
const disconnectRemote = vi.fn();
const clearRemoteError = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initial, true);
  useStore.setState({ openRemoteSession, newSession, disconnectRemote, clearRemoteError });
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

  it("labels pinned sessions by stable account ordinal without exposing profile ids", () => {
    const firstProfile = "00000000-0000-4000-8000-000000000001";
    const secondProfile = "00000000-0000-4000-8000-000000000002";
    useStore.setState({
      sessions: [
        session({ id: "a", title: "Alpha", accountProfileId: secondProfile }),
        session({ id: "b", title: "Beta", accountProfileId: firstProfile }),
      ],
      activeId: "a",
    });

    const { container } = render(<RemoteSessions />);

    expect(screen.getByRole("button", { name: /Alpha.*ChatGPT account 2/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Beta.*ChatGPT account 1/ })).toBeInTheDocument();
    expect(container).not.toHaveTextContent(firstProfile);
    expect(container).not.toHaveTextContent(secondProfile);
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

  it("shows activity for a running session even when it is not selected", () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "Alpha" }), session({ id: "b", title: "Beta" })],
      activeId: "b",
      runs: { a: run({ streaming: true }) },
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

  it("surfaces a remote command rejection and retries without ending the connection", () => {
    const accountProfileId = "00000000-0000-4000-8000-000000000001";
    useStore.setState({
      sessions: [session({ model: "gpt-live", accountProfileId })],
      activeId: "s1",
      remoteConnected: true,
      remoteError: "Configure a default ChatGPT account on the desktop, then try again.",
    });
    render(<RemoteSessions />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Configure a default ChatGPT account on the desktop, then try again.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("ChatGPT account 1");
    expect(screen.getByRole("alert")).not.toHaveTextContent(accountProfileId);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(clearRemoteError).toHaveBeenCalledOnce();
    expect(newSession).toHaveBeenCalledOnce();
    expect(disconnectRemote).not.toHaveBeenCalled();
  });

  it("dismisses a remote command rejection without retrying", () => {
    useStore.setState({ sessions: [session()], remoteError: "Desktop rejected the request." });
    render(<RemoteSessions />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(clearRemoteError).toHaveBeenCalledOnce();
    expect(newSession).not.toHaveBeenCalled();
  });

  it("disables rejection retry while another create is pending", () => {
    useStore.setState({
      sessions: [session()],
      remoteError: "Desktop rejected the request.",
      creatingSession: true,
    });
    render(<RemoteSessions />);

    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  });

  it("disables the new-session footer while a create is in flight (creatingSession)", () => {
    useStore.setState({ sessions: [session()], activeId: "s1", creatingSession: true });
    render(<RemoteSessions />);

    const button = screen.getByRole("button", { name: /New session on desktop/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Creating a session…");
  });

  it("keeps the new-session footer available while another session streams", () => {
    useStore.setState({ sessions: [session()], activeId: "s1", streaming: true });
    render(<RemoteSessions />);

    const button = screen.getByRole("button", { name: /New session on desktop/ });
    expect(button).toBeEnabled();
  });

  it("opens a different session while the active session keeps streaming", () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "Alpha" }), session({ id: "b", title: "Beta" })],
      activeId: "a",
      streaming: true,
    });
    render(<RemoteSessions />);

    fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
    expect(openRemoteSession).toHaveBeenCalledWith("b");
  });

  it("still opens the active session when tapped mid-stream", () => {
    useStore.setState({
      sessions: [session({ id: "a", title: "Alpha" }), session({ id: "b", title: "Beta" })],
      activeId: "a",
      streaming: true,
    });
    render(<RemoteSessions />);

    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    expect(openRemoteSession).toHaveBeenCalledWith("a");
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

  it("disables the empty-state CTA while a create is in flight (creatingSession)", () => {
    useStore.setState({ sessions: [], activeId: null, creatingSession: true });
    render(<RemoteSessions />);
    const button = screen.getByRole("button", { name: /New session/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Creating a session…");
  });

  it("keeps the empty-state CTA available while a session streams", () => {
    useStore.setState({ sessions: [], activeId: null, streaming: true });
    render(<RemoteSessions />);
    const button = screen.getByRole("button", { name: /New session/ });
    expect(button).toBeEnabled();
  });
});
