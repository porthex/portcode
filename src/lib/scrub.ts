// Redaction for the telemetry `beforeSend` hook — the privacy core of crash
// reporting. Portcode holds OAuth tokens, keyring/Noise secrets, and API keys, and
// streams prompts/code/shell I/O through the agent; NONE of that may ever reach
// Sentry. We therefore take an ALLOWLIST stance: an outgoing event is rebuilt from
// a small set of known-safe fields, and then every surviving string is run through
// `redactSecrets` as belt-and-suspenders. This module imports nothing from Sentry
// at runtime (types only), so it can't itself emit and is trivially unit-tested.
//
// Philosophy: over-redact. A false-positive redaction costs a slightly less
// precise stack frame; a false negative leaks a user's secret. We always choose
// the former.

import type { ErrorEvent, Breadcrumb, StackFrame } from "@sentry/react";

/** Hard cap on a string before regex work. Two jobs: (1) bounds any super-linear
 *  regex so a giant crash string can't freeze the main thread (defense-in-depth
 *  alongside the non-backtracking patterns below), and (2) prevents an accidental
 *  full-file/full-prompt dump from riding out inside an exception message. */
const MAX_REDACT_LEN = 2048;

/** Ordered redaction passes. Specific secrets first, then identifying paths, then
 *  a catch-all for key-shaped blobs. Applied to EVERY string we keep.
 *
 *  Regex notes (all verified linear / non-backtracking on capped input):
 *   - The email pattern uses dot-free labels (`[A-Za-z0-9-]+` joined by literal
 *     `\.`) so the domain side can't ambiguously overlap the TLD — the classic
 *     ReDoS shape this replaced. The local-part `+` is bounded by MAX_REDACT_LEN.
 *   - The key catch-all has NO `\b` anchor (a `\b` is absent between two word
 *     chars, so a key glued to a preceding identifier would escape) and includes
 *     base64URL chars (`-` `_`) plus hex — so Noise/iroh/JWT keys all match. */
const REDACTORS: ReadonlyArray<readonly [RegExp, string]> = [
  // Anthropic keys (sk-ant-oat…/sk-ant-api…) — tolerant of base64url `-_`.
  [/sk-ant-[A-Za-z0-9_-]{6,}/g, "[redacted-api-key]"],
  // Other `sk-` provider keys (OpenAI sk-proj_…, etc.). Leading `\b` so we don't
  // chew "sk-" inside a normal word like "task-…"; no trailing `\b` (it fails next
  // to `_`/`-`), tolerant of `_-`.
  [/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted-api-key]"],
  // Bearer / Authorization token values.
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted-token]"],
  [/("?(?:authorization|x-api-key|api[_-]?key)"?\s*[:=]\s*"?)[^"\s,}\]]+/gi, "$1[redacted]"],
  // Emails (non-overlapping labels — no catastrophic backtracking).
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[redacted-email]"],
  // IPv4 addresses.
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[redacted-ip]"],
  // User-identifying home directories → keep the shape, drop the username.
  //   C:\Users\Alice\…  ·  C:/Users/Alice/…
  [/([A-Za-z]:[\\/]Users[\\/])[^\\/]+/gi, "$1~user"],
  //   /home/alice/…  ·  /Users/alice/…
  [/(\/(?:home|Users)\/)[^/]+/g, "$1~user"],
  //   Android app-private dirs: /data/data/<pkg>/…  ·  /data/user/0/<pkg>/…
  [/(\/data\/(?:data|user\/\d+)\/)[^/]+/g, "$1~app"],
  // Key-shaped blobs (≥40 chars): standard base64, base64url (`-_`), or hex —
  // Noise/iroh keys, JWTs, tokens. No `\b` so word-char-adjacent keys still match.
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted-key]"],
];

/** Run every redaction pass over a string. Caps length first (ReDoS + dump guard),
 *  then applies each pass. Safe on any string. */
export function redactSecrets(value: string): string {
  const capped = value.length > MAX_REDACT_LEN;
  let out = capped ? value.slice(0, MAX_REDACT_LEN) : value;
  for (const [re, repl] of REDACTORS) out = out.replace(re, repl);
  return capped ? out + "…[truncated]" : out;
}

/** Only plain objects/arrays are safe to enumerate for redaction. A Map/Set/Date/
 *  class instance hides its payload from `Object.entries`, so we must not pass one
 *  through opaquely — `deepRedact` drops anything that isn't a plain object/array
 *  or a JSON primitive. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Deep-walk a value, redacting every string. Bounded in depth and breadth so a
 *  pathological event can't blow the stack or stall the main thread. Redacts
 *  strings; passes JSON primitives through; recurses plain objects/arrays; and
 *  DROPS everything else (functions, Map/Set/Date/typed-arrays/class instances) so
 *  a secret can't survive inside a container we can't safely enumerate. */
export function deepRedact<T>(value: T, depth = 0): T {
  if (depth > 8) return undefined as unknown as T;
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((v) => deepRedact(v, depth + 1)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "function") continue;
      out[k] = deepRedact(v, depth + 1);
    }
    return out as unknown as T;
  }
  // Non-plain object (Map/Set/Date/typed array/class instance) — can't enumerate
  // it safely, so drop it rather than risk leaking an unscrubbed payload.
  return undefined as unknown as T;
}

