import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  WasmLoader,
  WasmModule,
  WasmSession,
  WebSession,
  WebSessionConnector,
} from "./webSession";
import {
  WasmUnavailableError,
  createMockConnector,
  createWasmConnector,
  resetWebSessionConnector,
  setWebSessionConnector,
  webOnPhoneSyncDisconnected,
  webOnPhoneSyncFrame,
  webPhoneSyncConnect,
  webPhoneSyncDisconnect,
  webPhoneSyncReject,
  webPhoneSyncSendCommand,
} from "./webSession";

import type { ConnectInfo, RemoteCommand, SyncFrame } from "../types";

// Always restore the default mock connector so module-level state can't leak
// between tests. (`webPhoneSyncDisconnect` clears the current session; resetting
// the connector returns the registry to its default.)
afterEach(async () => {
  await webPhoneSyncDisconnect();
  resetWebSessionConnector();
});

const SAMPLE_FRAME: SyncFrame = { t: "session_list", sessions: [] };

/**
 * A custom in-test connector whose session exposes a `fire`/`drop` the test can
 * call to invoke the stored frame/disconnect callbacks — the WASM `Session` would
 * drive these from the network. We do NOT add such methods to the public
 * WebSession interface; they live only on this fake.
 */
function createFakeConnector() {
  const frameCbs = new Set<(f: SyncFrame) => void>();
  const disconnectedCbs = new Set<() => void>();
  const sent: RemoteCommand[] = [];
  const calls = { connect: 0, disconnect: 0, reject: 0 };
  let lastConnect: { qr: string; reconnect: boolean } | null = null;

  const connector: WebSessionConnector = {
    async connect(qr: string, reconnect: boolean, _privateKey?: string): Promise<WebSession> {
      calls.connect += 1;
      lastConnect = { qr, reconnect };
      return {
        sas: "FAKE-SAS",
        peerPublicKey: "FAKE_KEY==",
        async sendCommand(cmd) {
          sent.push(cmd);
        },
        onFrame(cb) {
          frameCbs.add(cb);
          return () => frameCbs.delete(cb);
        },
        onDisconnected(cb) {
          disconnectedCbs.add(cb);
          return () => disconnectedCbs.delete(cb);
        },
        async reject() {
          calls.reject += 1;
          for (const cb of disconnectedCbs) cb();
        },
        async disconnect() {
          calls.disconnect += 1;
          for (const cb of disconnectedCbs) cb();
        },
      };
    },
  };

  return {
    connector,
    sent,
    calls,
    get lastConnect() {
      return lastConnect;
    },
    fire(f: SyncFrame) {
      for (const cb of frameCbs) cb(f);
    },
  };
}

