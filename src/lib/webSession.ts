// Browser↔desktop transport boundary for the iOS web client.
//
// (See docs/IOS_WEB_CLIENT_PLAN.md §5.4/§5.6.)
//
// THE WASM BOUNDARY
// -----------------
// In the *shipped* web client, the phone-sync stack that normally lives in the
// Rust core (iroh dialing + Noise handshake + the SyncFrame channel) is compiled
// to WebAssembly via wasm-bindgen and exposed to JS as a `Session` class that
// connects over iroh-in-browser. That class is the real implementation of the
// {@link WebSession} interface defined below: it has a `sas`, a `peerPublicKey`,
// `sendCommand`, `onFrame`, `onDisconnected`, and `disconnect`.
//
// This module is deliberately transport-agnostic. It defines:
//   1. The {@link WebSession} / {@link WebSessionConnector} TypeScript interfaces
//      that the WASM `Session` class will satisfy.
//   2. A deterministic MOCK connector ({@link createMockConnector}) so the UI and
//      unit tests run with no WASM, no network, and no desktop peer.
//   3. A registry ({@link setWebSessionConnector} / {@link resetWebSessionConnector})
//      so the real WASM connector can be injected at app startup in the web build,
//      and tests can swap in a fake. The default connector is the mock.
//   4. A set of `webPhoneSync*` / `webOnPhoneSync*` wrappers shaped EXACTLY like
//      the phone-sync mobile-CLIENT functions in `src/lib/ipc.ts`
//      (`phoneSyncConnect` / `phoneSyncSendCommand` / `phoneSyncDisconnect` /
//      `onPhoneSyncFrame` / `onPhoneSyncDisconnected`). Mirroring that surface lets
//      ipc route to this module when running in web-client mode: the rest of the
//      app keeps calling one client API, and only the transport underneath changes.
//
// WIRING (web build)
// ------------------
// At startup the web entrypoint constructs the WASM-backed connector and calls
// `setWebSessionConnector(wasmConnector)`. From then on `webPhoneSyncConnect`
// dials through real iroh-in-browser. Until then (and in tests/preview) the
// default mock connector is used. The injection point is the ONLY place the real
// transport is referenced, so this module never imports wasm-bindgen glue.
//
// INVARIANTS
// ----------
// - Strict TypeScript; the public {@link WebSession} interface carries no
//   test-only hooks.
// - The wrappers manage a single module-level "current session" and are
//   idempotent / never throw on a missing session — matching ipc.ts's mock, where
//   send/disconnect on a nonexistent session are no-ops.

import type { ConnectInfo, RemoteCommand, SyncFrame } from "../types";

/** An unsubscribe handle. Defined locally to mirror `src/lib/ipc.ts`. */
export type Unlisten = () => void;

/**
 * A live browser↔desktop session. The WASM-bindgen `Session` class implements
 * this interface; {@link createMockConnector} returns an in-memory fake of it.
 *
 * `sas` / `peerPublicKey` / `vapidPublicKey` / `privateKey` are captured at
 * connect time (the short authentication string to compare out-of-band, the pinned
 * desktop key, the desktop's Web Push VAPID key, and the phone's own static private
 * key respectively), so they are readonly.
 */
export interface WebSession {
  readonly sas: string;
  readonly peerPublicKey: string;
  /**
   * The desktop's Web Push VAPID PUBLIC key (base64url), or `undefined` when the
   * desktop sent none (predates push, or the inert mock). The installed PWA passes
   * it as the `applicationServerKey` when subscribing to Web Push (§5.7).
   */
  readonly vapidPublicKey?: string;
  /**
   * The phone's own static private key generated during this dial (base64url), or
   * `undefined` when the wasm build predates the `privateKey` getter. Persisting
   * this and passing it back on the next `connect` (as `private_key`) lets wasm
   * resume a KK handshake against the same-phone identity instead of generating a
   * fresh static key each time, which would look like a different device to the
   * desktop. See wasm `Session.connect(qr, reconnect, private_key?)`.
   */
  readonly privateKey?: string;
  /** Send one command to the live desktop. */
  sendCommand(cmd: RemoteCommand): Promise<void>;
  /** Subscribe to frames forwarded from the desktop. Returns an unlisten handle. */
  onFrame(cb: (f: SyncFrame) => void): Unlisten;
  /** Subscribe to the "session dropped" signal. Returns an unlisten handle. */
  onDisconnected(cb: () => void): Unlisten;
  /**
   * Decline the pairing from the phone side: send a `pairing_reject` frame to the
   * desktop, then disconnect. Used when the user taps "It doesn't match — Cancel"
   * so the desktop learns the SAS was rejected (not just that the link dropped).
   */
  reject(): Promise<void>;
  /** Tear down the session. Idempotent. */
  disconnect(): Promise<void>;
}

