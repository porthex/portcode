import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ToolCall } from "./ToolCall";
import type { ContentBlock } from "../types";

// ToolCall is a pure props-driven block: it renders a collapsible tool
// call header plus, when expanded, the JSON input and an optional result.
// The result is rendered either as a plain <pre> or, when the output looks
// like a unified diff, through the DiffView line classifier. These tests
// drive every branch of summarize / StatusDot / looksLikeDiff / DiffView
// directly through the public component — no store or IPC is involved.

type ResultBlock = Extract<ContentBlock, { kind: "tool_result" }>;

const result = (over: Partial<ResultBlock> = {}): ResultBlock => ({
  kind: "tool_result",
  toolUseId: "t1",
  output: "ok",
  isError: false,
  ...over,
});

// The single status dot is the .pc-dot span at the start of the header button.
const dot = (container: HTMLElement): HTMLElement => {
  const el = container.querySelector("button .pc-dot");
  if (!el) throw new Error("status dot not found");
  return el as HTMLElement;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("summarize (header summary)", () => {
  it("prefers an input.path", () => {
    render(<ToolCall name="fs_read" input={{ path: "src/main.ts" }} />);
    expect(screen.getByText("src/main.ts")).toBeInTheDocument();
  });

  it("falls back to input.command when there is no path", () => {
    render(<ToolCall name="shell" input={{ command: "ls -la" }} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
  });

  it("falls back to input.pattern when there is no path or command", () => {
    render(<ToolCall name="grep" input={{ pattern: "TODO" }} />);
    expect(screen.getByText("TODO")).toBeInTheDocument();
  });

  it("uses the tool name when input is an object without summarizable keys", () => {
    render(<ToolCall name="custom_tool" input={{ other: 1 }} />);
    // name appears twice: the mono accent label and the summary span.
    expect(screen.getAllByText("custom_tool")).toHaveLength(2);
  });

  it("uses the tool name when input is not an object", () => {
    render(<ToolCall name="noop" input={null} />);
    expect(screen.getAllByText("noop")).toHaveLength(2);
  });

  it("ignores non-string path/command/pattern values and uses the name", () => {
    render(<ToolCall name="weird" input={{ path: 42, command: true, pattern: [] }} />);
    expect(screen.getAllByText("weird")).toHaveLength(2);
  });
});

describe("StatusDot", () => {
  it("is the warn variant (amber, pulsing) while pending (no result)", () => {
    const { container } = render(<ToolCall name="t" input={{}} />);
    const d = dot(container);
    // The warn modifier carries the amber color + pulse animation in CSS.
    expect(d.className).toContain("pc-dot--warn");
    expect(d.className).not.toContain("pc-dot--success");
  });

  it("is the success variant (green, not pulsing) for a successful result", () => {
    const { container } = render(
      <ToolCall name="t" input={{}} result={result({ isError: false })} />,
    );
    const d = dot(container);
    expect(d.className).toContain("pc-dot--success");
    expect(d.className).not.toContain("pc-dot--warn");
  });

  it("is red for an error result", () => {
    const { container } = render(
      <ToolCall name="t" input={{}} result={result({ isError: true })} />,
    );
    const d = dot(container);
    expect(d.className).toContain("bg-danger");
    // The error dot is neither the warn nor success status variant.
    expect(d.className).not.toContain("pc-dot--warn");
    expect(d.className).not.toContain("pc-dot--success");
  });
});

describe("collapse / expand toggle", () => {
  it("hides the body and shows the ▸ caret when collapsed", () => {
    render(<ToolCall name="t" input={{ path: "a.ts" }} result={result()} />);
    expect(screen.getByText("▸")).toBeInTheDocument();
    expect(screen.queryByText("Input")).not.toBeInTheDocument();
  });

  it("reveals the JSON input and ▾ caret when expanded, and hides again on a second click", () => {
    render(<ToolCall name="t" input={{ path: "a.ts" }} result={result()} />);
    const toggle = screen.getByRole("button");

    fireEvent.click(toggle);
    expect(screen.getByText("▾")).toBeInTheDocument();
    expect(screen.getByText("Input")).toBeInTheDocument();
    // input serialized as pretty JSON
    expect(screen.getByText(/"path": "a\.ts"/)).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByText("▸")).toBeInTheDocument();
    expect(screen.queryByText("Input")).not.toBeInTheDocument();
  });

  it("exposes aria-expanded/aria-label that flip false→true for screen readers", () => {
    render(<ToolCall name="t" input={{ path: "a.ts" }} result={result()} />);
    const toggle = screen.getByRole("button");

    // Collapsed: button advertises a closed region and an "expand" action.
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-label", "Expand tool output");

    fireEvent.click(toggle);

    // Expanded: aria-expanded flips and the label describes the collapse action.
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-label", "Collapse tool output");
  });
});

describe("result block rendering", () => {
  it("shows no result section while pending", () => {
    render(<ToolCall name="t" input={{}} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.queryByText("Result")).not.toBeInTheDocument();
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
  });

  it("labels a successful plain result 'Result' and shows its output", () => {
    render(<ToolCall name="t" input={{}} result={result({ output: "all good" })} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getByText("all good")).toBeInTheDocument();
  });

  it("labels an error result 'Error', styles it danger, and never uses DiffView", () => {
    // Output LOOKS like a diff, but isError must force the plain <pre> path.
    const diffOutput = "@@ -1 +1 @@\n-old\n+new";
    const { container } = render(
      <ToolCall name="t" input={{}} result={result({ isError: true, output: diffOutput })} />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.queryByText("Result")).not.toBeInTheDocument();

    // The error renders in a single <pre> with the danger text color, not
    // split into per-line <div>s the way DiffView would.
    const pre = container.querySelector("pre.text-danger");
    expect(pre).not.toBeNull();
    expect(pre).toHaveTextContent("@@ -1 +1 @@");
    expect(pre).toHaveTextContent("-old");
    expect(pre).toHaveTextContent("+new");
  });
});

describe("looksLikeDiff / DiffView", () => {
  // A diff that exercises every classification branch:
  //   "+++ " and "--- " file headers (.pc-diff-file)
  //   "@@ "  hunk header (.pc-diff-hunk)
  //   " ctx" context line (.pc-diff-ctx)
  //   ""     blank line (rendered as a single space, .pc-diff-ctx)
  //   "+add" added line (.pc-diff-add)
  //   "-rem" removed line (.pc-diff-del)
  const fullDiff = [
    "--- a/x",
    "+++ b/x",
    "@@ -1,3 +1,3 @@",
    " context",
    "",
    "+added",
    "-removed",
  ].join("\n");

  const diffContainer = (output: string): HTMLElement => {
    const { container } = render(
      <ToolCall name="edit" input={{ path: "x" }} result={result({ output })} />,
    );
    fireEvent.click(screen.getByRole("button"));
    return container;
  };

  // Find the per-line diff <div> whose text content equals the given line.
  // DiffView renders each line as a `.pc-diff-line` inside the `.pc-diff` box.
  const lineDiv = (container: HTMLElement, text: string): HTMLElement => {
    const divs = Array.from(container.querySelectorAll(".pc-diff .pc-diff-line"));
    const match = divs.find((d) => d.textContent === text);
    if (!match) throw new Error(`diff line not found: ${JSON.stringify(text)}`);
    return match as HTMLElement;
  };

  it("detects a diff via an @@ hunk header and renders per-line divs", () => {
    const container = diffContainer("@@ -1 +1 @@\n context");
    // DiffView emits a .pc-diff container with a .pc-diff-line per line
    // rather than a single <pre> text node.
    expect(container.querySelector(".pc-diff")).not.toBeNull();
    expect(container.querySelectorAll(".pc-diff .pc-diff-line").length).toBeGreaterThan(0);
  });

  it("also detects a diff that only has a +++ header", () => {
    const container = diffContainer("+++ b/file\nplain body");
    const header = lineDiv(container, "+++ b/file");
    expect(header.className).toContain("pc-diff-file");
  });

  it("classifies @@ hunk headers as the hunk class", () => {
    const container = diffContainer(fullDiff);
    expect(lineDiv(container, "@@ -1,3 +1,3 @@").className).toContain("pc-diff-hunk");
  });

  it("classifies +++ and --- file headers as file headers (not as add/remove)", () => {
    const container = diffContainer(fullDiff);
    const plus = lineDiv(container, "+++ b/x");
    const minus = lineDiv(container, "--- a/x");
    expect(plus.className).toContain("pc-diff-file");
    expect(plus.className).not.toContain("pc-diff-add");
    expect(minus.className).toContain("pc-diff-file");
    expect(minus.className).not.toContain("pc-diff-del");
  });

  it("classifies added lines as add and removed lines as del", () => {
    const container = diffContainer(fullDiff);
    const added = lineDiv(container, "+added");
    const removed = lineDiv(container, "-removed");
    expect(added.className).toContain("pc-diff-add");
    expect(removed.className).toContain("pc-diff-del");
  });

  it("classifies context lines as the context class", () => {
    const container = diffContainer(fullDiff);
    const ctx = lineDiv(container, " context");
    expect(ctx.className).toContain("pc-diff-ctx");
    expect(ctx.className).not.toContain("pc-diff-add");
    expect(ctx.className).not.toContain("pc-diff-del");
  });

  it("renders a blank diff line as a single space placeholder", () => {
    const container = diffContainer(fullDiff);
    // The empty line collapses to " " (line || " ") and stays a context line.
    const blank = lineDiv(container, " ");
    expect(blank.className).toContain("pc-diff-ctx");
  });

  it("does NOT use DiffView for ordinary output (plain <pre>, no diff container)", () => {
    const container = diffContainer("just a normal\nmulti-line result");
    expect(container.querySelector(".pc-diff")).toBeNull();
    expect(container.querySelectorAll(".pc-diff-line").length).toBe(0);
    expect(screen.getByText(/just a normal/)).toBeInTheDocument();
  });

  it("keeps the diff render and +/- counts stable across open/collapse toggles", () => {
    // The diff scan (looksLikeDiff) and count tally (diffCounts) are memoized on
    // [output, error], so toggling the body open and closed must not change the
    // detected diff structure or the header counts.
    const { container } = render(
      <ToolCall name="edit" input={{ path: "x" }} result={result({ output: fullDiff })} />,
    );
    const toggle = screen.getByRole("button");

    // Header counts are derived from the memoized scan even while collapsed:
    // fullDiff has one "+added" / one "-removed" (file headers excluded).
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("-1")).toBeInTheDocument();

    fireEvent.click(toggle); // open
    const openHtml = (container.querySelector(".pc-diff") as HTMLElement).innerHTML;
    const openLineCount = container.querySelectorAll(".pc-diff .pc-diff-line").length;

    fireEvent.click(toggle); // collapse — body unmounts, counts must persist
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("-1")).toBeInTheDocument();

    fireEvent.click(toggle); // re-open — identical diff render, no re-scan drift
    const reopenHtml = (container.querySelector(".pc-diff") as HTMLElement).innerHTML;
    const reopenLineCount = container.querySelectorAll(".pc-diff .pc-diff-line").length;

    expect(reopenHtml).toBe(openHtml);
    expect(reopenLineCount).toBe(openLineCount);
  });
});
