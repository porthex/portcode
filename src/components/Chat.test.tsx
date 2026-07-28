import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";

import { Chat } from "./Chat";
import { useStore } from "../store/store";
import type {
  CodexActivityEvent,
  Message,
  ContentBlock,
  Session,
  SyncFrame,
  TurnReceipt as TurnReceiptData,
} from "../types";

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

const receipt = (over: Partial<TurnReceiptData> = {}): TurnReceiptData => ({
  turnId: "turn-1",
  status: "completed",
  startedAt: 1_000,
  completedAt: 4_000,
  durationMs: 3_000,
  changedFiles: [],
  changedFileCount: 0,
  additions: 0,
  deletions: 0,
  filesTruncated: false,
  changeCertainty: "exact",
  backgroundTasksRunning: false,
  ...over,
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
      settings: { ...initial.settings },
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

  it("shows a transcript loader instead of a false empty state before history arrives", () => {
    useStore.setState({ activeId: "s1", messages: {}, streaming: false });

    render(<Chat />);

    expect(screen.getByRole("status", { name: "Loading conversation" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: EMPTY_HEADING })).not.toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveAttribute("aria-busy", "true");
  });

  it("shows the empty state when the active session has an empty message array", () => {
    useStore.setState({ activeId: "s1", messages: { s1: [] }, streaming: false });

    render(<Chat />);

    expect(screen.getByRole("heading", { name: EMPTY_HEADING })).toBeInTheDocument();
  });
});

