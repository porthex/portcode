import type { CodexActivityEvent } from "../types";

export const CODEX_ACTIVITY_WINDOW = 2_000;
export const CODEX_ACTIVITY_ARCHIVE_LIMIT = CODEX_ACTIVITY_WINDOW * 4;
export const CODEX_PROVISIONAL_OUTPUT_LIMIT = 40_000;
export const CODEX_UNKNOWN_ACTIVITY_LIMIT = 200;

export type CodexTurnStatus = "running" | "completed" | "interrupted" | "failed" | "unknown";

export interface CodexPlanStep {
  text: string;
  status: "pending" | "inProgress" | "completed";
}

export interface CodexTurnPlan {
  explanation?: string;
  steps: CodexPlanStep[];
  draftText?: string;
  finalText?: string;
  terminal?: boolean;
}

export interface CodexTurnDiff {
  text: string;
  uncertainty: "malformed" | "truncated" | "oversized" | null;
  sequence: number;
}

export interface CodexCommandActivity {
  itemId: string;
  status: string;
  terminal: boolean;
  command?: string;
  cwd?: string;
  processId?: string | number;
  output: string;
  truncatedChars: number;
  terminalInteractionCount: number;
  exitCode?: number;
  durationMs?: number;
  sequence: number;
}

export interface CodexFileChange {
  path: string;
  kind?: string;
  diff: string;
}

export interface CodexFileChangeActivity {
  itemId: string;
  status: string;
  terminal: boolean;
  changes: CodexFileChange[];
  sequence: number;
}

export interface CodexMcpActivity {
  itemId: string;
  status: string;
  terminal: boolean;
  server?: string;
  tool?: string;
  arguments?: unknown;
  progress?: string;
  result?: unknown;
  error?: unknown;
  durationMs?: number;
  sequence: number;
}

export interface CodexReasoningSummary {
  itemId: string;
  parts: string[];
  status: string;
  terminal: boolean;
  sequence: number;
}

export interface CodexCompactionActivity {
  itemId: string;
  status: string;
  terminal: boolean;
  sequence: number;
}

export interface CodexNotice {
  id: string;
  kind: "retry" | "error" | "warning";
  message: string;
  retrying: boolean;
  sequence: number;
}

export interface CodexTurnActivity {
  sessionId: string;
  threadId: string;
  turnId: string;
  status: CodexTurnStatus;
  plan: CodexTurnPlan | null;
  commands: Record<string, CodexCommandActivity>;
  fileChanges: Record<string, CodexFileChangeActivity>;
  turnDiff: CodexTurnDiff | null;
  mcpCalls: Record<string, CodexMcpActivity>;
  reasoning: Record<string, CodexReasoningSummary>;
  compactions: Record<string, CodexCompactionActivity>;
  notices: CodexNotice[];
  visibleCount: number;
  structuredItemIds: Set<string>;
  firstSequence: number;
}

export interface CodexUnknownActivity {
  sequence: number;
  sessionId: string;
  threadId: string;
  turnId?: string | null;
  itemId?: string | null;
  method: string;
  params: unknown;
  requestId?: unknown;
  emittedAtMs: number;
}

export interface CodexActivityProjection {
  turns: Record<string, CodexTurnActivity>;
  turnOrder: string[];
  unknown: CodexUnknownActivity[];
  hasMore: boolean;
  unknownTruncated: number;
}

