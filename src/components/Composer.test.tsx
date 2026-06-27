import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { Composer } from "./Composer";
import { useStore } from "../store/store";
import { DEFAULT_SETTINGS, type ComposerPhase, type Session, type Usage } from "../types";

// The Composer is a thin view over the real store: it binds the ACTIVE session's
// draft and calls the store's send/stop actions, which reach the IPC bridge. We
// mock only the IPC layer (so `send` can't spawn the real mock-agent, and the
// debounced draft save never hits a backend) and drive the actual store, asserting
// on observable DOM + store state. House style mirrors store.test.ts / smoke.test.tsx.
vi.mock("../lib/ipc", () => ({
  runAgent: vi.fn(),
  openFolder: vi.fn(),
  // setSessionModel (via updateSettings) lands here; echo the patch so the
  // store's updateSettings resolves and commits the new settings.model.
  saveSettings: vi.fn(),
  saveDraft: vi.fn(),
}));

import * as ipc from "../lib/ipc";

const m = vi.mocked(ipc);

// Snapshot a pristine store once, restore it (zustand has no built-in reset)
// before every test so cross-test state never leaks.
const initial = useStore.getState();

const sendButton = () => screen.getByTitle("Send (Enter)");
const stopButton = () => screen.getByTitle("Stop");
const textarea = () =>
  screen.getByPlaceholderText(
    "Describe a task, ask a question, or give an instruction…",
  ) as HTMLTextAreaElement;

// Seed an active session with a draft (drafts are keyed by activeId now).
const seedDraft = (text: string, id = "a") =>
  useStore.setState({ activeId: id, drafts: { [id]: text } });

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initial, true);
  // Default: runAgent resolves to a cancellable handle so `send` starts a turn
  // without ever touching a real backend.
  m.runAgent.mockResolvedValue({ cancel: vi.fn(async () => {}), dispose: vi.fn() });
  m.openFolder.mockResolvedValue(null);
  m.saveSettings.mockImplementation(async (s) => ({ ...DEFAULT_SETTINGS, ...s }));
  m.saveDraft.mockResolvedValue(undefined);
});

