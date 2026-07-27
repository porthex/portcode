import { Fragment, memo, useMemo, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { AgentInfo, ContentBlock, Message, TurnReceipt as TurnReceiptData } from "../types";
import { useStore } from "../store/store";
import { usePrefersReducedMotion, useScramble } from "../lib/useScramble";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import type { CodexTurnActivity } from "../lib/codexActivity";
import { ToolCall } from "./ToolCall";
import { isRoutineToolName, ToolActivityGroup, type ActivityCall } from "./ToolActivityGroup";
import { TurnChangesCard, TurnReceipt } from "./TurnReceipt";
import { CodexTurnActivityView } from "./CodexActivity";
import { AgentWorkflowCard } from "./AgentWorkflowCard";

// Hoisted to module scope so they're referentially stable across renders —
// otherwise a fresh array each render defeats React.memo on TextBlock and makes
// ReactMarkdown re-run remark/rehype (incl. syntax highlighting) on every delta.
// Typed off ReactMarkdown's own props so we don't deep-import unified's PluggableList.
type MarkdownPlugins = NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>;
const REMARK_PLUGINS: MarkdownPlugins = [remarkGfm];
const REHYPE_PLUGINS: MarkdownPlugins = [[rehypeHighlight, { detect: true }]];
const ACTIVE_REHYPE_PLUGINS: MarkdownPlugins = [];
const ACTIVE_CARET_REHYPE_PLUGINS: MarkdownPlugins = [rehypeStreamingCaret];

type HastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const CARET_UNSAFE_ELEMENTS = new Set([
  "a",
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// Put the streaming caret inside the final renderable Markdown element. A plain
// sibling after ReactMarkdown's block nodes falls onto a detached new line after
// headings, lists, and fenced code, which makes the live layout look unfinished.
function rehypeStreamingCaret() {
  return (tree: HastNode) => {
    let target: HastNode | undefined;
    const visit = (node: HastNode) => {
      if (
        node.type === "element" &&
        node.children &&
        node.tagName &&
        !CARET_UNSAFE_ELEMENTS.has(node.tagName)
      ) {
        target = node;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
    target?.children?.push({
      type: "element",
      tagName: "span",
      properties: { className: ["pc-caret"], ariaHidden: "true" },
      children: [],
    });
  };
}

// Structured replies need to format while they stream, but running the whole
// Markdown pipeline for every decorative scramble frame would make long turns
// progressively more expensive. Once a block contains Markdown syntax, prefer
// the live source (plus its caret) over the scramble. Plain prose keeps the
// terminal-style decode animation.
const BLOCK_MARKDOWN =
  /(^|\n)[\t ]{0,3}(?:#{1,6}(?:[\t ]|$)|[-+*][\t ]+|\d+[.)][\t ]+|>[\t ]?|`{3,}|~{3,})/m;
const SETEXT_THEMATIC_OR_CODE =
  /(^|\n)(?:[\t ]{0,3}(?:={3,}|-{3,}|_{3,})[\t ]*(?=\n|$)|[\t ]{4}\S)/m;
const INLINE_MARKDOWN =
  /(?:\*\*|__|~~|`|!\[|\[[^\]\n]*\]\(|<https?:\/\/|https?:\/\/|www\.|(^|[\s([{])[*_](?=\S))/m;
const TABLE_MARKDOWN = /(^|\n)[^\n|]+\|[^\n]+(?:\n|$)/m;

function hasMarkdownSyntax(text: string): boolean {
  return (
    BLOCK_MARKDOWN.test(text) ||
    SETEXT_THEMATIC_OR_CODE.test(text) ||
    INLINE_MARKDOWN.test(text) ||
    TABLE_MARKDOWN.test(text)
  );
}

// A tool_result paired with its tool_use by toolUseId. Reused (not re-derived)
// so the ToolCall props stay the existing narrowed shape.
type ResultBlock = Extract<ContentBlock, { kind: "tool_result" }>;
type ToolUseBlock = Extract<ContentBlock, { kind: "tool_use" }>;

type RenderItem =
  | { kind: "text"; block: Extract<ContentBlock, { kind: "text" }>; index: number }
  | { kind: "tool"; block: ToolUseBlock; result?: ResultBlock }
  | { kind: "activity"; calls: ActivityCall[] };

// Let Chromium skip style/layout/paint work for settled rows outside the
// viewport without removing them from the DOM. Keeping every message id present
// preserves search-result jumps, transcript semantics, and prepend pagination.
const SETTLED_ROW_STYLE = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 140px",
} as const;
const HISTORICAL_TOOL_INTERRUPTED =
  "Interrupted: this historical tool did not record a terminal result.";

// Memoised: while a turn streams, only the active assistant message's props change,
// so history rows (incl. their markdown + syntax highlighting) don't re-render on
// every delta — which kept the whole transcript re-highlighting ~45x/sec.
export const MessageView = memo(function MessageView({
  message,
  isActive = false,
  turnPresentation,
  agents,
  activity,
  remoteSafeActivity = false,
  onReviewChanges,
  reviewAvailable = true,
}: {
  message: Message;
  isActive?: boolean;
  turnPresentation?: {
    active: boolean;
    startedAt: number | null;
    waiting: boolean;
    finalizing: boolean;
  };
  agents?: AgentInfo[];
  activity?: CodexTurnActivity;
  remoteSafeActivity?: boolean;
  onReviewChanges?: (receipt: TurnReceiptData) => void;
  reviewAvailable?: boolean;
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

  // Fold consecutive, successful/pending read-only primitives into one calm
  // exploration row. A text block, mutation, delegation, unknown tool, or any
  // error flushes the group and remains individually visible in exact order.
  const renderItems = useMemo(
    () => buildRenderItems(message.blocks, resultByUseId, isActive, activity?.structuredItemIds),
    [message.blocks, resultByUseId, isActive, activity?.structuredItemIds],
  );
  const remoteTerminalVisible =
    remoteSafeActivity &&
    (activity?.status === "completed" ||
      activity?.status === "failed" ||
      activity?.status === "interrupted");
  const showReceipt =
    !isUser &&
    Boolean(
      message.receipt ||
      turnPresentation?.active ||
      turnPresentation?.finalizing ||
      (remoteSafeActivity && activity),
    );
  const textItems = showReceipt
    ? renderItems.filter(
        (item): item is Extract<RenderItem, { kind: "text" }> => item.kind === "text",
      )
    : [];
  const activityItems = showReceipt ? renderItems.filter((item) => item.kind !== "text") : [];
  const activityCount =
    activityItems.length + (activity?.visibleCount ?? 0) + (remoteTerminalVisible ? 1 : 0);
  const receiptActivity =
    activityCount > 0 ? (
      <div className="space-y-1.5">
        {activity && (activity.visibleCount > 0 || remoteTerminalVisible) && (
          <CodexTurnActivityView
            activity={activity}
            remoteSafe={remoteSafeActivity}
            reviewAvailable={reviewAvailable && Boolean(message.receipt)}
            onReviewChanges={
              message.receipt && onReviewChanges
                ? () => onReviewChanges(message.receipt!)
                : undefined
            }
          />
        )}
        {activityItems.map((item) => renderActivityItem(item, isActive))}
      </div>
    ) : null;
  const deferReceiptActivity = (activity?.visibleCount ?? 0) > 0 || remoteTerminalVisible;
  const workflowAgents = agents ?? [];
  const workflowCard =
    workflowAgents.length > 0 ? (
      <AgentWorkflowCard
        agents={workflowAgents}
        rootActive={Boolean(turnPresentation?.active)}
        startedAt={turnPresentation?.startedAt ?? message.receipt?.startedAt}
        durationMs={message.receipt?.agentDurationMs ?? message.receipt?.durationMs}
      />
    ) : null;

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

  // If the user has text selected inside this message, let the native copy menu
  // through instead of stealing it with the custom one. A selection elsewhere
  // must not suppress this message's actions.
  const handleContextMenu = (e: React.MouseEvent) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      for (let index = 0; index < sel.rangeCount; index += 1) {
        if (sel.getRangeAt(index).intersectsNode(e.currentTarget)) return;
      }
    }
    onContextMenu(menuItems)(e);
  };

  return (
    <div
      id={`pc-msg-${message.id}`}
      className={`mb-5 flex gap-[11px] ${isUser ? "justify-end" : "pc-msg-enter"}`}
      style={isActive ? undefined : SETTLED_ROW_STYLE}
      onContextMenu={handleContextMenu}
    >
      {!isUser && <Avatar />}
      <div className={`min-w-0 ${isUser ? "max-w-[82%]" : "flex-1"}`}>
        {isUser ? (
          <div className="pc-bubble-user break-words select-text">
            <MarkdownBody text={text} variant="user" rehypePlugins={REHYPE_PLUGINS} />
          </div>
        ) : (
          <div className="space-y-2">
            {showReceipt ? (
              <>
                <TurnReceipt
                  receipt={message.receipt}
                  active={turnPresentation?.active}
                  startedAt={turnPresentation?.startedAt}
                  waiting={turnPresentation?.waiting}
                  finalizing={turnPresentation?.finalizing}
                  activityCount={activityCount}
                  activity={deferReceiptActivity ? null : receiptActivity}
                  deferredActivity={deferReceiptActivity ? receiptActivity : null}
                />
                {textItems.length === 0 && workflowCard}
                {textItems.map((item, index) => (
                  <Fragment key={`text-${item.index}`}>
                    <TextBlock
                      text={item.block.text}
                      animate={animate}
                      active={isActive}
                      caret={animate && item.index === lastTextIndex}
                    />
                    {index === 0 && workflowCard}
                  </Fragment>
                ))}
                {message.receipt && (
                  <TurnChangesCard
                    receipt={message.receipt}
                    onReview={onReviewChanges}
                    reviewAvailable={reviewAvailable}
                  />
                )}
              </>
            ) : (
              <>
                {renderItems.map((item) => renderItem(item, isActive, animate, lastTextIndex))}
                {message.blocks.length === 0 && <Thinking />}
              </>
            )}
          </div>
        )}
      </div>
      {menu}
    </div>
  );
});

function renderItem(item: RenderItem, active: boolean, animate: boolean, lastTextIndex: number) {
  if (item.kind === "text") {
    return (
      <TextBlock
        key={`text-${item.index}`}
        text={item.block.text}
        animate={animate}
        active={active}
        caret={animate && item.index === lastTextIndex}
      />
    );
  }
  return renderActivityItem(item, active);
}

function renderActivityItem(item: Exclude<RenderItem, { kind: "text" }>, active: boolean) {
  if (item.kind === "activity") {
    return (
      <ToolActivityGroup
        key={`activity-${item.calls[0].tool.id}`}
        calls={item.calls}
        active={active}
      />
    );
  }
  return (
    <ToolCall
      key={item.block.id}
      name={item.block.name}
      input={item.block.input}
      result={item.result}
    />
  );
}

function buildRenderItems(
  blocks: ContentBlock[],
  resultByUseId: Map<string, ResultBlock>,
  isActive: boolean,
  structuredItemIds?: ReadonlySet<string>,
): RenderItem[] {
  const items: RenderItem[] = [];
  let routine: ActivityCall[] = [];

  const flushRoutine = () => {
    if (routine.length === 0) return;
    items.push({ kind: "activity", calls: routine });
    routine = [];
  };

  blocks.forEach((block, index) => {
    if (block.kind === "tool_result") return;
    if (block.kind === "text") {
      flushRoutine();
      items.push({ kind: "text", block, index });
      return;
    }
    if (structuredItemIds?.has(block.id)) {
      flushRoutine();
      return;
    }

    const result =
      resultByUseId.get(block.id) ??
      (!isActive
        ? {
            kind: "tool_result" as const,
            toolUseId: block.id,
            output: HISTORICAL_TOOL_INTERRUPTED,
            isError: true,
          }
        : undefined);
    if (isRoutineToolName(block.name) && !result?.isError) {
      routine.push({ tool: block, result });
      return;
    }

    flushRoutine();
    items.push({ kind: "tool", block, result });
  });

  flushRoutine();
  return items;
}

/** A single assistant text block, rendered as Markdown even before it settles. */
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
  if (animate && !hasMarkdownSyntax(text)) {
    return <ScrambleText text={text} caret={caret} />;
  }

  // Parse active source with the same safe Markdown renderer as settled output,
  // but defer syntax highlighting until completion. Highlighting the entire
  // accumulated response on every provider delta is disproportionately costly;
  // fenced and inline code are still code-shaped while the turn is in flight.
  return (
    <MarkdownBody
      text={text}
      rehypePlugins={
        active
          ? animate && caret
            ? ACTIVE_CARET_REHYPE_PLUGINS
            : ACTIVE_REHYPE_PLUGINS
          : REHYPE_PLUGINS
      }
    />
  );
});

/** The shared, raw-HTML-safe GFM surface used by sent prompts and replies. */
function MarkdownBody({
  text,
  variant = "assistant",
  rehypePlugins,
}: {
  text: string;
  variant?: "assistant" | "user";
  rehypePlugins: MarkdownPlugins;
}) {
  return (
    <div className={`prose-pc${variant === "user" ? " prose-pc--user" : ""}`}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehypePlugins}>
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
