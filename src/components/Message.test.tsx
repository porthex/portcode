import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { MessageView } from "./Message";
import { markdownLiteralText } from "../lib/sessionFormat";
import { STEP_MS } from "../lib/useScramble";
import { useStore } from "../store/store";
import type { ContentBlock, Message, Role, TurnReceipt as TurnReceiptData } from "../types";

// MessageView is a pure, props-driven presentational component: it folds a
// Message's content blocks into rendered output (markdown for text, a ToolCall
// for tool_use, nothing for a standalone tool_result) and shows a "thinking"
// indicator for an empty assistant turn. It reaches no store or IPC, so these
// tests construct Message props directly and assert the rendered DOM. ToolCall
// is intentionally NOT mocked — we let it render so the delegation is exercised,
// and react-markdown renders for real in jsdom.

const message = (role: Role, blocks: ContentBlock[]): Message => ({
  id: "m1",
  role,
  blocks,
  createdAt: 1,
});

const receipt = (over: Partial<TurnReceiptData> = {}): TurnReceiptData => ({
  turnId: "turn-1",
  status: "completed",
  startedAt: 1_000,
  completedAt: 5_200,
  durationMs: 4_200,
  changedFiles: [],
  changedFileCount: 0,
  additions: 0,
  deletions: 0,
  filesTruncated: false,
  changeCertainty: "exact",
  backgroundTasksRunning: false,
  ...over,
});