export interface CodexActivityProjectionOptions {
  hasMore?: boolean;
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const codexTurnKey = (sessionId: string, turnId: string): string =>
  JSON.stringify([sessionId, turnId]);

function emptyTurn(event: CodexActivityEvent, turnId: string): CodexTurnActivity {
  return {
    sessionId: event.sessionId,
    threadId: event.threadId,
    turnId,
    status: "unknown",
    plan: null,
    commands: {},
    fileChanges: {},
    turnDiff: null,
    mcpCalls: {},
    reasoning: {},
    compactions: {},
    notices: [],
    visibleCount: 0,
    structuredItemIds: new Set<string>(),
    firstSequence: event.sequence,
  };
}

function eventTurnId(event: CodexActivityEvent): string | undefined {
  if (event.turnId) return event.turnId;
  const params = asObject(event.params);
  const turn = asObject(params?.turn);
  return readString(turn?.id) ?? readString(params?.turnId);
}

function eventItem(event: CodexActivityEvent): Record<string, unknown> | null {
  return asObject(asObject(event.params)?.item);
}

function eventItemId(event: CodexActivityEvent): string | undefined {
  return (
    event.itemId ?? readString(eventItem(event)?.id) ?? readString(asObject(event.params)?.itemId)
  );
}

function readProcessId(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function completedItemStatus(value: unknown, error?: unknown): string {
  const status = readString(value);
  if (status === "completed" || status === "failed" || status === "interrupted") return status;
  if (status === "cancelled" || status === "canceled" || status === "declined") {
    return "interrupted";
  }
  if (status === undefined) return error == null ? "completed" : "failed";
  return "unknown";
}

const terminalTurnItemStatus = (status: CodexTurnStatus): string | null =>
  status === "completed" || status === "failed" || status === "interrupted" ? status : null;

function terminalizeTurnItems(turn: CodexTurnActivity): void {
  const status = terminalTurnItemStatus(turn.status);
  if (!status) return;
  if (turn.plan) turn.plan.terminal = true;
  for (const item of Object.values(turn.commands)) {
    if (!item.terminal) {
      item.status = status;
      item.terminal = true;
    }
  }
  for (const item of Object.values(turn.fileChanges)) {
    if (!item.terminal) {
      item.status = status;
      item.terminal = true;
    }
  }
  for (const item of Object.values(turn.mcpCalls)) {
    if (!item.terminal) {
      item.status = status;
      item.terminal = true;
    }
  }
  for (const item of Object.values(turn.reasoning)) {
    if (!item.terminal) {
      item.status = status;
      item.terminal = true;
    }
  }
  for (const item of Object.values(turn.compactions)) {
    if (!item.terminal) {
      item.status = status;
      item.terminal = true;
    }
  }
}

const REDACTED_REASONING_KEYS = new Set([
  "reasoning",
  "reasoningtext",
  "rawreasoning",
  "rawreasoningtext",
  "chainofthought",
  "chainofthoughttext",
  "internalreasoning",
  "internalreasoningtext",
  "modelreasoning",
  "modelreasoningtext",
]);

const REASONING_DISCRIMINATORS = new Set([
  "reasoning",
  "reasoningtext",
  "rawreasoning",
  "rawreasoningtext",
  "chainofthought",
  "chainofthoughttext",
  "internalreasoning",
  "internalreasoningtext",
  "modelreasoning",
  "modelreasoningtext",
]);

const SAFE_REASONING_METADATA_KEYS = new Set([
  "id",
  "type",
  "kind",
  "status",
  "summary",
  "threadid",
  "turnid",
  "itemid",
  "requestid",
  "contentindex",
  "startedat",
  "startedatms",
  "completedat",
  "completedatms",
  "durationms",
]);

const RAW_REASONING_REDACTION = Object.freeze({
  redacted: true,
  reason: "rawReasoning",
});

const KNOWN_SECRET_REDACTION = Object.freeze({
  redacted: true,
  reason: "knownSecret",
});

const KNOWN_SECRET_KEYS = new Set([
  "apikey",
  "xapikey",
  "password",
  "passwd",
  "passphrase",
  "authorization",
  "proxyauthorization",
  "credential",
  "credentials",
  "secret",
  "clientsecret",
  "apisecret",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "authtoken",
  "bearertoken",
  "sessiontoken",
  "privatekey",
  "cookie",
  "setcookie",
  "bearer",
  "auth",
  "authentication",
]);

const normalizedMetadataKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

const isReasoningShape = (object: Record<string, unknown>): boolean =>
  Object.entries(object).some(
    ([key, value]) =>
      (normalizedMetadataKey(key) === "type" || normalizedMetadataKey(key) === "kind") &&
      typeof value === "string" &&
      REASONING_DISCRIMINATORS.has(normalizedMetadataKey(value)),
  );

export function sanitizeCodexInspectorValue(value: unknown): unknown {
  return sanitizeCodexInspectorValueInner(value, new WeakMap<object, unknown>());
}

const REMOTE_IDENTIFIER = /^[A-Za-z0-9_.-]{1,128}$/;
const REMOTE_METHOD = /^[A-Za-z0-9/._-]{1,128}$/;
const REMOTE_ACTIVITY_REASONS = new Set([
  "rawReasoning",
  "knownSecret",
  "nonScalarRequestId",
  "maxDepth",
  "maxFields",
  "maxArrayItems",
  "maxStringBytes",
  "maxEncodedBytes",
  "maxMethodBytes",
]);
const REMOTE_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "contextCompaction",
  "plan",
  "collabAgentToolCall",
  "subAgentActivity",
]);

