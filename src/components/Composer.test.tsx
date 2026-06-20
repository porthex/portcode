import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { Composer } from "./Composer";
import { useStore } from "../store/store";
import type { Usage } from "../types";

// The Composer is a thin view over the real store: it binds `draft` and calls
// the store's send/stop actions, which reach the IPC bridge. We mock only the
// IPC layer (so `send` can't spawn the real mock-agent) and drive the actual
// store, asserting on observable DOM + store state. House style mirrors
// store.test.ts / smoke.test.tsx.
vi.mock("../lib/ipc", () => ({
  runAgent: vi.fn(),
  openFolder: vi.fn(),
}));

import * as ipc from "../lib/ipc";

const m = vi.mocked(ipc);

// Snapshot a pristine store once, restore it (zustand has no built-in reset)
// before every test so cross-test state never leaks.
const initial = useStore.getState();

const sendButton = () => screen.getByTitle("Send (Enter)");
const stopButton = () => screen.getByTitle("Stop");

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initial, true);
  // Default: runAgent resolves to a cancellable handle so `send` starts a turn
  // without ever touching a real backend.
  m.runAgent.mockResolvedValue({ cancel: vi.fn(async () => {}) });
  m.openFolder.mockResolvedValue(null);
});

describe("Composer textarea", () => {
  it("reflects the current draft and updates it on typing", () => {
    useStore.setState({ draft: "seed" });
    render(<Composer />);

    const ta = screen.getByPlaceholderText(
      "Describe a task, ask a question, or give an instruction…",
    ) as HTMLTextAreaElement;
    expect(ta.value).toBe("seed");

    // Typing routes through onChange -> setDraft (+ autoGrow).
    fireEvent.change(ta, { target: { value: "hello world" } });
    expect(useStore.getState().draft).toBe("hello world");
    expect(ta.value).toBe("hello world");
  });

  it("syncs the textarea height when the draft changes externally", () => {
    render(<Composer />);
    // Drives the [text] effect (height-sync) without going through onChange.
    // Wrap in act() so React commits the external store update and runs the
    // effect before we assert.
    act(() => {
      useStore.setState({ draft: "pasted from explorer" });
    });
    expect(
      (
        screen.getByPlaceholderText(
          "Describe a task, ask a question, or give an instruction…",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("pasted from explorer");
  });
});

describe("Composer send button", () => {
  it("is disabled for an empty or whitespace-only draft", () => {
    render(<Composer />);
    expect(sendButton()).toBeDisabled();

    useStore.setState({ draft: "   " });
    expect(sendButton()).toBeDisabled();
  });

  it("is enabled once the draft has content", () => {
    useStore.setState({ draft: "do a thing" });
    render(<Composer />);
    expect(sendButton()).toBeEnabled();
  });

  it("submits on click: clears the draft and forwards the text to send", async () => {
    useStore.setState({
      sessions: [
        {
          id: "a",
          title: "New chat",
          workspace: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeId: "a",
      messages: { a: [] },
      draft: "Refactor the parser",
    });
    render(<Composer />);

    fireEvent.click(sendButton());

    // submit() clears the draft synchronously, then awaits send().
    expect(useStore.getState().draft).toBe("");
    // Let the awaited send() microtasks flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(m.runAgent).toHaveBeenCalledWith("a", "Refactor the parser", expect.any(Function));
  });
});

describe("Composer key handling", () => {
  it("submits on Enter (without Shift)", async () => {
    useStore.setState({
      sessions: [
        {
          id: "a",
          title: "New chat",
          workspace: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeId: "a",
      messages: { a: [] },
      draft: "ship it",
    });
    render(<Composer />);

    const ta = screen.getByPlaceholderText(
      "Describe a task, ask a question, or give an instruction…",
    );
    fireEvent.keyDown(ta, { key: "Enter" });

    expect(useStore.getState().draft).toBe("");
    await Promise.resolve();
    await Promise.resolve();
    expect(m.runAgent).toHaveBeenCalledWith("a", "ship it", expect.any(Function));
  });

  it("inserts a newline (does not submit) on Shift+Enter", () => {
    useStore.setState({ activeId: "a", messages: { a: [] }, draft: "line one" });
    render(<Composer />);

    const ta = screen.getByPlaceholderText(
      "Describe a task, ask a question, or give an instruction…",
    );
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });

    // The Shift branch is skipped: draft is untouched and nothing is sent.
    expect(useStore.getState().draft).toBe("line one");
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it("ignores other keys", () => {
    useStore.setState({ activeId: "a", messages: { a: [] }, draft: "typing" });
    render(<Composer />);

    const ta = screen.getByPlaceholderText(
      "Describe a task, ask a question, or give an instruction…",
    );
    fireEvent.keyDown(ta, { key: "a" });

    expect(useStore.getState().draft).toBe("typing");
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it("does not send when Enter is pressed on a whitespace-only draft", () => {
    useStore.setState({ activeId: "a", messages: { a: [] }, draft: "   " });
    render(<Composer />);

    const ta = screen.getByPlaceholderText(
      "Describe a task, ask a question, or give an instruction…",
    );
    fireEvent.keyDown(ta, { key: "Enter" });

    // submit() bails on !t.trim() — the draft stays and send() is never reached.
    expect(useStore.getState().draft).toBe("   ");
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it("does not send when Enter is pressed while a turn is streaming", () => {
    // While streaming the Send button is hidden, but the textarea Enter handler
    // still fires — submit() must early-return on the `streaming` guard.
    useStore.setState({ activeId: "a", messages: { a: [] }, draft: "queued", streaming: true });
    render(<Composer />);

    const ta = screen.getByPlaceholderText(
      "Describe a task, ask a question, or give an instruction…",
    );
    fireEvent.keyDown(ta, { key: "Enter" });

    expect(useStore.getState().draft).toBe("queued");
    expect(m.runAgent).not.toHaveBeenCalled();
  });
});

describe("Composer stop button", () => {
  it("renders Stop (not Send) while streaming and cancels the run on click", async () => {
    const cancel = vi.fn(async () => {});
    useStore.setState({ streaming: true, cancel });
    render(<Composer />);

    // Send is replaced by Stop in the streaming branch.
    expect(screen.queryByTitle("Send (Enter)")).toBeNull();
    const btn = stopButton();
    expect(btn).toBeInTheDocument();

    fireEvent.click(btn);
    await Promise.resolve();

    // stop() invokes the stored cancel and clears the streaming flags.
    expect(cancel).toHaveBeenCalledTimes(1);
    const st = useStore.getState();
    expect(st.streaming).toBe(false);
    expect(st.cancel).toBeNull();
  });
});

describe("Composer UsageMeter", () => {
  it("always shows the active model and hint text, with no usage span when idle", () => {
    render(<Composer />);

    expect(screen.getByText("Enter to send · Shift+Enter for newline")).toBeInTheDocument();
    // Default model from DEFAULT_SETTINGS.
    expect(screen.getByText("claude-opus-4-8")).toBeInTheDocument();
    // No activeId / no usage -> total is 0 -> token+cost span is omitted.
    expect(screen.queryByText(/tok ·/)).toBeNull();
  });

  it("omits the usage span when an active session has no recorded usage", () => {
    // activeId set but usage map empty -> selector yields undefined -> total 0.
    useStore.setState({ activeId: "a" });
    render(<Composer />);
    expect(screen.queryByText(/tok ·/)).toBeNull();
  });

  it("shows tokens and a 4-decimal cost for small Opus usage", () => {
    const usage: Usage = { input: 1200, output: 300 };
    useStore.setState({ activeId: "a", usage: { a: usage } });
    render(<Composer />);

    // fmtTokens(1500) -> "1.5k"; Opus cost = (1200*15 + 300*75)/1e6 = 0.0405
    // which is >= 0.01, so 2 decimals: $0.04.
    expect(screen.getByText("1.5k tok · $0.04")).toBeInTheDocument();
    // Hover title carries the localized raw in/out split.
    expect(screen.getByTitle("1,200 in · 300 out")).toBeInTheDocument();
  });

  it("uses 4 decimals when the cost is below one cent", () => {
    const usage: Usage = { input: 100, output: 0 };
    useStore.setState({ activeId: "a", usage: { a: usage } });
    render(<Composer />);

    // total 100 -> fmtTokens(100) -> "100"; Opus cost = (100*15)/1e6 = 0.0015
    // which is < 0.01, so 4 decimals: $0.0015.
    expect(screen.getByText("100 tok · $0.0015")).toBeInTheDocument();
    expect(screen.getByTitle("100 in · 0 out")).toBeInTheDocument();
  });

  it("treats an unknown model as free", () => {
    useStore.setState({
      activeId: "a",
      usage: { a: { input: 5000, output: 0 } },
      settings: { ...initial.settings, model: "no-such-model" },
    });
    render(<Composer />);

    // Unknown model -> estimateCost 0 -> $0.0000; fmtTokens(5000) -> "5.0k".
    expect(screen.getByText("5.0k tok · $0.0000")).toBeInTheDocument();
    expect(screen.getByText("no-such-model")).toBeInTheDocument();
  });
});
