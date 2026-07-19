import { useEffect, useRef, useState } from "react";
import { toolPresence } from "../lib/toolNames";
import { useStore } from "../store/store";
import {
  DANGER_MODES,
  MODEL_PRICING,
  estimateCost,
  modelInfo,
  providerForModel,
  providerGroups,
  reasoningEffortLabel,
  type PermissionMode,
  type ResponseSpeed,
} from "../types";
import { SelectMenu } from "./SelectMenu";
import { ComposerEditor } from "./ComposerEditor";

/** Read the active session's model, falling back to the global default. */
function useActiveModel(): string {
  return useStore((s) => {
    const sess = s.activeId ? s.sessions.find((x) => x.id === s.activeId) : undefined;
    return sess?.model ?? s.settings.model;
  });
}

// Auto-grow cap; kept in sync with the editor's inline maxHeight so the JS
// target and the CSS clip agree (otherwise growth stops short at the smaller).
const MAX_TEXTAREA_H = 220;

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
  // Per-session draft: read the ACTIVE session's draft so a half-written message
  // can't bleed across sessions (the old single global `draft` did exactly that).
  const activeId = useStore((s) => s.activeId);
  const text = useStore((s) => (s.activeId ? (s.drafts[s.activeId] ?? "") : ""));
  const hasCachedMessages = useStore((s) => Boolean(s.activeId && s.activeId in s.messages));
  const messageLoad = useStore((s) => (s.activeId ? s.messageLoads[s.activeId] : undefined));
  const setText = useStore((s) => s.setDraft);
  const streaming = useStore((s) => s.streaming);
  const composerPhase = useStore((s) => s.composerPhase);
  const activeTool = useStore((s) => s.activeTool);
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const stopSession = useStore((s) => s.stopSession);
  const newSession = useStore((s) => s.newSession);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const remoteMode = useStore((s) => s.remoteMode);
  const remoteConnected = useStore((s) => s.remoteConnected);
  const activeModel = useActiveModel();
  const openAIModels = useStore((s) => s.openAIModels);
  const settings = useStore((s) => s.settings);
  const oauthStatus = useStore((s) => s.oauthStatus);
  const openAIAuthStatus = useStore((s) => s.openAIAuthStatus);
  const settingsError = useStore((s) => s.settingsError);
  const ref = useRef<HTMLDivElement>(null);
  // The pixel height of a single, empty row. Captured lazily from a collapsed
  // editor so the post-submit collapse has a concrete target to ease toward —
  // CSS height transitions can't interpolate to/from "auto" (the browser
  // resolves it instantly), which otherwise kills the collapse animation.
  const rowHeightRef = useRef<number | null>(null);

  // Send is fireable only with non-whitespace content and no turn in flight.
  const activeProvider = providerForModel(activeModel, openAIModels);
  const openAIUnavailable = activeProvider === "openai" && openAIAuthStatus?.available === false;
  const authenticated =
    (remoteMode && remoteConnected) ||
    (activeProvider === "openai"
      ? !openAIUnavailable && !!openAIAuthStatus?.signedIn
      : !!oauthStatus?.signedIn || settings.apiKeySet);
  const authHint =
    activeProvider === "openai"
      ? openAIUnavailable
        ? (openAIAuthStatus?.unavailableReason ??
          "ChatGPT subscription access is unavailable in this build")
        : "Sign in with ChatGPT in Settings to send"
      : "Sign in with Claude or add an API key in Settings to send";
  const authAction = openAIUnavailable
    ? "Open settings"
    : activeProvider === "openai"
      ? "Connect ChatGPT"
      : "Connect Claude";
  const historyReady = Boolean(
    activeId &&
    (messageLoad === undefined ||
      messageLoad.phase === "ready" ||
      messageLoad.phase === "refreshing" ||
      (messageLoad.phase === "error" && hasCachedMessages)),
  );
  const coldLoadError = Boolean(activeId && messageLoad?.phase === "error" && !hasCachedMessages);
  const canSend = text.trim().length > 0 && !streaming && authenticated && historyReady;
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
          : presenceFor(streaming, composerPhase, activeTool);
  const placeholder = !activeId
    ? "Create or select a chat to begin…"
    : streaming
      ? "Draft your next message while Portcode works…"
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
    // so submit() can animate down to a px value instead of snapping via "auto".
    if (rowHeightRef.current == null && !text) rowHeightRef.current = el.scrollHeight;
    el.style.height = next + "px";
  }, [text]);

  // Return focus to the composer when a turn finishes if focus was otherwise lost.
  // Never steal it from a permission button, picker, or another input, and never pop
  // the software keyboard on the phone. Drafting remains available during the run.
  useEffect(() => {
    if (streaming || remoteMode) return;
    const el = ref.current;
    if (el?.isContentEditable && document.activeElement === document.body) el.focus();
  }, [streaming, remoteMode]);

  const submit = async () => {
    const t = text;
    if (!t.trim() || streaming || !authenticated || !historyReady) return;
    setText("");
    // Collapse to the measured single-row height (a px target) so the declared
    // transition-[height] can ease the shrink; fall back to "auto" only if we
    // never captured a row height (e.g. submit before the first layout pass).
    if (ref.current)
      ref.current.style.height =
        rowHeightRef.current != null ? rowHeightRef.current + "px" : "auto";
    await send(t);
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
        <div className="pc-composer-surface">
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

          <div className="pc-composer-toolbar">
            <div className="pc-composer-controls" aria-label="Turn controls">
              <PermissionPicker />
              <ModelSetupPicker />
            </div>

            <div className="pc-composer-state">
              <span
                id="pc-composer-status"
                role="status"
                aria-live="polite"
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
                  coldLoadError
                    ? "Retry loading this conversation before sending"
                    : activeId && !historyReady
                      ? "Wait for this conversation to load"
                      : authenticated
                        ? "Send (Enter)"
                        : authHint
                }
                aria-label={
                  coldLoadError
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
  default: { label: "Ask", detail: "confirms sensitive actions" },
  acceptEdits: { label: "Edits allowed", detail: "workspace edits don’t ask" },
  plan: { label: "Plan only", detail: "no files will change" },
  auto: { label: "Auto approve", detail: "broad access" },
  bypass: { label: "Bypass confirmations", detail: "no confirmations" },
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
  const openAIModels = useStore((s) => s.openAIModels);
  const effort = useStore((s) => s.settings.reasoningEffort);
  const speed = useStore((s) => s.settings.responseSpeed);
  const updateSettings = useStore((s) => s.updateSettings);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<SetupPanel>("main");
  const groups = providerGroups(openAIModels).filter((provider) => provider.models.length > 0);
  const current = modelInfo(model, openAIModels);
  const openAI = providerForModel(model, openAIModels) === "openai";
  const supported = current?.reasoningEfforts ?? [];

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
    void updateSettings({ responseSpeed: next });
    setPanel("main");
  };
  const compactModelLabel = (current?.label ?? model)
    .replace(/^GPT[-\s]*/i, "")
    .replace(/^Claude\s+/i, "");

  return (
    <div ref={rootRef} className="pc-run-setup">
      <button
        ref={triggerRef}
        type="button"
        className="pc-run-setup__trigger"
        aria-label="Model, effort, and speed"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={streaming || !activeId}
        title="Configure model, effort, and speed"
        onClick={() => {
          setPanel("main");
          setOpen((currentOpen) => !currentOpen);
        }}
      >
        <span className="pc-run-setup__model">{compactModelLabel}</span>
        {openAI && supported.length > 0 && (
          <span className="pc-run-setup__effort">{reasoningEffortLabel(effort)}</span>
        )}
        {openAI && speed === "fast" && (
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
              {openAI && supported.length > 0 && (
                <SetupRow
                  label="Effort"
                  value={reasoningEffortLabel(effort)}
                  onClick={() => setPanel(panel === "effort" ? "main" : "effort")}
                />
              )}
              {openAI && (
                <SetupRow
                  label="Speed"
                  value={SPEED_PRESENTATION[speed].label}
                  onClick={() => setPanel(panel === "speed" ? "main" : "speed")}
                  accent={speed === "fast"}
                />
              )}
            </div>
          </div>

          {panel !== "main" && (
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
                      selected={level === effort}
                      onClick={() => commitEffort(level)}
                    />
                  ))}
                </div>
              )}
              {panel === "speed" && (
                <div role="listbox" aria-label="Response speed" className="pc-run-setup__options">
                  {(Object.keys(SPEED_PRESENTATION) as ResponseSpeed[]).map((value) => (
                    <SetupOption
                      key={value}
                      label={SPEED_PRESENTATION[value].label}
                      detail={SPEED_PRESENTATION[value].detail}
                      selected={value === speed}
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
  const openAIModels = useStore((s) => s.openAIModels);
  const usage = useStore((s) => (s.activeId ? s.usage[s.activeId] : undefined));
  const total = usage ? usage.input + usage.output : 0;
  const cost = usage ? estimateCost(model, usage) : 0;
  const openAI = providerForModel(model, openAIModels) === "openai";
  const label = modelInfo(model, openAIModels)?.label ?? model;
  if (total === 0) return null;
  const costKnown = openAI || Object.prototype.hasOwnProperty.call(MODEL_PRICING, model);
  const costLabel = openAI
    ? "ChatGPT plan"
    : costKnown
      ? `$${cost.toFixed(cost < 0.01 ? 4 : 2)} estimated`
      : "Cost unavailable";
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
