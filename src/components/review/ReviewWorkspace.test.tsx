import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as ipc from "../../lib/ipc";
import { useStore } from "../../store/store";
import { DEFAULT_SETTINGS } from "../../types";
import type {
  GitChangedFile,
  GitFilePatch,
  GitReviewManifest,
  GitReviewScope,
  TurnReceipt,
  TurnReviewManifest,
} from "../../types";
import { ReviewWorkspace } from "./ReviewWorkspace";

vi.mock("../../lib/ipc", () => ({
  getGitReviewBranches: vi.fn(),
  getGitReviewManifest: vi.fn(),
  getGitReviewFile: vi.fn(),
  getTurnReviewManifest: vi.fn(),
  getTurnReviewFile: vi.fn(),
}));

const m = vi.mocked(ipc);
const initialState = useStore.getState();

const branches = [
  { name: "main", revision: "refs/heads/main", kind: "local", current: true },
  { name: "release", revision: "refs/heads/release", kind: "local", current: false },
  {
    name: "origin/main",
    revision: "refs/remotes/origin/main",
    kind: "remote",
    current: false,
  },
] as const;

const files: GitChangedFile[] = [
  {
    path: "src/App.tsx",
    oldPath: null,
    status: "modified",
    areas: ["staged", "unstaged"],
    additions: 12,
    deletions: 3,
    binary: false,
  },
  {
    path: "src/new.ts",
    oldPath: null,
    status: "added",
    areas: ["untracked"],
    additions: 4,
    deletions: 0,
    binary: false,
  },
  {
    path: "src/deleted.ts",
    oldPath: null,
    status: "deleted",
    areas: ["staged"],
    additions: 0,
    deletions: 8,
    binary: false,
  },
  {
    path: "src/renamed.ts",
    oldPath: "src/old.ts",
    status: "renamed",
    areas: ["staged"],
    additions: 1,
    deletions: 1,
    binary: false,
  },
  {
    path: "src/copied.ts",
    oldPath: "src/source.ts",
    status: "copied",
    areas: ["unstaged"],
    additions: 2,
    deletions: 0,
    binary: false,
  },
  {
    path: "src/conflict.ts",
    oldPath: null,
    status: "unmerged",
    areas: ["unstaged"],
    additions: 0,
    deletions: 0,
    binary: false,
  },
  {
    path: "assets/reviewer.png",
    oldPath: null,
    status: "modified",
    areas: ["unstaged"],
    additions: null,
    deletions: null,
    binary: true,
  },
  {
    path: "src/mode-only.ts",
    oldPath: null,
    status: "modified",
    areas: ["unstaged"],
    additions: 0,
    deletions: 0,
    binary: false,
  },
];

function manifest(
  scope: GitReviewScope = { kind: "workingTree" },
  overrides: Partial<GitReviewManifest> = {},
): GitReviewManifest {
  const scopedFiles =
    scope.kind === "staged"
      ? files
          .filter((file) => file.areas.includes("staged"))
          .map((file) => ({ ...file, areas: ["staged"] as GitChangedFile["areas"] }))
      : scope.kind === "unstaged"
        ? files
            .filter((file) => file.areas.includes("unstaged") || file.areas.includes("untracked"))
            .map((file) => ({
              ...file,
              areas: [
                file.areas.includes("untracked") ? "untracked" : "unstaged",
              ] as GitChangedFile["areas"],
            }))
        : scope.kind === "branch" || scope.kind === "commit"
          ? files.slice(0, 3).map((file) => ({
              ...file,
              areas: ["committed"] as GitChangedFile["areas"],
            }))
          : files;
  return {
    snapshotId: `snapshot-${scope.kind}`,
    repositoryRoot: "D:/Projects/portcode",
    scope,
    baseLabel: scope.kind === "branch" ? "merge-base(origin/main) · abc12345" : "abc12345",
    targetLabel: scope.kind === "staged" ? "Index" : "Working tree",
    headOid: "abc123456789",
    files: scopedFiles,
    additions: scopedFiles.reduce((total, file) => total + (file.additions ?? 0), 0),
    deletions: scopedFiles.reduce((total, file) => total + (file.deletions ?? 0), 0),
    truncated: false,
    ...overrides,
  };
}