/** Keep only non-identifying frame fields; the filename is redacted (home dirs)
 *  and the absolute path / source context / local variables are dropped entirely
 *  (a `context_line` or `vars` can contain secrets or user code). */
function scrubFrame(frame: StackFrame): StackFrame {
  return {
    function: frame.function,
    filename: typeof frame.filename === "string" ? redactSecrets(frame.filename) : frame.filename,
    module: frame.module,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
  };
}

/** Keep a breadcrumb's shape (category/level/type/timestamp) and a redacted
 *  message, but DROP its `data` payload wholesale — that's where IPC args, URLs,
 *  and tool I/O would otherwise ride along. */
function scrubBreadcrumb(b: Breadcrumb): Breadcrumb {
  return {
    type: b.type,
    category: b.category,
    level: b.level,
    timestamp: b.timestamp,
    message: typeof b.message === "string" ? redactSecrets(b.message) : undefined,
  };
}

/**
 * The `beforeSend` transform. Rebuilds the event from an allowlist (exception
 * type + redacted value + scrubbed frames, scrubbed breadcrumbs, release/env),
 * explicitly strips the PII carriers Sentry would otherwise attach (server_name,
 * user, request, contexts.device, extra, tags, modules), then deep-redacts the
 * whole result. Returns `null` to drop the event if it somehow has no exception.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
  const safe: ErrorEvent = {
    // `ErrorEvent` carries a discriminant `type: undefined` (vs transaction events).
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    logger: event.logger,
    release: event.release,
    environment: event.environment,
    sdk: event.sdk,
    // Only the app/runtime/os *version* contexts — never device name (hostname).
    contexts: {
      app: event.contexts?.app,
      runtime: event.contexts?.runtime,
      os: event.contexts?.os ? { name: event.contexts.os.name } : undefined,
    },
  };

  if (event.exception?.values?.length) {
    safe.exception = {
      values: event.exception.values.map((v) => ({
        type: v.type,
        value: typeof v.value === "string" ? redactSecrets(v.value) : v.value,
        // Keep only the mechanism flags — NOT `mechanism.data`, which can carry a
        // request URL, file path, or syscall arg.
        mechanism: v.mechanism
          ? {
              type: v.mechanism.type,
              handled: v.mechanism.handled,
              synthetic: v.mechanism.synthetic,
            }
          : undefined,
        stacktrace: v.stacktrace
          ? { frames: (v.stacktrace.frames ?? []).map(scrubFrame) }
          : undefined,
      })),
    };
  } else if (event.message) {
    safe.message = redactSecrets(
      typeof event.message === "string" ? event.message : String(event.message),
    );
  } else {
    // No exception and no message — nothing actionable, and we won't risk leaking
    // whatever else was attached.
    return null;
  }

  if (event.breadcrumbs?.length) {
    safe.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  }

  // Belt-and-suspenders: deep-redact every remaining string. Even allowlisted
  // fields (e.g. a redacted message that still embeds a path) get a final pass.
  return deepRedact(safe);
}

/** Minimal shape of a performance span we keep. */
interface RawSpan {
  op?: string;
  description?: string;
  start_timestamp?: number;
  timestamp?: number;
  status?: string;
}

function scrubSpan(span: RawSpan): RawSpan {
  return {
    op: span.op,
    description:
      typeof span.description === "string" ? redactSecrets(span.description) : span.description,
    start_timestamp: span.start_timestamp,
    timestamp: span.timestamp,
    status: span.status,
  };
}

/**
 * The `beforeSendTransaction` transform — the performance-tracing counterpart to
 * `scrubEvent`. Transaction events are NOT exceptions, so they skip `beforeSend`
 * entirely; without this they'd ship transaction names + span descriptions (which
 * can embed URLs, file paths, or IPC args) unscrubbed. Same allowlist + redact +
 * deep-redact discipline. Generic over the concrete Sentry transaction type so the
 * caller keeps its exact typing.
 */
export function scrubTransaction<T>(event: T): T {
  const e = event as Record<string, unknown>;
  const trace = (e.contexts as { trace?: Record<string, unknown> } | undefined)?.trace;
  const safe: Record<string, unknown> = {
    type: "transaction",
    event_id: e.event_id,
    timestamp: e.timestamp,
    start_timestamp: e.start_timestamp,
    platform: e.platform,
    // The transaction NAME is the most likely place a route/path/arg leaks in.
    transaction: typeof e.transaction === "string" ? redactSecrets(e.transaction) : e.transaction,
    release: e.release,
    environment: e.environment,
    sdk: e.sdk,
    measurements: e.measurements,
    contexts: {
      app: (e.contexts as { app?: unknown } | undefined)?.app,
      runtime: (e.contexts as { runtime?: unknown } | undefined)?.runtime,
      // Keep the trace linkage but redact its human-readable description.
      trace: trace
        ? {
            op: trace.op,
            description:
              typeof trace.description === "string"
                ? redactSecrets(trace.description)
                : trace.description,
            trace_id: trace.trace_id,
            span_id: trace.span_id,
            parent_span_id: trace.parent_span_id,
            status: trace.status,
          }
        : undefined,
    },
    spans: Array.isArray(e.spans) ? (e.spans as RawSpan[]).map(scrubSpan) : undefined,
  };
  return deepRedact(safe) as unknown as T;
}