describe("MessageView — user role", () => {
  it("renders a user message as a right-aligned bubble showing the joined text", () => {
    const { container } = render(
      <MessageView message={message("user", [{ kind: "text", text: "Hello there" }])} />,
    );

    expect(screen.getByText("Hello there")).toBeInTheDocument();
    // user branch: outer row is right-justified and no assistant Avatar svg.
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain("justify-end");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("keeps GFM formatting rendered after the user message is sent", () => {
    const source = [
      "- first bullet",
      "- second bullet",
      "",
      "1. first step",
      "2. second step",
      "",
      "- [ ] pending task",
      "- [x] completed task",
      "",
      "**important** and `inline code`",
      "",
      "> quoted note",
    ].join("\n");
    const { container } = render(
      <MessageView message={message("user", [{ kind: "text", text: source }])} />,
    );

    const bubble = container.querySelector(".pc-bubble-user");
    expect(bubble?.querySelector(".prose-pc--user")).not.toBeNull();
    expect(bubble?.querySelector("ul:not(.contains-task-list)")).not.toBeNull();
    expect(bubble?.querySelector("ol")).not.toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(6);

    const tasks = screen.getAllByRole("checkbox");
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toBeDisabled();
    expect(tasks[0]).not.toBeChecked();
    expect(tasks[1]).toBeDisabled();
    expect(tasks[1]).toBeChecked();

    expect(bubble?.querySelector("strong")?.textContent).toBe("important");
    expect(bubble?.querySelector("code")?.textContent).toBe("inline code");
    expect(bubble?.querySelector("blockquote")?.textContent).toContain("quoted note");
    expect(bubble?.textContent).not.toContain("- [x]");
  });

  it("renders nested mixed lists and tasks semantically in a sent user message", () => {
    const source = [
      "- parent",
      "    1. first child",
      "    2. second child",
      "        - [x] nested task",
    ].join("\n");
    const { container } = render(
      <MessageView message={message("user", [{ kind: "text", text: source }])} />,
    );

    const bubble = container.querySelector(".pc-bubble-user");
    const topList = bubble?.querySelector(":scope .prose-pc--user > ul");
    const nestedOrdered = topList?.querySelector(":scope > li > ol");
    const nestedTasks = nestedOrdered?.querySelector("ul.contains-task-list");
    expect(topList).not.toBeNull();
    expect(nestedOrdered).not.toBeNull();
    expect(nestedTasks).not.toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(bubble?.textContent).not.toContain("- [x]");
  });

  it("keeps raw HTML inert in sent user Markdown", () => {
    const { container } = render(
      <MessageView
        message={message("user", [
          { kind: "text", text: "<script>alert('nope')</script>\n\n**safe**" },
        ])}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert('nope')</script>");
    expect(container.querySelector("strong")?.textContent).toBe("safe");
  });

  it("preserves an intentional single line break in user prose", () => {
    const { container } = render(
      <MessageView
        message={message("user", [{ kind: "text", text: "first line\nsecond line" }])}
      />,
    );

    const paragraph = container.querySelector(".prose-pc--user p");
    expect(paragraph?.textContent).toBe("first line\nsecond line");
  });

  it("joins only the text blocks and ignores non-text blocks in the user bubble", () => {
    // Mixing a non-text block forces textOf's false ternary arm (returns "").
    const { container } = render(
      <MessageView
        message={message("user", [
          { kind: "text", text: "abc" },
          { kind: "tool_result", toolUseId: "t1", output: "ignored", isError: false },
          { kind: "text", text: "def" },
        ])}
      />,
    );

    const bubble = screen.getByText("abcdef");
    expect(bubble).toBeInTheDocument();
    expect(bubble.textContent).toBe("abcdef");
    // The user branch never delegates to ToolCall, so no tool output leaks.
    expect(screen.queryByText("ignored")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders an empty user bubble when there is no text", () => {
    const { container } = render(<MessageView message={message("user", [])} />);

    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain("justify-end");
    // The bubble exists but carries no text content.
    const bubble = row.querySelector(".pc-bubble-user") as HTMLElement;
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toBe("");
  });

  it("wraps a long unbroken string in the user bubble (break-words)", () => {
    // A pasted long URL/path/spaceless key must wrap inside the 82% wrapper
    // instead of overflowing it — the bubble carries break-words like the
    // assistant streaming path.
    const url = "https://example.com/" + "a".repeat(200);
    const { container } = render(
      <MessageView message={message("user", [{ kind: "text", text: url }])} />,
    );

    const bubble = container.querySelector(".pc-bubble-user") as HTMLElement;
    expect(bubble).not.toBeNull();
    expect(bubble.className).toContain("break-words");
    expect(bubble.textContent).toBe(url);
  });
});

describe("MessageView — assistant role", () => {
  it("renders an Avatar and is not right-aligned", () => {
    const { container } = render(
      <MessageView message={message("assistant", [{ kind: "text", text: "hi" }])} />,
    );

    const row = container.firstElementChild as HTMLElement;
    expect(row.className).not.toContain("justify-end");
    // Avatar draws an inline svg only on the assistant branch.
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders a text block through react-markdown", () => {
    const { container } = render(
      <MessageView
        message={message("assistant", [{ kind: "text", text: "**bold** and plain" }])}
      />,
    );

    // react-markdown wraps prose in a <p> and turns ** ** into <strong>.
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(container.querySelector("strong")).not.toBeNull();
    expect(container.querySelector(".prose-pc")).not.toBeNull();
  });

  it("renders escaped account attribution literally without links, images, or HTML", () => {
    const label =
      "one@chatgpt.test ``` ![root [nested]](https://evil.test/pixel) <img src=x> &lbrack;text&rbrack;";
    const { container } = render(
      <MessageView
        message={message("assistant", [
          {
            kind: "text",
            text: `**Error:** ${markdownLiteralText(label)}: ChatGPT provider request failed.`,
          },
        ])}
      />,
    );

    const prose = container.querySelector(".prose-pc");
    expect(prose?.textContent).toContain(label);
    expect(prose?.querySelector("code")?.textContent).toBe(label);
    expect(prose?.querySelector("a")).toBeNull();
    expect(prose?.querySelector("img")).toBeNull();
    expect(prose?.querySelector("script, style, iframe, object, embed")).toBeNull();
  });

  it("renders a settled long unbroken token inside a .prose-pc <p> so it wraps at full width", () => {
    // The wrapping itself is delivered by the `.prose-pc p` stylesheet rule
    // (overflow-wrap/word-break), which jsdom does not lay out — so assert the
    // structural contract the rule targets: the long token lands in a <p> within
    // .prose-pc (not in a <pre>, which keeps horizontal scroll).
    const longPath = "C:\\dev\\porthex\\" + "segment".repeat(40) + "\\file.ts";
    const { container } = render(
      <MessageView message={message("assistant", [{ kind: "text", text: longPath }])} />,
    );

    const prose = container.querySelector(".prose-pc");
    expect(prose).not.toBeNull();
    const p = prose!.querySelector("p");
    expect(p).not.toBeNull();
    expect(p!.textContent).toBe(longPath);
    // The token must not be wrapped in a <pre> (those keep overflow-x: auto).
    expect(prose!.querySelector("pre")).toBeNull();
  });

  it("eases assistant rows in with pc-msg-enter while user rows do not animate", () => {
    const { container: asst } = render(
      <MessageView message={message("assistant", [{ kind: "text", text: "hi" }])} />,
    );
    const asstRow = asst.firstElementChild as HTMLElement;
    expect(asstRow.className).toContain("pc-msg-enter");

    const { container: usr } = render(
      <MessageView message={message("user", [{ kind: "text", text: "hi" }])} />,
    );
    const usrRow = usr.firstElementChild as HTMLElement;
    expect(usrRow.className).not.toContain("pc-msg-enter");
  });

  it("renders a successful read as compact activity with raw details on demand", () => {
    render(
      <MessageView
        message={message("assistant", [
          { kind: "tool_use", id: "t1", name: "fs_read", input: { path: "src/app.ts" } },
          { kind: "tool_result", toolUseId: "t1", output: "file contents", isError: false },
        ])}
      />,
    );

    // Routine implementation details stay quiet by default.
    expect(screen.getByText("Read file")).toBeInTheDocument();
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.queryByText("fs_read")).not.toBeInTheDocument();
    expect(screen.queryByText("file contents")).not.toBeInTheDocument();

    // First reveal operations, then reveal this operation's technical ID + result.
    const activityToggle = screen.getByRole("button", { name: /read file.*expand details/i });
    fireEvent.click(activityToggle);
    expect(screen.getByText("Raw activity")).toBeInTheDocument();
    expect(screen.queryByText("fs_read")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /read file.*expand output/i }));
    expect(screen.getByText("fs_read")).toBeInTheDocument();
    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getByText("file contents")).toBeInTheDocument();

    fireEvent.click(activityToggle);
    expect(screen.queryByText("fs_read")).not.toBeInTheDocument();
    expect(screen.queryByText("file contents")).not.toBeInTheDocument();
  });

  it("passes an error tool_result through so ToolCall renders the error branch", () => {
    render(
      <MessageView
        message={message("assistant", [
          { kind: "tool_use", id: "t2", name: "shell", input: { command: "ls" } },
          { kind: "tool_result", toolUseId: "t2", output: "boom failed", isError: true },
        ])}
      />,
    );

    expect(screen.getByText("Run command")).toBeInTheDocument();
    expect(screen.queryByText("shell")).not.toBeInTheDocument();
    expect(screen.getByText("ls")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));
    // isError === true switches the label to "Error" and shows the output.
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("boom failed")).toBeInTheDocument();
  });

  it("leaves a tool_use pending (result=undefined) when no matching tool_result exists", () => {
    render(
      <MessageView
        message={message("assistant", [
          { kind: "tool_use", id: "t3", name: "fs_write", input: { path: "out.txt" } },
          // a tool_result for a DIFFERENT id must not match.
          { kind: "tool_result", toolUseId: "other", output: "nope", isError: false },
        ])}
      />,
    );

    expect(screen.getByText("Write file")).toBeInTheDocument();
    expect(screen.queryByText("fs_write")).not.toBeInTheDocument();

    // Expanding shows the input but no Result/Error section (result is undefined).
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.queryByText("Result")).toBeNull();
    expect(screen.queryByText("Error")).toBeNull();
    expect(screen.queryByText("nope")).toBeNull();
  });

  it("renders a standalone tool_result as nothing (no ToolCall, no output)", () => {
    const { container } = render(
      <MessageView
        message={message("assistant", [
          { kind: "tool_result", toolUseId: "t4", output: "orphan output", isError: false },
        ])}
      />,
    );

    // tool_result with no preceding tool_use returns null from the map.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("orphan output")).toBeNull();
    // Avatar still renders (assistant branch), so exactly the avatar svg is present.
    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });

  it("shows the thinking indicator when the assistant turn has no blocks", () => {
    const { container } = render(<MessageView message={message("assistant", [])} />);

    // Thinking() renders three bouncing dots and no tool button.
    expect(screen.queryByRole("button")).toBeNull();
    const dots = container.querySelectorAll(".animate-bounce");
    expect(dots).toHaveLength(3);

    // The indicator carries a visually-hidden "Agent is thinking" label that the
    // outer transcript log region announces when this row is inserted; it is NOT
    // its own live region (no nested role="status"/aria-live inside role="log"),
    // while the decorative dots are hidden from the accessibility tree.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Agent is thinking")).toBeInTheDocument();
    dots.forEach((dot) => expect(dot).toHaveAttribute("aria-hidden", "true"));
    // The geometric bounce stops under prefers-reduced-motion (ON on the dev OS).
    dots.forEach((dot) => expect(dot.className).toContain("motion-reduce:animate-none"));
  });

  it("renders multiple text blocks and a tool pair together", () => {
    render(
      <MessageView
        message={message("assistant", [
          { kind: "text", text: "first paragraph" },
          { kind: "tool_use", id: "t5", name: "grep", input: { pattern: "TODO" } },
          { kind: "tool_result", toolUseId: "t5", output: "match", isError: false },
          { kind: "text", text: "second paragraph" },
        ])}
      />,
    );

    expect(screen.getByText("first paragraph")).toBeInTheDocument();
    expect(screen.getByText("second paragraph")).toBeInTheDocument();
    // Routine search activity is humanized; the raw tool name stays hidden.
    expect(screen.getByText("Searched project")).toBeInTheDocument();
    expect(screen.queryByText("grep")).not.toBeInTheDocument();
    expect(screen.getByText("TODO")).toBeInTheDocument();
  });

  it("groups consecutive read/search/list operations into one exploration row", () => {
    render(
      <MessageView
        message={message("assistant", [
          { kind: "tool_use", id: "r1", name: "read_file", input: { path: "a.ts" } },
          { kind: "tool_result", toolUseId: "r1", output: "a", isError: false },
          { kind: "tool_use", id: "r2", name: "search_text", input: { pattern: "TODO" } },
          { kind: "tool_result", toolUseId: "r2", output: "match", isError: false },
          { kind: "tool_use", id: "r3", name: "list_directory", input: { path: "src" } },
          { kind: "tool_result", toolUseId: "r3", output: "files", isError: false },
        ])}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText("Explored project")).toBeInTheDocument();
    expect(screen.getByText("1 file read · 1 search · 1 folder listed")).toBeInTheDocument();
    expect(screen.queryByText("read_file")).not.toBeInTheDocument();
    expect(screen.queryByText("search_text")).not.toBeInTheDocument();
    expect(screen.queryByText("list_directory")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /explored project.*expand details/i }));
    expect(screen.getByText("3 operations")).toBeInTheDocument();
    expect(screen.getByText("Read file")).toBeInTheDocument();
    expect(screen.getByText("Search project")).toBeInTheDocument();
    expect(screen.getByText("Browse folder")).toBeInTheDocument();
    // Raw result payloads are still lazy until their individual card is opened.
    expect(screen.queryByText("match")).not.toBeInTheDocument();
  });

  it("keeps a grouped activity in the present tense until the assistant turn settles", () => {
    const activityMessage = message("assistant", [
      { kind: "tool_use", id: "r1", name: "read_file", input: { path: "a.ts" } },
      { kind: "tool_result", toolUseId: "r1", output: "a", isError: false },
      { kind: "tool_use", id: "r2", name: "search_text", input: { pattern: "TODO" } },
      { kind: "tool_result", toolUseId: "r2", output: "match", isError: false },
    ]);
    const { rerender } = render(<MessageView message={activityMessage} isActive />);

    const runningToggle = screen.getByRole("button", {
      name: /exploring project.*1 file read.*1 search.*running.*expand details/i,
    });
    expect(runningToggle.closest(".pc-toolcall")).toHaveClass("pc-toolcall--active");
    expect(screen.queryByText("Explored project")).not.toBeInTheDocument();

    fireEvent.click(runningToggle);
    expect(screen.getByText("2 operations")).toBeInTheDocument();
    expect(screen.getByText("Read file")).toBeInTheDocument();
    expect(screen.getByText("Search project")).toBeInTheDocument();

    rerender(<MessageView message={activityMessage} />);

    const completedToggle = screen.getByRole("button", {
      name: /explored project.*1 file read.*1 search.*completed.*collapse details/i,
    });
    expect(completedToggle.closest(".pc-toolcall")).not.toHaveClass("pc-toolcall--active");
    expect(screen.queryByText("Exploring project")).not.toBeInTheDocument();
    expect(screen.getByText("2 operations")).toBeInTheDocument();
  });

  it("keeps a completed single read in the present tense while its assistant turn is active", () => {
    const readMessage = message("assistant", [
      { kind: "tool_use", id: "read", name: "read_file", input: { path: "src/app.ts" } },
      { kind: "tool_result", toolUseId: "read", output: "contents", isError: false },
    ]);
    const { rerender } = render(<MessageView message={readMessage} isActive />);

    expect(
      screen.getByRole("button", {
        name: /reading file.*src\/app\.ts.*running.*expand details/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Read file")).not.toBeInTheDocument();

    rerender(<MessageView message={readMessage} />);

    expect(
      screen.getByRole("button", {
        name: /read file.*src\/app\.ts.*completed.*expand details/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Reading file")).not.toBeInTheDocument();
  });

  it.each([
    ["list_directory", { path: "src" }, "Browsing folder", "Browsed folder"],
    ["glob", { pattern: "**/*.tsx" }, "Finding files", "Found files"],
    ["search_text", { pattern: "TODO" }, "Searching project", "Searched project"],
  ])("switches %s activity from present to settled wording", (name, input, active, settled) => {
    const activityMessage = message("assistant", [
      { kind: "tool_use", id: name, name, input },
      { kind: "tool_result", toolUseId: name, output: "done", isError: false },
    ]);
    const { rerender } = render(<MessageView message={activityMessage} isActive />);

    expect(screen.getByText(active)).toBeInTheDocument();
    expect(screen.queryByText(settled)).not.toBeInTheDocument();

    rerender(<MessageView message={activityMessage} />);

    expect(screen.getByText(settled)).toBeInTheDocument();
    expect(screen.queryByText(active)).not.toBeInTheDocument();
  });

  it("keeps failed reads and mutating tools individually visible", () => {
    render(
      <MessageView
        message={message("assistant", [
          { kind: "tool_use", id: "bad", name: "read_file", input: { path: "missing.ts" } },
          { kind: "tool_result", toolUseId: "bad", output: "not found", isError: true },
          { kind: "tool_use", id: "edit", name: "edit_file", input: { path: "a.ts" } },
          { kind: "tool_result", toolUseId: "edit", output: "done", isError: false },
          { kind: "tool_use", id: "ok", name: "find_files", input: { pattern: "**/*.ts" } },
          { kind: "tool_result", toolUseId: "ok", output: "a.ts", isError: false },
        ])}
      />,
    );

    expect(screen.getByText("Read file")).toBeInTheDocument();
    expect(screen.getByText("Edit file")).toBeInTheDocument();
    expect(screen.getByText("Found files")).toBeInTheDocument();
    expect(screen.queryByText("find_files")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /read file.*failed.*expand output/i }));
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("not found")).toBeInTheDocument();
  });

  it("announces a pending exploration group as running", () => {
    render(
      <MessageView
        message={message("assistant", [
          { kind: "tool_use", id: "pending", name: "grep", input: { pattern: "needle" } },
        ])}
        isActive
      />,
    );

    const toggle = screen.getByRole("button", { name: /searching project/i });
    expect(toggle).toHaveAccessibleName(/running, expand details/i);
    expect(toggle.closest(".pc-toolcall")).toHaveClass("pc-toolcall--active");
  });

  it("treats an unmatched historical tool as interrupted after reload", () => {
    render(
      <MessageView
        message={message("assistant", [
          { kind: "tool_use", id: "orphaned", name: "fs_read", input: { path: "old.log" } },
        ])}
      />,
    );

    const toggle = screen.getByRole("button", { name: /read file.*interrupted.*expand output/i });
    expect(toggle).not.toHaveAccessibleName(/running/);
    fireEvent.click(toggle);
    expect(
      screen.getByText(/historical tool did not record a terminal result/i),
    ).toBeInTheDocument();
  });

  it("humanizes a targetless folder listing without exposing the raw tool name", () => {
    render(
      <MessageView
        message={message("assistant", [
          { kind: "tool_use", id: "listing", name: "list", input: null },
          { kind: "tool_result", toolUseId: "listing", output: "a.ts", isError: false },
        ])}
      />,
    );

    expect(screen.getByText("Browsed folder")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.queryByText("list")).not.toBeInTheDocument();
  });

  it("lets settled offscreen rows use browser content visibility without applying it to active output", () => {
    const settled = render(
      <MessageView message={message("assistant", [{ kind: "text", text: "settled" }])} />,
    );
    expect(settled.container.firstElementChild).toHaveStyle({
      contentVisibility: "auto",
      containIntrinsicSize: "auto 140px",
    });

    const active = render(
      <MessageView
        message={{ ...message("assistant", [{ kind: "text", text: "active" }]), id: "m2" }}
        isActive
      />,
    );
    expect(active.container.firstElementChild).not.toHaveStyle({ contentVisibility: "auto" });
  });
});

describe("MessageView — turn receipt presentation", () => {
  it("replaces the empty-turn thinking dots with the fixed live lifecycle strip", () => {
    const { container, rerender } = render(
      <MessageView
        message={{ ...message("assistant", []), turnId: "turn-1" }}
        isActive
        turnPresentation={{ active: true, startedAt: null, waiting: false, finalizing: false }}
      />,
    );

    const strip = container.querySelector(".pc-turn-receipt__strip");
    expect(strip).toHaveTextContent("Starting");
    expect(screen.queryByText("Agent is thinking")).toBeNull();

    rerender(
      <MessageView
        message={{ ...message("assistant", []), turnId: "turn-1" }}
        isActive
        turnPresentation={{ active: true, startedAt: 1_000, waiting: true, finalizing: false }}
      />,
    );
    expect(strip).toHaveTextContent("Waiting for approval");

    rerender(
      <MessageView
        message={{ ...message("assistant", []), turnId: "turn-1" }}
        isActive
        turnPresentation={{ active: false, startedAt: 1_000, waiting: false, finalizing: true }}
      />,
    );
    expect(strip).toHaveTextContent("Finalizing");
  });

  it("keeps observable activity in the manual disclosure and the Markdown summary visible", () => {
    const turnMessage: Message = {
      ...message("assistant", [
        { kind: "tool_use", id: "read-1", name: "fs_read", input: { path: "src/App.tsx" } },
        { kind: "tool_result", toolUseId: "read-1", output: "contents", isError: false },
        { kind: "text", text: "## Result\n\nThe review is ready." },
      ]),
      turnId: "turn-1",
      receipt: receipt(),
    };
    const { container } = render(<MessageView message={turnMessage} />);

    expect(screen.getByRole("heading", { level: 2, name: "Result" })).toBeInTheDocument();
    const details = container.querySelector(".pc-turn-receipt__details-grid");
    expect(details).toHaveAttribute("aria-hidden", "true");
    expect(details).toHaveAttribute("inert");

    fireEvent.click(screen.getByRole("button", { name: /expand work activity/i }));
    expect(details).toHaveAttribute("aria-hidden", "false");
    expect(details).not.toHaveAttribute("inert");
    expect(screen.getByText("Read file")).toBeInTheDocument();
  });

  it("shows subagent activity as observable work without exposing a reasoning surface", () => {
    const { container } = render(
      <MessageView
        message={{
          ...message("assistant", [{ kind: "text", text: "Delegation complete." }]),
          turnId: "turn-1",
        }}
        turnPresentation={{ active: true, startedAt: 1_000, waiting: false, finalizing: false }}
        agents={[
          {
            id: "agent-1",
            description: "Audit accessibility",
            status: "running",
            step: 2,
          },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: /expand work activity/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /expand work activity/i }));
    expect(screen.getByRole("region", { name: "Subagent activity" })).toBeInTheDocument();
    expect(screen.getByText("Audit accessibility")).toBeInTheDocument();
    expect(screen.queryByText(/reasoning/i)).not.toBeInTheDocument();
    expect(container.querySelector(".pc-turn-agents__status")).toHaveTextContent("step 2");
  });

  it("appends the compact change card after the assistant result and wires Review", () => {
    const onReview = vi.fn();
    const turnReceipt = receipt({
      changedFiles: [
        {
          path: "src/new-feature.ts",
          status: "modified",
          additions: 8,
          deletions: 3,
          binary: false,
          certainty: "exact",
        },
      ],
      changedFileCount: 1,
      additions: 8,
      deletions: 3,
    });
    const { container } = render(
      <MessageView
        message={{
          ...message("assistant", [{ kind: "text", text: "Implementation complete." }]),
          turnId: "turn-1",
          receipt: turnReceipt,
        }}
        onReviewChanges={onReview}
      />,
    );

    const strip = container.querySelector(".pc-turn-receipt") as HTMLElement;
    const summary = screen.getByText("Implementation complete.");
    const card = container.querySelector(".pc-turn-changes") as HTMLElement;
    expect(strip.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(summary.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Review 1 changed file" }));
    expect(onReview).toHaveBeenCalledWith(turnReceipt);
  });

  it("makes the Review seam explicitly desktop-only in remote mode", () => {
    render(
      <MessageView
        message={{
          ...message("assistant", [{ kind: "text", text: "Done." }]),
          receipt: receipt({
            changedFiles: [
              {
                path: "src/mobile.ts",
                status: "added",
                additions: 1,
                deletions: 0,
                binary: false,
                certainty: "observed",
              },
            ],
            changedFileCount: 1,
            additions: 1,
            changeCertainty: "observed",
          }),
        }}
        reviewAvailable={false}
      />,
    );

    expect(screen.getByText("Review on desktop")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review 1 changed file/i })).toBeNull();
  });
});

describe("MessageView — typing animation", () => {
  // Freeze requestAnimationFrame so the reveal never advances during the test:
  // assertions stay deterministic and no setState escapes React's act().
  let previousTypingAnimation = false;
  beforeEach(() => {
    const settings = useStore.getState().settings;
    previousTypingAnimation = settings.typingAnimation;
    useStore.setState({ settings: { ...settings, typingAnimation: true } });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    const settings = useStore.getState().settings;
    useStore.setState({ settings: { ...settings, typingAnimation: previousTypingAnimation } });
    vi.unstubAllGlobals();
  });

  it("formats structured Markdown immediately and keeps the streaming caret", () => {
    const source = [
      "## Project summary",
      "",
      "**Portcode** uses `Rust`.",
      "",
      "- Fast",
      "- Native",
    ].join("\n");
    const { container } = render(
      <MessageView message={message("assistant", [{ kind: "text", text: source }])} isActive />,
    );

    // Structured source bypasses the high-frequency decorative scramble so the
    // current provider delta can go through GFM immediately.
    expect(container.querySelector(".pc-caret")).not.toBeNull();
    expect(container.querySelector(".prose-pc")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Project summary" })).toBeInTheDocument();
    expect(container.querySelector("strong")?.textContent).toBe("Portcode");
    expect(container.querySelector("code")?.textContent).toBe("Rust");
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Fast",
      "Native",
    ]);
    expect(container.querySelector(".pc-caret")?.closest("li")).toBe(
      screen.getAllByRole("listitem")[1],
    );
    expect(container.querySelector(".pc-scramble")).toBeNull();
  });

  it("bypasses the scramble for single emphasis and incomplete structured chunks", () => {
    const { container, rerender } = render(
      <MessageView message={message("assistant", [{ kind: "text", text: "*italic*" }])} isActive />,
    );
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelector(".pc-scramble")).toBeNull();

    rerender(
      <MessageView
        message={message("assistant", [{ kind: "text", text: "**still writing" }])}
        isActive
      />,
    );
    expect(container.textContent).toContain("**still writing");
    expect(container.querySelector(".pc-scramble")).toBeNull();
    expect(container.querySelector(".pc-caret")).not.toBeNull();

    rerender(
      <MessageView
        message={message("assistant", [{ kind: "text", text: "**still writing**" }])}
        isActive
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("still writing");
    expect(container.querySelector(".pc-caret")).not.toBeNull();

    rerender(
      <MessageView
        message={message("assistant", [{ kind: "text", text: "```ts\nconst partial = true" }])}
        isActive
      />,
    );
    expect(container.querySelector("pre code")?.textContent).toContain("const partial = true");
    expect(container.querySelector("pre code .pc-caret")).not.toBeNull();
    expect(container.querySelector(".pc-scramble")).toBeNull();
  });

  it("switches a growing plain block to Markdown without duplicate text", () => {
    const { container, rerender } = render(
      <MessageView message={message("assistant", [{ kind: "text", text: "Hello " }])} isActive />,
    );
    expect(container.querySelector(".prose-pc")).toHaveAttribute("aria-hidden", "true");

    rerender(
      <MessageView
        message={message("assistant", [{ kind: "text", text: "Hello\n\n## Summary" }])}
        isActive
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Summary" })).toBeInTheDocument();
    expect(container.textContent?.match(/Hello/g)).toHaveLength(1);
    expect(container.querySelector(".pc-scramble")).toBeNull();
    expect(container.querySelector(".pc-caret")).not.toBeNull();
  });

  it("renders a finished (inactive) turn as markdown with no caret", () => {
    const { container } = render(
      <MessageView message={message("assistant", [{ kind: "text", text: "**bold** text" }])} />,
    );

    expect(container.querySelector(".pc-caret")).toBeNull();
    expect(container.querySelector("strong")).not.toBeNull();
  });

  it("formats active headings, emphasis, lists, and inline code when the decode is off", () => {
    // This is the default path: active source is parsed as GFM on each provider
    // delta, while expensive syntax highlighting waits for the row to settle.
    const prev = useStore.getState().settings;
    useStore.setState({ settings: { ...prev, typingAnimation: false } });
    try {
      const source = [
        "## Project summary",
        "",
        "**Portcode** uses `Rust`.",
        "",
        "- Fast",
        "- Native",
      ].join("\n");
      const { container } = render(
        <MessageView message={message("assistant", [{ kind: "text", text: source }])} isActive />,
      );

      const prose = container.querySelector(".prose-pc");
      expect(prose).not.toBeNull();
      expect(
        screen.getByRole("heading", { level: 2, name: "Project summary" }),
      ).toBeInTheDocument();
      expect(container.querySelector("strong")?.textContent).toBe("Portcode");
      expect(container.querySelector("code")?.textContent).toBe("Rust");
      expect(screen.getByRole("list")).toBeInTheDocument();
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
      expect(container.querySelector(".pc-caret")).toBeNull();
      expect(container.querySelector(".pc-scramble")).toBeNull();
    } finally {
      useStore.setState({ settings: prev });
    }
  });

  it("defers fenced-code highlighting until the active turn settles", () => {
    const prev = useStore.getState().settings;
    useStore.setState({ settings: { ...prev, typingAnimation: false } });
    try {
      const code = "```js\nconst answer = 42;\n```";
      const { container, rerender } = render(
        <MessageView message={message("assistant", [{ kind: "text", text: code }])} isActive />,
      );

      const activeCode = container.querySelector("pre code");
      expect(activeCode?.textContent).toContain("const answer = 42;");
      expect(activeCode).not.toHaveClass("hljs");

      rerender(<MessageView message={message("assistant", [{ kind: "text", text: code }])} />);
      expect(container.querySelector("pre code")).toHaveClass("hljs");
    } finally {
      useStore.setState({ settings: prev });
    }
  });

  it("keeps incomplete Markdown visible and safe while more deltas are pending", () => {
    const prev = useStore.getState().settings;
    useStore.setState({ settings: { ...prev, typingAnimation: false } });
    try {
      const { container, rerender } = render(
        <MessageView
          message={message("assistant", [{ kind: "text", text: "**still writing" }])}
          isActive
        />,
      );
      expect(container.textContent).toContain("**still writing");

      rerender(
        <MessageView
          message={message("assistant", [{ kind: "text", text: "[partial link](" }])}
          isActive
        />,
      );
      expect(container.textContent).toContain("[partial link](");

      rerender(
        <MessageView
          message={message("assistant", [{ kind: "text", text: "```ts\nconst partial = true" }])}
          isActive
        />,
      );
      expect(container.querySelector("pre code")?.textContent).toContain("const partial = true");
    } finally {
      useStore.setState({ settings: prev });
    }
  });

  it("keeps ReactMarkdown's link and raw-HTML safety during streaming", () => {
    const prev = useStore.getState().settings;
    useStore.setState({ settings: { ...prev, typingAnimation: false } });
    try {
      const { container } = render(
        <MessageView
          message={message("assistant", [
            {
              kind: "text",
              text: "[safe](https://example.com) [unsafe](javascript:alert(1)) <script>alert(2)</script>",
            },
          ])}
          isActive
        />,
      );

      expect(screen.getByRole("link", { name: "safe" })).toHaveAttribute(
        "href",
        "https://example.com",
      );
      expect(screen.getByText("unsafe").getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
      expect(container.querySelector("script")).toBeNull();
      expect(container.textContent).toContain("<script>alert(2)</script>");
      expect(container.querySelector("[aria-live], [role='status']")).toBeNull();
    } finally {
      useStore.setState({ settings: prev });
    }
  });
});

describe("MessageView — right-click context menu", () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies the user message text from the context menu", () => {
    const { container } = render(
      <MessageView message={message("user", [{ kind: "text", text: "Hello there" }])} />,
    );

    fireEvent.contextMenu(container.firstElementChild as HTMLElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy message text" }));

    expect(writeText).toHaveBeenCalledWith("Hello there");
  });

  it("copies the joined assistant text from the context menu", () => {
    const { container } = render(
      <MessageView
        message={message("assistant", [
          { kind: "text", text: "part one " },
          { kind: "tool_use", id: "t1", name: "fs_read", input: {} },
          { kind: "text", text: "part two" },
        ])}
      />,
    );

    fireEvent.contextMenu(container.firstElementChild as HTMLElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy message text" }));

    // Only the text blocks are joined (tool_use is skipped).
    expect(writeText).toHaveBeenCalledWith("part one part two");
  });

  it("excludes lifecycle and changed-file receipt chrome from copied message text", () => {
    const { container } = render(
      <MessageView
        message={{
          ...message("assistant", [{ kind: "text", text: "Only this summary is copied." }]),
          receipt: receipt({
            changedFiles: [
              {
                path: "src/private-receipt-path.ts",
                status: "modified",
                additions: 4,
                deletions: 1,
                binary: false,
                certainty: "exact",
              },
            ],
            changedFileCount: 1,
            additions: 4,
            deletions: 1,
          }),
        }}
      />,
    );

    fireEvent.contextMenu(container.firstElementChild as HTMLElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy message text" }));

    expect(writeText).toHaveBeenCalledWith("Only this summary is copied.");
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("Worked for"));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("private-receipt-path"));
  });

  it("does not open the custom menu when text in that message is selected", () => {
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ intersectsNode: () => true }) as unknown as Range,
    } as unknown as Selection);
    const { container } = render(
      <MessageView message={message("user", [{ kind: "text", text: "Hello there" }])} />,
    );

    fireEvent.contextMenu(container.firstElementChild as HTMLElement);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the custom menu when the active selection is outside that message", () => {
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ intersectsNode: () => false }) as unknown as Range,
    } as unknown as Selection);
    const { container } = render(
      <MessageView message={message("user", [{ kind: "text", text: "Hello there" }])} />,
    );

    fireEvent.contextMenu(container.firstElementChild as HTMLElement);

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("opens the custom menu when there is no active selection", () => {
    vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: true } as Selection);
    const { container } = render(
      <MessageView message={message("user", [{ kind: "text", text: "Hello there" }])} />,
    );

    fireEvent.contextMenu(container.firstElementChild as HTMLElement);

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("disables Copy message text when the message has no text", () => {
    const { container } = render(
      <MessageView
        message={message("assistant", [{ kind: "tool_use", id: "t1", name: "shell", input: {} }])}
      />,
    );

    fireEvent.contextMenu(container.firstElementChild as HTMLElement);
    const item = screen.getByRole("menuitem", { name: "Copy message text" });
    expect(item).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(item);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("MessageView — scramble decode (active turn)", () => {
  // useScramble runs off requestAnimationFrame; drive it with a manual queue so
  // the decode advances by exact frames. One callback is scheduled per tick.
  let rafQueue: FrameRequestCallback[] = [];
  let elapsed = 0;
  const T0 = 1000;
  let previousTypingAnimation = false;

  beforeEach(() => {
    const settings = useStore.getState().settings;
    previousTypingAnimation = settings.typingAnimation;
    useStore.setState({ settings: { ...settings, typingAnimation: true } });
    rafQueue = [];
    elapsed = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    const settings = useStore.getState().settings;
    useStore.setState({ settings: { ...settings, typingAnimation: previousTypingAnimation } });
    vi.unstubAllGlobals();
  });

  function tick(ts: number) {
    const cbs = rafQueue;
    rafQueue = [];
    act(() => {
      cbs.forEach((cb) => cb(ts));
    });
  }
  function prime() {
    tick(T0);
  }
  function step(n = 1) {
    elapsed += n;
    tick(T0 + elapsed * STEP_MS);
  }

  it("keeps the glowing decode animation for genuinely plain prose", () => {
    const { container } = render(
      <MessageView
        message={message("assistant", [{ kind: "text", text: "Hello world " }])}
        isActive
      />,
    );

    prime();
    step(1);

    // Plain prose still takes the per-frame decode path. Structured source takes
    // the live Markdown path tested above, avoiding an AST parse on every frame.
    expect(container.querySelector(".pc-scramble")).not.toBeNull();
    expect(container.querySelector(".prose-pc")).not.toBeNull();
    expect(container.querySelector(".pc-caret")).not.toBeNull();

    // The decoding wrapper is hidden from assistive tech: its ~45/sec glyph churn
    // would flood the chat live region. The settled markdown re-announces in place.
    expect(container.querySelector(".prose-pc")).toHaveAttribute("aria-hidden", "true");
  });

  it("resolves words into their real characters as frames advance", () => {
    const { container } = render(
      <MessageView
        message={message("assistant", [{ kind: "text", text: "Hello world " }])}
        isActive
      />,
    );

    prime();
    step(40);

    // Both words have decoded into the real text (settled, no longer glyphs).
    expect(container.textContent).toContain("Hello world");
  });
});
