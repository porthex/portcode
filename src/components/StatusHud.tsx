import { useMemo } from "react";

import { useStore } from "../store/store";
import { DANGER_MODES, estimateCost, MODELS, type Message } from "../types";

/** "claude-opus-4-8" -> "OPUS 4.8" */
function modelLabel(id: string): string {
  const m = MODELS.find((x) => x.id === id);
  return (m?.label ?? id).replace(/^Claude\s+/, "").toUpperCase();
}

/** Last path segment of a workspace dir, or "local". */
function workspaceLabel(ws: string | null | undefined): string {
  if (!ws) return "local";
  const parts = ws.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "local";
}

/** Number of distinct tool invocations across the active session's messages. */
function countToolUses(messages: Message[] | undefined): number {
  if (!messages) return 0;
  let n = 0;
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind === "tool_use") n += 1;
    }
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
 * tracks the live `streaming` flag.
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
  const usage = useStore((s) => (s.activeId ? s.usage[s.activeId] : undefined));
  const usageMap = useStore((s) => s.usage);
  const messages = useStore((s) => (s.activeId ? s.messages[s.activeId] : undefined));
  const remoteMode = useStore((s) => s.remoteMode);
  const agents = useStore((s) => (s.activeId ? s.agents[s.activeId] : undefined));
  const runningAgents = agents ? agents.filter((a) => a.status === "running").length : 0;
  const bgTasks = useStore((s) => (s.activeId ? s.backgroundTasks[s.activeId] : undefined));
  const runningBg = bgTasks ? bgTasks.filter((t) => t.status === "running").length : 0;
  const tokens = usage ? usage.input + usage.output : 0;

  const workspaceConnected = Boolean(session?.workspace);
  // Memoized so a token/usage-only re-render (messages array reference stable)
  // doesn't re-scan the transcript. A real message change — including each
  // streaming text delta, since patchLast rebuilds the array — still recomputes.
  const toolUses = useMemo(() => countToolUses(messages), [messages]);

  // Cumulative spend across every session, persisted in SQLite and rehydrated on
  // startup (B2) so the running total survives a restart — a transparency/trust cue
  // (Fogg credibility). An estimate: it prices the summed tokens at the CURRENT
  // model (per-model splits aren't stored), matching the per-session UsageMeter.
  const totalCost = useMemo(() => {
    let input = 0;
    let output = 0;
    for (const u of Object.values(usageMap)) {
      input += u.input;
      output += u.output;
    }
    return estimateCost(model, { input, output });
  }, [usageMap, model]);

  return (
    <footer className="pc-hud">
      <div className="pc-hud-seg pc-hud-seg--left text-accent">
        <span className="pc-dot pc-dot--success" aria-hidden="true" />
        <span aria-hidden="true">{"⎇"}</span>{" "}
        <span className="pc-hud-trunc">{workspaceLabel(session?.workspace)}</span>
      </div>
      <div className="pc-hud-seg pc-hud-seg--left text-accent-2">
        <span className="pc-hud-trunc">{modelLabel(model)}</span>
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
          <span aria-hidden="true">{"◆"}</span> WORKSPACE {workspaceConnected ? "LINKED" : "LOCAL"}
        </div>
      )}

      <div className="pc-hud-spacer" />

      {!remoteMode && (
        <div className="pc-hud-seg pc-hud-seg--right text-faint">
          {toolUses === 1 ? "1 TOOL CALL" : `${toolUses} TOOL CALLS`}
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
      <div className="pc-hud-seg pc-hud-seg--right text-faint">{tokens.toLocaleString()} tok</div>
      {/* Cumulative spend (all sessions), survives restarts. Phone trims the HUD to
          essentials, so this desktop-only segment doesn't crowd a narrow screen. */}
      {!remoteMode && totalCost > 0 && (
        <div
          className="pc-hud-seg pc-hud-seg--right tabular-nums text-success"
          title="Total estimated spend across all sessions (priced at the current model)"
        >
          Σ ${totalCost.toFixed(totalCost < 0.01 ? 4 : 2)}
        </div>
      )}
      <div className="pc-hud-seg pc-hud-seg--right text-success">
        <span
          className={`pc-dot ${streaming ? "pc-dot--ring" : "pc-dot--success"}`}
          aria-hidden="true"
        />
        NEURAL LINK · {streaming ? "LIVE" : "IDLE"}
      </div>
    </footer>
  );
}