describe("Chat transcript", () => {
  it("omits per-turn structured activity while exposing unknown methods separately", () => {
    const activity: CodexActivityEvent[] = [
      {
        sequence: 1,
        sessionId: "s1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "commandExecution",
            command: "pnpm typecheck",
            status: "completed",
            aggregatedOutput: "clean",
          },
        },
        emittedAtMs: 10,
      },
      {
        sequence: 2,
        sessionId: "s1",
        threadId: "thread-1",
        turnId: "turn-2",
        method: "future/newMethod",
        params: { detail: "inspect me" },
        emittedAtMs: 20,
      },
    ];
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: {
        s1: [
          {
            id: "assistant-1",
            turnId: "turn-1",
            role: "assistant",
            blocks: [{ kind: "text", text: "First result" }],
            receipt: receipt({ turnId: "turn-1" }),
            createdAt: 1,
          },
          {
            id: "assistant-2",
            turnId: "turn-2",
            role: "assistant",
            blocks: [{ kind: "text", text: "Second result" }],
            receipt: receipt({ turnId: "turn-2" }),
            createdAt: 2,
          },
        ],
      },
      streaming: false,
      codexActivity: { s1: activity },
    });

    const { container } = render(<Chat />);

    expect(screen.queryByRole("button", { name: /work activity/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /pnpm typecheck/i })).toBeNull();
    expect(container.querySelector("#pc-msg-assistant-1 .pc-turn-receipt")).toHaveAttribute(
      "data-has-activity",
      "false",
    );
    expect(container.querySelector("#pc-msg-assistant-2 .pc-turn-receipt")).toHaveAttribute(
      "data-has-activity",
      "false",
    );
    expect(
      screen.getByRole("button", {
        name: "Unrecognized Codex activity (1), expand",
      }),
    ).toBeInTheDocument();
  });

  it("keeps unknown activity inspectable in an empty transcript", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [] },
      codexActivity: {
        s1: [
          {
            sequence: 1,
            sessionId: "s1",
            threadId: "thread-1",
            method: "future/emptyTranscript",
            params: { visible: true },
            emittedAtMs: 10,
          },
        ],
      },
    });

    render(<Chat />);

    expect(screen.getByRole("heading", { name: EMPTY_HEADING })).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Unrecognized Codex activity (1), expand",
      }),
    ).toBeInTheDocument();
  });

  it("switches unknown activity with the selected session without bleed", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session(), session({ id: "s2", title: "Other" })],
      messages: { s1: [], s2: [] },
      codexActivity: {
        s1: [
          {
            sequence: 1,
            sessionId: "s1",
            threadId: "thread-1",
            method: "future/sessionOne",
            params: {},
            emittedAtMs: 10,
          },
        ],
        s2: [
          {
            sequence: 2,
            sessionId: "s2",
            threadId: "thread-2",
            method: "future/sessionTwo",
            params: {},
            emittedAtMs: 20,
          },
        ],
      },
    });

    render(<Chat />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Unrecognized Codex activity (1), expand",
      }),
    );
    expect(screen.getByText("future/sessionOne")).toBeInTheDocument();

    act(() => useStore.setState({ activeId: "s2" }));

    expect(screen.getByText("future/sessionTwo")).toBeInTheDocument();
    expect(screen.queryByText("future/sessionOne")).not.toBeInTheDocument();
  });

  it("renders the bounded remote activity DTO while excluding every desktop-private field", () => {
    const sensitive = [
      "REMOTE_RAW_COMMAND_SENTINEL",
      "REMOTE_RAW_PATH_SENTINEL",
      "REMOTE_RAW_RESULT_SENTINEL",
      "REMOTE_CHILD_PAYLOAD_SENTINEL",
      "REMOTE_REQUEST_PAYLOAD_SENTINEL",
      "REMOTE_REASONING_SENTINEL",
    ];
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: {
        s1: [
          {
            id: "assistant-1",
            turnId: "turn-1",
            role: "assistant",
            blocks: [{ kind: "text", text: "Remote-safe transcript" }],
            receipt: receipt(),
            createdAt: 1,
          },
        ],
      },
      remoteMode: true,
      codexActivity: {},
    });
    const frames = [
      {
        type: "codex_activity",
        kind: "event",
        method: "turn/plan/updated",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 1,
        emittedAtMs: 10,
        redacted: false,
        truncated: false,
        payload: { type: "plan", steps: [{ status: "completed" }, { status: "inProgress" }] },
      },
      {
        type: "codex_activity",
        kind: "event",
        method: "turn/diff/updated",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 2,
        emittedAtMs: 20,
        redacted: false,
        truncated: false,
        payload: { type: "diff", additions: 4, deletions: 2, files: 1 },
      },
      {
        type: "codex_activity",
        kind: "event",
        method: "item/completed",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-safe",
        sequence: 3,
        emittedAtMs: 30,
        redacted: true,
        truncated: false,
        payload: {
          type: "tool",
          itemType: "commandExecution",
          status: "completed",
          terminal: true,
        },
      },
      {
        type: "codex_activity",
        kind: "event",
        method: "turn/completed",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 4,
        emittedAtMs: 40,
        redacted: false,
        truncated: false,
        payload: { type: "terminal", status: "completed" },
      },
      {
        type: "codex_activity",
        kind: "event",
        method: "future/safe-metadata",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 5,
        emittedAtMs: 50,
        redacted: true,
        truncated: true,
        redactionReasons: ["rawReasoning"],
      },
    ];
    for (const event of frames) {
      useStore
        .getState()
        .applyFrame({ t: "live", session_id: "s1", event } as unknown as SyncFrame);
    }
    const stalePrivateEvent: CodexActivityEvent = {
      sequence: 6,
      sessionId: "s1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "private-item",
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "private-item",
          type: "commandExecution",
          status: "completed",
          command: sensitive[0],
          cwd: sensitive[1],
          aggregatedOutput: sensitive[2],
          child: sensitive[3],
          request: sensitive[4],
          reasoning_text: sensitive[5],
        },
      },
      requestId: { payload: sensitive[4] },
      emittedAtMs: 60,
    };
    useStore.setState((state) => ({
      codexActivity: {
        ...state.codexActivity,
        s1: [...(state.codexActivity.s1 ?? []), stalePrivateEvent],
      },
    }));

    render(<Chat />);

    expect(screen.getByText("Remote-safe transcript")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /work activity/i })).toBeNull();
    expect(screen.queryByText("Step 1")).toBeNull();
    expect(screen.queryByRole("button", { name: /Live changes, updated/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Command, completed/i })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Unrecognized Codex activity (1), expand" }),
    );
    expect(screen.getByText("future/safe-metadata")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /safe metadata, expand/i })).toBeInTheDocument();
    for (const sentinel of sensitive) expect(document.body).not.toHaveTextContent(sentinel);
  });

  it("mounts a structured Codex request above the composer", () => {
    useStore.setState({
      activeId: "s1",
      messages: { s1: [] },
      streaming: true,
      pendingCodexRequest: {
        id: "request-1",
        method: "item/tool/requestUserInput",
        params: {
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which package should Codex change?",
            },
          ],
        },
      },
    });

    render(<Chat />);

    const prompt = screen.getByRole("dialog", { name: "Codex needs your input" });
    const composer = screen.getByTestId("chat-composer-area");
    expect(prompt).toBeInTheDocument();
    expect(
      prompt.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

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

  it("passes the streaming lifecycle through to live Markdown and activity wording", () => {
    const assistantMessage: Message = {
      id: "m2",
      role: "assistant",
      blocks: [
        { kind: "tool_use", id: "read-1", name: "fs_read", input: { path: "src/App.tsx" } },
        {
          kind: "tool_result",
          toolUseId: "read-1",
          output: "contents",
          isError: false,
        },
        { kind: "text", text: "## Project summary\n\n**Ready**" },
      ],
      createdAt: 2,
    };
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "inspect it"), assistantMessage] },
      streaming: true,
      settings: { ...initial.settings, typingAnimation: false },
    });

    render(<Chat />);

    expect(screen.getByText("Reading file")).toBeInTheDocument();
    expect(screen.queryByText("Read file")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Project summary" })).toBeInTheDocument();
    expect(screen.getByText("Ready").tagName).toBe("STRONG");

    act(() => useStore.setState({ streaming: false }));

    expect(screen.getByText("Read file")).toBeInTheDocument();
    expect(screen.queryByText("Reading file")).not.toBeInTheDocument();
  });

  it("binds the provider-neutral live run to its matching assistant turn", () => {
    const assistantMessage: Message = {
      id: "assistant-1",
      turnId: "turn-1",
      role: "assistant",
      blocks: [{ kind: "text", text: "I need approval to continue." }],
      createdAt: 2,
    };
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "make the change"), assistantMessage] },
      streaming: true,
      runs: {
        s1: {
          streaming: true,
          cancel: null,
          pendingPermission: {
            id: "permission-1",
            tool: "shell",
            summary: "Run the focused tests",
            input: {},
          },
          turnId: "turn-1",
          startedAt: Date.now() - 2_000,
          finalizing: false,
          receipt: null,
          outcome: null,
          composerPhase: "thinking",
          activeTool: null,
          unseenOutcome: null,
        },
      },
    });

    const { container } = render(<Chat />);

    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
    expect(container.querySelectorAll(".pc-turn-receipt")).toHaveLength(1);

    const provisional = receipt({
      startedAt: 1_000,
      completedAt: 3_500,
      durationMs: 2_500,
      agentDurationMs: 2_500,
      changeCertainty: "unavailable",
      changeState: "unknown",
    });
    act(() => {
      useStore.setState({
        streaming: false,
        messages: {
          s1: [userMessage("m1", "make the change"), { ...assistantMessage, receipt: provisional }],
        },
        runs: {
          s1: {
            streaming: false,
            cancel: null,
            pendingPermission: null,
            turnId: "turn-1",
            startedAt: 1_000,
            finalizing: true,
            agentDurationMs: 2_500,
            phaseRevision: 2,
            receipt: provisional,
            outcome: "completed",
            composerPhase: "idle",
            activeTool: null,
            unseenOutcome: null,
          },
        },
      });
    });

    expect(screen.getByText("Response complete · Checking file changes…")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for approval")).toBeNull();
    expect(screen.getByRole("log")).toHaveAttribute("aria-busy", "false");
    expect(container.querySelector(".pc-stop")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll('[role="status"][aria-live="polite"]')).toHaveLength(1);
  });

  it("correlates reloaded historical agents to each owning assistant receipt", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: {
        s1: [
          {
            id: "assistant-1",
            turnId: "turn-1",
            role: "assistant",
            blocks: [{ kind: "text", text: "First result" }],
            receipt: receipt({ turnId: "turn-1" }),
            createdAt: 1,
          },
          {
            id: "assistant-2",
            turnId: "turn-2",
            role: "assistant",
            blocks: [{ kind: "text", text: "Second result" }],
            receipt: receipt({ turnId: "turn-2", status: "error" }),
            createdAt: 2,
          },
        ],
      },
      streaming: false,
      agents: {
        s1: [
          {
            id: "agent-turn-1",
            description: "first turn agent",
            status: "ok",
            step: 1,
            launchTurnId: "turn-1",
          },
          {
            id: "agent-turn-2",
            description: "second turn agent",
            status: "error",
            step: 1,
            launchTurnId: "turn-2",
          },
        ],
      },
      runs: {},
    });

    const { container } = render(<Chat />);
    expect(screen.queryByRole("button", { name: /expand work activity/i })).toBeNull();

    const first = container.querySelector<HTMLElement>("#pc-msg-assistant-1")!;
    const second = container.querySelector<HTMLElement>("#pc-msg-assistant-2")!;
    expect(within(first).getByRole("region", { name: "Codex swarm workflow" })).toHaveTextContent(
      "All 1 agent completed",
    );
    expect(within(second).getByRole("region", { name: "Codex swarm workflow" })).toHaveTextContent(
      "1 of 1 agent failed",
    );
    expect(document.body).not.toHaveTextContent("first turn agent");
    expect(document.body).not.toHaveTextContent("second turn agent");
  });

  it("never projects exact child-thread activity into a parent receipt", () => {
    const childPlanSentinel = "CHILD PLAN MUST STAY OUT OF PARENT TRANSCRIPT";
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: {
        s1: [
          {
            id: "assistant-parent",
            turnId: "shared-turn-id",
            role: "assistant",
            blocks: [{ kind: "text", text: "Parent answer" }],
            receipt: receipt({ turnId: "shared-turn-id" }),
            createdAt: 1,
          },
        ],
      },
      agents: {
        s1: [
          {
            id: "child-thread",
            description: "child",
            status: "ok",
            step: 1,
            launchTurnId: "root-turn",
          },
        ],
      },
      codexActivity: {
        s1: [
          {
            sequence: 1,
            sessionId: "s1",
            threadId: "child-thread",
            turnId: "shared-turn-id",
            method: "item/completed",
            itemId: "child-plan",
            params: {
              threadId: "child-thread",
              turnId: "shared-turn-id",
              item: { id: "child-plan", type: "plan", text: childPlanSentinel },
              completedAtMs: 10,
            },
            emittedAtMs: 10,
          },
        ],
      },
    });

    render(<Chat />);

    expect(screen.queryByText(childPlanSentinel)).toBeNull();
    expect(screen.queryByRole("button", { name: /expand work activity/i })).toBeNull();
  });

  it("filters child ownership identically across the current page and a 2,001+ record archive", () => {
    const current = Array.from({ length: 2_000 }, (_, index): CodexActivityEvent => ({
      sequence: index + 3,
      sessionId: "s1",
      threadId: "root-thread",
      method: "thread/status/changed",
      params: { threadId: "root-thread", status: "idle" },
      emittedAtMs: index + 3,
    }));
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [] },
      agents: {
        s1: [
          {
            id: "child-thread",
            description: "correct child",
            status: "ok",
            step: 1,
          },
        ],
      },
      codexActivity: { s1: current },
      codexActivityPaging: {
        s1: {
          hasMore: false,
          nextCursor: null,
          loadingOlder: false,
          archiveLimited: false,
          olderEvents: [
            {
              sequence: 1,
              sessionId: "s1",
              threadId: "child-thread",
              turnId: "child-turn",
              method: "future/childOnly",
              params: { safe: "CHILD_ONLY_SENTINEL" },
              emittedAtMs: 1,
            },
            {
              sequence: 2,
              sessionId: "s1",
              threadId: "root-thread",
              method: "future/parentOnly",
              params: { safe: "PARENT_ONLY_SENTINEL" },
              emittedAtMs: 2,
            },
          ],
        },
      },
    });

    render(<Chat />);
    fireEvent.click(
      screen.getByRole("button", { name: "Unrecognized Codex activity (1), expand" }),
    );
    expect(screen.getByText("future/parentOnly")).toBeInTheDocument();
    expect(screen.queryByText("future/childOnly")).toBeNull();
    expect(document.body).not.toHaveTextContent("CHILD_ONLY_SENTINEL");
  });

  it("navigates every retained parent range in a bounded 10,000-row archive", () => {
    const all = Array.from({ length: 10_000 }, (_, index): CodexActivityEvent => {
      const sequence = index + 1;
      const child = sequence === 5_000;
      return {
        sequence,
        sessionId: "s1",
        threadId: child ? "child-thread" : "root-thread",
        method: child ? "future/childOnly" : "future/parentArchive",
        params: { safe: child ? "CHILD_ARCHIVE_SENTINEL" : "parent-safe" },
        emittedAtMs: sequence,
      };
    });
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [] },
      agents: {
        s1: [
          {
            id: "child-thread",
            description: "isolated child",
            status: "ok",
            step: 1,
          },
        ],
      },
      codexActivity: { s1: all.slice(8_000) },
      codexActivityPaging: {
        s1: {
          hasMore: false,
          nextCursor: null,
          loadingOlder: false,
          archiveLimited: false,
          olderEvents: all.slice(0, 8_000),
        },
      },
    });

    render(<Chat />);
    fireEvent.click(
      screen.getByRole("button", { name: "Unrecognized Codex activity (200), expand" }),
    );
    const details = screen.getByRole("region", {
      name: "Unrecognized Codex activity details",
    });
    expect(within(details).getByText("Sequence 10000")).toBeInTheDocument();
    expect(within(details).queryByText("Sequence 1")).toBeNull();
    expect(details).not.toHaveTextContent("future/childOnly");
    expect(details).not.toHaveTextContent("CHILD_ARCHIVE_SENTINEL");

    const oldest = screen.getByRole("button", { name: "Show oldest retained activity" });
    oldest.focus();
    fireEvent.click(oldest);
    expect(document.activeElement).toBe(oldest);
    expect(within(details).getByText("Sequence 1")).toBeInTheDocument();
    expect(within(details).queryByText("Sequence 10000")).toBeNull();
    expect(within(details).getAllByRole("listitem").length).toBeLessThanOrEqual(200);

    fireEvent.click(screen.getByRole("button", { name: "Show newest retained activity" }));
    expect(within(details).getByText("Sequence 10000")).toBeInTheDocument();
    expect(within(details).queryByText("Sequence 1")).toBeNull();
  });

  it("opens the persisted turn review from a completed receipt", () => {
    const turnReceipt = receipt({
      changedFiles: [
        {
          path: "src/review-me.ts",
          status: "modified",
          additions: 6,
          deletions: 2,
          binary: false,
          certainty: "exact",
        },
      ],
      changedFileCount: 1,
      additions: 6,
      deletions: 2,
    });
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: {
        s1: [
          {
            id: "assistant-1",
            turnId: "turn-1",
            role: "assistant",
            blocks: [{ kind: "text", text: "The implementation is complete." }],
            receipt: turnReceipt,
            createdAt: 2,
          },
        ],
      },
      streaming: false,
      workspaceSurface: "chat",
      reviewTarget: { kind: "workspace" },
    });

    render(<Chat />);
    fireEvent.click(screen.getByRole("button", { name: "Review 1 changed file" }));

    expect(useStore.getState().workspaceSurface).toBe("review");
    expect(useStore.getState().reviewTarget).toEqual({ kind: "turn", turnId: "turn-1" });
  });

  it("keeps receipt facts readable on the phone while deferring Review to desktop", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: {
        s1: [
          {
            id: "assistant-1",
            role: "assistant",
            blocks: [{ kind: "text", text: "Remote summary." }],
            receipt: receipt({
              changedFiles: [
                {
                  path: "src/phone-visible.ts",
                  status: "added",
                  additions: 2,
                  deletions: 0,
                  binary: false,
                  certainty: "observed",
                },
              ],
              changedFileCount: 1,
              additions: 2,
              changeCertainty: "observed",
            }),
            createdAt: 2,
          },
        ],
      },
      streaming: false,
      remoteMode: true,
    });

    render(<Chat />);

    expect(screen.getByText("src/phone-visible.ts")).toBeInTheDocument();
    expect(screen.getByText("Review on desktop")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review 1 changed file/i })).toBeNull();
  });

  it("keeps a 220-message / 880-tool transcript structurally compact", () => {
    const messages: Message[] = Array.from({ length: 220 }, (_, messageIndex) => {
      const blocks: ContentBlock[] = [];
      const specs = [
        { name: "fs_read", input: { path: `src/file-${messageIndex}-a.ts` } },
        { name: "fs_read", input: { path: `src/file-${messageIndex}-b.ts` } },
        { name: "grep", input: { pattern: `needle-${messageIndex}` } },
        { name: "list", input: { path: `src/feature-${messageIndex}` } },
      ];
      specs.forEach((spec, toolIndex) => {
        const id = `tool-${messageIndex}-${toolIndex}`;
        blocks.push({ kind: "tool_use", id, name: spec.name, input: spec.input });
        blocks.push({
          kind: "tool_result",
          toolUseId: id,
          output: `result-${messageIndex}-${toolIndex}`,
          isError: false,
        });
      });
      return {
        id: `bulk-${messageIndex}`,
        role: "assistant",
        blocks,
        createdAt: messageIndex,
      };
    });
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: messages },
      streaming: false,
    });

    const { container } = render(<Chat />);

    // All transcript anchors remain present for search jumps/pagination, while
    // each four-call exploration phase contributes only one compact DOM card.
    const rows = container.querySelectorAll('[id^="pc-msg-bulk-"]');
    expect(rows).toHaveLength(220);
    expect(container.querySelectorAll(".pc-toolcall")).toHaveLength(220);
    expect(screen.getAllByText("Explored project")).toHaveLength(220);
    expect(screen.getAllByText("2 files read · 1 search · 1 folder listed")).toHaveLength(220);

    // 880 raw cards and their result payloads must not exist until a specific
    // group is expanded. Settled rows opt into browser offscreen containment.
    expect(screen.queryByText("fs_read")).not.toBeInTheDocument();
    expect(screen.queryByText("result-219-3")).not.toBeInTheDocument();
    expect(
      Array.from(rows).every((row) => (row as HTMLElement).style.contentVisibility === "auto"),
    ).toBe(true);
    expect(container.querySelector("#pc-msg-bulk-219")).toBeInTheDocument();
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

    // Composer renders its rich textbox regardless of transcript state.
    expect(screen.getByRole("textbox", { name: "Message Portcode" })).toHaveAttribute(
      "aria-placeholder",
      "Describe a task, ask a question, or give an instruction…",
    );
    // PermissionPrompt returns null when nothing is pending.
    expect(screen.queryByText(/wants to run/i)).not.toBeInTheDocument();
  });

  it("does not render the legacy Subagents dropdown above the composer", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "delegate this work")] },
      agents: {
        s1: [
          {
            id: "agent-1",
            description: "Audit the workspace",
            status: "running",
            step: 2,
          },
        ],
      },
      streaming: true,
    });

    render(<Chat />);

    expect(screen.queryByRole("region", { name: "Subagents" })).not.toBeInTheDocument();
    expect(screen.queryByText("1 subagent running")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-composer-area")).toBeInTheDocument();
  });

  it("compacts only the transcript while the full-width composer stays fixed", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "keep the input wide")] },
      streaming: false,
    });

    const panel = <aside data-testid="test-environment-panel">Environment</aside>;
    const { rerender } = render(<Chat transcriptAside={panel} transcriptAsideOpen={false} />);
    const layout = screen.getByTestId("chat-transcript-layout");
    const scrollArea = screen.getByTestId("chat-transcript-scroll");
    const content = screen.getByTestId("chat-transcript-content");
    const aside = screen.getByTestId("chat-transcript-aside");
    const asideFrame = screen.getByTestId("chat-transcript-aside-frame");
    const composerArea = screen.getByTestId("chat-composer-area");

    expect(layout).toHaveClass("@container", "relative", "overflow-hidden");
    expect(scrollArea).toHaveClass("absolute", "inset-0", "overflow-y-auto");
    expect(content).not.toHaveClass("@min-[734px]:pr-[390px]");
    expect(aside).toHaveAttribute("inert");
    expect(aside).toHaveClass("absolute", "right-3", "max-w-[354px]");
    expect(asideFrame).toHaveClass("w-full", "py-3", "pl-3");
    expect(layout).not.toContainElement(composerArea);
    expect(composerArea).toHaveClass("w-full");
    expect(layout.parentElement).toBe(composerArea.parentElement);

    rerender(<Chat transcriptAside={panel} transcriptAsideOpen />);

    expect(content).toHaveClass("@min-[734px]:pr-[390px]");
    expect(scrollArea).toHaveClass("absolute", "inset-0");
    expect(aside).not.toHaveAttribute("inert");
    expect(composerArea).toHaveClass("w-full");
  });
});

