import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";

import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { isTauri } from "../lib/ipc";
import {
  buildSidebarRows,
  deriveStatus,
  sortSessions,
  workspaceLabel,
  type SidebarRow,
} from "../lib/sessionView";
import { useStore } from "../store/store";
import type { Session, SessionFolder, SessionGroup, SessionSort, SessionStatus } from "../types";

const SORT_OPTIONS: { value: SessionSort; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
  { value: "status", label: "Status" },
];
const GROUP_OPTIONS: { value: SessionGroup; label: string }[] = [
  { value: "none", label: "None" },
  { value: "status", label: "Status" },
  { value: "branch", label: "Branch" },
  { value: "workspace", label: "Workspace" },
];

/** Drag-and-drop "where would this land" relative to a hovered row. */
type DropHint = { id: string; place: "before" | "after" };

/** Compute whether a drop on `el` lands before or after it, from the pointer Y. */
function dropPlace(clientY: number, el: HTMLElement): "before" | "after" {
  const rect = el.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

/** The sessions sidebar. A width-animated shell morphs between the full 248px
 *  panel and the slim 52px rail (the swapped content cross-fades in); the mobile
 *  drawer passes `collapsible={false}` so it always shows the panel. */
export function Sidebar({ collapsible = true }: { collapsible?: boolean }) {
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const isCollapsed = collapsible && sidebarCollapsed;
  return (
    <div
      className="relative h-full shrink-0 overflow-hidden border-r border-border bg-panel transition-[width] duration-200 ease-out motion-reduce:transition-none"
      style={{ width: isCollapsed ? 52 : 248 }}
    >
      {isCollapsed ? <SessionRail /> : <SessionPanel collapsible={collapsible} />}
    </div>
  );
}

function SessionPanel({ collapsible }: { collapsible: boolean }) {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const streaming = useStore((s) => s.streaming);
  const remoteConnected = useStore((s) => s.remoteConnected);
  const newSession = useStore((s) => s.newSession);
  const selectSession = useStore((s) => s.selectSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const renameSession = useStore((s) => s.renameSession);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const settings = useStore((s) => s.settings);
  const oauthStatus = useStore((s) => s.oauthStatus);

  const sortBy = useStore((s) => s.sortBy);
  const groupBy = useStore((s) => s.groupBy);
  const folders = useStore((s) => s.folders);
  const folderOf = useStore((s) => s.folderOf);
  const archivedIds = useStore((s) => s.archivedIds);
  const manualOrder = useStore((s) => s.manualOrder);
  const setSortBy = useStore((s) => s.setSortBy);
  const setGroupBy = useStore((s) => s.setGroupBy);
  const setManualOrder = useStore((s) => s.setManualOrder);
  const addFolder = useStore((s) => s.addFolder);
  const toggleFolder = useStore((s) => s.toggleFolder);
  const renameFolder = useStore((s) => s.renameFolder);
  const deleteFolder = useStore((s) => s.deleteFolder);
  const moveSessionToFolder = useStore((s) => s.moveSessionToFolder);
  const toggleArchived = useStore((s) => s.toggleArchived);
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed);

  const signedInClaude = !!oauthStatus?.signedIn;
  const authed = signedInClaude || settings.apiKeySet;
  const authTitle = signedInClaude
    ? "Signed in with Claude"
    : settings.apiKeySet
      ? "API key set"
      : "Not authenticated";

  // Which sort/group popover is open (transient, instance-local). Only one at a time.
  const [menu, setMenu] = useState<"sort" | "group" | null>(null);
  // Inline folder rename: the folder being edited + its draft name. A ref carries
  // an Escape "cancel" intent across the unmount→blur edge (the blur handler's
  // closure would otherwise still see itself as editing and commit).
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const renameCancelled = useRef(false);
  // Inline session rename (grafted from the Claude-Code-parity work, whose backend
  // — renameSession/ipc.renameSession/the rename_session command — already landed
  // on this branch but whose UI trigger was dropped in the merge). `editingId` is
  // the row showing the editor; `draft` its working title. `editingRef` mirrors the
  // editing id synchronously so the trailing blur fired as the input unmounts is
  // absorbed (a stale closure would otherwise re-commit). `refocusRef` carries the
  // id whose select button should regain focus once the editor closes.
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const editingRef = useRef<string | null>(null);
  const refocusRef = useRef<string | null>(null);
  // Renames are a desktop-local DB write with no remote equivalent, and (like the
  // sibling row actions) are never allowed mid-turn — so the affordance is hidden
  // in both states. The store action guards these too; this just keeps the UI honest.
  const canRename = !streaming && !remoteConnected;
  // The folder currently under a dragged chat (drop-target highlight).
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  // Where a drag-reorder would drop, for the insertion-line indicator.
  const [dropHint, setDropHint] = useState<DropHint | null>(null);

  // Right-click context menus for session + folder rows (and the empty list area).
  const { onContextMenu, menu: ctxMenu } = useContextMenu();

  const archived = useMemo(() => new Set(archivedIds), [archivedIds]);
  const { rows, visible } = useMemo(
    () =>
      buildSidebarRows({
        sessions,
        activeId,
        streaming,
        sortBy,
        groupBy,
        folders,
        folderOf,
        archived,
        manualOrder,
      }),
    [sessions, activeId, streaming, sortBy, groupBy, folders, folderOf, archived, manualOrder],
  );

  // Exactly one session row is a tab stop: the active session when it's visible,
  // else the first visible row (mirrors the file tree's roving tabindex).
  const tabStopId =
    activeId !== null && visible.some((s) => s.id === activeId)
      ? activeId
      : (visible[0]?.id ?? null);

  // Roving-tabindex stops for arrow-key navigation, indexed by position in the
  // flat `visible` list (so nav follows the on-screen order, not raw insertion).
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // ── Inline session rename handlers ─────────────────────────────────────────
  const beginEdit = (s: Session) => {
    if (!canRename) return;
    editingRef.current = s.id;
    setEditingSessionId(s.id);
    setDraft(s.title);
  };
  // Close the editor exactly once (the ref guard absorbs the unmount blur),
  // optionally committing the draft, and queue focus back to the edited row.
  const closeEditor = (commit: boolean) => {
    const id = editingRef.current;
    if (id === null) return; // already closed → ignore a trailing blur
    editingRef.current = null;
    refocusRef.current = id;
    if (commit) void renameSession(id, draft);
    setEditingSessionId(null);
  };
  const commitEdit = () => closeEditor(true);
  const cancelEdit = () => closeEditor(false);
  const onEditKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
    // Keep arrows/Home/End local so the list's roving-nav doesn't fire while editing.
    e.stopPropagation();
  };
  // When the editor closes, return focus to the edited row's select button (the
  // input has unmounted by now, so this runs post-render). Adapted from parity's
  // `sessions.findIndex(...)`: this sidebar keys `rowRefs` by the FLATTENED VISIBLE
  // row order (each session row's `navIndex` === its index in `visible`), so we
  // refocus by the row's position in `visible`, not in the raw `sessions` array
  // (which would point at the wrong slot once folders/grouping reorder the list).
  useEffect(() => {
    if (editingSessionId !== null || refocusRef.current === null) return;
    const idx = visible.findIndex((s) => s.id === refocusRef.current);
    refocusRef.current = null;
    if (idx >= 0) rowRefs.current[idx]?.focus();
  }, [editingSessionId, visible]);

  const onListKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (streaming || visible.length === 0) return;
    const current = visible.findIndex((s) => s.id === activeId);
    const from = current === -1 ? 0 : current;
    let next: number;
    switch (e.key) {
      case "ArrowDown":
        next = Math.min(from + 1, visible.length - 1);
        break;
      case "ArrowUp":
        next = Math.max(from - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = visible.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    void selectSession(visible[next].id);
    rowRefs.current[next]?.focus();
  };

  const closeMenu = () => setMenu(null);

  const startRename = (id: string, name: string) => {
    renameCancelled.current = false;
    setEditingFolderId(id);
    setEditingName(name);
  };
  // Single commit path (blur). Enter blurs to commit; Escape sets the cancel ref
  // then blurs, so this no-ops and just tears the editor down.
  const commitRename = (id: string) => {
    if (renameCancelled.current) {
      renameCancelled.current = false;
    } else {
      renameFolder(id, editingName);
    }
    setEditingFolderId(null);
  };

  // A chat dropped onto a folder (or the loose root) moves there. The chat id
  // rides in a custom MIME so unrelated drags can't hijack the list.
  const draggedSessionId = (e: DragEvent): string => e.dataTransfer.getData("text/pc-session");

  // Drop a dragged chat next to `target`: it joins the target's folder/loose AND
  // the list switches to manual order with the chat spliced in beside the target.
  // This is the "reorder (sort by goes off) / move to other group" gesture.
  const reorder = (draggedId: string, target: Session, place: "before" | "after"): void => {
    if (!draggedId || draggedId === target.id) return;
    const statusOf = (id: string): SessionStatus => deriveStatus(id, activeId, streaming, archived);
    const order = sortSessions(sessions, sortBy, statusOf, manualOrder)
      .map((s) => s.id)
      .filter((id) => id !== draggedId);
    const ti = order.indexOf(target.id);
    if (ti === -1) return;
    const at = place === "before" ? ti : ti + 1;
    const next = [...order.slice(0, at), draggedId, ...order.slice(at)];
    moveSessionToFolder(draggedId, folderOf[target.id] ?? null);
    setManualOrder(next);
  };

  // Right-click items for a session row. Mutating actions are disabled while a turn
  // streams (mirrors the per-row button guards). "Move to folder" is a flat section
  // (a heading + one item per folder) so there's no submenu risk; "Remove from
  // folder" only appears when the chat is in one.
  const sessionMenuItems = (s: Session, status: SessionStatus): ContextMenuItem[] => {
    const inFolder = folderOf[s.id] ?? null;
    const items: ContextMenuItem[] = [
      {
        label: "New chat",
        icon: <PlusGlyph />,
        onSelect: () => void newSession(),
        disabled: streaming,
      },
      {
        label: status === "archived" ? "Unarchive" : "Archive",
        icon: <ArchiveIcon />,
        onSelect: () => toggleArchived(s.id),
        disabled: streaming,
      },
    ];
    // Move-to-folder section: only meaningful in the manual (folder) mode.
    if (groupBy === "none" && folders.length > 0) {
      let first = true;
      for (const f of folders) {
        items.push({
          label: f.name,
          icon: <FolderGlyph />,
          headingBefore: first ? "Move to folder" : undefined,
          separatorBefore: first || undefined,
          onSelect: () => moveSessionToFolder(s.id, f.id),
          disabled: inFolder === f.id,
        });
        first = false;
      }
      if (inFolder !== null) {
        items.push({
          label: "Remove from folder",
          icon: <RemoveFolderGlyph />,
          onSelect: () => moveSessionToFolder(s.id, null),
        });
      }
    }
    items.push({
      label: "Delete",
      icon: <TrashGlyph />,
      danger: true,
      separatorBefore: true,
      onSelect: () => void deleteSession(s.id),
      disabled: streaming,
    });
    return items;
  };

  // Right-click items for a folder row.
  const folderMenuItems = (folder: SessionFolder): ContextMenuItem[] => [
    { label: "New folder", icon: <NewFolderIcon />, onSelect: () => addFolder() },
    { label: "Rename", icon: <RenameGlyph />, onSelect: () => startRename(folder.id, folder.name) },
    {
      label: "Delete folder",
      icon: <TrashGlyph />,
      danger: true,
      separatorBefore: true,
      onSelect: () => deleteFolder(folder.id),
    },
  ];

  // Right-click items for the empty list background (loose area / no row hit).
  const listMenuItems = (): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      {
        label: "New chat",
        icon: <PlusGlyph />,
        onSelect: () => void newSession(),
        disabled: streaming,
      },
    ];
    if (groupBy === "none") {
      items.push({ label: "New folder", icon: <NewFolderIcon />, onSelect: () => addFolder() });
    }
    return items;
  };

  // ── Row renderers (close over the handlers above; one element per SidebarRow) ──
  const renderRow = (row: SidebarRow) => {
    switch (row.kind) {
      case "groupHeader":
        return (
          <div key={`h:${row.key}`} className="pc-group-head" role="presentation">
            <span className="pc-group-head__label">{row.label}</span>
            <span className="pc-count">{row.count}</span>
            <span className="pc-group-head__rule" aria-hidden="true" />
          </div>
        );
      case "folderEmpty":
        return (
          <div key={`e:${row.folderId}`} className="pc-folder-children">
            <div className="pc-folder-empty">empty · move chats here</div>
          </div>
        );
      case "folder":
        return renderFolder(row);
      case "session":
        return renderSession(row);
    }
  };

  const renderFolder = (row: Extract<SidebarRow, { kind: "folder" }>) => {
    const { folder, count } = row;
    const editing = editingFolderId === folder.id;
    const dragOver = dragOverFolderId === folder.id;
    return (
      <div
        key={`f:${folder.id}`}
        className={`pc-row group rounded-lg px-2 py-1.5 ${dragOver ? "pc-droptarget" : ""}`}
        onContextMenu={onContextMenu(folderMenuItems(folder))}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOverFolderId(folder.id);
        }}
        onDragLeave={() => setDragOverFolderId((cur) => (cur === folder.id ? null : cur))}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation(); // don't also bubble to the loose-root drop handler
          const id = draggedSessionId(e);
          if (id) moveSessionToFolder(id, folder.id);
          setDragOverFolderId(null);
        }}
      >
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => toggleFolder(folder.id)}
            aria-expanded={folder.open}
            aria-label={`${folder.name} folder, ${count} ${count === 1 ? "chat" : "chats"}`}
            className="flex shrink-0 items-center gap-1.5 text-left"
          >
            <span aria-hidden="true" className="w-3 text-[10px] text-faint">
              {folder.open ? "▾" : "▸"}
            </span>
            <span aria-hidden="true" className="inline-flex w-4 justify-center text-warn">
              {folder.open ? "▢" : "▣"}
            </span>
          </button>
          {editing ? (
            <input
              autoFocus
              value={editingName}
              aria-label="Folder name"
              onChange={(e) => setEditingName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  renameCancelled.current = true;
                  e.currentTarget.blur();
                }
              }}
              onBlur={() => commitRename(folder.id)}
              className="min-w-0 flex-1 rounded border border-accent-2/40 bg-panel-2 px-1.5 py-0.5 text-[13px] text-fg outline-none"
            />
          ) : (
            <button
              onClick={() => toggleFolder(folder.id)}
              onDoubleClick={() => startRename(folder.id, folder.name)}
              className="min-w-0 flex-1 truncate text-left text-[13px] text-fg"
              title="Double-click to rename"
            >
              {folder.name}
            </button>
          )}
          <span className="pc-count shrink-0">{count}</span>
          <button
            onClick={() => deleteFolder(folder.id)}
            aria-label={`Delete folder: ${folder.name}`}
            title="Delete folder (chats move out)"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
          >
            ✕
          </button>
        </div>
      </div>
    );
  };

  const renderSession = (row: Extract<SidebarRow, { kind: "session" }>) => {
    const { session: s, status, navIndex, indented } = row;
    const active = s.id === activeId;
    const isTabStop = s.id === tabStopId;
    const isArchived = status === "archived" && !active;
    // Reorder + folder DnD only applies in the manual ("none") mode; the auto
    // groupings derive their order, so rows aren't draggable there.
    const reorderable = groupBy === "none" && !streaming;
    // The ⎇ glyph names the real git branch when known (its true meaning); the
    // workspace folder rides alongside. Falls back to just the workspace when the
    // session isn't in a git repo.
    const meta = s.branch
      ? `${s.branch} · ${workspaceLabel(s.workspace)}`
      : workspaceLabel(s.workspace);
    const rowEl = (
      <div
        key={s.id}
        draggable={reorderable}
        onContextMenu={onContextMenu(sessionMenuItems(s, status))}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/pc-session", s.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          setDropHint(null);
          setDragOverFolderId(null);
        }}
        onDragOver={
          reorderable
            ? (e) => {
                e.preventDefault();
                setDropHint({ id: s.id, place: dropPlace(e.clientY, e.currentTarget) });
              }
            : undefined
        }
        onDragLeave={
          reorderable ? () => setDropHint((cur) => (cur?.id === s.id ? null : cur)) : undefined
        }
        onDrop={
          reorderable
            ? (e) => {
                e.preventDefault();
                e.stopPropagation(); // reorder wins over the loose-root drop
                reorder(draggedSessionId(e), s, dropPlace(e.clientY, e.currentTarget));
                setDropHint(null);
              }
            : undefined
        }
        className={
          (active
            ? "group rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 shadow-[inset_0_0_14px_rgba(255,46,126,0.12)] transition-[background-color,border-color,box-shadow,color] duration-150 ease-out motion-reduce:transition-none"
            : "pc-row group rounded-lg px-3 py-2") +
          (isArchived ? " pc-row--archived" : "") +
          (dropHint?.id === s.id ? ` pc-drop-line pc-drop-line--${dropHint.place}` : "")
        }
      >
        <div className="flex items-center">
          {reorderable && (
            // Explicit drag handle. The title is a full-width <button>, and
            // Chromium/WebView2 won't reliably start the parent row's native
            // drag when the press lands on a nested interactive <button> — so
            // grabbing a chat by its title (the obvious target) did nothing.
            // This non-button grip is an unambiguous drag surface: it carries
            // its own draggable/onDragStart so the gesture always initiates,
            // and stops the event bubbling so the row's handler doesn't re-fire.
            <span
              draggable
              onDragStart={(e) => {
                e.stopPropagation();
                e.dataTransfer.setData("text/pc-session", s.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                setDropHint(null);
                setDragOverFolderId(null);
              }}
              aria-hidden="true"
              title="Drag to reorder or move into a folder"
              className="pc-drag-handle -ml-1 mr-0.5 flex h-6 w-3.5 shrink-0 items-center justify-center text-faint opacity-0 transition-opacity group-hover:opacity-100"
            >
              ⠿
            </span>
          )}
          {editingSessionId === s.id ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditKeyDown}
              onBlur={commitEdit}
              aria-label={`Rename session: ${s.title}`}
              className="min-w-0 flex-1 rounded border border-accent/40 bg-panel-2 px-2 py-1 text-[13px] text-fg outline-none focus:border-accent"
            />
          ) : (
            <button
              ref={(el) => {
                rowRefs.current[navIndex] = el;
              }}
              onClick={() => selectSession(s.id)}
              onDoubleClick={() => beginEdit(s)}
              disabled={streaming}
              tabIndex={isTabStop ? 0 : -1}
              aria-current={active ? "true" : undefined}
              className={`flex min-w-0 flex-1 flex-col text-left ${
                streaming ? "cursor-not-allowed" : ""
              }`}
              title={streaming ? "Finish or stop the current turn first" : s.title}
            >
              <span className="relative flex items-center">
                <RowIndicator status={status} active={active} />
                <span
                  className={`truncate pl-3 text-[13px] ${
                    active ? "text-fg" : isArchived ? "text-faint" : "text-muted"
                  }`}
                >
                  {s.title}
                </span>
              </span>
              <span
                className={`truncate pl-3 font-mono text-[10.5px] ${
                  active ? "text-muted" : "text-faint"
                }`}
              >
                <span aria-hidden="true">⎇</span> {meta} · {relativeTime(s.updatedAt)}
              </span>
            </button>
          )}
          {canRename && editingSessionId !== s.id && (
            <button
              onClick={() => beginEdit(s)}
              tabIndex={isTabStop ? 0 : -1}
              className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint opacity-0 transition-opacity hover:bg-accent/10 hover:text-accent group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
              aria-label={`Rename session: ${s.title}`}
              title="Rename session"
            >
              <RenameGlyph />
            </button>
          )}
          {/* Row actions collapse to just the editor while this row is being renamed. */}
          {editingSessionId !== s.id && (
            <>
              <button
                onClick={() => toggleArchived(s.id)}
                disabled={streaming}
                tabIndex={isTabStop ? 0 : -1}
                className={`ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint opacity-0 transition-opacity hover:bg-accent-2/10 hover:text-accent-2 group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none ${
                  streaming ? "cursor-not-allowed opacity-50" : ""
                }`}
                aria-label={`${status === "archived" ? "Unarchive" : "Archive"} session: ${s.title}`}
                title={
                  streaming
                    ? "Finish or stop the current turn first"
                    : status === "archived"
                      ? "Unarchive"
                      : "Archive"
                }
              >
                <ArchiveIcon />
              </button>
              <button
                onClick={() => deleteSession(s.id)}
                disabled={streaming}
                tabIndex={isTabStop ? 0 : -1}
                className={`ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none ${
                  streaming ? "cursor-not-allowed opacity-50" : ""
                }`}
                aria-label={`Delete session: ${s.title}`}
                title={streaming ? "Finish or stop the current turn first" : "Delete session"}
              >
                ✕
              </button>
            </>
          )}
        </div>
      </div>
    );
    return indented ? (
      <div key={`i:${s.id}`} className="pc-folder-children">
        {rowEl}
      </div>
    ) : (
      rowEl
    );
  };

  // "manual" isn't a pickable preset — it's entered by drag-reordering — so it
  // isn't in SORT_OPTIONS; label it explicitly when active.
  const sortLabel =
    sortBy === "manual"
      ? "Manual"
      : (SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? "Recent");
  const groupLabel = GROUP_OPTIONS.find((o) => o.value === groupBy)?.label ?? "None";

  return (
    <aside aria-label="Sessions" className="pc-fade-in flex h-full w-[248px] flex-col">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-accent/60 bg-gradient-to-br from-accent/30 to-accent-2/25 shadow-[0_0_14px_rgba(255,46,126,0.4)]">
          <Logo />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="pc-wordmark pc-wordmark--glitch">PORTCODE</span>
          <span className="pc-eyebrow-mono text-[10px]">PORTHEX · v0.3.1-α</span>
        </div>
        {collapsible && (
          <button
            onClick={() => {
              setMenu(null);
              setSidebarCollapsed(true);
            }}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-faint transition-colors hover:border-border-2 hover:text-accent-2"
          >
            <CollapseIcon />
          </button>
        )}
      </div>

      {/* New session */}
      <div className="px-3 pb-2">
        <button
          onClick={newSession}
          disabled={streaming}
          title={streaming ? "Finish or stop the current turn first" : undefined}
          className={`pc-newsession ${streaming ? "cursor-not-allowed opacity-50" : ""}`}
        >
          <span className="text-[15px] leading-none">+</span>
          NEW SESSION
        </button>
      </div>

      {/* SESSIONS toolbar: label + total count, then New-folder / Sort / Group */}
      <div className="relative px-3 pb-1.5 pt-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10.5px] uppercase tracking-[2px] text-faint">
            Sessions
          </span>
          <span className="pc-count" aria-hidden="true">
            {sessions.length}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {groupBy === "none" && (
              <button
                onClick={() => {
                  setMenu(null);
                  addFolder();
                }}
                aria-label="New folder"
                title="New folder"
                className="pc-sess-ctrl"
              >
                <NewFolderIcon />
              </button>
            )}
            <button
              onClick={() => setMenu((m) => (m === "sort" ? null : "sort"))}
              aria-haspopup="menu"
              aria-expanded={menu === "sort"}
              aria-label={`Sort sessions (${sortLabel})`}
              title="Sort"
              className={`pc-sess-ctrl ${menu === "sort" || sortBy !== "recent" ? "pc-sess-ctrl--active" : ""}`}
            >
              <SortIcon />
              {sortLabel}
            </button>
            <button
              onClick={() => setMenu((m) => (m === "group" ? null : "group"))}
              aria-haspopup="menu"
              aria-expanded={menu === "group"}
              aria-label={`Group sessions (${groupLabel})`}
              title="Group"
              className={`pc-sess-ctrl ${menu === "group" || groupBy !== "none" ? "pc-sess-ctrl--active" : ""}`}
            >
              <GroupIcon />
              {groupLabel}
            </button>
          </div>
        </div>

        {menu !== null && (
          // Full-viewport click-catcher: an outside click closes the open popover.
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={closeMenu}
            className="fixed inset-0 z-[15] cursor-default"
          />
        )}
        {menu === "sort" && (
          <PopMenu
            label="Sort sessions"
            value={sortBy}
            options={SORT_OPTIONS}
            onPick={(v) => {
              setSortBy(v);
              closeMenu();
            }}
          />
        )}
        {menu === "group" && (
          <PopMenu
            label="Group sessions"
            value={groupBy}
            options={GROUP_OPTIONS}
            onPick={(v) => {
              setGroupBy(v);
              closeMenu();
            }}
          />
        )}
      </div>

      {/* Session rows / folder tree */}
      <nav
        aria-label="Session list"
        onKeyDown={onListKeyDown}
        onContextMenu={onContextMenu(listMenuItems())}
        onDragOver={groupBy === "none" ? (e) => e.preventDefault() : undefined}
        onDrop={
          groupBy === "none"
            ? (e) => {
                // A drop that didn't land on a folder (folders stopPropagation)
                // moves the chat back to the loose root.
                const id = draggedSessionId(e);
                if (id) moveSessionToFolder(id, null);
              }
            : undefined
        }
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2"
      >
        {rows.map(renderRow)}
      </nav>

      {/* Footer */}
      <div className="border-t border-border p-3">
        <button
          onClick={() => setShowSettings(true)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted transition-colors hover:bg-panel-2 hover:text-fg"
        >
          <GearIcon />
          Settings
          {authed && (
            <span className="ml-auto flex items-center gap-1.5" title={authTitle}>
              <span className="font-mono text-[10px] tracking-wide text-success">
                {signedInClaude ? "CLAUDE" : "KEY SET"}
              </span>
              <span className="pc-dot pc-dot--ring" aria-hidden="true" />
            </span>
          )}
        </button>
        {/* Footer chrome — honest labels derived from real state, never fabricated
            telemetry: the live session count, the backend stack identity, and
            whether the native Rust core is attached vs the browser preview mock. */}
        <div className="mt-2 flex items-center justify-between gap-1.5 px-2 font-mono text-[9px] text-faint">
          <span className="whitespace-nowrap">
            <span aria-hidden="true">◴</span>{" "}
            {sessions.length === 1 ? "1 SESSION" : `${sessions.length} SESSIONS`}
          </span>
          <span className="truncate">RUST · TOKIO</span>
          <span className="whitespace-nowrap">
            <span aria-hidden="true">◉</span> {isTauri() ? "CORE" : "PREVIEW"}
          </span>
        </div>
      </div>
      {ctxMenu}
    </aside>
  );
}

