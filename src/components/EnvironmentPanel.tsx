import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type RefObject,
} from "react";

import { getWorkspaceSummary } from "../lib/ipc";
import {
  buildAgentTree,
  summarizeAgents,
  visibleAgentTree,
  type AgentBranchInfo,
} from "../lib/agentTree";
import { useStore } from "../store/store";
import type { AgentInfo, AgentStatus, WorkspaceSummary } from "../types";

const EMPTY_AGENTS: AgentInfo[] = [];
const number = new Intl.NumberFormat();

type EnvironmentPanelProviderProps = PropsWithChildren<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>;

type EnvironmentPanelContextValue = {
  agents: AgentInfo[];
  agentSummary: ReturnType<typeof summarizeAgents>;
  visibleTree: AgentBranchInfo[];
  finished: number;
  hiddenFinished: number;
  showFinished: boolean;
  setShowFinished: React.Dispatch<React.SetStateAction<boolean>>;
  summary: WorkspaceSummary | null;
  refreshing: boolean;
  loadFailed: boolean;
  workspacePath: string;
  repositoryName: string;
  head: string;
  triggerStatus: string;
  panelId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  closeRef: RefObject<HTMLButtonElement | null>;
  refresh: () => Promise<void>;
};

const EnvironmentPanelContext = createContext<EnvironmentPanelContextValue | null>(null);

