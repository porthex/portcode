import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Message } from "../types";
import { ToolCall } from "./ToolCall";

export function MessageView({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <div className={`mb-5 flex gap-3 ${isUser ? "justify-end" : ""}`}>
      {!isUser && <Avatar />}
      <div className={`min-w-0 ${isUser ? "max-w-[85%]" : "flex-1"}`}>
        {isUser ? (
          <div className="whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-accent-dim px-4 py-2.5 text-fg select-text">
            {textOf(message)}
          </div>
        ) : (
          <div className="space-y-2">
            {message.blocks.map((b, i) => {
              if (b.kind === "text") {
                return (
                  <div key={i} className="prose-pc">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                    >
                      {b.text}
                    </ReactMarkdown>
                  </div>
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

function textOf(m: Message): string {
  return m.blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b.kind === "text" ? b.text : ""))
    .join("");
}

function Avatar() {
  return (
    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-dim">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
        <path
          d="M7 8l3 4-3 4M13 16h5"
          stroke="var(--color-accent)"
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
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.2s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.1s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" />
    </div>
  );
}
