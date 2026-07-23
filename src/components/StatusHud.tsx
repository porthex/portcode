import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as ipc from "../lib/ipc";
import { modelsForOpenAIProfile, useStore } from "../store/store";
import {
  DANGER_MODES,
  modelInfo,
  openAIAccountLabel,
  type Message,
  type ModelInfo,
} from "../types";
import { PlanUsagePopover } from "./PlanUsagePopover";
import { lowestPlanRemaining } from "./PlanUsagePanel";

/** "gpt-5.6-sol" -> the concise live catalogue label shown in the HUD. */
function modelLabel(id: string, openAIModels: ModelInfo[]): string {
  const m = modelInfo(id, openAIModels);
  return (m?.label ?? id).toUpperCase();
}

/** Last path segment of a workspace dir, or "local". */
function workspaceLabel(ws: string | null | undefined): string {
  if (!ws) return "local";
  const parts = ws.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "local";
}

/** Number of distinct tool invocations across the active session's messages. */
const toolUsesByMessage = new WeakMap<Message, number>();

function countToolUses(messages: Message[] | undefined): number {
  if (!messages) return 0;
  let n = 0;
  for (const m of messages) {
    let messageCount = toolUsesByMessage.get(m);
    if (messageCount === undefined) {
      messageCount = 0;
      for (const block of m.blocks) {
        if (block.kind === "tool_use") messageCount += 1;
      }
      toolUsesByMessage.set(m, messageCount);
    }
    n += messageCount;
  }
  return n;
}

/**
 * Status HUD — the 27px monospace footer bar.
 * Left group: branch · model · policy · workspace. Right group: tools · tokens · live.
 *
 * Every segment reflects real store state — no hardcoded counts or unverifiable
 * claims. The tools segment counts tool calls actually made this session; the
 * workspace segment reflects whether a folder is connected; the link segment
 * counts every live run, including runs in background sessions.
 */
