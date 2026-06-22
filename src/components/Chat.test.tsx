import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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
    // An API key is set so the unauthenticated sign-in nudge is suppressed and the
    // keyboard-hint assertions below aren't ambiguous.
    useStore.setState({
      activeId: null,
      messages: {},
      streaming: false,
      settings: { ...initial.settings, apiKeySet: true },
    });

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

  it("hides the desktop keyboard hints on the phone (remote mode)", () => {
    useStore.setState({ activeId: null, messages: {}, streaming: false, remoteMode: true });

    render(<Chat />);

    // The welcome copy stays, but the Ctrl+K / Ctrl+B hints (no keyboard and no
    // file explorer on a phone) are gone.
    expect(screen.getByText(EMPTY_HINT)).toBeInTheDocument();
    expect(screen.queryByText("for commands")).not.toBeInTheDocument();
    expect(screen.queryByText("for files")).not.toBeInTheDocument();
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

describe("Chat auto-scroll (only follows when pinned to bottom)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches a passive scroll listener that recomputes pinned-to-bottom without throwing", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "hi")] },
      streaming: false,
    });
    const { container } = render(<Chat />);
    const scroller = container.querySelector(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    // Firing the listener (the user scrolling) just recomputes the flag — no throw.
    expect(() => fireEvent.scroll(scroller as HTMLElement)).not.toThrow();
  });

  it("follows the streaming transcript to the bottom via a ResizeObserver while pinned", () => {
    const captured: { cb?: () => void } = {};
    const observe = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          captured.cb = cb;
        }
        observe = observe;
        disconnect = vi.fn();
      },
    );
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "streaming")] },
      streaming: true,
    });
    render(<Chat />);
    // The streaming effect observes the content for height growth.
    expect(observe).toHaveBeenCalledTimes(1);
    // Firing the observer (a content resize, pinned to bottom) must not throw.
    expect(captured.cb).toBeDefined();
    captured.cb?.();
  });
});

describe("Chat live region (screen-reader announcements)", () => {
  it("marks the transcript wrapper as a polite live region and reflects streaming via aria-busy", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "hi")] },
      streaming: true,
    });

    const { container } = render(<Chat />);
    const log = container.querySelector('[role="log"]');
    expect(log).not.toBeNull();
    expect(log).toHaveAttribute("aria-live", "polite");
    // aria-busy mirrors `streaming` so AT knows the turn is still updating.
    expect(log).toHaveAttribute("aria-busy", "true");
  });

  it("clears aria-busy when no turn is streaming", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "hi")] },
      streaming: false,
    });

    const { container } = render(<Chat />);
    expect(container.querySelector('[role="log"]')).toHaveAttribute("aria-busy", "false");
  });
});

describe("Chat init-error panel", () => {
  it("renders the init-failure alert (not the welcome copy) when initError is set", () => {
    useStore.setState({
      activeId: null,
      messages: {},
      streaming: false,
      initError: "core unreachable",
    });

    render(<Chat />);

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(screen.getByText("core unreachable")).toBeInTheDocument();
    // The welcome empty state must not also render.
    expect(screen.queryByText(EMPTY_HINT)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("calls retryInit when the init-error Retry button is clicked", () => {
    const retryInit = vi.fn(async () => {});
    useStore.setState({
      activeId: null,
      messages: {},
      streaming: false,
      initError: "boom",
      retryInit,
    });

    render(<Chat />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryInit).toHaveBeenCalledTimes(1);
  });
});

describe("Chat load-error retry block", () => {
  it("renders the load-failure retry alert for a load-failed session", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: {}, // no entry -> EMPTY fallback, so messages.length === 0
      loadErrors: { s1: true },
      streaming: false,
    });

    render(<Chat />);

    expect(screen.getByText("Couldn't load this conversation.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // The welcome empty state must not win for a load-failed session.
    expect(screen.queryByText(EMPTY_HINT)).not.toBeInTheDocument();
  });

  it("calls retryLoad(activeId) when the load-error Retry button is clicked", () => {
    const retryLoad = vi.fn(async () => {});
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: {},
      loadErrors: { s1: true },
      streaming: false,
      retryLoad,
    });

    render(<Chat />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryLoad).toHaveBeenCalledWith("s1");
  });

  it("still shows the welcome empty state for a genuinely empty (non-failed) session", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [] },
      loadErrors: {},
      streaming: false,
      settings: { ...initial.settings, apiKeySet: true },
    });

    render(<Chat />);
    expect(screen.getByText(EMPTY_HINT)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load this conversation.")).not.toBeInTheDocument();
  });
});

