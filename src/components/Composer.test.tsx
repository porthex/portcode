import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

import { Composer } from "./Composer";
import { useStore } from "../store/store";
import {
  DEFAULT_SETTINGS,
  type ComposerPhase,
  type OpenAIAccountSummary,
  type Session,
  type Usage,
} from "../types";

// The Composer is a thin view over the real store: it binds the ACTIVE session's
// draft and calls the store's send/stop actions, which reach the IPC bridge. We
// mock only the IPC layer (so `send` can't spawn the real mock-agent, and the
// debounced draft save never hits a backend) and drive the actual store, asserting
// on observable DOM + store state. House style mirrors store.test.ts / smoke.test.tsx.
vi.mock("../lib/ipc", () => ({
  runAgent: vi.fn(),
  openFolder: vi.fn(),
  // setSessionModel persists the active chat, then updateSettings mirrors it as
  // the default for future chats.
  updateSessionModel: vi.fn(),
  saveSettings: vi.fn(),
  saveDraft: vi.fn(),
  openaiModels: vi.fn(),
  pinSessionOpenAIAccount: vi.fn(),
  listSessions: vi.fn(),
}));

import * as ipc from "../lib/ipc";

const m = vi.mocked(ipc);

// Snapshot a pristine store once, restore it (zustand has no built-in reset)
// before every test so cross-test state never leaks.
const initial = useStore.getState();

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

const sendButton = () => screen.getByTitle("Send (Enter)");
const stopButton = () => screen.getByTitle("Stop");
const textarea = () => screen.getByRole("textbox", { name: "Message Portcode" });

// Seed an active session with a draft (drafts are keyed by activeId now).
const seedDraft = (text: string, id = "a") =>
  useStore.setState({ activeId: id, drafts: { [id]: text } });

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initial, true);
  // Most composer tests exercise drafting/streaming, not auth. Seed the legacy
  // Claude API-key path so Send stays available; auth-specific cases override it.
  useStore.setState({ settings: { ...DEFAULT_SETTINGS, apiKeySet: true } });
  // Default: runAgent resolves to a cancellable handle so `send` starts a turn
  // without ever touching a real backend.
  m.runAgent.mockResolvedValue({ cancel: vi.fn(async () => {}), dispose: vi.fn() });
  m.openFolder.mockResolvedValue(null);
  m.updateSessionModel.mockResolvedValue(undefined);
  m.saveSettings.mockImplementation(async (s) => ({ ...DEFAULT_SETTINGS, ...s }));
  m.saveDraft.mockResolvedValue(undefined);
  m.openaiModels.mockResolvedValue([]);
  m.listSessions.mockResolvedValue([]);
  m.pinSessionOpenAIAccount.mockImplementation(async (sessionId, accountProfileId) =>
    session({ id: sessionId, model: "gpt-live", accountProfileId }),
  );
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

const openAIAccount = (over: Partial<OpenAIAccountSummary> = {}): OpenAIAccountSummary => ({
  id: "00000000-0000-4000-8000-000000000001",
  accountLabel: "one@chatgpt.test",
  tier: "ChatGPT Plus",
  expiresAt: null,
  state: "connected",
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  ...over,
});