const remoteIdentifier = (value: unknown, fallback: string): string =>
  typeof value === "string" && REMOTE_IDENTIFIER.test(value) ? value : fallback;

const remoteMethod = (value: string): string =>
  REMOTE_METHOD.test(value) ? value : "redacted-method";

const remoteCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), 0xffff_ffff)
    : 0;

const remoteStatus = (value: unknown): string =>
  typeof value === "string" &&
  ["pending", "inProgress", "completed", "failed", "interrupted", "unknown"].includes(value)
    ? value
    : "unknown";

function remoteMetadata(value: unknown): Record<string, unknown> {
  const metadata = asObject(value);
  const reasons = (key: string) =>
    asArray(metadata?.[key])
      .filter(
        (reason): reason is string =>
          typeof reason === "string" && REMOTE_ACTIVITY_REASONS.has(reason),
      )
      .slice(0, 16);
  const originalBytes = remoteCount(metadata?.originalBytes);
  const retainedBytes = remoteCount(metadata?.retainedBytes);
  return {
    redacted: metadata?.redacted === true,
    truncated: metadata?.truncated === true,
    redactionReasons: reasons("redactionReasons"),
    truncationReasons: reasons("truncationReasons"),
    ...(metadata?.originalBytes === undefined ? {} : { originalBytes }),
    ...(metadata?.retainedBytes === undefined ? {} : { retainedBytes }),
  };
}

/** Rebuild remote activity from the public DTO allowlist at the render boundary.
 * This also makes a desktop-to-remote mode switch fail closed if stale local raw
 * activity remains in memory. No provider params, paths, outputs, requests, child
 * payloads, or reasoning values survive this conversion. */
export function remoteSafeCodexActivityEvents(
  events: readonly CodexActivityEvent[],
): CodexActivityEvent[] {
  return events.map((event) => {
    const source = asObject(event.params);
    const method = remoteMethod(event.method);
    const threadId = remoteIdentifier(event.threadId, "remote-codex");
    const turnId = event.turnId ? remoteIdentifier(event.turnId, "remote-turn") : undefined;
    const itemId = event.itemId ? remoteIdentifier(event.itemId, "remote-item") : undefined;
    let params: Record<string, unknown> = {
      threadId,
      ...(turnId === undefined ? {} : { turnId }),
      ...(itemId === undefined ? {} : { itemId }),
      _portcodeActivity: remoteMetadata(source?._portcodeActivity),
    };

    if (method === "turn/plan/updated") {
      params = {
        ...params,
        plan: asArray(source?.plan)
          .slice(0, 64)
          .flatMap((candidate, index) => {
            const status = remoteStatus(asObject(candidate)?.status);
            return status === "pending" || status === "inProgress" || status === "completed"
              ? [{ step: "Step " + (index + 1), status }]
              : [];
          }),
      };
    } else if (method === "turn/diff/updated") {
      const additions = remoteCount(source?.additions);
      const deletions = remoteCount(source?.deletions);
      const files = remoteCount(source?.files);
      params = {
        ...params,
        additions,
        deletions,
        files,
        diff:
          "Aggregate changes: +" + additions + " -" + deletions + " across " + files + " files.",
      };
    } else if (method === "item/started" || method === "item/completed") {
      const item = asObject(source?.item);
      const itemType =
        typeof item?.type === "string" && REMOTE_ITEM_TYPES.has(item.type) ? item.type : "unknown";
      params = {
        ...params,
        item: {
          id: itemId ?? "remote-item",
          type: itemType,
          status: remoteStatus(item?.status),
        },
      };
    } else if (method === "turn/completed") {
      const turn = asObject(source?.turn);
      params = {
        ...params,
        turn: {
          id: turnId ?? "remote-turn",
          status: remoteStatus(turn?.status),
        },
      };
    }

    return {
      sequence: Number.isSafeInteger(event.sequence) ? event.sequence : 0,
      sessionId: event.sessionId,
      threadId,
      ...(turnId === undefined ? {} : { turnId }),
      ...(itemId === undefined ? {} : { itemId }),
      method,
      params,
      emittedAtMs: Number.isFinite(event.emittedAtMs) ? event.emittedAtMs : 0,
    };
  });
}

