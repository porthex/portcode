import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { MessageView } from "./Message";
import { STEP_MS } from "../lib/useScramble";
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

  it("renders a tool_use block as a ToolCall and pairs it with a non-error tool_result", () => {
    render(
      <MessageView
        message={message("assistant", [
          { kind: "tool_use", id: "t1", name: "fs_read", input: { path: "src/app.ts" } },
          { kind: "tool_result", toolUseId: "t1", output: "file contents", isError: false },
        ])}
      />,
    );

    // ToolCall shows the tool name and, via summarize(), the input path.
    expect(screen.getByText("fs_read")).toBeInTheDocument();
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();

    // The matched result feeds ToolCall; expand the disclosure to reveal output.
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getByText("file contents")).toBeInTheDocument();
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

    expect(screen.getByText("shell")).toBeInTheDocument();
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

    expect(screen.getByText("fs_write")).toBeInTheDocument();

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
    // summarize() prefers the pattern field for the collapsed summary.
    expect(screen.getByText("grep")).toBeInTheDocument();
    expect(screen.getByText("TODO")).toBeInTheDocument();
  });
});

describe("MessageView — typing animation", () => {
  // Freeze requestAnimationFrame so the reveal never advances during the test:
  // assertions stay deterministic and no setState escapes React's act().
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the in-flight assistant turn in the body typography with a blinking caret", () => {
    const { container } = render(
      <MessageView
        message={message("assistant", [{ kind: "text", text: "**bold** text" }])}
        isActive
      />,
    );

    // The active turn shows the decode view in the SAME .prose-pc body typography as
    // the settled markdown (so it resolves in place) + a caret, not formatted markdown.
    expect(container.querySelector(".pc-caret")).not.toBeNull();
    expect(container.querySelector(".prose-pc")).not.toBeNull();
    expect(container.querySelector("strong")).toBeNull();
  });

  it("renders a finished (inactive) turn as markdown with no caret", () => {
    const { container } = render(
      <MessageView message={message("assistant", [{ kind: "text", text: "**bold** text" }])} />,
    );

    expect(container.querySelector(".pc-caret")).toBeNull();
    expect(container.querySelector("strong")).not.toBeNull();
  });
});

describe("MessageView — scramble decode (active turn)", () => {
  // useScramble runs off requestAnimationFrame; drive it with a manual queue so
  // the decode advances by exact frames. One callback is scheduled per tick.
  let rafQueue: FrameRequestCallback[] = [];
  let elapsed = 0;
  const T0 = 1000;

  beforeEach(() => {
    rafQueue = [];
    elapsed = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
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

  it("decodes the in-flight word as a glowing accent tail, not markdown", () => {
    const { container } = render(
      <MessageView
        message={message("assistant", [{ kind: "text", text: "**Hello** world " }])}
        isActive
      />,
    );

    prime();
    step(1);

    // The decoding tail is wrapped in .pc-scramble (the accent glow), in the same
    // .prose-pc body typography as settled markdown, with a caret, and is NOT yet
    // rendered as Markdown.
    expect(container.querySelector(".pc-scramble")).not.toBeNull();
    expect(container.querySelector(".prose-pc")).not.toBeNull();
    expect(container.querySelector(".pc-caret")).not.toBeNull();
    expect(container.querySelector("strong")).toBeNull();

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