describe("Chat session and new-turn positioning", () => {
  it("jumps to the latest message before paint when the active session changes", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session({ id: "s1" }), session({ id: "s2" })],
      messages: { s1: [userMessage("a1", "first session")] },
      streaming: false,
    });
    render(<Chat />);
    const scroller = screen.getByTestId("chat-transcript-scroll");
    Object.defineProperty(scroller, "scrollHeight", { value: 1200, configurable: true });
    scroller.scrollTop = 40;

    act(() =>
      useStore.setState({
        activeId: "s2",
        messages: {
          ...useStore.getState().messages,
          s2: [userMessage("b1", "older"), userMessage("b2", "latest")],
        },
      }),
    );

    expect(scroller.scrollTop).toBe(1200);
    expect(screen.getByText("latest")).toBeInTheDocument();
  });

  it("reselecting the active session requests Latest again", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "one"), userMessage("m2", "two")] },
      streaming: false,
    });
    render(<Chat />);
    const scroller = screen.getByTestId("chat-transcript-scroll");
    Object.defineProperty(scroller, "scrollHeight", { value: 800, configurable: true });
    scroller.scrollTop = 100;

    act(() =>
      useStore.setState({
        transcriptScrollRequest: { id: "latest-1", sessionId: "s1", kind: "latest" },
      }),
    );

    expect(scroller.scrollTop).toBe(800);
    expect(useStore.getState().transcriptScrollRequest).toBeNull();
  });

  it("moves a newly sent user turn to the top with a viewport-height runway", () => {
    const assistant: Message = {
      id: "assistant-new",
      role: "assistant",
      blocks: [],
      createdAt: 3,
      turnId: "turn-new",
    };
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("old", "old context")] },
      streaming: false,
    });
    render(<Chat />);
    const scroller = screen.getByTestId("chat-transcript-scroll");
    Object.defineProperty(scroller, "clientHeight", { value: 300, configurable: true });
    Object.defineProperty(scroller, "scrollHeight", { value: 900, configurable: true });

    const nextUser = { ...userMessage("new-user", "new prompt"), turnId: "turn-new" };
    act(() =>
      useStore.setState({
        messages: { s1: [userMessage("old", "old context"), nextUser, assistant] },
        streaming: true,
        transcriptScrollRequest: {
          id: "new-turn-1",
          sessionId: "s1",
          kind: "newTurn",
          targetMessageId: "new-user",
        },
      }),
    );

    const currentTurn = screen.getByTestId("chat-current-turn");
    expect(currentTurn).toHaveStyle({ minHeight: "252px" });
    expect(currentTurn).toContainElement(screen.getByText("new prompt"));
    expect(currentTurn).not.toContainElement(screen.getByText("old context"));
    expect(scroller.scrollTop).toBe(900);
    expect(useStore.getState().transcriptScrollRequest).toBeNull();
  });
});

