import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as ipc from "../../lib/ipc";
import { useStore } from "../../store/store";
import type {
  GitChangeArea,
  GitChangedFile,
  GitDiffHunk,
  GitDiffLine,
  GitFilePatch,
  GitReviewManifest,
  GitReviewScope,
} from "../../types";

type ScopeKind = GitReviewScope["kind"];
type CommentSide = "base" | "head";

interface ReviewComment {
  id: string;
  snapshotId: string;
  filePatchHash: string;
  path: string;
  side: CommentSide;
  line: number;
  hunkHeader: string;
  body: string;
}

interface DraftAnchor {
  side: CommentSide;
  line: number;
  hunkHeader: string;
}

const AREA_LABELS: Record<GitChangeArea, string> = {
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
  committed: "Changed files",
};

const AREA_ORDER: GitChangeArea[] = ["staged", "unstaged", "untracked", "committed"];

export function ReviewWorkspace({ active = true }: { active?: boolean }) {
  const workspace = useStore((state) => state.settings.workspace);
  const activeId = useStore((state) => state.activeId);
  const currentDraft = useStore((state) =>
    state.activeId ? (state.drafts[state.activeId] ?? "") : "",
  );
  const setDraft = useStore((state) => state.setDraft);
  const setWorkspaceSurface = useStore((state) => state.setWorkspaceSurface);
  const streaming = useStore((state) => state.streaming);

  const [scope, setScope] = useState<GitReviewScope>({ kind: "workingTree" });
  const [scopeKind, setScopeKind] = useState<ScopeKind>("workingTree");
  const [reference, setReference] = useState("origin/main");
  const [manifest, setManifest] = useState<GitReviewManifest | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [patch, setPatch] = useState<GitFilePatch | null>(null);
  const [manifestLoading, setManifestLoading] = useState(true);
  const [patchLoading, setPatchLoading] = useState(false);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [filePatchHashes, setFilePatchHashes] = useState(() => new Map<string, string>());
  const [draftAnchor, setDraftAnchor] = useState<DraftAnchor | null>(null);
  const [commentBody, setCommentBody] = useState("");

  const manifestRequest = useRef(0);
  const patchRequest = useRef(0);
  const previousStreaming = useRef(streaming);
  const previousActive = useRef(active);
  const activeRef = useRef(active);
  activeRef.current = active;

  const refresh = useCallback(async () => {
    const request = ++manifestRequest.current;
    setRefreshing(true);
    setManifestLoading(true);
    try {
      const next = await ipc.getGitReviewManifest(scope);
      if (request !== manifestRequest.current) return;
      setManifest((current) => {
        if (current?.snapshotId !== next.snapshotId) {
          patchRequest.current += 1;
          setPatch(null);
          setDraftAnchor(null);
        }
        return next;
      });
      setSelectedPath((current) =>
        current && next.files.some((file) => file.path === current)
          ? current
          : (next.files[0]?.path ?? null),
      );
      setManifestError(null);
    } catch (error) {
      if (request === manifestRequest.current) setManifestError(errorMessage(error));
    } finally {
      if (request === manifestRequest.current) {
        setManifestLoading(false);
        setRefreshing(false);
      }
    }
  }, [scope]);

  useEffect(() => {
    setManifest(null);
    setSelectedPath(null);
    setPatch(null);
    setManifestError(null);
    if (activeRef.current) void refresh();
    return () => {
      manifestRequest.current += 1;
      patchRequest.current += 1;
    };
  }, [refresh, workspace]);

  useEffect(() => {
    if (!active) return;
    const onFocus = () => void refresh();
    const interval = window.setInterval(() => void refresh(), 10_000);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [active, refresh]);

  useEffect(() => {
    if (active && !previousActive.current) {
      void refresh();
    } else if (!active && previousActive.current) {
      manifestRequest.current += 1;
      patchRequest.current += 1;
      setManifestLoading(false);
      setPatchLoading(false);
      setRefreshing(false);
    }
    previousActive.current = active;
  }, [active, refresh]);

  useEffect(() => {
    if (active && previousStreaming.current && !streaming) void refresh();
    previousStreaming.current = streaming;
  }, [active, streaming, refresh]);

  useEffect(() => {
    if (!active) return;
    if (!manifest || !selectedPath) {
      setPatch(null);
      return;
    }
    const request = ++patchRequest.current;
    setPatchLoading(true);
    setPatchError(null);
    void ipc
      .getGitReviewFile(scope, manifest.snapshotId, selectedPath)
      .then((next) => {
        if (request === patchRequest.current) {
          setFilePatchHashes((current) => {
            const updated = new Map(current);
            updated.set(filePatchKey(next.snapshotId, next.path), next.filePatchHash);
            return updated;
          });
          setPatch(next);
        }
      })
      .catch((error) => {
        if (request === patchRequest.current) setPatchError(errorMessage(error));
      })
      .finally(() => {
        if (request === patchRequest.current) setPatchLoading(false);
      });
    return () => {
      patchRequest.current += 1;
    };
  }, [active, manifest, scope, selectedPath]);

  const groups = useMemo(() => groupFiles(manifest), [manifest]);
  const selectedFile = manifest?.files.find((file) => file.path === selectedPath) ?? null;
  const currentComments = comments.filter(
    (comment) =>
      comment.snapshotId === manifest?.snapshotId &&
      filePatchHashes.get(filePatchKey(comment.snapshotId, comment.path)) === comment.filePatchHash,
  );
  const staleComments = comments.length - currentComments.length;

  const applyScope = () => {
    if (scopeKind === "branch") {
      const base = reference.trim();
      if (base) setScope({ kind: "branch", base });
    } else if (scopeKind === "commit") {
      const revision = reference.trim();
      if (revision) setScope({ kind: "commit", revision });
    }
  };

  const chooseScopeKind = (kind: ScopeKind) => {
    setScopeKind(kind);
    if (kind === "workingTree" || kind === "staged" || kind === "unstaged") {
      setScope({ kind });
    }
  };

  const addComment = () => {
    const body = commentBody.trim();
    if (!body || !draftAnchor || !patch || !manifest) return;
    setComments((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        snapshotId: manifest.snapshotId,
        filePatchHash: patch.filePatchHash,
        path: patch.path,
        side: draftAnchor.side,
        line: draftAnchor.line,
        hunkHeader: draftAnchor.hunkHeader,
        body,
      },
    ]);
    setCommentBody("");
    setDraftAnchor(null);
  };

  const sendCommentsToChat = () => {
    if (!activeId || !manifest || currentComments.length === 0) return;
    const reviewText = formatComments(manifest, currentComments);
    setDraft([currentDraft.trim(), reviewText].filter(Boolean).join("\n\n"));
    setWorkspaceSurface("chat");
  };

  return (
    <section
      aria-label="Review workspace"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg/80"
    >
      <header className="flex min-h-[54px] shrink-0 flex-wrap items-center gap-2 border-b border-border bg-panel/75 px-3 py-2">
        <div className="mr-1 min-w-0">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-accent-2">
            Review workspace
          </div>
          <div className="truncate text-[11px] text-faint" title={manifest?.repositoryRoot}>
            {manifest?.repositoryRoot ?? workspace ?? "Current directory"}
          </div>
        </div>
        <label className="sr-only" htmlFor="review-scope">
          Review scope
        </label>
        <select
          id="review-scope"
          aria-label="Review scope"
          value={scopeKind}
          onChange={(event) => chooseScopeKind(event.target.value as ScopeKind)}
          className="rounded-md border border-border-2 bg-panel-2 px-2.5 py-1.5 text-[11px] text-fg outline-none focus:border-accent-2"
        >
          <option value="workingTree">Working tree</option>
          <option value="staged">Staged</option>
          <option value="unstaged">Unstaged</option>
          <option value="branch">Branch…</option>
          <option value="commit">Commit…</option>
        </select>
        {(scopeKind === "branch" || scopeKind === "commit") && (
          <form
            className="flex min-w-[220px] flex-1 items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              applyScope();
            }}
          >
            <input
              aria-label={scopeKind === "branch" ? "Base branch or revision" : "Commit revision"}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border-2 bg-bg px-2.5 py-1.5 font-mono text-[11px] text-fg outline-none focus:border-accent-2"
            />
            <button type="submit" className="pc-btn-deny px-2.5 py-1.5 text-[11px]">
              Apply
            </button>
          </form>
        )}
        {manifest && (
          <div className="ml-auto flex items-center gap-2 font-mono text-[10px]">
            <span className="hidden max-w-[250px] truncate text-faint min-[900px]:inline">
              {manifest.baseLabel} → {manifest.targetLabel}
            </span>
            <span className="text-success">+{manifest.additions}</span>
            <span className="text-danger">−{manifest.deletions}</span>
          </div>
        )}
        <button
          type="button"
          aria-label="Refresh review"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="rounded-md border border-border-2 px-2.5 py-1.5 text-[11px] text-muted outline-none hover:border-accent-2/50 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent-2/25 disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <button
          type="button"
          onClick={() => setWorkspaceSurface("chat")}
          className="rounded-md px-2 py-1.5 text-[11px] text-faint outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent-2/25"
        >
          Back to chat
        </button>
      </header>

      <span className="sr-only" role="status" aria-live="polite">
        {refreshing
          ? "Refreshing review"
          : manifestError
            ? `Review unavailable: ${manifestError}`
            : ""}
      </span>

      {manifestError && !manifest ? (
        <ReviewError message={manifestError} onRetry={() => void refresh()} />
      ) : manifestLoading && !manifest ? (
        <div className="grid min-h-0 flex-1 place-items-center text-[12px] text-faint">
          Reading Git changes…
        </div>
      ) : manifest?.files.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
          <div>
            <div className="text-[14px] font-medium text-fg">No changes in this scope</div>
            <div className="mt-1 text-[11px] text-faint">
              {manifest.baseLabel} → {manifest.targetLabel}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)] max-[820px]:grid-cols-1">
          <aside className="flex min-h-0 flex-col border-r border-border bg-panel/35 max-[820px]:max-h-[220px] max-[820px]:border-b max-[820px]:border-r-0">
            <div className="flex items-center border-b border-border px-3 py-2">
              <div>
                <div className="text-[11px] font-medium text-fg">
                  {manifest?.files.length ?? 0} changed files
                </div>
                <div className="font-mono text-[8px] uppercase text-faint">
                  {currentComments.length} comment{currentComments.length === 1 ? "" : "s"}
                  {staleComments > 0 ? ` · ${staleComments} outdated` : ""}
                </div>
              </div>
              <button
                type="button"
                disabled={!activeId || currentComments.length === 0}
                onClick={sendCommentsToChat}
                className="ml-auto rounded-md border border-accent-2/30 bg-accent-2/[0.06] px-2 py-1 text-[9px] text-accent-2 outline-none hover:bg-accent-2/[0.11] focus-visible:ring-2 focus-visible:ring-accent-2/25 disabled:cursor-not-allowed disabled:opacity-35"
              >
                Send to chat
              </button>
            </div>
            {manifest?.truncated && (
              <div className="border-b border-warn/20 bg-warn/[0.05] px-3 py-2 text-[9px] text-warn">
                Snapshot fingerprinting reached a safety cap; refresh before acting on old comments.
              </div>
            )}
            <nav aria-label="Changed files" className="min-h-0 flex-1 overflow-y-auto py-1">
              {groups.map((group) => (
                <FileGroup
                  key={group.area}
                  area={group.area}
                  files={group.files}
                  selectedPath={selectedPath}
                  onSelect={(path) => {
                    setSelectedPath(path);
                    setDraftAnchor(null);
                  }}
                />
              ))}
            </nav>
          </aside>

          <main className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            {selectedFile && (
              <div className="flex min-h-[43px] shrink-0 items-center gap-2 border-b border-border bg-panel/30 px-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[11px] text-fg" title={selectedFile.path}>
                    {selectedFile.path}
                  </div>
                  {selectedFile.oldPath && (
                    <div className="truncate font-mono text-[8px] text-faint">
                      from {selectedFile.oldPath}
                    </div>
                  )}
                </div>
                <FileCounts file={selectedFile} />
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-auto" data-testid="review-diff-scroll">
              {patchLoading ? (
                <div className="grid min-h-40 place-items-center text-[11px] text-faint">
                  Loading patch…
                </div>
              ) : patchError ? (
                <ReviewError message={patchError} onRetry={() => void refresh()} compact />
              ) : patch?.binary ? (
                <div className="grid min-h-48 place-items-center px-6 text-center">
                  <div>
                    <div className="text-[13px] text-fg">Binary change</div>
                    <div className="mt-1 text-[10px] text-faint">
                      This file has no line-addressable text diff.
                    </div>
                  </div>
                </div>
              ) : patch ? (
                <ReviewDiff
                  patch={patch}
                  comments={comments}
                  draftAnchor={draftAnchor}
                  commentBody={commentBody}
                  onStartComment={setDraftAnchor}
                  onCommentBodyChange={setCommentBody}
                  onAddComment={addComment}
                  onCancelComment={() => {
                    setDraftAnchor(null);
                    setCommentBody("");
                  }}
                  onDeleteComment={(id) =>
                    setComments((current) => current.filter((comment) => comment.id !== id))
                  }
                />
              ) : null}
            </div>
          </main>
        </div>
      )}
    </section>
  );
}

