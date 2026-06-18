import { useEffect, useState } from "react";
import { useStore } from "../store/store";
import * as ipc from "../lib/ipc";
import type { DirEntry } from "../types";

export function FileExplorer() {
  const workspace = useStore((s) => s.settings.workspace);
  const openWorkspace = useStore((s) => s.openWorkspace);
  const [roots, setRoots] = useState<DirEntry[]>([]);

  useEffect(() => {
    let alive = true;
    ipc.listDir(undefined).then((r) => {
      if (alive) setRoots(r);
    });
    return () => {
      alive = false;
    };
  }, [workspace]);

  const name = workspace ? workspace.replace(/[/\\]+$/, "").split(/[/\\]/).pop() : null;

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="truncate text-xs font-medium uppercase tracking-wide text-muted">
          {name ?? "Explorer"}
        </span>
        <button
          onClick={() => void openWorkspace()}
          className="ml-auto rounded px-2 py-1 text-xs text-muted hover:bg-panel-2 hover:text-fg"
          title="Open folder"
        >
          Open…
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {roots.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted">
            No files. <br />
            <button
              onClick={() => void openWorkspace()}
              className="mt-2 rounded border border-border px-2 py-1 hover:border-accent hover:text-accent"
            >
              Open a folder
            </button>
          </div>
        ) : (
          roots.map((e) => <TreeNode key={e.path} entry={e} depth={0} />)
        )}
      </div>
    </aside>
  );
}

function TreeNode({ entry, depth }: { entry: DirEntry; depth: number }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const appendDraft = useStore((s) => s.appendDraft);

  const toggle = async () => {
    if (entry.isDir) {
      const next = !open;
      setOpen(next);
      if (next && children === null) {
        setChildren(await ipc.listDir(entry.path));
      }
    } else {
      appendDraft(entry.path);
    }
  };

  return (
    <div>
      <button
        onClick={() => void toggle()}
        className="flex w-full items-center gap-1 py-1 pr-2 text-left text-[13px] text-muted hover:bg-panel-2 hover:text-fg"
        style={{ paddingLeft: 8 + depth * 12 }}
        title={entry.isDir ? entry.name : `Insert ${entry.path} into composer`}
      >
        {entry.isDir ? (
          <span className="w-3 shrink-0 text-[10px]">{open ? "▾" : "▸"}</span>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="shrink-0">{entry.isDir ? "📁" : fileGlyph(entry.name)}</span>
        <span className="truncate">{entry.name}</span>
      </button>
      {open &&
        children?.map((c) => <TreeNode key={c.path} entry={c} depth={depth + 1} />)}
    </div>
  );
}

function fileGlyph(name: string): string {
  if (/\.(rs)$/.test(name)) return "🦀";
  if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) return "📜";
  if (/\.(json|toml|lock)$/.test(name)) return "⚙️";
  if (/\.(md|txt)$/.test(name)) return "📄";
  if (/\.(css|scss)$/.test(name)) return "🎨";
  return "📄";
}