describe("mock connector", () => {
  it("connect returns the fixed ConnectInfo and omits the VAPID key", async () => {
    const conn = createMockConnector();
    const session = await conn.connect("ignored-qr", false);
    expect(session.sas).toBe("MOCK-SAS-1234");
    expect(session.peerPublicKey).toBe("MOCK_DESKTOP_KEY_BASE64==");
    // The mock advertises NO VAPID key: a fake value decodes to an invalid P-256
    // applicationServerKey, so push-subscribe is skipped (no-vapid-key) instead of
    // throwing. See createMockConnector + pushClient.
    expect(session.vapidPublicKey).toBeUndefined();
  });

  it("sendCommand resolves to undefined", async () => {
    const conn = createMockConnector();
    const session = await conn.connect("qr", true);
    await expect(session.sendCommand({ cmd: "cancel", session_id: "s1" })).resolves.toBeUndefined();
  });

  it("disconnect notifies registered disconnected callbacks", async () => {
    const conn = createMockConnector();
    const session = await conn.connect("qr", false);
    const cb = vi.fn();
    session.onDisconnected(cb);
    await session.disconnect();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("reject notifies registered disconnected callbacks (inert preview teardown)", async () => {
    const conn = createMockConnector();
    const session = await conn.connect("qr", false);
    const cb = vi.fn();
    session.onDisconnected(cb);
    await expect(session.reject()).resolves.toBeUndefined();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("disconnect is idempotent (second call notifies nobody)", async () => {
    const conn = createMockConnector();
    const session = await conn.connect("qr", false);
    const cb = vi.fn();
    session.onDisconnected(cb);
    await session.disconnect();
    await session.disconnect();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("onFrame / onDisconnected unlisten removes the callback", async () => {
    const conn = createMockConnector();
    const session = await conn.connect("qr", false);

    // onFrame returns a working unlisten (frame cb is stored but the mock never
    // emits, so we assert via removal not delivery).
    const offFrame = session.onFrame(vi.fn());
    offFrame();

    const cb = vi.fn();
    const offDisc = session.onDisconnected(cb);
    offDisc();
    await session.disconnect();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("ipc-shaped wrappers (default mock connector)", () => {
  it("webPhoneSyncConnect returns the mock ConnectInfo (no VAPID key, no privateKey)", async () => {
    const info: ConnectInfo = await webPhoneSyncConnect("qr");
    expect(info).toEqual({
      sas: "MOCK-SAS-1234",
      peerPublicKey: "MOCK_DESKTOP_KEY_BASE64==",
      vapidPublicKey: undefined,
      privateKey: undefined,
    });
  });

  it("webPhoneSyncConnect forwards reconnect=true", async () => {
    await expect(webPhoneSyncConnect("qr", true)).resolves.toBeDefined();
  });

  it("webPhoneSyncSendCommand is a no-op with no current session", async () => {
    await expect(
      webPhoneSyncSendCommand({ cmd: "create_session", title: "x" }),
    ).resolves.toBeUndefined();
  });

  it("webPhoneSyncSendCommand forwards after connect", async () => {
    await webPhoneSyncConnect("qr");
    await expect(
      webPhoneSyncSendCommand({ cmd: "run", session_id: "s1", text: "hi" }),
    ).resolves.toBeUndefined();
  });

  it("webPhoneSyncDisconnect is idempotent with no current session", async () => {
    await expect(webPhoneSyncDisconnect()).resolves.toBeUndefined();
    await expect(webPhoneSyncDisconnect()).resolves.toBeUndefined();
  });

  it("webPhoneSyncReject is a no-op with no current session", async () => {
    await expect(webPhoneSyncReject()).resolves.toBeUndefined();
  });

  it("webOnPhoneSyncFrame returns a no-op unlisten with no current session", () => {
    const off = webOnPhoneSyncFrame(vi.fn());
    expect(off).toBeTypeOf("function");
    expect(() => off()).not.toThrow();
  });

  it("webOnPhoneSyncDisconnected returns a no-op unlisten with no current session", () => {
    const off = webOnPhoneSyncDisconnected(vi.fn());
    expect(off).toBeTypeOf("function");
    expect(() => off()).not.toThrow();
  });
});

describe("connector registry", () => {
  it("setWebSessionConnector swaps in a custom connector used by webPhoneSyncConnect", async () => {
    const fake = createFakeConnector();
    setWebSessionConnector(fake.connector);

    const info = await webPhoneSyncConnect("my-qr", true);
    expect(info).toEqual({
      sas: "FAKE-SAS",
      peerPublicKey: "FAKE_KEY==",
      vapidPublicKey: undefined,
      privateKey: undefined,
    });
    expect(fake.calls.connect).toBe(1);
    expect(fake.lastConnect).toEqual({ qr: "my-qr", reconnect: true });

    await webPhoneSyncSendCommand({ cmd: "cancel", session_id: "s1" });
    expect(fake.sent).toEqual([{ cmd: "cancel", session_id: "s1" }]);
  });

  it("disconnects the previous session when reconnecting (no leak across dials)", async () => {
    const fake = createFakeConnector();
    setWebSessionConnector(fake.connector);

    await webPhoneSyncConnect("qr-1");
    await webPhoneSyncConnect("qr-2"); // replaces the first session

    // The prior session must have been torn down exactly once by the second connect.
    expect(fake.calls.connect).toBe(2);
    expect(fake.calls.disconnect).toBe(1);
  });

  it("resetWebSessionConnector restores the default mock connector", async () => {
    setWebSessionConnector(createFakeConnector().connector);
    resetWebSessionConnector();
    const info = await webPhoneSyncConnect("qr");
    expect(info.sas).toBe("MOCK-SAS-1234");
  });

  it("webOnPhoneSyncFrame delivers frames from the current session (custom connector)", async () => {
    const fake = createFakeConnector();
    setWebSessionConnector(fake.connector);
    await webPhoneSyncConnect("qr");

    const cb = vi.fn();
    const off = webOnPhoneSyncFrame(cb);
    fake.fire(SAMPLE_FRAME);
    expect(cb).toHaveBeenCalledWith(SAMPLE_FRAME);

    // unlisten stops delivery
    off();
    fake.fire(SAMPLE_FRAME);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("webOnPhoneSyncDisconnected fires on disconnect (custom connector)", async () => {
    const fake = createFakeConnector();
    setWebSessionConnector(fake.connector);
    await webPhoneSyncConnect("qr");

    const cb = vi.fn();
    webOnPhoneSyncDisconnected(cb);
    await webPhoneSyncDisconnect();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(fake.calls.disconnect).toBe(1);

    // current session cleared: a later send is a no-op (doesn't reach the fake)
    await webPhoneSyncSendCommand({ cmd: "cancel", session_id: "s1" });
    expect(fake.sent).toEqual([]);
  });

  it("webPhoneSyncReject routes to the current session's reject and clears it", async () => {
    const fake = createFakeConnector();
    setWebSessionConnector(fake.connector);
    await webPhoneSyncConnect("qr");

    const cb = vi.fn();
    webOnPhoneSyncDisconnected(cb);
    await webPhoneSyncReject();

    // Routes to reject (NOT disconnect) and notifies the drop listener.
    expect(fake.calls.reject).toBe(1);
    expect(fake.calls.disconnect).toBe(0);
    expect(cb).toHaveBeenCalledTimes(1);

    // The current session is cleared, so a later send/reject is a no-op.
    await webPhoneSyncSendCommand({ cmd: "cancel", session_id: "s1" });
    expect(fake.sent).toEqual([]);
    await expect(webPhoneSyncReject()).resolves.toBeUndefined();
    expect(fake.calls.reject).toBe(1);
  });
});

// ── Real WASM-backed connector ───────────────────────────────────────────────
//
// The real connector lazily `import()`s `portcode-wasm` and adapts its `Session`
// class to {@link WebSession}. The actual package is not present here (CI builds
// it), so every test injects a fake loader — we NEVER resolve the real specifier.

/** A fake `portcode-wasm` `Session` that records calls and lets the test drive the
 *  inbound-frame callback the way the network would. */
function createFakeWasmSession(opts: { withOnDisconnected?: boolean; withReject?: boolean } = {}) {
  const sent: RemoteCommand[] = [];
  let eventCb: ((f: SyncFrame) => void) | null = null;
  let dropCb: (() => void) | null = null;
  const calls = { disconnect: 0, reject: 0 };
  const session: WasmSession = {
    sas: "WASM-SAS",
    peerPublicKey: "WASM_KEY==",
    vapidPublicKey: "WASM_VAPID==",
    sendCommand(cmd) {
      sent.push(cmd);
    },
    onEvent(cb) {
      eventCb = cb;
    },
    disconnect() {
      calls.disconnect += 1;
    },
  };
  // Only newer wasm builds expose `onDisconnected`; the adapter must guard for its
  // absence, so the fake exposes it only when asked.
  if (opts.withOnDisconnected !== false) {
    session.onDisconnected = (cb) => {
      dropCb = cb;
    };
  }
  // `reject` is also only on newer wasm builds; default present, omit when asked so
  // the adapter's fallback-to-disconnect path can be exercised.
  if (opts.withReject !== false) {
    session.reject = () => {
      calls.reject += 1;
    };
  }
  return {
    session,
    sent,
    calls,
    emit(f: SyncFrame) {
      eventCb?.(f);
    },
    /** Simulate a SPONTANEOUS transport drop the wasm side observed. */
    emitDrop() {
      dropCb?.();
    },
  };
}

describe("createWasmConnector (real connector, faked wasm module)", () => {
  it("adapts the wasm Session: connect returns its sas/peerPublicKey", async () => {
    const fake = createFakeWasmSession();
    const load = vi.fn(
      async (): Promise<WasmModule> => ({
        Session: { connect: vi.fn(async () => fake.session) },
      }),
    );
    const connector = createWasmConnector(load);
    const session = await connector.connect("the-qr", true);
    expect(session.sas).toBe("WASM-SAS");
    expect(session.peerPublicKey).toBe("WASM_KEY==");
    // The VAPID key threads through the adapter (used for the push subscription).
    expect(session.vapidPublicKey).toBe("WASM_VAPID==");
  });

  it("forwards qr/reconnect to Session.connect and only loads the module once", async () => {
    const fake = createFakeWasmSession();
    const connect = vi.fn(async () => fake.session);
    const load = vi.fn(async (): Promise<WasmModule> => ({ Session: { connect } }));
    const connector = createWasmConnector(load);

    await connector.connect("qr-1", false);
    await connector.connect("qr-2", true);

    expect(load).toHaveBeenCalledTimes(1); // memoized
    expect(connect).toHaveBeenNthCalledWith(1, "qr-1", false, undefined);
    expect(connect).toHaveBeenNthCalledWith(2, "qr-2", true, undefined);
  });

  it("sendCommand reaches the wasm session; onEvent frames fan out to onFrame", async () => {
    const fake = createFakeWasmSession();
    const connector = createWasmConnector(async () => ({
      Session: { connect: async () => fake.session },
    }));
    const session = await connector.connect("qr", false);

    await session.sendCommand({ cmd: "run", session_id: "s1", text: "hi" });
    expect(fake.sent).toEqual([{ cmd: "run", session_id: "s1", text: "hi" }]);

    const a = vi.fn();
    const b = vi.fn();
    session.onFrame(a);
    const offB = session.onFrame(b);
    fake.emit(SAMPLE_FRAME);
    expect(a).toHaveBeenCalledWith(SAMPLE_FRAME);
    expect(b).toHaveBeenCalledWith(SAMPLE_FRAME);

    // unlisten stops just that subscriber
    offB();
    fake.emit(SAMPLE_FRAME);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("disconnect tears down the wasm session, fires onDisconnected, and is idempotent", async () => {
    const fake = createFakeWasmSession();
    const connector = createWasmConnector(async () => ({
      Session: { connect: async () => fake.session },
    }));
    const session = await connector.connect("qr", false);

    const onDisc = vi.fn();
    session.onDisconnected(onDisc);
    await session.disconnect();
    await session.disconnect(); // second call is a no-op

    expect(fake.calls.disconnect).toBe(1);
    expect(onDisc).toHaveBeenCalledTimes(1);
  });

  it("onDisconnected unlisten removes the callback before disconnect", async () => {
    const fake = createFakeWasmSession();
    const connector = createWasmConnector(async () => ({
      Session: { connect: async () => fake.session },
    }));
    const session = await connector.connect("qr", false);
    const onDisc = vi.fn();
    const off = session.onDisconnected(onDisc);
    off();
    await session.disconnect();
    expect(onDisc).not.toHaveBeenCalled();
  });

  it("reject calls the wasm reject (not disconnect), fans out, and is idempotent with disconnect", async () => {
    const fake = createFakeWasmSession();
    const connector = createWasmConnector(async () => ({
      Session: { connect: async () => fake.session },
    }));
    const session = await connector.connect("qr", false);

    const onDisc = vi.fn();
    session.onDisconnected(onDisc);
    await session.reject();

    // Routes to the wasm `reject` (carries the pairing_reject frame), not disconnect.
    expect(fake.calls.reject).toBe(1);
    expect(fake.calls.disconnect).toBe(0);
    expect(onDisc).toHaveBeenCalledTimes(1);

    // A later disconnect is a no-op (reject already released the handle + fanned out).
    await session.disconnect();
    expect(fake.calls.disconnect).toBe(0);
    expect(onDisc).toHaveBeenCalledTimes(1);
  });

  it("reject falls back to disconnect when the wasm Session has no reject (older build)", async () => {
    const fake = createFakeWasmSession({ withReject: false });
    const connector = createWasmConnector(async () => ({
      Session: { connect: async () => fake.session },
    }));
    const session = await connector.connect("qr", false);

    const onDisc = vi.fn();
    session.onDisconnected(onDisc);
    await session.reject();

    // No wasm `reject` to call → the channel still closes via `disconnect`.
    expect(fake.calls.reject).toBe(0);
    expect(fake.calls.disconnect).toBe(1);
    expect(onDisc).toHaveBeenCalledTimes(1);
  });

  it("a SPONTANEOUS wasm transport drop fires onDisconnected (not just manual disconnect)", async () => {
    const fake = createFakeWasmSession({ withOnDisconnected: true });
    const connector = createWasmConnector(async () => ({
      Session: { connect: async () => fake.session },
    }));
    const session = await connector.connect("qr", false);
    const onDisc = vi.fn();
    session.onDisconnected(onDisc);

    // The wasm side observed the relay/connection drop on its own — no manual
    // disconnect() call. The adapter must fan that out to the store.
    fake.emitDrop();
    expect(onDisc).toHaveBeenCalledTimes(1);

    // A spontaneous drop does NOT release the wasm handle, so a later manual
    // disconnect still tears it down — but the fanout is idempotent (no re-notify).
    await session.disconnect();
    expect(fake.calls.disconnect).toBe(1);
    expect(onDisc).toHaveBeenCalledTimes(1);
  });

  it("tolerates a wasm Session WITHOUT onDisconnected (older build): disconnect still fans out", async () => {
    const fake = createFakeWasmSession({ withOnDisconnected: false });
    const connector = createWasmConnector(async () => ({
      Session: { connect: async () => fake.session },
    }));
    const session = await connector.connect("qr", false);
    const onDisc = vi.fn();
    session.onDisconnected(onDisc);
    // No spontaneous-drop bridge exists, but a manual disconnect still notifies.
    await session.disconnect();
    expect(fake.calls.disconnect).toBe(1);
    expect(onDisc).toHaveBeenCalledTimes(1);
  });

  it("SURFACES the load failure (Fix C): connect rejects with WasmUnavailableError, not a silent mock", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cause = new Error("Cannot find module 'portcode-wasm'");
    // Loader rejects exactly as a missing/broken `portcode-wasm` artifact would.
    const load = vi.fn(() => Promise.reject(cause));
    const connector = createWasmConnector(load);

    // A real wasm-load failure must be VISIBLE — connect rejects (so connectRemote's
    // catch sets remoteError) instead of silently degrading to the inert mock.
    await expect(connector.connect("qr", false)).rejects.toBeInstanceOf(WasmUnavailableError);
    // The original cause is preserved for diagnostics, and we logged once.
    await connector.connect("qr", false).catch((e: unknown) => {
      expect((e as WasmUnavailableError).reason).toBe(cause);
    });
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it("retries the load on a later connect after a failure (failure is not cached)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = createFakeWasmSession();
    // First load rejects; second succeeds — a transient first-load failure must recover.
    const load = vi
      .fn<WasmLoader>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ Session: { connect: async () => fake.session } });
    const connector = createWasmConnector(load);

    await expect(connector.connect("qr", false)).rejects.toBeInstanceOf(WasmUnavailableError);
    // The memo was cleared, so this re-asks the loader and succeeds.
    const session = await connector.connect("qr", false);
    expect(session.sas).toBe("WASM-SAS");
    expect(load).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("works through setWebSessionConnector + webPhoneSyncConnect end to end", async () => {
    const fake = createFakeWasmSession();
    setWebSessionConnector(
      createWasmConnector(async () => ({
        Session: { connect: async () => fake.session },
      })),
    );
    const info = await webPhoneSyncConnect("qr", false);
    expect(info).toEqual({
      sas: "WASM-SAS",
      peerPublicKey: "WASM_KEY==",
      vapidPublicKey: "WASM_VAPID==",
      // privateKey is undefined on the fake (not added to createFakeWasmSession yet).
      privateKey: undefined,
    });

    const cb = vi.fn();
    webOnPhoneSyncFrame(cb);
    fake.emit(SAMPLE_FRAME);
    expect(cb).toHaveBeenCalledWith(SAMPLE_FRAME);

    await webPhoneSyncDisconnect();
    expect(fake.calls.disconnect).toBe(1);
  });

  it("surfaces privateKey from the wasm Session through adaptWasmSession", async () => {
    // Simulate a wasm session that exposes a privateKey getter (newer build).
    const fake = createFakeWasmSession();
    Object.defineProperty(fake.session, "privateKey", {
      value: "PRIV_KEY_BASE64==",
      configurable: true,
    });
    const connect = vi.fn(async () => fake.session);
    const connector = createWasmConnector(async () => ({ Session: { connect } }));

    const session = await connector.connect("qr", false);
    expect(session.privateKey).toBe("PRIV_KEY_BASE64==");
  });

  it("forwards private_key to Session.connect (KK same-phone resume)", async () => {
    const fake = createFakeWasmSession();
    const connect = vi.fn(async () => fake.session);
    const connector = createWasmConnector(async () => ({ Session: { connect } }));

    await connector.connect("qr", true, "MY_PRIV_KEY==");
    expect(connect).toHaveBeenCalledWith("qr", true, "MY_PRIV_KEY==");
  });

  it("webPhoneSyncConnect threads privateKey to the connector and surfaces it in ConnectInfo", async () => {
    const fake = createFakeWasmSession();
    Object.defineProperty(fake.session, "privateKey", { value: "PRIV==", configurable: true });
    const connect = vi.fn(async () => fake.session);
    setWebSessionConnector(createWasmConnector(async () => ({ Session: { connect } })));

    const info = await webPhoneSyncConnect("qr", true, "INPUT_PRIV==");
    // The private key is forwarded to the wasm connect call.
    expect(connect).toHaveBeenCalledWith("qr", true, "INPUT_PRIV==");
    // And the session's privateKey is surfaced in the returned ConnectInfo.
    expect(info.privateKey).toBe("PRIV==");
  });

  it("privateKey is undefined on older wasm builds (no getter)", async () => {
    const fake = createFakeWasmSession();
    // Older build: no privateKey on the session (the default from createFakeWasmSession).
    const connector = createWasmConnector(async () => ({
      Session: { connect: async () => fake.session },
    }));
    const session = await connector.connect("qr", false);
    expect(session.privateKey).toBeUndefined();
  });
});