/** The collapsed 52px rail: logo, expand, new session, count, spacer, settings,
 *  and the auth status dot. Two always-reachable affordances — collapse from the
 *  panel header, expand from here. */
function SessionRail() {
  const sessions = useStore((s) => s.sessions);
  const streaming = useStore((s) => s.streaming);
  const newSession = useStore((s) => s.newSession);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed);
  const settings = useStore((s) => s.settings);
  const oauthStatus = useStore((s) => s.oauthStatus);

  const authed = !!oauthStatus?.signedIn || settings.apiKeySet;
  const authTitle = oauthStatus?.signedIn
    ? "Signed in with Claude"
    : settings.apiKeySet
      ? "API key set"
      : "Not authenticated";

  return (
    <aside
      aria-label="Sessions"
      className="pc-fade-in flex h-full w-[52px] flex-col items-center gap-2 py-3"
    >
      <div className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-accent/60 bg-gradient-to-br from-accent/30 to-accent-2/25 shadow-[0_0_14px_rgba(255,46,126,0.4)]">
        <Logo />
      </div>
      <button
        onClick={() => setSidebarCollapsed(false)}
        aria-label="Expand sidebar"
        title="Expand sidebar"
        className="pc-rail-btn pc-rail-btn--cyan"
      >
        <ExpandIcon />
      </button>
      <button
        onClick={newSession}
        disabled={streaming}
        aria-label="New session"
        title={streaming ? "Finish or stop the current turn first" : "New session"}
        className={`pc-rail-btn pc-rail-btn--accent ${streaming ? "cursor-not-allowed opacity-50" : ""}`}
      >
        <span className="text-[17px] leading-none">+</span>
      </button>
      <span
        className="pc-count"
        title={`${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`}
        aria-label={`${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`}
      >
        {sessions.length}
      </span>
      <div className="flex-1" />
      <button
        onClick={() => setShowSettings(true)}
        aria-label="Settings"
        title="Settings"
        className="pc-rail-btn"
      >
        <GearIcon />
      </button>
      {authed && <span className="pc-dot pc-dot--ring" title={authTitle} aria-label={authTitle} />}
    </aside>
  );
}

