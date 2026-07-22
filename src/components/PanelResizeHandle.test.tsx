import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { PanelResizeHandle, usePersistentPanelWidth } from "./PanelResizeHandle";

const KEY = "pc.testPanelWidth";

function Harness() {
  const { width, setWidth } = usePersistentPanelWidth({
    storageKey: KEY,
    defaultWidth: 240,
    minWidth: 180,
    maxWidth: 420,
  });
  return (
    <div>
      <output aria-label="Panel width">{width}</output>
      <PanelResizeHandle
        label="Resize test explorer"
        width={width}
        minWidth={180}
        maxWidth={420}
        defaultWidth={240}
        onResize={setWidth}
      />
    </div>
  );
}

afterEach(() => localStorage.removeItem(KEY));

describe("PanelResizeHandle", () => {
  it("drags horizontally and clamps at the supported bounds", () => {
    render(<Harness />);
    const handle = screen.getByRole("separator", { name: "Resize test explorer" });

    fireEvent.pointerDown(handle, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 500 });

    expect(screen.getByRole("status", { name: "Panel width" })).toHaveTextContent("420");
    expect(handle).toHaveAttribute("aria-valuenow", "420");
    expect(document.body.style.cursor).toBe("col-resize");

    fireEvent.pointerMove(window, { clientX: -500 });
    expect(screen.getByRole("status", { name: "Panel width" })).toHaveTextContent("180");

    fireEvent.pointerUp(window);
    expect(document.body.style.cursor).toBe("");
  });

  it("supports keyboard resizing and double-click reset", () => {
    render(<Harness />);
    const handle = screen.getByRole("separator", { name: "Resize test explorer" });

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(screen.getByRole("status", { name: "Panel width" })).toHaveTextContent("248");
    fireEvent.keyDown(handle, { key: "End" });
    expect(screen.getByRole("status", { name: "Panel width" })).toHaveTextContent("420");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(screen.getByRole("status", { name: "Panel width" })).toHaveTextContent("180");

    fireEvent.doubleClick(handle);
    expect(screen.getByRole("status", { name: "Panel width" })).toHaveTextContent("240");
  });

  it("restores a persisted width and clamps stale values", () => {
    localStorage.setItem(KEY, "999");
    const first = render(<Harness />);
    expect(screen.getByRole("status", { name: "Panel width" })).toHaveTextContent("420");
    first.unmount();

    localStorage.setItem(KEY, "320");
    render(<Harness />);
    expect(screen.getByRole("status", { name: "Panel width" })).toHaveTextContent("320");
  });
});
