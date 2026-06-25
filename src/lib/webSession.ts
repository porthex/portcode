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
 * `sas` / `peerPublicKey` are captured at connect time (the short authentication
 * string to compare out-of-band and the pinned desktop key), so they are readonly.
 */
export interface WebSession {
  readonly sas: string;
  readonly peerPublicKey: string;
  /** Send one command to the live desktop. */
  sendCommand(cmd: RemoteCommand): Promise<void>;
  /** Subscribe to frames forwarded from the desktop. Returns an unlisten handle. */
  onFrame(cb: (f: SyncFrame) => void): Unlisten;
  /** Subscribe to the "session dropped" signal. Returns an unlisten handle. */
  onDisconnected(cb: () => void): Unlisten;
  /** Tear down the session. Idempotent. */
  disconnect(): Promise<void>;
}

/**
 * Opens {@link WebSession}s. The real implementation wraps the WASM `Session`
 * constructor (dial + handshake over iroh-in-browser); the mock fabricates a
 * deterministic session. `reconnect` selects the handshake prologue exactly like
 * `phoneSyncConnect` in ipc.ts (false = first pairing binds the QR nonce; true =
 * remembered-desktop reconnect binds an empty prologue).
 */
export interface WebSessionConnector {
  connect(qr: string, reconnect: boolean): Promise<WebSession>;
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
    async connect(_qr: string, _reconnect: boolean): Promise<WebSession> {
      const frameCbs = new Set<(f: SyncFrame) => void>();
      const disconnectedCbs = new Set<() => void>();

      return {
        sas: "MOCK-SAS-1234",
        peerPublicKey: "MOCK_DESKTOP_KEY_BASE64==",
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
  sendCommand(cmd: RemoteCommand): void | Promise<void>;
  /** Register the inbound-frame callback; Rust invokes it per `SyncFrame`. */
  onEvent(cb: (f: SyncFrame) => void): void;
  /** Tear down the session (drops the channel; ends the loops). */
  disconnect(): void | Promise<void>;
}

/** The shape of the `portcode-wasm` module: a `Session` class with a static
 *  `connect`. Only what we call is declared. */
export interface WasmModule {
  Session: {
    connect(qr: string, reconnect: boolean): Promise<WasmSession>;
  };
}

/** Loads the `portcode-wasm` module. Injectable so tests supply a fake instead of
 *  resolving the real (CI-built, here-absent) package. */
export type WasmLoader = () => Promise<WasmModule>;

/**
 * The default {@link WasmLoader}: a dynamic `import()` of the `portcode-wasm`
 * package. The specifier is held in a variable and the import is marked
 * `@vite-ignore` so neither Vite nor the TS resolver tries to statically resolve a
 * package that does not exist in this repo (it is produced by CI). When the
 * package is absent the returned promise rejects, which the connector catches to
 * fall back to the mock.
 */
/* c8 ignore start -- exercised only in a real browser; tests inject a fake loader. */
export const defaultWasmLoader: WasmLoader = () => {
  const spec = "portcode-wasm";
  return import(/* @vite-ignore */ spec) as Promise<WasmModule>;
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
  return {
    sas: ws.sas,
    peerPublicKey: ws.peerPublicKey,
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
    async disconnect(): Promise<void> {
      // Idempotent: only tear down the wasm session + notify once.
      if (disconnected) return;
      disconnected = true;
      await ws.disconnect();
      for (const cb of disconnectedCbs) cb();
      frameCbs.clear();
      disconnectedCbs.clear();
    },
  };
}

/**
 * Build the real WASM-backed {@link WebSessionConnector}. It lazily loads the
 * `portcode-wasm` module on the first {@link WebSessionConnector.connect}; on load
 * failure (module absent) it logs ONCE and permanently delegates to the mock
 * connector so the PWA keeps working until CI wires the wasm in.
 *
 * @param load injectable module loader (defaults to {@link defaultWasmLoader});
 *   tests pass a fake to avoid resolving the real package.
 */
export function createWasmConnector(load: WasmLoader = defaultWasmLoader): WebSessionConnector {
  // Memoize the load so we import once and reuse the resolved module / fallback.
  let mod: Promise<WasmModule | null> | null = null;
  const fallback = createMockConnector();

  function loadModule(): Promise<WasmModule | null> {
    if (mod === null) {
      mod = load().catch((e: unknown) => {
        // Expected here until CI builds portcode-wasm: degrade to the mock so the
        // shipped PWA still pairs (against the inert preview) instead of throwing.
        console.warn("[webSession] portcode-wasm unavailable; falling back to mock connector:", e);
        return null;
      });
    }
    return mod;
  }

  return {
    async connect(qr: string, reconnect: boolean): Promise<WebSession> {
      const m = await loadModule();
      if (m === null) return fallback.connect(qr, reconnect);
      const ws = await m.Session.connect(qr, reconnect);
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
 * (`{ sas, peerPublicKey }`). Mirrors ipc.ts `phoneSyncConnect`.
 */
export async function webPhoneSyncConnect(qr: string, reconnect = false): Promise<ConnectInfo> {
  // Capture the session being replaced so we can tear it down: overwriting
  // `current` without disconnecting the old session would leak it (its socket /
  // WASM handle would stay open) across a reconnect.
  const previous = current;
  const next = await connector.connect(qr, reconnect);
  current = next;
  // Disconnect the prior session AFTER the new dial succeeds (so a failed dial
  // leaves the existing session intact). Swallow errors — a best-effort teardown
  // of the old session must not fail the new connect.
  if (previous && previous !== next) {
    await previous.disconnect().catch(() => {});
  }
  return { sas: next.sas, peerPublicKey: next.peerPublicKey };
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
