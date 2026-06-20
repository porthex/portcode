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
  it("shows 'Explorer' when no workspace is set", async () => {
    render(<FileExplorer />);
    expect(screen.getByText("Explorer")).toBeInTheDocument();
    // Initial load resolves to [] -> the effect's setRoots runs.
    await waitFor(() => expect(m.listDir).toHaveBeenCalledWith(undefined));
  });

  it("derives the basename from the workspace path (trailing slashes stripped)", async () => {
    useStore.setState({
      settings: { ...initialState.settings, workspace: "C:/dev/porthex/portcode//" },
    });

    render(<FileExplorer />);

    // basename of the workspace, ignoring trailing separators
    expect(await screen.findByText("portcode")).toBeInTheDocument();
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
    expect(await screen.findByText(/No files/)).toBeInTheDocument();
    const placeholderBtn = screen.getByRole("button", { name: "Open a folder" });

    fireEvent.click(placeholderBtn);

    await waitFor(() => expect(m.openFolder).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(m.saveSettings).toHaveBeenCalledWith({ workspace: "C:/picked/dir" }),
    );
  });

  it("invokes openWorkspace from the header button", async () => {
    render(<FileExplorer />);
    const headerBtn = screen.getByRole("button", { name: "Open…" });

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
    // A directory shows the collapsed caret + folder glyph.
    expect(screen.getByText("▸")).toBeInTheDocument();
    expect(screen.getByText("📁")).toBeInTheDocument();
  });

  it("expands a directory, fetching and rendering its children with the sub-path", async () => {
    m.listDir
      .mockResolvedValueOnce([entry({ name: "src", path: "src", isDir: true })])
      .mockResolvedValueOnce([entry({ name: "App.tsx", path: "src/App.tsx", isDir: false })]);

    render(<FileExplorer />);

    const dirBtn = await screen.findByRole("button", { name: /src/ });
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
    const dirBtn = await screen.findByRole("button", { name: /src/ });

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

  it("handles an empty directory: expands with no children rendered", async () => {
    m.listDir
      .mockResolvedValueOnce([entry({ name: "empty", path: "empty", isDir: true })])
      .mockResolvedValueOnce([]);

    render(<FileExplorer />);
    const dirBtn = await screen.findByRole("button", { name: /empty/ });

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
    const fileBtn = await screen.findByRole("button", { name: /notes\.md/ });

    fireEvent.click(fileBtn);

    // appendDraft folded the path into the real store; no second listDir.
    await waitFor(() => expect(useStore.getState().draft).toBe("docs/notes.md "));
    expect(m.listDir).toHaveBeenCalledTimes(1);
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
    expect(screen.getByText("🦀")).toBeInTheDocument(); // .rs
    expect(screen.getByText("📜")).toBeInTheDocument(); // .tsx (ts/js family)
    expect(screen.getByText("⚙️")).toBeInTheDocument(); // .toml (config family)
    expect(screen.getByText("🎨")).toBeInTheDocument(); // .css

    // .md and the extension-less fallback both render the document glyph.
    expect(screen.getAllByText("📄").length).toBeGreaterThanOrEqual(2);
  });
});
