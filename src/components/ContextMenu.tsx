import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * On-theme right-click context menu (Neon-Noir). A `useContextMenu()` hook returns
 * an `onContextMenu` handler factory you attach to a surface with that row's items,
 * plus a portal-rendered `<menu>` that styles as a sibling of the Sort/Group
 * popover (.pc-pop). Portaled to <body> so an `overflow-hidden` ancestor (the
 * sidebar shell clips!) can never cut it off, repositioned to stay on-screen, and
 * fully keyboard-navigable.
 */

/** A single row in a context menu. */
export interface ContextMenuItem {
  /** Visible label (and the item's accessible name). */
  label: string;
  /** Optional leading icon node (rendered in a fixed-width icon cell). */
  icon?: ReactNode;
  /** Invoked when the item is activated (click / Enter / Space). */
  onSelect: () => void;
  /** Optional right-aligned hint, e.g. a keyboard shortcut. */
  shortcut?: string;
  /** Tint the row danger (e.g. Delete). */
  danger?: boolean;
  /** Dim + make the row inert (no hover, no activation). */
  disabled?: boolean;
  /** Draw a faint separator rule above this item. */
  separatorBefore?: boolean;
  /** Draw a non-interactive section caption above this item (after any separator). */
  headingBefore?: string;
}

/** Open state: the cursor position and the items to render. */
interface OpenState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

// ── Single-menu coordination ────────────────────────────────────────────────
// Only one context menu may be open across the whole app. Each open menu registers
// a closer here; opening a new one (or any global close trigger) runs every closer
// first, so a prior menu can never linger behind a freshly opened one.
const closers = new Set<() => void>();
function closeAll(): void {
  for (const close of [...closers]) close();
}

/**
 * Wire a surface for a right-click menu. Returns:
 * - `onContextMenu(items)` — an event-handler FACTORY: call it with the items for
 *   a given row and spread the result onto that row's `onContextMenu`. An empty
 *   items array leaves the native menu intact (nothing to show).
 * - `menu` — the portal node to render once anywhere in the component's output.
 */
export function useContextMenu() {
  const [open, setOpen] = useState<OpenState | null>(null);
  // The element that had focus when the menu opened, so Escape/close can restore it.
  const openerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(null);
  }, []);

  // Register this instance's closer for the global single-menu rule, and make sure
  // it's pulled on unmount so a stale closer can't fire into a dead component.
  useEffect(() => {
    closers.add(close);
    return () => {
      closers.delete(close);
    };
  }, [close]);

  const onContextMenu = useCallback(
    (items: ContextMenuItem[]) => (e: ReactMouseEvent) => {
      // Nothing to show — leave the platform's native menu (e.g. on plain text).
      if (items.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      // Close any other open menu first (and this one if already open) so exactly
      // one is ever visible.
      closeAll();
      openerRef.current = (e.currentTarget as HTMLElement) ?? null;
      setOpen({ x: e.clientX, y: e.clientY, items });
    },
    [],
  );

  const handleClose = useCallback(() => {
    close();
    // Return focus to the surface that opened the menu so keyboard users keep place.
    openerRef.current?.focus?.();
    openerRef.current = null;
  }, [close]);

  const menu = open ? (
    <ContextMenu x={open.x} y={open.y} items={open.items} onClose={handleClose} />
  ) : null;

  return { onContextMenu, menu };
}

