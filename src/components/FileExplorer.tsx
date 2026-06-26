import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store/store";
import * as ipc from "../lib/ipc";
import type { DirEntry } from "../types";

export function FileExplorer() {
  const workspace = useStore((s) => s.settings.workspace);
  const openWorkspace = useStore((s) => s.openWorkspace);
  const workspaceError = useStore((s) => s.workspaceError);
  const toggleFiles = useStore((s) => s.toggleFiles);
  const [roots, setRoots] = useState<DirEntry[]>([]);
  // Roving-tabindex active row: the path of the single treeitem that holds
  // tabIndex 0. Null until the user focuses a row, so the first root keeps the
  // default tab stop. One tab stop into the tree; arrow keys move within it.
  const [activePath, setActivePath] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    // The prior workspace's active row no longer exists; drop it so the new
    // tree's first root reclaims the default tab stop.
    setActivePath(null);
    ipc
      .listDir(undefined)
      .then((r) => {
        if (alive) setRoots(r);
      })
      .catch(() => {
        // A failed scan (no workspace, permissions, backend error) resolves to
        // the empty state instead of hanging on a blank view / unhandled reject.
        if (alive) setRoots([]);
      });
    return () => {
      alive = false;
    };
  }, [workspace]);

  // Keyboard model for the ARIA tree pattern, driven off the live DOM: the rows
  // are queried in document order each keypress, so navigation always reflects
  // the current expanded shape without a parallel registry to keep in sync.
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const tree = treeRef.current;
    if (!tree) return;
    // Collapsed folders keep their children mounted (so the accordion can animate
    // shut) but mark them aria-hidden; exclude those rows so arrow nav never lands
    // focus on an invisible row inside an aria-hidden subtree.
    const rows = [...tree.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].filter(
      (r) => !r.closest('[aria-hidden="true"]'),
    );
    if (rows.length === 0) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    // Focus on the container itself (tabbed in, not yet on a row) starts at the
    // first row for the next move.
    const idx = current === -1 ? 0 : current;
    const focusRow = (row: HTMLButtonElement | undefined) => {
      if (!row) return;
      setActivePath(row.dataset.path ?? null);
      row.focus();
    };
    const row = rows[idx];
    const isDir = row?.getAttribute("aria-expanded") !== null;
    const isOpen = row?.getAttribute("aria-expanded") === "true";
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRow(rows[Math.min(idx + 1, rows.length - 1)]);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusRow(rows[Math.max(idx - 1, 0)]);
        break;
      case "ArrowRight":
        e.preventDefault();
        // Closed dir → expand; already-open dir → step into its first child.
        if (isDir && !isOpen) row.click();
        else if (isDir && isOpen) focusRow(rows[Math.min(idx + 1, rows.length - 1)]);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (isDir && isOpen) row.click();
        break;
      case "Home":
        e.preventDefault();
        focusRow(rows[0]);
        break;
      case "End":
        e.preventDefault();
        focusRow(rows[rows.length - 1]);
        break;
    }
  }, []);

  // Exactly one treeitem must carry tabIndex 0. Honour an explicit focus choice;
  // otherwise default to the first root so the tree stays keyboard-reachable.
  const activeRow = activePath ?? roots[0]?.path ?? null;

  return (
    <aside
      aria-label="File explorer"
      className="flex h-full w-[236px] shrink-0 flex-col border-r border-border bg-panel/80"
    >
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-[11px]">
        <span
          className="pc-eyebrow-mono text-[9.5px] tracking-[2px] text-accent-2"
          style={{ filter: "drop-shadow(0 0 6px rgba(33, 230, 255, 0.55))" }}
        >
          ◧ PORTCODE
        </span>
        <button
          onClick={() => void openWorkspace()}
          className="ml-auto font-mono text-[10px] text-faint hover:text-accent-2"
          title="Open folder"
          aria-label="Open folder"
        >
          OPEN…
        </button>
        {/* The explorer can now be dismissed from its own header, not just the
            main-header folder toggle — both flip the same `filesOpen` flag. */}
        <button
          onClick={toggleFiles}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint transition-colors hover:bg-danger/10 hover:text-danger motion-reduce:transition-none"
          title="Close file explorer"
          aria-label="Close file explorer"
        >
          ✕
        </button>
      </div>
      {workspaceError && (
        <p
          role="alert"
          className="flex items-start gap-1.5 border-b border-border px-3.5 py-2 text-[11px] text-danger"
        >
          <span aria-hidden="true">⚠</span>
          <span>Couldn’t open folder: {workspaceError}</span>
        </p>
      )}
      <div
        ref={treeRef}
        role="tree"
        aria-label="File tree"
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto py-1.5 font-mono text-[12px]"
      >
        {roots.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted">
            No workspace set
            <br />
            <span className="text-faint">Pick a folder to start browsing.</span>
            <br />
            <button
              onClick={() => void openWorkspace()}
              className="pc-btn-ghost mt-2 px-2 py-1 text-[11px]"
            >
              Open a folder
            </button>
          </div>
        ) : (
          // Key the rendered roots by workspace so a workspace switch remounts
          // every TreeNode, clearing stale open/children state from a prior
          // workspace whose paths could collide with the new one. A Fragment
          // (not a wrapper <div>) keeps role="tree" the direct parent of the
          // root treeitems, as the ARIA tree pattern requires.
          <Fragment key={workspace ?? "__none__"}>
            {roots.map((e) => (
              <TreeNode
                key={e.path}
                entry={e}
                depth={0}
                activeRow={activeRow}
                onActivate={setActivePath}
              />
            ))}
          </Fragment>
        )}
      </div>
    </aside>
  );
}

