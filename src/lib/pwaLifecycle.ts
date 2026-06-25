// Session-persistence core for the iOS web client (docs/IOS_WEB_CLIENT_PLAN.md §5.8).
//
// iOS is hostile to long-lived connections in a web app. When the user backgrounds
// the tab (switches apps, locks the phone, or even just swipes to the home screen),
// WebKit suspends the JavaScript context within a few seconds and DROPS any open
// socket. There is no keep-alive, no grace period, and crucially no reliable event
// that fires *as* the connection dies — by the time we'd notice, the JS context is
// already frozen. So we cannot rely on the socket's own error/close handlers to tell
// us we've been disconnected.
//
// The strategy this module encodes is therefore defensive on both edges:
//
//   1. On HIDE (visibilitychange → "hidden"): proactively tear the connection down
//      ourselves. We're about to be suspended and the socket is as good as dead; an
//      orderly teardown avoids leaking a half-open connection and lets the server
//      reclaim resources promptly instead of waiting for its own timeout.
//
//   2. On RESUME (visibilitychange → "visible", `pageshow`, or `online`): treat the
//      connection as dead — never trust that it survived — and reconnect from
//      scratch. We listen to all three signals because iOS is inconsistent about
//      which one it delivers: `pageshow` fires when a page is restored from the
//      back/forward (b-f) cache, `visibilitychange` fires on tab focus, and `online`
//      fires when the radio comes back after airplane mode / a dead zone. Any of them
//      means "you might have been gone; re-establish."
//
// Everything here is dependency-injected (DOM targets via the ambient globals,
// timers and RNG via parameters) so the whole lifecycle can be driven deterministically
// from jsdom tests with fake timers and a fixed RNG. Following the house style (see
// scanner.ts), nothing in this module throws for environmental reasons: a missing
// `document`/`window` (SSR, prerender, non-browser test) simply yields a no-op
// subscription rather than an exception.

/** Callbacks the lifecycle watcher invokes. `onResume` is the important one — it
 *  fires whenever the app may have been suspended and the connection should be
 *  rebuilt. `onHide` is optional and fires when the app is being backgrounded, the
 *  moment to proactively tear the connection down. */
export interface LifecycleHandlers {
  onResume: () => void;
  onHide?: () => void;
}

/**
 * Subscribe to the browser lifecycle signals that bracket an iOS suspend/resume.
 *
 * Wires up:
 *   - `document` "visibilitychange" → `onResume` when `visibilityState === "visible"`,
 *     `onHide` when "hidden".
 *   - `window` "pageshow" → `onResume` (b-f cache restore).
 *   - `window` "online" → `onResume` (radio came back).
 *
 * Returns an unsubscribe function that removes ALL of the listeners it added. Safe to
 * call in any environment: if `document` or `window` is absent the relevant listeners
 * are simply skipped, and the returned unsubscribe is still callable.
 */
export function watchLifecycle(handlers: LifecycleHandlers): () => void {
  const doc = typeof document === "undefined" ? undefined : document;
  const win = typeof window === "undefined" ? undefined : window;

  const onVisibility = (): void => {
    // jsdom and browsers both expose visibilityState; default to "visible" so a
    // synthetic event without the property is treated as a resume, not a hide.
    if (doc?.visibilityState === "hidden") {
      handlers.onHide?.();
    } else {
      handlers.onResume();
    }
  };
  const onResume = (): void => {
    handlers.onResume();
  };

  doc?.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("pageshow", onResume);
  win?.addEventListener("online", onResume);

  return () => {
    doc?.removeEventListener("visibilitychange", onVisibility);
    win?.removeEventListener("pageshow", onResume);
    win?.removeEventListener("online", onResume);
  };
}

/** Tuning for the exponential backoff. All fields optional; see defaults below. */
export interface BackoffOptions {
  /** Delay for attempt 0 before jitter, in ms. Default 1000. */
  baseMs?: number;
  /** Ceiling the un-jittered delay is capped at, in ms. Default 30000. */
  maxMs?: number;
  /** Growth factor between attempts. Default 2 (classic exponential). */
  factor?: number;
  /** Random source in [0, 1). Injectable for deterministic tests. Default Math.random. */
  rng?: () => number;
}

const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  baseMs: 1000,
  maxMs: 30000,
  factor: 2,
  rng: Math.random,
};