/** The portal-rendered menu. Internal — surfaces use {@link useContextMenu}. */
function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLMenuElement>(null);
  // Start at the cursor; clamp into the viewport after measuring (below).
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  // The indices of activatable (non-disabled) items, in DOM order — the keyboard
  // arrow navigation walks these.
  const enabledIndices = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  const [activeIndex, setActiveIndex] = useState<number>(enabledIndices[0] ?? -1);

  // Clamp the menu inside the viewport: flip past the cursor near the right/bottom
  // edges, then nudge so it never spills off any side. Runs before paint so the
  // menu never flashes off-screen.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 6;
    let left = x;
    let top = y;
    // Flip to the left of the cursor if it would overflow the right edge.
    if (left + width + margin > vw) left = x - width;
    // Flip above the cursor if it would overflow the bottom edge.
    if (top + height + margin > vh) top = y - height;
    // Final clamp so a menu taller/wider than the viewport still starts on-screen.
    left = Math.max(margin, Math.min(left, vw - width - margin));
    top = Math.max(margin, Math.min(top, vh - height - margin));
    setPos({ left, top });
  }, [x, y]);

  // Move focus into the menu on open so the keyboard model is immediately live.
  // The active row focuses ITSELF (see ContextMenuRow), so only fall back to the
  // menu container when there's no activatable row — otherwise this would steal
  // focus back from the row (parent effects run after child effects).
  useEffect(() => {
    if (enabledIndices.length === 0) menuRef.current?.focus();
    // Run once on mount; the row effects own focus after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Outside interaction (scroll, resize, an unhandled mousedown anywhere, blur)
  // closes the menu. The capture-phase mousedown also catches clicks on the
  // surface beneath without needing a full-viewport catcher element.
  useEffect(() => {
    const onDocMouseDown = (e: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    // A right-click elsewhere is handled by that surface's own opener (closeAll),
    // but a right-click on dead space must still dismiss this one.
    const onDocContextMenu = (e: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("contextmenu", onDocContextMenu, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown, true);
      document.removeEventListener("contextmenu", onDocContextMenu, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const activate = (item: ContextMenuItem) => {
    if (item.disabled) return;
    onClose();
    item.onSelect();
  };

  const moveActive = (dir: 1 | -1) => {
    if (enabledIndices.length === 0) return;
    const cur = enabledIndices.indexOf(activeIndex);
    const next = cur === -1 ? 0 : (cur + dir + enabledIndices.length) % enabledIndices.length;
    setActiveIndex(enabledIndices[next]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        e.preventDefault();
        if (enabledIndices.length) setActiveIndex(enabledIndices[0]);
        break;
      case "End":
        e.preventDefault();
        if (enabledIndices.length) setActiveIndex(enabledIndices[enabledIndices.length - 1]);
        break;
      case "Enter":
      case " ": {
        e.preventDefault();
        const item = items[activeIndex];
        if (item) activate(item);
        break;
      }
      case "Tab":
        // Trap focus inside the transient menu — Tab just closes it.
        e.preventDefault();
        onClose();
        break;
    }
  };

  const style: CSSProperties = { left: pos.left, top: pos.top };

  return createPortal(
    <menu
      ref={menuRef}
      role="menu"
      aria-orientation="vertical"
      tabIndex={-1}
      className="pc-ctx"
      style={style}
      onKeyDown={onKeyDown}
      // Suppress a native menu on the menu itself.
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <ContextMenuRow
          key={`${item.label}:${i}`}
          item={item}
          active={i === activeIndex}
          onActivate={() => activate(item)}
          onHover={() => !item.disabled && setActiveIndex(i)}
        />
      ))}
    </menu>,
    document.body,
  );
}

function ContextMenuRow({
  item,
  active,
  onActivate,
  onHover,
}: {
  item: ContextMenuItem;
  active: boolean;
  onActivate: () => void;
  onHover: () => void;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  // Keep DOM focus on the active row so :focus-visible styling + the roving model
  // agree, and screen readers track the highlighted item.
  useEffect(() => {
    if (active && !item.disabled) rowRef.current?.focus();
  }, [active, item.disabled]);

  return (
    <>
      {item.separatorBefore && <li className="pc-ctx__sep" role="separator" />}
      {item.headingBefore && (
        <li className="pc-ctx__heading" role="presentation">
          {item.headingBefore}
        </li>
      )}
      <li role="none">
        <button
          ref={rowRef}
          type="button"
          role="menuitem"
          aria-disabled={item.disabled || undefined}
          tabIndex={-1}
          className={`pc-ctx__item${item.danger ? " pc-ctx__item--danger" : ""}`}
          onClick={onActivate}
          onMouseEnter={onHover}
        >
          {item.icon !== undefined && (
            <span className="pc-ctx__icon" aria-hidden="true">
              {item.icon}
            </span>
          )}
          <span className="pc-ctx__label">{item.label}</span>
          {item.shortcut && (
            <span className="pc-ctx__hint" aria-hidden="true">
              {item.shortcut}
            </span>
          )}
        </button>
      </li>
    </>
  );
}
