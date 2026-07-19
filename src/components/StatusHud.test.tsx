import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import {
  DEFAULT_SETTINGS,
  type Message,
  type PlanUsageSnapshot,
  type ProviderId,
  type Session,
  type Settings,
  type Usage,
} from "../types";
import { useStore } from "../store/store";
import { StatusHud } from "./StatusHud";

// StatusHud is a pure projection of store state into the footer bar. We drive
// the REAL store and mock only the IPC layer (imported transitively by the
// store) so no backend is touched. The whole point of this component is that it
// must NOT assert hardcoded/unverifiable facts: the tools segment counts tool
// calls actually made this session, the workspace segment reflects a connected
// folder, and the link segment tracks the live `streaming` flag.
const getPlanUsage = vi.hoisted(() => vi.fn());

vi.mock("../lib/ipc", () => ({
  getSettings: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  getMessages: vi.fn(),
  deleteSession: vi.fn(),
  saveSettings: vi.fn(),
  resolvePermission: vi.fn(),
  openFolder: vi.fn(),
  runAgent: vi.fn(),
  getPlanUsage,
}));

const initialState = useStore.getState();

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  title: "Chat",
  workspace: null,
  model: "claude-opus-4-8",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const run = (
  over: Partial<(typeof initialState.runs)[string]> = {},
): (typeof initialState.runs)[string] => ({
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

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  ...over,
});

const toolUseMsg = (count: number): Message => ({
  id: "m-tools",
  role: "assistant",
  blocks: Array.from({ length: count }, (_, i) => ({
    kind: "tool_use" as const,
    id: `t${i}`,
    name: "fs.read",
    input: {},
  })),
  createdAt: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  // zustand has no built-in reset; restore the pristine snapshot each test.
  useStore.setState(initialState, true);
});