export function StatusHud() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const model = useStore((s) => {
    const sess = s.sessions.find((x) => x.id === s.activeId);
    return sess?.model ?? s.settings.model;
  });
  const policy = useStore((s) => s.settings.defaultPolicy);
  const mode = useStore((s) => s.settings.permissionMode);
  const streaming = useStore((s) => s.streaming);
  const runs = useStore((s) => s.runs);
  const usage = useStore((s) => (s.activeId ? s.usage[s.activeId] : undefined));
  const messages = useStore((s) => (s.activeId ? s.messages[s.activeId] : undefined));
  const remoteMode = useStore((s) => s.remoteMode);
  const openAIModels = useStore((s) => s.openAIModels);
  const openAIAccounts = useStore((s) => s.openAIAccounts);
  const openAIAccountsError = useStore((s) => s.openAIAccountsError);
  const openAIModelCatalogs = useStore((s) => s.openAIModelCatalogs);
  const openAIAuth = useStore((s) => s.openAIAuthStatus);
  const showSettings = useStore((s) => s.showSettings);
  const showPalette = useStore((s) => s.showPalette);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const agents = useStore((s) => (s.activeId ? s.agents[s.activeId] : undefined));
  const runningAgents = agents ? agents.filter((a) => a.status === "running").length : 0;
  const bgTasks = useStore((s) => (s.activeId ? s.backgroundTasks[s.activeId] : undefined));
  const runningBg = bgTasks ? bgTasks.filter((t) => t.status === "running").length : 0;
  const tokens = usage ? usage.input + usage.output : 0;
  const liveRunCount = Math.max(
    Object.values(runs).filter((run) => run.streaming || run.finalizing).length,
    streaming ? 1 : 0,
  );
  const [showPlanUsage, setShowPlanUsage] = useState(false);
  const [planRemaining, setPlanRemaining] = useState<number | null>(null);
  const planTriggerRef = useRef<HTMLButtonElement>(null);
  const activeOpenAIModels = modelsForOpenAIProfile(
    session?.accountProfileId,
    openAIModelCatalogs,
    openAIModels,
  );
  const activeOpenAIAccount = session?.accountProfileId
    ? openAIAccounts.find((account) => account.id === session.accountProfileId)
    : undefined;
  const providerConnected =
    openAIAuth?.available !== false && activeOpenAIAccount?.state === "connected";

  const closePlanUsage = useCallback(() => setShowPlanUsage(false), []);
  const openPlanSettings = useCallback(
    (section?: "account") => {
      setShowPlanUsage(false);
      setShowSettings(true);
      const target = section === "account" ? "pc-setting-openai" : "pc-setting-usage";
      window.setTimeout(() => {
        document.getElementById(target)?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      }, 0);
    },
    [setShowSettings],
  );

  useEffect(() => {
    if (showSettings || showPalette || remoteMode) setShowPlanUsage(false);
  }, [remoteMode, showPalette, showSettings]);

  useEffect(() => {
    setPlanRemaining(null);
    if (remoteMode || !providerConnected) return;

    let cancelled = false;
    void ipc
      .getPlanUsage("openai", session?.accountProfileId ?? null)
      .then((snapshot) => {
        if (!cancelled) setPlanRemaining(lowestPlanRemaining([snapshot]));
      })
      .catch(() => {
        if (!cancelled) setPlanRemaining(null);
      });
    return () => {
      cancelled = true;
    };
  }, [providerConnected, remoteMode, session?.accountProfileId]);

  const workspaceConnected = Boolean(session?.workspace);
  // Memoized so a token/usage-only re-render (messages array reference stable)
  // doesn't re-scan the transcript. A real message change — including each
  // streaming text delta, since patchLast rebuilds the array — still recomputes.
  const toolUses = useMemo(() => countToolUses(messages), [messages]);

  return (
    <>
      <footer className="pc-hud">
        <div className="pc-hud-seg pc-hud-seg--left text-accent">
          <span className="pc-dot pc-dot--success" aria-hidden="true" />
          <span aria-hidden="true">{"⎇"}</span>{" "}
          <span className="pc-hud-trunc">{workspaceLabel(session?.workspace)}</span>
        </div>
        <div className="pc-hud-seg pc-hud-seg--left text-accent-2">
          <span className="pc-hud-trunc">{modelLabel(model, activeOpenAIModels)}</span>
        </div>
        <div
          className={`pc-hud-seg pc-hud-seg--left ${activeOpenAIAccount?.state === "connected" ? "text-success" : "text-warn"}`}
          title={
            activeOpenAIAccount
              ? `Codex authentication: ${openAIAccountLabel(activeOpenAIAccount, openAIAccounts)}`
              : session?.accountProfileId
                ? openAIAccountsError
                  ? "Codex authentication registry is unavailable"
                  : "This session's Codex authentication was removed"
                : "This session needs Codex authentication"
          }
        >
          <span className="pc-hud-trunc">
            {activeOpenAIAccount
              ? openAIAccountLabel(activeOpenAIAccount, openAIAccounts)
              : session?.accountProfileId
                ? openAIAccountsError
                  ? "ACCOUNT UNAVAILABLE"
                  : "ACCOUNT REMOVED"
                : "ACCOUNT NEEDED"}
          </span>
        </div>
        {/* The phone trims the HUD to essentials so the 7 desktop segments don't
          overflow a narrow screen — policy and the redundant workspace segment
          (the ⎇ branch above already names the workspace) are desktop-only. */}
        {/* In `default` mode the gate behaviour IS the legacy policy, so show that;
          otherwise show the active MODE, and flag the loosened auto/bypass modes
          in a danger colour with a warning glyph so a relaxed gate is never hidden. */}
        {!remoteMode &&
          (mode === "default" ? (
            <div className="pc-hud-seg text-warn">POLICY: {policy.toUpperCase()}</div>
          ) : (
            <div
              className={`pc-hud-seg ${DANGER_MODES.includes(mode) ? "text-danger" : "text-warn"}`}
            >
              {DANGER_MODES.includes(mode) ? "⚠ " : ""}MODE: {mode.toUpperCase()}
            </div>
          ))}
        {!remoteMode && (
          <div className="pc-hud-seg text-violet">
            <span aria-hidden="true">{"◆"}</span> WORKSPACE{" "}
            {workspaceConnected ? "LINKED" : "LOCAL"}
          </div>
        )}

        <div className="pc-hud-spacer" />

        {!remoteMode && (
          <div
            className="pc-hud-seg pc-hud-seg--right text-faint"
            title={`${toolUses} agent tool ${toolUses === 1 ? "call" : "calls"}`}
          >
            {toolUses === 1 ? "1 ACTION" : `${toolUses} ACTIONS`}
          </div>
        )}
        {runningAgents > 0 && (
          <div className="pc-hud-seg pc-hud-seg--right text-accent-2">
            <span className="pc-dot pc-dot--ring" aria-hidden="true" />
            {runningAgents === 1 ? "1 AGENT" : `${runningAgents} AGENTS`}
          </div>
        )}
        {runningBg > 0 && (
          <div className="pc-hud-seg pc-hud-seg--right text-accent-2">
            <span className="pc-dot pc-dot--ring" aria-hidden="true" />
            {runningBg === 1 ? "1 BG TASK" : `${runningBg} BG TASKS`}
          </div>
        )}
        {!remoteMode && (
          <button
            ref={planTriggerRef}
            type="button"
            className={`pc-hud-seg pc-hud-seg--right pc-hud-plan-trigger${showPlanUsage ? " pc-hud-plan-trigger--active" : ""}`}
            aria-label={`Plan usage, ${planRemaining === null ? "percentage unavailable" : `${planRemaining}% remaining`}, ${providerConnected ? "connected" : "not connected"} for this GPT chat`}
            aria-haspopup="dialog"
            aria-expanded={showPlanUsage}
            aria-controls="pc-plan-usage-popover"
            title="Lowest remaining percentage for this GPT chat"
            onClick={() => setShowPlanUsage((open) => !open)}
          >
            <span
              className={`pc-dot ${providerConnected ? "pc-dot--success" : ""}`}
              aria-hidden="true"
            />
            USAGE
            <span
              className={`pc-hud-plan-value${
                planRemaining !== null && planRemaining <= 10
                  ? " pc-hud-plan-value--danger"
                  : planRemaining !== null && planRemaining <= 25
                    ? " pc-hud-plan-value--warn"
                    : ""
              }`}
            >
              {planRemaining === null ? "--" : planRemaining}%
            </span>
          </button>
        )}
        <div className="pc-hud-seg pc-hud-seg--right text-faint">{tokens.toLocaleString()} tok</div>
        <div className="pc-hud-seg pc-hud-seg--right text-success">
          <span
            className={`pc-dot ${liveRunCount > 0 ? "pc-dot--ring" : "pc-dot--success"}`}
            aria-hidden="true"
          />
          NEURAL LINK · {liveRunCount > 0 ? `${liveRunCount} LIVE` : "IDLE"}
        </div>
      </footer>
      {!remoteMode && (
        <PlanUsagePopover
          open={showPlanUsage}
          openAIAccountProfileId={session?.accountProfileId ?? null}
          triggerRef={planTriggerRef}
          onClose={closePlanUsage}
          onOpenSettings={openPlanSettings}
          onRemainingChange={setPlanRemaining}
        />
      )}
    </>
  );
}
