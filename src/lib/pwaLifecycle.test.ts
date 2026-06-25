import { afterEach, describe, expect, it, vi } from "vitest";
import { createReconnectController, nextBackoffDelay, watchLifecycle } from "./pwaLifecycle";

/** Force document.visibilityState for the next dispatched visibilitychange. */
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
}

describe("watchLifecycle", () => {
  afterEach(() => {
    setVisibility("visible");
  });

  it("fires onResume on visibilitychange→visible, pageshow, and online", () => {
    const onResume = vi.fn();
    const onHide = vi.fn();
    const unsub = watchLifecycle({ onResume, onHide });

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onResume).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("pageshow"));
    expect(onResume).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event("online"));
    expect(onResume).toHaveBeenCalledTimes(3);

    expect(onHide).not.toHaveBeenCalled();
    unsub();
  });

  it("fires onHide on visibilitychange→hidden", () => {
    const onResume = vi.fn();
    const onHide = vi.fn();
    const unsub = watchLifecycle({ onResume, onHide });

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
    unsub();
  });

  it("tolerates a missing optional onHide handler when hidden", () => {
    const onResume = vi.fn();
    const unsub = watchLifecycle({ onResume });

    setVisibility("hidden");
    expect(() => document.dispatchEvent(new Event("visibilitychange"))).not.toThrow();
    expect(onResume).not.toHaveBeenCalled();
    unsub();
  });

  it("unsubscribe removes every listener", () => {
    const onResume = vi.fn();
    const onHide = vi.fn();
    const unsub = watchLifecycle({ onResume, onHide });
    unsub();

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("online"));
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(onResume).not.toHaveBeenCalled();
    expect(onHide).not.toHaveBeenCalled();
  });

  it("is a no-op (and returns a callable unsubscribe) without document/window", () => {
    const origDoc = globalThis.document;
    const origWin = globalThis.window;
    // @ts-expect-error simulate non-browser environment
    delete globalThis.document;
    // @ts-expect-error simulate non-browser environment
    delete globalThis.window;
    try {
      const onResume = vi.fn();
      const unsub = watchLifecycle({ onResume });
      expect(() => unsub()).not.toThrow();
      expect(onResume).not.toHaveBeenCalled();
    } finally {
      globalThis.document = origDoc;
      globalThis.window = origWin;
    }
  });
});

describe("nextBackoffDelay", () => {
  it("returns the capped ceiling with rng()=1", () => {
    expect(nextBackoffDelay(0, { rng: () => 1 })).toBe(1000);
    expect(nextBackoffDelay(2, { rng: () => 1 })).toBe(4000);
  });

  it("returns 0 with rng()=0", () => {
    expect(nextBackoffDelay(5, { rng: () => 0 })).toBe(0);
  });

  it("caps at maxMs for large attempts", () => {
    expect(nextBackoffDelay(100, { rng: () => 1 })).toBe(30000);
    expect(nextBackoffDelay(100, { rng: () => 1, maxMs: 5000 })).toBe(5000);
  });

  it("grows exponentially before the cap", () => {
    const r = { rng: () => 1 };
    const d0 = nextBackoffDelay(0, r);
    const d1 = nextBackoffDelay(1, r);
    const d2 = nextBackoffDelay(2, r);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });

  it("honours custom base/factor and applies jitter via rng", () => {
    expect(nextBackoffDelay(1, { baseMs: 100, factor: 3, rng: () => 0.5 })).toBe(150); // 100 * 3^1 = 300, * 0.5 = 150
  });

  it("uses defaults (Math.random) when no opts given", () => {
    const d = nextBackoffDelay(0);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(1000);
  });
});

/** A manual timer stub: captures scheduled callbacks so the test can invoke them. */
function makeTimerStub() {
  const scheduled: Array<{ id: number; cb: () => void; delay: number }> = [];
  let nextId = 1;
  const cleared: number[] = [];
  const setTimeoutFn = ((cb: () => void, delay?: number) => {
    const id = nextId++;
    scheduled.push({ id, cb, delay: delay ?? 0 });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id?: ReturnType<typeof setTimeout>) => {
    if (id !== undefined) cleared.push(id as unknown as number);
  }) as unknown as typeof clearTimeout;
  return { scheduled, cleared, setTimeoutFn, clearTimeoutFn };
}

