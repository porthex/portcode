import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { CommandPalette } from "./CommandPalette";
import { useStore } from "../store/store";
import { DEFAULT_SETTINGS, MODELS } from "../types";

// The palette is a thin keyboard-driven view over the real store: each command
// dispatches a store action, some of which reach the IPC bridge (newSession ->
// createSession, openWorkspace -> openFolder, updateSettings -> saveSettings).
// We mock the IPC module exactly as the store suite does (TDD London) so the
// tests assert real store-state transitions and the exact IPC calls fired,
// never a backend. The store itself is left real.
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

import * as ipc from "../lib/ipc";

const m = vi.mocked(ipc);
const initialState = useStore.getState();

// Fixed (non-model) command count, see CommandPalette.tsx.
const FIXED_COMMANDS = 4;
const TOTAL_COMMANDS = FIXED_COMMANDS + MODELS.length;

const open = () => useStore.setState({ showPalette: true });
const input = () => screen.getByPlaceholderText("Type a command…") as HTMLInputElement;
const commandButtons = () => screen.queryAllByRole("button").filter((b) => b.querySelector("span"));

beforeEach(() => {
  vi.clearAllMocks();
  // zustand has no reset; restore a pristine store between tests.
  useStore.setState(initialState, true);

  m.getSettings.mockResolvedValue(DEFAULT_SETTINGS);
  m.listSessions.mockResolvedValue([]);
  m.getMessages.mockResolvedValue([]);
  m.createSession.mockResolvedValue(undefined);
  m.deleteSession.mockResolvedValue(undefined);
  m.saveSettings.mockImplementation(async (s) => ({ ...DEFAULT_SETTINGS, ...s }));
  m.resolvePermission.mockResolvedValue(undefined);
  m.openFolder.mockResolvedValue(null);
  m.runAgent.mockResolvedValue({ cancel: vi.fn(async () => {}) });
});

describe("visibility", () => {
  it("renders nothing while the palette is closed", () => {
    const { container } = render(<CommandPalette />);
    expect(useStore.getState().showPalette).toBe(false);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByPlaceholderText("Type a command…")).toBeNull();
  });

  it("renders the input and the full command list when open", () => {
    open();
    render(<CommandPalette />);

    expect(input()).toBeInTheDocument();
    expect(commandButtons()).toHaveLength(TOTAL_COMMANDS);
    expect(screen.getByText("New chat")).toBeInTheDocument();
    expect(screen.getByText("Model: Claude Opus 4.8")).toBeInTheDocument();
    // hint labels render for commands that declare one
    expect(screen.getByText("Ctrl+N")).toBeInTheDocument();
  });
});

describe("filtering", () => {
  it("narrows the list as the query is typed (case-insensitive, label match)", () => {
    open();
    render(<CommandPalette />);

    fireEvent.change(input(), { target: { value: "model" } });

    const buttons = commandButtons();
    expect(buttons).toHaveLength(MODELS.length);
    expect(screen.getByText("Model: Claude Sonnet 4.6")).toBeInTheDocument();
    expect(screen.queryByText("New chat")).toBeNull();
  });

  it("trims/ignores whitespace-only queries and shows everything", () => {
    open();
    render(<CommandPalette />);

    fireEvent.change(input(), { target: { value: "   " } });

    expect(commandButtons()).toHaveLength(TOTAL_COMMANDS);
  });

  it("shows an empty-state when nothing matches", () => {
    open();
    render(<CommandPalette />);

    fireEvent.change(input(), { target: { value: "zzzzz-nope" } });

    expect(screen.getByText("No matching commands")).toBeInTheDocument();
    expect(commandButtons()).toHaveLength(0);
  });
});

describe("keyboard navigation", () => {
  it("ArrowDown moves the highlight down and clamps at the last item", () => {
    open();
    render(<CommandPalette />);
    const el = input();

    // first item highlighted initially
    expect(commandButtons()[0].className).toContain("bg-accent-dim");

    fireEvent.keyDown(el, { key: "ArrowDown" });
    let buttons = commandButtons();
    expect(buttons[0].className).not.toContain("bg-accent-dim");
    expect(buttons[1].className).toContain("bg-accent-dim");

    // press far past the end -> clamps on the last command, never out of range
    for (let i = 0; i < TOTAL_COMMANDS + 3; i++) {
      fireEvent.keyDown(el, { key: "ArrowDown" });
    }
    buttons = commandButtons();
    expect(buttons[TOTAL_COMMANDS - 1].className).toContain("bg-accent-dim");
  });

  it("ArrowUp moves the highlight up and clamps at the first item", () => {
    open();
    render(<CommandPalette />);
    const el = input();

    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(commandButtons()[2].className).toContain("bg-accent-dim");

    fireEvent.keyDown(el, { key: "ArrowUp" });
    expect(commandButtons()[1].className).toContain("bg-accent-dim");

    // press past the top -> clamps on the first command
    for (let i = 0; i < TOTAL_COMMANDS + 3; i++) {
      fireEvent.keyDown(el, { key: "ArrowUp" });
    }
    expect(commandButtons()[0].className).toContain("bg-accent-dim");
  });

  it("hovering an item makes it the highlighted selection", () => {
    open();
    render(<CommandPalette />);

    const settings = screen.getByText("Open settings").closest("button");
    expect(settings).not.toBeNull();
    fireEvent.mouseEnter(settings as HTMLElement);

    expect((settings as HTMLElement).className).toContain("bg-accent-dim");
  });
});

