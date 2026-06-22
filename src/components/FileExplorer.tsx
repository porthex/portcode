import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/store";
import * as ipc from "../lib/ipc";
import type { DirEntry } from "../types";

export function FileExplorer() {
  const workspace = useStore((s) => s.settings.workspace);
  const openWorkspace = useStore((s) => s.openWorkspace);
  const workspaceError = useStore((s) => s.workspaceError);
  const [roots, setRoots] = useState<DirEntry[]>([]);

  useEffect(() => {
    let alive = true;
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
        role="tree"
        aria-label="File tree"
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
          // workspace whose paths could collide with the new one.
          <div key={workspace ?? "__none__"}>
            {roots.map((e) => (
              <TreeNode key={e.path} entry={e} depth={0} />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function TreeNode({ entry, depth }: { entry: DirEntry; depth: number }) {
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
        role="treeitem"
        aria-expanded={entry.isDir ? open : undefined}
        aria-label={entry.isDir ? `${entry.name} folder` : entry.name}
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
            ▸
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
      {open && children?.map((c) => <TreeNode key={c.path} entry={c} depth={depth + 1} />)}
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