function patch(path: string, overrides: Partial<GitFilePatch> = {}): GitFilePatch {
  return {
    snapshotId: "snapshot-workingTree",
    path,
    oldPath: path === "src/renamed.ts" ? "src/old.ts" : null,
    status: "modified",
    binary: false,
    filePatchHash: `patch-${path}`,
    truncated: false,
    hunks: [
      {
        header: "@@ -12,3 +12,4 @@ export function preview() {",
        oldStart: 12,
        oldLines: 3,
        newStart: 12,
        newLines: 4,
        lines: [
          { kind: "context", content: "  const mode = current;", oldLine: 12, newLine: 12 },
          { kind: "deletion", content: "  return oldValue;", oldLine: 13, newLine: null },
          { kind: "addition", content: "  const reviewed = true;", oldLine: null, newLine: 13 },
          { kind: "addition", content: "  return newValue;", oldLine: null, newLine: 14 },
          { kind: "context", content: "}", oldLine: 14, newLine: 15 },
          { kind: "meta", content: "\\ No newline at end of file", oldLine: null, newLine: null },
        ],
      },
    ],
    ...overrides,
  };
}

const turnReceipt: TurnReceipt = {
  turnId: "turn-1",
  status: "completed",
  stopReason: "end_turn",
  startedAt: 1_000,
  completedAt: 3_000,
  durationMs: 2_000,
  changedFiles: [
    {
      path: "src/App.tsx",
      status: "modified",
      additions: 2,
      deletions: 1,
      binary: false,
      certainty: "exact",
    },
  ],
  changedFileCount: 1,
  additions: 2,
  deletions: 1,
  filesTruncated: false,
  changeCertainty: "exact",
  backgroundTasksRunning: false,
};

