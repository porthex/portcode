import { describe, it, expect } from "vitest";
import { redactSecrets, deepRedact, scrubEvent, scrubTransaction } from "./scrub";
import type { ErrorEvent } from "@sentry/react";

// The scrubber is the privacy gate for crash reporting — these tests are the
// contract that secrets NEVER survive into an outgoing event. House style mirrors
// the other lib tests.

describe("redactSecrets", () => {
  it("redacts Anthropic + generic sk- API keys", () => {
    expect(redactSecrets("key sk-ant-api03-abcDEF_12-34 end")).toBe("key [redacted-api-key] end");
    expect(redactSecrets("sk-0123456789abcdefABCDEF")).toBe("[redacted-api-key]");
  });

  it("redacts bearer tokens and auth headers", () => {
    expect(redactSecrets("Authorization: Bearer abc.def-ghi123")).toContain("[redacted-token]");
    expect(redactSecrets('"x-api-key":"supersecretvalue"')).toContain("[redacted]");
  });

  it("redacts emails", () => {
    expect(redactSecrets("contact a667066706670@gmail.com now")).toBe(
      "contact [redacted-email] now",
    );
  });

  it("strips the username from home directories on every OS shape", () => {
    expect(redactSecrets("C:\\Users\\Memphi$\\dev\\app")).toBe("C:\\Users\\~user\\dev\\app");
    expect(redactSecrets("C:/Users/Alice/file.ts")).toBe("C:/Users/~user/file.ts");
    expect(redactSecrets("/home/alice/code/x")).toBe("/home/~user/code/x");
    expect(redactSecrets("/Users/bob/x")).toBe("/Users/~user/x");
    expect(redactSecrets("/data/data/dev.porthex.portcode/files")).toBe("/data/data/~app/files");
    expect(redactSecrets("/data/user/0/dev.porthex.portcode/x")).toBe("/data/user/0/~app/x");
  });

  it("redacts key-shaped base64 blobs", () => {
    const key = "QStvZ2VuZXJhdGVkbG9uZ2Jhc2U2NGtleXZhbHVlMTIzNDU2Nzg5MA==";
    expect(redactSecrets(`pub=${key}`)).toBe("pub=[redacted-key]");
  });

  it("redacts base64URL keys (with - and _) and keys glued to a word char", () => {
    // 44-char base64url key containing - and _ (standard-base64 class would miss it).
    const urlKey = "ab-CD_efGHijKLmnOPqrSTuvWXyz0123456789-_ABCD";
    expect(redactSecrets(`k=${urlKey}`)).toBe("k=[redacted-key]");
    // No \b: a key immediately preceded by a word char must still be caught.
    expect(redactSecrets(`token${urlKey}`)).toContain("[redacted-key]");
    expect(redactSecrets(`token${urlKey}`)).not.toContain(urlKey);
  });

  it("redacts hex node ids and IPv4 addresses", () => {
    expect(
      redactSecrets("node e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b"),
    ).toContain("[redacted-key]");
    expect(redactSecrets("relay 192.168.1.42:443")).toBe("relay [redacted-ip]:443");
  });

  it("redacts non-anthropic sk- keys containing _ or -", () => {
    expect(redactSecrets("sk-proj_aB3dEf_GhIjKlMnOpQr")).toBe("[redacted-api-key]");
    // but does not chew 'sk-' inside an ordinary hyphenated word
    expect(redactSecrets("task-management-system-design")).toBe("task-management-system-design");
  });

  it("caps very long strings so a giant dump can't ride out (and resists ReDoS)", () => {
    const huge = "noreply@" + "a".repeat(50000); // also the old email-ReDoS shape
    const out = redactSecrets(huge);
    expect(out.length).toBeLessThan(3000);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("leaves ordinary text untouched", () => {
    expect(redactSecrets("TypeError: cannot read property 'x' of undefined")).toBe(
      "TypeError: cannot read property 'x' of undefined",
    );
  });
});

describe("deepRedact", () => {
  it("redacts strings nested in objects and arrays", () => {
    const out = deepRedact({ a: "sk-ant-secret123456", b: [{ c: "/home/alice/x" }] });
    expect(out).toEqual({ a: "[redacted-api-key]", b: [{ c: "/home/~user/x" }] });
  });

  it("drops functions and caps depth", () => {
    const out = deepRedact({ fn: () => 1, n: 5, ok: true }) as Record<string, unknown>;
    expect("fn" in out).toBe(false);
    expect(out.n).toBe(5);
    expect(out.ok).toBe(true);
  });

  it("drops non-plain objects (Map/Set/Date) it cannot safely enumerate", () => {
    const secretMap = new Map([["k", "sk-ant-hidden123456"]]);
    const out = deepRedact({ a: secretMap, b: new Set(["sk-ant-set123456"]), c: "ok" }) as Record<
      string,
      unknown
    >;
    // The containers are dropped wholesale — their (unscrubbable) contents can't leak.
    expect(out.a).toBeUndefined();
    expect(out.b).toBeUndefined();
    expect(out.c).toBe("ok");
    expect(JSON.stringify(out)).not.toContain("sk-ant-");
  });
});

// Build an event laced with every kind of secret in every place Sentry would
// otherwise carry one.
function pollutedEvent(): ErrorEvent {
  return {
    event_id: "e1",
    level: "error",
    server_name: "DESKTOP-SECRET",
    user: { email: "a667066706670@gmail.com", ip_address: "1.2.3.4" },
    request: { headers: { Authorization: "Bearer abc.def123" } },
    extra: { prompt: "write my novel about sk-ant-leak999999" },
    tags: { apiKey: "sk-ant-tagleak123456" },
    contexts: { device: { name: "Memphis-PC" }, app: { app_version: "5.0.0" } },
    breadcrumbs: [
      {
        category: "ipc",
        message: "phone_sync_connect /home/alice/secret",
        data: { qr: "sk-ant-bc-leak123456", token: "Bearer zzz" },
      },
    ],
    exception: {
      values: [
        {
          type: "TypeError",
          value: "boom with key sk-ant-msg-leak123456",
          stacktrace: {
            frames: [
              {
                function: "scan",
                filename: "C:\\Users\\Memphi$\\app\\scanner.ts",
                abs_path: "C:\\Users\\Memphi$\\app\\scanner.ts",
                lineno: 10,
                colno: 2,
                in_app: true,
                vars: { apiKey: "sk-ant-frame-leak123456" },
                context_line: "const k = 'sk-ant-ctx-leak123456'",
              },
            ],
          },
        },
      ],
    },
  } as unknown as ErrorEvent;
}

describe("scrubEvent", () => {
  it("never lets any planted secret survive anywhere in the output", () => {
    const out = scrubEvent(pollutedEvent());
    const blob = JSON.stringify(out);
    for (const secret of [
      "sk-ant-leak999999",
      "sk-ant-tagleak123456",
      "sk-ant-bc-leak123456",
      "sk-ant-msg-leak123456",
      "sk-ant-frame-leak123456",
      "sk-ant-ctx-leak123456",
      "a667066706670@gmail.com",
      "Memphi$",
      "Memphis-PC",
      "DESKTOP-SECRET",
      "1.2.3.4",
    ]) {
      expect(blob).not.toContain(secret);
    }
  });

  it("drops the PII carriers Sentry attaches by default", () => {
    const out = scrubEvent(pollutedEvent()) as unknown as Record<string, unknown>;
    expect(out.server_name).toBeUndefined();
    expect(out.user).toBeUndefined();
    expect(out.request).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(out.tags).toBeUndefined();
    // device.name (hostname) is dropped; the app version context is kept.
    const contexts = out.contexts as { device?: unknown; app?: { app_version?: string } };
    expect(contexts.device).toBeUndefined();
    expect(contexts.app?.app_version).toBe("5.0.0");
  });

  it("keeps the actionable bits: error type and app-relative frame", () => {
    const out = scrubEvent(pollutedEvent());
    const frame = out?.exception?.values?.[0]?.stacktrace?.frames?.[0];
    expect(out?.exception?.values?.[0]?.type).toBe("TypeError");
    expect(frame?.function).toBe("scan");
    expect(frame?.filename).toBe("C:\\Users\\~user\\app\\scanner.ts");
    // source context + locals + abs_path are dropped wholesale.
    expect(frame).not.toHaveProperty("vars");
    expect(frame).not.toHaveProperty("context_line");
    expect(frame).not.toHaveProperty("abs_path");
  });

  it("scrubs breadcrumbs: redacts the message, drops the data payload", () => {
    const out = scrubEvent(pollutedEvent());
    const bc = out?.breadcrumbs?.[0] as Record<string, unknown>;
    expect(bc.message).toBe("phone_sync_connect /home/~user/secret");
    expect(bc.data).toBeUndefined();
  });

  it("keeps exception.mechanism flags but drops mechanism.data (paths/urls)", () => {
    const ev = {
      event_id: "m1",
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            mechanism: {
              type: "onunhandledrejection",
              handled: false,
              synthetic: true,
              data: { url: "https://api/x?token=sk-ant-mechleak123456", path: "/home/bob/p" },
            },
            stacktrace: { frames: [] },
          },
        ],
      },
    } as unknown as ErrorEvent;
    const out = scrubEvent(ev);
    const mech = out?.exception?.values?.[0]?.mechanism as unknown as Record<string, unknown>;
    expect(mech.type).toBe("onunhandledrejection");
    expect(mech.handled).toBe(false);
    expect(mech.synthetic).toBe(true);
    expect(mech.data).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("sk-ant-mechleak123456");
  });

  it("redacts a message-only event", () => {
    const ev = { event_id: "m", message: "fail sk-ant-msgonly123456" } as unknown as ErrorEvent;
    const out = scrubEvent(ev) as unknown as Record<string, unknown>;
    expect(out.message).toBe("fail [redacted-api-key]");
  });

  it("drops an event with neither exception nor message", () => {
    expect(scrubEvent({ event_id: "x" } as unknown as ErrorEvent)).toBeNull();
  });
});

