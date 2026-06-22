import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { FileExplorer } from "./FileExplorer";
import { useStore } from "../store/store";
import * as ipc from "../lib/ipc";
import type { DirEntry } from "../types";

// FileExplorer loads directory entries from the backend via `ipc.listDir` and
// folds file clicks into the real store (`appendDraft`) / opens a workspace
// (`openWorkspace`). We mock only the IPC boundary and drive the genuine
// zustand store, asserting rendered tree behaviour and the store/ipc effects.
vi.mock("../lib/ipc", () => ({
  listDir: vi.fn(),
  openFolder: vi.fn(),
  saveSettings: vi.fn(),
}));

const m = vi.mocked(ipc);
const initialState = useStore.getState();

const entry = (over: Partial<DirEntry> = {}): DirEntry => ({
  name: "file.ts",
  path: "file.ts",
  isDir: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Restore a pristine store between tests (zustand has no built-in reset).
  useStore.setState(initialState, true);

  // Sensible defaults; individual tests override as needed.
  m.listDir.mockResolvedValue([]);
  m.openFolder.mockResolvedValue(null);
  m.saveSettings.mockImplementation(async (s) => ({
    ...useStore.getState().settings,
    ...s,
  }));
});

describe("FileExplorer header", () => {
  it("shows the PORTCODE eyebrow regardless of workspace", async () => {
    render(<FileExplorer />);
    // Neon-Noir header: a fixed "◧ PORTCODE" eyebrow (no workspace basename).
    expect(screen.getByText("◧ PORTCODE")).toBeInTheDocument();
    // Initial load resolves to [] -> the effect's setRoots runs.
    await waitFor(() => expect(m.listDir).toHaveBeenCalledWith(undefined));
  });

  it("keeps the fixed eyebrow even when a workspace path is set", async () => {
    useStore.setState({
      settings: { ...initialState.settings, workspace: "C:/dev/porthex/portcode//" },
    });

    render(<FileExplorer />);

    // The header no longer derives a basename; it stays the static eyebrow.
    expect(await screen.findByText("◧ PORTCODE")).toBeInTheDocument();
    await waitFor(() => expect(m.listDir).toHaveBeenCalledWith(undefined));
  });

  it("reloads the directory listing when the workspace changes", async () => {
    const { rerender } = render(<FileExplorer />);
    await waitFor(() => expect(m.listDir).toHaveBeenCalledTimes(1));

    useStore.setState({
      settings: { ...initialState.settings, workspace: "C:/work/repo" },
    });
    rerender(<FileExplorer />);

    await waitFor(() => expect(m.listDir).toHaveBeenCalledTimes(2));
  });

  it("does not setRoots after unmount (alive guard)", async () => {
    let resolveList!: (entries: DirEntry[]) => void;
    m.listDir.mockReturnValueOnce(
      new Promise<DirEntry[]>((res) => {
        resolveList = res;
      }),
    );

    const { unmount } = render(<FileExplorer />);
    // Unmount before the in-flight listDir resolves; the cleanup sets alive=false.
    unmount();
    resolveList([entry({ name: "late.ts", path: "late.ts", isDir: false })]);

    // No throw / act-warning and the late entry never renders.
    await waitFor(() => expect(m.listDir).toHaveBeenCalled());
    expect(screen.queryByText("late.ts")).not.toBeInTheDocument();
  });
});

describe("FileExplorer empty state", () => {
  it("renders the empty placeholder and opens a folder from it", async () => {
    m.openFolder.mockResolvedValueOnce("C:/picked/dir");
    render(<FileExplorer />);

    // Two distinct 'open' affordances exist when empty: header + placeholder.
    // The empty state spells out that no workspace is set and hints at the fix.
    expect(await screen.findByText("No workspace set")).toBeInTheDocument();
    expect(screen.getByText("Pick a folder to start browsing.")).toBeInTheDocument();
    const placeholderBtn = screen.getByRole("button", { name: "Open a folder" });

    fireEvent.click(placeholderBtn);

    await waitFor(() => expect(m.openFolder).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(m.saveSettings).toHaveBeenCalledWith({ workspace: "C:/picked/dir" }),
    );
  });

  it("falls back to the empty placeholder when listDir rejects", async () => {
    // A failed directory scan must not hang on a blank view or leak an
    // unhandled rejection; the .catch() guard resolves roots to [] so the
    // empty-state placeholder still renders.
    m.listDir.mockRejectedValueOnce(new Error("scan failed"));

    render(<FileExplorer />);

    expect(await screen.findByText("No workspace set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open a folder" })).toBeInTheDocument();
    await waitFor(() => expect(m.listDir).toHaveBeenCalledWith(undefined));
  });

  it("invokes openWorkspace from the header button", async () => {
    render(<FileExplorer />);
    // Header affordance shows "OPEN…" but is labelled "Open folder" for
    // screen readers, so its accessible name is the aria-label.
    const headerBtn = screen.getByRole("button", { name: "Open folder" });
    expect(headerBtn).toHaveTextContent("OPEN…");

    fireEvent.click(headerBtn);

    await waitFor(() => expect(m.openFolder).toHaveBeenCalledTimes(1));
  });
});