function FileGroup({
  area,
  files,
  selectedPath,
  onSelect,
}: {
  area: GitChangeArea;
  files: GitChangedFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="pb-1">
      <div className="flex items-center justify-between px-3 pb-1 pt-2 font-mono text-[8px] uppercase tracking-[0.15em] text-faint">
        <span>{AREA_LABELS[area]}</span>
        <span>{files.length}</span>
      </div>
      <ul aria-label={area === "committed" ? "Changed files" : `${AREA_LABELS[area]} files`}>
        {files.map((file) => (
          <li key={`${area}:${file.path}`}>
            <button
              type="button"
              aria-current={selectedPath === file.path ? "true" : undefined}
              onClick={() => onSelect(file.path)}
              className={`grid min-h-9 w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-1.5 border-l-2 px-2.5 text-left outline-none transition-colors ${
                selectedPath === file.path
                  ? "border-accent-2 bg-accent-2/[0.07] text-fg"
                  : "border-transparent text-muted hover:bg-white/[0.025] hover:text-fg focus-visible:border-accent-2/60 focus-visible:bg-accent-2/[0.04]"
              }`}
            >
              <StatusGlyph status={file.status} />
              <span className="truncate font-mono text-[10px]" title={file.path}>
                {file.path}
              </span>
              <FileCounts file={file} compact />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewDiff({
  patch,
  comments,
  draftAnchor,
  commentBody,
  onStartComment,
  onCommentBodyChange,
  onAddComment,
  onCancelComment,
  onDeleteComment,
}: {
  patch: GitFilePatch;
  comments: ReviewComment[];
  draftAnchor: DraftAnchor | null;
  commentBody: string;
  onStartComment: (anchor: DraftAnchor) => void;
  onCommentBodyChange: (body: string) => void;
  onAddComment: () => void;
  onCancelComment: () => void;
  onDeleteComment: (id: string) => void;
}) {
  if (patch.hunks.length === 0) {
    return (
      <div className="grid min-h-40 place-items-center px-6 text-center text-[11px] text-faint">
        No textual hunks in this file change.
      </div>
    );
  }
  return (
    <div className="min-w-max pb-8 font-mono text-[11px]" role="table" aria-label={patch.path}>
      {patch.hunks.map((hunk, hunkIndex) => (
        <DiffHunk
          key={`${hunk.header}:${hunkIndex}`}
          patch={patch}
          hunk={hunk}
          comments={comments}
          draftAnchor={draftAnchor}
          commentBody={commentBody}
          onStartComment={onStartComment}
          onCommentBodyChange={onCommentBodyChange}
          onAddComment={onAddComment}
          onCancelComment={onCancelComment}
          onDeleteComment={onDeleteComment}
        />
      ))}
      {patch.truncated && (
        <div className="border-y border-warn/20 bg-warn/[0.04] px-4 py-2 text-warn">
          Patch truncated at the native safety limit.
        </div>
      )}
    </div>
  );
}

function DiffHunk({
  patch,
  hunk,
  comments,
  draftAnchor,
  commentBody,
  onStartComment,
  onCommentBodyChange,
  onAddComment,
  onCancelComment,
  onDeleteComment,
}: {
  patch: GitFilePatch;
  hunk: GitDiffHunk;
  comments: ReviewComment[];
  draftAnchor: DraftAnchor | null;
  commentBody: string;
  onStartComment: (anchor: DraftAnchor) => void;
  onCommentBodyChange: (body: string) => void;
  onAddComment: () => void;
  onCancelComment: () => void;
  onDeleteComment: (id: string) => void;
}) {
  return (
    <div role="rowgroup">
      <div
        role="row"
        className="sticky top-0 z-10 border-y border-violet/20 bg-violet/[0.08] px-3 py-1.5 text-[10px] text-violet backdrop-blur-sm"
      >
        {hunk.header}
      </div>
      {hunk.lines.map((line, lineIndex) => {
        const anchor = commentAnchor(line, hunk.header);
        const lineComments = anchor
          ? comments.filter(
              (comment) =>
                comment.snapshotId === patch.snapshotId &&
                comment.filePatchHash === patch.filePatchHash &&
                comment.path === patch.path &&
                comment.side === anchor.side &&
                comment.line === anchor.line,
            )
          : [];
        const composing =
          anchor &&
          draftAnchor?.side === anchor.side &&
          draftAnchor.line === anchor.line &&
          draftAnchor.hunkHeader === anchor.hunkHeader;
        return (
          <div key={`${hunk.header}:${lineIndex}`} role="rowgroup">
            <div
              role="row"
              className={`group grid min-h-[22px] grid-cols-[44px_44px_22px_minmax(420px,1fr)] border-l-2 ${lineClass(line)}`}
            >
              <span
                role="cell"
                className="select-none border-r border-border/60 px-2 text-right text-faint"
              >
                {line.oldLine ?? ""}
              </span>
              <span
                role="cell"
                className="select-none border-r border-border/60 px-2 text-right text-faint"
              >
                {line.newLine ?? ""}
              </span>
              <span role="cell" className="select-none text-center text-faint" aria-hidden="true">
                {linePrefix(line)}
              </span>
              <span role="cell" className="relative whitespace-pre pr-9 text-fg/90">
                {line.content || " "}
                {anchor && (
                  <button
                    type="button"
                    aria-label={`Comment on ${patch.path} ${anchor.side} line ${anchor.line}`}
                    onClick={() => onStartComment(anchor)}
                    className="absolute right-1 top-0.5 rounded border border-accent-2/30 bg-panel px-1.5 text-[10px] text-accent-2 opacity-0 outline-none transition-opacity group-hover:opacity-100 focus:opacity-100 focus-visible:ring-2 focus-visible:ring-accent-2/30"
                  >
                    +
                  </button>
                )}
              </span>
            </div>
            {lineComments.map((comment) => (
              <div
                key={comment.id}
                className="ml-[110px] mr-3 my-1 max-w-[760px] rounded-md border border-accent-2/20 bg-accent-2/[0.055] px-3 py-2 font-sans text-[11px] text-fg"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1 whitespace-pre-wrap">{comment.body}</div>
                  <button
                    type="button"
                    aria-label="Delete review comment"
                    onClick={() => onDeleteComment(comment.id)}
                    className="shrink-0 text-faint outline-none hover:text-danger focus-visible:ring-2 focus-visible:ring-danger/30"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
            {composing && (
              <div className="ml-[110px] mr-3 my-1 max-w-[760px] rounded-md border border-accent-2/35 bg-panel p-2.5">
                <textarea
                  autoFocus
                  aria-label={`Comment for ${patch.path} line ${anchor.line}`}
                  value={commentBody}
                  onChange={(event) => onCommentBodyChange(event.target.value)}
                  rows={3}
                  className="w-full resize-y rounded border border-border-2 bg-bg px-2.5 py-2 font-sans text-[11px] text-fg outline-none focus:border-accent-2"
                  placeholder="What should change here?"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={!commentBody.trim()}
                    onClick={onAddComment}
                    className="pc-btn-allow px-2.5 py-1 text-[10px] disabled:opacity-40"
                  >
                    Add comment
                  </button>
                  <button
                    type="button"
                    onClick={onCancelComment}
                    className="pc-btn-deny px-2.5 py-1 text-[10px]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ReviewError({
  message,
  onRetry,
  compact = false,
}: {
  message: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={`grid place-items-center px-6 text-center ${compact ? "min-h-40" : "min-h-0 flex-1"}`}
    >
      <div>
        <div className="text-[13px] text-danger">Review unavailable</div>
        <div className="mt-1 max-w-xl text-[10px] text-faint">{message}</div>
        <button
          type="button"
          onClick={onRetry}
          className="pc-btn-deny mt-3 px-3 py-1.5 text-[11px]"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function StatusGlyph({ status }: { status: GitChangedFile["status"] }) {
  const glyph =
    status === "added"
      ? "A"
      : status === "deleted"
        ? "D"
        : status === "unmerged"
          ? "U"
          : status === "renamed"
            ? "R"
            : status === "copied"
              ? "C"
              : "M";
  const color =
    status === "added"
      ? "text-success"
      : status === "deleted" || status === "unmerged"
        ? "text-danger"
        : status === "renamed" || status === "copied"
          ? "text-violet"
          : "text-warn";
  return (
    <span aria-label={status} className={`font-mono text-[9px] ${color}`}>
      {glyph}
    </span>
  );
}

function FileCounts({ file, compact = false }: { file: GitChangedFile; compact?: boolean }) {
  if (file.binary) {
    return <span className="font-mono text-[8px] uppercase text-faint">binary</span>;
  }
  return (
    <span className={`flex gap-1.5 font-mono ${compact ? "text-[8px]" : "text-[9px]"}`}>
      <span className="text-success">+{file.additions ?? 0}</span>
      <span className="text-danger">−{file.deletions ?? 0}</span>
    </span>
  );
}

function groupFiles(manifest: GitReviewManifest | null) {
  if (!manifest) return [];
  return AREA_ORDER.map((area) => ({
    area,
    files: manifest.files.filter((file) => file.areas.includes(area)),
  })).filter((group) => group.files.length > 0);
}

function filePatchKey(snapshotId: string, path: string) {
  return `${snapshotId}\0${path}`;
}

function commentAnchor(line: GitDiffLine, hunkHeader: string): DraftAnchor | null {
  if (line.kind === "deletion" && line.oldLine !== null) {
    return { side: "base", line: line.oldLine, hunkHeader };
  }
  if (line.kind !== "meta" && line.newLine !== null) {
    return { side: "head", line: line.newLine, hunkHeader };
  }
  return null;
}

function linePrefix(line: GitDiffLine) {
  if (line.kind === "addition") return "+";
  if (line.kind === "deletion") return "−";
  if (line.kind === "meta") return "·";
  return " ";
}

function lineClass(line: GitDiffLine) {
  if (line.kind === "addition") return "border-success/60 bg-success/[0.075]";
  if (line.kind === "deletion") return "border-danger/60 bg-danger/[0.075]";
  if (line.kind === "meta") return "border-violet/40 bg-violet/[0.04] text-violet";
  return "border-transparent hover:bg-white/[0.018]";
}

function formatComments(manifest: GitReviewManifest, comments: ReviewComment[]) {
  const lines = comments.map(
    (comment, index) =>
      `${index + 1}. ${comment.path}:${comment.line} (${comment.side}) — ${comment.body}`,
  );
  return [
    `Please address these review comments for ${manifest.baseLabel} → ${manifest.targetLabel}.`,
    `Review snapshot: ${manifest.snapshotId}`,
    "Re-open the current files before editing; stop and ask if an anchor is stale or ambiguous.",
    "",
    ...lines,
  ].join("\n");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