function sanitizeCodexInspectorValueInner(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (Array.isArray(value)) {
    const sanitized: unknown[] = [];
    seen.set(value, sanitized);
    for (const child of value) {
      sanitized.push(sanitizeCodexInspectorValueInner(child, seen));
    }
    return sanitized;
  }
  const object = asObject(value);
  if (!object) return value;
  const reasoningShape = isReasoningShape(object);
  const sanitized: Record<string, unknown> = {};
  seen.set(value, sanitized);
  for (const [key, child] of Object.entries(object)) {
    const normalized = normalizedMetadataKey(key);
    if (KNOWN_SECRET_KEYS.has(normalized)) {
      sanitized[key] = KNOWN_SECRET_REDACTION;
      continue;
    }
    if (REDACTED_REASONING_KEYS.has(normalized)) {
      sanitized[key] = RAW_REASONING_REDACTION;
      continue;
    }
    if (reasoningShape && !SAFE_REASONING_METADATA_KEYS.has(normalized)) {
      sanitized[key] = RAW_REASONING_REDACTION;
      continue;
    }
    sanitized[key] = sanitizeCodexInspectorValueInner(child, seen);
  }
  return sanitized;
}

function readDiffUncertainty(params: Record<string, unknown> | null): CodexTurnDiff["uncertainty"] {
  if (typeof params?.diff !== "string") return "malformed";
  const metadata = asObject(params?._portcodeActivity);
  if (metadata?.truncated !== true) return null;
  const reasons = asArray(metadata.truncationReasons).filter(
    (reason): reason is string => typeof reason === "string",
  );
  return reasons.some((reason) => reason === "maxEncodedBytes" || reason === "maxStringBytes")
    ? "oversized"
    : "truncated";
}

function appendCommandOutput(command: CodexCommandActivity, delta: string): void {
  const combined = command.output + delta;
  const overflow = Math.max(0, combined.length - CODEX_PROVISIONAL_OUTPUT_LIMIT);
  command.output = overflow > 0 ? combined.slice(overflow) : combined;
  command.truncatedChars += overflow;
}

function readFileChanges(value: unknown): CodexFileChange[] {
  const changes: CodexFileChange[] = [];
  for (const candidate of asArray(value)) {
    const change = asObject(candidate);
    const path = readString(change?.path);
    if (!path) continue;
    const kind = readString(change?.kind);
    changes.push({
      path,
      ...(kind === undefined ? {} : { kind }),
      diff: readString(change?.diff) ?? "",
    });
  }
  return changes;
}

function eventNoticeMessage(event: CodexActivityEvent): string {
  const params = asObject(event.params);
  return (
    readString(params?.message) ??
    readString(asObject(params?.error)?.message) ??
    (event.method === "error" ? "Codex reported an error." : "Codex reported a warning.")
  );
}

const MEANINGFUL_PROGRESS_METHODS = new Set([
  "turn/plan/updated",
  "item/plan/delta",
  "item/started",
  "item/completed",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/agentMessage/delta",
  "thread/compacted",
]);

const RECOGNIZED_CODEX_ACTIVITY_METHODS = new Set([
  "thread/started",
  "thread/name/updated",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "thread/compacted",
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "turn/diff/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "error",
  "warning",
  "guardianWarning",
]);

export function isRecognizedCodexActivityMethod(method: string): boolean {
  return RECOGNIZED_CODEX_ACTIVITY_METHODS.has(method);
}

const MAX_REASONING_SUMMARY_PARTS = 100;

function readSummaryIndex(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MAX_REASONING_SUMMARY_PARTS
    ? value
    : undefined;
}

