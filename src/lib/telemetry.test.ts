import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// telemetry.ts gates the Sentry SDK behind consent AND a build-time DSN. We mock
// @sentry/react and toggle the DSN env to drive every gate branch. Like ipc.test,
// we reload the module per test because it keeps a module-level `active` flag.

vi.mock("@sentry/react", () => ({
  init: vi.fn(),
  close: vi.fn().mockResolvedValue(true),
  captureException: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: "BrowserTracing" })),
}));

const DSN = "https://abc@o1.ingest.sentry.io/1";

async function load() {
  vi.resetModules();
  const sentry = await import("@sentry/react");
  const telemetry = await import("./telemetry");
  return { sentry: vi.mocked(sentry), telemetry };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("initTelemetry gate", () => {
  it("does NOT init when consent is null (not yet asked), even with a DSN", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const { sentry, telemetry } = await load();
    expect(telemetry.initTelemetry(null)).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
    expect(telemetry.isTelemetryActive()).toBe(false);
  });

  it("does NOT init when consent is false", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const { sentry, telemetry } = await load();
    expect(telemetry.initTelemetry(false)).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("does NOT init when consent is true but no DSN was baked in", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    const { sentry, telemetry } = await load();
    expect(telemetry.initTelemetry(true)).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("inits with a scrubbing beforeSend + no default PII when consent + DSN present", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const { sentry, telemetry } = await load();
    expect(telemetry.initTelemetry(true)).toBe(true);
    expect(telemetry.isTelemetryActive()).toBe(true);
    expect(sentry.init).toHaveBeenCalledTimes(1);
    const opts = sentry.init.mock.calls[0][0]!;
    expect(opts.dsn).toBe(DSN);
    expect(opts.sendDefaultPii).toBe(false);
    expect(typeof opts.beforeSend).toBe("function");
    // Performance tracing is enabled, so transactions must be scrubbed too.
    expect(typeof opts.beforeSendTransaction).toBe("function");
    expect(opts.tracesSampleRate).toBeGreaterThan(0);
  });

  it("is idempotent — a second call does not re-init", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const { sentry, telemetry } = await load();
    telemetry.initTelemetry(true);
    expect(telemetry.initTelemetry(true)).toBe(true);
    expect(sentry.init).toHaveBeenCalledTimes(1);
  });

  it("beforeSend routes events through the scrubber (strips secrets)", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const { sentry, telemetry } = await load();
    telemetry.initTelemetry(true);
    const beforeSend = sentry.init.mock.calls[0][0]!.beforeSend!;
    const out = beforeSend(
      { event_id: "1", message: "leak sk-ant-secret123456" } as never,
      {} as never,
    ) as { message?: string };
    expect(out.message).toBe("leak [redacted-api-key]");
  });
});

describe("telemetryConfigured", () => {
  it("reflects whether a DSN was baked in", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    let { telemetry } = await load();
    expect(telemetry.telemetryConfigured()).toBe(false);

    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    ({ telemetry } = await load());
    expect(telemetry.telemetryConfigured()).toBe(true);
  });
});

describe("reportError / consent lifecycle", () => {
  it("reportError is a no-op until reporting is live", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const { sentry, telemetry } = await load();
    telemetry.reportError(new Error("x"));
    expect(sentry.captureException).not.toHaveBeenCalled();

    telemetry.initTelemetry(true);
    telemetry.reportError(new Error("y"));
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("opt-out drops events at beforeSend (no close); opt-in re-arms without a second init", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const { sentry, telemetry } = await load();
    telemetry.initTelemetry(true);
    const beforeSend = sentry.init.mock.calls[0][0]!.beforeSend!;
    // Live → event passes (scrubbed, not null).
    expect(beforeSend({ event_id: "1", message: "hi" } as never, {} as never)).not.toBeNull();

    telemetry.shutdownTelemetry();
    expect(telemetry.isTelemetryActive()).toBe(false);
    expect(sentry.close).not.toHaveBeenCalled(); // we deliberately never close()
    // Off → the SAME beforeSend now drops everything (incl. auto-instrumented events).
    expect(beforeSend({ event_id: "2", message: "leak" } as never, {} as never)).toBeNull();

    // Opt back in → live again, but NO second Sentry.init.
    expect(telemetry.initTelemetry(true)).toBe(true);
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(telemetry.isTelemetryActive()).toBe(true);
    expect(beforeSend({ event_id: "3", message: "ok" } as never, {} as never)).not.toBeNull();
  });

  it("beforeSendTransaction is consent-gated too", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
    const { sentry, telemetry } = await load();
    telemetry.initTelemetry(true);
    const bst = sentry.init.mock.calls[0][0]!.beforeSendTransaction!;
    const txn = { type: "transaction", event_id: "t", transaction: "load" } as never;
    expect(bst(txn, {} as never)).not.toBeNull();
    telemetry.shutdownTelemetry();
    expect(bst(txn, {} as never)).toBeNull();
  });
});
