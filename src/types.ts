// Shared types. These mirror the Rust core's serde models so the IPC boundary
// stays a single source of truth.

export type Role = "user" | "assistant" | "system";

export type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; output: string; isError: boolean };

export interface Message {
  id: string;
  role: Role;
  blocks: ContentBlock[];
  createdAt: number;
}

export interface Session {
  id: string;
  title: string;
  workspace: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Events streamed from the core during an agent run. */
export type StreamEvent =
  | { type: "turn_start"; messageId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError: boolean }
  | {
      type: "permission_request";
      id: string;
      tool: string;
      summary: string;
      input: unknown;
    }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn_end"; stopReason: string }
  | { type: "error"; message: string };

export interface PendingPermission {
  id: string;
  tool: string;
  summary: string;
  input: unknown;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export type ToolPolicy = "allow" | "ask" | "deny";

export interface Settings {
  provider: "anthropic";
  model: string;
  apiKeySet: boolean;
  defaultPolicy: ToolPolicy;
  workspace: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  apiKeySet: false,
  defaultPolicy: "ask",
  workspace: null,
};

export const MODELS = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export interface Usage {
  input: number;
  output: number;
}

// Approximate Anthropic list prices, USD per million tokens (input / output).
export const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 15, out: 75 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};

export function estimateCost(model: string, usage: Usage): number {
  const p = MODEL_PRICING[model] ?? { in: 0, out: 0 };
  return (usage.input * p.in + usage.output * p.out) / 1_000_000;
}
