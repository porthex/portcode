import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { Chat } from "./Chat";
import { useStore } from "../store/store";
import type { Message, ContentBlock, Session } from "../types";

// Chat is the transcript for the active session. It is display-only: it reads
// `activeId`, `messages[activeId]`, and `streaming` from the real store, renders
// either the EmptyState or a MessageView per message, and always mounts the
// PermissionPrompt + Composer children. We drive the genuine store (resetting it
// between tests) and let the children render un-mocked — none of them reach the
// IPC bridge on render, and we never trigger a handler that would.
const initial = useStore.getState();

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  title: "Chat",
  workspace: null,
  model: "claude-opus-4-8",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const userMessage = (id: string, text: string): Message => ({
  id,
  role: "user",
  blocks: [{ kind: "text", text } as ContentBlock],
  createdAt: 1,
});

// Marker text that only the EmptyState renders, so its presence/absence cleanly
// distinguishes the empty branch from a populated transcript. The hint is a
// substring of a longer paragraph, so it is matched with a regex.
const EMPTY_HEADING = "Portcode";
const EMPTY_HINT = /Describe a task to get started\./;

beforeEach(() => {
  // zustand has no built-in reset; restore the pristine state captured at import.
  useStore.setState(initial, true);
});

describe("Chat empty state", () => {
  it("shows the welcome empty state when there is no active session", () => {
    useStore.setState({ activeId: null, messages: {}, streaming: false });

    render(<Chat />);

    expect(screen.getByRole("heading", { name: EMPTY_HEADING })).toBeInTheDocument();
    expect(screen.getByText(EMPTY_HINT)).toBeInTheDocument();
    // The Kbd shortcut hints are part of the empty state.
    expect(screen.getByText("for commands")).toBeInTheDocument();
    expect(screen.getByText("for files")).toBeInTheDocument();
    expect(screen.getAllByText("Ctrl")).toHaveLength(2);
    expect(screen.getByText("K")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
  });

  it("falls back to the empty state when the active session has no message entry", () => {
    // activeId is set, but `messages[activeId]` is undefined -> the `|| EMPTY`
    // fallback in the selector kicks in.
    useStore.setState({ activeId: "s1", messages: {}, streaming: false });

    render(<Chat />);

    expect(screen.getByRole("heading", { name: EMPTY_HEADING })).toBeInTheDocument();
  });

  it("shows the empty state when the active session has an empty message array", () => {
    useStore.setState({ activeId: "s1", messages: { s1: [] }, streaming: false });

    render(<Chat />);

    expect(screen.getByRole("heading", { name: EMPTY_HEADING })).toBeInTheDocument();
  });
});

describe("Chat transcript", () => {
  it("renders one MessageView per message, in order, and hides the empty state", () => {
    const messages: Message[] = [
      userMessage("m1", "first question"),
      userMessage("m2", "second question"),
      userMessage("m3", "third question"),
    ];
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: messages },
      streaming: false,
    });

    render(<Chat />);

    // The empty-state copy must be gone once there is a transcript.
    expect(screen.queryByRole("heading", { name: EMPTY_HEADING })).not.toBeInTheDocument();
    expect(screen.queryByText(EMPTY_HINT)).not.toBeInTheDocument();

    // Each user message renders its text verbatim (no markdown transform).
    const first = screen.getByText("first question");
    const second = screen.getByText("second question");
    const third = screen.getByText("third question");
    expect(first).toBeInTheDocument();
    expect(second).toBeInTheDocument();
    expect(third).toBeInTheDocument();

    // DOM order matches the message order. compareDocumentPosition returns
    // DOCUMENT_POSITION_FOLLOWING (4) when the argument comes after the node.
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(second.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders the transcript while a turn is streaming (effect runs without error)", () => {
    // streaming is an effect dependency; flipping it must not break the render
    // and the transcript is still shown.
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "in-flight prompt")] },
      streaming: true,
    });

    render(<Chat />);

    expect(screen.getByText("in-flight prompt")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: EMPTY_HEADING })).not.toBeInTheDocument();
  });
});

describe("Chat children", () => {
  it("always mounts the Composer and leaves the PermissionPrompt hidden by default", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [] },
      pendingPermission: null,
      streaming: false,
    });

    render(<Chat />);

    // Composer renders its textarea regardless of transcript state.
    expect(
      screen.getByPlaceholderText("Describe a task, ask a question, or give an instruction…"),
    ).toBeInTheDocument();
    // PermissionPrompt returns null when nothing is pending.
    expect(screen.queryByText(/wants to run/i)).not.toBeInTheDocument();
  });
});