const session = (over: Partial<Session> = {}): Session => ({
  id: "a",
  title: "New chat",
  workspace: null,
  model: "claude-opus-4-8",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe("Composer textarea", () => {
  it("reflects the active session's draft and updates it on typing", () => {
    seedDraft("seed");
    render(<Composer />);

    expect(textarea().value).toBe("seed");

    // Typing routes through onChange -> setDraft (+ autoGrow), keyed by activeId.
    fireEvent.change(textarea(), { target: { value: "hello world" } });
    expect(useStore.getState().drafts.a).toBe("hello world");
    expect(textarea().value).toBe("hello world");
  });

  it("shows only the ACTIVE session's draft (no cross-session bleed)", () => {
    // The bug per-session drafts fix: a half-written message in one session must not
    // appear in another. Two sessions hold distinct drafts; only the active shows.
    useStore.setState({ activeId: "a", drafts: { a: "draft A", b: "draft B" } });
    const { rerender } = render(<Composer />);
    expect(textarea().value).toBe("draft A");

    act(() => useStore.setState({ activeId: "b" }));
    rerender(<Composer />);
    expect(textarea().value).toBe("draft B");
  });

  it("syncs the textarea height when the draft changes externally", () => {
    useStore.setState({ activeId: "a" });
    render(<Composer />);
    // Drives the [text] effect (height-sync) without going through onChange.
    act(() => {
      useStore.setState({ drafts: { a: "pasted from explorer" } });
    });
    expect(textarea().value).toBe("pasted from explorer");
  });

  it("is enabled when idle and disabled while a turn is streaming", () => {
    useStore.setState({ activeId: "a" });
    const { rerender } = render(<Composer />);
    // Idle (with an active session): keystrokes accepted; not flagged busy to AT.
    expect(textarea()).toBeEnabled();
    expect(textarea()).not.toHaveAttribute("aria-busy", "true");

    act(() => {
      useStore.setState({ streaming: true });
    });
    rerender(<Composer />);
    expect(textarea()).toBeDisabled();
    // Streaming: AT sees the input as busy for the duration of the turn.
    expect(textarea()).toHaveAttribute("aria-busy", "true");
  });

  it("disables the input when there is no active session to draft into", () => {
    // Without an activeId, setDraft has nowhere to key the draft, so an enabled
    // field would silently eat keystrokes — disable it instead (honest dead-end).
    render(<Composer />);
    expect(textarea()).toBeDisabled();
  });

  it("carries the streaming dim on the input itself, not the frame", () => {
    render(<Composer />);
    const ta = textarea();
    expect(ta.className).toContain("disabled:opacity-60");
    expect(ta.className).toContain("disabled:saturate-[0.6]");
    expect(ta.className).toContain("transition-[height,opacity,filter]");
    expect(ta.className).toContain("motion-reduce:transition-none");
  });

  it("exposes an explicit accessible name (not just the placeholder)", () => {
    render(<Composer />);
    expect(screen.getByRole("textbox", { name: "Message Portcode" })).toBe(textarea());
  });
});

describe("Composer send button", () => {
  it("is disabled for an empty or whitespace-only draft", () => {
    useStore.setState({ activeId: "a" });
    render(<Composer />);
    expect(sendButton()).toBeDisabled();

    act(() => seedDraft("   "));
    expect(sendButton()).toBeDisabled();
  });

  it("is enabled once the draft has content", () => {
    seedDraft("do a thing");
    render(<Composer />);
    expect(sendButton()).toBeEnabled();
  });

  it("exposes an accessible name for screen readers while idle", () => {
    render(<Composer />);
    // While idle the Stop control is aria-hidden, so the only button with this role
    // tree the accessible-name query reaches is Send.
    expect(screen.getByRole("button", { name: "Send message" })).toBe(sendButton());
  });

  it("arms a one-shot pulse the moment Send becomes fireable", () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ activeId: "a" });
      render(<Composer />);
      // Empty draft → not armed.
      expect(sendButton().className).not.toContain("pc-armed");
      // Disabled→enabled transition (motor anticipation) arms the pulse.
      act(() => seedDraft("now there's content"));
      expect(sendButton().className).toContain("pc-armed");
      // One-shot: the pulse class drops shortly after it plays so a later
      // disabled→enabled transition can re-trigger it.
      act(() => vi.advanceTimersByTime(320));
      expect(sendButton().className).not.toContain("pc-armed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits on click: clears the active draft and forwards the text to send", async () => {
    useStore.setState({
      sessions: [
        {
          id: "a",
          title: "New chat",
          workspace: null,
          model: "claude-opus-4-8",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeId: "a",
      messages: { a: [] },
      drafts: { a: "Refactor the parser" },
    });
    render(<Composer />);

    fireEvent.click(sendButton());

    // submit() clears the draft synchronously, then awaits send().
    expect(useStore.getState().drafts.a).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(m.runAgent).toHaveBeenCalledWith(
      "a",
      "Refactor the parser",
      "claude-opus-4-8",
      expect.any(Function),
    );
  });

  it("collapses the textarea to an explicit px height on submit (not 'auto')", async () => {
    useStore.setState({
      sessions: [
        {
          id: "a",
          title: "New chat",
          workspace: null,
          model: "claude-opus-4-8",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeId: "a",
      messages: { a: [] },
    });
    render(<Composer />);
    const ta = textarea();

    // Seed a tall multi-line draft (drives the [text] effect to grow the field).
    act(() => {
      useStore.setState({ drafts: { a: "line one\nline two\nline three" } });
    });

    fireEvent.click(sendButton());

    // The collapse sets an interpolatable px value (CSS can't ease to/from "auto").
    expect(ta.style.height).toMatch(/px$/);
    expect(ta.style.height).not.toBe("auto");

    await Promise.resolve();
    await Promise.resolve();
    expect(m.runAgent).toHaveBeenCalledWith(
      "a",
      "line one\nline two\nline three",
      "claude-opus-4-8",
      expect.any(Function),
    );
  });
});

describe("Composer key handling", () => {
  const seedSession = (draft: string) =>
    useStore.setState({
      sessions: [
        {
          id: "a",
          title: "New chat",
          workspace: null,
          model: "claude-opus-4-8",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeId: "a",
      messages: { a: [] },
      drafts: { a: draft },
    });

  it("submits on Enter (without Shift)", async () => {
    seedSession("ship it");
    render(<Composer />);
    fireEvent.keyDown(textarea(), { key: "Enter" });

    expect(useStore.getState().drafts.a).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(m.runAgent).toHaveBeenCalledWith(
      "a",
      "ship it",
      "claude-opus-4-8",
      expect.any(Function),
    );
  });

  it("does not submit on the Enter that commits an IME composition", async () => {
    seedSession("日本語");
    render(<Composer />);
    // The composition-commit Enter carries isComposing on the native event; the
    // guard must let it pass through (commit the candidate) without sending.
    fireEvent.keyDown(textarea(), { key: "Enter", isComposing: true });

    expect(useStore.getState().drafts.a).toBe("日本語");
    await Promise.resolve();
    await Promise.resolve();
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it("inserts a newline (does not submit) on Shift+Enter", () => {
    useStore.setState({ activeId: "a", messages: { a: [] }, drafts: { a: "line one" } });
    render(<Composer />);
    fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });

    expect(useStore.getState().drafts.a).toBe("line one");
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it("ignores other keys", () => {
    useStore.setState({ activeId: "a", messages: { a: [] }, drafts: { a: "typing" } });
    render(<Composer />);
    fireEvent.keyDown(textarea(), { key: "a" });

    expect(useStore.getState().drafts.a).toBe("typing");
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it("does not send when Enter is pressed on a whitespace-only draft", () => {
    useStore.setState({ activeId: "a", messages: { a: [] }, drafts: { a: "   " } });
    render(<Composer />);
    fireEvent.keyDown(textarea(), { key: "Enter" });

    expect(useStore.getState().drafts.a).toBe("   ");
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it("does not send when Enter is pressed while a turn is streaming", () => {
    useStore.setState({
      activeId: "a",
      messages: { a: [] },
      drafts: { a: "queued" },
      streaming: true,
    });
    render(<Composer />);
    fireEvent.keyDown(textarea(), { key: "Enter" });

    expect(useStore.getState().drafts.a).toBe("queued");
    expect(m.runAgent).not.toHaveBeenCalled();
  });
});

describe("Composer send↔stop crossfade", () => {
  it("stacks both controls and only the active one is in the tab order", () => {
    const { rerender } = render(<Composer />);
    // Idle: Send is reachable; Stop is hidden from AT and out of the tab sequence.
    expect(sendButton()).toHaveAttribute("tabindex", "0");
    expect(sendButton()).not.toHaveAttribute("aria-hidden", "true");
    expect(stopButton()).toHaveAttribute("tabindex", "-1");
    expect(stopButton()).toHaveAttribute("aria-hidden", "true");

    act(() => useStore.setState({ streaming: true }));
    rerender(<Composer />);
    // Streaming: the visibility + tab order swap — Stop in, Send out.
    expect(stopButton()).toHaveAttribute("tabindex", "0");
    expect(stopButton()).not.toHaveAttribute("aria-hidden", "true");
    expect(sendButton()).toHaveAttribute("tabindex", "-1");
    expect(sendButton()).toHaveAttribute("aria-hidden", "true");
  });

  it("cross-fades the controls (not an instant swap) and both fill one slot", () => {
    const { rerender } = render(<Composer />);
    // Both carry the crossfade class; idle shows Send / hides Stop.
    expect(sendButton().className).toContain("pc-action");
    expect(stopButton().className).toContain("pc-action");
    expect(sendButton().className).toContain("pc-action--shown");
    expect(stopButton().className).toContain("pc-action--hidden");

    act(() => useStore.setState({ streaming: true }));
    rerender(<Composer />);
    expect(stopButton().className).toContain("pc-action--shown");
    expect(sendButton().className).toContain("pc-action--hidden");
  });

  it("cancels the run on Stop click and clears the streaming flags", async () => {
    const cancel = vi.fn(async () => {});
    useStore.setState({ streaming: true, cancel });
    render(<Composer />);

    fireEvent.click(stopButton());
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledTimes(1);
    const st = useStore.getState();
    expect(st.streaming).toBe(false);
    expect(st.cancel).toBeNull();
  });

  it("relabels + dims the Stop button while a stop is in flight", () => {
    useStore.setState({ streaming: true, composerPhase: "stopping" });
    render(<Composer />);
    // The instant Stop is pressed (composerPhase === "stopping"): relabel for AT and
    // dim, before the backend cancel resolves.
    expect(stopButton()).toHaveAttribute("aria-label", "Stopping…");
    expect(stopButton().className).toContain("pc-stop--stopping");
    // And it's disabled so a second click can't fire a duplicate cancel.
    expect(stopButton()).toBeDisabled();
  });

  it("exposes an accessible name for the Stop control while streaming", () => {
    useStore.setState({ streaming: true });
    render(<Composer />);
    expect(screen.getByRole("button", { name: "Stop generating" })).toBe(stopButton());
  });

  it("keeps the Stop control at full strength (the dim is scoped to the input)", () => {
    useStore.setState({ streaming: true });
    render(<Composer />);
    const frame = stopButton().closest(".pc-neon-frame")!;
    expect(frame.className).not.toContain("opacity-70");
    expect(frame.className).not.toContain("saturate-[0.6]");
  });
});

describe("Composer neon frame (state-bearing)", () => {
  it("flows only while streaming via the data-busy flag", () => {
    const { rerender } = render(<Composer />);
    const frame = () => textarea().closest(".pc-neon-frame")!;
    // At rest: still + glowing (no busy flag → the CSS animation doesn't run).
    expect(frame()).not.toHaveAttribute("data-busy", "true");

    act(() => useStore.setState({ streaming: true }));
    rerender(<Composer />);
    // Streaming: the gradient flows.
    expect(frame()).toHaveAttribute("data-busy", "true");
    // The flow + the wrapper transitions both have a reduced-motion fallback.
    expect(frame().className).toContain("motion-reduce:transition-none");
  });
});

describe("Composer presence region", () => {
  const phaseText = (streaming: boolean, phase: ComposerPhase) => {
    useStore.setState({ streaming, composerPhase: phase });
    render(<Composer />);
    return screen.getByRole("status").textContent;
  };

  it("is a polite, atomic live status region", () => {
    render(<Composer />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
  });

  it("reads 'ready when you are' at rest", () => {
    expect(phaseText(false, "idle")).toContain("ready when you are");
  });

  it("acknowledges the send with 'got it — reading…' (received)", () => {
    expect(phaseText(true, "received")).toContain("got it — reading…");
  });

  it("settles to 'thinking with you…' while working", () => {
    expect(phaseText(true, "thinking")).toContain("thinking with you…");
  });

  it("reads 'stopping…' the instant Stop is pressed", () => {
    expect(phaseText(true, "stopping")).toContain("stopping…");
  });

  it("shows the honest Shift+Enter hint only when the draft is multi-line", () => {
    seedDraft("one line");
    const { rerender } = render(<Composer />);
    expect(screen.queryByText("Shift+Enter for a new line")).toBeNull();

    act(() => seedDraft("line one\nline two"));
    rerender(<Composer />);
    expect(screen.getByText("Shift+Enter for a new line")).toBeInTheDocument();
  });
});

describe("Composer UsageMeter", () => {
  it("shows the active model and presence at rest, with no usage span", () => {
    render(<Composer />);
    // The static keycap hint is gone — the presence region carries the live status.
    expect(screen.getByRole("status").textContent).toContain("ready when you are");
    // Default model from DEFAULT_SETTINGS.
    expect(screen.getByText("claude-opus-4-8")).toBeInTheDocument();
    // No activeId / no usage -> total is 0 -> token+cost span is omitted.
    expect(screen.queryByText(/tok$/)).toBeNull();
  });

  it("omits the usage span when an active session has no recorded usage", () => {
    useStore.setState({ activeId: "a" });
    render(<Composer />);
    expect(screen.queryByText(/tok$/)).toBeNull();
  });

  it("shows tokens and a 4-decimal cost for small Opus usage, with tabular-nums", () => {
    const usage: Usage = { input: 1200, output: 300 };
    useStore.setState({ activeId: "a", usage: { a: usage } });
    render(<Composer />);

    // fmtTokens(1500) -> "1.5k"; Opus cost = (1200*5 + 300*25)/1e6 = 0.0135 -> $0.01.
    expect(screen.getByText("1.5k tok")).toBeInTheDocument();
    expect(screen.getByText("$0.01")).toBeInTheDocument();
    expect(screen.getByTitle("1,200 in · 300 out")).toBeInTheDocument();
    // tabular-nums (on the usage group span) keeps the counter from reflowing as
    // digits change width.
    expect(screen.getByText("1.5k tok").closest("[aria-hidden='true']")?.className).toContain(
      "tabular-nums",
    );
  });

  it("keeps the per-tick token counter out of the live region (aria-hidden)", () => {
    useStore.setState({ activeId: "a", usage: { a: { input: 1200, output: 300 } } });
    render(<Composer />);
    // The ticking numbers must not be announced on every streaming delta — they live
    // OUTSIDE the role=status region and the number span is aria-hidden.
    const usageSpan = screen.getByText("1.5k tok").closest("[aria-hidden='true']");
    expect(usageSpan).not.toBeNull();
    expect(screen.getByRole("status").textContent).not.toContain("tok");
  });

  it("uses 4 decimals when the cost is below one cent", () => {
    const usage: Usage = { input: 100, output: 0 };
    useStore.setState({ activeId: "a", usage: { a: usage } });
    render(<Composer />);

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

describe("Composer plan-mode banner", () => {
  it("shows the banner in plan mode and exits to default on click", async () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, permissionMode: "plan" } });
    render(<Composer />);

    expect(screen.getByText("Plan mode")).toBeInTheDocument();
    const exit = screen.getByRole("button", { name: /Exit plan mode/i });

    await act(async () => {
      fireEvent.click(exit);
    });
    expect(m.saveSettings).toHaveBeenCalledWith({ permissionMode: "default" });
  });

  it("is hidden when not in plan mode", () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, permissionMode: "default" } });
    render(<Composer />);

    expect(screen.queryByRole("button", { name: /Exit plan mode/i })).not.toBeInTheDocument();
  });

  it("is hidden on the phone even in plan mode", () => {
    useStore.setState({
      remoteMode: true,
      settings: { ...DEFAULT_SETTINGS, permissionMode: "plan" },
    });
    render(<Composer />);

    expect(screen.queryByRole("button", { name: /Exit plan mode/i })).not.toBeInTheDocument();
  });
});

describe("Composer ModelPicker", () => {
  it("reflects the active session's model and groups options by provider", () => {
    useStore.setState({
      sessions: [session({ id: "a", model: "claude-opus-4-8" })],
      activeId: "a",
      messages: { a: [] },
    });
    render(<Composer />);

    const picker = screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement;
    expect(picker.value).toBe("claude-opus-4-8");
    // Provider-grouped: the Anthropic <optgroup> wraps the model options.
    const groups = picker.querySelectorAll("optgroup");
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Anthropic");
    expect(screen.getByRole("option", { name: "Claude Sonnet 4.6" })).toBeInTheDocument();
  });

  it("changing the model updates the active session AND the last-used default", async () => {
    useStore.setState({
      sessions: [session({ id: "a", model: "claude-opus-4-8" })],
      activeId: "a",
      messages: { a: [] },
    });
    render(<Composer />);

    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), {
      target: { value: "claude-sonnet-4-6" },
    });

    // setSessionModel updates the session synchronously, then awaits the
    // last-used sync into settings.model (updateSettings -> ipc.saveSettings).
    expect(useStore.getState().sessions[0].model).toBe("claude-sonnet-4-6");
    await Promise.resolve();
    await Promise.resolve();
    expect(m.saveSettings).toHaveBeenCalledWith({ model: "claude-sonnet-4-6" });
    expect(useStore.getState().settings.model).toBe("claude-sonnet-4-6");
  });

  it("is disabled while a turn is streaming", () => {
    useStore.setState({
      sessions: [session({ id: "a" })],
      activeId: "a",
      messages: { a: [] },
      streaming: true,
    });
    render(<Composer />);
    expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();
  });
});