describe("Chat scroll-to-search-result", () => {
  const origScroll = Element.prototype.scrollIntoView;
  afterEach(() => {
    Element.prototype.scrollIntoView = origScroll;
  });

  it("scrolls the targeted message into view and clears the request", () => {
    const spy = vi.fn();
    // jsdom doesn't implement scrollIntoView — install a spy so the effect's call is
    // observable (and harmless).
    Element.prototype.scrollIntoView = spy as unknown as () => void;
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "first"), userMessage("m2", "the target turn")] },
      streaming: false,
      scrollTargetId: "m2",
    });

    render(<Chat />);

    expect(spy).toHaveBeenCalled();
    // The request is consumed exactly once, so it can't re-fire on the next render.
    expect(useStore.getState().scrollTargetId).toBeNull();
  });

  it("leaves the target set when the message isn't in the DOM yet (retries later)", () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy as unknown as () => void;
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "only message")] },
      streaming: false,
      scrollTargetId: "not-rendered-yet",
    });

    render(<Chat />);

    // Nothing matched, so the effect waits (the next messages update re-runs it)
    // rather than clearing — otherwise a still-loading session would lose the scroll.
    expect(spy).not.toHaveBeenCalled();
    expect(useStore.getState().scrollTargetId).toBe("not-rendered-yet");
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

  it("makes the transcript programmatically focusable (tabIndex -1) so focus can be routed there", () => {
    // The scroll region is focusable out of the Tab order so the PermissionPrompt
    // can move focus back to it when a gated turn clears mid-stream and the Deny
    // button unmounts (otherwise focus would fall back to <body>).
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "hi")] },
      streaming: false,
    });

    const { container } = render(<Chat />);
    const log = container.querySelector('[role="log"]') as HTMLElement;
    expect(log).toHaveAttribute("tabindex", "-1");
    // It actually accepts focus.
    log.focus();
    expect(log).toHaveFocus();
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

  it("keeps cached messages visible when a background refresh fails", () => {
    const retryLoad = vi.fn(async () => {});
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "cached transcript")] },
      messageLoads: {
        s1: {
          phase: "error",
          loadedAt: 1,
          lastAccessedAt: 2,
          requestId: 2,
          error: "offline",
          nextCursor: null,
          loadingOlder: false,
        },
      },
      retryLoad,
    });

    render(<Chat />);
    expect(screen.getByText("cached transcript")).toBeInTheDocument();
    expect(screen.getByText(/Showing cached messages/)).toBeInTheDocument();
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
      settings: { ...initial.settings },
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
    // Carries the pcRise entrance class (gated for reduced motion in index.css)
    // so it eases in instead of snapping, since it mounts only when scrolled up.
    expect(btn).toHaveClass("pc-fab-enter");

    fireEvent.click(btn);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).not.toBeInTheDocument();

    // After re-pinning, a real scroll with bottom geometry must keep it hidden via
    // the `scrollHeight - scrollTop - clientHeight < 80` recompute, not just the
    // direct setPinned in the click handler.
    scroller.scrollTop = scroller.scrollHeight - 300; // 1000 - clientHeight(300) => delta 0 < 80
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).not.toBeInTheDocument();
  });

  it("only shifts the button for an open aside at the transcript container breakpoint", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "hi")] },
      streaming: false,
    });

    const { container } = render(
      <Chat transcriptAside={<aside>Environment</aside>} transcriptAsideOpen />,
    );
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    stubScrolledUp(scroller);
    fireEvent.scroll(scroller);

    const button = screen.getByRole("button", { name: "Scroll to latest" });
    expect(button).toHaveClass("right-4", "@min-[734px]:right-[382px]");
    expect(button).not.toHaveStyle({ right: "382px" });
  });

  it("never shows the button when there are no messages", () => {
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [] },
      streaming: false,
      settings: { ...initial.settings },
    });

    const { container } = render(<Chat />);
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    stubScrolledUp(scroller);
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).not.toBeInTheDocument();
  });
});

