import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebSession, WebSessionConnector } from "./webSession";
import {
  createMockConnector,
  resetWebSessionConnector,
  setWebSessionConnector,
  webOnPhoneSyncDisconnected,
  webOnPhoneSyncFrame,
  webPhoneSyncConnect,
  webPhoneSyncDisconnect,
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
  const calls = { connect: 0, disconnect: 0 };
  let lastConnect: { qr: string; reconnect: boolean } | null = null;

  const connector: WebSessionConnector = {
    async connect(qr: string, reconnect: boolean): Promise<WebSession> {
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
  it("connect returns the fixed ConnectInfo", async () => {
    const conn = createMockConnector();
    const session = await conn.connect("ignored-qr", false);
    expect(session.sas).toBe("MOCK-SAS-1234");
    expect(session.peerPublicKey).toBe("MOCK_DESKTOP_KEY_BASE64==");
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
  it("webPhoneSyncConnect returns the mock ConnectInfo", async () => {
    const info: ConnectInfo = await webPhoneSyncConnect("qr");
    expect(info).toEqual({
      sas: "MOCK-SAS-1234",
      peerPublicKey: "MOCK_DESKTOP_KEY_BASE64==",
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
    expect(info).toEqual({ sas: "FAKE-SAS", peerPublicKey: "FAKE_KEY==" });
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
});