/** Owns the live, read-only environment model shared by the title-bar switch and dock. */
export function EnvironmentPanelProvider({
  open,
  onOpenChange,
  children,
}: EnvironmentPanelProviderProps) {
  const activeId = useStore((state) => state.activeId);
  const agents = useStore((state) =>
    state.activeId ? (state.agents[state.activeId] ?? EMPTY_AGENTS) : EMPTY_AGENTS,
  );
  const workspace = useStore((state) => state.settings.workspace);
  const streaming = useStore((state) => state.streaming);
  const showSettings = useStore((state) => state.showSettings);
  const showPalette = useStore((state) => state.showPalette);

  const panelId = `environment-${useId().replace(/:/g, "")}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const requestVersionRef = useRef(0);
  const requestBusyRef = useRef(false);
  const requestQueuedRef = useRef(false);
  const previousStreamingRef = useRef(streaming);
  const [showFinished, setShowFinished] = useState(false);
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const agentTree = useMemo(() => buildAgentTree(agents), [agents]);
  const agentSummary = useMemo(() => summarizeAgents(agents, agentTree), [agents, agentTree]);
  const compactTree = useMemo(() => visibleAgentTree(agentTree, false), [agentTree]);
  const visibleTree = showFinished ? agentTree : compactTree;
  const finished = agentSummary.completed + agentSummary.stopped;
  const hiddenFinished = Math.max(0, finished - countFinished(compactTree));

  const restoreFocusFromPanel = useCallback(() => {
    const focused = document.activeElement;
    if (focused && panelRef.current?.contains(focused)) triggerRef.current?.focus();
  }, []);

  const refresh = useCallback(async () => {
    requestVersionRef.current += 1;
    if (requestBusyRef.current) {
      requestQueuedRef.current = true;
      return;
    }

    requestBusyRef.current = true;
    if (mountedRef.current) setRefreshing(true);
    do {
      requestQueuedRef.current = false;
      const requestVersion = requestVersionRef.current;
      try {
        const next = await getWorkspaceSummary();
        if (mountedRef.current && requestVersion === requestVersionRef.current) {
          setSummary(next);
          setLoadFailed(false);
        }
      } catch {
        if (mountedRef.current && requestVersion === requestVersionRef.current) {
          setLoadFailed(true);
        }
      }
    } while (requestQueuedRef.current && mountedRef.current);
    requestBusyRef.current = false;
    if (mountedRef.current) setRefreshing(false);
  }, []);

  useEffect(() => {
    // React Strict Mode deliberately replays setup→cleanup→setup in development;
    // restore the guard in setup so the second pass can commit async results.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestVersionRef.current += 1;
    };
  }, []);

  // Keep the trigger useful before the first open and whenever workspace changes.
  useEffect(() => {
    setSummary(null);
    setLoadFailed(false);
    void refresh();
  }, [workspace, refresh]);

  // Session/workspace changes start a fresh compact view instead of leaving a
  // popover open with context from the previously selected session.
  useEffect(() => {
    restoreFocusFromPanel();
    onOpenChange(false);
    setShowFinished(false);
  }, [activeId, workspace, onOpenChange, restoreFocusFromPanel]);

  // Never leave this lower-priority surface lurking underneath a modal.
  useEffect(() => {
    if (showSettings || showPalette) {
      restoreFocusFromPanel();
      onOpenChange(false);
    }
  }, [showSettings, showPalette, onOpenChange, restoreFocusFromPanel]);

  // Tool edits often settle at turn-end. Refresh once on that edge without
  // coupling Git polling to every agent progress event.
  useEffect(() => {
    if (previousStreamingRef.current && !streaming) void refresh();
    previousStreamingRef.current = streaming;
  }, [streaming, refresh]);

  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => void refresh(), 5_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onOpenChange(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onOpenChange]);

  const workspacePath = summary?.path ?? workspace ?? "Current directory";
  const repositoryName = basename(workspacePath);
  const git = summary?.git;
  const head =
    git?.kind === "repository"
      ? (git.branch ?? (git.detachedHead ? `detached ${git.detachedHead}` : "unknown head"))
      : git?.kind === "notRepository"
        ? "no git"
        : "workspace";
  const triggerStatus = `${agentSummary.running} running${
    agentSummary.failed > 0 ? `, ${agentSummary.failed} failed` : ""
  }`;

  return (
    <EnvironmentPanelContext.Provider
      value={{
        agents,
        agentSummary,
        visibleTree,
        finished,
        hiddenFinished,
        showFinished,
        setShowFinished,
        summary,
        refreshing,
        loadFailed,
        workspacePath,
        repositoryName,
        head,
        triggerStatus,
        panelId,
        triggerRef,
        panelRef,
        closeRef,
        refresh,
      }}
    >
      {children}
    </EnvironmentPanelContext.Provider>
  );
}

/** The compact title-bar switch. Layout state remains controlled by the desktop shell. */
export function EnvironmentPanelTrigger({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const {
    agentSummary,
    repositoryName,
    head,
    triggerStatus,
    panelId,
    triggerRef,
    closeRef,
    refresh,
  } = useEnvironmentPanel();

  return (
    <button
      ref={triggerRef}
      type="button"
      aria-label={`Environment and agents, ${head}, ${triggerStatus}`}
      aria-expanded={open}
      aria-controls={panelId}
      onClick={(event) => {
        const nextOpen = !open;
        if (nextOpen) void refresh();
        onOpenChange(nextOpen);
        if (nextOpen && event.detail === 0) {
          window.requestAnimationFrame(() => closeRef.current?.focus());
        }
      }}
      className={`flex h-[31px] max-w-[210px] items-center gap-2 rounded-[7px] border px-2.5 font-mono text-[10px] outline-none transition-[background-color,border-color,box-shadow,color] duration-150 motion-reduce:transition-none ${
        open
          ? "border-accent-2/55 bg-accent-2/12 text-fg shadow-[0_0_18px_rgba(33,230,255,0.12)]"
          : "border-border-2 bg-panel-2/80 text-muted hover:border-accent-2/35 hover:text-fg"
      } focus-visible:border-accent-2/70 focus-visible:ring-2 focus-visible:ring-accent-2/15`}
    >
      <span
        className={`pc-dot ${
          agentSummary.failed > 0
            ? "bg-danger"
            : agentSummary.running > 0
              ? "pc-dot--ring"
              : "pc-dot--success"
        }`}
        aria-hidden="true"
      />
      <span className="hidden max-w-[72px] truncate text-fg min-[900px]:inline">
        {repositoryName}
      </span>
      <span className="max-w-[82px] truncate text-accent-2">⑂ {head}</span>
      <span
        className={`min-w-5 rounded-full px-1.5 py-0.5 text-center text-[9px] ${
          agentSummary.failed > 0 ? "bg-danger/10 text-danger" : "bg-accent-2/10 text-accent-2"
        }`}
      >
        {agentSummary.running}
      </span>
      <span
        aria-hidden="true"
        className={`text-[9px] text-faint transition-transform duration-300 ease-out motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
      >
        ▾
      </span>
    </button>
  );
}

