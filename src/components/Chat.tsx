import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "../store/store";
import { MessageView } from "./Message";
import { Composer } from "./Composer";
import { PermissionPrompt } from "./PermissionPrompt";
import { CodexRequestPrompt } from "./CodexRequestPrompt";
import { type Message } from "../types";
import type { AgentInfo } from "../types";

// Stable reference so the selector never returns a fresh array (which would
// trip useSyncExternalStore's infinite-loop guard).
const EMPTY: Message[] = [];

const TRANSCRIPT_VERTICAL_PADDING_PX = 48;
const BOTTOM_PIN_THRESHOLD_PX = 16;

const agentsForLaunchTurn = (
  agents: readonly AgentInfo[] | undefined,
  turnId: string | null | undefined,
): AgentInfo[] | undefined => {
  if (!agents || !turnId) return undefined;
  const ownedIds = new Set(
    agents.filter((agent) => agent.launchTurnId === turnId).map((agent) => agent.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const agent of agents) {
      if (
        !ownedIds.has(agent.id) &&
        ((agent.parentId && ownedIds.has(agent.parentId)) ||
          (agent.parentThreadId && ownedIds.has(agent.parentThreadId)))
      ) {
        ownedIds.add(agent.id);
        changed = true;
      }
    }
  }
  const result = agents.filter((agent) => ownedIds.has(agent.id));
  return result.length > 0 ? result : undefined;
};

type ChatProps = {
  transcriptAside?: ReactNode;
  transcriptAsideOpen?: boolean;
};

