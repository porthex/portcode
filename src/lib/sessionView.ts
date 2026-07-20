// Pure presentation logic for the sessions sidebar: deriving a row's status,
// ordering the list, and flattening sort/group/folder state into a single
// ordered list of tagged rows the component maps 1:1. Kept framework-free (no
// React, no store) so the tree/grouping logic is unit-testable in isolation and
// the component stays a thin renderer over `buildSidebarRows`.

import type { Session, SessionFolder, SessionGroup, SessionSort } from "../types";

export type SessionActivityStatus = "waiting" | "stopping" | "running" | "idle" | "archived";

export interface SessionRunActivity {
  streaming?: boolean;
  finalizing?: boolean;
  pendingPermission?: unknown | null;
}

/** Split the persisted session collection into the two sidebar destinations.
 * Archive membership is presentation-only, so stale archived ids are harmless
 * and simply do not appear in either returned collection. */
export function partitionSessions(
  sessions: readonly Session[],
  archivedIds: ReadonlySet<string>,
): { active: Session[]; archived: Session[] } {
  const active: Session[] = [];
  const archived: Session[] = [];
  for (const session of sessions) {
    (archivedIds.has(session.id) ? archived : active).push(session);
  }
  return { active, archived };
}

/** Basename of a workspace path, or "local" when none is set. Doubles as the
 *  `⎇` row label and the bucket key for `groupBy: "workspace"`. */
export function workspaceLabel(workspace: string | null): string {
  if (!workspace) return "local";
  const parts = workspace.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "local";
}

/**
 * Derive a session's display status. Live work wins over the presentation-only
 * archive flag so an archived chat cannot hide a permission request or run.
 * The legacy activeId/streaming call form remains for restored state and tests.
 */
export function deriveStatus(
  id: string,
  runOrActiveId: SessionRunActivity | string | null | undefined,
  streamingOrArchived: boolean | ReadonlySet<string>,
  legacyArchived?: ReadonlySet<string>,
): SessionActivityStatus {
  const legacy = typeof streamingOrArchived === "boolean";
  const run: SessionRunActivity | undefined = legacy
    ? id === runOrActiveId && streamingOrArchived
      ? { streaming: true }
      : undefined
    : typeof runOrActiveId === "object" && runOrActiveId !== null
      ? runOrActiveId
      : undefined;
  const archived = legacy ? (legacyArchived ?? new Set<string>()) : streamingOrArchived;
  if (run?.pendingPermission) return "waiting";
  if (run?.finalizing) return "stopping";
  if (run?.streaming) return "running";
  if (archived.has(id)) return "archived";
  return "idle";
}

// Status grouping renders in this fixed order (empties skipped). Lower rank =
// earlier, which also drives the `status` sort's primary key.
const STATUS_ORDER: { status: SessionActivityStatus; label: string }[] = [
  { status: "waiting", label: "Needs attention" },
  { status: "stopping", label: "Stopping" },
  { status: "running", label: "Running" },
  { status: "idle", label: "Idle" },
  { status: "archived", label: "Archived" },
];
const STATUS_RANK: Record<SessionActivityStatus, number> = {
  waiting: 0,
  stopping: 1,
  running: 2,
  idle: 3,
  archived: 4,
};

/**
 * A copy of `sessions` ordered by `sortBy`. `recent` = newest `updatedAt` first;
 * `name` = title `localeCompare`; `status` = attention→stopping→running→idle→archived,
 * first within a bucket; `manual` = the user's drag-reordered `manualOrder`
 * (ids not in it sort after, newest first). Array.sort is stable, so equal keys
 * preserve input order (keeps keyboard-nav order deterministic when ties occur).
 */
export function sortSessions(
  sessions: readonly Session[],
  sortBy: SessionSort,
  statusOf: (id: string) => SessionActivityStatus,
  manualOrder: readonly string[] = [],
): Session[] {
  const arr = [...sessions];
  switch (sortBy) {
    case "name":
      arr.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case "status":
      arr.sort((a, b) => {
        const r = STATUS_RANK[statusOf(a.id)] - STATUS_RANK[statusOf(b.id)];
        return r !== 0 ? r : b.updatedAt - a.updatedAt;
      });
      break;
    case "manual": {
      const pos = new Map(manualOrder.map((id, i) => [id, i] as const));
      arr.sort((a, b) => {
        const pa = pos.get(a.id) ?? Number.POSITIVE_INFINITY;
        const pb = pos.get(b.id) ?? Number.POSITIVE_INFINITY;
        return pa !== pb ? pa - pb : b.updatedAt - a.updatedAt;
      });
      break;
    }
    case "recent":
    default:
      arr.sort((a, b) => b.updatedAt - a.updatedAt);
      break;
  }
  return arr;
}

/** One rendered line in the sidebar tree. The component maps these 1:1. */
export type SidebarRow =
  | { kind: "groupHeader"; key: string; label: string; count: number }
  | { kind: "folder"; folder: SessionFolder; count: number }
  | { kind: "folderEmpty"; folderId: string }
  | {
      kind: "session";
      session: Session;
      status: SessionActivityStatus;
      /** Index into the flat `visible` list — the roving-tabindex / keyboard-nav slot. */
      navIndex: number;
      /** Rendered indented under an open folder (nested guide line). */
      indented: boolean;
    };

