import { useCallback, useEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";

import type { ProviderId } from "../types";
import { PlanUsagePanel } from "./PlanUsagePanel";

interface PlanUsagePopoverProps {
  open: boolean;
  provider: ProviderId;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onOpenSettings: (provider?: ProviderId) => void;
  onRemainingChange: (remaining: number | null) => void;
}

/** Fast, non-modal plan check anchored above the persistent status HUD. */
export function PlanUsagePopover({
  open,
  provider,
  triggerRef,
  onClose,
  onOpenSettings,
  onRemainingChange,
}: PlanUsagePopoverProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeAndRestoreFocus = useCallback(() => {
    onClose();
    triggerRef.current?.focus();
  }, [onClose, triggerRef]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();

    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
    };

    document.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeAndRestoreFocus, open, onClose, triggerRef]);

  if (!open) return null;

  return createPortal(
    <section
      ref={panelRef}
      id="pc-plan-usage-popover"
      className="pc-plan-quick"
      role="dialog"
      aria-label="Plan usage quick view"
    >
      <header className="pc-plan-quick__header">
        <div>
          <span>{provider === "openai" ? "OPENAI · GPT" : "ANTHROPIC · CLAUDE"}</span>
          <strong>Plan usage</strong>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={closeAndRestoreFocus}
          aria-label="Close plan usage"
        >
          ×
        </button>
      </header>
      <PlanUsagePanel
        compact
        onlyProvider={provider}
        onOpenSettings={onOpenSettings}
        onRemainingChange={onRemainingChange}
      />
      <footer className="pc-plan-quick__footer">
        <span>Included allowance, separate from API billing</span>
        <button type="button" onClick={() => onOpenSettings()}>
          Open detailed usage in Settings →
        </button>
      </footer>
    </section>,
    document.body,
  );
}
