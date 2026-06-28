import { memo, useMemo, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ContentBlock, Message } from "../types";
import { useStore } from "../store/store";
import { usePrefersReducedMotion, useScramble } from "../lib/useScramble";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ToolCall } from "./ToolCall";

// Hoisted to module scope so they're referentially stable across renders —
// otherwise a fresh array each render defeats React.memo on TextBlock and makes
// ReactMarkdown re-run remark/rehype (incl. syntax highlighting) on every delta.
// Typed off ReactMarkdown's own props so we don't deep-import unified's PluggableList.
type MarkdownPlugins = NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>;
const REMARK_PLUGINS: MarkdownPlugins = [remarkGfm];
const REHYPE_PLUGINS: MarkdownPlugins = [[rehypeHighlight, { detect: true }]];

// A tool_result paired with its tool_use by toolUseId. Reused (not re-derived)
// so the ToolCall props stay the existing narrowed shape.
type ResultBlock = Extract<ContentBlock, { kind: "tool_result" }>;

// Memoised: while a turn streams, only the active assistant message's props change,
// so history rows (incl. their markdown + syntax highlighting) don't re-render on
// every delta — which kept the whole transcript re-highlighting ~45x/sec.
export const MessageView = memo(function MessageView({
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

  // Index results by toolUseId once per render instead of a linear find per
  // tool_use — the active assistant row re-renders on every delta.
  const resultByUseId = useMemo(() => {
    const m = new Map<string, ResultBlock>();
    for (const b of message.blocks) if (b.kind === "tool_result") m.set(b.toolUseId, b);
    return m;
  }, [message.blocks]);

  // Right-click → copy the message's text. Disabled when the message has no text
  // (e.g. a tool-only assistant turn). Plain text inside the bubble keeps its own
  // native selection menu; this is the convenience "copy the whole message".
  const { onContextMenu, menu } = useContextMenu();
  const text = textOf(message);
  const menuItems: ContextMenuItem[] = [
    {
      label: "Copy message text",
      icon: <CopyGlyph />,
      onSelect: () => void navigator.clipboard?.writeText?.(text).catch(() => {}),
      disabled: text.length === 0,
    },
  ];

  return (
    <div
      id={`pc-msg-${message.id}`}
      className={`mb-5 flex gap-[11px] ${isUser ? "justify-end" : "pc-msg-enter"}`}
      onContextMenu={onContextMenu(menuItems)}
    >
      {!isUser && <Avatar />}
      <div className={`min-w-0 ${isUser ? "max-w-[82%]" : "flex-1"}`}>
        {isUser ? (
          <div className="pc-bubble-user whitespace-pre-wrap break-words select-text">
            {textOf(message)}
          </div>
        ) : (
          <div className="space-y-2">
            {message.blocks.map((b, i) => {
              if (b.kind === "text") {
                return (
                  <TextBlock
                    key={i}
                    text={b.text}
                    animate={animate}
                    active={isActive}
                    caret={animate && i === lastTextIndex}
                  />
                );
              }
              if (b.kind === "tool_use") {
                const result = resultByUseId.get(b.id);
                return <ToolCall key={i} name={b.name} input={b.input} result={result} />;
              }
              return null; // tool_result is rendered alongside its tool_use
            })}
            {message.blocks.length === 0 && <Thinking />}
          </div>
        )}
      </div>
      {menu}
    </div>
  );
});

/**
 * A single assistant text block. While its turn is streaming it reveals one WORD
 * at a time as a "decode" — each word flickers through random glyphs and resolves
 * left-to-right; once the turn completes it re-renders as full Markdown.
 */
const TextBlock = memo(function TextBlock({
  text,
  animate,
  active,
  caret,
}: {
  text: string;
  animate: boolean;
  active: boolean;
  caret: boolean;
}) {
  if (animate) {
    return <ScrambleText text={text} caret={caret} />;
  }
  // Active but NOT animating (reduced-motion ON, or typingAnimation off): render
  // cheap static plain text in the SAME .prose-pc body typography as the settled
  // markdown, so the body resolves in place when ReactMarkdown takes over. This
  // avoids re-running remark/rehype + syntax highlighting on every streaming
  // delta — the whole accumulated reply was otherwise re-highlighted per chunk.
  if (active) {
    return (
      <div className="prose-pc">
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </div>
    );
  }
  return (
    <div className="prose-pc">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

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
  // Render the decode in the SAME typography as the settled markdown body (.prose-pc,
  // a <p>) so that when the turn finishes and ReactMarkdown takes over, the text
  // resolves in place — no font/size/line-height swap reflowing the whole reply.
  // Hidden from assistive tech: the ~45/sec glyph churn would flood the chat live
  // region. When the turn ends the same text re-renders via the non-hidden
  // ReactMarkdown TextBlock, which the conversation log announces in place.
  return (
    <div className="prose-pc" aria-hidden="true">
      <p className="whitespace-pre-wrap break-words">
        {settled}
        {decoding && <span className="pc-scramble">{decoding}</span>}
        {caret && <span className="pc-caret" aria-hidden="true" />}
      </p>
    </div>
  );
}

function textOf(m: Message): string {
  return m.blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b.kind === "text" ? b.text : ""))
    .join("");
}

function CopyGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M5 15V6a1 1 0 0 1 1-1h9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
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
    <div className="flex items-center gap-1 py-1 text-muted">
      <span className="sr-only">Agent is thinking</span>
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.2s] motion-reduce:animate-none"
      />
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.1s] motion-reduce:animate-none"
      />
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted motion-reduce:animate-none"
      />
    </div>
  );
}