export interface BuildRowsParams {
  sessions: readonly Session[];
  activeId: string | null;
  streaming: boolean;
  sortBy: SessionSort;
  groupBy: SessionGroup;
  folders: readonly SessionFolder[];
  /** sessionId → folderId (or null/absent = loose at the root). */
  folderOf: Readonly<Record<string, string | null>>;
  archived: ReadonlySet<string>;
  /** Per-session run state. When supplied it is authoritative over the legacy
   * activeId/streaming pair and allows background sessions to report activity. */
  runs?: Readonly<Record<string, SessionRunActivity | undefined>>;
  /** Drag-reordered order of session ids, honoured when `sortBy === "manual"`. */
  manualOrder?: readonly string[];
}

/** Group an already-sorted list into first-appearance-ordered buckets. */
function bucketBy(
  sorted: readonly Session[],
  keyOf: (s: Session) => { key: string; label: string },
): { key: string; label: string; sessions: Session[] }[] {
  const order: { key: string; label: string }[] = [];
  const buckets = new Map<string, Session[]>();
  for (const s of sorted) {
    const { key, label } = keyOf(s);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push({ key, label });
    }
    bucket.push(s);
  }
  return order.map(({ key, label }) => ({ key, label, sessions: buckets.get(key) ?? [] }));
}

/**
 * Flatten sort/group/folder state into a single ordered `rows[]` plus the flat
 * `visible[]` list of the sessions actually shown (collapsed-folder children are
 * omitted). `visible` indices line up with each session row's `navIndex`, so the
 * component can drive one roving-tabindex / arrow-key model across all modes.
 *
 * - `status` grouping → attention/stopping/running/idle/archived in fixed order.
 * - `workspace` grouping → one bucket per `⎇` label, in first-appearance order.
 * - `none` → loose chats first, then folders with their (sorted) children nested.
 *   Folders apply ONLY here; the automatic groupings ignore them.
 */
export function buildSidebarRows(p: BuildRowsParams): { rows: SidebarRow[]; visible: Session[] } {
  const { sessions, activeId, streaming, sortBy, groupBy, folders, folderOf, archived } = p;
  const manualOrder = p.manualOrder ?? [];
  const statusOf = (id: string): SessionActivityStatus =>
    p.runs
      ? deriveStatus(id, p.runs[id], archived)
      : deriveStatus(id, activeId, streaming, archived);
  const sort = (list: readonly Session[]): Session[] =>
    sortSessions(list, sortBy, statusOf, manualOrder);

  const rows: SidebarRow[] = [];
  const visible: Session[] = [];
  const pushSession = (s: Session, indented: boolean): void => {
    rows.push({
      kind: "session",
      session: s,
      status: statusOf(s.id),
      navIndex: visible.length,
      indented,
    });
    visible.push(s);
  };
  const pushGroups = (groups: { key: string; label: string; sessions: Session[] }[]): void => {
    for (const g of groups) {
      rows.push({ kind: "groupHeader", key: g.key, label: g.label, count: g.sessions.length });
      for (const s of g.sessions) pushSession(s, false);
    }
  };

  if (groupBy === "status") {
    pushGroups(
      STATUS_ORDER.map(({ status, label }) => ({
        key: `status:${status}`,
        label,
        sessions: sort(sessions.filter((s) => statusOf(s.id) === status)),
      })).filter((g) => g.sessions.length > 0),
    );
    return { rows, visible };
  }

  if (groupBy === "branch") {
    pushGroups(
      bucketBy(sort(sessions), (s) =>
        s.branch
          ? { key: `b:${s.branch}`, label: s.branch }
          : { key: "b:none", label: "no branch" },
      ),
    );
    return { rows, visible };
  }

  if (groupBy === "workspace") {
    pushGroups(
      bucketBy(sort(sessions), (s) => {
        const label = workspaceLabel(s.workspace);
        return { key: `ws:${label}`, label };
      }),
    );
    return { rows, visible };
  }

  // groupBy === "none": manual folder tree. Loose chats sit at the root above the
  // folders; each folder's children are nested under it when open.
  const folderIds = new Set(folders.map((f) => f.id));
  const folderIdOf = (id: string): string | null => {
    const f = folderOf[id];
    // A membership pointing at a since-deleted folder falls back to loose.
    return f && folderIds.has(f) ? f : null;
  };

  for (const s of sort(sessions.filter((s) => folderIdOf(s.id) === null))) {
    pushSession(s, false);
  }

  for (const folder of folders) {
    const members = sort(sessions.filter((s) => folderIdOf(s.id) === folder.id));
    rows.push({ kind: "folder", folder, count: members.length });
    if (folder.open) {
      if (members.length === 0) rows.push({ kind: "folderEmpty", folderId: folder.id });
      else for (const s of members) pushSession(s, true);
    }
  }

  return { rows, visible };
}