/**
 * Opens {@link WebSession}s. The real implementation wraps the WASM `Session`
 * constructor (dial + handshake over iroh-in-browser); the mock fabricates a
 * deterministic session. `reconnect` selects the handshake prologue exactly like
 * `phoneSyncConnect` in ipc.ts (false = first pairing binds the QR nonce; true =
 * remembered-desktop reconnect binds an empty prologue). `privateKey` (optional)
 * is the phone's own static private key from a previous dial; passing it back lets
 * the wasm resume a KK handshake with the same identity rather than generating a
 * fresh key each time (see {@link WebSession.privateKey}).
 */
export interface WebSessionConnector {
  connect(qr: string, reconnect: boolean, privateKey?: string): Promise<WebSession>;
}

/**
 * The deterministic preview/test connector. Produces a {@link WebSession} with a
 * fixed SAS and peer key and an in-memory frame/disconnect callback registry:
 *
 * - `connect` ignores `qr`/`reconnect` and returns a session with the fixed
 *   identity below (matching ipc.ts's mock `phoneSyncConnect`).
 * - `onFrame` / `onDisconnected` store callbacks and return a real unlisten that
 *   removes them.
 * - `sendCommand` resolves (no-op: no real desktop receives it).
 * - `disconnect` resolves and notifies every registered disconnected callback,
 *   then clears the registries; it is idempotent (a second call notifies the now
 *   empty set, i.e. nobody).
 *
 * NOTE: frame *delivery* has no public trigger on {@link WebSession} — the mock
 * stores frame callbacks but never emits to them (the preview has no desktop). To
 * exercise frame delivery, tests supply their own connector whose session invokes
 * the stored callbacks. This keeps the shipped {@link WebSession} surface free of
 * test-only methods.
 */
export function createMockConnector(): WebSessionConnector {
  return {
    async connect(_qr: string, _reconnect: boolean, _privateKey?: string): Promise<WebSession> {
      const frameCbs = new Set<(f: SyncFrame) => void>();
      const disconnectedCbs = new Set<() => void>();

      return {
        sas: "MOCK-SAS-1234",
        peerPublicKey: "MOCK_DESKTOP_KEY_BASE64==",
        // No `vapidPublicKey`: a mock value decodes to the wrong byte length for a
        // P-256 `applicationServerKey`, which would make `PushManager.subscribe`
        // throw in any host that actually has push. Omitting it cleanly SKIPS the
        // push-subscribe path (the desktop's real key is supplied by the wasm
        // `Session` in the shipped client). See pushClient's `no-vapid-key` skip.
        async sendCommand(_cmd: RemoteCommand): Promise<void> {
          // no-op: the preview has no paired desktop to receive commands.
        },
        onFrame(cb: (f: SyncFrame) => void): Unlisten {
          frameCbs.add(cb);
          return () => {
            frameCbs.delete(cb);
          };
        },
        onDisconnected(cb: () => void): Unlisten {
          disconnectedCbs.add(cb);
          return () => {
            disconnectedCbs.delete(cb);
          };
        },
        async reject(): Promise<void> {
          // No real desktop to send the reject frame to; mirror `disconnect` so the
          // preview/test still tears the (inert) session down and notifies listeners.
          for (const cb of disconnectedCbs) cb();
          frameCbs.clear();
          disconnectedCbs.clear();
        },
        async disconnect(): Promise<void> {
          for (const cb of disconnectedCbs) cb();
          frameCbs.clear();
          disconnectedCbs.clear();
        },
      };
    },
  };
}

