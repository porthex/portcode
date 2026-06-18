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

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 py-6">
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            messages.map((m) => <MessageView key={m.id} message={m} />)
          )}
        </div>
      </div>
      <PermissionPrompt />
      <Composer />
    </div>
  );
}

function EmptyState() {
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
        A fast, native AI coding agent for Windows. Ask it to read, edit, and run
        code in your workspace. Describe a task to get started.
      </p>
      <div className="mt-4 flex items-center gap-2 text-xs text-muted">
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
        <span>for commands</span>
        <span className="mx-1 text-border">·</span>
        <Kbd>Ctrl</Kbd>
        <Kbd>B</Kbd>
        <span>for files</span>
      </div>
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
