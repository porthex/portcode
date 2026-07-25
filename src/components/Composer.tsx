import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import * as ipc from "../lib/ipc";
import { toolPresence } from "../lib/toolNames";
import { modelsForOpenAIProfile, preferredOpenAIAccount, useStore } from "../store/store";
import {
  DANGER_MODES,
  fastServiceTierForModel,
  modelInfo,
  openAIAccountLabel,
  providerGroups,
  reasoningEffortForModel,
  reasoningEffortLabel,
  type Attachment,
  type PermissionMode,
  type ResponseSpeed,
} from "../types";
import { SelectMenu } from "./SelectMenu";
import { ComposerEditor } from "./ComposerEditor";

/** Read the active session's model, falling back to the global default. */
function useActiveModel(): string {
  return useStore((s) => {
    const sess = s.activeId
      ? (s.sessions.find((x) => x.id === s.activeId) ??
        (s.pendingSession?.id === s.activeId ? s.pendingSession : undefined))
      : undefined;
    return sess?.model ?? s.settings.model;
  });
}

// Auto-grow cap; kept in sync with the editor's inline maxHeight so the JS
// target and the CSS clip agree (otherwise growth stops short at the smaller).
const MAX_TEXTAREA_H = 220;
const EMPTY_ATTACHMENTS: Attachment[] = [];

function attachmentPaths(files: ArrayLike<File>): string[] {
  return Array.from(files)
    .map((file) => (file as File & { path?: string }).path?.trim() ?? "")
    .filter((path): path is string => path.length > 0);
}

type AttachmentReviewIdentity = {
  nextId: number;
  idsByPath: Map<string, number>;
  disambiguatedPaths: Set<string>;
};

function attachmentReviewLabels(
  attachments: Attachment[],
  identity: AttachmentReviewIdentity | undefined,
): Map<string, string> {
  return new Map(
    attachments.map((attachment) => {
      const id = identity?.idsByPath.get(attachment.path);
      const label =
        identity?.disambiguatedPaths.has(attachment.path) && id !== undefined
          ? `${attachment.name} <attachment ${id}>`
          : attachment.name;
      return [attachment.path, label];
    }),
  );
}

function attachmentTypeLabel(attachment: Attachment): string {
  const dot = attachment.name.lastIndexOf(".");
  return dot >= 0 && dot < attachment.name.length - 1
    ? attachment.name.slice(dot + 1).toUpperCase()
    : attachment.kind.toUpperCase();
}

function attachmentSizeLabel(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + " MiB";
}

// The live presence phrases, derived from REAL turn/stream state (never padded
// latency). The dot color honors the brand semantics: cyan = the agent at work,
// danger = a Stop in flight, faint = at rest.
function presenceFor(
  streaming: boolean,
  phase: "idle" | "received" | "thinking" | "stopping",
  tool: string | null,
): { text: string; dot: string } {
  if (phase === "stopping") return { text: "stopping…", dot: "pc-dot pc-dot--danger" };
  if (!streaming) return { text: "ready when you are", dot: "pc-dot--idle" };
  if (phase === "received") return { text: "got it — reading…", dot: "pc-dot pc-dot--cyan" };
  // A tool is concretely running — name it honestly (driven by real tool_use events).
  // Gated on the "thinking" phase (reliably reset to idle at every turn end) so a
  // residual tool label can never surface on a new turn before its first real event.
  if (phase === "thinking" && tool) return { text: toolPresence(tool), dot: "pc-dot pc-dot--cyan" };
  return { text: "thinking with you…", dot: "pc-dot pc-dot--cyan" };
}