describe("Chat scroll-up pagination (remote mode)", () => {
  // Pretend the scroller is tall and the user scrolled to the TOP, so the scroll
  // listener's near-top check fires (scrollTop < 200).
  const stubScrolledToTop = (el: HTMLElement) => {
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    el.scrollTop = 0;
  };

  const remoteSession = (over: Partial<{ hasMore: boolean; loading: boolean }> = {}) => {
    const loadOlderMessages = vi.fn(async () => {});
    useStore.setState({
      activeId: "s1",
      sessions: [session()],
      messages: { s1: [userMessage("m1", "hi"), userMessage("m2", "yo")] },
      streaming: false,
      remoteConnected: true,
      messagePaging: { s1: { hasMore: true, loading: false, oldestSeq: 5, ...over } },
      loadOlderMessages,
    });
    return loadOlderMessages;
  };

  it("calls loadOlderMessages when scrolled to the top with more history", () => {
    const loadOlderMessages = remoteSession();

    const { container } = render(<Chat />);
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    stubScrolledToTop(scroller);
    fireEvent.scroll(scroller);

    expect(loadOlderMessages).toHaveBeenCalledWith("s1");
  });

  it("does not paginate when not remote-connected", () => {
    const loadOlderMessages = remoteSession();
    useStore.setState({ remoteConnected: false });

    const { container } = render(<Chat />);
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    stubScrolledToTop(scroller);
    fireEvent.scroll(scroller);

    expect(loadOlderMessages).not.toHaveBeenCalled();
  });

  it("does not paginate when there is no more history", () => {
    const loadOlderMessages = remoteSession({ hasMore: false });

    const { container } = render(<Chat />);
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    stubScrolledToTop(scroller);
    fireEvent.scroll(scroller);

    expect(loadOlderMessages).not.toHaveBeenCalled();
  });

  it("does not paginate while a fetch is already loading", () => {
    const loadOlderMessages = remoteSession({ loading: true });

    const { container } = render(<Chat />);
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    stubScrolledToTop(scroller);
    fireEvent.scroll(scroller);

    expect(loadOlderMessages).not.toHaveBeenCalled();
  });

  it("does not paginate when the user is not near the top", () => {
    const loadOlderMessages = remoteSession();

    const { container } = render(<Chat />);
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    // Scrolled DOWN, away from the top — the near-top check must not fire.
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 300, configurable: true });
    scroller.scrollTop = 700;
    fireEvent.scroll(scroller);

    expect(loadOlderMessages).not.toHaveBeenCalled();
  });
});

