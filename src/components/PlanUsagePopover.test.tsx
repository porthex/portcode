import { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PlanUsagePopover } from "./PlanUsagePopover";

vi.mock("./PlanUsagePanel", () => ({
  PlanUsagePanel: () => <div>Usage panel</div>,
}));

function PopoverHost({ onOpenSettings = () => {} }: { onOpenSettings?: () => void } = {}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Plan limits
      </button>
      <button type="button">Outside control</button>
      <PlanUsagePopover
        open={open}
        triggerRef={triggerRef}
        onClose={() => setOpen(false)}
        onOpenSettings={() => {
          onOpenSettings();
          setOpen(false);
        }}
      />
    </>
  );
}

describe("PlanUsagePopover", () => {
  it("restores trigger focus when the Close button dismisses it", () => {
    render(<PopoverHost />);
    const trigger = screen.getByRole("button", { name: "Plan limits" });

    fireEvent.click(trigger);
    const close = screen.getByRole("button", { name: "Close plan usage" });
    expect(close).toHaveFocus();

    fireEvent.click(close);
    expect(screen.queryByRole("dialog", { name: "Plan usage quick view" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("restores trigger focus when Escape dismisses it", () => {
    render(<PopoverHost />);
    const trigger = screen.getByRole("button", { name: "Plan limits" });

    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "Close plan usage" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Plan usage quick view" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("dismisses when the user presses outside the popover", () => {
    render(<PopoverHost />);
    fireEvent.click(screen.getByRole("button", { name: "Plan limits" }));

    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside control" }));

    expect(screen.queryByRole("dialog", { name: "Plan usage quick view" })).toBeNull();
  });

  it("routes the detailed-usage action to Settings", () => {
    const onOpenSettings = vi.fn();
    render(<PopoverHost onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole("button", { name: "Plan limits" }));

    fireEvent.click(screen.getByRole("button", { name: "Open detailed usage in Settings →" }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Plan usage quick view" })).toBeNull();
  });
});
