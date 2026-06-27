import { describe, expect, it } from "vitest";

import type { Session, SessionFolder } from "../types";
import { buildSidebarRows, deriveStatus, sortSessions, workspaceLabel } from "./sessionView";

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  title: "Chat",
  workspace: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const folder = (over: Partial<SessionFolder> = {}): SessionFolder => ({
  id: "f1",
  name: "Folder",
  open: true,
  ...over,
});

const noArchive = new Set<string>();
const statusOfNone = () => "idle" as const;

describe("workspaceLabel", () => {
  it("returns 'local' for a null workspace", () => {
    expect(workspaceLabel(null)).toBe("local");
  });

  it("returns the basename for a path, handling both slash styles and trailing separators", () => {
    expect(workspaceLabel("C:/dev/porthex/portcode")).toBe("portcode");
    expect(workspaceLabel("C:\\dev\\porthex\\app")).toBe("app");
    expect(workspaceLabel("/home/me/proj/")).toBe("proj");
  });

  it("falls back to 'local' when a path has no real segments", () => {
    expect(workspaceLabel("/")).toBe("local");
  });
});

describe("deriveStatus", () => {
  it("archived wins over everything", () => {
    expect(deriveStatus("a", "a", true, new Set(["a"]))).toBe("archived");
  });

  it("the open session is running while a turn streams", () => {
    expect(deriveStatus("a", "a", true, noArchive)).toBe("running");
  });

  it("the open session is idle when not streaming", () => {
    expect(deriveStatus("a", "a", false, noArchive)).toBe("idle");
  });

  it("a non-active session is never running (single global stream)", () => {
    expect(deriveStatus("b", "a", true, noArchive)).toBe("idle");
  });
});

