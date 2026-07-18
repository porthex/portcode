import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store/store";
import { SettingsBoundary } from "./SettingsBoundary";

let shouldThrow = true;
function FragileSettings() {
  if (shouldThrow) throw new Error("broken settings glyph");
  return <div>Settings recovered</div>;
}

function ControlledHost() {
  const showSettings = useStore((state) => state.showSettings);
  const setShowSettings = useStore((state) => state.setShowSettings);
  return (
    <div>
      <button type="button" onClick={() => setShowSettings(true)}>
        Workspace control
      </button>
      {showSettings && (
        <SettingsBoundary>
          <FragileSettings />
        </SettingsBoundary>
      )}
    </div>
  );
}

describe("SettingsBoundary", () => {
  beforeEach(() => {
    shouldThrow = true;
    useStore.setState({ showSettings: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("contains a Settings crash and lets the user return to the live workspace", () => {
    render(<ControlledHost />);

    expect(screen.getByRole("alertdialog", { name: "Settings couldn't open" })).toHaveTextContent(
      "broken settings glyph",
    );
    const workspace = screen.getByText("Workspace control").closest("button")!;
    const returnToChat = screen.getByRole("button", { name: "Return to chat" });
    expect(returnToChat).toHaveFocus();
    expect(workspace).toHaveAttribute("inert");
    expect(workspace).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(returnToChat);
    expect(useStore.getState().showSettings).toBe(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(workspace).not.toHaveAttribute("inert");
    expect(workspace).not.toHaveAttribute("aria-hidden");
  });

  it("can retry without reloading the whole application", () => {
    render(
      <SettingsBoundary>
        <FragileSettings />
      </SettingsBoundary>,
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Try settings again" }));
    expect(screen.getByText("Settings recovered")).toBeInTheDocument();
  });

  it("returns focus to the connected control that opened Settings", () => {
    useStore.setState({ showSettings: false });
    render(<ControlledHost />);
    const opener = screen.getByRole("button", { name: "Workspace control" });

    opener.focus();
    fireEvent.click(opener);
    const returnToChat = screen.getByRole("button", { name: "Return to chat" });
    expect(returnToChat).toHaveFocus();

    fireEvent.click(returnToChat);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("traps focus between recovery actions and lets Escape return to chat", () => {
    render(<ControlledHost />);
    const back = screen.getByRole("button", { name: "Return to chat" });
    const retry = screen.getByRole("button", { name: "Try settings again" });

    fireEvent.keyDown(back, { key: "Tab", shiftKey: true });
    expect(retry).toHaveFocus();
    fireEvent.keyDown(retry, { key: "Tab" });
    expect(back).toHaveFocus();
    fireEvent.keyDown(back, { key: "Escape" });
    expect(useStore.getState().showSettings).toBe(false);
  });
});