/** Read-only panel body rendered in the shell's right-hand dock. */
export function EnvironmentPanelDock({ onClose }: { onClose: () => void }) {
  const {
    agents,
    agentSummary,
    visibleTree,
    finished,
    hiddenFinished,
    showFinished,
    setShowFinished,
    summary,
    refreshing,
    loadFailed,
    workspacePath,
    repositoryName,
    panelId,
    triggerRef,
    panelRef,
    closeRef,
  } = useEnvironmentPanel();

  return (
    <section
      ref={panelRef}
      id={panelId}
      aria-label="Environment and agents"
      className="relative flex max-h-full w-full max-w-[342px] flex-col overflow-hidden rounded-xl border border-border-2 bg-[linear-gradient(160deg,rgba(17,20,29,0.99),rgba(8,10,16,0.99))] text-left shadow-[0_24px_70px_rgba(0,0,0,0.62),0_0_0_1px_rgba(255,255,255,0.018),0_0_32px_rgba(33,230,255,0.055)]"
    >
      <span
        className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-accent via-[#b06bff] to-accent-2 opacity-70"
        aria-hidden="true"
      />
      <div className="flex min-h-[55px] items-center border-b border-border px-3.5 pb-2.5 pt-3">
        <div className="min-w-0">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted">
            Environment
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-fg" title={workspacePath}>
              {repositoryName}
            </span>
            <span className="rounded bg-success/[0.07] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wide text-success">
              ● {summary?.configured === false ? "Fallback" : "Local"}
            </span>
          </div>
        </div>
        <span className="ml-auto mr-2 font-mono text-[8px] text-faint">
          {refreshing ? "Refreshing…" : "Live"}
        </span>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close environment and agents"
          onClick={() => {
            onClose();
            triggerRef.current?.focus();
          }}
          className="rounded p-1 text-[16px] leading-none text-faint outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent-2/30"
        >
          ×
        </button>
      </div>

      <div className="min-h-0 overflow-y-auto px-3 pb-2.5 pt-1.5">
        <EnvironmentFacts summary={summary} workspacePath={workspacePath} loadFailed={loadFailed} />

        <div className="flex items-center px-0.5 pb-2 pt-3">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted">
              Subagents
            </div>
            <div className="mt-0.5 font-mono text-[8px] uppercase text-faint">
              {agentSummary.roots} root · {agentSummary.children} child
            </div>
          </div>
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="ml-auto flex flex-wrap justify-end gap-1 font-mono text-[8px] uppercase"
          >
            <span className="rounded-full bg-accent-2/[0.08] px-1.5 py-0.5 text-accent-2">
              {agentSummary.running} running
            </span>
            {agentSummary.failed > 0 && (
              <span className="rounded-full bg-danger/10 px-1.5 py-0.5 text-danger">
                {agentSummary.failed} failed
              </span>
            )}
            <span className="rounded-full bg-white/[0.035] px-1.5 py-0.5 text-faint">
              {finished} done
            </span>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-bg/50">
          {agents.length === 0 ? (
            <div className="px-3 py-5 text-center text-[11px] text-faint">
              No subagents in this session
            </div>
          ) : (
            <ul
              aria-label="Agent activity"
              className="max-h-[238px] overflow-y-auto py-0.5 [scrollbar-color:#2b354d_transparent] [scrollbar-width:thin]"
            >
              {visibleTree.map((branch) => (
                <CompactAgentBranch key={branch.agent.id} branch={branch} depth={0} />
              ))}
              {hiddenFinished > 0 && (
                <li className="border-t border-border/70">
                  <button
                    type="button"
                    aria-expanded={showFinished}
                    onClick={() => setShowFinished((current) => !current)}
                    className="flex min-h-8 w-full items-center justify-between px-3 pl-8 font-mono text-[9px] uppercase text-faint outline-none transition-colors hover:bg-white/[0.025] hover:text-muted focus-visible:bg-accent-2/[0.06]"
                  >
                    <span>{showFinished ? "Hide" : "Show"} finished agents</span>
                    <span>{hiddenFinished}</span>
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** Standalone composition retained for focused component tests and isolated previews. */
export function EnvironmentPanel() {
  const [open, setOpen] = useState(false);

  return (
    <EnvironmentPanelProvider open={open} onOpenChange={setOpen}>
      <EnvironmentPanelTrigger open={open} onOpenChange={setOpen} />
      <div aria-hidden={!open || undefined} inert={!open} className={open ? "mt-1.5" : "hidden"}>
        <EnvironmentPanelDock onClose={() => setOpen(false)} />
      </div>
    </EnvironmentPanelProvider>
  );
}

function useEnvironmentPanel(): EnvironmentPanelContextValue {
  const value = useContext(EnvironmentPanelContext);
  if (!value) throw new Error("Environment panel components require EnvironmentPanelProvider");
  return value;
}

function EnvironmentFacts({
  summary,
  workspacePath,
  loadFailed,
}: {
  summary: WorkspaceSummary | null;
  workspacePath: string;
  loadFailed: boolean;
}) {
  const git = summary?.git;
  const repository = git?.kind === "repository" ? git : null;
  const changeDetail = repository
    ? repository.changedFiles === 0
      ? "Working tree clean"
      : `${number.format(repository.changedFiles)} changed ${repository.changedFiles === 1 ? "file" : "files"}${
          repository.untrackedFiles > 0
            ? ` · ${number.format(repository.untrackedFiles)} untracked`
            : ""
        }`
    : git?.kind === "notRepository"
      ? "No Git repository"
      : loadFailed || git?.kind === "unavailable"
        ? "Git status unavailable"
        : "Reading workspace…";
  const branch = repository
    ? (repository.branch ??
      (repository.detachedHead ? `Detached ${repository.detachedHead}` : "Unknown HEAD"))
    : "Branch";
  const upstream = repository?.upstream;
  const sync = repository
    ? [
        repository.ahead > 0 ? `↑${number.format(repository.ahead)}` : "",
        repository.behind > 0 ? `↓${number.format(repository.behind)}` : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "";

  return (
    <div className="border-b border-border pb-1.5">
      <FactRow
        icon="▣"
        label="Changes"
        detail={changeDetail}
        value={
          repository ? (
            <span className="flex gap-2 font-mono text-[9px]">
              <span className="text-success">+{number.format(repository.additions)}</span>
              <span className="text-danger">−{number.format(repository.deletions)}</span>
            </span>
          ) : (
            <span className="text-faint">—</span>
          )
        }
      />
      <FactRow
        icon="▱"
        label="Local"
        detail={workspacePath}
        detailTitle={workspacePath}
        value={<span className="pc-dot pc-dot--success" aria-hidden="true" />}
      />
      <FactRow
        icon="⑂"
        label={branch}
        detail={
          repository
            ? upstream
              ? `${upstream}${sync ? ` · ${sync}` : " · synced"}`
              : "No upstream"
            : changeDetail
        }
        value={
          repository ? (
            <span className="font-mono text-[8px] uppercase text-muted">
              {upstream ? "Upstream" : "Local"}
            </span>
          ) : (
            <span className="text-faint">—</span>
          )
        }
      />
    </div>
  );
}

function FactRow({
  icon,
  label,
  detail,
  detailTitle,
  value,
}: {
  icon: string;
  label: string;
  detail: string;
  detailTitle?: string;
  value: React.ReactNode;
}) {
  return (
    <div className="grid min-h-9 grid-cols-[22px_minmax(0,1fr)_auto] items-center px-0.5 py-1">
      <span className="text-[12px] text-muted" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="truncate text-[11px] text-fg">{label}</div>
        <div className="mt-0.5 truncate font-mono text-[8px] text-faint" title={detailTitle}>
          {detail}
        </div>
      </div>
      <div className="ml-2">{value}</div>
    </div>
  );
}

function CompactAgentBranch({ branch, depth }: { branch: AgentBranchInfo; depth: number }) {
  return (
    <li>
      <CompactAgentRow agent={branch.agent} depth={depth} />
      {branch.children.length > 0 && (
        <ul aria-label={`Subagents of ${branch.agent.description}`}>
          {branch.children.map((child) => (
            <CompactAgentBranch key={child.agent.id} branch={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function CompactAgentRow({ agent, depth }: { agent: AgentInfo; depth: number }) {
  const meta = agentStatus(agent.status);
  const detail =
    agent.status === "running" ? (agent.step > 0 ? `Step ${agent.step}` : "Starting") : meta.label;

  return (
    <div
      role="group"
      className={`grid min-h-[38px] grid-cols-[22px_minmax(0,1fr)_auto] items-center border-b border-border/70 py-1 pr-2 ${
        depth === 0 ? "bg-[#b06bff]/[0.025]" : "bg-white/[0.012]"
      }`}
      style={{ paddingLeft: 8 + Math.min(depth, 3) * 14 }}
      aria-label={`${agent.description}, ${detail}`}
    >
      <span
        className={`grid h-3.5 w-3.5 place-items-center rounded text-[8px] ${meta.glyph}`}
        aria-hidden="true"
      >
        {depth === 0 ? "◆" : "↳"}
      </span>
      <div className="min-w-0">
        <div className="truncate text-[10px] text-fg" title={agent.description}>
          {agent.description}
        </div>
        <div className={`mt-0.5 font-mono text-[8px] uppercase ${meta.text}`}>
          {depth === 0 ? "Root" : "Child"} · {meta.label}
        </div>
      </div>
      <span className={`ml-2 font-mono text-[8px] uppercase ${meta.text}`}>{detail}</span>
    </div>
  );
}

function agentStatus(status: AgentStatus): { label: string; text: string; glyph: string } {
  switch (status) {
    case "running":
      return {
        label: "Working",
        text: "text-accent-2",
        glyph: "bg-accent-2 text-bg shadow-[0_0_10px_rgba(33,230,255,0.22)]",
      };
    case "ok":
      return {
        label: "Completed",
        text: "text-success",
        glyph: "border border-success/20 bg-success/[0.08] text-success",
      };
    case "cancelled":
      return {
        label: "Stopped",
        text: "text-faint",
        glyph: "border border-border bg-white/[0.03] text-faint",
      };
    case "error":
      return {
        label: "Failed",
        text: "text-danger",
        glyph: "border border-danger/30 bg-danger/10 text-danger",
      };
  }
}

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || path || "Workspace";
}

function countFinished(branches: AgentBranchInfo[]): number {
  let total = 0;
  for (const branch of branches) {
    if (branch.agent.status === "ok" || branch.agent.status === "cancelled") total += 1;
    total += countFinished(branch.children);
  }
  return total;
}