describe("FileExplorer tree", () => {
  it("renders the loaded roots, distinguishing directories from files", async () => {
    m.listDir.mockResolvedValueOnce([
      entry({ name: "src", path: "src", isDir: true }),
      entry({ name: "README.md", path: "README.md", isDir: false }),
    ]);

    render(<FileExplorer />);

    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    // A collapsed directory shows both the caret "▸" and the amber folder
    // glyph "▸" (two distinct spans share the same right-pointing triangle).
    expect(screen.getAllByText("▸")).toHaveLength(2);
    // README.md is the extension-less-of-interest fallback "◇" (text-faint).
    expect(screen.getByText("◇")).toBeInTheDocument();
  });

  it("expands a directory, fetching and rendering its children with the sub-path", async () => {
    m.listDir
      .mockResolvedValueOnce([entry({ name: "src", path: "src", isDir: true })])
      .mockResolvedValueOnce([entry({ name: "App.tsx", path: "src/App.tsx", isDir: false })]);

    render(<FileExplorer />);

    // Rows are tree items (role="treeitem"); the dir's accessible name is its
    // explicit "<name> folder" label, which the /src/ matcher still matches.
    const dirBtn = await screen.findByRole("treeitem", { name: /src/ });
    fireEvent.click(dirBtn);

    // Second listDir call carries the directory's path.
    await waitFor(() => expect(m.listDir).toHaveBeenNthCalledWith(2, "src"));
    expect(await screen.findByText("App.tsx")).toBeInTheDocument();
    // Caret flips to the expanded glyph.
    expect(screen.getByText("▾")).toBeInTheDocument();
  });

  it("collapses an expanded directory without refetching, then re-expands from cache", async () => {
    m.listDir
      .mockResolvedValueOnce([entry({ name: "src", path: "src", isDir: true })])
      .mockResolvedValueOnce([entry({ name: "App.tsx", path: "src/App.tsx", isDir: false })]);

    render(<FileExplorer />);
    const dirBtn = await screen.findByRole("treeitem", { name: /src/ });

    // expand -> children fetched
    fireEvent.click(dirBtn);
    expect(await screen.findByText("App.tsx")).toBeInTheDocument();
    expect(m.listDir).toHaveBeenCalledTimes(2);

    // collapse -> child hidden, no extra fetch
    fireEvent.click(dirBtn);
    await waitFor(() => expect(screen.queryByText("App.tsx")).not.toBeInTheDocument());
    expect(m.listDir).toHaveBeenCalledTimes(2);

    // re-expand -> served from cache (children !== null), still no extra fetch
    fireEvent.click(dirBtn);
    expect(await screen.findByText("App.tsx")).toBeInTheDocument();
    expect(m.listDir).toHaveBeenCalledTimes(2);
  });

  it("dedupes rapid toggles while expanding: listDir fires once for the folder", async () => {
    let resolveChildren!: (entries: DirEntry[]) => void;
    m.listDir
      .mockResolvedValueOnce([entry({ name: "src", path: "src", isDir: true })])
      .mockReturnValueOnce(
        // Keep the expand pending so the in-flight guard is active for the
        // toggles that land before the children resolve.
        new Promise<DirEntry[]>((res) => {
          resolveChildren = res;
        }),
      );

    render(<FileExplorer />);
    const dirBtn = await screen.findByRole("treeitem", { name: /src/ });

    // First click kicks off the (still-pending) child fetch.
    fireEvent.click(dirBtn);
    await waitFor(() => expect(m.listDir).toHaveBeenNthCalledWith(2, "src"));

    // Two more toggles while the first listDir is in flight (collapse, then a
    // re-expand attempt) must not fire a duplicate fetch: children is still
    // null, but the loading ref short-circuits the guarded branch.
    fireEvent.click(dirBtn);
    fireEvent.click(dirBtn);

    // Settle the pending fetch; exactly one child listDir ran for "src".
    resolveChildren([entry({ name: "App.tsx", path: "src/App.tsx", isDir: false })]);
    await waitFor(() => expect(m.listDir.mock.calls.filter((c) => c[0] === "src")).toHaveLength(1));
    expect(m.listDir).toHaveBeenCalledTimes(2);
  });

  it("recovers from a failed expand: collapses the caret and renders no children", async () => {
    m.listDir
      .mockResolvedValueOnce([entry({ name: "locked", path: "locked", isDir: true })])
      .mockRejectedValueOnce(new Error("permission denied"));

    render(<FileExplorer />);
    const dirBtn = await screen.findByRole("treeitem", { name: /locked/ });

    fireEvent.click(dirBtn);

    // The sub-path was queried but rejected; the catch resets the node so the
    // caret collapses back to "▸" and no stuck-open empty directory remains.
    await waitFor(() => expect(m.listDir).toHaveBeenNthCalledWith(2, "locked"));
    await waitFor(() => expect(screen.queryByText("▾")).not.toBeInTheDocument());
    expect(screen.getAllByText("▸")).toHaveLength(2);

    // children settled to [] (not null), so re-expanding serves the cache
    // without re-hitting the failing backend.
    fireEvent.click(dirBtn);
    await waitFor(() => expect(screen.getByText("▾")).toBeInTheDocument());
    expect(m.listDir).toHaveBeenCalledTimes(2);
  });

  it("handles an empty directory: expands with no children rendered", async () => {
    m.listDir
      .mockResolvedValueOnce([entry({ name: "empty", path: "empty", isDir: true })])
      .mockResolvedValueOnce([]);

    render(<FileExplorer />);
    const dirBtn = await screen.findByRole("treeitem", { name: /empty/ });

    fireEvent.click(dirBtn);

    // Caret flips open and the sub-path was queried, but nothing new renders.
    await waitFor(() => expect(m.listDir).toHaveBeenNthCalledWith(2, "empty"));
    expect(await screen.findByText("▾")).toBeInTheDocument();
  });

  it("clicking a file appends its path to the composer draft instead of fetching", async () => {
    m.listDir.mockResolvedValueOnce([
      entry({ name: "notes.md", path: "docs/notes.md", isDir: false }),
    ]);

    render(<FileExplorer />);
    const fileBtn = await screen.findByRole("treeitem", { name: /notes\.md/ });

    fireEvent.click(fileBtn);

    // appendDraft folded the path into the real store; no second listDir.
    await waitFor(() => expect(useStore.getState().draft).toBe("docs/notes.md "));
    expect(m.listDir).toHaveBeenCalledTimes(1);
  });
});

