import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { useContextMenu, type ContextMenuItem } from "./ContextMenu";

// A tiny harness that wires the hook to a single right-clickable surface and
// renders the portal menu. Tests pass the items to show; `onSelect` spies assert
// activation. The surface is focusable so Escape's focus-restore is observable.
function Harness({ items }: { items: ContextMenuItem[] }) {
  const { onContextMenu, menu } = useContextMenu();
  return (
    <div>
      <button data-testid="surface" onContextMenu={onContextMenu(items)}>
        right-click me
      </button>
      <button data-testid="other">elsewhere</button>
      {menu}
    </div>
  );
}

const openMenu = () => {
  fireEvent.contextMenu(screen.getByTestId("surface"), { clientX: 40, clientY: 50 });
};

describe("useContextMenu / ContextMenu", () => {
  it("opens on contextmenu at the cursor position and suppresses the native menu", () => {
    const onSelect = vi.fn();
    render(<Harness items={[{ label: "Do it", onSelect }]} />);

    // No menu until the surface is right-clicked.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    // fireEvent returns false when the handler called preventDefault — so the
    // platform's native menu is suppressed on this handled surface.
    const notPrevented = fireEvent.contextMenu(screen.getByTestId("surface"), {
      clientX: 120,
      clientY: 200,
    });
    expect(notPrevented).toBe(false);

    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();
    // Positioned at the cursor (jsdom getBoundingClientRect is 0×0, so no clamp).
    expect(menu).toHaveStyle({ left: "120px", top: "200px" });
  });

  it("renders one menuitem per item with its label, icon, and shortcut hint", () => {
    render(
      <Harness
        items={[
          {
            label: "Copy",
            icon: <span data-testid="ico" />,
            shortcut: "Ctrl C",
            onSelect: vi.fn(),
          },
          { label: "Delete", danger: true, onSelect: vi.fn() },
        ]}
      />,
    );
    openMenu();

    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(screen.getByRole("menuitem", { name: "Copy" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    expect(screen.getByTestId("ico")).toBeInTheDocument();
    // The shortcut renders in the faint hint column.
    expect(screen.getByText("Ctrl C")).toHaveClass("pc-ctx__hint");
  });

  it("applies the danger class to destructive items", () => {
    render(<Harness items={[{ label: "Delete", danger: true, onSelect: vi.fn() }]} />);
    openMenu();

    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveClass("pc-ctx__item--danger");
  });

  it("calls onSelect and closes when an item is clicked", () => {
    const onSelect = vi.fn();
    render(<Harness items={[{ label: "Do it", onSelect }]} />);
    openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Do it" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("activates the focused item on Enter and on Space, then closes", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(
      <Harness
        items={[
          { label: "First", onSelect: first },
          { label: "Second", onSelect: second },
        ]}
      />,
    );

    // Enter activates the first (initially active) item.
    openMenu();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Enter" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    // Re-open; ArrowDown to the second item, then Space activates it.
    openMenu();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: " " });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("navigates items with ArrowDown / ArrowUp (wrapping) and Home / End", () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    render(
      <Harness
        items={[
          { label: "A", onSelect: a },
          { label: "B", onSelect: b },
          { label: "C", onSelect: c },
        ]}
      />,
    );
    openMenu();
    const menu = screen.getByRole("menu");

    // Active item carries DOM focus; assert via document.activeElement.
    expect(screen.getByRole("menuitem", { name: "A" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "B" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "C" })).toHaveFocus();
    // ArrowDown from the last wraps to the first.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "A" })).toHaveFocus();
    // ArrowUp from the first wraps to the last.
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "C" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(screen.getByRole("menuitem", { name: "A" })).toHaveFocus();
  });

  it("does not fire disabled items and marks them aria-disabled; nav skips them", () => {
    const enabled = vi.fn();
    const disabled = vi.fn();
    render(
      <Harness
        items={[
          { label: "Off", onSelect: disabled, disabled: true },
          { label: "On", onSelect: enabled },
        ]}
      />,
    );
    openMenu();

    const off = screen.getByRole("menuitem", { name: "Off" });
    expect(off).toHaveAttribute("aria-disabled", "true");

    // A click on the disabled item is a no-op (the JS guard backs the CSS).
    fireEvent.click(off);
    expect(disabled).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // The only enabled item is the initial active one; Enter fires it.
    expect(screen.getByRole("menuitem", { name: "On" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Enter" });
    expect(enabled).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and restores focus to the opener", () => {
    render(<Harness items={[{ label: "Do it", onSelect: vi.fn() }]} />);
    openMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // Focus returns to the surface that opened the menu.
    expect(screen.getByTestId("surface")).toHaveFocus();
  });

  it("closes on an outside mousedown", () => {
    render(<Harness items={[{ label: "Do it", onSelect: vi.fn() }]} />);
    openMenu();

    fireEvent.mouseDown(screen.getByTestId("other"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on a right-click in dead space (outside the menu)", () => {
    render(<Harness items={[{ label: "Do it", onSelect: vi.fn() }]} />);
    openMenu();

    fireEvent.contextMenu(screen.getByTestId("other"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on scroll and on Tab (focus trap)", () => {
    render(<Harness items={[{ label: "Do it", onSelect: vi.fn() }]} />);

    openMenu();
    fireEvent.scroll(window);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    openMenu();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("leaves the native menu intact when there are no items", () => {
    render(<Harness items={[]} />);

    // Nothing to show — the handler returns early without preventDefault, so the
    // native menu is left intact and no portal renders. fireEvent returns true
    // (default NOT prevented).
    const notPrevented = fireEvent.contextMenu(screen.getByTestId("surface"));
    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("renders separators and section headings between item groups", () => {
    render(
      <Harness
        items={[
          { label: "Top", onSelect: vi.fn() },
          {
            label: "Grouped",
            onSelect: vi.fn(),
            separatorBefore: true,
            headingBefore: "Move to folder",
          },
        ]}
      />,
    );
    openMenu();

    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByText("Move to folder")).toHaveClass("pc-ctx__heading");
  });

  describe("viewport clamping", () => {
    const realW = window.innerWidth;
    const realH = window.innerHeight;
    let rectSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // A small viewport + a non-trivial menu rect so the flip/clamp logic runs.
      Object.defineProperty(window, "innerWidth", { value: 300, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 300, configurable: true });
      rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 200,
        height: 200,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
    });
    afterEach(() => {
      rectSpy.mockRestore();
      Object.defineProperty(window, "innerWidth", { value: realW, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: realH, configurable: true });
    });

    it("flips the menu past the cursor near the right/bottom edges", () => {
      render(<Harness items={[{ label: "Do it", onSelect: vi.fn() }]} />);
      // Click near the bottom-right: 250+200 overflows 300 on both axes, so the
      // menu flips to (cursor - size) = 50 on each axis.
      fireEvent.contextMenu(screen.getByTestId("surface"), { clientX: 250, clientY: 250 });

      const menu = screen.getByRole("menu");
      expect(menu).toHaveStyle({ left: "50px", top: "50px" });
    });

    it("clamps to the margin when even the flipped position would overflow", () => {
      render(<Harness items={[{ label: "Do it", onSelect: vi.fn() }]} />);
      // Cursor at the extreme top-left: cursor-size would be negative, so it
      // clamps to the 6px margin.
      fireEvent.contextMenu(screen.getByTestId("surface"), { clientX: 2, clientY: 2 });

      const menu = screen.getByRole("menu");
      expect(menu).toHaveStyle({ left: "6px", top: "6px" });
    });
  });

  it("keeps only one menu open at a time across surfaces", () => {
    function TwoSurfaces() {
      const one = useContextMenu();
      const two = useContextMenu();
      return (
        <div>
          <button
            data-testid="s1"
            onContextMenu={one.onContextMenu([{ label: "One", onSelect: vi.fn() }])}
          >
            one
          </button>
          <button
            data-testid="s2"
            onContextMenu={two.onContextMenu([{ label: "Two", onSelect: vi.fn() }])}
          >
            two
          </button>
          {one.menu}
          {two.menu}
        </div>
      );
    }
    render(<TwoSurfaces />);

    fireEvent.contextMenu(screen.getByTestId("s1"));
    expect(screen.getByRole("menuitem", { name: "One" })).toBeInTheDocument();

    // Opening the second surface's menu closes the first — exactly one is shown.
    fireEvent.contextMenu(screen.getByTestId("s2"));
    expect(screen.queryByRole("menuitem", { name: "One" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Two" })).toBeInTheDocument();
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });
});
