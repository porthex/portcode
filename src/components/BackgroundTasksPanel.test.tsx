import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { type BackgroundTaskInfo } from "../types";
import { useStore } from "../store/store";
import { BackgroundTasksPanel } from "./BackgroundTasksPanel";

// BackgroundTasksPanel is a pure store-driven projection (display-only — no action
// dispatch), so it reaches no IPC. We drive the REAL store via setState and mock
// the ipc module only so the store can import without a backend.
vi.mock("../lib/ipc", () => ({}));

const initialState = useStore.getState();

const task = (over: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo => ({
  id: "t1",
  command: "npm run dev",
  status: "running",
  ...over,
});

const seed = (tasks: BackgroundTaskInfo[]) =>
  useStore.setState({ activeId: "s1", backgroundTasks: { s1: tasks } });

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initialState, true);
});

describe("BackgroundTasksPanel", () => {
  it("renders nothing when the active session launched no background tasks", () => {
    useStore.setState({ activeId: "s1", backgroundTasks: {} });
    const { container } = render(<BackgroundTasksPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists a running task with its command and a running indicator", () => {
    seed([task({ id: "t1", command: "npm run dev", status: "running" })]);

    render(<BackgroundTasksPanel />);

    expect(screen.getByText("npm run dev")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    // The header summarizes the running count.
    expect(screen.getByText("1 background task running")).toBeInTheDocument();
  });

  it("shows a finished-ok task as done and a failed task with its exit code", () => {
    seed([
      task({ id: "ok", command: "build", status: "ok", exitCode: 0, output: "built" }),
      task({ id: "bad", command: "make", status: "error", exitCode: 2, output: "boom" }),
    ]);

    render(<BackgroundTasksPanel />);

    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText("exit 2")).toBeInTheDocument();
    // Nothing running → the header falls back to a plain count.
    expect(screen.getByText("2 background tasks")).toBeInTheDocument();
  });

  it("exposes the captured output via the row's title for hover inspection", () => {
    seed([task({ id: "ok", command: "build", status: "ok", exitCode: 0, output: "built fine" })]);

    render(<BackgroundTasksPanel />);

    expect(screen.getByText("build")).toHaveAttribute("title", "build\n\nbuilt fine");
  });

  it("titles a running task with just its command (no output yet)", () => {
    seed([task({ id: "t1", command: "npm run dev", status: "running" })]);

    render(<BackgroundTasksPanel />);

    expect(screen.getByText("npm run dev")).toHaveAttribute("title", "npm run dev");
  });
});
