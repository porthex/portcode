import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store/store";
import { installQaControls } from "./install";
import type { Attachment } from "../types";

beforeEach(() => {
  delete window.__PORTCODE_QA__;
});

describe("QA control installer", () => {
  it("seeds only display-safe local fixtures and isolates remote/reset state", () => {
    const controls = installQaControls();
    controls.seedLocalComposer({
      sessions: [
        { id: "qa-a", title: "Alpha" },
        { id: "qa-b", title: "Beta" },
      ],
      activeId: "qa-a",
      draft: "keep me",
    });

    let state = useStore.getState();
    expect(state.activeId).toBe("qa-a");
    expect(state.drafts).toEqual({ "qa-a": "keep me" });
    expect(state.openAIAccounts).toEqual([
      expect.objectContaining({ id: "qa-codex", accountLabel: "QA Codex", state: "connected" }),
    ]);
    expect(JSON.stringify(state.openAIAccounts)).not.toMatch(/token|secret|oauth|api.?key/i);

    controls.session.disappear("qa-a");
    state = useStore.getState();
    expect(state.sessions.map((session) => session.id)).toEqual(["qa-b"]);
    expect(state.activeId).toBe("qa-b");
    expect(state.drafts).not.toHaveProperty("qa-a");

    const pending: Attachment = {
      path: "C:/qa/pending.txt",
      name: "pending.txt",
      kind: "text",
      mediaType: "text/plain",
      size: 12,
      thumbnailUrl: null,
    };
    useStore.setState({ attachments: { "qa-b": [pending] } });

    controls.remote.enter({
      sessions: [
        {
          id: "qa-b",
          title: "Remote",
          workspace: null,
          model: "gpt-5.2-codex",
          accountProfileId: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    state = useStore.getState();
    expect(state.remoteMode).toBe(true);
    expect(state.remoteConnected).toBe(true);
    expect(state.activeId).toBe("qa-b");
    expect(state.attachments).toEqual({ "qa-b": [pending] });

    controls.resetScenario();
    state = useStore.getState();
    expect(state.remoteMode).toBe(false);
    expect(state.remoteConnected).toBe(false);
    expect(state.sessions).toEqual([]);
    expect(state.runs).toEqual({});
  });

  it("purges synthetic Codex activity and agent state before reused session IDs are reseeded", () => {
    const controls = installQaControls();
    controls.seedLocalComposer({ sessions: [{ id: "qa-reused" }], activeId: "qa-reused" });
    useStore.setState({
      agents: { "qa-reused": [{ id: "stale-agent" }] as never },
      backgroundTasks: { "qa-reused": [{ id: "stale-task" }] as never },
      codexActivity: { "qa-reused": [{ sequence: 1, kind: "unknown" }] as never },
      codexActivityPaging: {
        "qa-reused": {
          hasMore: true,
          nextCursor: 1,
          loadingOlder: false,
          olderEvents: [{ sequence: 1, kind: "unknown" }] as never,
          archiveLimited: false,
        },
      },
      usage: { "qa-reused": { inputTokens: 1, outputTokens: 1 } as never },
      messagePaging: { "qa-reused": { hasMore: true, loading: false, oldestSeq: 1 } },
    });

    controls.resetScenario();
    controls.seedLocalComposer({ sessions: [{ id: "qa-reused" }], activeId: "qa-reused" });

    const state = useStore.getState();
    expect(state.agents).toEqual({});
    expect(state.backgroundTasks).toEqual({});
    expect(state.codexActivity).toEqual({});
    expect(state.codexActivityPaging).toEqual({});
    expect(state.usage).toEqual({});
    expect(state.messagePaging).toEqual({});
  });
});