describe("StatusHud", () => {
  it("shows LOCAL when no workspace is connected and never claims GRAPHIFY READY", () => {
    useStore.setState({ sessions: [session({ workspace: null })], activeId: "s1" });

    render(<StatusHud />);

    expect(screen.getByText(/WORKSPACE LOCAL/)).toBeInTheDocument();
    // The old hardcoded/unverifiable claims must be gone.
    expect(screen.queryByText(/GRAPHIFY READY/)).not.toBeInTheDocument();
    expect(screen.queryByText(/SANDBOXED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/7 TOOLS/)).not.toBeInTheDocument();
  });

  it("shows LINKED when a workspace folder is connected", () => {
    useStore.setState({
      sessions: [session({ workspace: "C:/dev/porthex/portcode" })],
      activeId: "s1",
    });

    render(<StatusHud />);

    expect(screen.getByText(/WORKSPACE LINKED/)).toBeInTheDocument();
    // The branch segment surfaces the last path segment of the workspace.
    expect(screen.getByText(/portcode/)).toBeInTheDocument();
  });

  it("counts zero tool calls for a fresh session", () => {
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      messages: { s1: [] },
    });

    render(<StatusHud />);

    expect(screen.getByText("0 ACTIONS")).toBeInTheDocument();
  });

  it("uses the singular label for exactly one tool call", () => {
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      messages: { s1: [toolUseMsg(1)] },
    });

    render(<StatusHud />);

    expect(screen.getByText("1 ACTION")).toBeInTheDocument();
  });

  it("counts tool_use blocks across the active session's messages", () => {
    const userMsg: Message = {
      id: "u1",
      role: "user",
      blocks: [{ kind: "text", text: "hi" }],
      createdAt: 1,
    };
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      messages: { s1: [userMsg, toolUseMsg(2), toolUseMsg(1)] },
    });

    render(<StatusHud />);

    expect(screen.getByText("3 ACTIONS")).toBeInTheDocument();
  });

  it("does not rescan stable historical blocks when a new transcript array arrives", () => {
    let scans = 0;
    const blocks = new Proxy(toolUseMsg(2).blocks, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) scans += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const historical: Message = { ...toolUseMsg(2), id: "cached", blocks };
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      messages: { s1: [historical] },
    });
    render(<StatusHud />);
    expect(scans).toBe(1);

    // Streaming replaces the outer session array but preserves historical
    // Message objects. Their block trees should stay cached.
    useStore.setState({ messages: { s1: [historical] } });
    expect(scans).toBe(1);
  });

  it("falls back to zero tool calls when the active session has no message entry", () => {
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      messages: {},
    });

    render(<StatusHud />);

    expect(screen.getByText("0 ACTIONS")).toBeInTheDocument();
  });

  it("reflects the live streaming flag in the link segment", () => {
    useStore.setState({ sessions: [session()], activeId: "s1", streaming: true });
    const live = render(<StatusHud />);
    expect(live.getByText(/LIVE/)).toBeInTheDocument();
    expect(live.queryByText(/IDLE/)).not.toBeInTheDocument();

    useStore.setState({ streaming: false });
    live.rerender(<StatusHud />);
    expect(live.getByText(/IDLE/)).toBeInTheDocument();
    expect(live.queryByText(/LIVE/)).not.toBeInTheDocument();
  });

  it("reports the total live-run count across selected and background sessions", () => {
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      runs: {
        a: run({ streaming: true }),
        b: run({ streaming: true, finalizing: true }),
      },
    });

    render(<StatusHud />);
    expect(screen.getByText(/NEURAL LINK · 2 LIVE/)).toBeInTheDocument();
  });

  it("gives the link dot a stronger ring pulse while streaming, success when idle", () => {
    useStore.setState({ sessions: [session()], activeId: "s1", streaming: true });
    const { container, rerender } = render(<StatusHud />);

    // The dot lives in the NEURAL LINK segment (the last right segment).
    const liveDot = container.querySelector(".pc-hud-seg--right:last-child .pc-dot");
    expect(liveDot).not.toBeNull();
    expect(liveDot).toHaveClass("pc-dot--ring");
    expect(liveDot).not.toHaveClass("pc-dot--success");
    // Decorative — never voiced by a screen reader.
    expect(liveDot).toHaveAttribute("aria-hidden", "true");

    useStore.setState({ streaming: false });
    rerender(<StatusHud />);
    const idleDot = container.querySelector(".pc-hud-seg--right:last-child .pc-dot");
    expect(idleDot).toHaveClass("pc-dot--success");
    expect(idleDot).not.toHaveClass("pc-dot--ring");
  });

  it("renders the active session's model and the policy from settings", () => {
    useStore.setState({
      sessions: [session({ model: "claude-sonnet-4-6" })],
      activeId: "s1",
      settings: settings({ defaultPolicy: "deny" }),
    });

    render(<StatusHud />);

    // The model segment now reads the ACTIVE SESSION's model, not settings.model.
    expect(screen.getByText("SONNET 4.6")).toBeInTheDocument();
    expect(screen.getByText("POLICY: DENY")).toBeInTheDocument();
  });

  it("shows the permission MODE (not the legacy policy) when a non-default mode is active", () => {
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      settings: settings({ permissionMode: "acceptEdits" }),
    });

    render(<StatusHud />);

    expect(screen.getByText("MODE: ACCEPTEDITS")).toBeInTheDocument();
    expect(screen.queryByText(/POLICY:/)).not.toBeInTheDocument();
  });

  it("flags a loosened auto/bypass mode with a danger style and warning glyph", () => {
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      settings: settings({ permissionMode: "bypass" }),
    });

    render(<StatusHud />);

    const seg = screen.getByText(/MODE: BYPASS/);
    expect(seg.textContent).toContain("⚠");
    expect(seg).toHaveClass("text-danger");
  });

  it("trims the desktop-dense segments on the phone (remote mode)", () => {
    useStore.setState({
      sessions: [session({ workspace: "C:/dev/porthex/portcode" })],
      activeId: "s1",
      remoteMode: true,
    });

    render(<StatusHud />);

    // Essentials stay; the desktop-only / overflow-prone segments are dropped so
    // the 7-segment bar fits a narrow screen.
    expect(screen.getByText(/NEURAL LINK/)).toBeInTheDocument();
    expect(screen.queryByText(/POLICY:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/WORKSPACE LINKED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ACTIONS?/)).not.toBeInTheDocument();
  });

  it("renders cumulative token usage for the active session", () => {
    const usage: Usage = { input: 1200, output: 340 };
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      usage: { s1: usage },
    });

    render(<StatusHud />);

    expect(screen.getByText(`${(1540).toLocaleString()} tok`)).toBeInTheDocument();
  });

  it("opens a one-click plan-usage popover and restores focus on Escape", async () => {
    useStore.setState({
      sessions: [session({ model: "gpt-5.6-sol" })],
      activeId: "s1",
      oauthStatus: {
        signedIn: true,
        expiresAt: null,
        account: "claude@example.com",
        tier: "Claude Max",
      },
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: "gpt@example.com",
        tier: "ChatGPT Plus",
      },
    });
    getPlanUsage.mockImplementation(async (provider: ProviderId): Promise<PlanUsageSnapshot> => ({
      provider,
      plan: provider === "openai" ? "Plus" : "Max",
      updatedAt: Math.floor(Date.now() / 1000),
      windows: [
        {
          id: "session",
          label: "Current session",
          usedPercent: provider === "openai" ? 20 : 35,
          resetsAt: String(Math.floor(Date.now() / 1000) + 60 * 60),
          windowMinutes: 300,
        },
      ],
    }));

    render(<StatusHud />);
    const trigger = await screen.findByRole("button", {
      name: "Plan usage, 80% remaining, connected for this GPT chat",
    });
    expect(trigger).toHaveTextContent(/USAGE\s*80%/);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);

    expect(screen.getByRole("dialog", { name: "Plan usage quick view" })).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const gptCard = screen.getByRole("article", { name: "GPT plan usage" });
    expect(screen.queryByRole("article", { name: "Claude plan usage" })).not.toBeInTheDocument();
    expect(screen.getByText("OPENAI · GPT")).toBeInTheDocument();
    expect(
      await within(gptCard).findByRole("progressbar", { name: "Current session remaining" }),
    ).toHaveAttribute("aria-valuenow", "80");
    expect(getPlanUsage.mock.calls.every(([provider]) => provider === "openai")).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Plan usage quick view" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("opens the detailed Settings usage section from the quick view", () => {
    useStore.setState({ sessions: [session()], activeId: "s1", showSettings: false });
    render(<StatusHud />);

    fireEvent.click(screen.getByRole("button", { name: /Plan usage,/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open detailed usage in Settings →" }));

    expect(useStore.getState().showSettings).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Plan usage quick view" })).not.toBeInTheDocument();
  });

  it("shows a running-subagents count only while subagents are running", () => {
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      agents: {
        s1: [
          { id: "a1", description: "x", status: "running", step: 1 },
          { id: "a2", description: "y", status: "running", step: 2 },
          { id: "a3", description: "z", status: "ok", step: 4 }, // finished — not counted
        ],
      },
    });

    render(<StatusHud />);
    expect(screen.getByText("2 AGENTS")).toBeInTheDocument();
  });

  it("omits the subagents segment when none are running", () => {
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      agents: { s1: [{ id: "a1", description: "x", status: "ok", step: 3 }] },
    });

    render(<StatusHud />);
    expect(screen.queryByText(/AGENT/)).not.toBeInTheDocument();
  });

  it("shows a running-background-tasks count only while tasks are running", () => {
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      backgroundTasks: {
        s1: [
          { id: "t1", command: "npm run dev", status: "running" },
          { id: "t2", command: "make build", status: "error", exitCode: 1 }, // finished — not counted
        ],
      },
    });

    render(<StatusHud />);
    expect(screen.getByText("1 BG TASK")).toBeInTheDocument();
  });

  it("omits the background-tasks segment when none are running", () => {
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      backgroundTasks: { s1: [{ id: "t1", command: "build", status: "ok", exitCode: 0 }] },
    });

    render(<StatusHud />);
    expect(screen.queryByText(/BG TASK/)).not.toBeInTheDocument();
  });

  it("prices each Anthropic session with its own model and excludes GPT usage", () => {
    useStore.setState({
      sessions: [
        session({ id: "s1", model: "gpt-5.6-sol" }),
        session({ id: "s2", model: "claude-opus-4-8" }),
        session({ id: "s3", model: "claude-sonnet-4-6" }),
      ],
      activeId: "s1",
      usage: {
        s1: { input: 1_000_000, output: 0 },
        s2: { input: 1_000_000, output: 0 },
        s3: { input: 1_000_000, output: 0 },
      },
    });

    render(<StatusHud />);

    // GPT subscription usage is excluded; Opus input is $5/M and Sonnet is $3/M.
    expect(screen.getByText("Σ $8.00")).toBeInTheDocument();
  });

  it("omits the spend segment when nothing has been spent", () => {
    useStore.setState({ sessions: [session()], activeId: "s1" });
    render(<StatusHud />);
    expect(screen.queryByText(/^Σ /)).toBeNull();
  });

  it("uses live OpenAI labels and never claims API-priced subscription spend", () => {
    useStore.setState({
      sessions: [session({ model: "gpt-live" })],
      activeId: "s1",
      openAIModels: [
        {
          id: "gpt-live",
          label: "GPT Live Codex",
          provider: "openai",
          reasoningEfforts: ["high"],
          defaultReasoningEffort: "high",
        },
      ],
      usage: { s1: { input: 50_000, output: 10_000 } },
    });

    const { container } = render(<StatusHud />);

    expect(screen.getByText("GPT LIVE CODEX")).toBeInTheDocument();
    expect(container.textContent).not.toContain("$");
  });

  it("drops the spend segment on the phone (remote mode) to fit a narrow bar", () => {
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      remoteMode: true,
      usage: { s1: { input: 5000, output: 1000 } },
    });
    render(<StatusHud />);
    expect(screen.queryByText(/^Σ /)).toBeNull();
    expect(screen.queryByRole("button", { name: /Plan usage,/ })).not.toBeInTheDocument();
  });
});