/** A small listbox-style popover; the active option carries a cyan ✓ and
 *  aria-checked so state isn't conveyed by colour alone. */
function PopMenu<T extends string>({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onPick: (v: T) => void;
}) {
  return (
    <div className="pc-pop right-3 top-full mt-1" role="menu" aria-label={label}>
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            role="menuitemradio"
            aria-checked={checked}
            onClick={() => onPick(o.value)}
            className="pc-pop__item"
          >
            <span
              className="pc-pop__check"
              aria-hidden="true"
              style={{ visibility: checked ? "visible" : "hidden" }}
            >
              ✓
            </span>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The leading status indicator for a session row. Running (the open, streaming
 * session) gets a green pulsing dot; archived a dim box glyph; the open idle
 * session the magenta dot; any other idle row a faint static pip.
 */
function RowIndicator({ status, active }: { status: SessionStatus; active: boolean }) {
  const pos = "absolute left-[3px] top-1/2 -translate-y-1/2";
  if (status === "running")
    return <span className={`pc-dot pc-dot--success ${pos}`} aria-hidden="true" />;
  if (status === "archived")
    return (
      <span
        className="absolute left-[1px] top-1/2 -translate-y-1/2 text-[10px] leading-none text-faint"
        aria-hidden="true"
      >
        ▢
      </span>
    );
  if (active) return <span className={`pc-dot pc-dot--accent ${pos}`} aria-hidden="true" />;
  return <span className={`pc-dot--idle ${pos}`} aria-hidden="true" />;
}

/** Compact relative time from an epoch-ms timestamp: now / Nm / Nh / yest / Nd. */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "now";
  const hr = Math.floor(min / 60);
  if (hr < 1) return `${min}m`;
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yest";
  return `${day}d`;
}

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 9l3 3-3 3M13 15h4"
        stroke="var(--color-accent-hi)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M6 5v14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path
        d="M15 8l-4 4 4 4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M6 5v14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path
        d="M11 8l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NewFolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7a2 2 0 0 1 2-2h3l2 2h6a2 2 0 0 1 2 2v3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M3 7v10a2 2 0 0 0 2 2h6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M18 14v6M15 17h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function SortIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 7h13M5 12h9M5 17h5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GroupIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="16" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="4" y="14" width="16" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 8h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M3 5h18v3H3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M10 12h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// ── Context-menu glyphs ──────────────────────────────────────────────────────
function PlusGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RemoveFolderGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9 13h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function RenameGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 16.5V20h3.5L18 9.5 14.5 6 4 16.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M13 7.5 16.5 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