describe("FileExplorer accessibility", () => {
  it("labels the <aside> landmark so it is a named complementary region", async () => {
    render(<FileExplorer />);

    expect(screen.getByRole("complementary", { name: "File explorer" })).toBeInTheDocument();
    await waitFor(() => expect(m.listDir).toHaveBeenCalledWith(undefined));
  });

  it("exposes tree semantics: a tree container with treeitem rows", async () => {
    m.listDir.mockResolvedValueOnce([
      entry({ name: "src", path: "src", isDir: true }),
      entry({ name: "README.md", path: "README.md", isDir: false }),
    ]);

    render(<FileExplorer />);

    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "File tree" })).toBeInTheDocument();
    // Both rows are treeitems (one directory, one file).
    expect(screen.getAllByRole("treeitem")).toHaveLength(2);
  });

  it("reflects directory open/closed state via aria-expanded", async () => {
    m.listDir
      .mockResolvedValueOnce([entry({ name: "src", path: "src", isDir: true })])
      .mockResolvedValueOnce([entry({ name: "App.tsx", path: "src/App.tsx", isDir: false })]);

    render(<FileExplorer />);

    const dirBtn = await screen.findByRole("treeitem", { name: "src folder" });
    // Collapsed directory advertises aria-expanded="false".
    expect(dirBtn).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(dirBtn);

    // After expanding, the same row flips to aria-expanded="true".
    await waitFor(() => expect(dirBtn).toHaveAttribute("aria-expanded", "true"));
  });

  it("omits aria-expanded on file rows (only directories are expandable)", async () => {
    m.listDir.mockResolvedValueOnce([
      entry({ name: "notes.md", path: "docs/notes.md", isDir: false }),
    ]);

    render(<FileExplorer />);

    const fileBtn = await screen.findByRole("treeitem", { name: "notes.md" });
    expect(fileBtn).not.toHaveAttribute("aria-expanded");
  });

  it("gives a directory row the explicit accessible name '<name> folder'", async () => {
    m.listDir.mockResolvedValueOnce([entry({ name: "src", path: "src", isDir: true })]);

    render(<FileExplorer />);

    // The decorative caret/glyph spans are aria-hidden, so the row's accessible
    // name comes solely from the explicit aria-label, not the leaked symbols.
    expect(await screen.findByRole("treeitem", { name: "src folder" })).toBeInTheDocument();
    // Decorative glyphs stay in the DOM (aria-hidden) so text assertions hold.
    expect(screen.getAllByText("▸")).toHaveLength(2);
  });

  it("surfaces a workspace open failure in an alert region", () => {
    useStore.setState({ workspaceError: "permission denied" });

    render(<FileExplorer />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t open folder: permission denied");
  });
});

