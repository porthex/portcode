import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { Composer } from "./Composer";
import { useStore } from "../store/store";
import { DEFAULT_SETTINGS, type Usage } from "../types";

// The Composer is a thin view over the real store: it binds `draft` and calls
// the store's send/stop actions, which reach the IPC bridge. We mock only the
// IPC layer (so `send` can't spawn the real mock-agent) and drive the actual
// store, asserting on observable DOM + store state. House style mirrors
// store.test.ts / smoke.test.tsx.
vi.mock("../lib/ipc", () => ({
  runAgent: vi.fn(),
  openFolder: vi.fn(),
  saveSettings: vi.fn(),
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
  m.runAgent.mockResolvedValue({ cancel: vi.fn(async () => {}), dispose: vi.fn() });
  m.openFolder.mockResolvedValue(null);
  m.saveSettings.mockImplementation(async (s) => ({ ...DEFAULT_SETTINGS, ...s }));
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

  it("is enabled when idle and disabled while a turn is streaming", () => {
    const ta = () =>
      screen.getByPlaceholderText("Describe a task, ask a question, or give an instruction…");

    const { rerender } = render(<Composer />);
    // Idle: keystrokes accepted.
    expect(ta()).toBeEnabled();

    // Streaming: the textarea goes inert so keystrokes are visibly ignored,
    // mirroring submit()'s `streaming` early-return guard.
    // Idle: not flagged busy to assistive tech.
    expect(ta()).not.toHaveAttribute("aria-busy", "true");

    act(() => {
      useStore.setState({ streaming: true });
    });
    rerender(<Composer />);
    expect(ta()).toBeDisabled();
    // Streaming: AT sees the input as busy for the duration of the turn.
    expect(ta()).toHaveAttribute("aria-busy", "true");
  });

  it("carries the streaming dim on the input itself, not the frame", () => {
    render(<Composer />);
    // The disabled-state dim lives on the textarea so it greys only the inert
    // input while leaving the Stop button (rendered in the same frame) bright.
    const ta = screen.getByPlaceholderText(
      "Describe a task, ask a question, or give an instruction…",
    );
    expect(ta.className).toContain("disabled:opacity-60");
    expect(ta.className).toContain("disabled:saturate-[0.6]");
    // The dim/undim eases instead of snapping at turn boundaries: opacity and
    // filter are in the transition list (not just height), and the
    // reduced-motion guard still neutralizes it.
    expect(ta.className).toContain("transition-[height,opacity,filter]");
    expect(ta.className).toContain("motion-reduce:transition-none");
  });

  it("exposes an explicit accessible name (not just the placeholder)", () => {
    render(<Composer />);
    // The placeholder is an unreliable accessible name (dropped once a draft is
    // present; not exposed by some AT). The aria-label is the stable name, so
    // the field is reachable by accessible name regardless of draft state.
    expect(screen.getByRole("textbox", { name: "Message Portcode" })).toBe(
      screen.getByPlaceholderText("Describe a task, ask a question, or give an instruction…"),
    );
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

  it("exposes an accessible name for screen readers while idle", () => {
    render(<Composer />);
    // Icon-only button: the SVG arrow conveys nothing to assistive tech, so the
    // aria-label is what announces it. byRole(name) matches the accessible name.
    expect(screen.getByRole("button", { name: "Send message" })).toBe(sendButton());
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

  it("collapses the textarea to an explicit px height on submit (not 'auto')", async () => {
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
    });
    // Mount with an empty draft so the [text] effect captures the single-row
    // height first; only then does submit() have a px target to collapse to.
    render(<Composer />);
    const ta = screen.getByPlaceholderText(
      "Describe a task, ask a question, or give an instruction…",
    ) as HTMLTextAreaElement;

    // Seed a tall multi-line draft (drives the [text] effect to grow the field).
    act(() => {
      useStore.setState({ draft: "line one\nline two\nline three" });
    });

    fireEvent.click(sendButton());

    // The collapse sets an interpolatable px value (CSS can't ease to/from
    // "auto"). jsdom reports scrollHeight 0, so the concrete value is "0px" —
    // what matters is it's a px string, not "auto".
    expect(ta.style.height).toMatch(/px$/);
    expect(ta.style.height).not.toBe("auto");

    await Promise.resolve();
    await Promise.resolve();
    expect(m.runAgent).toHaveBeenCalledWith(
      "a",
      "line one\nline two\nline three",
      expect.any(Function),
    );
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

  it("does not submit on the Enter that commits an IME composition", async () => {
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
      draft: "日本語",
    });
    render(<Composer />);

    const ta = screen.getByPlaceholderText(
      "Describe a task, ask a question, or give an instruction…",
    );
    // The composition-commit Enter carries isComposing on the native event; the
    // guard must let it pass through (commit the candidate) without sending.
    fireEvent.keyDown(ta, { key: "Enter", isComposing: true });

    // Draft is preserved (not cleared by submit) and no turn was started.
    expect(useStore.getState().draft).toBe("日本語");
    await Promise.resolve();
    await Promise.resolve();
    expect(m.runAgent).not.toHaveBeenCalled();
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

  it("exposes an accessible name for screen readers while streaming", () => {
    useStore.setState({ streaming: true });
    render(<Composer />);
    // The stop control is a bare red square with no text; the aria-label is the
    // only thing announcing its purpose to assistive tech.
    expect(screen.getByRole("button", { name: "Stop generating" })).toBe(stopButton());
  });

  it("guards its glow transition under prefers-reduced-motion", () => {
    useStore.setState({ streaming: true });
    render(<Composer />);
    // The Stop button animates box-shadow/filter on hover/active; without the
    // guard that would still play under reduced-motion (the global CSS doesn't
    // cover Tailwind transition utilities).
    expect(stopButton().className).toContain("motion-reduce:transition-none");
  });

  it("stays at full strength while streaming (the dim is scoped to the input)", () => {
    useStore.setState({ streaming: true });
    render(<Composer />);
    // The streaming dim must NOT live on the pc-neon-frame wrapper, or it would
    // de-emphasize the Stop button — the only available action during a run.
    const frame = stopButton().closest(".pc-neon-frame")!;
    expect(frame.className).not.toContain("opacity-70");
    expect(frame.className).not.toContain("saturate-[0.6]");
  });
});

describe("Composer UsageMeter", () => {
  it("always shows the active model and hint text, with no usage span when idle", () => {
    render(<Composer />);

    // The hint is split across spans (ENTER / SHIFT+ENTER keycaps in
    // text-muted); assert the keycap labels rather than one joined node.
    expect(screen.getByText("ENTER")).toBeInTheDocument();
    expect(screen.getByText("SHIFT+ENTER")).toBeInTheDocument();
    // Default model from DEFAULT_SETTINGS.
    expect(screen.getByText("claude-opus-4-8")).toBeInTheDocument();
    // No activeId / no usage -> total is 0 -> token+cost span is omitted.
    expect(screen.queryByText(/tok$/)).toBeNull();
  });

  it("omits the usage span when an active session has no recorded usage", () => {
    // activeId set but usage map empty -> selector yields undefined -> total 0.
    useStore.setState({ activeId: "a" });
    render(<Composer />);
    expect(screen.queryByText(/tok$/)).toBeNull();
  });

  it("shows tokens and a 4-decimal cost for small Opus usage", () => {
    const usage: Usage = { input: 1200, output: 300 };
    useStore.setState({ activeId: "a", usage: { a: usage } });
    render(<Composer />);

    // fmtTokens(1500) -> "1.5k"; Opus cost = (1200*5 + 300*25)/1e6 = 0.0135
    // which is >= 0.01, so 2 decimals: $0.01. Tokens and cost render in their
    // own spans (text-accent-2 / text-success), so assert each separately.
    expect(screen.getByText("1.5k tok")).toBeInTheDocument();
    expect(screen.getByText("$0.01")).toBeInTheDocument();
    // Hover title carries the localized raw in/out split.
    expect(screen.getByTitle("1,200 in · 300 out")).toBeInTheDocument();
  });

  it("uses 4 decimals when the cost is below one cent", () => {
    const usage: Usage = { input: 100, output: 0 };
    useStore.setState({ activeId: "a", usage: { a: usage } });
    render(<Composer />);

    // total 100 -> fmtTokens(100) -> "100"; Opus cost = (100*5)/1e6 = 0.0005
    // which is < 0.01, so 4 decimals: $0.0005.
    expect(screen.getByText("100 tok")).toBeInTheDocument();
    expect(screen.getByText("$0.0005")).toBeInTheDocument();
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
    expect(screen.getByText("5.0k tok")).toBeInTheDocument();
    expect(screen.getByText("$0.0000")).toBeInTheDocument();
    expect(screen.getByText("no-such-model")).toBeInTheDocument();
  });
});

describe("Composer permission-mode pill", () => {
  it("renders the current mode and cycles it on click", async () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, permissionMode: "default" } });
    render(<Composer />);

    const pill = screen.getByRole("button", { name: /Permission mode: default/i });
    expect(pill).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(pill);
    });

    // Cycles default → acceptEdits via updateSettings → saveSettings.
    expect(m.saveSettings).toHaveBeenCalledWith({ permissionMode: "acceptEdits" });
  });

  it("is hidden on the phone (remote mode) — the mode is a desktop-side gate setting", () => {
    useStore.setState({ remoteMode: true, settings: { ...DEFAULT_SETTINGS } });
    render(<Composer />);

    expect(screen.queryByRole("button", { name: /Permission mode/i })).not.toBeInTheDocument();
  });
});