/**
 * Delay (ms) before reconnect attempt `attempt` (0-based).
 *
 * The un-jittered delay grows exponentially — `baseMs * factor^attempt` — capped at
 * `maxMs`. We then apply **full jitter**: the returned delay is a uniform random value
 * in `[0, capped]`, computed as `rng() * capped`. Full jitter (rather than
 * `capped/2 + rng()*capped/2` "equal jitter") is the AWS-recommended choice for
 * de-correlating a thundering herd: if many clients were suspended by the same event
 * (e.g. the phone woke from sleep) they'd otherwise all retry in lockstep and stampede
 * the server. Spreading uniformly across the whole window minimizes that collision
 * probability. Because the jitter is `rng() * capped`, tests can pin it exactly:
 * `rng: () => 1` yields the capped ceiling, `rng: () => 0` yields 0.
 */
export function nextBackoffDelay(attempt: number, opts?: BackoffOptions): number {
  const { baseMs, maxMs, factor, rng } = { ...DEFAULT_BACKOFF, ...opts };
  const capped = Math.min(maxMs, baseMs * Math.pow(factor, attempt));
  return rng() * capped;
}

/** A running reconnect loop. `start` kicks it off; `stop` cancels any pending retry.
 *  `attempts` reflects how many retries have been scheduled since the last success. */
export interface ReconnectController {
  start(): void;
  stop(): void;
  readonly attempts: number;
}

/**
 * Build a reconnect controller that retries `connect()` with exponential backoff +
 * full jitter until it succeeds or `maxAttempts` is exhausted.
 *
 * Behaviour:
 *   - `start()` calls `connect()` immediately. On rejection it schedules a retry after
 *     `nextBackoffDelay(attempts)` via the injected `setTimeoutFn`, incrementing
 *     `attempts`. On resolve it resets `attempts` to 0 and stops retrying.
 *   - If `attempts` reaches `maxAttempts` (when provided), it calls `onGiveUp` once and
 *     stops instead of scheduling another retry.
 *   - `stop()` cancels any pending timer via `clearTimeoutFn`.
 *
 * Timers are injected (defaulting to the global `setTimeout`/`clearTimeout`) so tests
 * can drive the loop with fake timers or by capturing the scheduled callbacks directly.
 */
export function createReconnectController(opts: {
  connect: () => Promise<void>;
  onGiveUp?: () => void;
  maxAttempts?: number;
  backoff?: BackoffOptions;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): ReconnectController {
  const {
    connect,
    onGiveUp,
    maxAttempts,
    backoff,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = opts;

  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Guards against a connect() promise that resolves/rejects after stop(): a late
  // settlement must not schedule a new retry on a controller the caller has torn down.
  let running = false;
  // A monotonically-increasing token identifying the CURRENT run. Both start() and
  // stop() bump it, so any connect() continuation captured by an older run can detect
  // that it has been superseded and bail. Without this, a late settlement from a
  // stopped run (or a previous start→stop→start cycle) could cancel the timer or
  // schedule a retry belonging to a newer run.
  let runId = 0;

  const cancelTimer = (): void => {
    if (timer !== undefined) {
      clearTimeoutFn(timer);
      timer = undefined;
    }
  };

  const attempt = (id: number): void => {
    if (!running || id !== runId) return;
    void connect().then(
      () => {
        // Bail unless this continuation belongs to the still-running current run.
        if (!running || id !== runId) return;
        // Success: forget the failure history and idle. A future suspend/resume will
        // call start() again.
        attempts = 0;
        running = false;
        cancelTimer();
      },
      () => {
        if (!running || id !== runId) return;
        if (maxAttempts !== undefined && attempts >= maxAttempts) {
          running = false;
          cancelTimer();
          onGiveUp?.();
          return;
        }
        const delay = nextBackoffDelay(attempts, backoff);
        attempts += 1;
        timer = setTimeoutFn(() => attempt(id), delay);
      },
    );
  };

  return {
    start(): void {
      if (running) return;
      // A fresh run: bump the token and reset the failure history so attempts can't
      // leak across a previous stop→start. Any older run's continuation now sees a
      // stale id and no-ops.
      runId += 1;
      attempts = 0;
      running = true;
      attempt(runId);
    },
    stop(): void {
      // Bump the token so a connect() still in flight from this run bails on
      // settlement, and reset attempts so a later start() begins clean.
      runId += 1;
      running = false;
      attempts = 0;
      cancelTimer();
    },
    get attempts(): number {
      return attempts;
    },
  };
}