// ── Real WASM-backed connector ───────────────────────────────────────────────
//
// The shipped web client dials through the iroh-in-browser stack compiled to
// WebAssembly (`portcode-wasm`, built by CI per §6 — NOT present in this repo at
// test/build time). The package exposes a `Session` class shaped like §5.4:
// `Session.connect(qr, reconnect) -> Promise<Session>`, `sendCommand`, `onEvent`,
// `disconnect`, and a `peerPublicKey` getter. We adapt that to {@link WebSession}.
//
// Two things keep this safe to ship before the wasm exists:
//   1. The wasm package is imported LAZILY via a dynamic `import()` on the FIRST
//      `connect` (so the PWA shell paints before the hundreds-of-KB wasm chunk
//      loads, per §5.6), and the import specifier is INJECTABLE so tests never
//      resolve the real (absent) module.
//   2. If the import FAILS (module missing — the normal state here until CI wires
//      it) the connector logs once and FALLS BACK to the deterministic mock, so
//      `webPhoneSyncConnect` keeps resolving and the deployed PWA stays usable.

/**
 * The subset of the `portcode-wasm` `Session` class (§5.4) we depend on. Declared
 * structurally so this module never imports the wasm glue at type-check time.
 */
export interface WasmSession {
  readonly sas: string;
  readonly peerPublicKey: string;
  /** The desktop's Web Push VAPID PUBLIC key getter (added on the Rust `Session`
   *  alongside `peerPublicKey`); `undefined` when the desktop sent none. */
  readonly vapidPublicKey?: string;
  /**
   * The phone's own static private key (base64url) generated for this dial.
   * Exposed by the Rust `Session` so the JS layer can persist it across page
   * loads and pass it back on the next `connect` as `private_key?`, enabling
   * KK same-phone resume. Older wasm builds that don't expose this getter
   * return `undefined`; the adapter surfaces it as-is.
   */
  readonly privateKey?: string;
  sendCommand(cmd: RemoteCommand): void | Promise<void>;
  /** Register the inbound-frame callback; Rust invokes it per `SyncFrame`. */
  onEvent(cb: (f: SyncFrame) => void): void;
  /**
   * OPTIONAL: register a callback fired when the wasm side observes the transport
   * DROP on its own (relay/connection torn down), not just on a manual
   * `disconnect()`. Older wasm builds may not provide it, so it is optional and
   * guarded at the call site. When present, {@link adaptWasmSession} bridges it into
   * the `onDisconnected` fanout so a spontaneous drop reaches the store.
   */
  onDisconnected?(cb: () => void): void;
  /**
   * Decline the pairing: send the `PairingReject` frame, then disconnect. Added on
   * the Rust `Session` alongside `disconnect` (no args). The adapter calls this for
   * {@link WebSession.reject}; an older wasm build without it falls back to a plain
   * `disconnect()` so the channel still closes.
   */
  reject?(): void | Promise<void>;
  /** Tear down the session (drops the channel; ends the loops). */
  disconnect(): void | Promise<void>;
}

/** The shape of the `portcode-wasm` module: a `Session` class with a static
 *  `connect`. Only what we call is declared. `private_key?` matches the wasm
 *  binding's snake_case param name (from wasm-bindgen's JS glue) and is optional
 *  so callers without a persisted key omit it cleanly. */
export interface WasmModule {
  Session: {
    connect(qr: string, reconnect: boolean, private_key?: string): Promise<WasmSession>;
  };
}

/** Loads the `portcode-wasm` module. Injectable so tests supply a fake instead of
 *  resolving the real (CI-built, here-absent) package. */
export type WasmLoader = () => Promise<WasmModule>;