describe("Composer rich editor", () => {
  it("reflects the active session's Markdown draft", () => {
    seedDraft("seed");
    render(<Composer />);

    expect(textarea()).toHaveTextContent("seed");
  });

  it("shows only the ACTIVE session's draft (no cross-session bleed)", () => {
    // The bug per-session drafts fix: a half-written message in one session must not
    // appear in another. Two sessions hold distinct drafts; only the active shows.
    useStore.setState({ activeId: "a", drafts: { a: "draft A", b: "draft B" } });
    const { rerender } = render(<Composer />);
    expect(textarea()).toHaveTextContent("draft A");

    act(() => useStore.setState({ activeId: "b" }));
    rerender(<Composer />);
    expect(textarea()).toHaveTextContent("draft B");
  });

  it("syncs the editor when the draft changes externally", async () => {
    useStore.setState({ activeId: "a" });
    render(<Composer />);
    // Drives the [text] effect (height-sync) without going through onChange.
    act(() => {
      useStore.setState({ drafts: { a: "pasted from explorer" } });
    });
    await waitFor(() => expect(textarea()).toHaveTextContent("pasted from explorer"));
  });

  it("stays editable while a turn streams so the next message can be drafted", async () => {
    useStore.setState({ activeId: "a" });
    const { rerender } = render(<Composer />);
    // Idle (with an active session): keystrokes are accepted.
    expect(textarea()).toBeEnabled();

    act(() => {
      useStore.setState({ streaming: true });
    });
    rerender(<Composer />);
    expect(textarea()).toBeEnabled();
    expect(textarea()).toHaveAttribute(
      "aria-placeholder",
      "Draft your next message while Portcode works…",
    );
    // The shell owns the run state; the still-editable textbox is not mislabeled busy.
    expect(textarea().closest(".pc-neon-frame")).toHaveAttribute("aria-busy", "true");
    act(() => useStore.setState({ drafts: { a: "next thought" } }));
    await waitFor(() => expect(textarea()).toHaveTextContent("next thought"));
  });

  it("disables the input when there is no active session to draft into", () => {
    // Without an activeId, setDraft has nowhere to key the draft, so an enabled
    // field would silently eat keystrokes — disable it instead (honest dead-end).
    render(<Composer />);
    expect(textarea()).toHaveAttribute("contenteditable", "false");
    expect(textarea()).toHaveAttribute("aria-readonly", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Create or select a chat to start");
    expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
  });

  it("routes the no-session CTA through the shared default creation path", () => {
    const newSession = vi.fn(async () => {});
    useStore.setState({ newSession });
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    expect(newSession).toHaveBeenCalledWith();
  });

  it("uses a dedicated full-width writing surface with a compliant placeholder", () => {
    render(<Composer />);
    const editor = textarea();
    expect(editor).toHaveAttribute("contenteditable", "false");
    expect(editor.className).toContain("pc-composer-editor");
    expect(editor).toHaveAttribute("aria-placeholder", "Create or select a chat to begin…");
  });

  it("exposes an explicit accessible name (not just the placeholder)", () => {
    render(<Composer />);
    expect(screen.getByRole("textbox", { name: "Message Portcode" })).toBe(textarea());
  });

  it("teaches the supported formatting from a compact help button", () => {
    render(<Composer />);
    const help = screen.getByRole("button", { name: "Formatting help" });
    fireEvent.click(help);

    const guide = screen.getByRole("dialog", { name: "Message formatting" });
    expect(guide).toHaveTextContent("- [ ] task");
    expect(guide).toHaveTextContent("Tab");
    expect(guide).toHaveTextContent("Shift+Tab");
    expect(guide).toHaveTextContent("Shift+Enter");
    expect(guide).toHaveTextContent("empty nested item it outdents");

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Message formatting" })).toBeNull();

    fireEvent.click(help);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Message formatting" })).toBeNull();
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
    expect(m.runAgent).toHaveBeenCalledWith("a", "Refactor the parser", expect.any(Function));
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
    expect(m.runAgent).toHaveBeenCalledWith("a", "ship it", expect.any(Function));
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

  it("keeps the draft editable but guards Send after a cold history load error", () => {
    useStore.setState({
      activeId: "a",
      messages: {},
      drafts: { a: "keep this draft" },
      messageLoads: {
        a: {
          phase: "error",
          loadedAt: null,
          lastAccessedAt: 1,
          requestId: 1,
          error: "offline",
          nextCursor: null,
          loadingOlder: false,
        },
      },
    });
    render(<Composer />);

    expect(textarea()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Conversation failed to load" })).toBeDisabled();
  });

  it("allows Send when a refresh fails but cached history remains", () => {
    useStore.setState({
      activeId: "a",
      messages: { a: [] },
      drafts: { a: "send from cache" },
      messageLoads: {
        a: {
          phase: "error",
          loadedAt: 1,
          lastAccessedAt: 2,
          requestId: 2,
          error: "offline",
          nextCursor: null,
          loadingOlder: false,
        },
      },
    });
    render(<Composer />);

    expect(sendButton()).toBeEnabled();
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
    useStore.setState({
      sessions: [session({ id: "a" })],
      activeId: "a",
      messages: { a: [] },
      streaming: true,
      cancel,
    });
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
    useStore.setState({ activeId: "a", streaming, composerPhase: phase });
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

  it("names the running canonical tool while a tool_use is active", () => {
    useStore.setState({
      activeId: "a",
      streaming: true,
      composerPhase: "thinking",
      activeTool: "search_text",
    });
    render(<Composer />);
    expect(screen.getByRole("status").textContent).toContain("searching the project…");
  });

  it("falls back to a generic 'running <name>…' for an unmapped tool", () => {
    useStore.setState({
      activeId: "a",
      streaming: true,
      composerPhase: "thinking",
      activeTool: "mystery_tool",
    });
    render(<Composer />);
    expect(screen.getByRole("status").textContent).toContain("running mystery tool…");
  });

  it("never shows a residual tool label once streaming ends (streaming-gated)", () => {
    useStore.setState({
      activeId: "a",
      streaming: false,
      composerPhase: "idle",
      activeTool: "grep",
    });
    render(<Composer />);
    expect(screen.getByRole("status").textContent).toContain("ready when you are");
  });

  it("shows the generic 'thinking with you…' (not a tool) outside the thinking phase", () => {
    // An observed turn can be streaming with a stale activeTool while the phase is
    // still idle; the phase gate keeps the tool label from surfacing wrongly.
    useStore.setState({
      activeId: "a",
      streaming: true,
      composerPhase: "idle",
      activeTool: "grep",
    });
    render(<Composer />);
    const status = screen.getByRole("status").textContent;
    expect(status).toContain("thinking with you…");
    expect(status).not.toContain("searching the project…");
  });

  it("keeps the keyboard contract discoverable and switches to drafting guidance while busy", () => {
    seedDraft("one line");
    const { rerender } = render(<Composer />);
    expect(screen.getByText("Enter").tagName).toBe("KBD");
    expect(screen.getByText("Send")).toBeInTheDocument();
    expect(screen.getByText("Shift+Enter").tagName).toBe("KBD");
    expect(screen.getByText("New line")).toBeInTheDocument();

    act(() => useStore.setState({ streaming: true }));
    rerender(<Composer />);
    expect(
      screen.getByText("Keep drafting · send unlocks when this run finishes"),
    ).toBeInTheDocument();
  });
});

describe("Composer UsageMeter", () => {
  it("shows the selected model once and omits usage when the session has none", () => {
    useStore.setState({ activeId: "a" });
    render(<Composer />);
    expect(screen.getByRole("status").textContent).toContain("ready when you are");
    // The model lives in its labeled picker and is no longer repeated in telemetry.
    expect(screen.getAllByText("Opus 4.8")).toHaveLength(1);
    expect(screen.queryByRole("group", { name: /Session usage/i })).toBeNull();
  });

  it("omits the usage span when an active session has no recorded usage", () => {
    useStore.setState({ activeId: "a" });
    render(<Composer />);
    expect(screen.queryByRole("group", { name: /Session usage/i })).toBeNull();
  });

  it("labels cumulative session tokens and estimated Opus cost", () => {
    const usage: Usage = { input: 1200, output: 300 };
    useStore.setState({ activeId: "a", usage: { a: usage } });
    render(<Composer />);

    // fmtTokens(1500) -> "1.5k"; Opus cost = (1200*5 + 300*25)/1e6 = 0.0135 -> $0.01.
    expect(screen.getByText("1.5k tokens")).toBeInTheDocument();
    expect(screen.getByText("$0.01 estimated")).toBeInTheDocument();
    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.getByTitle("1,200 in · 300 out")).toBeInTheDocument();
    expect(
      screen.getByRole("group", {
        name: /Session usage: 1,500 tokens, 1,200 input and 300 output/i,
      }),
    ).toHaveClass("pc-composer-usage");
  });

  it("formats million-scale usage cleanly and names the ChatGPT plan", () => {
    useStore.setState({
      sessions: [session({ model: "gpt-5.6-sol" })],
      activeId: "a",
      usage: { a: { input: 2_000_000, output: 199_700 } },
      openAIAuthStatus: { signedIn: true, expiresAt: null, account: null, tier: null },
    });
    render(<Composer />);

    expect(screen.getByText("2.2M tokens")).toBeInTheDocument();
    expect(screen.getByText("ChatGPT plan")).toBeInTheDocument();
    expect(screen.queryByText("2199.7k tokens")).toBeNull();
  });

  it("keeps ticking visuals out of the live region but exposes a stable accessible summary", () => {
    useStore.setState({ activeId: "a", usage: { a: { input: 1200, output: 300 } } });
    render(<Composer />);

    const usageGroup = screen.getByRole("group", { name: /Session usage: 1,500 tokens/i });
    expect(usageGroup.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("status").textContent).not.toContain("tokens");
    expect(usageGroup).toHaveAccessibleName(
      "Session usage: 1,500 tokens, 1,200 input and 300 output; $0.01 estimated; Claude Opus 4.8",
    );
  });

  it("uses 4 decimals when the cost is below one cent", () => {
    const usage: Usage = { input: 100, output: 0 };
    useStore.setState({ activeId: "a", usage: { a: usage } });
    render(<Composer />);

    expect(screen.getByText("100 tokens")).toBeInTheDocument();
    expect(screen.getByText("$0.0005 estimated")).toBeInTheDocument();
    expect(screen.getByTitle("100 in · 0 out")).toBeInTheDocument();
  });

  it("reports unavailable pricing honestly instead of treating an unknown model as free", () => {
    useStore.setState({
      activeId: "a",
      usage: { a: { input: 5000, output: 0 } },
      settings: { ...initial.settings, model: "no-such-model" },
    });
    render(<Composer />);

    expect(screen.getByText("5.0k tokens")).toBeInTheDocument();
    expect(screen.getByText("Cost unavailable")).toBeInTheDocument();
    expect(screen.queryByText("$0.0000")).toBeNull();
    expect(screen.getByRole("group", { name: /no-such-model/i })).toBeInTheDocument();
  });
});

describe("Composer permission dropdown", () => {
  it("shows every permission mode in clearly separated groups", () => {
    render(<Composer />);

    expect(screen.queryByText("Access")).not.toBeInTheDocument();
    const picker = screen.getByRole("combobox", { name: "Permission mode" });
    expect(picker).toHaveValue("default");
    expect(picker).toHaveTextContent("Ask");

    fireEvent.click(picker);
    expect(screen.getByRole("group", { name: "Standard access" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Elevated access" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Ask" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Edits allowed" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Plan only" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Auto configurable" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Bypass configurable" })).toBeInTheDocument();
  });

  it("persists any selected permission mode", async () => {
    render(<Composer />);

    fireEvent.click(screen.getByRole("combobox", { name: "Permission mode" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Bypass configurable" }));
    });

    expect(m.saveSettings).toHaveBeenCalledWith({ permissionMode: "bypass" });
    expect(useStore.getState().settings.permissionMode).toBe("bypass");
  });

  it("is hidden on the phone because permission policy is desktop-owned", () => {
    useStore.setState({ remoteMode: true, settings: { ...DEFAULT_SETTINGS } });
    render(<Composer />);

    expect(screen.queryByRole("combobox", { name: "Permission mode" })).not.toBeInTheDocument();
  });

  it("marks dangerous access and freezes policy changes during a run", () => {
    useStore.setState({
      streaming: true,
      settings: { ...DEFAULT_SETTINGS, permissionMode: "bypass" },
    });
    render(<Composer />);

    const picker = screen.getByRole("combobox", { name: "Permission mode" });
    expect(picker).toHaveTextContent("Bypass configurable");
    expect(picker).toHaveAttribute("title", expect.stringContaining("protected actions still ask"));
    expect(picker).toHaveClass("pc-permission-select--danger");
    expect(picker).toBeDisabled();
  });

  it("freezes global permission policy while a background session runs", () => {
    useStore.setState({
      activeId: "a",
      runs: { b: run({ streaming: true }) },
      settings: { ...DEFAULT_SETTINGS, permissionMode: "default" },
    });
    render(<Composer />);

    expect(screen.getByRole("combobox", { name: "Permission mode" })).toBeDisabled();
  });

  it("removes the plan warning banner while keeping plan state clear in the composer", () => {
    useStore.setState({
      activeId: "a",
      settings: { ...DEFAULT_SETTINGS, apiKeySet: true, permissionMode: "plan" },
    });
    render(<Composer />);

    expect(screen.queryByRole("button", { name: /Exit plan mode/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Dismiss plan mode notice/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Permission mode" })).toHaveTextContent(
      "Plan only",
    );
    expect(textarea()).toHaveAttribute(
      "aria-placeholder",
      "Describe what you want planned — files will stay untouched…",
    );
  });
});

describe("Composer recovery", () => {
  it("surfaces setting-save failures where they happened without hiding run status", () => {
    useStore.setState({ activeId: "a", settingsError: "database is locked" });
    render(<Composer />);

    expect(screen.getByRole("status")).toHaveTextContent("ready when you are");
    expect(screen.getByRole("alert")).toHaveTextContent("That setting wasn’t saved");
    expect(screen.getByRole("alert")).toHaveAttribute("title", "database is locked");

    fireEvent.click(screen.getByRole("button", { name: "Review settings" }));
    expect(useStore.getState().showSettings).toBe(true);
  });
});

describe("Composer run setup", () => {
  it("reflects the active session's model and groups options by provider", () => {
    useStore.setState({
      sessions: [session({ id: "a", model: "claude-opus-4-8" })],
      activeId: "a",
      messages: { a: [] },
    });
    render(<Composer />);

    const picker = screen.getByRole("button", { name: "Model, effort, and speed" });
    expect(screen.queryByText("Chat model")).not.toBeInTheDocument();
    expect(picker).toHaveTextContent("Opus 4.8");
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    // Provider-grouped inside Portcode's themed listbox (not a native OS popup).
    expect(screen.getByRole("group", { name: "Anthropic · Claude" })).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "OpenAI · ChatGPT subscription" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Claude Sonnet 4.6" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Model" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(picker).toHaveAttribute("aria-expanded", "false");
  });

  it("changing the model updates the active session AND the last-used default", async () => {
    useStore.setState({
      sessions: [session({ id: "a", model: "claude-opus-4-8" })],
      activeId: "a",
      messages: { a: [] },
    });
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "Model, effort, and speed" }));
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    fireEvent.click(screen.getByRole("option", { name: "Claude Sonnet 4.6" }));

    // setSessionModel updates the session synchronously, then awaits the
    // last-used sync into settings.model (updateSettings -> ipc.saveSettings).
    expect(useStore.getState().sessions[0].model).toBe("claude-sonnet-4-6");
    await Promise.resolve();
    await Promise.resolve();
    expect(m.saveSettings).toHaveBeenCalledWith({
      model: "claude-sonnet-4-6",
      reasoningEffort: "medium",
    });
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
    expect(screen.getByRole("button", { name: "Model, effort, and speed" })).toBeDisabled();
  });
});

describe("Composer OpenAI auth and reasoning", () => {
  const openAIModel = {
    id: "gpt-live",
    label: "GPT Live",
    provider: "openai" as const,
    reasoningEfforts: ["minimal", "high", "ultra"],
    defaultReasoningEffort: "high",
  };

  it("routes an unassigned GPT session to Settings without an account prompt above the composer", () => {
    useStore.setState({
      sessions: [session({ model: "gpt-live" })],
      activeId: "a",
      drafts: { a: "ship it" },
      openAIModels: [openAIModel],
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-live" },
      openAIAuthStatus: null,
    });
    render(<Composer />);

    expect(
      screen.getByRole("button", {
        name: "Choose a default ChatGPT account in Settings to send",
      }),
    ).toBeDisabled();
    expect(screen.queryByRole("group", { name: "Choose ChatGPT account" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "ChatGPT account for this conversation" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage ChatGPT" }));
    expect(useStore.getState().showSettings).toBe(true);
  });
  it("fails closed and removes OpenAI choices when this build disables the capability", () => {
    useStore.setState({
      sessions: [session({ model: "gpt-live" })],
      activeId: "a",
      drafts: { a: "ship it" },
      openAIModels: [],
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-live" },
      openAIAuthStatus: {
        signedIn: false,
        expiresAt: null,
        account: null,
        tier: null,
        available: false,
        unavailableReason: "Disabled in this build",
      },
    });
    render(<Composer />);

    expect(screen.getByRole("button", { name: "Disabled in this build" })).toBeDisabled();
    expect(
      screen
        .getAllByRole("status")
        .some((status) => status.textContent?.includes("Disabled in this build")),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Model, effort, and speed" }));
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    expect(screen.queryByRole("group", { name: /OpenAI/ })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Anthropic/ })).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Reasoning level" })).not.toBeInTheDocument();
  });

  it("enables sends when signed in and renders only advertised reasoning levels", () => {
    const account = openAIAccount();
    useStore.setState({
      sessions: [session({ model: "gpt-live", accountProfileId: account.id })],
      activeId: "a",
      drafts: { a: "ship it" },
      openAIModels: [openAIModel],
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: [openAIModel], error: null },
      },
      settings: {
        ...DEFAULT_SETTINGS,
        provider: "openai",
        model: "gpt-live",
        reasoningEffort: "high",
      },
      openAIAuthStatus: { signedIn: true, expiresAt: null, account: null, tier: null },
    });
    render(<Composer />);

    expect(sendButton()).toBeEnabled();
    const picker = screen.getByRole("button", { name: "Model, effort, and speed" });
    expect(screen.queryByText("Thinking default")).not.toBeInTheDocument();
    expect(picker).toHaveTextContent("Live");
    expect(picker).toHaveTextContent("High");
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("button", { name: /^Effort:/ }));
    expect(screen.getAllByRole("option", { name: /Minimal|High|Ultra/ })).toHaveLength(3);
    expect(screen.getByRole("option", { name: "High" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("option", { name: "Minimal" }));
    expect(m.saveSettings).toHaveBeenCalledWith({ reasoningEffort: "minimal" });
  });

  it("places the multi-account selector beside the model control", () => {
    const first = openAIAccount();
    const second = openAIAccount({
      id: "00000000-0000-4000-8000-000000000002",
      accountLabel: "two@chatgpt.test",
      tier: "ChatGPT Team",
    });
    useStore.setState({
      sessions: [session({ model: "gpt-live", accountProfileId: first.id })],
      activeId: "a",
      openAIModels: [openAIModel],
      openAIAccounts: [first, second],
      openAIModelCatalogs: {
        [first.id]: { status: "ready", models: [openAIModel], error: null },
        [second.id]: { status: "ready", models: [openAIModel], error: null },
      },
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-live" },
    });
    render(<Composer />);

    const controls = screen.getByRole("group", { name: "Turn controls" });
    const modelPicker = screen.getByRole("button", { name: "Model, effort, and speed" });
    const accountPicker = screen.getByRole("combobox", {
      name: "ChatGPT account for this chat",
    });
    expect(controls).toContainElement(modelPicker);
    expect(controls).toContainElement(accountPicker);
    expect(modelPicker.compareDocumentPosition(accountPicker)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(accountPicker).toHaveTextContent("one@chatgpt.test");
    expect(screen.queryByText("Which ChatGPT account owns this conversation?")).toBeNull();
  });

  it("limits a pinned ChatGPT conversation's model picker to that provider", () => {
    const account = openAIAccount();
    useStore.setState({
      sessions: [session({ model: "gpt-live", accountProfileId: account.id })],
      activeId: "a",
      openAIModels: [openAIModel],
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: [openAIModel], error: null },
      },
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-live" },
    });
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "Model, effort, and speed" }));
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));

    expect(screen.getByRole("group", { name: /OpenAI/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "GPT Live" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Anthropic/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Claude/ })).not.toBeInTheDocument();
  });

  it("offers Fast with an explicit speed and usage tradeoff", async () => {
    useStore.setState({
      sessions: [session({ model: "gpt-live" })],
      activeId: "a",
      openAIModels: [openAIModel],
      settings: {
        ...DEFAULT_SETTINGS,
        provider: "openai",
        model: "gpt-live",
        reasoningEffort: "high",
      },
    });
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "Model, effort, and speed" }));
    fireEvent.click(screen.getByRole("button", { name: /^Speed:/ }));
    expect(screen.getByRole("option", { name: /Fast/ })).toHaveTextContent(
      "1.5x speed, more usage",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Fast/ }));
    });
    expect(m.saveSettings).toHaveBeenCalledWith({ responseSpeed: "fast" });
    expect(useStore.getState().settings.responseSpeed).toBe("fast");
    expect(screen.queryByText("Advanced")).not.toBeInTheDocument();
  });

  it("keeps remote sends available because subscription auth lives on the desktop", () => {
    useStore.setState({
      sessions: [session({ model: "gpt-live" })],
      activeId: "a",
      drafts: { a: "remote task" },
      openAIModels: [openAIModel],
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-live" },
      openAIAuthStatus: null,
      remoteMode: true,
      remoteConnected: true,
    });
    render(<Composer />);

    expect(sendButton()).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Model, effort, and speed" })).toBeNull();
    expect(screen.queryByRole("listbox", { name: "Reasoning level" })).toBeNull();
  });

  it("does not bypass authentication while remote mode is disconnected", () => {
    useStore.setState({
      sessions: [session({ model: "gpt-live" })],
      activeId: "a",
      drafts: { a: "remote task" },
      openAIModels: [openAIModel],
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-live" },
      openAIAuthStatus: null,
      remoteMode: true,
      remoteConnected: false,
    });
    render(<Composer />);

    expect(
      screen.getByRole("button", {
        name: "Choose a default ChatGPT account in Settings to send",
      }),
    ).toBeDisabled();
    expect(
      screen
        .getAllByRole("status")
        .some((status) => status.textContent?.includes("Choose a default ChatGPT account")),
    ).toBe(true);
  });

  it("silently assigns the configured default to an unassigned legacy GPT session", async () => {
    const account = openAIAccount();
    const legacy = session({ model: "gpt-live", accountProfileId: null });
    useStore.setState({
      sessions: [legacy],
      activeId: legacy.id,
      openAIModels: [openAIModel],
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: [openAIModel], error: null },
      },
      lastOpenAIAccountProfileId: account.id,
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
      },
    });
    m.pinSessionOpenAIAccount.mockResolvedValue({
      ...legacy,
      accountProfileId: account.id,
    });
    render(<Composer />);

    await waitFor(() => expect(useStore.getState().sessions[0].accountProfileId).toBe(account.id));
    expect(m.pinSessionOpenAIAccount).toHaveBeenCalledWith(legacy.id, account.id, "gpt-live");
    expect(screen.queryByRole("group", { name: "Choose ChatGPT account" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "ChatGPT account for this conversation" }),
    ).not.toBeInTheDocument();
  });

  it("keeps an existing GPT session on its assigned account when the default changes", () => {
    const first = openAIAccount();
    const second = openAIAccount({
      id: "00000000-0000-4000-8000-000000000002",
      accountLabel: "two@chatgpt.test",
      tier: "ChatGPT Team",
    });
    const existing = session({ model: "gpt-live", accountProfileId: first.id });
    useStore.setState({
      sessions: [existing],
      activeId: existing.id,
      openAIModels: [openAIModel],
      openAIAccounts: [first, second],
      openAIModelCatalogs: {
        [first.id]: { status: "ready", models: [openAIModel], error: null },
        [second.id]: { status: "ready", models: [openAIModel], error: null },
      },
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
      },
      lastOpenAIAccountProfileId: second.id,
    });
    render(<Composer />);

    expect(m.pinSessionOpenAIAccount).not.toHaveBeenCalled();
    expect(useStore.getState().sessions[0].accountProfileId).toBe(first.id);
    expect(screen.queryByRole("group", { name: "Choose ChatGPT account" })).not.toBeInTheDocument();
  });

  it("keeps a removed account's session readable without exposing the local UUID", () => {
    const removed = openAIAccount({
      accountLabel: null,
      state: "removed",
      expiresAt: null,
    });
    useStore.setState({
      sessions: [session({ model: "gpt-live", accountProfileId: removed.id })],
      activeId: "a",
      drafts: { a: "history remains" },
      openAIAccounts: [removed],
      openAIAuthStatus: {
        signedIn: false,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
      },
    });
    render(<Composer />);

    expect(screen.getByText("This session's ChatGPT account is unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage ChatGPT" })).toBeInTheDocument();
    expect(screen.queryByText(removed.id)).not.toBeInTheDocument();
    expect(textarea()).toHaveTextContent("history remains");
  });
});
