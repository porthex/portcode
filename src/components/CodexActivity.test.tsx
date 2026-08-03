import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CodexActivityEvent } from "../types";
import { codexTurnKey, projectCodexActivity } from "../lib/codexActivity";
import {
  CodexActivityHistoryInspector,
  CodexTurnActivityView,
  CodexUnknownActivityInspector,
} from "./CodexActivity";

const event = (
  sequence: number,
  method: string,
  over: Partial<CodexActivityEvent> = {},
): CodexActivityEvent => ({
  sequence,
  sessionId: "S1",
  threadId: "T1",
  turnId: "U1",
  method,
  params: {},
  emittedAtMs: sequence * 10,
  ...over,
});

const turnFrom = (events: CodexActivityEvent[]) =>
  projectCodexActivity(events).turns[codexTurnKey("S1", "U1")]!;

describe("CodexTurnActivityView", () => {
  it("renders every canonical plan status with accessible text", () => {
    const activity = turnFrom([
      event(1, "turn/plan/updated", {
        params: {
          turnId: "U1",
          explanation: "Ship safely",
          plan: [
            { step: "Inspect", status: "pending" },
            { step: "Implement", status: "inProgress" },
            { step: "Verify", status: "completed" },
          ],
        },
      }),
    ]);

    render(<CodexTurnActivityView activity={activity} />);

    expect(screen.getByRole("region", { name: "Codex turn activity" })).toBeInTheDocument();
    expect(screen.getByText("Ship safely")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("hostile plan text retains only canonical visible statuses", () => {
    const longUnicode = `LONG_${"界".repeat(240)}<script>window.PWNED = true</script>`;
    const emoji = "Emoji 👩🏽‍💻🚀✅";
    const multiline = "Line one\nLine two\nLine three";
    const rtlFuture = "RTL \u202e marker text";
    const activity = turnFrom([
      event(1, "turn/plan/updated", {
        params: {
          threadId: "T1",
          turnId: "U1",
          explanation: "Provider text remains inert",
          plan: [
            { step: "", status: "pending" },
            { step: longUnicode, status: "pending" },
            { step: emoji, status: "inProgress" },
            { step: multiline, status: "completed" },
            { step: rtlFuture, status: "future-status" },
          ],
        },
      }),
    ]);

    const { container } = render(<CodexTurnActivityView activity={activity} />);
    const rows = [...container.querySelectorAll(".pc-codex-plan__step")];

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelector(".min-w-0")?.textContent)).toEqual([
      longUnicode,
      emoji,
      multiline,
    ]);
    expect(rows.map((row) => row.querySelectorAll(".pc-codex-plan__status").length)).toEqual([
      1, 1, 1,
    ]);
    expect(rows.map((row) => row.querySelector(".pc-codex-plan__status")?.textContent)).toEqual([
      "Pending",
      "In progress",
      "Completed",
    ]);
    for (const row of rows) {
      expect(row.querySelector(".min-w-0")).toHaveClass("flex-1");
      expect(row.querySelector(".pc-codex-plan__status")).toHaveClass("pc-codex-plan__status");
    }
    expect(screen.queryByText(rtlFuture)).not.toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect((window as Window & { PWNED?: boolean }).PWNED).toBeUndefined();
  });

  it("gives each rendered turn plan a unique accessible label target", () => {
    const activity = turnFrom([
      event(1, "turn/plan/updated", {
        params: {
          turnId: "U1",
          plan: [{ step: "Inspect", status: "pending" }],
        },
      }),
    ]);

    render(
      <>
        <CodexTurnActivityView activity={activity} />
        <CodexTurnActivityView activity={activity} />
      </>,
    );

    const labels = screen.getAllByText("Plan");
    expect(new Set(labels.map((label) => label.id))).toHaveLength(2);
    for (const label of labels) {
      expect(label.parentElement).toHaveAttribute("aria-labelledby", label.id);
    }
  });

  it("renders authoritative final plan text separately from the last structured statuses", () => {
    const finalText = "Final prose only — do not invent checklist status";
    const activity = turnFrom([
      event(1, "turn/plan/updated", {
        params: {
          threadId: "T1",
          turnId: "U1",
          plan: [{ step: "Structured step", status: "inProgress" }],
        },
      }),
      event(2, "item/completed", {
        itemId: "plan-1",
        params: {
          threadId: "T1",
          turnId: "U1",
          item: { id: "plan-1", type: "plan", text: finalText },
          completedAtMs: 20,
        },
      }),
    ]);

    render(<CodexTurnActivityView activity={activity} />);

    expect(screen.getByText("Last structured plan update")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("Final plan")).toBeInTheDocument();
    expect(screen.getByText(finalText)).toBeInTheDocument();
  });

  it("keeps command output unmounted while collapsed and updates an open disclosure", () => {
    const start = event(1, "item/started", {
      itemId: "I1",
      params: {
        turnId: "U1",
        item: {
          id: "I1",
          type: "commandExecution",
          command: "echo hi",
          cwd: "C:/repo",
        },
      },
    });
    const firstDelta = event(2, "item/commandExecution/outputDelta", {
      itemId: "I1",
      params: { turnId: "U1", itemId: "I1", delta: "live output" },
    });
    const { rerender } = render(<CodexTurnActivityView activity={turnFrom([start, firstDelta])} />);

    const toggle = screen.getByRole("button", {
      name: "echo hi, running, expand output",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.querySelector(".pc-toolcall__name")).toHaveClass("min-w-0");
    expect(toggle.querySelector(".pc-codex-activity__status")).toHaveClass(
      "shrink-0",
      "whitespace-nowrap",
    );
    expect(screen.queryByText("live output")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "echo hi details" })).toBeInTheDocument();
    expect(screen.getByText("live output")).toBeInTheDocument();

    rerender(
      <CodexTurnActivityView
        activity={turnFrom([
          start,
          firstDelta,
          event(3, "item/commandExecution/outputDelta", {
            itemId: "I1",
            params: { turnId: "U1", itemId: "I1", delta: " tail" },
          }),
        ])}
      />,
    );
    expect(screen.getByText("live output tail")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders notices, summaries, compaction, diffs, and MCP progress with lazy details", () => {
    const activity = turnFrom([
      event(1, "turn/started", { params: { turn: { id: "U1" } } }),
      event(2, "error", {
        params: {
          turnId: "U1",
          message: "Retrying after overload",
          willRetry: true,
        },
      }),
      event(3, "item/completed", {
        itemId: "R1",
        params: {
          turnId: "U1",
          item: {
            id: "R1",
            type: "reasoning",
            summary: ["Safe summary"],
          },
          completedAtMs: 30,
        },
      }),
      event(4, "item/completed", {
        itemId: "C1",
        params: {
          turnId: "U1",
          item: { id: "C1", type: "contextCompaction", status: "completed" },
        },
      }),
      event(5, "item/completed", {
        itemId: "F1",
        params: {
          turnId: "U1",
          item: {
            id: "F1",
            type: "fileChange",
            status: "completed",
            changes: [{ path: "src/app.ts", kind: "update", diff: "+file line" }],
          },
        },
      }),
      event(6, "turn/diff/updated", {
        params: { turnId: "U1", diff: "+aggregate line" },
      }),
      event(7, "item/mcpToolCall/progress", {
        itemId: "M1",
        params: { turnId: "U1", itemId: "M1", message: "Fetching issue" },
      }),
      event(8, "item/started", {
        itemId: "M1",
        params: {
          turnId: "U1",
          item: {
            id: "M1",
            type: "mcpToolCall",
            server: "github",
            tool: "get_issue",
          },
        },
      }),
      event(9, "error", {
        params: {
          turnId: "U1",
          message: "Retrying after overload",
          willRetry: true,
        },
      }),
    ]);

    render(<CodexTurnActivityView activity={activity} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Retrying after overload");
    const reasoning = screen.getByRole("button", {
      name: "Reasoning summary, completed, expand summary",
    });
    expect(screen.queryByText("Safe summary")).not.toBeInTheDocument();
    fireEvent.click(reasoning);
    expect(screen.getByText("Safe summary")).toBeInTheDocument();
    expect(screen.getByText("Context compacted.")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Changed 1 file, completed, expand changes",
      }),
    );
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("+file line")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Live changes, updated, expand diff",
      }),
    );
    expect(screen.getByText("+aggregate line")).toBeInTheDocument();
    expect(screen.getByText("Fetching issue")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "github / get_issue, running, expand details",
      }),
    ).toBeInTheDocument();
  });

  it("renders defensive statuses and terminal MCP details without empty activity chrome", () => {
    const nestedMcpReasoning = "LEGACY_MCP_RAW_REASONING_MUST_NOT_RENDER";
    const empty = render(
      <CodexTurnActivityView
        activity={turnFrom([event(1, "turn/started", { params: { turn: { id: "U1" } } })])}
      />,
    );
    expect(empty.container).toBeEmptyDOMElement();
    empty.unmount();

    const activity = turnFrom([
      event(1, "warning", { params: { turnId: "U1", message: "Caution" } }),
      event(2, "error", {
        params: { turnId: "U1", message: "Terminal detail", willRetry: false },
      }),
      event(3, "item/started", {
        itemId: "C1",
        params: { turnId: "U1", item: { id: "C1", type: "contextCompaction" } },
      }),
      event(4, "item/started", {
        itemId: "C2",
        params: { turnId: "U1", item: { id: "C2", type: "contextCompaction" } },
      }),
      event(5, "item/completed", {
        itemId: "F1",
        params: {
          turnId: "U1",
          item: {
            id: "F1",
            type: "commandExecution",
            command: "fail",
            status: "failed",
          },
        },
      }),
      event(6, "item/completed", {
        itemId: "F2",
        params: {
          turnId: "U1",
          item: {
            id: "F2",
            type: "commandExecution",
            command: "stop",
            status: "declined",
          },
        },
      }),
      event(7, "item/completed", {
        itemId: "F3",
        params: {
          turnId: "U1",
          item: {
            id: "F3",
            type: "commandExecution",
            command: "future",
            status: "future",
          },
        },
      }),
      event(8, "item/completed", {
        itemId: "M1",
        params: {
          turnId: "U1",
          item: {
            id: "M1",
            type: "mcpToolCall",
            server: "github",
            tool: "get_issue",
            status: "failed",
            arguments: {
              issue: 7,
              payload: { raw_reasoning: { text: nestedMcpReasoning } },
            },
            result: { partial: true },
            error: { message: "No issue" },
            durationMs: 12,
          },
        },
      }),
      event(9, "item/started", {
        itemId: "R1",
        params: {
          turnId: "U1",
          item: { id: "R1", type: "reasoning", summary: ["One"] },
        },
      }),
      event(10, "item/started", {
        itemId: "R2",
        params: {
          turnId: "U1",
          item: { id: "R2", type: "reasoning", summary: ["Two"] },
        },
      }),
    ]);

    render(<CodexTurnActivityView activity={activity} />);

    expect(screen.getByRole("note")).toHaveTextContent("Caution");
    expect(screen.getByRole("alert")).toHaveTextContent("Terminal detail");
    expect(screen.getAllByText("Compacting context…")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "fail, failed, expand output" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "stop, interrupted, expand output" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "future, unknown, expand output" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "github / get_issue, failed, expand details",
      }),
    );
    expect(screen.getByText("Arguments")).toBeInTheDocument();
    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getAllByText("Error")).toHaveLength(2);
    expect(screen.getByText(/No issue/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(nestedMcpReasoning);
  });

  it("labels uncertain aggregate diff evidence and routes review to the selected turn", () => {
    const onReviewChanges = vi.fn();
    const activity = turnFrom([
      event(1, "turn/diff/updated", {
        params: {
          threadId: "T1",
          turnId: "U1",
          diff: "+bounded prefix",
          _portcodeActivity: {
            truncated: true,
            truncationReasons: ["maxEncodedBytes"],
            originalBytes: 500_000,
            retainedBytes: 64_000,
          },
        },
      }),
    ]);

    render(
      <CodexTurnActivityView
        activity={activity}
        onReviewChanges={onReviewChanges}
        reviewAvailable
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Live changes, updated, expand diff" }));

    expect(screen.getByText(/oversized.*may be incomplete/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review exact turn changes" }));
    expect(onReviewChanges).toHaveBeenCalledTimes(1);
  });
});

describe("CodexUnknownActivityInspector", () => {
  it("lazily renders benign parameters, redacts nested reasoning, and offers authoritative older access", () => {
    const hostile = "<script>window.PWNED = true</script>";
    const rawSentinel = "LEGACY_RAW_REASONING_MUST_NOT_RENDER_OR_COPY";
    const projection = projectCodexActivity(
      [
        event(1, "future/unknown", {
          itemId: "I-unknown",
          params: {
            hostile,
            nested: [null, "✓"],
            payload: {
              reasoning: { text: rawSentinel },
              normalizedKinds: [
                { kind: "chain_of_thought", content: rawSentinel },
                { "K-I-N-D": "RAW Reasoning", payload: { text: rawSentinel } },
                { TyPe: "Chain.Of-Thought", text: rawSentinel },
                { reasoning_text: rawSentinel },
                { "Chain.Of-Thought Text": rawSentinel },
                { INTERNAL_REASONING_TEXT: rawSentinel },
                {
                  kind: "reasoning_text",
                  summary: "SAFE_REASONING_SUMMARY_MUST_RENDER",
                  text: rawSentinel,
                },
                { type: "chain-of-thought-text", payload: rawSentinel },
                { "K I N D": "Internal.Reasoning-Text", value: rawSentinel },
              ],
            },
          },
        }),
      ],
      { hasMore: true },
    );
    const loadOlder = vi.fn();

    render(
      <CodexUnknownActivityInspector
        projection={projection}
        onLoadOlder={loadOlder}
        loadingOlder={false}
      />,
    );

    const inspector = screen.getByRole("button", {
      name: "Unrecognized Codex activity (1), expand",
    });
    expect(inspector).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("future/unknown")).not.toBeInTheDocument();
    expect(screen.queryByText(hostile)).not.toBeInTheDocument();

    fireEvent.click(inspector);
    expect(screen.getByText("Older persisted activity is available.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(loadOlder).toHaveBeenCalledTimes(1);
    const parameters = screen.getByRole("button", {
      name: "future/unknown recorded parameters, expand",
    });
    expect(screen.queryByText(hostile)).not.toBeInTheDocument();
    fireEvent.click(parameters);
    expect(screen.getByText(new RegExp("window.PWNED"))).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(document.body).not.toHaveTextContent(rawSentinel);
    expect(screen.queryByText(rawSentinel)).toBeNull();
    expect(document.body).toHaveTextContent("SAFE_REASONING_SUMMARY_MUST_RENDER");
  });

  it("keeps legacy known-secret values out of DOM, accessible text, and copyable JSON", () => {
    const sentinels = [
      "DOM_API_KEY_SENTINEL",
      "DOM_PASSWORD_SENTINEL",
      "DOM_AUTHORIZATION_SENTINEL",
      "DOM_NESTED_CREDENTIAL_SENTINEL",
    ];
    const projection = projectCodexActivity([
      event(1, "future/legacyKnownSecrets", {
        params: {
          api_key: sentinels[0],
          "Pass.Word": sentinels[1],
          "Proxy Authorization": sentinels[2],
          nested: [{ CREDENTIALS: sentinels[3] }],
          status: "completed",
          summary: "SAFE_INSPECTOR_SUMMARY",
        },
      }),
    ]);

    render(<CodexUnknownActivityInspector projection={projection} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Unrecognized Codex activity (1), expand",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "future/legacyKnownSecrets recorded parameters, expand",
      }),
    );

    const copyableJson = screen.getByRole("region", {
      name: "future/legacyKnownSecrets recorded parameters",
    });
    expect(copyableJson).toHaveTextContent("SAFE_INSPECTOR_SUMMARY");
    for (const sentinel of sentinels) {
      expect(copyableJson).not.toHaveTextContent(sentinel);
      expect(document.body).not.toHaveTextContent(sentinel);
      for (const element of document.querySelectorAll("[aria-label]")) {
        expect(element.getAttribute("aria-label")).not.toContain(sentinel);
      }
    }
  });

  it("fails closed when recorded parameters cannot be serialized", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const projection = projectCodexActivity([event(1, "future/circular", { params: circular })]);

    render(<CodexUnknownActivityInspector projection={projection} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Unrecognized Codex activity (1), expand",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "future/circular recorded parameters, expand",
      }),
    );

    expect(screen.getByText("Unable to display recorded parameters.")).toBeInTheDocument();
  });
});

