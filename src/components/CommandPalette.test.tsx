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
// Rows are role="option" under the role="listbox" results container (their
// implicit <button> role is overridden), so query them by the option role.
const commandButtons = () => screen.queryAllByRole("option");

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
  m.runAgent.mockResolvedValue({ cancel: vi.fn(async () => {}), dispose: vi.fn() });
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

  it("gives the search input an accessible name (not just a placeholder)", () => {
    open();
    render(<CommandPalette />);

    // the input is reachable by its accessible name, which placeholders do not provide.
    // It carries role="combobox" (overriding the implicit textbox role) for the listbox.
    const search = screen.getByRole("combobox", { name: "Command palette search" });
    expect(search).toBe(input());
  });

  it("exposes the shortcut in a hinted command's accessible name", () => {
    open();
    render(<CommandPalette />);

    // a hinted row announces label + shortcut to screen readers, not a bare glyph
    expect(screen.getByRole("option", { name: "New chat, Ctrl+N" })).toBeInTheDocument();
    // a hintless row falls back to just its label
    expect(screen.getByRole("option", { name: "Open folder…" })).toBeInTheDocument();
  });
});

describe("accessibility roles", () => {
  it("exposes the palette as a modal dialog and the input as a combobox", () => {
    open();
    render(<CommandPalette />);

    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const combobox = screen.getByRole("combobox", { name: "Command palette search" });
    expect(combobox).toBe(input());
    expect(combobox).toHaveAttribute("aria-controls", "pc-palette-list");
    expect(combobox).toHaveAttribute("aria-haspopup", "listbox");

    // the results container is the listbox the combobox controls
    const listbox = screen.getByRole("listbox", { name: "Commands" });
    expect(listbox).toHaveAttribute("id", "pc-palette-list");
  });

  it("tracks the active option via aria-activedescendant as the highlight moves", () => {
    open();
    render(<CommandPalette />);
    const el = input();

    // first command ("New chat") is active initially
    expect(el).toHaveAttribute("aria-activedescendant", "pc-cmd-new");

    // arrowing down moves the active descendant to the next row
    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(el).toHaveAttribute("aria-activedescendant", "pc-cmd-files");
  });

  it("clears aria-activedescendant when nothing matches", () => {
    open();
    render(<CommandPalette />);
    const el = input();

    fireEvent.change(el, { target: { value: "zzzzz-nope" } });
    expect(screen.getByText("No matching commands")).toBeInTheDocument();
    expect(el).not.toHaveAttribute("aria-activedescendant");
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
  it("ArrowDown moves the highlight down through the list", () => {
    open();
    render(<CommandPalette />);
    const el = input();

    // first item highlighted initially
    expect(commandButtons()[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(el, { key: "ArrowDown" });
    const buttons = commandButtons();
    expect(buttons[0]).toHaveAttribute("aria-selected", "false");
    expect(buttons[1]).toHaveAttribute("aria-selected", "true");
  });

  it("ArrowDown at the last item wraps around to the first", () => {
    open();
    render(<CommandPalette />);
    const el = input();

    // walk to the last row
    for (let i = 0; i < TOTAL_COMMANDS - 1; i++) {
      fireEvent.keyDown(el, { key: "ArrowDown" });
    }
    expect(commandButtons()[TOTAL_COMMANDS - 1]).toHaveAttribute("aria-selected", "true");

    // one more ArrowDown wraps back to the top
    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(commandButtons()[0]).toHaveAttribute("aria-selected", "true");
  });

  it("ArrowUp moves the highlight up through the list", () => {
    open();
    render(<CommandPalette />);
    const el = input();

    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(commandButtons()[2]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(el, { key: "ArrowUp" });
    expect(commandButtons()[1]).toHaveAttribute("aria-selected", "true");
  });

  it("ArrowUp at the first item wraps around to the last", () => {
    open();
    render(<CommandPalette />);
    const el = input();

    // first item highlighted initially
    expect(commandButtons()[0]).toHaveAttribute("aria-selected", "true");

    // one ArrowUp from the top wraps to the bottom
    fireEvent.keyDown(el, { key: "ArrowUp" });
    expect(commandButtons()[TOTAL_COMMANDS - 1]).toHaveAttribute("aria-selected", "true");
  });

  it("hovering an item makes it the highlighted selection", () => {
    open();
    render(<CommandPalette />);

    const settings = screen.getByText("Open settings").closest("button");
    expect(settings).not.toBeNull();
    fireEvent.mouseEnter(settings as HTMLElement);

    expect(settings as HTMLElement).toHaveAttribute("aria-selected", "true");
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

  it("ArrowDown on an empty result set never drives selection negative (clamped at 0)", () => {
    open();
    render(<CommandPalette />);
    const el = input();

    // no matches: sel would otherwise be set to filtered.length - 1 === -1
    fireEvent.change(el, { target: { value: "zzzzz-nope" } });
    expect(screen.getByText("No matching commands")).toBeInTheDocument();

    // pressing ArrowDown must not crash nor make a later Enter fire choose(-1)
    expect(() => fireEvent.keyDown(el, { key: "ArrowDown" })).not.toThrow();

    // a follow-up Enter stays a no-op (choose(sel) hits no real command)
    fireEvent.keyDown(el, { key: "Enter" });
    expect(useStore.getState().showPalette).toBe(true);
    expect(m.createSession).not.toHaveBeenCalled();
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("arrow keys on an empty result set keep selection at 0 (modulo never yields NaN)", () => {
    open();
    render(<CommandPalette />);
    const el = input();

    fireEvent.change(el, { target: { value: "zzzzz-nope" } });
    expect(screen.getByText("No matching commands")).toBeInTheDocument();

    // wrapping over length 0 must not divide-by-zero into NaN; selection stays 0
    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "ArrowUp" });

    // a follow-up Enter is still a no-op (choose(0) hits no command)
    fireEvent.keyDown(el, { key: "Enter" });
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

  it("Escape closes the palette even when focus has left the input", () => {
    open();
    render(<CommandPalette />);

    // Focus may sit on a row (after hovering/clicking) rather than the input; the
    // input's own keydown wouldn't fire, so a window-level handler must catch Escape.
    fireEvent.keyDown(document, { key: "Escape" });

    expect(useStore.getState().showPalette).toBe(false);
  });

  it("ignores unrelated keys", () => {
    open();
    render(<CommandPalette />);

    fireEvent.keyDown(input(), { key: "a" });

    // no navigation, no close
    expect(useStore.getState().showPalette).toBe(true);
    expect(commandButtons()[0]).toHaveAttribute("aria-selected", "true");
  });

  it("traps Tab so focus stays in the palette (default prevented, list unchanged)", () => {
    open();
    render(<CommandPalette />);

    // Tab/Shift+Tab on the input must not move focus to app chrome behind the scrim
    const tab = fireEvent.keyDown(input(), { key: "Tab" });
    expect(tab).toBe(false); // returns false when preventDefault() was called

    // the palette stays open with the first row still selected
    expect(useStore.getState().showPalette).toBe(true);
    expect(commandButtons()[0]).toHaveAttribute("aria-selected", "true");
  });

  it("keeps option rows out of the tab order so the combobox is the only tab stop", () => {
    open();
    render(<CommandPalette />);

    // every row carries tabindex="-1": the input owns DOM focus, aria-activedescendant
    // marks the active option (combobox-with-listbox pattern), so rows aren't tab stops.
    for (const row of commandButtons()) {
      expect(row).toHaveAttribute("tabindex", "-1");
    }
  });

  it("traps focus inside the dialog even when a row holds focus (Tab + Shift+Tab)", () => {
    open();
    render(<CommandPalette />);
    const dialog = screen.getByRole("dialog", { name: "Command palette" });

    // Even if focus somehow reaches a row (SR/spatial nav), Tab must not escape the modal.
    const row = commandButtons()[0];
    row.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(row, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(row, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
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
    expect(buttons[0]).toHaveAttribute("aria-selected", "true");
  });
});
