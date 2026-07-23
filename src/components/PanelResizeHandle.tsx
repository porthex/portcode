import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export function clampPanelWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
}

/** A panel width that survives reloads. Invalid/stale values are clamped so a
 * preference can never reopen an explorer outside its supported range. */
export function usePersistentPanelWidth({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
}: {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}) {
  const [width, setWidthState] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      return Number.isFinite(stored) && stored > 0
        ? clampPanelWidth(stored, minWidth, maxWidth)
        : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });

  const setWidth = useCallback(
    (next: number) => {
      const clamped = clampPanelWidth(next, minWidth, maxWidth);
      setWidthState(clamped);
      try {
        localStorage.setItem(storageKey, String(clamped));
      } catch {
        // Width persistence is a convenience. Resizing remains live if storage is
        // unavailable or full.
      }
    },
    [maxWidth, minWidth, storageKey],
  );

  return { width, setWidth };
}

/** Full-height vertical splitter used by the desktop Sessions and Files rails.
 * Pointer movement is captured on window so dragging remains stable when the
 * cursor outruns the narrow visual handle. The same control supports keyboard
 * resizing for users who cannot drag it. */
export function PanelResizeHandle({
  label,
  width,
  minWidth,
  maxWidth,
  defaultWidth,
  onResize,
  onResizeStart,
  onResizeEnd,
}: {
  label: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
  onResize: (width: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const moveListenerRef = useRef<((event: PointerEvent) => void) | null>(null);
  const endListenerRef = useRef<(() => void) | null>(null);
  const restoreBodyRef = useRef<{ cursor: string; userSelect: string } | null>(null);
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);
  onResizeRef.current = onResize;
  onResizeEndRef.current = onResizeEnd;

  const cleanup = useCallback(() => {
    const hadActiveDrag = dragRef.current !== null || endListenerRef.current !== null;
    dragRef.current = null;
    if (moveListenerRef.current) {
      window.removeEventListener("pointermove", moveListenerRef.current);
      moveListenerRef.current = null;
    }
    if (endListenerRef.current) {
      window.removeEventListener("pointerup", endListenerRef.current);
      window.removeEventListener("pointercancel", endListenerRef.current);
      endListenerRef.current = null;
    }
    const restore = restoreBodyRef.current;
    restoreBodyRef.current = null;
    if (restore) {
      document.body.style.cursor = restore.cursor;
      document.body.style.userSelect = restore.userSelect;
    }
    if (hadActiveDrag) onResizeEndRef.current?.();
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cleanup();
    dragRef.current = { startX: event.clientX, startWidth: width };
    restoreBodyRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    onResizeStart?.();

    const move = (moveEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      onResizeRef.current(
        clampPanelWidth(drag.startWidth + moveEvent.clientX - drag.startX, minWidth, maxWidth),
      );
    };
    const end = () => cleanup();
    moveListenerRef.current = move;
    endListenerRef.current = end;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = width - step;
    else if (event.key === "ArrowRight") next = width + step;
    else if (event.key === "Home") next = minWidth;
    else if (event.key === "End") next = maxWidth;
    if (next === null) return;
    event.preventDefault();
    onResize(clampPanelWidth(next, minWidth, maxWidth));
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · Arrow keys resize · Double-click resets"
      data-tauri-drag-region={false}
      className="pc-panel-resizer"
      onPointerDown={startDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(defaultWidth)}
    >
      <span aria-hidden="true" />
    </div>
  );
}
