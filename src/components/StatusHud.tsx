import { useStore } from "../store/store";
import { MODELS, type Message } from "../types";

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
  const streaming = useStore((s) => s.streaming);
  const usage = useStore((s) => (s.activeId ? s.usage[s.activeId] : undefined));
  const messages = useStore((s) => (s.activeId ? s.messages[s.activeId] : undefined));
  const remoteMode = useStore((s) => s.remoteMode);
  const tokens = usage ? usage.input + usage.output : 0;

  const workspaceConnected = Boolean(session?.workspace);
  const toolUses = countToolUses(messages);

  return (
    <footer className="pc-hud">
      <div className="pc-hud-seg text-accent">
        <span className="pc-dot pc-dot--success" />
        {"⎇"} {workspaceLabel(session?.workspace)}
      </div>
      <div className="pc-hud-seg text-accent-2">{modelLabel(model)}</div>
      {/* The phone trims the HUD to essentials so the 7 desktop segments don't
          overflow a narrow screen — policy and the redundant workspace segment
          (the ⎇ branch above already names the workspace) are desktop-only. */}
      {!remoteMode && <div className="pc-hud-seg text-warn">POLICY: {policy.toUpperCase()}</div>}
      {!remoteMode && (
        <div className="pc-hud-seg text-violet">
          {"◆"} WORKSPACE {workspaceConnected ? "LINKED" : "LOCAL"}
        </div>
      )}

      <div className="pc-hud-spacer" />

      {!remoteMode && (
        <div className="pc-hud-seg pc-hud-seg--right text-faint">
          {toolUses === 1 ? "1 TOOL CALL" : `${toolUses} TOOL CALLS`}
        </div>
      )}
      <div className="pc-hud-seg pc-hud-seg--right text-faint">{tokens.toLocaleString()} tok</div>
      <div className="pc-hud-seg pc-hud-seg--right text-success">
        <span className="pc-dot pc-dot--success" />
        NEURAL LINK · {streaming ? "LIVE" : "IDLE"}
      </div>
    </footer>
  );
}