describe("createReconnectController", () => {
  it("increments attempts on each rejection, resets to 0 on success", async () => {
    const timers = makeTimerStub();
    let calls = 0;
    const connect = vi.fn(() => {
      calls += 1;
      return calls <= 2 ? Promise.reject(new Error("nope")) : Promise.resolve();
    });
    const ctrl = createReconnectController({
      connect,
      backoff: { rng: () => 1 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    ctrl.start();
    await Promise.resolve();
    expect(ctrl.attempts).toBe(1); // first reject scheduled retry 0
    expect(timers.scheduled).toHaveLength(1);
    expect(timers.scheduled[0].delay).toBe(1000); // nextBackoffDelay(0) capped

    timers.scheduled[0].cb(); // run retry → second reject
    await Promise.resolve();
    expect(ctrl.attempts).toBe(2);
    expect(timers.scheduled).toHaveLength(2);
    expect(timers.scheduled[1].delay).toBe(2000); // nextBackoffDelay(1)

    timers.scheduled[1].cb(); // run retry → resolve
    await Promise.resolve();
    expect(ctrl.attempts).toBe(0); // success resets
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("calls onGiveUp and stops once maxAttempts is reached", async () => {
    const timers = makeTimerStub();
    const onGiveUp = vi.fn();
    const connect = vi.fn(() => Promise.reject(new Error("always")));
    const ctrl = createReconnectController({
      connect,
      onGiveUp,
      maxAttempts: 2,
      backoff: { rng: () => 0 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    ctrl.start();
    await Promise.resolve(); // reject #1 → attempts 1
    timers.scheduled[0].cb();
    await Promise.resolve(); // reject #2 → attempts 2
    timers.scheduled[1].cb();
    await Promise.resolve(); // reject #3 → attempts >= max → give up

    expect(ctrl.attempts).toBe(2);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(timers.scheduled).toHaveLength(2); // no further retry scheduled
  });

  it("tolerates maxAttempts give-up without an onGiveUp callback", async () => {
    const timers = makeTimerStub();
    const connect = vi.fn(() => Promise.reject(new Error("x")));
    const ctrl = createReconnectController({
      connect,
      maxAttempts: 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    ctrl.start();
    await Promise.resolve();
    expect(ctrl.attempts).toBe(0);
    expect(timers.scheduled).toHaveLength(0);
  });

  it("stop() cancels a pending timer", async () => {
    const timers = makeTimerStub();
    const connect = vi.fn(() => Promise.reject(new Error("nope")));
    const ctrl = createReconnectController({
      connect,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    ctrl.start();
    await Promise.resolve();
    expect(timers.scheduled).toHaveLength(1);
    const id = timers.scheduled[0].id;

    ctrl.stop();
    expect(timers.cleared).toContain(id);
  });

  it("ignores a late resolve after stop()", async () => {
    const timers = makeTimerStub();
    let resolveFn: () => void = () => {};
    const connect = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveFn = res;
        }),
    );
    const ctrl = createReconnectController({
      connect,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    ctrl.start();
    ctrl.stop();
    resolveFn(); // settles after stop — must be ignored
    await Promise.resolve();
    expect(ctrl.attempts).toBe(0);
    expect(timers.scheduled).toHaveLength(0);
  });

  it("ignores a late reject after stop()", async () => {
    const timers = makeTimerStub();
    let rejectFn: (e: unknown) => void = () => {};
    const connect = vi.fn(
      () =>
        new Promise<void>((_res, rej) => {
          rejectFn = rej;
        }),
    );
    const ctrl = createReconnectController({
      connect,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    ctrl.start();
    ctrl.stop();
    rejectFn(new Error("late"));
    await Promise.resolve();
    expect(ctrl.attempts).toBe(0);
    expect(timers.scheduled).toHaveLength(0);
  });

  it("isolates runs: a late connect() from a stopped run can't cancel/reschedule the new run", async () => {
    // Regression: stop() then start(), with the FIRST run's connect() settling late.
    // The stale settlement must not touch the second run's timer/attempts.
    const timers = makeTimerStub();
    const resolvers: Array<{ res: () => void; rej: (e: unknown) => void }> = [];
    const connect = vi.fn(
      () =>
        new Promise<void>((res, rej) => {
          resolvers.push({ res, rej });
        }),
    );
    const ctrl = createReconnectController({
      connect,
      backoff: { rng: () => 1 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    ctrl.start(); // run #1: connect() #1 is now pending
    expect(connect).toHaveBeenCalledTimes(1);

    ctrl.stop(); // tear run #1 down before it settles
    ctrl.start(); // run #2: connect() #2 pending
    expect(connect).toHaveBeenCalledTimes(2);

    // Now the FIRST run's connect rejects LATE. It belongs to a superseded run, so it
    // must NOT schedule a retry (no new timer) nor disturb run #2.
    resolvers[0].rej(new Error("late from run #1"));
    await Promise.resolve();
    await Promise.resolve();
    expect(timers.scheduled).toHaveLength(0);
    expect(ctrl.attempts).toBe(0);

    // Run #2's own connect rejecting DOES schedule a retry — it's the live run.
    resolvers[1].rej(new Error("run #2 fail"));
    await Promise.resolve();
    await Promise.resolve();
    expect(timers.scheduled).toHaveLength(1);
    expect(ctrl.attempts).toBe(1);
    ctrl.stop();
  });

  it("resets attempts across a stop→start cycle (no leak)", async () => {
    const timers = makeTimerStub();
    const connect = vi.fn(() => Promise.reject(new Error("always")));
    const ctrl = createReconnectController({
      connect,
      backoff: { rng: () => 1 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    ctrl.start();
    await Promise.resolve();
    expect(ctrl.attempts).toBe(1); // one failure recorded
    ctrl.stop();
    expect(ctrl.attempts).toBe(0); // stop resets
    ctrl.start();
    expect(ctrl.attempts).toBe(0); // fresh run starts clean
    ctrl.stop();
  });

  it("start() is idempotent while already running", () => {
    const timers = makeTimerStub();
    const connect = vi.fn(() => new Promise<void>(() => {})); // never settles
    const ctrl = createReconnectController({
      connect,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    ctrl.start();
    ctrl.start();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("stop() with no pending timer is a no-op", () => {
    const timers = makeTimerStub();
    const connect = vi.fn(() => new Promise<void>(() => {}));
    const ctrl = createReconnectController({
      connect,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    ctrl.start();
    ctrl.stop();
    ctrl.stop(); // second stop: timer already cleared
    expect(() => ctrl.stop()).not.toThrow();
  });

  it("defaults to the global setTimeout/clearTimeout when not injected", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const connect = vi.fn(() => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("once")) : Promise.resolve();
      });
      const ctrl = createReconnectController({
        connect,
        backoff: { rng: () => 1, baseMs: 10 },
      });
      ctrl.start();
      await Promise.resolve();
      expect(ctrl.attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
      expect(ctrl.attempts).toBe(0);
      expect(connect).toHaveBeenCalledTimes(2);
      ctrl.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