describe("sortSessions", () => {
  const a = session({ id: "a", title: "Banana", updatedAt: 100 });
  const b = session({ id: "b", title: "apple", updatedAt: 300 });
  const c = session({ id: "c", title: "Cherry", updatedAt: 200 });

  it("recent: newest updatedAt first", () => {
    expect(sortSessions([a, b, c], "recent", statusOfNone).map((s) => s.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("name: case-insensitive locale order", () => {
    expect(sortSessions([a, b, c], "name", statusOfNone).map((s) => s.id)).toEqual([
      "b", // apple
      "a", // Banana
      "c", // Cherry
    ]);
  });

  it("status: running → idle → archived, then newest within a bucket", () => {
    const statusOf = (id: string) =>
      id === "a" ? ("archived" as const) : id === "b" ? ("idle" as const) : ("running" as const);
    // c=running first; b=idle next; a=archived last.
    expect(sortSessions([a, b, c], "status", statusOf).map((s) => s.id)).toEqual(["c", "b", "a"]);
  });

  it("status tiebreak falls back to newest first within the same bucket", () => {
    const all = [
      session({ id: "x", updatedAt: 10 }),
      session({ id: "y", updatedAt: 30 }),
      session({ id: "z", updatedAt: 20 }),
    ];
    expect(sortSessions(all, "status", statusOfNone).map((s) => s.id)).toEqual(["y", "z", "x"]);
  });

  it("does not mutate the input array", () => {
    const input = [a, b, c];
    sortSessions(input, "name", statusOfNone);
    expect(input.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});

describe("buildSidebarRows — none mode (folder tree)", () => {
  it("renders loose chats first, then folders with nested open children", () => {
    const loose = session({ id: "loose", updatedAt: 500 });
    const inFolder = session({ id: "child", updatedAt: 400 });
    const { rows, visible } = buildSidebarRows({
      sessions: [loose, inFolder],
      activeId: "loose",
      streaming: false,
      sortBy: "recent",
      groupBy: "none",
      folders: [folder({ id: "f1", open: true })],
      folderOf: { child: "f1" },
      archived: noArchive,
    });

    expect(rows.map((r) => r.kind)).toEqual(["session", "folder", "session"]);
    // The nested child is marked indented; the loose row is not.
    const sessionRows = rows.filter((r) => r.kind === "session");
    expect(sessionRows[0]).toMatchObject({ indented: false, navIndex: 0 });
    expect(sessionRows[1]).toMatchObject({ indented: true, navIndex: 1 });
    // visible[navIndex] lines up with each session row.
    expect(visible.map((s) => s.id)).toEqual(["loose", "child"]);
  });

  it("hides children of a collapsed folder (folder shows count, no nested rows)", () => {
    const { rows, visible } = buildSidebarRows({
      sessions: [session({ id: "child" })],
      activeId: null,
      streaming: false,
      sortBy: "recent",
      groupBy: "none",
      folders: [folder({ id: "f1", open: false })],
      folderOf: { child: "f1" },
      archived: noArchive,
    });
    expect(rows.map((r) => r.kind)).toEqual(["folder"]);
    const folderRow = rows[0];
    expect(folderRow.kind === "folder" && folderRow.count).toBe(1);
    expect(visible).toHaveLength(0);
  });

  it("shows the empty placeholder for an open folder with no members", () => {
    const { rows } = buildSidebarRows({
      sessions: [],
      activeId: null,
      streaming: false,
      sortBy: "recent",
      groupBy: "none",
      folders: [folder({ id: "f1", open: true })],
      folderOf: {},
      archived: noArchive,
    });
    expect(rows.map((r) => r.kind)).toEqual(["folder", "folderEmpty"]);
  });

  it("treats membership pointing at a deleted folder as loose", () => {
    const { rows, visible } = buildSidebarRows({
      sessions: [session({ id: "orphan" })],
      activeId: null,
      streaming: false,
      sortBy: "recent",
      groupBy: "none",
      folders: [], // f-gone no longer exists
      folderOf: { orphan: "f-gone" },
      archived: noArchive,
    });
    expect(rows.map((r) => r.kind)).toEqual(["session"]);
    expect(visible.map((s) => s.id)).toEqual(["orphan"]);
  });
});

describe("buildSidebarRows — status mode", () => {
  it("buckets into Active / Idle / Archived in order, skipping empties", () => {
    const running = session({ id: "r" });
    const idle = session({ id: "i" });
    const arch = session({ id: "a" });
    const { rows } = buildSidebarRows({
      sessions: [idle, arch, running],
      activeId: "r",
      streaming: true, // makes the active session "running"
      sortBy: "recent",
      groupBy: "status",
      folders: [folder()], // folders are ignored in auto-group modes
      folderOf: { i: "f1" },
      archived: new Set(["a"]),
    });
    const headers = rows.filter((r) => r.kind === "groupHeader");
    expect(headers.map((h) => (h.kind === "groupHeader" ? h.label : ""))).toEqual([
      "Active",
      "Idle",
      "Archived",
    ]);
    // Folder rows never appear in status mode.
    expect(rows.some((r) => r.kind === "folder")).toBe(false);
  });

  it("skips an empty bucket (no Active header when nothing streams)", () => {
    const { rows } = buildSidebarRows({
      sessions: [session({ id: "i" })],
      activeId: "i",
      streaming: false,
      sortBy: "recent",
      groupBy: "status",
      folders: [],
      folderOf: {},
      archived: noArchive,
    });
    const labels = rows
      .filter((r) => r.kind === "groupHeader")
      .map((h) => (h.kind === "groupHeader" ? h.label : ""));
    expect(labels).toEqual(["Idle"]);
  });
});

describe("buildSidebarRows — workspace mode", () => {
  it("buckets by the ⎇ label in first-appearance order", () => {
    const { rows } = buildSidebarRows({
      sessions: [
        session({ id: "a", workspace: "C:/x/alpha", updatedAt: 300 }),
        session({ id: "b", workspace: "C:/y/beta", updatedAt: 200 }),
        session({ id: "c", workspace: "C:/x/alpha", updatedAt: 100 }),
      ],
      activeId: null,
      streaming: false,
      sortBy: "recent",
      groupBy: "workspace",
      folders: [],
      folderOf: {},
      archived: noArchive,
    });
    const headers = rows
      .filter((r) => r.kind === "groupHeader")
      .map((h) => (h.kind === "groupHeader" ? `${h.label}:${h.count}` : ""));
    // alpha appears first (a), beta second (b); alpha has 2 members.
    expect(headers).toEqual(["alpha:2", "beta:1"]);
  });

  it("groups null workspaces under 'local'", () => {
    const { rows } = buildSidebarRows({
      sessions: [session({ id: "a", workspace: null })],
      activeId: null,
      streaming: false,
      sortBy: "recent",
      groupBy: "workspace",
      folders: [],
      folderOf: {},
      archived: noArchive,
    });
    const header = rows.find((r) => r.kind === "groupHeader");
    expect(header && header.kind === "groupHeader" && header.label).toBe("local");
  });
});

describe("buildSidebarRows — branch mode", () => {
  it("buckets by git branch in first-appearance order", () => {
    const { rows } = buildSidebarRows({
      sessions: [
        session({ id: "a", branch: "main", updatedAt: 300 }),
        session({ id: "b", branch: "feature/x", updatedAt: 200 }),
        session({ id: "c", branch: "main", updatedAt: 100 }),
      ],
      activeId: null,
      streaming: false,
      sortBy: "recent",
      groupBy: "branch",
      folders: [],
      folderOf: {},
      archived: noArchive,
    });
    const headers = rows
      .filter((r) => r.kind === "groupHeader")
      .map((h) => (h.kind === "groupHeader" ? `${h.label}:${h.count}` : ""));
    expect(headers).toEqual(["main:2", "feature/x:1"]);
  });

  it("buckets branchless sessions under 'no branch'", () => {
    const { rows } = buildSidebarRows({
      sessions: [
        session({ id: "a", branch: null }),
        session({ id: "b", branch: undefined }),
        session({ id: "c", branch: "main" }),
      ],
      activeId: null,
      streaming: false,
      sortBy: "recent",
      groupBy: "branch",
      folders: [],
      folderOf: {},
      archived: noArchive,
    });
    const headers = rows
      .filter((r) => r.kind === "groupHeader")
      .map((h) => (h.kind === "groupHeader" ? `${h.label}:${h.count}` : ""));
    // The two branchless sessions share one "no branch" bucket.
    expect(headers).toContain("no branch:2");
    expect(headers).toContain("main:1");
  });
});

describe("sortSessions — manual order", () => {
  const a = session({ id: "a", updatedAt: 100 });
  const b = session({ id: "b", updatedAt: 200 });
  const c = session({ id: "c", updatedAt: 300 });

  it("orders by the explicit manualOrder", () => {
    const out = sortSessions([a, b, c], "manual", statusOfNone, ["c", "a", "b"]);
    expect(out.map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("places ids missing from manualOrder last, newest first", () => {
    // Only "a" is pinned; b and c fall after it ordered by recency (c before b).
    const out = sortSessions([a, b, c], "manual", statusOfNone, ["a"]);
    expect(out.map((s) => s.id)).toEqual(["a", "c", "b"]);
  });

  it("honours a manual order threaded through buildSidebarRows", () => {
    const { visible } = buildSidebarRows({
      sessions: [a, b, c],
      activeId: null,
      streaming: false,
      sortBy: "manual",
      groupBy: "none",
      folders: [],
      folderOf: {},
      archived: noArchive,
      manualOrder: ["b", "c", "a"],
    });
    expect(visible.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });
});