export function Composer() {
  const attachmentReviewIdentitiesRef = useRef(new Map<string, AttachmentReviewIdentity>());
  const [, bumpAttachmentReviewIdentity] = useState(0);
  const [pickerError, setPickerError] = useState<string | null>(null);
  // Per-session draft: read the ACTIVE session's draft so a half-written message
  // can't bleed across sessions (the old single global `draft` did exactly that).
  const activeId = useStore((s) => s.activeId);
  const text = useStore((s) => (s.activeId ? (s.drafts[s.activeId] ?? "") : ""));
  const hasCachedMessages = useStore((s) => Boolean(s.activeId && s.activeId in s.messages));
  const messageLoad = useStore((s) => (s.activeId ? s.messageLoads[s.activeId] : undefined));
  const setText = useStore((s) => s.setDraft);
  const attachments = useStore((s) =>
    s.activeId ? (s.attachments[s.activeId] ?? EMPTY_ATTACHMENTS) : EMPTY_ATTACHMENTS,
  );
  useLayoutEffect(() => {
    if (!activeId) return;
    const pathsByName = new Map<string, string[]>();
    const rawNames = new Set<string>();
    for (const attachment of attachments) {
      rawNames.add(attachment.name);
      const paths = pathsByName.get(attachment.name) ?? [];
      paths.push(attachment.path);
      pathsByName.set(attachment.name, paths);
    }

    let identity = attachmentReviewIdentitiesRef.current.get(activeId);
    let changed = false;
    if (!identity) {
      identity = {
        nextId: 1,
        idsByPath: new Map(),
        disambiguatedPaths: new Set(),
      };
      attachmentReviewIdentitiesRef.current.set(activeId, identity);
      changed = true;
    }
    for (const paths of pathsByName.values()) {
      if (paths.length <= 1) continue;
      for (const path of paths) {
        if (!identity.disambiguatedPaths.has(path)) {
          identity.disambiguatedPaths.add(path);
          changed = true;
        }
      }
    }

    const generatedLabels = new Set<string>();
    for (const attachment of attachments) {
      if (!identity.disambiguatedPaths.has(attachment.path)) continue;

      const currentId = identity.idsByPath.get(attachment.path);
      const currentLabel =
        currentId === undefined ? null : `${attachment.name} <attachment ${currentId}>`;
      if (
        currentLabel !== null &&
        !rawNames.has(currentLabel) &&
        !generatedLabels.has(currentLabel)
      ) {
        generatedLabels.add(currentLabel);
        continue;
      }

      let id: number;
      let label: string;
      do {
        id = identity.nextId;
        identity.nextId += 1;
        label = `${attachment.name} <attachment ${id}>`;
      } while (rawNames.has(label) || generatedLabels.has(label));
      identity.idsByPath.set(attachment.path, id);
      generatedLabels.add(label);
      changed = true;
    }
    if (changed) bumpAttachmentReviewIdentity((revision) => revision + 1);
  }, [activeId, attachments]);
  const attachmentLabels = attachmentReviewLabels(
    attachments,
    activeId ? attachmentReviewIdentitiesRef.current.get(activeId) : undefined,
  );
  for (const attachment of attachments) {
    if (attachment.displayName) attachmentLabels.set(attachment.path, attachment.displayName);
  }
  const attachmentError = useStore((s) =>
    s.activeId ? (s.attachmentErrors[s.activeId] ?? null) : null,
  );
  const canRetryAttachmentValidation = useStore((s) =>
    s.activeId ? (s.attachmentRetryPaths[s.activeId]?.length ?? 0) > 0 : false,
  );
  const canRetryAttachmentSend = useStore((s) =>
    Boolean(s.activeId && s.attachmentSendErrors[s.activeId]),
  );
  const attachmentBusy = useStore((s) => Boolean(s.activeId && s.attachmentBusy[s.activeId]));
  const addAttachments = useStore((s) => s.addAttachments);
  const retryAttachmentValidation = useStore((s) => s.retryAttachmentValidation);
  const removeAttachment = useStore((s) => s.removeAttachment);
  const clearAttachmentError = useStore((s) => s.clearAttachmentError);
  const streaming = useStore((s) => s.streaming);
  const activeRun = useStore((s) => (s.activeId ? s.runs[s.activeId] : undefined));
  const finalizing = activeRun?.finalizing ?? false;
  const outcome = activeRun?.outcome ?? null;
  const composerPhase = useStore((s) => s.composerPhase);
  const activeTool = useStore((s) => s.activeTool);
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const stopSession = useStore((s) => s.stopSession);
  const newSession = useStore((s) => s.newSession);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const remoteMode = useStore((s) => s.remoteMode);
  const remoteConnected = useStore((s) => s.remoteConnected);
  const activeSession = useStore((s) =>
    s.activeId
      ? (s.sessions.find((session) => session.id === s.activeId) ??
        (s.pendingSession?.id === s.activeId ? s.pendingSession : undefined))
      : undefined,
  );
  const openAIAccounts = useStore((s) => s.openAIAccounts);
  const defaultOpenAIAccountProfileId = useStore((s) => s.lastOpenAIAccountProfileId);
  const pinSessionOpenAIAccount = useStore((s) => s.pinSessionOpenAIAccount);
  const settings = useStore((s) => s.settings);
  const openAIAuthStatus = useStore((s) => s.openAIAuthStatus);
  const settingsError = useStore((s) => s.settingsError);
  const ref = useRef<HTMLDivElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  const attachmentRemoveRefs = useRef(new Map<string, HTMLButtonElement>());
  const [dragActive, setDragActive] = useState(false);
  // The pixel height of a single, empty row. Captured lazily from a collapsed
  // editor so the post-submit collapse has a concrete target to ease toward —
  // CSS height transitions can't interpolate to/from "auto" (the browser
  // resolves it instantly), which otherwise kills the collapse animation.
  const rowHeightRef = useRef<number | null>(null);

  // Send is fireable only with non-whitespace content and no turn in flight.
  const openAIUnavailable = openAIAuthStatus?.available === false;
  const activeOpenAIAccount = activeSession?.accountProfileId
    ? openAIAccounts.find((account) => account.id === activeSession.accountProfileId)
    : undefined;
  const unassignedOpenAISession = !activeSession?.accountProfileId;
  useEffect(() => {
    if (remoteMode || streaming || !activeSession || activeSession.accountProfileId) {
      return;
    }
    const defaultAccount = preferredOpenAIAccount(openAIAccounts, defaultOpenAIAccountProfileId);
    if (defaultAccount) {
      void pinSessionOpenAIAccount(activeSession.id, defaultAccount.id);
    }
  }, [
    activeSession,
    defaultOpenAIAccountProfileId,
    openAIAccounts,
    pinSessionOpenAIAccount,
    remoteMode,
    streaming,
  ]);
  const authenticated =
    (remoteMode && remoteConnected) ||
    (!openAIUnavailable && activeOpenAIAccount?.state === "connected");
  const authHint = openAIUnavailable
    ? (openAIAuthStatus?.unavailableReason ??
      "ChatGPT subscription access is unavailable in this build")
    : unassignedOpenAISession
      ? "Connect ChatGPT or an OpenAI Platform API key in Settings to send"
      : activeOpenAIAccount?.state === "reconnect_required"
        ? `Reconnect ${openAIAccountLabel(activeOpenAIAccount, openAIAccounts)} in Settings to send`
        : activeSession?.accountProfileId
          ? "This session's Codex authentication is unavailable"
          : "Connect ChatGPT or an OpenAI Platform API key in Settings to send";
  const authAction = "Open settings";
  const historyReady = Boolean(
    activeId &&
    (messageLoad === undefined ||
      messageLoad.phase === "ready" ||
      messageLoad.phase === "refreshing" ||
      (messageLoad.phase === "error" && hasCachedMessages)),
  );
  const coldLoadError = Boolean(activeId && messageLoad?.phase === "error" && !hasCachedMessages);
  const hasAttachments = attachments.length > 0;
  const attachmentLocked = streaming || finalizing || attachmentBusy || !activeId;
  const attachmentLockedRef = useRef(attachmentLocked);
  useEffect(() => {
    attachmentLockedRef.current = attachmentLocked;
    if (attachmentLocked) setDragActive(false);
  }, [attachmentLocked]);
  const canSend =
    (text.trim().length > 0 || hasAttachments) &&
    !streaming &&
    !finalizing &&
    !attachmentBusy &&
    authenticated &&
    historyReady;
  // Armed cue (motor anticipation): a one-shot pulse the moment Send becomes
  // fireable. Seeded from the initial value so a restored draft doesn't pulse on
  // mount — only a genuine disabled→enabled transition arms it.
  const [armed, setArmed] = useState(false);
  const prevCanSend = useRef(canSend);
  const prevActiveId = useRef(activeId);
  useEffect(() => {
    // A session switch flips canSend without any typing (the new session just has a
    // different draft) — that's a non-event, so don't fire the pulse for it. Only a
    // genuine in-session disabled→enabled transition (the user typed) arms it.
    if (activeId !== prevActiveId.current) {
      prevActiveId.current = activeId;
      prevCanSend.current = canSend;
      return;
    }
    if (canSend && !prevCanSend.current) setArmed(true);
    prevCanSend.current = canSend;
  }, [canSend, activeId]);
  // One-shot: drop the pulse class shortly after it plays (slightly past the 0.3s
  // animation) so a later disabled→enabled transition can re-trigger it.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 320);
    return () => clearTimeout(t);
  }, [armed]);

  const stopping = composerPhase === "stopping";
  const presence = !activeId
    ? { text: "Create or select a chat to start", dot: "pc-dot--idle" }
    : coldLoadError
      ? { text: "conversation unavailable — retry above", dot: "pc-dot pc-dot--danger" }
      : !historyReady
        ? { text: "loading conversationâ€¦", dot: "pc-dot pc-dot--cyan" }
        : !authenticated
          ? { text: authHint, dot: "pc-dot pc-dot--danger" }
          : finalizing && !streaming
            ? { text: "response complete · checking file changes…", dot: "pc-dot--idle" }
            : attachmentBusy && streaming
              ? { text: "awaiting acceptance…", dot: "pc-dot pc-dot--cyan" }
              : presenceFor(streaming, composerPhase, activeTool);
  const placeholder = !activeId
    ? "Create or select a chat to begin…"
    : streaming
      ? "Draft your next message while Portcode works…"
      : finalizing
        ? "Draft your next message while Portcode checks file changes…"
        : settings.permissionMode === "plan"
          ? "Describe what you want planned — files will stay untouched…"
          : "Describe a task, ask a question, or give an instruction…";

  // Keep the editor height in sync when the draft changes externally
  // (e.g. a file path inserted from the explorer, or switching sessions).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (rowHeightRef.current == null && el.clientHeight > 0) {
      rowHeightRef.current = el.clientHeight;
    }
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_H);
    // Memoize the single-row height the first time we see a collapsed editor,
    // so an accepted send can animate down to a px value instead of snapping via "auto".
    if (rowHeightRef.current == null && !text) rowHeightRef.current = el.scrollHeight;
    el.style.height = next + "px";
  }, [text]);

  // Return focus to the composer when a turn finishes if focus was otherwise lost.
  // Never steal it from a permission button, picker, or another input, and never pop
  // the software keyboard on the phone. Drafting remains available during the run.
  useEffect(() => {
    if (streaming || finalizing || remoteMode) return;
    const el = ref.current;
    if (el?.isContentEditable && document.activeElement === document.body) el.focus();
  }, [streaming, finalizing, remoteMode]);

  useEffect(() => {
    if (remoteMode) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void ipc
      .onNativeFileDrop((event) => {
        if (attachmentLockedRef.current || event.type === "leave") {
          setDragActive(false);
          return;
        }
        const rect = dropZoneRef.current?.getBoundingClientRect();
        if (!rect) return;
        const inside =
          event.x >= rect.left &&
          event.x <= rect.right &&
          event.y >= rect.top &&
          event.y <= rect.bottom;
        if (!inside) {
          setDragActive(false);
          return;
        }
        if (event.type === "drop") {
          setDragActive(false);
          if (event.paths.length > 0) void addAttachments(event.paths);
          return;
        }
        setDragActive(true);
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {
        setDragActive(false);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addAttachments, remoteMode]);

  const submit = async () => {
    const t = text;
    if (
      (!t.trim() && !hasAttachments) ||
      streaming ||
      finalizing ||
      attachmentBusy ||
      !authenticated ||
      !historyReady
    ) {
      return;
    }
    const submittedSessionId = activeId;
    await send(t);
    // send() owns the acceptance boundary and clears the session draft only after
    // every model/catalog/settings preflight succeeds. Preserve both the editor
    // text and its height when a compatibility repair fails, or when the user has
    // already started typing a follow-up while the command handle was resolving.
    if (!submittedSessionId || submittedSessionId in useStore.getState().drafts) return;
    if (ref.current) {
      ref.current.style.height =
        rowHeightRef.current != null ? rowHeightRef.current + "px" : "auto";
    }
  };

  const attachFromPaths = (paths: string[]) => {
    if (attachmentLocked || remoteMode || paths.length === 0) return;
    void addAttachments(paths);
  };

  const chooseAttachments = async () => {
    if (attachmentLocked || remoteMode) return;
    setPickerError(null);
    try {
      const paths = await ipc.pickAttachmentPaths();
      attachFromPaths(paths);
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : "Could not open the file picker.");
    }
  };

  const onDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (attachmentLocked || remoteMode || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    setDragActive(true);
  };

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (attachmentLocked || remoteMode || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  };

  const onDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (remoteMode) return;
    event.preventDefault();
    setDragActive(false);
    attachFromPaths(attachmentPaths(event.dataTransfer.files));
  };

  const onPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (attachmentLocked || remoteMode || event.clipboardData.files.length === 0) return;
    const paths = attachmentPaths(event.clipboardData.files);
    if (paths.length === 0) return;
    event.preventDefault();
    attachFromPaths(paths);
  };

  return (
    <div className="pc-composer-dock">
      {/* The perimeter is deliberately quiet at rest. Focus, a sendable draft, and a
          running turn each earn a distinct state cue instead of permanent rainbow noise. */}
      <div
        data-busy={streaming ? "true" : undefined}
        data-armed={canSend ? "true" : undefined}
        aria-busy={streaming}
        className="pc-neon-frame w-full max-w-none transition-[opacity,filter] duration-200 motion-reduce:transition-none"
      >
        <div
          ref={dropZoneRef}
          className="pc-composer-surface"
          data-testid="composer-drop-zone"
          data-drag-active={dragActive ? "true" : undefined}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onPasteCapture={onPaste}
        >
          <div className="pc-composer-input-zone">
            <FormattingHelp />
            <ComposerEditor
              key={activeId ?? "no-session"}
              editableRef={ref}
              value={text}
              onChange={setText}
              onSubmit={() => void submit()}
              disabled={!activeId}
              placeholder={placeholder}
              maxHeight={MAX_TEXTAREA_H}
            />
          </div>

          {!remoteMode && (hasAttachments || attachmentError || pickerError || attachmentBusy) && (
            <div className="pc-attachment-tray">
              {hasAttachments && (
                <ul className="pc-attachment-list" aria-label="Attached files">
                  {attachments.map((attachment, index) => (
                    <li className="pc-attachment-chip" key={attachment.path}>
                      {attachment.thumbnailUrl ? (
                        <img
                          className="pc-attachment-chip__preview"
                          src={attachment.thumbnailUrl}
                          alt={
                            "Preview " + (attachmentLabels.get(attachment.path) ?? attachment.name)
                          }
                        />
                      ) : (
                        <span className="pc-attachment-chip__icon" aria-hidden="true">
                          {attachment.kind === "image" ? "▧" : "≡"}
                        </span>
                      )}
                      <span className="pc-attachment-chip__copy">
                        <span
                          className="pc-attachment-chip__name"
                          title={attachmentLabels.get(attachment.path) ?? attachment.name}
                        >
                          {attachmentLabels.get(attachment.path) ?? attachment.name}
                        </span>
                        <span className="pc-attachment-chip__meta">
                          {attachmentTypeLabel(attachment) +
                            " · " +
                            attachmentSizeLabel(attachment.size)}
                        </span>
                      </span>
                      <button
                        ref={(element) => {
                          if (element) attachmentRemoveRefs.current.set(attachment.path, element);
                          else attachmentRemoveRefs.current.delete(attachment.path);
                        }}
                        type="button"
                        className="pc-attachment-chip__remove"
                        aria-label={
                          "Remove " + (attachmentLabels.get(attachment.path) ?? attachment.name)
                        }
                        title={
                          "Remove " +
                          (attachmentLabels.get(attachment.path) ?? attachment.name) +
                          (attachmentLocked ? " — attachments are locked during a turn" : "")
                        }
                        disabled={attachmentLocked}
                        onClick={() => {
                          const remaining = attachments.filter(
                            ({ path }) => path !== attachment.path,
                          );
                          const nextPath = remaining[Math.min(index, remaining.length - 1)]?.path;
                          removeAttachment(attachment.path);
                          queueMicrotask(() => {
                            (nextPath
                              ? attachmentRemoveRefs.current.get(nextPath)
                              : attachButtonRef.current
                            )?.focus();
                          });
                        }}
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {attachmentBusy && !streaming && (
                <span className="pc-attachment-status" role="status">
                  Checking files…
                </span>
              )}
              {(pickerError || attachmentError) && (
                <div className="pc-attachment-error" role="alert">
                  <ul tabIndex={0} aria-label="Attachment validation issues">
                    {(pickerError ?? attachmentError ?? "").split("\n").map((message, index) => (
                      <li key={`${index}:${message}`}>{message}</li>
                    ))}
                  </ul>
                  {pickerError && (
                    <button
                      type="button"
                      aria-label="Retry attachment picker"
                      onClick={() => void chooseAttachments()}
                    >
                      Retry
                    </button>
                  )}
                  {!pickerError && canRetryAttachmentValidation && (
                    <button
                      type="button"
                      aria-label="Retry attachment validation"
                      disabled={attachmentBusy}
                      onClick={() => {
                        const retrySessionId = activeId;
                        void retryAttachmentValidation().finally(() => {
                          const focusWasLost =
                            document.activeElement === document.body ||
                            document.activeElement === null;
                          if (
                            retrySessionId &&
                            useStore.getState().activeId === retrySessionId &&
                            focusWasLost
                          ) {
                            attachButtonRef.current?.focus();
                          }
                        });
                      }}
                    >
                      Retry
                    </button>
                  )}
                  {canRetryAttachmentSend && (
                    <button type="button" aria-label="Retry Send" onClick={() => void submit()}>
                      Retry Send
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="Dismiss attachment error"
                    onClick={() => {
                      setPickerError(null);
                      clearAttachmentError();
                      queueMicrotask(() => attachButtonRef.current?.focus());
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="pc-composer-toolbar">
            <div className="pc-composer-controls" role="group" aria-label="Turn controls">
              {!remoteMode && (
                <button
                  ref={attachButtonRef}
                  type="button"
                  className="pc-attach-button"
                  aria-label="Attach files"
                  title={attachmentLocked ? "Attachments are locked during a turn" : "Attach files"}
                  disabled={attachmentLocked}
                  onClick={() => void chooseAttachments()}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="m20.5 11.5-8.7 8.7a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7L9 17.4a2 2 0 0 1-2.8-2.8l8.5-8.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>Attach</span>
                </button>
              )}
              <PermissionPicker />
              <ModelSetupPicker />
            </div>

            <div className="pc-composer-state">
              <span
                id="pc-composer-status"
                role="status"
                aria-live={activeId && (streaming || finalizing || outcome) ? "off" : "polite"}
                aria-atomic="true"
                className="pc-composer-presence"
              >
                <span className={presence.dot} aria-hidden="true" />
                <span>{presence.text}</span>
              </span>
              {settingsError ? (
                <div className="pc-composer-recovery pc-composer-recovery--error">
                  <span role="alert" title={settingsError}>
                    That setting wasn’t saved
                  </span>
                  <button type="button" onClick={() => setShowSettings(true)}>
                    Review settings
                  </button>
                </div>
              ) : (
                <>
                  {!activeId && (
                    <button
                      type="button"
                      className="pc-composer-recovery-action"
                      onClick={() => void newSession()}
                    >
                      New chat
                    </button>
                  )}
                  {activeId && !authenticated && (
                    <button
                      type="button"
                      className="pc-composer-recovery-action"
                      onClick={() => setShowSettings(true)}
                    >
                      {authAction}
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Send and Stop remain stacked in one predictable slot. While Stop is
                visible, the full writing surface stays available for the next draft. */}
            <div className="pc-composer-action-slot">
              <button
                onClick={() => void submit()}
                disabled={!canSend}
                tabIndex={streaming ? -1 : 0}
                aria-hidden={streaming || undefined}
                className={`pc-send pc-action ${streaming ? "pc-action--hidden" : "pc-action--shown"}${armed ? " pc-armed" : ""}`}
                title={
                  finalizing
                    ? "Finishing the change record before sending"
                    : coldLoadError
                      ? "Retry loading this conversation before sending"
                      : activeId && !historyReady
                        ? "Wait for this conversation to load"
                        : authenticated
                          ? "Send (Enter)"
                          : authHint
                }
                aria-label={
                  finalizing
                    ? "Send unlocks after file changes are checked"
                    : coldLoadError
                      ? "Conversation failed to load"
                      : activeId && !historyReady
                        ? "Conversation is loading"
                        : authenticated
                          ? "Send message"
                          : authHint
                }
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 19V5M5.5 11.5 12 5l6.5 6.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                onClick={() => (activeId ? void stopSession(activeId) : void stop())}
                disabled={!streaming || stopping}
                tabIndex={streaming ? 0 : -1}
                aria-hidden={!streaming || undefined}
                className={`pc-stop pc-action ${streaming ? "pc-action--shown" : "pc-action--hidden"}${stopping ? " pc-stop--stopping" : ""}`}
                title="Stop"
                aria-label={stopping ? "Stopping…" : "Stop generating"}
              >
                <span className="block h-3 w-3 rounded-sm bg-danger" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="pc-composer-meta">
        <span className="pc-composer-shortcuts" aria-hidden="true">
          {activeId ? (
            streaming ? (
              "Keep drafting · send unlocks when this run finishes"
            ) : finalizing ? (
              "Response complete · send unlocks after file check"
            ) : (
              <>
                <kbd>Enter</kbd>
                <span>Send</span>
                <span className="pc-composer-shortcut-separator">·</span>
                <kbd>Shift+Enter</kbd>
                <span>New line</span>
              </>
            )
          ) : (
            "Your drafts are saved per chat"
          )}
        </span>
        <UsageMeter />
      </div>
    </div>
  );
}
const MODE_PRESENTATION: Record<PermissionMode, { label: string; detail: string }> = {
  default: { label: "Ask", detail: "protected actions ask unless explicitly allowed" },
  acceptEdits: {
    label: "Edits allowed",
    detail: "edits skip prompts; protected actions follow saved rules",
  },
  plan: { label: "Plan only", detail: "no files will change" },
  auto: { label: "Auto configurable", detail: "protected actions ask unless explicitly allowed" },
  bypass: { label: "Bypass all", detail: "no permission prompts" },
};

/** Every desktop permission mode in one explicit, provider-native dropdown. */
function PermissionPicker() {
  const mode = useStore((s) => s.settings.permissionMode);
  const updateSettings = useStore((s) => s.updateSettings);
  const remoteMode = useStore((s) => s.remoteMode);
  const anyRunLive = useStore(
    (s) => Object.values(s.runs).some((run) => run.streaming || run.finalizing) || s.streaming,
  );
  if (remoteMode) return null;
  const danger = DANGER_MODES.includes(mode);
  const presentation = MODE_PRESENTATION[mode];
  return (
    <div className="pc-composer-field pc-composer-field--permission">
      <SelectMenu
        label="Permission mode"
        title={`${presentation.label} — ${presentation.detail}`}
        value={mode}
        onChange={(next) => void updateSettings({ permissionMode: next as PermissionMode })}
        disabled={anyRunLive}
        placement="top"
        className="min-w-0"
        buttonClassName={`pc-composer-select-button pc-permission-select${danger ? " pc-permission-select--danger" : ""}`}
        groups={[
          {
            id: "standard-access",
            label: "Standard access",
            options: (["default", "acceptEdits", "plan"] as PermissionMode[]).map((value) => ({
              value,
              label: MODE_PRESENTATION[value].label,
            })),
          },
          {
            id: "elevated-access",
            label: "Elevated access",
            options: (["auto", "bypass"] as PermissionMode[]).map((value) => ({
              value,
              label: MODE_PRESENTATION[value].label,
            })),
          },
        ]}
      />
    </div>
  );
}

type SetupPanel = "main" | "model" | "effort" | "speed";

const SPEED_PRESENTATION: Record<ResponseSpeed, { label: string; detail: string }> = {
  standard: { label: "Standard", detail: "Default speed" },
  fast: { label: "Fast", detail: "1.5x speed, more usage" },
};

/** One compact surface for the active run's model, reasoning, and processing speed. */
function ModelSetupPicker() {
  const model = useActiveModel();
  const setSessionModel = useStore((s) => s.setSessionModel);
  const activeId = useStore((s) => s.activeId);
  const streaming = useStore((s) => s.streaming);
  const remoteMode = useStore((s) => s.remoteMode);
  const openAIModels = useStore((s) => {
    const session = s.activeId
      ? (s.sessions.find((candidate) => candidate.id === s.activeId) ??
        (s.pendingSession?.id === s.activeId ? s.pendingSession : undefined))
      : undefined;
    return modelsForOpenAIProfile(session?.accountProfileId, s.openAIModelCatalogs, s.openAIModels);
  });
  const effort = useStore((s) => s.settings.reasoningEffort);
  const speed = useStore((s) => s.settings.responseSpeed);
  const updateSettings = useStore((s) => s.updateSettings);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<SetupPanel>("main");
  // Portcode now runs every turn through the bundled Codex engine. Keep legacy
  // model labels readable in history, but never offer Claude as a runnable
  // choice in the active composer.
  const groups = providerGroups(openAIModels).filter(
    (provider) => provider.id === "openai" && provider.models.length > 0,
  );
  const current = modelInfo(model, openAIModels);
  const supported = current?.reasoningEfforts ?? [];
  const fastTier = fastServiceTierForModel(current);
  const supportsFast = fastTier !== undefined;
  const effectiveSpeed: ResponseSpeed = supportsFast ? speed : "standard";
  const effectiveEffort = reasoningEffortForModel(model, effort, openAIModels);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setPanel("main");
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (panel !== "main") setPanel("main");
      else {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, panel]);

  useEffect(() => {
    if (streaming) setOpen(false);
  }, [streaming]);

  useEffect(() => {
    if (supportsFast || panel !== "speed") return;
    setPanel("main");
  }, [panel, supportsFast]);

  useEffect(() => {
    if (!current || supportsFast || speed !== "fast") return;
    void updateSettings({ responseSpeed: "standard" });
  }, [current, speed, supportsFast, updateSettings]);

  // The desktop owns session models and provider credentials. Until the remote
  // protocol has an authoritative set-model command, showing a phone-side picker
  // would promise a change that the next desktop session snapshot simply reverts.
  if (remoteMode) return null;

  const commitModel = (next: string) => {
    void setSessionModel(next);
    setPanel("main");
  };
  const commitEffort = (next: string) => {
    void updateSettings({ reasoningEffort: next });
    setPanel("main");
  };
  const commitSpeed = (next: ResponseSpeed) => {
    if (next === "fast" && !supportsFast) return;
    void updateSettings({ responseSpeed: next });
    setPanel("main");
  };
  const compactModelLabel = (current?.label ?? model)
    .replace(/^GPT[-\s]*/i, "")
    .replace(/^Claude\s+/i, "");
  const setupControlLabel = supportsFast ? "Model, effort, and speed" : "Model and effort";

  return (
    <div ref={rootRef} className="pc-run-setup">
      <button
        ref={triggerRef}
        type="button"
        className="pc-run-setup__trigger"
        aria-label={setupControlLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={streaming || !activeId}
        title={`Configure ${setupControlLabel.toLowerCase()}`}
        onClick={() => {
          setPanel("main");
          setOpen((currentOpen) => !currentOpen);
        }}
      >
        <span className="pc-run-setup__model">{compactModelLabel}</span>
        {supported.length > 0 && (
          <span className="pc-run-setup__effort">{reasoningEffortLabel(effectiveEffort)}</span>
        )}
        {effectiveSpeed === "fast" && (
          <svg className="pc-run-setup__bolt" viewBox="0 0 12 14" aria-hidden="true">
            <path d="M7.3.8 1.7 8h3.5l-.6 5.2L10.3 6H6.8z" fill="currentColor" />
          </svg>
        )}
        <svg
          className={`pc-run-setup__chevron${open ? " pc-run-setup__chevron--open" : ""}`}
          viewBox="0 0 12 12"
          aria-hidden="true"
        >
          <path d="m2.25 4.25 3.75 3.5 3.75-3.5" fill="none" stroke="currentColor" />
        </svg>
      </button>

      {open && (
        <>
          <div className="pc-run-setup__popover" role="dialog" aria-label="Run setup">
            <div className="pc-run-setup__rows">
              <SetupRow
                label="Model"
                value={compactModelLabel}
                onClick={() => setPanel(panel === "model" ? "main" : "model")}
              />
              {supported.length > 0 && (
                <SetupRow
                  label="Effort"
                  value={reasoningEffortLabel(effectiveEffort)}
                  onClick={() => setPanel(panel === "effort" ? "main" : "effort")}
                />
              )}
              {supportsFast && (
                <SetupRow
                  label="Speed"
                  value={SPEED_PRESENTATION[effectiveSpeed].label}
                  onClick={() => setPanel(panel === "speed" ? "main" : "speed")}
                  accent={effectiveSpeed === "fast"}
                />
              )}
            </div>
          </div>

          {panel !== "main" && (panel !== "speed" || supportsFast) && (
            <div className={`pc-run-setup__sidecar pc-run-setup__sidecar--${panel}`}>
              <div className="pc-run-setup__sidecar-label">
                {panel === "model" ? "Model" : panel === "effort" ? "Effort" : "Speed"}
              </div>
              {panel === "model" && (
                <div role="listbox" aria-label="Model" className="pc-run-setup__options">
                  {groups.map((provider) => (
                    <div key={provider.id} role="group" aria-label={provider.label}>
                      <div className="pc-run-setup__group-label">{provider.label}</div>
                      {provider.models.map((candidate) => (
                        <SetupOption
                          key={candidate.id}
                          label={candidate.label}
                          selected={candidate.id === model}
                          onClick={() => commitModel(candidate.id)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {panel === "effort" && (
                <div role="listbox" aria-label="Reasoning level" className="pc-run-setup__options">
                  {supported.map((level) => (
                    <SetupOption
                      key={level}
                      label={reasoningEffortLabel(level)}
                      selected={level === effectiveEffort}
                      onClick={() => commitEffort(level)}
                    />
                  ))}
                </div>
              )}
              {panel === "speed" && supportsFast && (
                <div role="listbox" aria-label="Response speed" className="pc-run-setup__options">
                  {(Object.keys(SPEED_PRESENTATION) as ResponseSpeed[]).map((value) => (
                    <SetupOption
                      key={value}
                      label={SPEED_PRESENTATION[value].label}
                      detail={
                        value === "fast"
                          ? fastTier?.description || SPEED_PRESENTATION.fast.detail
                          : SPEED_PRESENTATION.standard.detail
                      }
                      selected={value === effectiveSpeed}
                      icon={value === "fast" ? "bolt" : undefined}
                      onClick={() => commitSpeed(value)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SetupRow({
  label,
  value,
  onClick,
  accent = false,
}: {
  label: string;
  value: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      className="pc-run-setup__row"
      aria-label={`${label}: ${value}`}
      onClick={onClick}
    >
      <span>{label}</span>
      <span className={accent ? "pc-run-setup__row-value--accent" : undefined}>{value}</span>
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="m4.25 2.25 3.5 3.75-3.5 3.75" fill="none" stroke="currentColor" />
      </svg>
    </button>
  );
}

function SetupOption({
  label,
  detail,
  selected,
  onClick,
  icon,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onClick: () => void;
  icon?: "bolt";
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`pc-run-setup__option${selected ? " pc-run-setup__option--selected" : ""}`}
      onClick={onClick}
    >
      <span className="pc-run-setup__option-copy">
        <span>
          {icon === "bolt" && (
            <svg className="pc-run-setup__option-bolt" viewBox="0 0 12 14" aria-hidden="true">
              <path d="M7.3.8 1.7 8h3.5l-.6 5.2L10.3 6H6.8z" fill="currentColor" />
            </svg>
          )}
          {label}
        </span>
        {detail && <span>{detail}</span>}
      </span>
      <span className="pc-run-setup__check" aria-hidden="true">
        {selected && (
          <svg viewBox="0 0 12 12">
            <path d="m2 6.2 2.5 2.4L10 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        )}
      </span>
    </button>
  );
}

function FormattingHelp() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="pc-format-help">
      <button
        type="button"
        className="pc-format-help__trigger"
        aria-label="Formatting help"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Formatting help"
        onClick={() => setOpen((current) => !current)}
      >
        ?
      </button>
      {open && (
        <div className="pc-format-help__popover" role="dialog" aria-label="Message formatting">
          <div className="pc-format-help__heading">
            <span>Message formatting</span>
            <span>Use these shortcuts to structure your draft.</span>
          </div>
          <div className="pc-format-help__grid">
            <code>- item</code>
            <span>Bulleted list</span>
            <code>1. item</code>
            <span>Numbered list</span>
            <code>- [ ] task</code>
            <span>To-do</span>
            <kbd>Tab</kbd>
            <span>Nest list item</span>
            <kbd>Shift+Tab</kbd>
            <span>Outdent list item</span>
            <code>**bold**</code>
            <span>Bold</span>
            <code>`code`</code>
            <span>Inline code</span>
            <code>&gt; note</code>
            <span>Quote</span>
          </div>
          <div className="pc-format-help__tip">
            In a list, <kbd>Enter</kbd> or <kbd>Shift+Enter</kbd> adds the next item. On an empty
            nested item it outdents; on an empty top-level item it exits. Outside lists,
            <kbd>Enter</kbd> sends.
          </div>
        </div>
      )}
    </div>
  );
}

function UsageMeter() {
  const model = useActiveModel();
  const openAIModels = useStore((s) => {
    const session = s.activeId
      ? (s.sessions.find((candidate) => candidate.id === s.activeId) ??
        (s.pendingSession?.id === s.activeId ? s.pendingSession : undefined))
      : undefined;
    return modelsForOpenAIProfile(session?.accountProfileId, s.openAIModelCatalogs, s.openAIModels);
  });
  const usage = useStore((s) => (s.activeId ? s.usage[s.activeId] : undefined));
  const total = usage ? usage.input + usage.output : 0;
  const label = modelInfo(model, openAIModels)?.label ?? model;
  if (total === 0) return null;
  const costLabel = "Codex plan or API billing";
  return (
    <span
      role="group"
      className="pc-composer-usage"
      aria-label={`Session usage: ${total.toLocaleString()} tokens, ${usage!.input.toLocaleString()} input and ${usage!.output.toLocaleString()} output; ${costLabel}; ${label}`}
    >
      <span
        aria-hidden="true"
        title={`${usage!.input.toLocaleString()} in · ${usage!.output.toLocaleString()} out`}
      >
        <span className="pc-composer-usage__label">Session</span>
        <span className="pc-composer-usage__tokens">{fmtTokens(total)} tokens</span>
        <span>·</span>
        <span>{costLabel}</span>
      </span>
    </span>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
