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
  current = await connector.connect(qr, reconnect);
  return { sas: current.sas, peerPublicKey: current.peerPublicKey };
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