/**
 * The default {@link WasmLoader}: lazily loads the COMMITTED `portcode-wasm`
 * browser artifact under `web/wasm/portcode-wasm/` (built by `wasm-pack --target
 * web` and checked in — Vercel has no Rust, so the wasm must be prebuilt; see that
 * dir's README and the `wasm` CI freshness job).
 *
 * It does two lazy things on the FIRST `connect`:
 *   1. dynamic-`import()`s the wasm-bindgen glue module (`portcode_wasm.js`) so the
 *      PWA shell paints before the multi-MB wasm chunk loads (§5.6), and
 *   2. calls the glue's default `init(wasmUrl)`, passing the `_bg.wasm` URL resolved
 *      through Vite's `?url` import so the fetch points at the content-hashed asset
 *      the web build emits into `web-dist/assets/` (rather than the glue's own
 *      `import.meta.url`-relative guess, which would not survive bundling).
 *
 * After `init()` resolves, the module's `Session` class is live; we return it as the
 * {@link WasmModule}. Any failure (artifact missing, init throws) rejects the
 * promise, which {@link createWasmConnector} catches to fall back to the mock so a
 * broken/absent wasm never bricks the PWA.
 *
 * The `?url` import is a tiny string and the glue `import()` is lazy, so neither the
 * 4 MB wasm nor the glue lands in the main chunk. We avoid `vite-plugin-top-level-await`
 * (it hard-requires rollup, absent under Vite 8's rolldown bundler): the lazy
 * dynamic-import path keeps each top-level await inside its own async chunk.
 *
 * SUBRESOURCE INTEGRITY (§5.10/§6): the wasm is delivered as a dynamically
 * `import()`ed ES module, and the SRI `integrity` attribute only applies to
 * `<script>`/`<link>` tags — there is no broadly-supported way to pin a hash on a
 * dynamic `import()` (the proposed import-map integrity is not yet shippable). The
 * integrity guarantees we rely on instead are: same-origin delivery from the Vercel
 * CDN, the strict CSP in `web/index.html` (`script-src 'self'`, no third-party
 * origins, no `unsafe-eval` beyond `wasm-unsafe-eval`), and content-hashed immutable
 * asset URLs. True wasm SRI is deferred to a build step that emits `<link
 * rel="modulepreload" integrity=...>` once the CI wasm artifact is wired (Phase 6).
 */
/* c8 ignore start -- exercised only in a real browser; tests inject a fake loader. */
export const defaultWasmLoader: WasmLoader = async () => {
  // Resolve the wasm binary URL through Vite (`?url` → the emitted, content-hashed
  // asset path) and lazily import the glue module. Both specifiers are static so the
  // bundler can rewrite them, but the glue import stays dynamic so the heavy chunk is
  // only fetched on the first connect.
  const [{ default: init, Session }, { default: wasmUrl }] = await Promise.all([
    import("../../web/wasm/portcode-wasm/portcode_wasm.js"),
    import("../../web/wasm/portcode-wasm/portcode_wasm_bg.wasm?url"),
  ]);
  await init(wasmUrl);
  return { Session } as unknown as WasmModule;
};
/* c8 ignore stop */

/** Adapt a wasm {@link WasmSession} to the {@link WebSession} interface. The wasm
 *  side exposes a single `onEvent` callback; we fan it out to multiple `onFrame`
 *  subscribers and synthesize `onDisconnected` locally (fired by `disconnect`). */
function adaptWasmSession(ws: WasmSession): WebSession {
  const frameCbs = new Set<(f: SyncFrame) => void>();
  const disconnectedCbs = new Set<() => void>();
  // Bridge the single wasm `onEvent` to our multi-subscriber `onFrame` registry.
  ws.onEvent((f: SyncFrame) => {
    for (const cb of frameCbs) cb(f);
  });
  let disconnected = false;
  let toreDown = false;
  // Notify every `onDisconnected` subscriber exactly once, then clear the
  // registries. Shared by a spontaneous transport drop (the wasm `onDisconnected`
  // bridge below) and a manual `disconnect()`, so whichever fires first wins and
  // the other is a no-op.
  function fanoutDisconnect(): void {
    if (disconnected) return;
    disconnected = true;
    for (const cb of disconnectedCbs) cb();
    frameCbs.clear();
    disconnectedCbs.clear();
  }
  // Bridge a SPONTANEOUS transport drop (relay/connection torn down) into the
  // fanout so the store learns the session died even without a manual disconnect.
  // Guarded: older wasm builds don't expose `onDisconnected`.
  ws.onDisconnected?.(() => {
    fanoutDisconnect();
  });
  return {
    sas: ws.sas,
    peerPublicKey: ws.peerPublicKey,
    // Carry the desktop's VAPID key through to the WebSession so the push client
    // can use it as the `applicationServerKey` (undefined when the desktop sent none).
    vapidPublicKey: ws.vapidPublicKey,
    // Surface the phone's own static private key so callers can persist it and
    // pass it back on the next `connect` for KK same-phone resume. Older wasm
    // builds that don't expose `privateKey` produce `undefined` here, which is
    // harmless — the wasm falls back to a fresh key on the next dial.
    privateKey: ws.privateKey,
    async sendCommand(cmd: RemoteCommand): Promise<void> {
      await ws.sendCommand(cmd);
    },
    onFrame(cb: (f: SyncFrame) => void): Unlisten {
      frameCbs.add(cb);
      return () => {
        frameCbs.delete(cb);
      };
    },
    onDisconnected(cb: () => void): Unlisten {
      disconnectedCbs.add(cb);
      return () => {
        disconnectedCbs.delete(cb);
      };
    },
    async reject(): Promise<void> {
      // Decline the pairing: send the reject frame + disconnect via the wasm
      // `reject()`. Shares the once-only teardown guard with `disconnect` (a reject
      // releases the wasm handle, so a later manual disconnect must not re-release).
      // Older wasm builds lack `reject` — fall back to a plain disconnect so the
      // channel still closes (the desktop just won't learn the SAS was rejected).
      if (toreDown) return;
      toreDown = true;
      if (ws.reject) await ws.reject();
      else await ws.disconnect();
      fanoutDisconnect();
    },
    async disconnect(): Promise<void> {
      // Tear down the wasm session at most once (a spontaneous drop fires the
      // fanout but does NOT release the wasm handle, so a later manual disconnect
      // still must). `fanoutDisconnect` is independently idempotent, so a drop that
      // already notified makes this a notify no-op.
      if (toreDown) return;
      toreDown = true;
      await ws.disconnect();
      fanoutDisconnect();
    },
  };
}