function TreeNode({
  entry,
  depth,
  activeRow,
  onActivate,
}: {
  entry: DirEntry;
  depth: number;
  activeRow: string | null;
  onActivate: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  // Synchronous in-flight guard: a ref (not state) so a second toggle in the
  // same tick sees the latest value and cannot fire a duplicate listDir while
  // the first is still pending.
  const loading = useRef(false);
  const appendDraft = useStore((s) => s.appendDraft);

  const toggle = async () => {
    if (entry.isDir) {
      const next = !open;
      setOpen(next);
      if (next && children === null && !loading.current) {
        loading.current = true;
        try {
          setChildren(await ipc.listDir(entry.path));
        } catch {
          // A failed expand (permissions, backend error) must not leak an
          // unhandled rejection or leave a stuck-open caret with no children:
          // settle on an empty listing and collapse back to the closed state.
          setChildren([]);
          setOpen(false);
        } finally {
          loading.current = false;
        }
      }
    } else {
      appendDraft(entry.path);
    }
  };

  const glyph = entry.isDir ? null : fileGlyph(entry.name);
  const rowColor = entry.isDir ? "text-fg" : (glyph!.rowClass ?? "text-muted");

  return (
    <div>
      <button
        onClick={() => void toggle()}
        onFocus={() => onActivate(entry.path)}
        role="treeitem"
        data-path={entry.path}
        aria-expanded={entry.isDir ? open : undefined}
        aria-level={depth + 1}
        aria-label={entry.isDir ? `${entry.name} folder` : entry.name}
        // Roving tabindex: only the active row is a tab stop; arrow keys move
        // the active row within that single stop.
        tabIndex={activeRow === entry.path ? 0 : -1}
        className={`pc-row--file flex w-full items-center gap-1.5 py-1 pr-2 text-left ${rowColor}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        title={entry.isDir ? entry.name : `Insert ${entry.path} into composer`}
      >
        {entry.isDir ? (
          <span aria-hidden="true" className="w-3 shrink-0 text-[10px] text-faint">
            {open ? "▾" : "▸"}
          </span>
        ) : (
          <span aria-hidden="true" className="w-3 shrink-0" />
        )}
        {entry.isDir ? (
          <span aria-hidden="true" className="inline-flex w-4 shrink-0 justify-center text-warn">
            {open ? "▢" : "▣"}
          </span>
        ) : (
          <span
            aria-hidden="true"
            className={`inline-flex w-4 shrink-0 justify-center ${glyph!.colorClass}`}
          >
            {glyph!.glyph}
          </span>
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {/* Smooth expand/collapse via the same grid 0fr->1fr accordion the app uses
          for ToolCall bodies and the file rail (the overflow-hidden child shrinks
          to 0). children stays null until first expand, so the group mounts only
          once data exists, then animates on every subsequent toggle. */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          {children && (
            // The expandable treeitem owns its contents via a child role="group",
            // so AT reports the parent/child level the aria-expanded above implies.
            // Once opened the group persists while collapsed (to animate), so
            // aria-hidden drops it from AT when the directory is closed.
            <div role="group" aria-hidden={!open || undefined}>
              {children.map((c) => (
                <TreeNode
                  key={c.path}
                  entry={c}
                  depth={depth + 1}
                  activeRow={activeRow}
                  onActivate={onActivate}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface FileType {
  glyph: string;
  /** color for the leading type-glyph */
  colorClass: string;
  /** optional override for the whole row's text color (e.g. .rs → amber) */
  rowClass?: string;
}

function fileGlyph(name: string): FileType {
  if (/\.tsx$/.test(name)) return { glyph: "◆", colorClass: "text-accent-2" };
  if (/\.ts$/.test(name)) return { glyph: "◆", colorClass: "text-success" };
  if (/\.css$/.test(name)) return { glyph: "◆", colorClass: "text-accent" };
  if (/\.rs$/.test(name)) return { glyph: "🦀", colorClass: "text-warn", rowClass: "text-warn" };
  return { glyph: "◇", colorClass: "text-faint" };
}