describe("Chat scroll-to-latest affordance", () => {
  // Pretend the scroller is taller than the viewport and scrolled up, so the
  // scroll listener computes "not pinned".
  const stubScrolledUp = (el: HTMLElement) => {
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    el.scrollTop = 0;
  };

  it("hides the button while pinned to the bottom", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "hi")] },
      streaming: false,
    });

    render(<Chat />);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).not.toBeInTheDocument();
  });

  it("shows the button after the user scrolls up, then hides it and pins on click", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "hi")] },
      streaming: false,
    });

    const { container } = render(<Chat />);
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    stubScrolledUp(scroller);
    fireEvent.scroll(scroller);

    const btn = screen.getByRole("button", { name: "Scroll to latest" });
    expect(btn).toBeInTheDocument();

    fireEvent.click(btn);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).not.toBeInTheDocument();

    // After re-pinning, a real scroll with bottom geometry must keep it hidden via
    // the `scrollHeight - scrollTop - clientHeight < 80` recompute, not just the
    // direct setPinned in the click handler.
    scroller.scrollTop = scroller.scrollHeight - 300; // 1000 - clientHeight(300) => delta 0 < 80
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).not.toBeInTheDocument();
  });

  it("never shows the button when there are no messages", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [] },
      streaming: false,
      settings: { ...initial.settings, apiKeySet: true },
    });

    const { container } = render(<Chat />);
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    stubScrolledUp(scroller);
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).not.toBeInTheDocument();
  });
});

describe("Chat EmptyState auth affordance", () => {
  it("nudges to sign in when unauthenticated on desktop", () => {
    useStore.setState({
      activeId: null,
      messages: {},
      streaming: false,
      remoteMode: false,
      oauthStatus: null,
      settings: { ...initial.settings, apiKeySet: false },
    });

    render(<Chat />);
    expect(screen.getByText("Sign in with Claude or add an API key to start")).toBeInTheDocument();
  });

  it("opens settings when the sign-in nudge button is clicked", () => {
    const setShowSettings = vi.fn();
    useStore.setState({
      activeId: null,
      messages: {},
      streaming: false,
      remoteMode: false,
      oauthStatus: null,
      settings: { ...initial.settings, apiKeySet: false },
      setShowSettings,
    });

    render(<Chat />);
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(setShowSettings).toHaveBeenCalledWith(true);
  });

  it("hides the nudge when signed in via OAuth", () => {
    useStore.setState({
      activeId: null,
      messages: {},
      streaming: false,
      remoteMode: false,
      oauthStatus: { signedIn: true, expiresAt: null, account: null, tier: null },
      settings: { ...initial.settings, apiKeySet: false },
    });

    render(<Chat />);
    expect(
      screen.queryByText("Sign in with Claude or add an API key to start"),
    ).not.toBeInTheDocument();
  });

  it("hides the nudge when an API key is set", () => {
    useStore.setState({
      activeId: null,
      messages: {},
      streaming: false,
      remoteMode: false,
      oauthStatus: null,
      settings: { ...initial.settings, apiKeySet: true },
    });

    render(<Chat />);
    expect(
      screen.queryByText("Sign in with Claude or add an API key to start"),
    ).not.toBeInTheDocument();
  });

  it("suppresses the nudge in remote mode even when unauthenticated", () => {
    useStore.setState({
      activeId: null,
      messages: {},
      streaming: false,
      remoteMode: true,
      oauthStatus: null,
      settings: { ...initial.settings, apiKeySet: false },
    });

    render(<Chat />);
    expect(
      screen.queryByText("Sign in with Claude or add an API key to start"),
    ).not.toBeInTheDocument();
  });
});
