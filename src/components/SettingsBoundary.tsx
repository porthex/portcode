import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useStore } from "../store/store";
import { ErrorBoundary } from "./ErrorBoundary";

/** Keeps a Settings-only render failure from replacing the entire agent workspace. */
export function SettingsBoundary({ children }: { children: ReactNode }) {
  const setShowSettings = useStore((state) => state.setShowSettings);
  const openerRef = useRef<HTMLElement | null>(null);
  const openerCapturedRef = useRef(false);
  if (!openerCapturedRef.current) {
    openerCapturedRef.current = true;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  const returnToChat = (reset: () => void) => {
    setShowSettings(false);
    reset();
  };

  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <SettingsRecovery
          error={error}
          opener={openerRef.current}
          onReturn={() => returnToChat(reset)}
          onRetry={reset}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

function SettingsRecovery({
  error,
  opener,
  onReturn,
  onRetry,
}: {
  error: Error;
  opener: HTMLElement | null;
  onReturn: () => void;
  onRetry: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const returnRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    returnRef.current?.focus();
    const overlay = overlayRef.current;
    const siblings = overlay?.parentElement
      ? Array.from(overlay.parentElement.children).filter((node) => node !== overlay)
      : [];
    const snapshots = siblings.map((node) => ({
      node,
      inert: node.hasAttribute("inert"),
      ariaHidden: node.getAttribute("aria-hidden"),
    }));
    for (const { node } of snapshots) {
      node.setAttribute("inert", "");
      node.setAttribute("aria-hidden", "true");
    }
    return () => {
      for (const { node, inert, ariaHidden } of snapshots) {
        if (!inert) node.removeAttribute("inert");
        if (ariaHidden === null) node.removeAttribute("aria-hidden");
        else node.setAttribute("aria-hidden", ariaHidden);
      }
      if (restoreFocusRef.current && opener?.isConnected) opener.focus();
    };
  }, [opener]);

  const returnAndRestoreFocus = () => {
    restoreFocusRef.current = true;
    onReturn();
  };

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      returnAndRestoreFocus();
      return;
    }
    if (event.key !== "Tab") return;
    const first = returnRef.current;
    const last = retryRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={overlayRef}
      className="pc-overlay z-[58] items-center justify-center p-6"
      onKeyDown={trapFocus}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="pc-settings-error-title"
        className="pc-modal w-full max-w-lg overflow-hidden p-6"
      >
        <div className="pc-eyebrow mb-2">SETTINGS RECOVERY</div>
        <h2
          id="pc-settings-error-title"
          className="font-display text-lg font-semibold tracking-wide text-accent"
        >
          Settings couldn&apos;t open
        </h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
          Your chat and running agents are still safe. You can return immediately or retry this
          panel after the transient error clears.
        </p>
        <pre className="mt-4 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg border border-danger/25 bg-danger/[0.06] p-3 font-mono text-[11px] text-danger">
          {error.message || "Unexpected Settings error"}
        </pre>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={returnRef}
            type="button"
            onClick={returnAndRestoreFocus}
            className="rounded-lg border border-border-2 bg-panel-2 px-3 py-2 text-[12px] text-muted hover:text-fg"
          >
            Return to chat
          </button>
          <button
            ref={retryRef}
            type="button"
            onClick={onRetry}
            className="pc-btn-accent px-3 py-2 text-[12px]"
          >
            Try settings again
          </button>
        </div>
      </div>
    </div>
  );
}
