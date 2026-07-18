import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { MessageView } from "./Message";
import { STEP_MS } from "../lib/useScramble";
import { useStore } from "../store/store";
import type { ContentBlock, Message, Role } from "../types";

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
    const bubble = row.querySelector(".whitespace-pre-wrap") as HTMLElement;
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