const turnManifest: TurnReviewManifest = {
  turnId: "turn-1",
  snapshotId: "turn-snapshot-1",
  repositoryRoot: "D:/Projects/portcode",
  receipt: turnReceipt,
  files: turnReceipt.changedFiles,
  additions: 2,
  deletions: 1,
  truncated: false,
  patchesAvailable: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initialState, true);
  useStore.setState({
    activeId: "s1",
    sessions: [
      {
        id: "s1",
        title: "Review",
        workspace: null,
        model: "claude-opus-4-8",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    drafts: {},
    workspaceSurface: "review",
    settings: { ...DEFAULT_SETTINGS, workspace: "D:/Projects/portcode" },
  });
  m.getGitReviewManifest.mockImplementation(async (scope) => manifest(scope));
  m.getGitReviewBranches.mockResolvedValue([...branches]);
  m.getTurnReviewManifest.mockResolvedValue(turnManifest);
  m.getTurnReviewFile.mockRejectedValue(new Error("Historical patch unavailable"));
  m.getGitReviewFile.mockImplementation(async (_scope, snapshotId, path) => {
    const file = files.find((candidate) => candidate.path === path);
    if (file?.binary) {
      return patch(path, { snapshotId, binary: true, hunks: [] });
    }
    if (path === "src/mode-only.ts") return patch(path, { snapshotId, hunks: [] });
    return patch(path, {
      snapshotId,
      oldPath: file?.oldPath ?? null,
      status: file?.status ?? "modified",
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderLoaded() {
  render(<ReviewWorkspace />);
  await screen.findByRole("table", { name: "src/App.tsx" });
}

function chooseMenuOption(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

describe("ReviewWorkspace", () => {
  it("opens a receipt-backed turn manifest without falling back to the live workspace", async () => {
    useStore.setState({ reviewTarget: { kind: "turn", turnId: "turn-1" } });

    render(<ReviewWorkspace />);

    expect(await screen.findByText("Turn changes")).toBeInTheDocument();
    expect(m.getTurnReviewManifest).toHaveBeenCalledWith("turn-1");
    expect(m.getGitReviewManifest).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox", { name: "Review scope" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh review" })).not.toBeInTheDocument();
    expect(await screen.findByText(/did not retain an immutable line patch/i)).toBeInTheDocument();
    expect(m.getTurnReviewFile).not.toHaveBeenCalled();
  });

  it("loads the working-tree manifest, groups files, and lazily opens the first patch", async () => {
    m.getGitReviewManifest.mockImplementation(async (scope) =>
      manifest(scope, { truncated: true }),
    );
    m.getGitReviewFile.mockImplementation(async (_scope, snapshotId, path) =>
      patch(path, { snapshotId, truncated: true }),
    );

    await renderLoaded();

    expect(m.getGitReviewManifest).toHaveBeenCalledWith({ kind: "workingTree" });
    expect(m.getGitReviewFile).toHaveBeenCalledWith(
      { kind: "workingTree" },
      "snapshot-workingTree",
      "src/App.tsx",
    );
    expect(screen.getByRole("navigation", { name: "Changed files" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Staged files" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Unstaged files" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Untracked files" })).toBeInTheDocument();
    expect(screen.getAllByText("src/App.tsx").length).toBeGreaterThan(1);
    expect(screen.getByText(/Snapshot fingerprinting reached/)).toBeInTheDocument();
    expect(screen.getByText(/Patch truncated/)).toBeInTheDocument();
    expect(screen.getByLabelText("added")).toHaveTextContent("A");
    expect(screen.getByLabelText("deleted")).toHaveTextContent("D");
    expect(screen.getByLabelText("renamed")).toHaveTextContent("R");
    expect(screen.getByLabelText("copied")).toHaveTextContent("C");
    expect(screen.getByLabelText("unmerged")).toHaveTextContent("U");
  });

  it("switches scopes and refreshes branch comparison immediately on selection", async () => {
    await renderLoaded();
    const scope = screen.getByRole("combobox", { name: "Review scope" });
    expect(scope.tagName).toBe("BUTTON");
    expect(screen.getByRole("banner")).toHaveClass("shrink-0");
    expect(screen.getByRole("banner")).not.toHaveClass("flex-nowrap", "overflow-x-auto");
    expect(screen.getByTestId("review-header-primary")).toHaveClass("h-[46px]");
    expect(screen.getByTestId("review-header-title")).toHaveClass("flex-1", "min-w-0");
    expect(screen.getByTestId("review-header-controls")).toHaveClass("grid", "min-h-[44px]");
    expect(screen.getByTestId("review-scope-control")).toHaveClass("min-w-0");
    expect(screen.getByTestId("review-header-summary")).toBeInTheDocument();
    expect(screen.getByText("All local changes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to chat" })).not.toBeInTheDocument();

    chooseMenuOption("Review scope", "Staged");
    await waitFor(() => expect(m.getGitReviewManifest).toHaveBeenCalledWith({ kind: "staged" }));
    expect(screen.getByText("Changes ready to commit")).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Staged files" })).toBeInTheDocument();

    chooseMenuOption("Review scope", "Unstaged");
    await waitFor(() => expect(m.getGitReviewManifest).toHaveBeenCalledWith({ kind: "unstaged" }));
    expect(screen.getByText("Changes not yet staged")).toBeInTheDocument();

    chooseMenuOption("Review scope", "Branch…");
    await waitFor(() => expect(m.getGitReviewBranches).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(m.getGitReviewManifest).toHaveBeenCalledWith({
        kind: "branch",
        base: "refs/remotes/origin/main",
      }),
    );
    const branch = screen.getByRole("combobox", { name: "Base branch" });
    expect(branch.tagName).toBe("BUTTON");
    expect(branch).toHaveTextContent("origin/main");
    expect(screen.queryByRole("textbox", { name: /Base branch/ })).not.toBeInTheDocument();
    chooseMenuOption("Base branch", "release");
    await waitFor(() =>
      expect(m.getGitReviewManifest).toHaveBeenCalledWith({
        kind: "branch",
        base: "refs/heads/release",
      }),
    );
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Changed files" })).toBeInTheDocument();

    chooseMenuOption("Review scope", "Commit…");
    const commit = screen.getByRole("textbox", { name: "Commit revision" });
    fireEvent.change(commit, { target: { value: "abc123" } });
    fireEvent.submit(commit.closest("form")!);
    await waitFor(() =>
      expect(m.getGitReviewManifest).toHaveBeenCalledWith({
        kind: "commit",
        revision: "abc123",
      }),
    );
  });

  it("disables branch review when the workspace has no branches", async () => {
    m.getGitReviewBranches.mockResolvedValue([]);
    await renderLoaded();
    const calls = m.getGitReviewManifest.mock.calls.length;

    chooseMenuOption("Review scope", "Branch…");
    const branch = await screen.findByRole("combobox", { name: "Base branch" });
    await waitFor(() => expect(branch).toHaveTextContent("No branches found"));
    expect(branch).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(m.getGitReviewManifest).toHaveBeenCalledTimes(calls);

    chooseMenuOption("Review scope", "Commit…");
    fireEvent.change(screen.getByRole("textbox", { name: "Commit revision" }), {
      target: { value: " " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(m.getGitReviewManifest).toHaveBeenCalledTimes(calls);
  });

  it("reports a workspace branch-list failure without restoring free-form input", async () => {
    m.getGitReviewBranches.mockRejectedValue(new Error("cannot enumerate refs"));
    await renderLoaded();

    chooseMenuOption("Review scope", "Branch…");
    const branch = await screen.findByRole("combobox", { name: "Base branch" });
    await waitFor(() => expect(branch).toHaveTextContent("Branches unavailable"));
    expect(branch).toHaveAttribute("title", "cannot enumerate refs");
    expect(screen.queryByRole("textbox", { name: /Base branch/ })).not.toBeInTheDocument();
  });

  it("loads selected files lazily and renders rename, binary, and metadata-only states", async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: /renamed\s*src\/renamed\.ts/ }));
    await waitFor(() =>
      expect(m.getGitReviewFile).toHaveBeenLastCalledWith(
        { kind: "workingTree" },
        "snapshot-workingTree",
        "src/renamed.ts",
      ),
    );
    expect(await screen.findByText("from src/old.ts")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /assets\/reviewer\.png\s*binary/ }));
    expect(await screen.findByText("Binary change")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /src\/mode-only\.ts/ }));
    expect(await screen.findByText("No textual hunks in this file change.")).toBeInTheDocument();
  });

  it("creates, cancels, deletes, and batches line comments into the chat draft", async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Comment on src/App.tsx base line 13" }));
    const cancelled = screen.getByRole("textbox", { name: "Comment for src/App.tsx line 13" });
    fireEvent.change(cancelled, { target: { value: "Do not drop this error." } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Do not drop this error.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Comment on src/App.tsx head line 13" }));
    const textarea = screen.getByRole("textbox", { name: "Comment for src/App.tsx line 13" });
    expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
    fireEvent.change(textarea, { target: { value: "Preserve the previous behavior." } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    expect(screen.getByText("Preserve the previous behavior.")).toBeInTheDocument();
    expect(screen.getByText("1 comment")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send to chat" }));

    expect(useStore.getState().workspaceSurface).toBe("chat");
    expect(useStore.getState().drafts.s1).toContain("src/App.tsx:13 (head)");
    expect(useStore.getState().drafts.s1).toContain("Review snapshot: snapshot-workingTree");

    useStore.getState().setWorkspaceSurface("review");
    fireEvent.click(screen.getByRole("button", { name: "Delete review comment" }));
    expect(screen.queryByText("Preserve the previous behavior.")).toBeNull();
  });

  it("appends review comments to an existing draft and disables handoff without a session", async () => {
    useStore.setState({ drafts: { s1: "Keep this draft." } });
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Comment on src/App.tsx head line 14" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment for src/App.tsx line 14" }), {
      target: { value: "Use the validated value." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    fireEvent.click(screen.getByRole("button", { name: "Send to chat" }));
    expect(useStore.getState().drafts.s1).toMatch(/^Keep this draft\.\n\nPlease address/);

    act(() => useStore.setState({ activeId: null, workspaceSurface: "review" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send to chat" })).toBeDisabled(),
    );
  });

  it("clears an unfinished comment when switching files", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Comment on src/App.tsx head line 13" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment for src/App.tsx line 13" }), {
      target: { value: "This belongs to App only." },
    });

    fireEvent.click(screen.getByRole("button", { name: /src\/new\.ts/ }));
    await screen.findByRole("table", { name: "src/new.ts" });
    fireEvent.click(screen.getByRole("button", { name: "Comment on src/new.ts head line 13" }));

    expect(screen.getByRole("textbox", { name: "Comment for src/new.ts line 13" })).toHaveValue("");
  });

  it("retains old comments but marks them outdated after the snapshot changes", async () => {
    let current = manifest();
    m.getGitReviewManifest.mockImplementation(async () => current);
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Comment on src/App.tsx head line 13" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment for src/App.tsx line 13" }), {
      target: { value: "Re-check this branch." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    current = manifest({ kind: "workingTree" }, { snapshotId: "snapshot-next" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));

    expect(await screen.findByText("0 comments · 1 outdated")).toBeInTheDocument();
    expect(screen.queryByText("Re-check this branch.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send to chat" })).toBeDisabled();
  });

  it("does not reattach a comment when the file patch changes within one snapshot", async () => {
    let filePatchHash = "patch-before";
    m.getGitReviewFile.mockImplementation(async (_scope, snapshotId, path) =>
      patch(path, { snapshotId, filePatchHash }),
    );
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Comment on src/App.tsx head line 13" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment for src/App.tsx line 13" }), {
      target: { value: "Keep this bound to the original patch." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    filePatchHash = "patch-after";
    fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));

    expect(await screen.findByText("0 comments · 1 outdated")).toBeInTheDocument();
    expect(screen.queryByText("Keep this bound to the original patch.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send to chat" })).toBeDisabled();
  });

  it("shows initial, patch, and empty-scope failure states with retry", async () => {
    m.getGitReviewManifest.mockRejectedValueOnce(new Error("not a repository"));
    render(<ReviewWorkspace />);
    expect(await screen.findByText("not a repository")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("table", { name: "src/App.tsx" });

    m.getGitReviewFile.mockRejectedValueOnce("bridge down");
    fireEvent.click(screen.getByRole("button", { name: /src\/new\.ts/ }));
    expect(await screen.findByText("bridge down")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("table", { name: "src/new.ts" });

    m.getGitReviewManifest.mockResolvedValueOnce(
      manifest(
        { kind: "workingTree" },
        { snapshotId: "empty", files: [], additions: 0, deletions: 0 },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
    expect(await screen.findByText("No changes in this scope")).toBeInTheDocument();
  });

  it("keeps the last manifest visible when a background refresh fails", async () => {
    await renderLoaded();
    m.getGitReviewManifest.mockRejectedValueOnce(new Error("temporarily unavailable"));

    fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Review unavailable: temporarily unavailable",
      ),
    );
    expect(screen.getByRole("table", { name: "src/App.tsx" })).toBeInTheDocument();
  });

  it("serializes refresh ticks, commits the active result, and queues one follow-up", async () => {
    let resolveFirst!: (value: GitReviewManifest) => void;
    let resolveSecond!: (value: GitReviewManifest) => void;
    m.getGitReviewManifest
      .mockReturnValueOnce(
        new Promise<GitReviewManifest>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<GitReviewManifest>((resolve) => {
          resolveSecond = resolve;
        }),
      );

    render(<ReviewWorkspace />);
    await waitFor(() => expect(m.getGitReviewManifest).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(m.getGitReviewManifest).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(manifest(undefined, { snapshotId: "first", baseLabel: "first result" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(m.getGitReviewManifest).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/first result →/)).toBeInTheDocument();

    await act(async () => {
      resolveSecond(manifest(undefined, { snapshotId: "follow-up", baseLabel: "follow-up" }));
      await Promise.resolve();
    });
    expect(await screen.findByText(/follow-up →/)).toBeInTheDocument();
    expect(m.getGitReviewManifest).toHaveBeenCalledTimes(2);
  });

  it("invalidates an in-flight manifest when the scope and workspace change", async () => {
    let resolveOld!: (value: GitReviewManifest) => void;
    m.getGitReviewManifest
      .mockReturnValueOnce(
        new Promise<GitReviewManifest>((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockImplementationOnce(async (nextScope) =>
        manifest(nextScope, {
          repositoryRoot: "D:/Projects/next",
          baseLabel: "fresh scope",
        }),
      );

    render(<ReviewWorkspace />);
    await waitFor(() => expect(m.getGitReviewManifest).toHaveBeenCalledTimes(1));
    chooseMenuOption("Review scope", "Staged");
    act(() => {
      useStore.setState({
        settings: { ...useStore.getState().settings, workspace: "D:/Projects/next" },
      });
    });
    expect(m.getGitReviewManifest).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveOld(manifest(undefined, { baseLabel: "stale scope" }));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(m.getGitReviewManifest).toHaveBeenLastCalledWith({ kind: "staged" }),
    );
    expect(await screen.findByText(/fresh scope →/)).toBeInTheDocument();
    expect(screen.queryByText(/stale scope →/)).toBeNull();
    expect(screen.getByTitle("D:/Projects/next")).toBeInTheDocument();
    expect(m.getGitReviewManifest).toHaveBeenCalledTimes(2);
  });

  it("invalidates an in-flight manifest while inactive and refreshes once on resume", async () => {
    let resolveHidden!: (value: GitReviewManifest) => void;
    m.getGitReviewManifest
      .mockReturnValueOnce(
        new Promise<GitReviewManifest>((resolve) => {
          resolveHidden = resolve;
        }),
      )
      .mockImplementationOnce(async (nextScope) => manifest(nextScope, { baseLabel: "resumed" }));

    const view = render(<ReviewWorkspace active />);
    await waitFor(() => expect(m.getGitReviewManifest).toHaveBeenCalledTimes(1));
    view.rerender(<ReviewWorkspace active={false} />);

    await act(async () => {
      resolveHidden(manifest(undefined, { baseLabel: "hidden stale" }));
      await Promise.resolve();
    });
    expect(screen.queryByText(/hidden stale →/)).toBeNull();
    expect(m.getGitReviewManifest).toHaveBeenCalledTimes(1);

    view.rerender(<ReviewWorkspace active />);
    expect(await screen.findByText(/resumed →/)).toBeInTheDocument();
    expect(m.getGitReviewManifest).toHaveBeenCalledTimes(2);
  });

  it("refreshes on focus, turn completion, and the visible-surface interval", async () => {
    vi.useFakeTimers();
    render(<ReviewWorkspace />);
    await act(async () => Promise.resolve());
    const initialCalls = m.getGitReviewManifest.mock.calls.length;

    act(() => window.dispatchEvent(new Event("focus")));
    await act(async () => Promise.resolve());
    expect(m.getGitReviewManifest.mock.calls.length).toBeGreaterThan(initialCalls);

    act(() => useStore.setState({ streaming: true }));
    act(() => useStore.setState({ streaming: false }));
    await act(async () => Promise.resolve());
    const afterTurn = m.getGitReviewManifest.mock.calls.length;

    act(() => vi.advanceTimersByTime(10_000));
    await act(async () => Promise.resolve());
    expect(m.getGitReviewManifest.mock.calls.length).toBeGreaterThan(afterTurn);
  });

  it("pauses hidden lifecycle refreshes and resumes without losing controller state", async () => {
    const view = render(<ReviewWorkspace active />);
    await screen.findByRole("table", { name: "src/App.tsx" });
    fireEvent.click(screen.getByRole("button", { name: "Comment on src/App.tsx head line 13" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment for src/App.tsx line 13" }), {
      target: { value: "Keep this review state." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    view.rerender(<ReviewWorkspace active={false} />);
    const callsWhileHidden = m.getGitReviewManifest.mock.calls.length;
    act(() => window.dispatchEvent(new Event("focus")));
    act(() => useStore.setState({ streaming: true }));
    act(() => useStore.setState({ streaming: false }));
    await act(async () => Promise.resolve());
    expect(m.getGitReviewManifest).toHaveBeenCalledTimes(callsWhileHidden);

    view.rerender(<ReviewWorkspace active />);
    await waitFor(() =>
      expect(m.getGitReviewManifest.mock.calls.length).toBeGreaterThan(callsWhileHidden),
    );
    expect(screen.getByText("1 comment")).toBeInTheDocument();
    expect(await screen.findByText("Keep this review state.")).toBeInTheDocument();
  });
});