/**
 * The error a {@link createWasmConnector}'s `connect` rejects with when the real
 * `portcode-wasm` module fails to load. Distinct (named) so the store/UI can tell a
 * genuine wasm-load failure apart from an ordinary dial error and surface it as
 * "the secure transport couldn't load" rather than a misleading no-op.
 */
export class WasmUnavailableError extends Error {
  /** The underlying load failure (import reject / init throw). Kept as an own field
   *  rather than the standard `Error.cause` (not in the ES2021 lib target). */
  readonly reason: unknown;
  constructor(reason: unknown) {
    super(
      "The secure connection module couldn't load. Reload the app and try again — " +
        "if this keeps happening the build may be incomplete.",
    );
    this.name = "WasmUnavailableError";
    this.reason = reason;
  }
}

/**
 * Build the real WASM-backed {@link WebSessionConnector}. It lazily loads the
 * `portcode-wasm` module on the first {@link WebSessionConnector.connect}.
 *
 * NON-SILENT FALLBACK (Fix C): a load FAILURE is SURFACED, not swallowed — `connect`
 * rejects with a {@link WasmUnavailableError} (after logging once). This propagates
 * through `webPhoneSyncConnect` → `phoneSyncConnect` → `store.connectRemote`'s catch,
 * which sets `remoteError`, so a real-device wasm failure is visible in the pair UI
 * instead of masquerading as a connect that "fetched nothing". The inert mock is
 * still reachable for tests/preview via the default connector registry + injected
 * fake loaders — we just don't auto-degrade a real injected-wasm failure to it.
 *
 * @param load injectable module loader (defaults to {@link defaultWasmLoader});
 *   tests pass a fake to avoid resolving the real package.
 */
export function createWasmConnector(load: WasmLoader = defaultWasmLoader): WebSessionConnector {
  // Memoize the load so we import once and reuse the resolved module across dials.
  // A rejected load is intentionally NOT cached as a sentinel: each connect re-asks
  // so a transient first-load failure (e.g. offline at launch) can recover on retry.
  let mod: Promise<WasmModule> | null = null;

  function loadModule(): Promise<WasmModule> {
    if (mod === null) {
      mod = load().catch((e: unknown) => {
        // Surface, don't silently degrade: a real wasm-load failure must reach the
        // UI. Clear the memo so a later connect can retry the load.
        mod = null;
        console.warn("[webSession] portcode-wasm failed to load:", e);
        throw new WasmUnavailableError(e);
      });
    }
    return mod;
  }

  return {
    async connect(qr: string, reconnect: boolean, privateKey?: string): Promise<WebSession> {
      const m = await loadModule();
      // Pass the persisted phone private key (if any) so wasm can resume the KK
      // handshake with the same static identity rather than generating a fresh key.
      // Older wasm builds that don't accept the third param ignore it safely.
      const ws = await m.Session.connect(qr, reconnect, privateKey);
      return adaptWasmSession(ws);
    },
  };
}

