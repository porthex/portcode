import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, type AgentInfo, type WorkspaceSummary } from "../types";
import { useStore } from "../store/store";
import { EnvironmentPanel } from "./EnvironmentPanel";

vi.mock("../lib/ipc", () => ({
  getWorkspaceSummary: vi.fn(),
}));

import * as ipc from "../lib/ipc";

const m = vi.mocked(ipc);
const initialState = useStore.getState();

const repositorySummary = (
  overrides: Partial<Extract<WorkspaceSummary["git"], { kind: "repository" }>> = {},
): WorkspaceSummary => ({
  path: "D:\\Projects\\portcode",
  configured: true,
  git: {
    kind: "repository",
    branch: "main",
    detachedHead: null,
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
    changedFiles: 58,
    untrackedFiles: 3,
    additions: 6_342,
    deletions: 718,
    ...overrides,
  },
});

const agent = (id: string, overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  description: id,
  status: "running",
  step: 1,
  ...overrides,
});

function seed(agents: AgentInfo[] = [agent("Map OAuth flow", { step: 4 })]) {
  useStore.setState({
    activeId: "s1",
    agents: { s1: agents },
    settings: { ...DEFAULT_SETTINGS, workspace: "D:\\Projects\\portcode" },
  });
}

async function openPanel() {
  const trigger = await screen.findByRole("button", { name: /Environment and agents/ });
  fireEvent.click(trigger);
  return screen.getByRole("region", { name: "Environment and agents" });
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initialState, true);
  seed();
  m.getWorkspaceSummary.mockResolvedValue(repositorySummary());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EnvironmentPanel", () => {
  it("shows compact workspace facts and remains read-only", async () => {
    render(<EnvironmentPanel />);
    const panel = await openPanel();

    expect(within(panel).getByText("58 changed files · 3 untracked")).toBeInTheDocument();
    expect(within(panel).getByText("+6,342")).toBeInTheDocument();
    expect(within(panel).getByText("−718")).toBeInTheDocument();
    expect(within(panel).getByText("origin/main · ↑2 ↓1")).toBeInTheDocument();
    expect(within(panel).getByText("D:\\Projects\\portcode")).toHaveAttribute(
      "title",
      "D:\\Projects\\portcode",
    );
    expect(
      within(panel).queryByRole("button", { name: /stop|commit|push|pull request/i }),
    ).toBeNull();
  });

  it("opens the full review workspace from the Changes fact", async () => {
    render(<EnvironmentPanel />);
    const panel = await openPanel();

    fireEvent.click(within(panel).getByRole("button", { name: /Review changes/ }));

    expect(useStore.getState().workspaceSurface).toBe("review");
    expect(screen.queryByRole("region", { name: "Environment and agents" })).toBeNull();
  });

  it("settles workspace loading after React Strict Mode replays effects", async () => {
    render(
      <StrictMode>
        <EnvironmentPanel />
      </StrictMode>,
    );
    const panel = await openPanel();

    await waitFor(() => expect(within(panel).queryByText("Reading workspace…")).toBeNull());
    expect(within(panel).getByText("58 changed files · 3 untracked")).toBeInTheDocument();
  });

  it("keeps 20 live agents in a bounded scroll region with root/child context", async () => {
    const agents = Array.from({ length: 5 }, (_, root) => [
      agent(`Root task ${root + 1}`, { step: root + 1 }),
      ...Array.from({ length: 3 }, (_, child) =>
        agent(`Child task ${root + 1}.${child + 1}`, {
          parentId: `Root task ${root + 1}`,
          step: child + 1,
        }),
      ),
    ]).flat();
    seed(agents);

    render(<EnvironmentPanel />);
    const panel = await openPanel();
    const activity = within(panel).getByRole("list", { name: "Agent activity" });

    expect(activity).toHaveClass("max-h-[238px]", "overflow-y-auto");
    expect(within(activity).getAllByRole("group", { name: /, Step \d+$/ })).toHaveLength(20);
    expect(within(panel).getByText("5 root · 15 child")).toBeInTheDocument();
    expect(within(panel).getByText("20 running")).toBeInTheDocument();
  });

  it("keeps a 500-agent swarm inside the same bounded activity viewport", async () => {
    seed(
      Array.from({ length: 500 }, (_, index) =>
        agent(`Swarm task ${index + 1}`, { step: (index % 9) + 1 }),
      ),
    );

    render(<EnvironmentPanel />);
    const panel = await openPanel();
    const activity = within(panel).getByRole("list", { name: "Agent activity" });

    expect(activity).toHaveClass("max-h-[238px]", "overflow-y-auto");
    expect(
      within(activity).getAllByRole("group", { name: /Swarm task \d+, Step \d+$/ }),
    ).toHaveLength(500);
    expect(within(panel).getByText("500 root · 0 child")).toBeInTheDocument();
    expect(within(panel).getByText("500 running")).toBeInTheDocument();
  });

  it("summarizes successful/stopped work while failed branches remain visible", async () => {
    seed([
      agent("active"),
      agent("finished", { status: "ok", step: 3 }),
      agent("stopped", { status: "cancelled", step: 2 }),
      agent("broken", { status: "error", step: 1 }),
    ]);

    render(<EnvironmentPanel />);
    const panel = await openPanel();

    expect(within(panel).getByText("broken")).toBeInTheDocument();
    expect(within(panel).queryByText("finished")).toBeNull();
    expect(within(panel).queryByText("stopped")).toBeNull();
    expect(within(panel).getByText("1 failed")).toBeInTheDocument();
    expect(within(panel).getByText("2 done")).toBeInTheDocument();

    const disclosure = within(panel).getByRole("button", { name: /Show finished agents/ });
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getByText("finished")).toBeInTheDocument();
    expect(within(panel).getByText("stopped")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: /Hide finished agents/ }));
    expect(within(panel).queryByText("finished")).toBeNull();
  });

  it("does not offer a no-op finished disclosure for an ancestor of live work", async () => {
    seed([
      agent("finished root", { status: "ok" }),
      agent("live child", { parentId: "finished root" }),
    ]);

    render(<EnvironmentPanel />);
    const panel = await openPanel();

    expect(within(panel).getByText("finished root")).toBeInTheDocument();
    expect(within(panel).getByText("live child")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /finished agents/i })).toBeNull();
  });

  it("announces mixed swarm status atomically and exposes both counts on the trigger", async () => {
    seed([agent("active"), agent("broken", { status: "error" })]);
    render(<EnvironmentPanel />);

    const trigger = await screen.findByRole("button", {
      name: /Environment and agents, main, 1 running, 1 failed/,
    });
    fireEvent.click(trigger);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status).toHaveTextContent("1 running");
    expect(status).toHaveTextContent("1 failed");
    expect(status).toHaveTextContent("0 done");
    expect(screen.getByText(/Refreshing…|Live/)).not.toHaveAttribute("aria-live");
  });

  it("shows an honest empty state for sessions without agents", async () => {
    seed([]);
    render(<EnvironmentPanel />);

    const panel = await openPanel();
    expect(within(panel).getByText("No subagents in this session")).toBeInTheDocument();
    expect(within(panel).getByText("0 root · 0 child")).toBeInTheDocument();
  });

  it("stays docked on outside press and restores trigger focus on Escape/close", async () => {
    render(<EnvironmentPanel />);
    const trigger = screen.getByRole("button", { name: /Environment and agents/ });
    await openPanel();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Environment and agents" })).toBeNull();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("region", { name: "Environment and agents" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close environment and agents" }));
    expect(screen.queryByRole("region", { name: "Environment and agents" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("moves keyboard-open focus into the dock", async () => {
    render(<EnvironmentPanel />);
    const trigger = screen.getByRole("button", { name: /Environment and agents/ });
    trigger.focus();

    fireEvent.click(trigger, { detail: 0 });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close environment and agents" })).toHaveFocus(),
    );
  });

  it("closes when a modal opens or the active session changes", async () => {
    render(<EnvironmentPanel />);
    const trigger = screen.getByRole("button", { name: /Environment and agents/ });
    await openPanel();

    act(() => useStore.setState({ showPalette: true }));
    expect(screen.queryByRole("region", { name: "Environment and agents" })).toBeNull();

    act(() => useStore.setState({ showPalette: false }));
    fireEvent.click(trigger);
    const close = screen.getByRole("button", { name: "Close environment and agents" });
    close.focus();
    act(() => useStore.setState({ activeId: "s2", agents: { s1: [], s2: [] } }));
    expect(screen.queryByRole("region", { name: "Environment and agents" })).toBeNull();
    expect(trigger).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: /Environment and agents/ }));
    act(() => useStore.setState({ showSettings: true }));
    expect(screen.queryByRole("region", { name: "Environment and agents" })).toBeNull();
  });

  it("degrades cleanly for non-repositories, detached HEAD, and IPC failures", async () => {
    m.getWorkspaceSummary.mockResolvedValueOnce({
      path: "C:\\scratch",
      configured: true,
      git: { kind: "notRepository" },
    });
    const first = render(<EnvironmentPanel />);
    let panel = await openPanel();
    expect(within(panel).getAllByText("No Git repository")).toHaveLength(2);
    first.unmount();

    m.getWorkspaceSummary.mockResolvedValue(
      repositorySummary({
        branch: null,
        detachedHead: "abc12345",
        upstream: null,
        ahead: 0,
        behind: 0,
      }),
    );
    render(<EnvironmentPanel />);
    panel = await openPanel();
    expect(within(panel).getByText("Detached abc12345")).toBeInTheDocument();
    expect(within(panel).getByText("No upstream")).toBeInTheDocument();
  });

  it("keeps the last useful path visible when the native refresh rejects", async () => {
    m.getWorkspaceSummary.mockRejectedValue(new Error("bridge unavailable"));
    render(<EnvironmentPanel />);

    const panel = await openPanel();
    await waitFor(() =>
      expect(within(panel).getAllByText("Git status unavailable")).toHaveLength(2),
    );
    expect(within(panel).getByText("D:\\Projects\\portcode")).toBeInTheDocument();
  });

  it("queues a fresh workspace request and ignores the superseded response", async () => {
    let resolveOld!: (summary: WorkspaceSummary) => void;
    const oldRequest = new Promise<WorkspaceSummary>((resolve) => {
      resolveOld = resolve;
    });
    m.getWorkspaceSummary.mockReturnValueOnce(oldRequest).mockResolvedValueOnce({
      path: "D:\\Projects\\next",
      configured: true,
      git: { kind: "notRepository" },
    });

    render(<EnvironmentPanel />);
    act(() => {
      useStore.setState({
        settings: { ...useStore.getState().settings, workspace: "D:\\Projects\\next" },
      });
    });
    resolveOld(repositorySummary({ branch: "stale" }));

    await waitFor(() => expect(m.getWorkspaceSummary).toHaveBeenCalledTimes(2));
    const panel = await openPanel();
    expect(within(panel).getByText("D:\\Projects\\next")).toBeInTheDocument();
    expect(within(panel).queryByText("stale")).toBeNull();
  });

  it("keeps the active poll valid and coalesces repeated ticks into one follow-up", async () => {
    let resolveFirst!: (summary: WorkspaceSummary) => void;
    let resolveSecond!: (summary: WorkspaceSummary) => void;
    m.getWorkspaceSummary
      .mockReturnValueOnce(
        new Promise<WorkspaceSummary>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<WorkspaceSummary>((resolve) => {
          resolveSecond = resolve;
        }),
      );

    render(<EnvironmentPanel />);
    await waitFor(() => expect(m.getWorkspaceSummary).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /Environment and agents/ }));
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(m.getWorkspaceSummary).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(repositorySummary({ branch: "first-result" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(m.getWorkspaceSummary).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("button", { name: /Environment and agents, first-result/ }),
    ).toBeInTheDocument();

    await act(async () => {
      resolveSecond(repositorySummary({ branch: "follow-up" }));
      await Promise.resolve();
    });
    expect(
      await screen.findByRole("button", { name: /Environment and agents, follow-up/ }),
    ).toBeInTheDocument();
  });

  it("invalidates an active poll on unmount without starting its queued follow-up", async () => {
    let resolveRequest!: (summary: WorkspaceSummary) => void;
    m.getWorkspaceSummary.mockReturnValueOnce(
      new Promise<WorkspaceSummary>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const view = render(<EnvironmentPanel />);
    await waitFor(() => expect(m.getWorkspaceSummary).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /Environment and agents/ }));
    view.unmount();

    await act(async () => {
      resolveRequest(repositorySummary({ branch: "too-late" }));
      await Promise.resolve();
    });
    expect(m.getWorkspaceSummary).toHaveBeenCalledTimes(1);
  });

  it("refreshes on focus, turn completion, and the open-panel interval", async () => {
    vi.useFakeTimers();
    render(<EnvironmentPanel />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: /Environment and agents/ }));
    await act(async () => Promise.resolve());
    const afterOpen = m.getWorkspaceSummary.mock.calls.length;

    act(() => window.dispatchEvent(new Event("focus")));
    await act(async () => Promise.resolve());
    expect(m.getWorkspaceSummary.mock.calls.length).toBeGreaterThan(afterOpen);

    act(() => useStore.setState({ streaming: true }));
    act(() => useStore.setState({ streaming: false }));
    await act(async () => Promise.resolve());
    const afterTurn = m.getWorkspaceSummary.mock.calls.length;

    act(() => vi.advanceTimersByTime(5_000));
    await act(async () => Promise.resolve());
    expect(m.getWorkspaceSummary.mock.calls.length).toBeGreaterThan(afterTurn);
  });
});
