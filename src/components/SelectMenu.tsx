import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

export interface SelectMenuOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectMenuGroup {
  id: string;
  label?: string;
  options: SelectMenuOption[];
}

interface SelectMenuProps {
  value: string;
  groups: SelectMenuGroup[];
  onChange: (value: string) => void;
  label: string;
  id?: string;
  title?: string;
  disabled?: boolean;
  placement?: "top" | "bottom";
  className?: string;
  buttonClassName?: string;
}

/**
 * A WebView-native select surface. Unlike the operating-system `<select>` popup,
 * this stays inside Portcode's visual and focus model and behaves consistently
 * across Windows WebView2 versions.
 */
export function SelectMenu({
  value,
  groups,
  onChange,
  label,
  id,
  title,
  disabled = false,
  placement = "bottom",
  className = "",
  buttonClassName = "",
}: SelectMenuProps) {
  const generatedId = useId().replace(/:/g, "");
  const listboxId = `${id ?? `pc-select-${generatedId}`}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(value);
  const catalogOptions = useMemo(() => groups.flatMap((group) => group.options), [groups]);
  const catalogSelection = catalogOptions.find((option) => option.value === value);
  const unavailableOption: SelectMenuOption | undefined = catalogSelection
    ? undefined
    : { value, label: `Unavailable (${value})`, disabled: true };
  const renderedGroups = unavailableOption
    ? [{ id: "__unavailable", label: "Unavailable", options: [unavailableOption] }, ...groups]
    : groups;
  const options = unavailableOption ? [unavailableOption, ...catalogOptions] : catalogOptions;
  const enabledOptions = options.filter((option) => !option.disabled);
  const selected = catalogSelection ?? unavailableOption;
  const optionIds = new Map(
    options.map((option, index) => [option.value, `${listboxId}-option-${index}`]),
  );

  useEffect(() => {
    setHighlighted(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current.get(highlighted)?.scrollIntoView?.({ block: "nearest" });
  }, [open, highlighted]);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  const commit = (next: string) => {
    if (next !== value) onChange(next);
    close(true);
  };

  const moveHighlight = (delta: number) => {
    if (enabledOptions.length === 0) return;
    const current = enabledOptions.findIndex((option) => option.value === highlighted);
    const selectedIndex = enabledOptions.findIndex((option) => option.value === value);
    // An unavailable persisted value is rendered as a disabled selected row. It is
    // intentionally absent from enabledOptions, so begin just outside the enabled
    // range: ArrowDown lands on the first real choice and ArrowUp on the last.
    const origin = current >= 0 ? current : selectedIndex >= 0 ? selectedIndex : delta > 0 ? -1 : 0;
    const next = (origin + delta + enabledOptions.length) % enabledOptions.length;
    setHighlighted(enabledOptions[next].value);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) {
          setOpen(true);
          setHighlighted(
            enabledOptions.some((option) => option.value === value)
              ? value
              : (enabledOptions[0]?.value ?? value),
          );
        } else {
          moveHighlight(1);
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) {
          setOpen(true);
          setHighlighted(
            enabledOptions.some((option) => option.value === value)
              ? value
              : (enabledOptions[enabledOptions.length - 1]?.value ?? value),
          );
        } else {
          moveHighlight(-1);
        }
        break;
      case "Home":
        if (!open || enabledOptions.length === 0) return;
        event.preventDefault();
        setHighlighted(enabledOptions[0].value);
        break;
      case "End":
        if (!open || enabledOptions.length === 0) return;
        event.preventDefault();
        setHighlighted(enabledOptions[enabledOptions.length - 1].value);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) commit(highlighted);
        else {
          setHighlighted(value);
          setOpen(true);
        }
        break;
      case "Escape":
        if (!open) return;
        event.preventDefault();
        close();
        break;
      case "Tab":
        // Let the browser advance focus normally, but never strand a popup open
        // after its combobox has lost keyboard focus.
        if (open) close();
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      className={`relative ${className}`}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      <button
        ref={buttonRef}
        id={id}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? optionIds.get(highlighted) : undefined}
        value={value}
        title={title}
        disabled={disabled}
        onClick={() => {
          setHighlighted(value);
          setOpen((current) => !current);
        }}
        onKeyDown={onTriggerKeyDown}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-panel-2 text-left text-fg outline-none transition-colors hover:border-accent-2/40 focus-visible:border-accent-2/70 focus-visible:ring-2 focus-visible:ring-accent-2/15 disabled:cursor-not-allowed disabled:opacity-50 ${buttonClassName}`}
      >
        <span className="min-w-0 truncate">{selected?.label ?? value}</span>
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          className={`shrink-0 text-faint transition-transform motion-reduce:transition-none ${open ? "rotate-180 text-accent-2" : ""}`}
        >
          <path d="m2.25 4.25 3.75 3.5 3.75-3.5" stroke="currentColor" strokeWidth="1.35" />
        </svg>
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={label}
          className={`pc-select-popover absolute z-50 max-h-72 min-w-full overflow-y-auto rounded-xl border border-border-2 bg-[#0c0e16] p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.62),0_0_0_1px_rgba(255,255,255,0.025)] ${
            placement === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"
          }`}
        >
          {renderedGroups.map((group) => (
            <div key={group.id} role="group" aria-label={group.label}>
              {group.label && (
                <div className="px-2 pb-1 pt-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
                  {group.label}
                </div>
              )}
              {group.options.map((option) => {
                const isSelected = option.value === value;
                const isHighlighted = option.value === highlighted;
                return (
                  <button
                    key={option.value}
                    ref={(node) => {
                      if (node) optionRefs.current.set(option.value, node);
                      else optionRefs.current.delete(option.value);
                    }}
                    id={optionIds.get(option.value)}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={option.disabled}
                    tabIndex={-1}
                    onPointerMove={() => !option.disabled && setHighlighted(option.value)}
                    onClick={() => commit(option.value)}
                    className={`pc-select-option flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors disabled:opacity-40 ${
                      isHighlighted
                        ? "bg-accent/15 text-fg shadow-[inset_2px_0_0_var(--color-accent)]"
                        : "text-muted hover:bg-accent-2/[0.07] hover:text-fg"
                    }`}
                  >
                    <span className="whitespace-nowrap">{option.label}</span>
                    <span
                      aria-hidden="true"
                      className={`text-accent-2 ${isSelected ? "opacity-100" : "opacity-0"}`}
                    >
                      ✓
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