describe("Chat EmptyState auth affordance", () => {
  it("nudges to sign in when unauthenticated on desktop", () => {
    useStore.setState({
      activeId: null,
      messages: {},
      streaming: false,
      remoteMode: false,
      settings: { ...initial.settings },
    });

    render(<Chat />);
    expect(
      screen.getByText("Connect ChatGPT or an OpenAI Platform API key to start"),
    ).toBeInTheDocument();
  });

  it("opens settings when the sign-in nudge button is clicked", () => {
    const setShowSettings = vi.fn();
    useStore.setState({
      activeId: null,
      messages: {},
      streaming: false,
      remoteMode: false,
      settings: { ...initial.settings },
      setShowSettings,
    });

    render(<Chat />);
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(setShowSettings).toHaveBeenCalledWith(true);
  });

  it("hides the nudge when Codex reports an API-key account", () => {
    useStore.setState({
      activeId: null,
      messages: {},
      streaming: false,
      remoteMode: false,
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: "OpenAI Platform API key",
        tier: null,
        available: true,
      },
      openAIAccounts: [
        {
          id: "codex-primary",
          accountLabel: "OpenAI Platform API key",
          tier: null,
          expiresAt: null,
          state: "connected",
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
        },
      ],
    });

    render(<Chat />);
    expect(
      screen.queryByText("Connect ChatGPT or an OpenAI Platform API key to start"),
    ).not.toBeInTheDocument();
  });

  it("gates an OpenAI model on ChatGPT subscription auth, not the Anthropic key", () => {
    useStore.setState({
      activeId: null,
      messages: {},
      streaming: false,
      remoteMode: false,
      openAIAuthStatus: null,
      settings: {
        ...initial.settings,
        provider: "openai",
        model: "gpt-5.6-sol",
      },
    });

    const { rerender } = render(<Chat />);
    expect(
      screen.getByText("Connect ChatGPT or an OpenAI Platform API key to start"),
    ).toBeInTheDocument();

    const accountProfileId = "00000000-0000-4000-8000-000000000001";
    act(() =>
      useStore.setState({
        sessions: [session({ model: "gpt-5.6-sol", accountProfileId })],
        activeId: "s1",
        openAIAuthStatus: { signedIn: true, expiresAt: null, account: null, tier: null },
        openAIAccounts: [
          {
            id: accountProfileId,
            accountLabel: "one@chatgpt.test",
            tier: "ChatGPT Plus",
            expiresAt: null,
            state: "connected",
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: null,
          },
        ],
      }),
    );
    rerender(<Chat />);
    expect(screen.queryByText(/Connect ChatGPT or an OpenAI Platform API key/)).toBeNull();
  });

  it("hides default-account info while preserving legacy and removed-account recovery", () => {
    const accountProfileId = "00000000-0000-4000-8000-000000000001";
    const account = {
      id: accountProfileId,
      accountLabel: "one@chatgpt.test",
      tier: "ChatGPT Plus",
      expiresAt: null,
      state: "connected" as const,
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
    };
    useStore.setState({
      activeId: null,
      sessions: [],
      messages: {},
      streaming: false,
      remoteMode: false,
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
      },
      openAIAccounts: [account],
      settings: { ...initial.settings, provider: "openai", model: "gpt-5.6-sol" },
    });
    const view = render(<Chat />);
    expect(screen.queryByText(/default ChatGPT account/)).not.toBeInTheDocument();

    act(() =>
      useStore.setState({
        sessions: [session({ model: "gpt-5.6-sol", accountProfileId: null })],
        activeId: "s1",
        messages: { s1: [] },
      }),
    );
    view.rerender(<Chat />);
    expect(
      screen.getByText("Connect ChatGPT or an OpenAI Platform API key in Settings to start"),
    ).toBeInTheDocument();

    act(() =>
      useStore.setState({
        sessions: [session({ model: "gpt-5.6-sol", accountProfileId })],
        openAIAccounts: [],
      }),
    );
    view.rerender(<Chat />);
    expect(screen.getByText("Reconnect this chat's ChatGPT account to start")).toBeInTheDocument();
  });

  it("offers registry retry and account management instead of reconnect during discovery failure", () => {
    const accountProfileId = "00000000-0000-4000-8000-000000000098";
    const refreshOpenAIStatus = vi.fn(async () => {});
    useStore.setState({
      sessions: [session({ model: "gpt-5.6-sol", accountProfileId })],
      activeId: "s1",
      messages: { s1: [] },
      streaming: false,
      remoteMode: false,
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
      },
      openAIAccounts: [],
      openAIAccountsError: "credential registry is locked",
      openAIModels: [
        {
          id: "gpt-5.6-sol",
          label: "GPT-5.6 Sol",
          provider: "openai",
          reasoningEfforts: ["high"],
          defaultReasoningEffort: "high",
        },
      ],
      refreshOpenAIStatus,
      showSettings: false,
    });

    render(<Chat />);

    expect(
      screen.getByText(
        "This chat's ChatGPT account is unavailable because account discovery failed",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/reconnect this chat/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/credential was removed/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry accounts" }));
    expect(refreshOpenAIStatus).toHaveBeenCalledOnce();
    fireEvent.click(screen.getAllByRole("button", { name: "Manage accounts" })[0]);
    expect(useStore.getState().showSettings).toBe(true);
  });

  it("directs unavailable Codex auth to Settings without offering Claude", () => {
    const setShowSettings = vi.fn();
    useStore.setState({
      activeId: null,
      messages: {},
      streaming: false,
      remoteMode: false,
      openAIAuthStatus: {
        signedIn: false,
        expiresAt: null,
        account: null,
        tier: null,
        available: false,
        unavailableReason: "Disabled in this build",
      },
      settings: {
        ...initial.settings,
        provider: "openai",
        model: "gpt-5.6-sol",
      },
      setShowSettings,
    });

    render(<Chat />);

    expect(
      screen.getByText(
        "Disabled in this build. Connect ChatGPT or an OpenAI Platform API key in Settings to start",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Choose Claude/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(setShowSettings).toHaveBeenCalledWith(true);
  });

  it("suppresses the nudge in remote mode even when unauthenticated", () => {
    useStore.setState({
      activeId: null,
      messages: {},
      streaming: false,
      remoteMode: true,
      settings: { ...initial.settings },
    });

    render(<Chat />);
    expect(
      screen.queryByText("Connect ChatGPT or an OpenAI Platform API key to start"),
    ).not.toBeInTheDocument();
  });
});
