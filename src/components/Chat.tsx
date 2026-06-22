import { useEffect, useRef } from "react";
import { useStore } from "../store/store";
import { MessageView } from "./Message";
import { Composer } from "./Composer";
import { PermissionPrompt } from "./PermissionPrompt";
import type { Message } from "../types";

// Stable reference so the selector never returns a fresh array (which would
// trip useSyncExternalStore's infinite-loop guard).
const EMPTY: Message[] = [];

export function Chat() {
  const activeId = useStore((s) => s.activeId);
  const messages = useStore((s) => (activeId && s.messages[activeId]) || EMPTY);
  const streaming = useStore((s) => s.streaming);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether the viewport is pinned to the bottom. We only auto-follow new content
  // while the user is already at the bottom — otherwise scrolling up to read history
  // (especially mid-stream, when the decode grows the transcript ~45x/sec) would
  // yank the view back down on every frame and wrestle scroll away from the user.
  const stuckToBottom = useRef(true);

  // Track whether the user is near the bottom; a programmatic scroll keeps it true.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // A freshly-selected session starts pinned to its latest message.
  useEffect(() => {
    stuckToBottom.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stuckToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

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
      if (stuckToBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [streaming]);

  const lastIndex = messages.length - 1;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div ref={contentRef} className="w-full max-w-none px-6 py-6">
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            messages.map((m, i) => (
              <MessageView
                key={m.id}
                message={m}
                isActive={streaming && i === lastIndex && m.role === "assistant"}
              />
            ))
          )}
        </div>
      </div>
      <PermissionPrompt />
      <Composer />
    </div>
  );
}

function EmptyState() {
  // Keyboard shortcuts are meaningless on the phone (no Ctrl key, and the file
  // explorer is desktop-only), so the hint row is desktop-only.
  const remoteMode = useStore((s) => s.remoteMode);
  return (
    <div className="mt-24 flex flex-col items-center text-center">
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
      {!remoteMode && (
        <div className="mt-4 flex items-center gap-2 text-xs text-muted">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
          <span>for commands</span>
          <span className="mx-1 text-border">·</span>
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