// ── Connector registry ──────────────────────────────────────────────────────
//
// `connector` is the active transport factory; it defaults to the mock so the app
// runs with no WASM. The web build injects the WASM-backed connector via
// `setWebSessionConnector` at startup (the sole reference to the real transport).
let connector: WebSessionConnector = createMockConnector();

/** Inject the active connector (the web build wires the WASM-backed one here). */
export function setWebSessionConnector(c: WebSessionConnector): void {
  connector = c;
}

/** Restore the default mock connector (used by tests to isolate, and to tear the
 *  WASM connector back down). */
export function resetWebSessionConnector(): void {
  connector = createMockConnector();
}

// ── ipc-shaped client wrappers ───────────────────────────────────────────────
//
// These mirror the mobile-CLIENT functions in `src/lib/ipc.ts` so ipc can route
// to them in web-client mode. They own a single module-level "current session":
// `webPhoneSyncConnect` opens it, the rest operate on it, and `webPhoneSyncDisconnect`
// tears it down. Like ipc.ts's mock, operations on a missing session never throw.
let current: WebSession | null = null;

/**
 * Dial + pair with a desktop from its scanned QR payload via the active connector,
 * store the result as the current session, and return its {@link ConnectInfo}
 * (`{ sas, peerPublicKey, vapidPublicKey?, privateKey? }`). Mirrors ipc.ts
 * `phoneSyncConnect`. `privateKey` (optional) is the phone's persisted static
 * private key from a prior dial; pass it to resume a KK same-phone handshake.
 */
export async function webPhoneSyncConnect(
  qr: string,
  reconnect = false,
  privateKey?: string,
): Promise<ConnectInfo> {
  // Capture the session being replaced so we can tear it down: overwriting
  // `current` without disconnecting the old session would leak it (its socket /
  // WASM handle would stay open) across a reconnect.
  const previous = current;
  const next = await connector.connect(qr, reconnect, privateKey);
  current = next;
  // Disconnect the prior session AFTER the new dial succeeds (so a failed dial
  // leaves the existing session intact). Swallow errors — a best-effort teardown
  // of the old session must not fail the new connect.
  if (previous && previous !== next) {
    await previous.disconnect().catch(() => {});
  }
  return {
    sas: next.sas,
    peerPublicKey: next.peerPublicKey,
    vapidPublicKey: next.vapidPublicKey,
    privateKey: next.privateKey,
  };
}

/** Forward one command to the current session. No-op if not connected. */
export async function webPhoneSyncSendCommand(command: RemoteCommand): Promise<void> {
  await current?.sendCommand(command);
}

/** Tear down + clear the current session. Idempotent (no-op if not connected). */
export async function webPhoneSyncDisconnect(): Promise<void> {
  const session = current;
  current = null;
  await session?.disconnect();
}

/**
 * Decline the pairing on the current session: send the `pairing_reject` frame to the
 * desktop, then clear + tear down. Idempotent (no-op if not connected). Mirrors
 * {@link webPhoneSyncDisconnect} but routes through the session's `reject` so the
 * desktop learns the SAS was rejected, not merely that the link dropped.
 */
export async function webPhoneSyncReject(): Promise<void> {
  const session = current;
  current = null;
  await session?.reject();
}

/**
 * Subscribe to frames on the current session. Returns an unlisten handle.
 *
 * BEHAVIOR (documented choice): the subscription targets the session that is
 * current *at call time*. If there is no current session yet (caller hasn't
 * connected), this returns a no-op unlisten rather than throwing — call after
 * connect to receive frames. Mirrors ipc.ts, where the mock's subscription is
 * inert when nothing is live.
 */
export function webOnPhoneSyncFrame(cb: (f: SyncFrame) => void): Unlisten {
  return current?.onFrame(cb) ?? (() => {});
}

/**
 * Subscribe to the "session dropped" signal on the current session. Returns an
 * unlisten handle; a no-op unlisten when there is no current session (same
 * documented behavior as {@link webOnPhoneSyncFrame}).
 */
export function webOnPhoneSyncDisconnected(cb: () => void): Unlisten {
  return current?.onDisconnected(cb) ?? (() => {});
}
