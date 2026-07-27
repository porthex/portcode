import { describe, expect, it } from "vitest";

import type { CodexActivityEvent } from "../types";
import { codexTurnKey, projectCodexActivity, sanitizeCodexInspectorValue } from "./codexActivity";

const event = (
  sequence: number,
  method: string,
  over: Partial<CodexActivityEvent> = {},
): CodexActivityEvent => ({
  sequence,
  sessionId: "S1",
  threadId: "T1",
  method,
  params: {},
  emittedAtMs: sequence * 10,
  ...over,
});

describe("projectCodexActivity", () => {
  it("orders and deduplicates by persisted sequence without mutating the input", () => {
    const events = [
      event(3, "turn/started", {
        turnId: "U3",
        params: { turn: { id: "U3" } },
      }),
      event(1, "turn/started", {
        turnId: "U1",
        params: { turn: { id: "U1" } },
      }),
      event(1, "turn/started", {
        turnId: "duplicate-must-not-win",
        params: { turn: { id: "duplicate-must-not-win" } },
      }),
    ];
    const originalOrder = events.map((candidate) => candidate.turnId);

    const projection = projectCodexActivity(events);

    expect(events.map((candidate) => candidate.turnId)).toEqual(originalOrder);
    expect(projection.turnOrder).toEqual([codexTurnKey("S1", "U1"), codexTurnKey("S1", "U3")]);
  });

  it("upserts a completed turn and ignores a late start that would regress it", () => {
    const projection = projectCodexActivity([
      event(1, "turn/completed", {
        turnId: "U1",
        params: { turn: { id: "U1", status: "failed" } },
      }),
      event(2, "turn/started", {
        turnId: "U1",
        params: { turn: { id: "U1", status: "inProgress" } },
      }),
    ]);

    expect(projection.turns[codexTurnKey("S1", "U1")]?.status).toBe("failed");
  });

  it("keeps the first terminal and pre-terminal diff across legacy reordered persistence", () => {
    const projection = projectCodexActivity([
      event(1, "turn/diff/updated", {
        turnId: "U1",
        params: { threadId: "T1", turnId: "U1", diff: "PRE" },
      }),
      event(2, "turn/completed", {
        turnId: "U1",
        params: { threadId: "T1", turn: { id: "U1", status: "completed" } },
      }),
      event(3, "turn/diff/updated", {
        turnId: "U1",
        params: { threadId: "T1", turnId: "U1", diff: "LATE" },
      }),
      event(4, "turn/completed", {
        turnId: "U1",
        params: { threadId: "T1", turn: { id: "U1", status: "failed" } },
      }),
    ]);

    const turn = projection.turns[codexTurnKey("S1", "U1")];
    expect(turn?.status).toBe("completed");
    expect(turn?.turnDiff).toEqual({ text: "PRE", uncertainty: null, sequence: 1 });
  });

  it("keeps structured plan state but makes canonical delta/final text terminal and authoritative", () => {
    const projection = projectCodexActivity([
      event(1, "turn/plan/updated", {
        turnId: "U1",
        params: {
          turnId: "U1",
          explanation: "Initial approach",
          plan: [
            { step: "Inspect", status: "completed" },
            { step: "Implement", status: "inProgress" },
          ],
        },
      }),
      event(2, "item/plan/delta", {
        turnId: "U1",
        itemId: "plan-1",
        params: {
          threadId: "T1",
          turnId: "U1",
          itemId: "plan-1",
          delta: "Provisional free-form plan",
        },
      }),
      event(3, "item/completed", {
        turnId: "U1",
        itemId: "plan-1",
        params: {
          threadId: "T1",
          turnId: "U1",
          item: { id: "plan-1", type: "plan", text: "AUTHORITATIVE FINAL PLAN" },
          completedAtMs: 30,
        },
      }),
      event(4, "item/plan/delta", {
        turnId: "U1",
        itemId: "plan-1",
        params: {
          threadId: "T1",
          turnId: "U1",
          itemId: "plan-1",
          delta: " LATE DELTA",
        },
      }),
      event(5, "turn/plan/updated", {
        turnId: "U1",
        params: {
          threadId: "T1",
          turnId: "U1",
          explanation: "Late snapshot",
          plan: [{ step: "Must not replace", status: "pending" }],
        },
      }),
      event(6, "turn/plan/updated", {
        sessionId: "S2",
        threadId: "T2",
        turnId: "U1",
        params: {
          turnId: "U1",
          plan: [{ step: "Other session", status: "completed" }],
        },
      }),
    ]);

    expect(projection.turns[codexTurnKey("S1", "U1")]?.plan).toEqual({
      explanation: "Initial approach",
      steps: [
        { text: "Inspect", status: "completed" },
        { text: "Implement", status: "inProgress" },
      ],
      finalText: "AUTHORITATIVE FINAL PLAN",
      terminal: true,
    });
    expect(projection.turns[codexTurnKey("S2", "U1")]?.plan?.steps).toEqual([
      { text: "Other session", status: "completed" },
    ]);
  });

  it("upserts command output before start and preserves identical deltas in sequence order", () => {
    const projection = projectCodexActivity([
      event(1, "item/commandExecution/outputDelta", {
        turnId: "U1",
        itemId: "I1",
        params: { turnId: "U1", itemId: "I1", delta: "same" },
      }),
      event(2, "item/commandExecution/outputDelta", {
        turnId: "U1",
        itemId: "I1",
        params: { turnId: "U1", itemId: "I1", delta: "same" },
      }),
      event(3, "item/started", {
        turnId: "U1",
        itemId: "I1",
        params: {
          turnId: "U1",
          item: {
            id: "I1",
            type: "commandExecution",
            command: "echo same",
            cwd: "C:/repo",
          },
        },
      }),
    ]);

    const turn = projection.turns[codexTurnKey("S1", "U1")];
    expect(turn?.commands.I1).toMatchObject({
      command: "echo same",
      cwd: "C:/repo",
      output: "samesame",
      status: "running",
    });
    expect(turn?.structuredItemIds).toEqual(new Set(["I1"]));
  });

  it("bounds provisional command output and never retains terminal stdin", () => {
    const secret = "SECRET_STDIN_SENTINEL";
    const projection = projectCodexActivity([
      event(1, "item/commandExecution/outputDelta", {
        turnId: "U1",
        itemId: "I1",
        params: {
          turnId: "U1",
          itemId: "I1",
          delta: "older" + "x".repeat(40_000),
        },
      }),
      event(2, "item/commandExecution/terminalInteraction", {
        turnId: "U1",
        itemId: "I1",
        params: { turnId: "U1", itemId: "I1", processId: 42, stdin: secret },
      }),
    ]);

    const command = projection.turns[codexTurnKey("S1", "U1")]?.commands.I1;
    expect(command?.output).toBe("x".repeat(40_000));
    expect(command?.truncatedChars).toBe(5);
    expect(command?.terminalInteractionCount).toBe(1);
    expect(command?.processId).toBe(42);
    expect(JSON.stringify(projection)).not.toContain(secret);
  });

  it("uses completed command output authoritatively and ignores late provisional events", () => {
    const projection = projectCodexActivity([
      event(1, "item/commandExecution/outputDelta", {
        turnId: "U1",
        itemId: "I1",
        params: { turnId: "U1", itemId: "I1", delta: "partial" },
      }),
      event(2, "item/completed", {
        turnId: "U1",
        itemId: "I1",
        params: {
          turnId: "U1",
          item: {
            id: "I1",
            type: "commandExecution",
            command: "pnpm test",
            cwd: "C:/repo",
            status: "completed",
            aggregatedOutput: "authoritative final output",
            exitCode: 0,
            durationMs: 123,
            processId: 55,
          },
        },
      }),
      event(3, "item/commandExecution/outputDelta", {
        turnId: "U1",
        itemId: "I1",
        params: { turnId: "U1", itemId: "I1", delta: "LATE" },
      }),
      event(4, "item/started", {
        turnId: "U1",
        itemId: "I1",
        params: { turnId: "U1", item: { id: "I1", type: "commandExecution" } },
      }),
    ]);

    expect(projection.turns[codexTurnKey("S1", "U1")]?.commands.I1).toMatchObject({
      status: "completed",
      output: "authoritative final output",
      truncatedChars: 0,
      exitCode: 0,
      durationMs: 123,
      processId: 55,
    });
  });

  it("replaces file-change and turn-diff snapshots with authoritative completion", () => {
    const projection = projectCodexActivity([
      event(1, "item/started", {
        turnId: "U1",
        itemId: "I1",
        params: { turnId: "U1", item: { id: "I1", type: "fileChange" } },
      }),
      event(2, "item/fileChange/patchUpdated", {
        turnId: "U1",
        itemId: "I1",
        params: {
          turnId: "U1",
          itemId: "I1",
          changes: [{ path: "old.ts", kind: "update", diff: "old draft" }],
        },
      }),
      event(3, "item/fileChange/patchUpdated", {
        turnId: "U1",
        itemId: "I1",
        params: {
          turnId: "U1",
          itemId: "I1",
          changes: [{ path: "new.ts", kind: "add", diff: "+draft" }],
        },
      }),
      event(4, "turn/diff/updated", {
        turnId: "U1",
        params: { turnId: "U1", diff: "+one" },
      }),
      event(5, "turn/diff/updated", {
        turnId: "U1",
        params: { turnId: "U1", diff: "+two" },
      }),
      event(6, "item/completed", {
        turnId: "U1",
        itemId: "I1",
        params: {
          turnId: "U1",
          item: {
            id: "I1",
            type: "fileChange",
            status: "completed",
            changes: [{ path: "final.ts", kind: "update", diff: "final diff" }],
          },
        },
      }),
      event(7, "item/fileChange/patchUpdated", {
        turnId: "U1",
        itemId: "I1",
        params: {
          turnId: "U1",
          itemId: "I1",
          changes: [{ path: "late.ts", diff: "+late" }],
        },
      }),
    ]);

    const turn = projection.turns[codexTurnKey("S1", "U1")];
    expect(turn?.fileChanges.I1).toMatchObject({
      status: "completed",
      changes: [{ path: "final.ts", kind: "update", diff: "final diff" }],
    });
    expect(turn?.turnDiff).toEqual({
      text: "+two",
      uncertainty: null,
      sequence: 5,
    });
  });

  it("keeps aggregate diffs exact-turn replace-latest and labels malformed or oversized input", () => {
    const projection = projectCodexActivity([
      event(1, "turn/diff/updated", {
        turnId: "U1",
        params: { threadId: "T1", turnId: "U1", diff: "+stale" },
      }),
      event(2, "turn/diff/updated", {
        turnId: "U2",
        params: { threadId: "T1", turnId: "U2", diff: "+other turn" },
      }),
      event(3, "turn/diff/updated", {
        turnId: "U1",
        params: {
          threadId: "T1",
          turnId: "U1",
          diff: "+bounded prefix",
          _portcodeActivity: {
            redacted: false,
            truncated: true,
            redactionReasons: [],
            truncationReasons: ["maxEncodedBytes"],
            originalBytes: 500_000,
            retainedBytes: 64_000,
          },
        },
      }),
      event(4, "turn/diff/updated", {
        turnId: "U3",
        params: { threadId: "T1", turnId: "U3", diff: { unexpected: true } },
      }),
    ]);

    expect(projection.turns[codexTurnKey("S1", "U1")]?.turnDiff).toEqual({
      text: "+bounded prefix",
      uncertainty: "oversized",
      sequence: 3,
    });
    expect(projection.turns[codexTurnKey("S1", "U2")]?.turnDiff).toEqual({
      text: "+other turn",
      uncertainty: null,
      sequence: 2,
    });
    expect(projection.turns[codexTurnKey("S1", "U3")]?.turnDiff).toEqual({
      text: "",
      uncertainty: "malformed",
      sequence: 4,
    });
  });

  it("clears retry notices on progress while retaining errors and warnings through completion", () => {
    const started = event(1, "turn/started", {
      turnId: "U1",
      params: { turn: { id: "U1" } },
    });
    const retry = event(2, "error", {
      turnId: "U1",
      params: {
        turnId: "U1",
        message: "Overloaded; retrying",
        willRetry: true,
      },
    });
    const retryProjection = projectCodexActivity([started, retry]);
    expect(retryProjection.turns[codexTurnKey("S1", "U1")]?.status).toBe("running");
    expect(retryProjection.turns[codexTurnKey("S1", "U1")]?.notices).toEqual([
      expect.objectContaining({
        kind: "retry",
        retrying: true,
        message: "Overloaded; retrying",
      }),
    ]);

    const projection = projectCodexActivity([
      started,
      retry,
      event(3, "turn/plan/updated", {
        turnId: "U1",
        params: {
          turnId: "U1",
          plan: [{ step: "Continue", status: "inProgress" }],
        },
      }),
      event(4, "error", {
        turnId: "U1",
        params: {
          turnId: "U1",
          message: "Visible failure detail",
          willRetry: false,
        },
      }),
      event(5, "warning", { params: { message: "Provider warning" } }),
      event(6, "guardianWarning", { params: { message: "Guardian warning" } }),
      event(7, "turn/completed", {
        turnId: "U1",
        params: { turn: { id: "U1", status: "completed" } },
      }),
    ]);

    const turn = projection.turns[codexTurnKey("S1", "U1")];
    expect(turn?.status).toBe("completed");
    expect(turn?.notices.map(({ kind, message }) => ({ kind, message }))).toEqual([
      { kind: "error", message: "Visible failure detail" },
      { kind: "warning", message: "Provider warning" },
      { kind: "warning", message: "Guardian warning" },
    ]);
  });

  it("projects final reasoning summaries while suppressing raw reasoning content", () => {
    const rawSentinel = "RAW_REASONING_SENTINEL";
    const completedSentinel = "COMPLETED_REASONING_CONTENT_SENTINEL";
    const projection = projectCodexActivity([
      event(1, "item/reasoning/summaryPartAdded", {
        turnId: "U1",
        itemId: "I1",
        params: { turnId: "U1", itemId: "I1", summaryIndex: 1 },
      }),
      event(2, "item/reasoning/summaryTextDelta", {
        turnId: "U1",
        itemId: "I1",
        params: {
          turnId: "U1",
          itemId: "I1",
          summaryIndex: 1,
          delta: "Draft B",
        },
      }),
      event(3, "item/reasoning/summaryTextDelta", {
        turnId: "U1",
        itemId: "I1",
        params: {
          turnId: "U1",
          itemId: "I1",
          summaryIndex: 0,
          delta: "Draft A",
        },
      }),
      event(4, "item/reasoning/textDelta", {
        turnId: "U1",
        itemId: "I1",
        params: { turnId: "U1", itemId: "I1", delta: rawSentinel },
      }),
      event(5, "item/completed", {
        turnId: "U1",
        itemId: "I1",
        params: {
          turnId: "U1",
          item: {
            id: "I1",
            type: "reasoning",
            summary: ["Final A", "Final B"],
            content: [completedSentinel],
          },
          completedAtMs: 50,
        },
      }),
    ]);

    const turn = projection.turns[codexTurnKey("S1", "U1")];
    expect(turn?.reasoning.I1).toMatchObject({
      parts: ["Final A", "Final B"],
      status: "completed",
    });
    expect(JSON.stringify(projection)).not.toContain(rawSentinel);
    expect(JSON.stringify(projection)).not.toContain(completedSentinel);
  });

  it("projects monotonic context compaction with a current-turn compatibility fallback", () => {
    const projection = projectCodexActivity([
      event(1, "item/completed", {
        turnId: "U1",
        itemId: "I1",
        params: {
          turnId: "U1",
          item: { id: "I1", type: "contextCompaction", status: "completed" },
        },
      }),
      event(2, "item/started", {
        turnId: "U1",
        itemId: "I1",
        params: { turnId: "U1", item: { id: "I1", type: "contextCompaction" } },
      }),
      event(3, "turn/started", {
        turnId: "U2",
        params: { turn: { id: "U2" } },
      }),
      event(4, "thread/compacted", { params: {} }),
    ]);

    expect(projection.turns[codexTurnKey("S1", "U1")]?.compactions.I1?.status).toBe("completed");
    expect(
      Object.values(projection.turns[codexTurnKey("S1", "U2")]?.compactions ?? {})[0]?.status,
    ).toBe("completed");
  });

  it("upserts MCP progress and replaces it with authoritative terminal results", () => {
    const projection = projectCodexActivity([
      event(1, "item/mcpToolCall/progress", {
        turnId: "U1",
        itemId: "I1",
        params: { turnId: "U1", itemId: "I1", message: "Connecting" },
      }),
      event(2, "item/mcpToolCall/progress", {
        turnId: "U1",
        itemId: "I1",
        params: { turnId: "U1", itemId: "I1", message: "Reading repository" },
      }),
      event(3, "item/started", {
        turnId: "U1",
        itemId: "I1",
        params: {
          turnId: "U1",
          item: {
            id: "I1",
            type: "mcpToolCall",
            server: "github",
            tool: "get_file",
            arguments: { path: "README.md" },
          },
        },
      }),
      event(4, "item/completed", {
        turnId: "U1",
        itemId: "I1",
        params: {
          turnId: "U1",
          item: {
            id: "I1",
            type: "mcpToolCall",
            status: "completed",
            result: { content: "done" },
            durationMs: 80,
          },
        },
      }),
      event(5, "item/mcpToolCall/progress", {
        turnId: "U1",
        itemId: "I1",
        params: { turnId: "U1", itemId: "I1", message: "LATE" },
      }),
      event(6, "item/completed", {
        turnId: "U1",
        itemId: "I2",
        params: {
          turnId: "U1",
          item: {
            id: "I2",
            type: "mcpToolCall",
            status: "failed",
            server: "github",
            tool: "get_issue",
            error: { message: "Not found" },
            durationMs: 30,
          },
        },
      }),
    ]);

    const turn = projection.turns[codexTurnKey("S1", "U1")];
    expect(turn?.mcpCalls.I1).toMatchObject({
      server: "github",
      tool: "get_file",
      arguments: { path: "README.md" },
      progress: "Reading repository",
      status: "completed",
      result: { content: "done" },
      durationMs: 80,
    });
    expect(turn?.mcpCalls.I2).toMatchObject({
      status: "failed",
      error: { message: "Not found" },
      durationMs: 30,
    });
  });

  it("bounds unknown recorded parameters while excluding known and sensitive methods", () => {
    const nestedRawSentinel = "LEGACY_NESTED_RAW_REASONING_SENTINEL";
    const unknownEvents = Array.from({ length: 205 }, (_, index) =>
      event(index + 1, "future/method/" + (index + 1), {
        turnId: "U1",
        itemId: "I" + (index + 1),
        params: { nested: { index, html: "<img src=x onerror=alert(1)>" } },
        requestId: "R" + (index + 1),
      }),
    );
    const projection = projectCodexActivity([
      ...unknownEvents,
      event(206, "future/malformed", {
        params: {
          benign: { escaped: "<keep metadata inert>" },
          payload: { reasoning: { text: nestedRawSentinel } },
        },
      }),
      event(207, "item/reasoning/textDelta", {
        turnId: "U1",
        itemId: "I-sensitive",
        params: { delta: "RAW_REASONING_MUST_STAY_HIDDEN" },
      }),
      event(208, "turn/started", {
        turnId: "U2",
        params: { turn: { id: "U2" } },
      }),
    ]);

    expect(projection.unknown).toHaveLength(200);
    expect(projection.unknownTruncated).toBe(6);
    expect(projection.unknown[0]?.sequence).toBe(1);
    expect(projection.unknown[99]?.sequence).toBe(100);
    expect(projection.unknown[100]?.sequence).toBe(107);
    expect(projection.unknown[projection.unknown.length - 1]).toMatchObject({
      sequence: 206,
      method: "future/malformed",
    });
    expect(projection.unknown.some((record) => record.method === "turn/started")).toBe(false);
    expect(JSON.stringify(projection)).not.toContain("RAW_REASONING_MUST_STAY_HIDDEN");
    expect(JSON.stringify(projection)).not.toContain(nestedRawSentinel);
    expect(JSON.stringify(projection)).toContain("<keep metadata inert>");
  });

  it("uses authoritative hasMore instead of inferring truncation from an exact 2,000-row page", () => {
    const rows = Array.from({ length: 2_000 }, (_, index) =>
      event(index + 1, "future/page", { params: { index } }),
    );

    expect(projectCodexActivity(rows, { hasMore: false }).hasMore).toBe(false);
    expect(projectCodexActivity(rows, { hasMore: true }).hasMore).toBe(true);
  });

  it.each([
    ["failed", "failed"],
    ["cancelled", "interrupted"],
  ] as const)(
    "terminalizes every still-running turn-owned item when the turn is %s",
    (turnStatus, expectedStatus) => {
      const projection = projectCodexActivity([
        event(1, "item/started", {
          turnId: "U1",
          itemId: "command",
          params: {
            threadId: "T1",
            turnId: "U1",
            item: {
              id: "command",
              type: "commandExecution",
              command: "pnpm test",
              status: "inProgress",
            },
            startedAtMs: 10,
          },
        }),
        event(2, "item/started", {
          turnId: "U1",
          itemId: "file",
          params: {
            threadId: "T1",
            turnId: "U1",
            item: { id: "file", type: "fileChange", status: "inProgress", changes: [] },
            startedAtMs: 20,
          },
        }),
        event(3, "item/started", {
          turnId: "U1",
          itemId: "mcp",
          params: {
            threadId: "T1",
            turnId: "U1",
            item: {
              id: "mcp",
              type: "mcpToolCall",
              server: "github",
              tool: "get_issue",
              status: "inProgress",
            },
            startedAtMs: 30,
          },
        }),
        event(4, "item/started", {
          turnId: "U1",
          itemId: "reasoning",
          params: {
            threadId: "T1",
            turnId: "U1",
            item: { id: "reasoning", type: "reasoning", summary: ["Safe summary"] },
            startedAtMs: 40,
          },
        }),
        event(5, "item/started", {
          turnId: "U1",
          itemId: "compaction",
          params: {
            threadId: "T1",
            turnId: "U1",
            item: { id: "compaction", type: "contextCompaction" },
            startedAtMs: 50,
          },
        }),
        event(6, "turn/completed", {
          turnId: "U1",
          params: {
            threadId: "T1",
            turn: {
              id: "U1",
              status: turnStatus,
              items: [],
              error: turnStatus === "failed" ? { message: "boom" } : null,
            },
            completedAtMs: 60,
          },
        }),
        event(7, "item/commandExecution/outputDelta", {
          turnId: "U1",
          itemId: "command",
          params: { threadId: "T1", turnId: "U1", itemId: "command", delta: "LATE" },
        }),
        event(8, "item/fileChange/patchUpdated", {
          turnId: "U1",
          itemId: "file",
          params: {
            threadId: "T1",
            turnId: "U1",
            itemId: "file",
            changes: [{ path: "late.ts", diff: "+late" }],
          },
        }),
        event(9, "item/mcpToolCall/progress", {
          turnId: "U1",
          itemId: "mcp",
          params: { threadId: "T1", turnId: "U1", itemId: "mcp", message: "LATE" },
        }),
        event(10, "item/reasoning/summaryTextDelta", {
          turnId: "U1",
          itemId: "reasoning",
          params: {
            threadId: "T1",
            turnId: "U1",
            itemId: "reasoning",
            summaryIndex: 0,
            delta: "LATE",
          },
        }),
        event(11, "item/started", {
          turnId: "U1",
          itemId: "compaction",
          params: {
            threadId: "T1",
            turnId: "U1",
            item: { id: "compaction", type: "contextCompaction" },
            startedAtMs: 110,
          },
        }),
      ]);

      const turn = projection.turns[codexTurnKey("S1", "U1")];
      expect(turn?.commands.command).toMatchObject({
        status: expectedStatus,
        terminal: true,
        output: "",
      });
      expect(turn?.fileChanges.file).toMatchObject({
        status: expectedStatus,
        terminal: true,
        changes: [],
      });
      expect(turn?.mcpCalls.mcp).toMatchObject({
        status: expectedStatus,
        terminal: true,
        progress: undefined,
      });
      expect(turn?.reasoning.reasoning).toMatchObject({
        status: expectedStatus,
        terminal: true,
        parts: ["Safe summary"],
      });
      expect(turn?.compactions.compaction).toMatchObject({
        status: expectedStatus,
        terminal: true,
      });
    },
  );

  it("safely ignores malformed lifecycle identities and preserves unknown terminal states", () => {
    const projection = projectCodexActivity([
      event(1, "thread/tokenUsage/updated", { turnId: null, params: {} }),
      event(2, "turn/completed", {
        turnId: "U-cancelled",
        params: { turn: { id: "U-cancelled", status: "cancelled" } },
      }),
      event(3, "turn/completed", {
        turnId: "U-unknown",
        params: { turn: { id: "U-unknown", status: "futureStatus" } },
      }),
      event(4, "item/completed", {
        turnId: "U-cancelled",
        itemId: "I-command",
        params: {
          turnId: "U-cancelled",
          item: {
            id: "I-command",
            type: "commandExecution",
            status: "declined",
          },
        },
      }),
      event(5, "item/completed", {
        turnId: "U-cancelled",
        itemId: "I-file",
        params: {
          turnId: "U-cancelled",
          item: {
            id: "I-file",
            type: "fileChange",
            status: "futureStatus",
            changes: [{ diff: "+missing path" }],
          },
        },
      }),
      event(6, "item/started", {
        turnId: "U-cancelled",
        itemId: "R-start",
        params: {
          turnId: "U-cancelled",
          item: {
            id: "R-start",
            type: "reasoning",
            summary: [{ text: "Object summary" }],
          },
        },
      }),
      event(7, "item/completed", {
        turnId: "U-cancelled",
        itemId: "R-terminal",
        params: {
          turnId: "U-cancelled",
          item: {
            id: "R-terminal",
            type: "reasoning",
            summary: ["Final summary"],
          },
          completedAtMs: 70,
        },
      }),
      event(8, "item/reasoning/summaryTextDelta", {
        turnId: "U-cancelled",
        itemId: "R-terminal",
        params: {
          turnId: "U-cancelled",
          itemId: "R-terminal",
          summaryIndex: 0,
          delta: "LATE",
        },
      }),
      event(9, "item/reasoning/summaryPartAdded", {
        turnId: "U-cancelled",
        params: { turnId: "U-cancelled", summaryIndex: 999 },
      }),
      event(10, "item/commandExecution/outputDelta", {
        turnId: "U-cancelled",
        params: { turnId: "U-cancelled", delta: "ignored" },
      }),
      event(11, "item/mcpToolCall/progress", {
        turnId: "U-cancelled",
        params: { turnId: "U-cancelled", message: "ignored" },
      }),
      event(12, "item/commandExecution/terminalInteraction", {
        turnId: "U-cancelled",
        params: { turnId: "U-cancelled" },
      }),
      event(13, "item/fileChange/patchUpdated", {
        turnId: "U-cancelled",
        params: { turnId: "U-cancelled", changes: [] },
      }),
      event(14, "item/completed", {
        turnId: "U-cancelled",
        params: { turnId: "U-cancelled", item: { type: "commandExecution" } },
      }),
      event(15, "item/started", {
        turnId: "U-cancelled",
        params: { turnId: "U-cancelled", item: { type: "commandExecution" } },
      }),
      event(16, "item/started", {
        turnId: "U-cancelled",
        itemId: "C-running",
        params: {
          turnId: "U-cancelled",
          item: { id: "C-running", type: "contextCompaction" },
        },
      }),
      event(17, "error", {
        turnId: "U-cancelled",
        params: { turnId: "U-cancelled", willRetry: true },
      }),
      event(18, "error", {
        turnId: "U-cancelled",
        params: { turnId: "U-cancelled", willRetry: true },
      }),
    ]);

    const cancelled = projection.turns[codexTurnKey("S1", "U-cancelled")];
    expect(cancelled?.status).toBe("interrupted");
    expect(cancelled?.commands["I-command"]?.status).toBe("interrupted");
    expect(cancelled?.fileChanges["I-file"]).toMatchObject({
      status: "unknown",
      changes: [],
    });
    expect(cancelled?.reasoning["R-start"]?.parts).toEqual(["Object summary"]);
    expect(cancelled?.reasoning["R-terminal"]?.parts).toEqual(["Final summary"]);
    expect(cancelled?.compactions["C-running"]).toMatchObject({
      status: "interrupted",
      terminal: true,
    });
    expect(cancelled?.notices.filter((notice) => notice.kind === "retry")).toHaveLength(1);
    expect(projection.turns[codexTurnKey("S1", "U-unknown")]?.status).toBe("unknown");
  });

  it("recursively redacts normalized type and kind reasoning variants before any projection", () => {
    const sentinel = "RAW_SENTINEL_FRONTEND_REASONING";
    const hostile = {
      nested: [
        { kind: "chain_of_thought", summary: ["safe"], content: sentinel },
        { "K-I-N-D": "RAW Reasoning", payload: { text: sentinel } },
        { TyPe: "Chain.Of-Thought", raw_reasoning: sentinel },
        { reasoning_text: sentinel },
        { "Chain.Of-Thought Text": sentinel },
        { INTERNAL_REASONING_TEXT: sentinel },
        { kind: "reasoning_text", summary: ["Safe reasoning summary"], text: sentinel },
        { type: "chain-of-thought-text", summary: "Safe discriminator summary", payload: sentinel },
        { "K I N D": "Internal.Reasoning-Text", summary: "Safe internal summary", value: sentinel },
      ],
    };
    const sanitized = JSON.stringify(sanitizeCodexInspectorValue(hostile));
    expect(sanitized).not.toContain(sentinel);
    expect(sanitized).toContain("Safe reasoning summary");
    expect(sanitized).toContain("Safe discriminator summary");
    expect(sanitized).toContain("Safe internal summary");

    const projection = projectCodexActivity([
      event(1, "item/completed", {
        turnId: "U-safe",
        itemId: "M-safe",
        params: {
          turnId: "U-safe",
          item: {
            id: "M-safe",
            type: "mcpToolCall",
            status: "completed",
            server: "safe-server",
            tool: "safe-tool",
            arguments: hostile,
            result: hostile,
          },
        },
      }),
    ]);
    expect(JSON.stringify(projection)).not.toContain(sentinel);
  });

  it("recursively redacts normalized known-secret keys before legacy rows are projected", () => {
    const sentinels = [
      "API_KEY_FRONTEND_SENTINEL",
      "PASSWORD_FRONTEND_SENTINEL",
      "AUTHORIZATION_FRONTEND_SENTINEL",
      "CREDENTIAL_FRONTEND_SENTINEL",
      "CLIENT_SECRET_FRONTEND_SENTINEL",
      "ACCESS_TOKEN_FRONTEND_SENTINEL",
      "PRIVATE_KEY_FRONTEND_SENTINEL",
      "COOKIE_FRONTEND_SENTINEL",
    ];
    const hostile = {
      apiKey: sentinels[0],
      "Pass-Word": sentinels[1],
      AUTHORIZATION: sentinels[2],
      nested: [{ "cre.den_tial": sentinels[3] }],
      "Client Secret": sentinels[4],
      access_token: sentinels[5],
      PRIVATE_KEY: sentinels[6],
      "Set-Cookie": sentinels[7],
      status: "completed",
      summary: "Safe summary survives",
      correlationId: "safe-correlation",
      benignUnknownMetadata: { provider: "future-codex", count: 3 },
    };

    const sanitized = sanitizeCodexInspectorValue(hostile);
    const encoded = JSON.stringify(sanitized);
    for (const sentinel of sentinels) {
      expect(encoded).not.toContain(sentinel);
    }
    expect(sanitized).toMatchObject({
      status: "completed",
      summary: "Safe summary survives",
      correlationId: "safe-correlation",
      benignUnknownMetadata: { provider: "future-codex", count: 3 },
    });

    const projection = projectCodexActivity([
      event(1, "future/knownSecretMatrix", { params: hostile }),
    ]);
    const projected = JSON.stringify(projection);
    for (const sentinel of sentinels) {
      expect(projected).not.toContain(sentinel);
    }
    expect(projected).toContain("Safe summary survives");
    expect(projected).toContain("safe-correlation");
  });

  it("freezes provisional plans at the terminal turn sequence across reordered duplicates", () => {
    const projection = projectCodexActivity([
      event(5, "item/completed", {
        turnId: "U-plan-terminal",
        itemId: "plan-1",
        params: {
          turnId: "U-plan-terminal",
          item: { id: "plan-1", type: "plan", text: "LATE FINAL" },
        },
      }),
      event(2, "turn/plan/updated", {
        turnId: "U-plan-terminal",
        params: {
          turnId: "U-plan-terminal",
          explanation: "authoritative pre-terminal",
          plan: [{ step: "Ship safely", status: "inProgress" }],
        },
      }),
      event(3, "turn/completed", {
        turnId: "U-plan-terminal",
        params: { turn: { id: "U-plan-terminal", status: "completed" } },
      }),
      event(4, "turn/plan/updated", {
        turnId: "U-plan-terminal",
        params: {
          turnId: "U-plan-terminal",
          explanation: "late mutation",
          plan: [{ step: "MUST NOT REPLACE", status: "pending" }],
        },
      }),
      event(4, "turn/plan/updated", {
        turnId: "U-plan-terminal",
        params: { turnId: "U-plan-terminal", plan: [] },
      }),
    ]);

    expect(projection.turns[codexTurnKey("S1", "U-plan-terminal")]?.plan).toEqual({
      explanation: "authoritative pre-terminal",
      steps: [{ text: "Ship safely", status: "inProgress" }],
      terminal: true,
    });
  });
});