export function Chat({ transcriptAside, transcriptAsideOpen = false }: ChatProps = {}) {
  const activeId = useStore((s) => s.activeId);
  const messages = useStore((s) => (activeId && s.messages[activeId]) || EMPTY);

  const hasCachedMessages = useStore((s) => Boolean(activeId && activeId in s.messages));
  const messageLoad = useStore((s) => (activeId ? s.messageLoads[activeId] : undefined));
  const streaming = useStore((s) => s.streaming);
  const activeRun = useStore((s) => (s.activeId ? s.runs[s.activeId] : undefined));
  const activeAgents = useStore((s) => (s.activeId ? s.agents[s.activeId] : undefined));
  const agentsByLaunchTurn = useMemo(() => {
    const byTurn = new Map<string, AgentInfo[]>();
    if (!activeAgents) return byTurn;
    for (const agent of activeAgents) {
      const turnId = agent.launchTurnId;
      if (!turnId || byTurn.has(turnId)) continue;
      const owned = agentsForLaunchTurn(activeAgents, turnId);
      if (owned) byTurn.set(turnId, owned);
    }
    return byTurn;
  }, [activeAgents]);

  const remoteMode = useStore((s) => s.remoteMode);
  const openTurnReview = useStore((s) => s.openTurnReview);
  const initError = useStore((s) => s.initError);
  const loadError = useStore((s) => (activeId ? s.loadErrors[activeId] : false));
  const retryInit = useStore((s) => s.retryInit);
  const retryLoad = useStore((s) => s.retryLoad);
  const scrollTargetId = useStore((s) => s.scrollTargetId);
  const clearScrollTarget = useStore((s) => s.clearScrollTarget);
  const transcriptScrollRequest = useStore((s) => s.transcriptScrollRequest);
  const clearTranscriptScrollRequest = useStore((s) => s.clearTranscriptScrollRequest);
  const workspaceSurface = useStore((s) => s.workspaceSurface);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const currentTurnRef = useRef<HTMLDivElement>(null);
  // Whether the viewport is pinned to the bottom. We only auto-follow new content
  // while the user is already at the bottom — otherwise scrolling up to read history
  // (especially mid-stream, when the decode grows the transcript ~45x/sec) would
  // yank the view back down on every frame and wrestle scroll away from the user.
  const stuckToBottom = useRef(true);
  // Mirror of stuckToBottom in render state so the "scroll to latest" button can
  // appear/hide reactively (the ref alone wouldn't re-render).
  const [pinned, setPinned] = useState(true);
  const [hasUnreadActivity, setHasUnreadActivity] = useState(false);
  const unreadActivityRef = useRef(false);
  const followFrameRef = useRef<number | null>(null);
  const previousLatestAssistantRef = useRef<Message | undefined>(undefined);
  // After this client sends a turn, keep that turn at least one transcript viewport
  // tall. Bottom-following then places the user bubble at the top while the answer
  // grows into the space below (Claude/Codex-style), without exposing older turns.
  // Keying by session prevents a switch from leaking the runway into another chat.
  const [turnAnchorSessionId, setTurnAnchorSessionId] = useState<string | null>(null);
  const requestedNewTurn = Boolean(
    activeId &&
    transcriptScrollRequest?.kind === "newTurn" &&
    transcriptScrollRequest.sessionId === activeId,
  );
  const anchorCurrentTurn =
    Boolean(activeId && turnAnchorSessionId === activeId) || requestedNewTurn;
  let currentTurnStart = -1;
  if (anchorCurrentTurn) {
    const requestedMessageId = requestedNewTurn
      ? transcriptScrollRequest?.targetMessageId
      : undefined;
    if (requestedMessageId) {
      currentTurnStart = messages.findIndex((message) => message.id === requestedMessageId);
    }
    // Authoritative remote catch-up can replace an optimistic id. The newest user
    // row is still the correct turn boundary, so use it as the durable fallback.
    if (currentTurnStart < 0) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === "user") {
          currentTurnStart = index;
          break;
        }
      }
    }
  }
  // Anchor for preserving scroll position across a PREPEND (scroll-up pagination):
  // the prior render's scrollHeight + the id of the prior first message. When older
  // rows land in front, the content above the viewport grows; restoring scrollTop by
  // the height delta keeps the message the user was reading visually in place instead
  // of jumping. Tracked per the messages array's identity.
  const prevScrollHeight = useRef(0);
  const prevFirstId = useRef<string | null>(null);

  // Distance from the top below which scrolling up triggers loading older history.
  const LOAD_OLDER_THRESHOLD_PX = 200;

  const sizeCurrentTurn = useCallback(() => {
    const scroller = scrollRef.current;
    const turn = currentTurnRef.current;
    if (!scroller || !turn) return;
    turn.style.minHeight = `${Math.max(
      0,
      scroller.clientHeight - TRANSCRIPT_VERTICAL_PADDING_PX,
    )}px`;
  }, []);

  const updateUnreadActivity = useCallback((next: boolean) => {
    if (unreadActivityRef.current === next) return;
    unreadActivityRef.current = next;
    setHasUnreadActivity(next);
  }, []);

  const scheduleBottomFollow = useCallback(() => {
    if (followFrameRef.current !== null) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null;
      const scroller = scrollRef.current;
      if (scroller && stuckToBottom.current) scroller.scrollTop = scroller.scrollHeight;
    });
  }, []);

  useEffect(
    () => () => {
      if (followFrameRef.current !== null) cancelAnimationFrame(followFrameRef.current);
    },
    [],
  );

  // Track whether the user is near the bottom; a programmatic scroll keeps it true.
  // Also drives scroll-up pagination: when the user nears the TOP in remote mode and
  // older history exists, request the next page. Live store reads (getState) avoid a
  // stale closure without re-subscribing the listener on every paging change.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_PIN_THRESHOLD_PX;
      const pinChanged = stuckToBottom.current !== atBottom;
      stuckToBottom.current = atBottom;
      if (pinChanged) setPinned(atBottom);
      if (!atBottom && followFrameRef.current !== null) {
        cancelAnimationFrame(followFrameRef.current);
        followFrameRef.current = null;
      }
      if (atBottom) updateUnreadActivity(false);
      // Near the top → load older messages (remote mode only). Read live state so the
      // guards (connected / hasMore / not already loading) reflect the latest store,
      // not the values captured when this listener was attached.
      if (el.scrollTop < LOAD_OLDER_THRESHOLD_PX) {
        const st = useStore.getState();
        const id = st.activeId;
        if (!id) return;
        const p = st.messagePaging[id];
        const load = st.messageLoads[id];
        const canLoadLocal = !st.remoteConnected && Boolean(load?.nextCursor);
        const canLoadRemote = st.remoteConnected && p?.hasMore !== false;
        if ((!canLoadLocal && !canLoadRemote) || p?.loading || load?.loadingOlder) return;
        void st.loadOlderMessages(id);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [updateUnreadActivity]);

  // Keep the current-turn runway matched to the real transcript viewport (the
  // composer and permission banner can both change it).
  useLayoutEffect(() => {
    if (!anchorCurrentTurn || currentTurnStart < 0) return;
    sizeCurrentTurn();
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sizeCurrentTurn);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [anchorCurrentTurn, currentTurnStart, sizeCurrentTurn]);

  // A session identity change jumps before paint. Keeping the bottom pin enabled
  // means a cold history load that lands a tick later also finishes at its latest
  // row instead of leaving the viewport at the old session's scroll offset.
  useLayoutEffect(() => {
    setTurnAnchorSessionId(null);
    stuckToBottom.current = true;
    setPinned(true);
    updateUnreadActivity(false);
    previousLatestAssistantRef.current = undefined;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId, updateUnreadActivity]);

  useLayoutEffect(() => {
    if (stuckToBottom.current) scheduleBottomFollow();
  }, [messages, scheduleBottomFollow, streaming]);

  const latestAssistant = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant") return messages[index];
    }
    return undefined;
  })();

  useLayoutEffect(() => {
    const previous = previousLatestAssistantRef.current;
    previousLatestAssistantRef.current = latestAssistant;
    if (previous && latestAssistant !== previous && !stuckToBottom.current) {
      updateUnreadActivity(true);
    }
  }, [latestAssistant, updateUnreadActivity]);

  // Explicit navigation requests also cover re-selecting the already-active chat,
  // which an activeId-only effect cannot observe. A new turn keeps its viewport
  // runway after the one-shot request is consumed; selecting Latest removes it.
  useLayoutEffect(() => {
    const request = transcriptScrollRequest;
    if (!request || request.sessionId !== activeId || (!remoteMode && workspaceSurface !== "chat"))
      return;
    const el = scrollRef.current;
    if (!el) return;

    if (request.kind === "newTurn") {
      const turn = currentTurnRef.current;
      if (!turn || currentTurnStart < 0) return;
      sizeCurrentTurn();
      setTurnAnchorSessionId(activeId);
    } else {
      // The wrapper may still exist for an earlier anchored turn during this layout
      // pass. Remove its runway before measuring the true transcript bottom.
      if (currentTurnRef.current) currentTurnRef.current.style.minHeight = "";
      setTurnAnchorSessionId(null);
    }

    stuckToBottom.current = true;
    setPinned(true);
    updateUnreadActivity(false);
    el.scrollTop = el.scrollHeight;
    clearTranscriptScrollRequest(request.id);
  }, [
    activeId,
    clearTranscriptScrollRequest,
    currentTurnStart,
    messages,
    remoteMode,
    sizeCurrentTurn,
    transcriptScrollRequest,
    updateUnreadActivity,
    workspaceSurface,
  ]);

  // A ⌘K search result asked to reveal a specific past message: scroll it into view
  // once it's in the DOM (it can arrive a tick later when the session was just
  // loaded), then clear the request. Declared after the bottom-followers above so it
  // wins on a jump. Leaves the target set until the element exists, so a still-loading
  // session retries on the next messages update instead of losing the scroll.
  useEffect(() => {
    if (!scrollTargetId) return;
    const el = document.getElementById(`pc-msg-${scrollTargetId}`);
    if (!el) return;
    el.scrollIntoView?.({ block: "center" });
    clearScrollTarget();
  }, [scrollTargetId, messages, clearScrollTarget]);

  // Preserve the reading position when an older page is PREPENDED. Runs on every
  // messages change, before paint: if the first message id changed (rows were added
  // in front) while NOT pinned to the bottom, bump scrollTop by the height the
  // prepend added, so the previously-visible message stays put instead of the view
  // snapping upward. The activeId reset effect (which pins to bottom) handles a
  // session switch; here we only act on a same-session prepend.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      prevScrollHeight.current = 0;
      prevFirstId.current = null;
      return;
    }
    const firstId = messages[0]?.id ?? null;
    const prepended =
      !stuckToBottom.current &&
      prevFirstId.current !== null &&
      firstId !== prevFirstId.current &&
      el.scrollHeight > prevScrollHeight.current;
    if (prepended) {
      el.scrollTop += el.scrollHeight - prevScrollHeight.current;
    }
    prevScrollHeight.current = el.scrollHeight;
    prevFirstId.current = firstId;
  }, [messages]);

  // The decode reveal grows the transcript height between store updates, so follow
  // it to the bottom while a turn streams — but only while the user is still pinned
  // to the bottom (never fight a user who scrolled up). ResizeObserver is absent in
  // jsdom — guard so tests don't choke.
  useEffect(() => {
    if (!streaming) return;
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stuckToBottom.current) scheduleBottomFollow();
      else updateUnreadActivity(true);
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scheduleBottomFollow, streaming, updateUnreadActivity]);

  const lastIndex = messages.length - 1;
  const coldLoading = Boolean(
    activeId &&
    messages.length === 0 &&
    (!hasCachedMessages || messageLoad?.phase === "idle" || messageLoad?.phase === "loading"),
  );
  const coldError = messages.length === 0 && (messageLoad?.phase === "error" || loadError);
  const refreshError = messages.length > 0 && messageLoad?.phase === "error";
  const reviewTurn = useCallback(
    (receipt: NonNullable<Message["receipt"]>) => openTurnReview(receipt.turnId),
    [openTurnReview],
  );

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuckToBottom.current = true;
    setPinned(true);
    updateUnreadActivity(false);
  };

  const renderMessage = (message: Message, index: number) => {
    const isActiveAssistant = streaming && index === lastIndex && message.role === "assistant";
    const isRunMessage =
      message.role === "assistant" &&
      Boolean(
        activeRun?.turnId &&
        (message.turnId === activeRun.turnId || message.id === activeRun.turnId),
      );
    const run = isRunMessage ? activeRun : undefined;
    const activityTurnId = message.turnId ?? (isRunMessage ? activeRun?.turnId : undefined);
    const turnAgents = activityTurnId ? agentsByLaunchTurn.get(activityTurnId) : undefined;
    const turnPresentation =
      run && (run.streaming || run.finalizing)
        ? {
            active: run.streaming,
            startedAt: run.startedAt,
            waiting: run.pendingPermission !== null,
            // Stop acknowledgement also uses `finalizing`, but the response is
            // complete only after streaming turns false.
            finalizing: run.finalizing && !run.streaming,
          }
        : undefined;
    return (
      <MessageView
        key={message.id}
        message={message}
        isActive={isActiveAssistant}
        turnPresentation={turnPresentation}
        agents={turnAgents}
        onReviewChanges={reviewTurn}
        reviewAvailable={!remoteMode}
      />
    );
  };

  const renderedMessages =
    currentTurnStart >= 0 ? (
      <>
        {messages.slice(0, currentTurnStart).map((message, index) => renderMessage(message, index))}
        <div ref={currentTurnRef} data-testid="chat-current-turn" className="min-w-0">
          {messages
            .slice(currentTurnStart)
            .map((message, index) => renderMessage(message, currentTurnStart + index))}
        </div>
      </>
    ) : (
      messages.map(renderMessage)
    );

  return (
    <div data-testid="chat-shell" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* The scroller spans the transcript so its gutter stays at the far-right edge.
          The dock overlays that surface while only message content makes room. */}
      <div
        data-testid="chat-transcript-layout"
        className="@container relative min-h-0 flex-1 overflow-hidden"
      >
        <div className="absolute inset-0 min-w-0">
          <div
            ref={scrollRef}
            data-testid="chat-transcript-scroll"
            className="absolute inset-0 overflow-y-auto [scrollbar-gutter:stable]"
          >
            <div
              ref={contentRef}
              data-testid="chat-transcript-content"
              className={`w-full max-w-none px-6 py-6 transition-[padding-right] duration-300 ease-out motion-reduce:transition-none ${
                transcriptAside && transcriptAsideOpen ? "@min-[734px]:pr-[390px]" : ""
              }`}
              role="log"
              aria-live="polite"
              aria-relevant="additions text"
              aria-busy={streaming || coldLoading || messageLoad?.phase === "refreshing"}
              // Programmatically focusable (not in the Tab order) so the
              // PermissionPrompt can route focus back here when a gated turn clears
              // mid-stream and its Deny button unmounts.
              tabIndex={-1}
            >
              {initError ? (
                <InitErrorPanel message={initError} onRetry={() => void retryInit()} />
              ) : coldError ? (
                <LoadErrorPanel onRetry={() => activeId && void retryLoad(activeId)} />
              ) : coldLoading ? (
                <TranscriptSkeleton />
              ) : messages.length === 0 ? (
                <EmptyState />
              ) : (
                renderedMessages
              )}
              {refreshError && (
                <RefreshErrorNotice onRetry={() => activeId && void retryLoad(activeId)} />
              )}
            </div>
          </div>
          {!pinned && messages.length > 0 && (
            <button
              type="button"
              aria-label={hasUnreadActivity ? "Scroll to latest, new activity" : "Scroll to latest"}
              onClick={scrollToBottom}
              className={`pc-fab-enter absolute bottom-4 right-4 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-panel text-fg transition-[right,opacity] duration-300 ease-out hover:border-accent-2 hover:shadow-[var(--shadow-glow-cyan)] active:brightness-90 motion-reduce:transition-none ${
                transcriptAside && transcriptAsideOpen ? "@min-[734px]:right-[382px]" : ""
              }`}
            >
              {hasUnreadActivity && (
                <span
                  data-testid="chat-unread-indicator"
                  aria-hidden="true"
                  className="absolute right-1 top-1 h-2 w-2 rounded-full bg-danger shadow-[0_0_8px_var(--color-danger)]"
                />
              )}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M6 9l6 6 6-6"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
        {transcriptAside && (
          <div
            data-testid="chat-transcript-aside"
            aria-hidden={!transcriptAsideOpen || undefined}
            inert={!transcriptAsideOpen}
            className="pointer-events-none absolute inset-y-0 right-3 z-10 flex w-[calc(100%-12px)] max-w-[354px] justify-end overflow-hidden"
          >
            <div
              data-testid="chat-transcript-aside-frame"
              className={`pointer-events-auto flex h-full w-full flex-none items-start justify-end py-3 pl-3 transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none ${
                transcriptAsideOpen
                  ? "translate-x-0 opacity-100 delay-75 motion-reduce:delay-0"
                  : "pointer-events-none translate-x-3 opacity-0"
              }`}
            >
              {transcriptAside}
            </div>
          </div>
        )}
      </div>
      <PermissionPrompt />
      <CodexRequestPrompt />
      <div data-testid="chat-composer-area" className="w-full min-h-0 shrink">
        <Composer />
      </div>
    </div>
  );
}

function InitErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="mt-24 mx-auto flex max-w-md flex-col items-center gap-3 text-center"
    >
      <h1 className="text-lg font-semibold text-danger">Couldn't start Portcode</h1>
      <p className="text-sm text-muted">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg border border-border bg-panel px-3 py-1.5 text-sm text-fg hover:border-accent"
      >
        Retry
      </button>
    </div>
  );
}

function LoadErrorPanel({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="mt-24 mx-auto flex max-w-md flex-col items-center gap-3 text-center"
    >
      <p className="text-sm text-danger">Couldn't load this conversation.</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg border border-border bg-panel px-3 py-1.5 text-sm text-fg hover:border-accent"
      >
        Retry
      </button>
    </div>
  );
}

function TranscriptSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading conversation"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-7"
    >
      <span className="text-center font-mono text-[11px] uppercase tracking-[1.6px] text-faint">
        Loading conversationâ€¦
      </span>
      <div aria-hidden="true" className="flex flex-col gap-6">
        <SkeletonMessage align="right" width="w-[58%]" />
        <SkeletonMessage align="left" width="w-[78%]" />
        <SkeletonMessage align="left" width="w-[64%]" />
      </div>
    </div>
  );
}

function SkeletonMessage({ align, width }: { align: "left" | "right"; width: string }) {
  return (
    <div
      className={`${width} ${align === "right" ? "ml-auto" : "mr-auto"} rounded-xl border border-border/60 bg-panel/60 p-4`}
    >
      <div className="h-2.5 w-24 animate-pulse rounded bg-border-2/70 motion-reduce:animate-none" />
      <div className="mt-3 h-2.5 w-full animate-pulse rounded bg-border/80 motion-reduce:animate-none" />
      <div className="mt-2 h-2.5 w-[72%] animate-pulse rounded bg-border/60 motion-reduce:animate-none" />
    </div>
  );
}

function RefreshErrorNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="sticky bottom-2 mx-auto mt-5 flex w-fit items-center gap-2 rounded-lg border border-danger/30 bg-panel/95 px-3 py-2 text-xs text-muted shadow-lg"
    >
      <span>Couldnâ€™t refresh this conversation. Showing cached messages.</span>
      <button type="button" onClick={onRetry} className="font-medium text-accent-2 hover:underline">
        Retry
      </button>
    </div>
  );
}

function EmptyState() {
  // Keyboard shortcuts are meaningless on the phone (no Ctrl key, and the file
  // explorer is desktop-only), so the hint row is desktop-only.
  const remoteMode = useStore((s) => s.remoteMode);
  const openAIAuthStatus = useStore((s) => s.openAIAuthStatus);
  const openAIAccountsError = useStore((s) => s.openAIAccountsError);
  const activeSession = useStore((s) =>
    s.activeId
      ? (s.sessions.find((session) => session.id === s.activeId) ??
        (s.pendingSession?.id === s.activeId ? s.pendingSession : undefined))
      : undefined,
  );
  const activeOpenAIAccount = useStore((s) =>
    activeSession?.accountProfileId
      ? s.openAIAccounts.find((account) => account.id === activeSession.accountProfileId)
      : undefined,
  );
  const connectedOpenAIAccountCount = useStore(
    (s) => s.openAIAccounts.filter((account) => account.state === "connected").length,
  );
  const setShowSettings = useStore((s) => s.setShowSettings);
  const refreshOpenAIStatus = useStore((s) => s.refreshOpenAIStatus);
  const openAIUnavailable = openAIAuthStatus?.available === false;
  const openAIRegistryUnavailable = Boolean(
    activeSession?.accountProfileId && !activeOpenAIAccount && openAIAccountsError,
  );
  const authed =
    !openAIUnavailable &&
    (activeSession ? activeOpenAIAccount?.state === "connected" : connectedOpenAIAccountCount > 0);
  const authNudge = openAIRegistryUnavailable
    ? "This chat's ChatGPT account is unavailable because account discovery failed"
    : openAIUnavailable
      ? `${openAIAuthStatus?.unavailableReason ?? "Codex authentication is unavailable in this build"}. Connect ChatGPT or an OpenAI Platform API key in Settings to start`
      : activeSession?.accountProfileId
        ? "Reconnect this chat's ChatGPT account to start"
        : activeSession
          ? "Connect ChatGPT or an OpenAI Platform API key in Settings to start"
          : "Connect ChatGPT or an OpenAI Platform API key to start";
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="mb-4 rounded-2xl border border-border bg-panel p-4">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
          <path
            d="M7 8l3 4-3 4M13 16h5"
            stroke="var(--color-accent)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h1 className="text-lg font-semibold">Portcode</h1>
      <p className="mt-1 max-w-md text-sm text-muted">
        A fast, native AI coding agent for Windows. Ask it to read, edit, and run code in your
        workspace. Describe a task to get started.
      </p>
      {!remoteMode && !authed && (
        <div className="mt-4 flex items-center gap-2 text-xs text-muted">
          <span>{authNudge}</span>
          {openAIRegistryUnavailable ? (
            <>
              <button
                type="button"
                onClick={() => void refreshOpenAIStatus()}
                className="rounded border border-border bg-panel px-2 py-0.5 text-fg hover:border-accent"
              >
                Retry accounts
              </button>
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="rounded border border-border bg-panel px-2 py-0.5 text-fg hover:border-accent"
              >
                Manage accounts
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="rounded border border-border bg-panel px-2 py-0.5 text-fg hover:border-accent"
            >
              Open settings
            </button>
          )}
        </div>
      )}
      {!remoteMode && (
        <div className="mt-4 flex items-center gap-2 text-xs text-muted">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
          <span>for commands</span>
          <span className="mx-1 text-faint">·</span>
          <Kbd>Ctrl</Kbd>
          <Kbd>B</Kbd>
          <span>for files</span>
        </div>
      )}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-panel px-1.5 py-0.5 font-mono text-[11px] text-fg">
      {children}
    </kbd>
  );
}
