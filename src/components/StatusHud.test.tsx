import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { DEFAULT_SETTINGS, type Message, type Session, type Settings, type Usage } from "../types";
import { useStore } from "../store/store";
import { StatusHud } from "./StatusHud";

// StatusHud is a pure projection of store state into the footer bar. We drive
// the REAL store and mock only the IPC layer (imported transitively by the
// store) so no backend is touched. The whole point of this component is that it
// must NOT assert hardcoded/unverifiable facts: the tools segment counts tool
// calls actually made this session, the workspace segment reflects a connected
// folder, and the link segment tracks the live `streaming` flag.
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
}));

const initialState = useStore.getState();

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  title: "Chat",
  workspace: null,
  createdAt: 1,
  updatedAt: 1,
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

    expect(screen.getByText("0 TOOL CALLS")).toBeInTheDocument();
  });

  it("uses the singular label for exactly one tool call", () => {
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      messages: { s1: [toolUseMsg(1)] },
    });

    render(<StatusHud />);

    expect(screen.getByText("1 TOOL CALL")).toBeInTheDocument();
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

    expect(screen.getByText("3 TOOL CALLS")).toBeInTheDocument();
  });

  it("falls back to zero tool calls when the active session has no message entry", () => {
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      messages: {},
    });

    render(<StatusHud />);

    expect(screen.getByText("0 TOOL CALLS")).toBeInTheDocument();
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

  it("renders the model and policy from settings", () => {
    useStore.setState({
      sessions: [session()],
      activeId: "s1",
      settings: settings({ model: "claude-sonnet-4-6", defaultPolicy: "deny" }),
    });

    render(<StatusHud />);

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
    expect(screen.queryByText(/TOOL CALL/)).not.toBeInTheDocument();
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
});