function readReasoningSummary(value: unknown): string[] {
  return asArray(value)
    .slice(0, MAX_REASONING_SUMMARY_PARTS)
    .map((part) => readString(part) ?? readString(asObject(part)?.text))
    .filter((part): part is string => part !== undefined);
}

function completedTurnStatus(event: CodexActivityEvent): CodexTurnStatus {
  const status = readString(asObject(asObject(event.params)?.turn)?.status);
  if (status === "completed") return "completed";
  if (status === "interrupted" || status === "cancelled" || status === "canceled") {
    return "interrupted";
  }
  if (status === "failed") return "failed";
  return "unknown";
}

export function projectCodexActivity(
  events: readonly CodexActivityEvent[],
  options: CodexActivityProjectionOptions = {},
): CodexActivityProjection {
  const ordered: CodexActivityEvent[] = [];
  const seenSequences = new Set<number>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (seenSequences.has(event.sequence)) continue;
    seenSequences.add(event.sequence);
    ordered.push({
      ...event,
      params: sanitizeCodexInspectorValue(event.params),
      ...(event.requestId === undefined
        ? {}
        : { requestId: sanitizeCodexInspectorValue(event.requestId) }),
    });
  }

  const turns: Record<string, CodexTurnActivity> = {};
  const turnOrder: string[] = [];
  const unknown: CodexUnknownActivity[] = [];
  const currentTurnByThread = new Map<string, string>();
  const threadKey = (event: CodexActivityEvent): string =>
    JSON.stringify([event.sessionId, event.threadId]);

  const ensureTurn = (event: CodexActivityEvent, turnId: string): CodexTurnActivity => {
    const key = codexTurnKey(event.sessionId, turnId);
    const existing = turns[key];
    if (existing) return existing;
    const created = emptyTurn(event, turnId);
    turns[key] = created;
    turnOrder.push(key);
    return created;
  };

  const ensureCommand = (
    turn: CodexTurnActivity,
    itemId: string,
    sequence: number,
  ): CodexCommandActivity => {
    const existing = turn.commands[itemId];
    if (existing) return existing;
    const created: CodexCommandActivity = {
      itemId,
      status: "running",
      terminal: false,
      output: "",
      truncatedChars: 0,
      terminalInteractionCount: 0,
      sequence,
    };
    turn.commands[itemId] = created;
    turn.structuredItemIds.add(itemId);
    turn.visibleCount += 1;
    return created;
  };

  const ensureFileChange = (
    turn: CodexTurnActivity,
    itemId: string,
    sequence: number,
  ): CodexFileChangeActivity => {
    const existing = turn.fileChanges[itemId];
    if (existing) return existing;
    const created: CodexFileChangeActivity = {
      itemId,
      status: "running",
      terminal: false,
      changes: [],
      sequence,
    };
    turn.fileChanges[itemId] = created;
    turn.structuredItemIds.add(itemId);
    turn.visibleCount += 1;
    return created;
  };

  const ensureReasoning = (
    turn: CodexTurnActivity,
    itemId: string,
    sequence: number,
  ): CodexReasoningSummary => {
    const existing = turn.reasoning[itemId];
    if (existing) return existing;
    const created: CodexReasoningSummary = {
      itemId,
      parts: [],
      status: "running",
      terminal: false,
      sequence,
    };
    turn.reasoning[itemId] = created;
    turn.visibleCount += 1;
    return created;
  };

  const ensureCompaction = (
    turn: CodexTurnActivity,
    itemId: string,
    sequence: number,
    structured: boolean,
  ): CodexCompactionActivity => {
    const existing = turn.compactions[itemId];
    if (existing) return existing;
    const created: CodexCompactionActivity = {
      itemId,
      status: "running",
      terminal: false,
      sequence,
    };
    turn.compactions[itemId] = created;
    if (structured) turn.structuredItemIds.add(itemId);
    turn.visibleCount += 1;
    return created;
  };

  const ensureMcpCall = (
    turn: CodexTurnActivity,
    itemId: string,
    sequence: number,
  ): CodexMcpActivity => {
    const existing = turn.mcpCalls[itemId];
    if (existing) return existing;
    const created: CodexMcpActivity = {
      itemId,
      status: "running",
      terminal: false,
      progress: undefined,
      sequence,
    };
    turn.mcpCalls[itemId] = created;
    turn.structuredItemIds.add(itemId);
    turn.visibleCount += 1;
    return created;
  };

  for (const event of ordered) {
    if (!isRecognizedCodexActivityMethod(event.method)) {
      unknown.push({
        sequence: event.sequence,
        sessionId: event.sessionId,
        threadId: event.threadId,
        turnId: event.turnId,
        itemId: event.itemId,
        method: event.method,
        params: sanitizeCodexInspectorValue(event.params),
        requestId: event.requestId,
        emittedAtMs: event.emittedAtMs,
      });
      continue;
    }
    const explicitTurnId = eventTurnId(event);
    const turnId = explicitTurnId ?? currentTurnByThread.get(threadKey(event));
    if (!turnId) continue;
    const existingTurn = turns[codexTurnKey(event.sessionId, turnId)];
    if (existingTurn && terminalTurnItemStatus(existingTurn.status)) {
      if (
        event.method === "turn/completed" ||
        event.method === "turn/plan/updated" ||
        event.method === "turn/diff/updated" ||
        event.method === "turn/started"
      ) {
        continue;
      }
    }
    let turn: CodexTurnActivity;
    if (event.method === "turn/started") {
      currentTurnByThread.set(threadKey(event), turnId);
    }
    if (MEANINGFUL_PROGRESS_METHODS.has(event.method)) {
      turn = ensureTurn(event, turnId);
      turn.notices = turn.notices.filter((notice) => notice.kind !== "retry");
    }
    if (event.method === "turn/completed") {
      turn = ensureTurn(event, turnId);
      turn.status = completedTurnStatus(event);
      terminalizeTurnItems(turn);
      turn.notices = turn.notices.filter((notice) => notice.kind !== "retry");
    } else if (event.method === "error") {
      turn = ensureTurn(event, turnId);
      const retrying = asObject(event.params)?.willRetry === true;
      if (retrying) turn.notices = turn.notices.filter((notice) => notice.kind !== "retry");
      turn.notices.push({
        id: retrying ? "retry" : "error:" + event.sequence,
        kind: retrying ? "retry" : "error",
        message: eventNoticeMessage(event),
        retrying,
        sequence: event.sequence,
      });
    } else if (event.method === "warning" || event.method === "guardianWarning") {
      turn = ensureTurn(event, turnId);
      turn.notices.push({
        id: "warning:" + event.sequence,
        kind: "warning",
        message: eventNoticeMessage(event),
        retrying: false,
        sequence: event.sequence,
      });
    } else if (event.method === "turn/plan/updated") {
      turn = ensureTurn(event, turnId);
      if (terminalTurnItemStatus(turn.status) || turn.plan?.terminal) continue;
      const params = asObject(event.params);
      const steps: CodexPlanStep[] = [];
      for (const candidate of asArray(params?.plan)) {
        const step = asObject(candidate);
        const text = readString(step?.step) ?? readString(step?.text);
        const status = readString(step?.status);
        if (text && (status === "pending" || status === "inProgress" || status === "completed")) {
          steps.push({ text, status });
        }
      }
      const explanation = readString(params?.explanation);
      turn.plan = explanation === undefined ? { steps } : { explanation, steps };
      turn.visibleCount = 1;
    } else if (event.method === "turn/diff/updated") {
      turn = ensureTurn(event, turnId);
      const params = asObject(event.params);
      turn.turnDiff = {
        text: readString(params?.diff) ?? "",
        uncertainty: readDiffUncertainty(params),
        sequence: event.sequence,
      };
    } else if (event.method === "turn/started") {
      turn = ensureTurn(event, turnId);
      if (turn.status === "unknown") turn.status = "running";
    } else if (event.method === "item/agentMessage/delta") {
      // Assistant text is already projected into the transcript. It only acts as
      // meaningful progress here so a transient retry notice can clear.
    } else if (event.method === "item/plan/delta") {
      turn = ensureTurn(event, turnId);
      if (terminalTurnItemStatus(turn.status) || turn.plan?.terminal) continue;
      const delta = readString(asObject(event.params)?.delta) ?? "";
      const plan = turn.plan ?? { steps: [] };
      plan.draftText = (plan.draftText ?? "") + delta;
      turn.plan = plan;
    } else if (event.method === "thread/compacted") {
      turn = ensureTurn(event, turnId);
      ensureCompaction(turn, "thread-compaction:" + event.sequence, event.sequence, false).status =
        "completed";
      const compaction = turn.compactions["thread-compaction:" + event.sequence];
      if (compaction) compaction.terminal = true;
    } else if (event.method === "item/reasoning/textDelta") {
      // Raw reasoning is deliberately consumed without producing visible or
      // inspectable state. Only summary methods below are safe to project.
    } else if (
      event.method === "item/reasoning/summaryPartAdded" ||
      event.method === "item/reasoning/summaryTextDelta"
    ) {
      const itemId = eventItemId(event);
      const params = asObject(event.params);
      const summaryIndex = readSummaryIndex(params?.summaryIndex);
      if (!itemId || summaryIndex === undefined) continue;
      turn = ensureTurn(event, turnId);
      const reasoning = ensureReasoning(turn, itemId, event.sequence);
      if (reasoning.terminal) continue;
      while (reasoning.parts.length <= summaryIndex) reasoning.parts.push("");
      if (event.method === "item/reasoning/summaryTextDelta") {
        reasoning.parts[summaryIndex] += readString(params?.delta) ?? "";
      }
    } else if (event.method === "item/commandExecution/outputDelta") {
      const itemId = eventItemId(event);
      if (!itemId) continue;
      turn = ensureTurn(event, turnId);
      const command = ensureCommand(turn, itemId, event.sequence);
      if (!command.terminal) {
        appendCommandOutput(command, readString(asObject(event.params)?.delta) ?? "");
      }
    } else if (event.method === "item/mcpToolCall/progress") {
      const itemId = eventItemId(event);
      if (!itemId) continue;
      turn = ensureTurn(event, turnId);
      const mcpCall = ensureMcpCall(turn, itemId, event.sequence);
      if (!mcpCall.terminal) {
        mcpCall.progress = readString(asObject(event.params)?.message) ?? mcpCall.progress;
      }
    } else if (event.method === "item/commandExecution/terminalInteraction") {
      const itemId = eventItemId(event);
      if (!itemId) continue;
      turn = ensureTurn(event, turnId);
      const command = ensureCommand(turn, itemId, event.sequence);
      if (!command.terminal) {
        command.terminalInteractionCount += 1;
        command.processId = readProcessId(asObject(event.params)?.processId) ?? command.processId;
      }
    } else if (event.method === "item/fileChange/patchUpdated") {
      const itemId = eventItemId(event);
      if (!itemId) continue;
      turn = ensureTurn(event, turnId);
      const fileChange = ensureFileChange(turn, itemId, event.sequence);
      if (!fileChange.terminal) {
        fileChange.changes = readFileChanges(asObject(event.params)?.changes);
        fileChange.status = "running";
      }
    } else if (event.method === "item/completed") {
      const item = eventItem(event);
      const itemId = eventItemId(event);
      if (!itemId) continue;
      turn = ensureTurn(event, turnId);
      if (readString(item?.type) === "commandExecution") {
        const command = ensureCommand(turn, itemId, event.sequence);
        command.command = readString(item?.command) ?? command.command;
        command.cwd = readString(item?.cwd) ?? command.cwd;
        command.processId = readProcessId(item?.processId) ?? command.processId;
        const aggregatedOutput = readString(item?.aggregatedOutput);
        if (aggregatedOutput !== undefined) {
          command.output = aggregatedOutput;
          command.truncatedChars = 0;
        }
        command.exitCode = readNumber(item?.exitCode);
        command.durationMs = readNumber(item?.durationMs);
        command.status = completedItemStatus(item?.status);
        command.terminal = true;
      } else if (readString(item?.type) === "fileChange") {
        const fileChange = ensureFileChange(turn, itemId, event.sequence);
        fileChange.changes = readFileChanges(item?.changes);
        fileChange.status = completedItemStatus(item?.status);
        fileChange.terminal = true;
      } else if (readString(item?.type) === "reasoning") {
        const reasoning = ensureReasoning(turn, itemId, event.sequence);
        reasoning.parts = readReasoningSummary(item?.summary);
        reasoning.status = completedItemStatus(item?.status, item?.error);
        reasoning.terminal = true;
      } else if (readString(item?.type) === "contextCompaction") {
        const compaction = ensureCompaction(turn, itemId, event.sequence, true);
        compaction.status = completedItemStatus(item?.status, item?.error);
        compaction.terminal = true;
      } else if (readString(item?.type) === "mcpToolCall") {
        const mcpCall = ensureMcpCall(turn, itemId, event.sequence);
        mcpCall.server = readString(item?.server) ?? mcpCall.server;
        mcpCall.tool = readString(item?.tool) ?? mcpCall.tool;
        mcpCall.arguments = item?.arguments ?? mcpCall.arguments;
        mcpCall.result = item?.result;
        mcpCall.error = item?.error;
        mcpCall.durationMs = readNumber(item?.durationMs);
        mcpCall.status = completedItemStatus(item?.status, item?.error);
        mcpCall.terminal = true;
      } else if (readString(item?.type) === "plan") {
        if (terminalTurnItemStatus(turn.status) || turn.plan?.terminal) continue;
        const plan = turn.plan ?? { steps: [] };
        delete plan.draftText;
        plan.finalText = readString(item?.text) ?? "";
        plan.terminal = true;
        turn.plan = plan;
      }
    } else if (event.method === "item/started") {
      const item = eventItem(event);
      const itemId = eventItemId(event);
      if (!itemId) continue;
      turn = ensureTurn(event, turnId);
      if (readString(item?.type) === "commandExecution") {
        const command = ensureCommand(turn, itemId, event.sequence);
        command.command = readString(item?.command) ?? command.command;
        command.cwd = readString(item?.cwd) ?? command.cwd;
        command.processId = readProcessId(item?.processId) ?? command.processId;
        if (!command.terminal) command.status = "running";
      } else if (readString(item?.type) === "fileChange") {
        const fileChange = ensureFileChange(turn, itemId, event.sequence);
        if (!fileChange.terminal) {
          fileChange.changes = readFileChanges(item?.changes);
          fileChange.status = "running";
        }
      } else if (readString(item?.type) === "reasoning") {
        const reasoning = ensureReasoning(turn, itemId, event.sequence);
        if (!reasoning.terminal) {
          reasoning.parts = readReasoningSummary(item?.summary);
          reasoning.status = "running";
        }
      } else if (readString(item?.type) === "contextCompaction") {
        const compaction = ensureCompaction(turn, itemId, event.sequence, true);
        if (!compaction.terminal) compaction.status = "running";
      } else if (readString(item?.type) === "mcpToolCall") {
        const mcpCall = ensureMcpCall(turn, itemId, event.sequence);
        mcpCall.server = readString(item?.server) ?? mcpCall.server;
        mcpCall.tool = readString(item?.tool) ?? mcpCall.tool;
        mcpCall.arguments = item?.arguments ?? mcpCall.arguments;
        if (!mcpCall.terminal) mcpCall.status = "running";
      }
    }
    const projectedTurn = turns[codexTurnKey(event.sessionId, turnId)];
    if (projectedTurn) terminalizeTurnItems(projectedTurn);
  }

  for (const turn of Object.values(turns)) {
    turn.visibleCount =
      (turn.plan ? 1 : 0) +
      Object.keys(turn.commands).length +
      Object.keys(turn.fileChanges).length +
      Object.keys(turn.mcpCalls).length +
      Object.keys(turn.reasoning).length +
      Object.keys(turn.compactions).length +
      turn.notices.length +
      (turn.turnDiff ? 1 : 0);
  }

  const boundedUnknown =
    unknown.length <= CODEX_UNKNOWN_ACTIVITY_LIMIT
      ? unknown
      : [
          ...unknown.slice(0, CODEX_UNKNOWN_ACTIVITY_LIMIT / 2),
          ...unknown.slice(-CODEX_UNKNOWN_ACTIVITY_LIMIT / 2),
        ];

  return {
    turns,
    turnOrder,
    unknown: boundedUnknown,
    hasMore: options.hasMore === true,
    unknownTruncated: unknown.length - boundedUnknown.length,
  };
}