describe("scrubTransaction (performance events)", () => {
  function pollutedTransaction() {
    return {
      type: "transaction",
      event_id: "t1",
      transaction: "GET /home/alice/secret?key=sk-ant-txn-leak123456",
      server_name: "DESKTOP-SECRET",
      user: { email: "a667066706670@gmail.com" },
      contexts: {
        app: { app_version: "5.0.0" },
        device: { name: "Memphis-PC" },
        trace: { op: "navigation", description: "load sk-ant-trace-leak123456", trace_id: "abc" },
      },
      spans: [
        {
          op: "http.client",
          description: "POST https://x/api Bearer tok.en-secret123",
          data: { token: "sk-ant-span-leak123456" },
          status: "ok",
        },
      ],
    };
  }

  it("never lets a planted secret survive a transaction", () => {
    const blob = JSON.stringify(scrubTransaction(pollutedTransaction()));
    for (const secret of [
      "sk-ant-txn-leak123456",
      "sk-ant-trace-leak123456",
      "sk-ant-span-leak123456",
      "a667066706670@gmail.com",
      "Memphis-PC",
      "DESKTOP-SECRET",
      "alice",
    ]) {
      expect(blob).not.toContain(secret);
    }
  });

  it("keeps the useful perf shape and drops PII + span data", () => {
    const out = scrubTransaction(pollutedTransaction()) as Record<string, unknown>;
    expect(out.type).toBe("transaction");
    expect(out.transaction).toBe("GET /home/~user/secret?key=[redacted-api-key]");
    expect(out.server_name).toBeUndefined();
    expect(out.user).toBeUndefined();
    const contexts = out.contexts as { device?: unknown; trace?: { op?: string } };
    expect(contexts.device).toBeUndefined();
    expect(contexts.trace?.op).toBe("navigation");
    const span = (out.spans as Array<Record<string, unknown>>)[0];
    expect(span.op).toBe("http.client");
    expect(span.data).toBeUndefined();
  });
});
