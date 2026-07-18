import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SelectMenu } from "./SelectMenu";

const groups = [
  {
    id: "primary",
    label: "Primary",
    options: [
      { value: "one", label: "One" },
      { value: "two", label: "Two" },
    ],
  },
  { id: "other", label: "Other", options: [{ value: "three", label: "Three" }] },
];

describe("SelectMenu", () => {
  it("opens a themed listbox and commits an option", () => {
    const onChange = vi.fn();
    render(<SelectMenu label="Model" value="one" groups={groups} onChange={onChange} />);

    const trigger = screen.getByRole("combobox", { name: "Model" });
    expect(trigger).toHaveTextContent("One");
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Model" });
    expect(listbox).toBeInTheDocument();
    expect(listbox).toHaveClass("pc-select-popover");
    expect(screen.getByRole("option", { name: "Two" })).toHaveClass("pc-select-option");
    expect(trigger.querySelector("svg")).toHaveClass("motion-reduce:transition-none");
    fireEvent.click(screen.getByRole("option", { name: "Two" }));

    expect(onChange).toHaveBeenCalledWith("two");
    expect(screen.queryByRole("listbox", { name: "Model" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("supports keyboard navigation and Escape", () => {
    const onChange = vi.fn();
    render(<SelectMenu label="Model" value="one" groups={groups} onChange={onChange} />);
    const trigger = screen.getByRole("combobox", { name: "Model" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("two");

    fireEvent.keyDown(trigger, { key: " " });
    expect(screen.getByRole("listbox", { name: "Model" })).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Model" })).not.toBeInTheDocument();
  });

  it("supports reverse, boundary, and pointer highlighting before commit", () => {
    const onChange = vi.fn();
    render(<SelectMenu label="Model" value="one" groups={groups} onChange={onChange} />);
    const trigger = screen.getByRole("combobox", { name: "Model" });

    // Closed Home is a no-op; ArrowUp opens and a second ArrowUp wraps backward.
    fireEvent.keyDown(trigger, { key: "Home" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(trigger.getAttribute("aria-activedescendant")).toMatch(/-option-2$/);

    fireEvent.keyDown(trigger, { key: "Home" });
    expect(trigger.getAttribute("aria-activedescendant")).toMatch(/-option-0$/);
    fireEvent.keyDown(trigger, { key: "End" });
    expect(trigger.getAttribute("aria-activedescendant")).toMatch(/-option-2$/);

    fireEvent.pointerMove(screen.getByRole("option", { name: "Two" }));
    expect(trigger.getAttribute("aria-activedescendant")).toMatch(/-option-1$/);
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("two");
  });

  it("scrolls keyboard-highlighted options into the visible listbox viewport", () => {
    render(<SelectMenu label="Model" value="one" groups={groups} onChange={() => {}} />);
    const trigger = screen.getByRole("combobox", { name: "Model" });

    fireEvent.click(trigger);
    const one = screen.getByRole("option", { name: "One" });
    const two = screen.getByRole("option", { name: "Two" });
    const three = screen.getByRole("option", { name: "Three" });
    const scrollOne = vi.fn();
    const scrollTwo = vi.fn();
    const scrollThree = vi.fn();
    Object.defineProperty(one, "scrollIntoView", { configurable: true, value: scrollOne });
    Object.defineProperty(two, "scrollIntoView", { configurable: true, value: scrollTwo });
    Object.defineProperty(three, "scrollIntoView", { configurable: true, value: scrollThree });

    fireEvent.keyDown(trigger, { key: "End" });
    expect(scrollThree).toHaveBeenLastCalledWith({ block: "nearest" });
    fireEvent.keyDown(trigger, { key: "Home" });
    expect(scrollOne).toHaveBeenLastCalledWith({ block: "nearest" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(scrollTwo).toHaveBeenLastCalledWith({ block: "nearest" });
  });

  it("closes on outside press and cannot open while disabled", () => {
    const { rerender } = render(
      <SelectMenu label="Model" value="one" groups={groups} onChange={() => {}} />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox", { name: "Model" })).not.toBeInTheDocument();

    rerender(<SelectMenu label="Model" value="one" groups={groups} onChange={() => {}} disabled />);
    const disabled = screen.getByRole("combobox", { name: "Model" });
    expect(disabled).toBeDisabled();
    fireEvent.click(disabled);
    expect(screen.queryByRole("listbox", { name: "Model" })).not.toBeInTheDocument();
  });

  it("closes when keyboard focus leaves the combobox", () => {
    render(<SelectMenu label="Model" value="one" groups={groups} onChange={() => {}} />);
    const trigger = screen.getByRole("combobox", { name: "Model" });

    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Tab" });
    expect(screen.queryByRole("listbox", { name: "Model" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.blur(trigger, { relatedTarget: document.body });
    expect(screen.queryByRole("listbox", { name: "Model" })).not.toBeInTheDocument();
  });

  it("shows an unavailable stored value honestly instead of impersonating the first option", () => {
    render(
      <SelectMenu label="Model" value="retired/model id" groups={groups} onChange={() => {}} />,
    );
    const trigger = screen.getByRole("combobox", { name: "Model" });
    expect(trigger).toHaveValue("retired/model id");
    expect(trigger).toHaveTextContent("Unavailable (retired/model id)");
    expect(trigger).not.toHaveTextContent(/^One$/);

    fireEvent.click(trigger);
    const unavailable = screen.getByRole("option", {
      name: "Unavailable (retired/model id)",
    });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveAttribute("aria-selected", "true");
    expect(trigger.getAttribute("aria-activedescendant")).toBe(unavailable.id);
  });

  it("moves from an unavailable value to the first or last enabled choice", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SelectMenu label="Model" value="retired" groups={groups} onChange={onChange} />,
    );
    const trigger = screen.getByRole("combobox", { name: "Model" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "One" }).id,
    );
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("one");

    rerender(<SelectMenu label="Model" value="retired" groups={groups} onChange={onChange} />);
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(trigger).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Three" }).id,
    );
  });
});
