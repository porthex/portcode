import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";

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

afterEach(() => {
  vi.useRealTimers();
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
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("stopped")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
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

  it("shows immediate stopping feedback and disables duplicate Stop requests", async () => {
    let resolveCancel!: () => void;
    m.cancelAgentById.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCancel = resolve;
      }),
    );
    seed([agent({ id: "a1", description: "slow worker", step: 2 })]);

    render(<AgentsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Stop subagent: slow worker" }));

    const stopping = screen.getByRole("button", { name: "Stopping subagent: slow worker" });
    expect(stopping).toBeDisabled();
    expect(stopping).toHaveTextContent("Stopping…");
    fireEvent.click(stopping);
    expect(m.cancelAgentById).toHaveBeenCalledTimes(1);

    resolveCancel();
    await waitFor(() => expect(m.cancelAgentById).toHaveBeenCalledTimes(1));
  });

  it("offers a retry when a Stop request rejects", async () => {
    const cancelAgent = vi.fn().mockRejectedValue(new Error("offline"));
    useStore.setState({ cancelAgent });
    seed([agent({ id: "a1", description: "remote worker", step: 2 })]);

    render(<AgentsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Stop subagent: remote worker" }));

    const retry = await screen.findByRole("button", {
      name: "Retry stop subagent: remote worker",
    });
    expect(retry).toBeEnabled();
    expect(retry).toHaveAttribute("title", "Stop was not confirmed. Try again.");
  });

  it("restores the Stop affordance when cancellation is not acknowledged", async () => {
    vi.useFakeTimers();
    seed([agent({ id: "a1", description: "quiet worker", step: 2 })]);

    render(<AgentsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Stop subagent: quiet worker" }));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(screen.getByRole("button", { name: "Retry stop subagent: quiet worker" })).toBeEnabled();
    expect(screen.getByText("still running")).toBeInTheDocument();
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

  it("renders parentId relationships as nested, labelled subagent lists", () => {
    seed([
      agent({ id: "plan", description: "plan the work", status: "running", step: 1 }),
      agent({ id: "code", parentId: "plan", description: "implement UI", step: 2 }),
      agent({ id: "test", parentId: "code", description: "verify UI", step: 1 }),
      agent({ id: "orphan", parentId: "missing", description: "orphaned task", step: 1 }),
    ]);

    render(<AgentsPanel />);

    const planChildren = screen.getByRole("list", { name: "Subagents of plan the work" });
    expect(within(planChildren).getByText("implement UI")).toBeInTheDocument();
    const codeChildren = screen.getByRole("list", { name: "Subagents of implement UI" });
    expect(within(codeChildren).getByText("verify UI")).toBeInTheDocument();

    // Missing parents never make work disappear; the orphan is promoted to a
    // root in the activity list.
    expect(screen.getByText("orphaned task")).toBeInTheDocument();
  });

  it("surfaces malformed parent cycles once instead of recursing forever", () => {
    seed([
      agent({ id: "a", parentId: "b", description: "cycle A", step: 1 }),
      agent({ id: "b", parentId: "a", description: "cycle B", step: 1 }),
    ]);

    render(<AgentsPanel />);

    expect(screen.getAllByText("cycle A")).toHaveLength(1);
    expect(screen.getAllByText("cycle B")).toHaveLength(1);
    expect(screen.getByRole("list", { name: "Subagents of cycle A" })).toBeInTheDocument();
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

  it("respects a manual collapse when another sibling starts running", () => {
    seed([agent({ id: "a1", description: "first", status: "running", step: 1 })]);
    render(<AgentsPanel />);

    const toggle = screen.getByRole("button", { name: /1 subagent running/i });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    act(() => {
      seed([
        agent({ id: "a1", description: "first", status: "running", step: 2 }),
        agent({ id: "a2", description: "second", status: "running", step: 1 }),
      ]);
    });

    expect(screen.getByRole("button", { name: /2 subagents running/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
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