describe("FileExplorer workspace switch", () => {
  it("remounts the tree on a workspace change, dropping stale subtree state", async () => {
    // Workspace A: expand "src" -> children fetched once.
    m.listDir
      .mockResolvedValueOnce([entry({ name: "src", path: "src", isDir: true })])
      .mockResolvedValueOnce([entry({ name: "A.tsx", path: "src/A.tsx", isDir: false })]);

    const { rerender } = render(<FileExplorer />);
    const dirA = await screen.findByRole("treeitem", { name: "src folder" });
    fireEvent.click(dirA);
    expect(await screen.findByText("A.tsx")).toBeInTheDocument();
    expect(m.listDir).toHaveBeenCalledTimes(2);

    // Switch workspace: the keyed container remounts TreeNodes, so the new
    // same-named "src" starts collapsed with no cached children.
    m.listDir
      .mockResolvedValueOnce([entry({ name: "src", path: "src", isDir: true })])
      .mockResolvedValueOnce([entry({ name: "B.tsx", path: "src/B.tsx", isDir: false })]);
    useStore.setState({
      settings: { ...initialState.settings, workspace: "C:/other/repo" },
    });
    rerender(<FileExplorer />);

    // Root re-listed for the new workspace (call 3), and the prior child is gone.
    await waitFor(() => expect(m.listDir).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText("A.tsx")).not.toBeInTheDocument());

    // Re-expanding the same-named folder re-requests listDir for "src" instead
    // of serving the previous workspace's stale cached children.
    const dirB = await screen.findByRole("treeitem", { name: "src folder" });
    fireEvent.click(dirB);
    await waitFor(() => expect(m.listDir).toHaveBeenCalledTimes(4));
    expect(await screen.findByText("B.tsx")).toBeInTheDocument();
    expect(screen.queryByText("A.tsx")).not.toBeInTheDocument();
  });
});

describe("fileGlyph (via rendered file rows)", () => {
  it("maps known extensions to their glyphs and falls back for the rest", async () => {
    m.listDir.mockResolvedValueOnce([
      entry({ name: "core.rs", path: "core.rs", isDir: false }),
      entry({ name: "app.tsx", path: "app.tsx", isDir: false }),
      entry({ name: "Cargo.toml", path: "Cargo.toml", isDir: false }),
      entry({ name: "README.md", path: "README.md", isDir: false }),
      entry({ name: "theme.css", path: "theme.css", isDir: false }),
      entry({ name: "Makefile", path: "Makefile", isDir: false }),
    ]);

    render(<FileExplorer />);

    await screen.findByText("core.rs");
    // Neon-Noir type glyphs: a crab for Rust, an amber/cyan/green diamond
    // "◆" for the source families, and a hollow "◇" fallback otherwise.
    expect(screen.getByText("🦀")).toBeInTheDocument(); // .rs
    // .tsx (text-accent-2) and .css (text-accent) both render the filled "◆".
    expect(screen.getAllByText("◆")).toHaveLength(2);

    // .toml, .md and the extension-less Makefile all fall back to "◇".
    expect(screen.getAllByText("◇")).toHaveLength(3);
  });
});
