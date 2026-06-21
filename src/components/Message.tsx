import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Message } from "../types";
import { useStore } from "../store/store";
import { usePrefersReducedMotion, useScramble } from "../lib/useScramble";
import { ToolCall } from "./ToolCall";

export function MessageView({
  message,
  isActive = false,
}: {
  message: Message;
  isActive?: boolean;
}) {
  const isUser = message.role === "user";
  const typingAnimation = useStore((s) => s.settings.typingAnimation);
  const reducedMotion = usePrefersReducedMotion();
  // Only the in-flight assistant turn types out. History, the "off" setting, and
  // reduced-motion all render the finished markdown immediately.
  const animate = !isUser && isActive && typingAnimation && !reducedMotion;

  // The last text block is the one still being streamed — it carries the caret.
  let lastTextIndex = -1;
  message.blocks.forEach((b, i) => {
    if (b.kind === "text") lastTextIndex = i;
  });

  return (
    <div className={`mb-5 flex gap-[11px] ${isUser ? "justify-end" : ""}`}>
      {!isUser && <Avatar />}
      <div className={`min-w-0 ${isUser ? "" : "flex-1"}`}>
        {isUser ? (
          <div className="pc-bubble-user whitespace-pre-wrap select-text">{textOf(message)}</div>
        ) : (
          <div className="space-y-2">
            {message.blocks.map((b, i) => {
              if (b.kind === "text") {
                return (
                  <TextBlock
                    key={i}
                    text={b.text}
                    animate={animate}
                    caret={animate && i === lastTextIndex}
                  />
                );
              }
              if (b.kind === "tool_use") {
                const result = message.blocks.find(
                  (x) => x.kind === "tool_result" && x.toolUseId === b.id,
                );
                return (
                  <ToolCall
                    key={i}
                    name={b.name}
                    input={b.input}
                    result={result && result.kind === "tool_result" ? result : undefined}
                  />
                );
              }
              return null; // tool_result is rendered alongside its tool_use
            })}
            {message.blocks.length === 0 && <Thinking />}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A single assistant text block. While its turn is streaming it reveals one WORD
 * at a time as a "decode" — each word flickers through random glyphs and resolves
 * left-to-right; once the turn completes it re-renders as full Markdown.
 */
function TextBlock({ text, animate, caret }: { text: string; animate: boolean; caret: boolean }) {
  if (animate) {
    return <ScrambleText text={text} caret={caret} />;
  }
  return (
    <div className="prose-pc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true }]]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * The streaming assistant turn rendered as a per-word decode (see useScramble):
 * settled text is plain monospace, and the still-decoding tail of the current
 * word glows in the accent (.pc-scramble). A blinking caret trails the last
 * block while it streams.
 */
function ScrambleText({ text, caret }: { text: string; caret: boolean }) {
  const { display, scrambleStart } = useScramble(text, true);
  const settled = display.slice(0, scrambleStart);
  const decoding = display.slice(scrambleStart);
  return (
    <div className="prose-pc whitespace-pre-wrap break-words font-mono text-[13px]">
      {settled}
      {decoding && <span className="pc-scramble">{decoding}</span>}
      {caret && <span className="pc-caret" aria-hidden="true" />}
    </div>
  );
}

function textOf(m: Message): string {
  return m.blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b.kind === "text" ? b.text : ""))
    .join("");
}

function Avatar() {
  return (
    <div className="pc-avatar mt-0.5 text-accent-2">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M7 8l3 4-3 4M13 16h5"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function Thinking() {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-1 py-1 text-muted">
      <span className="sr-only">Agent is thinking</span>
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.2s]"
      />
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.1s]"
      />
      <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" />
    </div>
  );
}
