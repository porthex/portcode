import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { type AgentInfo } from "../types";
import { useStore } from "../store/store";
import { AgentsPanel } from "./AgentsPanel";

// AgentsPanel is a store-driven projection: it reads the active session's
// `agents` list and dispatches `cancelAgent`. We drive the REAL store and mock
// only the IPC layer the store reaches, so a Stop click exercises the real
// action wiring without a backend.
vi.mock("../lib/ipc", () => ({
  cancelAgentById: vi.fn(),
  phoneSyncSendCommand: vi.fn(),
}));

import * as ipc from "../lib/ipc";

const m = vi.mocked(ipc);
const initialState = useStore.getState();

const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "a1",
  description: "audit deps",
  status: "running",
  step: 0,
  ...over,
});

const seed = (agents: AgentInfo[]) => useStore.setState({ activeId: "s1", agents: { s1: agents } });

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initialState, true);
  m.cancelAgentById.mockResolvedValue(undefined);
});

describe("AgentsPanel", () => {
  it("renders nothing when the active session has no subagents", () => {
    useStore.setState({ activeId: "s1", agents: {} });
    const { container } = render(<AgentsPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each subagent with its description and a running step indicator", () => {
    seed([agent({ id: "a1", description: "audit deps", status: "running", step: 3 })]);

    render(<AgentsPanel />);

    // Running agents auto-open the panel so rows are visible.
    expect(screen.getByText("audit deps")).toBeInTheDocument();
    expect(screen.getByText("step 3")).toBeInTheDocument();
    // The header summarizes the running count.
    expect(screen.getByText("1 subagent running")).toBeInTheDocument();
  });

  it("shows 'starting' before the first progress tick", () => {
    seed([agent({ step: 0 })]);
    render(<AgentsPanel />);
    expect(screen.getByText("starting")).toBeInTheDocument();
  });

  it("shows terminal status for finished subagents and offers no Stop", () => {
    seed([
      agent({ id: "ok", description: "done one", status: "ok", step: 5 }),
      agent({ id: "stopped", description: "stopped one", status: "cancelled", step: 2 }),
      agent({ id: "err", description: "broken one", status: "error", step: 1 }),
    ]);

    render(<AgentsPanel />);

    // Status text is always in the DOM (ul stays mounted at height 0 when collapsed).
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText("stopped")).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
    // No agent is running, so no Stop button — only the header toggle button.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute("aria-expanded", "false");
    // Header falls back to a plain count when nothing is running.
    expect(screen.getByText("3 subagents")).toBeInTheDocument();
  });

  it("Stop cancels just that subagent via the per-agent IPC", async () => {
    seed([
      agent({ id: "a1", description: "first", status: "running", step: 1 }),
      agent({ id: "a2", description: "second", status: "running", step: 1 }),
    ]);

    render(<AgentsPanel />);

    // Running agents auto-open the panel, so Stop buttons are visible.
    fireEvent.click(screen.getByRole("button", { name: "Stop subagent: second" }));
    await Promise.resolve();

    expect(m.cancelAgentById).toHaveBeenCalledWith("a2");
    expect(m.cancelAgentById).toHaveBeenCalledTimes(1);
  });

  it("only running subagents get a Stop button (plus the header toggle)", () => {
    seed([
      agent({ id: "run", description: "running one", status: "running", step: 1 }),
      agent({ id: "done", description: "done one", status: "ok", step: 2 }),
    ]);

    render(<AgentsPanel />);

    // Running agent auto-opens, so we see: header toggle + 1 Stop button.
    const buttons = screen.getAllByRole("button");
    // The Stop button for the running agent.
    const stopButtons = buttons.filter((b) => b.getAttribute("aria-label")?.startsWith("Stop"));
    expect(stopButtons).toHaveLength(1);
    expect(stopButtons[0]).toHaveAccessibleName("Stop subagent: running one");
  });

  // ── Collapsible accordion behaviour ─────────────────────────────────────

  it("is collapsed by default when agents exist but none are running", () => {
    seed([agent({ id: "a1", status: "ok", step: 2 })]);

    render(<AgentsPanel />);

    // Match only the header toggle (its name starts with a count, e.g. "1 subagent
    // running" / "3 subagents") — not the per-row "Stop subagent: …" buttons.
    const toggle = screen.getByRole("button", { name: /\d+ subagents?/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("auto-opens when a running agent is present", () => {
    seed([agent({ id: "a1", status: "running", step: 1 })]);

    render(<AgentsPanel />);

    // Match only the header toggle (its name starts with a count, e.g. "1 subagent
    // running" / "3 subagents") — not the per-row "Stop subagent: …" buttons.
    const toggle = screen.getByRole("button", { name: /\d+ subagents?/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("clicking the header toggle expands the collapsed panel", () => {
    seed([agent({ id: "a1", status: "ok", step: 2 })]);

    render(<AgentsPanel />);

    // Match only the header toggle (its name starts with a count, e.g. "1 subagent
    // running" / "3 subagents") — not the per-row "Stop subagent: …" buttons.
    const toggle = screen.getByRole("button", { name: /\d+ subagents?/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("clicking the header toggle again collapses the expanded panel", () => {
    // Start expanded (running agent auto-opens it).
    seed([agent({ id: "a1", status: "running", step: 1 })]);

    render(<AgentsPanel />);

    // Match only the header toggle (its name starts with a count, e.g. "1 subagent
    // running" / "3 subagents") — not the per-row "Stop subagent: …" buttons.
    const toggle = screen.getByRole("button", { name: /\d+ subagents?/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("rows stay mounted in the DOM even when the panel is collapsed (grid-0fr)", () => {
    // Non-running agents → collapsed by default.
    seed([agent({ id: "a1", description: "audit deps", status: "ok", step: 2 })]);

    render(<AgentsPanel />);

    // Match only the header toggle (its name starts with a count, e.g. "1 subagent
    // running" / "3 subagents") — not the per-row "Stop subagent: …" buttons.
    const toggle = screen.getByRole("button", { name: /\d+ subagents?/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Row text still exists in the DOM (height 0, not unmounted).
    expect(screen.getByText("audit deps")).toBeInTheDocument();
  });

  it("chevron reflects open state: ▸ when closed, ▾ when open", () => {
    seed([agent({ id: "a1", status: "ok", step: 2 })]);

    render(<AgentsPanel />);

    // Match only the header toggle (its name starts with a count, e.g. "1 subagent
    // running" / "3 subagents") — not the per-row "Stop subagent: …" buttons.
    const toggle = screen.getByRole("button", { name: /\d+ subagents?/i });
    expect(toggle).toHaveTextContent("▸");

    fireEvent.click(toggle);

    expect(toggle).toHaveTextContent("▾");
  });
});