describe("running commands", () => {
  it("Enter runs the highlighted command (New chat) and closes the palette", async () => {
    open();
    render(<CommandPalette />);

    // default highlight is the first command: "New chat"
    fireEvent.keyDown(input(), { key: "Enter" });

    await vi.waitFor(() => expect(m.createSession).toHaveBeenCalledTimes(1));
    expect(useStore.getState().showPalette).toBe(false);
  });

  it("Enter on a model command persists the model via updateSettings", async () => {
    open();
    render(<CommandPalette />);

    fireEvent.change(input(), { target: { value: "haiku" } });
    fireEvent.keyDown(input(), { key: "Enter" });

    await vi.waitFor(() =>
      expect(m.saveSettings).toHaveBeenCalledWith({ model: "claude-haiku-4-5-20251001" }),
    );
    expect(useStore.getState().showPalette).toBe(false);
  });

  it("Enter is a no-op when the filtered list is empty", () => {
    open();
    render(<CommandPalette />);

    fireEvent.change(input(), { target: { value: "zzzzz-nope" } });
    fireEvent.keyDown(input(), { key: "Enter" });

    // still open, no action dispatched
    expect(useStore.getState().showPalette).toBe(true);
    expect(m.createSession).not.toHaveBeenCalled();
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("clicking a command runs it and closes (Toggle file explorer flips state)", () => {
    open();
    render(<CommandPalette />);
    const before = useStore.getState().showFiles;

    fireEvent.click(screen.getByText("Toggle file explorer"));

    expect(useStore.getState().showFiles).toBe(!before);
    expect(useStore.getState().showPalette).toBe(false);
  });

  it("running Open settings flips showSettings through the store", () => {
    open();
    render(<CommandPalette />);

    fireEvent.click(screen.getByText("Open settings"));

    expect(useStore.getState().showSettings).toBe(true);
    expect(useStore.getState().showPalette).toBe(false);
  });

  it("running Open folder reaches the openFolder IPC", async () => {
    open();
    render(<CommandPalette />);

    fireEvent.click(screen.getByText("Open folder…"));

    await vi.waitFor(() => expect(m.openFolder).toHaveBeenCalledTimes(1));
    expect(useStore.getState().showPalette).toBe(false);
  });
});

describe("closing", () => {
  it("Escape closes the palette", () => {
    open();
    render(<CommandPalette />);

    fireEvent.keyDown(input(), { key: "Escape" });

    expect(useStore.getState().showPalette).toBe(false);
  });

  it("ignores unrelated keys", () => {
    open();
    render(<CommandPalette />);

    fireEvent.keyDown(input(), { key: "a" });

    // no navigation, no close
    expect(useStore.getState().showPalette).toBe(true);
    expect(commandButtons()[0].className).toContain("bg-accent-dim");
  });

  it("clicking the backdrop closes the palette", () => {
    open();
    const { container } = render(<CommandPalette />);
    const overlay = container.firstChild as HTMLElement;

    fireEvent.click(overlay);

    expect(useStore.getState().showPalette).toBe(false);
  });

  it("clicking inside the dialog does not close the palette (stopPropagation)", () => {
    open();
    render(<CommandPalette />);

    // the input lives inside the dialog; clicking it must not bubble to close
    fireEvent.click(input());

    expect(useStore.getState().showPalette).toBe(true);
  });

  it("resets the query and selection on close, so reopening starts fresh", () => {
    open();
    const view = render(<CommandPalette />);

    // dirty the state: type a filter and move the highlight
    fireEvent.change(input(), { target: { value: "model" } });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    // close via Escape (calls close() which resets query + sel)
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(useStore.getState().showPalette).toBe(false);

    // reopen: input is empty and the full list is shown with first item selected
    open();
    view.rerender(<CommandPalette />);
    expect(input().value).toBe("");
    const buttons = commandButtons();
    expect(buttons).toHaveLength(TOTAL_COMMANDS);
    expect(buttons[0].className).toContain("bg-accent-dim");
  });
});