describe("CodexActivityHistoryInspector", () => {
  it("deduplicates, sorts, filters, and navigates every bounded retained range", () => {
    const retained = Array.from({ length: 450 }, (_, index) =>
      event(450 - index, `future/event-${450 - index}`),
    );
    retained.push(event(200, "future/duplicate"));
    retained.push(event(451, "turn/started", { params: { turn: { id: "U1" } } }));

    const { rerender } = render(
      <CodexActivityHistoryInspector events={retained} scopeKey="first" unknownOnly />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Unrecognized Codex activity/ }));
    expect(
      screen.getByText(/Showing unrecognized retained records 251–450 of 450/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show oldest retained activity" }));
    expect(screen.getByText(/retained records 1–200 of 450/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Newer" }));
    expect(screen.getByText(/retained records 201–400 of 450/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show newest retained activity" }));
    expect(screen.getByText(/retained records 251–450 of 450/)).toBeInTheDocument();

    rerender(
      <CodexActivityHistoryInspector events={retained} scopeKey="second" unknownOnly={false} />,
    );
    expect(screen.getByText(/retained records 252–451 of 451/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    expect(screen.getByText(/retained records 52–251 of 451/)).toBeInTheDocument();
  });

  it("renders projected turns and explicit empty history copy", () => {
    const { rerender } = render(
      <CodexActivityHistoryInspector
        events={[event(1, "turn/started", { params: { turn: { id: "U1" } } })]}
        renderTurns
      />,
    );
    expect(screen.getByText(/Turn running/i)).toBeInTheDocument();

    rerender(<CodexActivityHistoryInspector events={[]} emptyMessage="No retained activity." />);
    expect(screen.getByText("No retained activity.")).toBeInTheDocument();
  });
});
