import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerServiceWorker,
  startWebClientLifecycle,
  type LifecycleStorage,
  type LifecycleStore,
  type LifecycleStoreState,
} from "./webClientLifecycle";
import type { LifecycleHandlers } from "./pwaLifecycle";
import type { PinnedPeer } from "./webStorage";

// webClientLifecycle ties pwaLifecycle + webStorage to the store. Everything is
// dependency-injected, so we drive it with a fake store (getState + subscribe), a
// fake storage, a captured lifecycle watcher, and a manual timer stub — no real DOM
// events, no IndexedDB, no real timers.

/** A minimal observable fake of the store slice the module reads + drives. */
function makeFakeStore(initial: Partial<LifecycleStoreState> = {}) {
  const listeners = new Set<() => void>();
  const reconnectRemote = vi.fn(async () => {});
  const setOnline = vi.fn((v: boolean) => {
    state.online = v;
  });
  const hydrateRememberedQr = vi.fn((qr: string) => {
    if (!state.lastPairingQr) state.lastPairingQr = qr;
  });
  const state: LifecycleStoreState = {
    remoteConnected: false,
    remoteVerified: false,
    remoteConnecting: false,
    remoteSas: null,
    remotePeerKey: null,
    lastPairingQr: null,
    online: true,
    reconnectRemote,
    setOnline,
    hydrateRememberedQr,
    ...initial,
  };
  const store: LifecycleStore = {
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  /** Mutate state and notify subscribers (mirrors zustand set()). */
  const set = (patch: Partial<LifecycleStoreState>) => {
    Object.assign(state, patch);
    for (const l of [...listeners]) l();
  };
  return { store, state, set, reconnectRemote, setOnline, hydrateRememberedQr, listeners };
}

/** A fake storage whose calls are spies; the pinned peer is in-memory. */
function makeFakeStorage(pinned: PinnedPeer | null = null) {
  let stored = pinned;
  const storage: LifecycleStorage = {
    loadPinnedPeer: vi.fn(async () => stored),
    savePinnedPeer: vi.fn(async (p: PinnedPeer) => {
      stored = p;
    }),
    clearPinnedPeer: vi.fn(async () => {
      stored = null;
    }),
    getOrCreateDeviceId: vi.fn(async () => "device-abc"),
    requestPersistentStorage: vi.fn(async () => true),
  };
  return storage;
}

/** Capture the handlers passed to watchLifecycle so the test can fire resume/hide. */
function makeWatchStub() {
  let captured: LifecycleHandlers | null = null;
  const unwatch = vi.fn();
  const watch = vi.fn((handlers: LifecycleHandlers) => {
    captured = handlers;
    return unwatch;
  });
  return {
    watch: watch as unknown as typeof import("./pwaLifecycle").watchLifecycle,
    unwatch,
    resume: () => captured?.onResume(),
    hide: () => captured?.onHide?.(),
  };
}

/** A manual timer stub (mirrors pwaLifecycle.test). */
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

const flush = () => Promise.resolve();

describe("startWebClientLifecycle — reconnect on resume", () => {
  it("reconnects on resume when there is a remembered QR and no live session", async () => {
    const { store, reconnectRemote } = makeFakeStore({ lastPairingQr: "QR-1" });
    const storage = makeFakeStorage();
    const w = makeWatchStub();
    const t = makeTimerStub();

    const stop = startWebClientLifecycle({
      store,
      storage,
      watch: w.watch,
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    w.resume();
    await flush();
    expect(reconnectRemote).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does NOT reconnect on resume when already live", async () => {
    const { store, reconnectRemote } = makeFakeStore({
      lastPairingQr: "QR-1",
      remoteConnected: true,
      remoteVerified: true,
    });
    const w = makeWatchStub();
    const t = makeTimerStub();
    const stop = startWebClientLifecycle({
      store,
      storage: makeFakeStorage(),
      watch: w.watch,
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    w.resume();
    await flush();
    expect(reconnectRemote).not.toHaveBeenCalled();
    stop();
  });

  it("does NOT reconnect on resume when there is no remembered desktop", async () => {
    const { store, reconnectRemote } = makeFakeStore({ lastPairingQr: null });
    const w = makeWatchStub();
    const t = makeTimerStub();
    const stop = startWebClientLifecycle({
      store,
      storage: makeFakeStorage(),
      watch: w.watch,
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    w.resume();
    await flush();
    expect(reconnectRemote).not.toHaveBeenCalled();
    stop();
  });

  it("does NOT dial when a connect is already in flight (remoteConnecting)", async () => {
    const { store, reconnectRemote } = makeFakeStore({
      lastPairingQr: "QR-1",
      remoteConnecting: true,
    });
    const w = makeWatchStub();
    const t = makeTimerStub();
    const stop = startWebClientLifecycle({
      store,
      storage: makeFakeStorage(),
      watch: w.watch,
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    w.resume();
    await flush();
    // The controller started but its connect() short-circuits (resolves) without dialing.
    expect(reconnectRemote).not.toHaveBeenCalled();
    stop();
  });

  it("keeps the store online flag truthful on resume (navigator.onLine)", async () => {
    const { store, setOnline } = makeFakeStore({ lastPairingQr: "QR-1" });
    const w = makeWatchStub();
    const t = makeTimerStub();
    const stop = startWebClientLifecycle({
      store,
      storage: makeFakeStorage(),
      watch: w.watch,
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    w.resume();
    await flush();
    expect(setOnline).toHaveBeenCalledWith(navigator.onLine);
    stop();
  });

  it("stops the reconnect loop on hide", async () => {
    // Make reconnect fail so the controller schedules a retry timer we can see cleared.
    const { store, reconnectRemote } = makeFakeStore({ lastPairingQr: "QR-1" });
    reconnectRemote.mockRejectedValue(new Error("no desktop"));
    const w = makeWatchStub();
    const t = makeTimerStub();
    const stop = startWebClientLifecycle({
      store,
      storage: makeFakeStorage(),
      watch: w.watch,
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    w.resume();
    await flush();
    await flush();
    await flush();
    expect(t.scheduled).toHaveLength(1); // a retry was scheduled after the rejection
    const id = t.scheduled[0].id;

    w.hide();
    expect(t.cleared).toContain(id);
    stop();
  });

  it("uses the IndexedDB-hydrated QR when the store has no remembered QR", async () => {
    const { store, reconnectRemote, hydrateRememberedQr, state, set } = makeFakeStore({
      lastPairingQr: null,
    });
    const storage = makeFakeStorage({
      peerPublicKey: "KEY",
      deviceId: "device-abc",
      qr: "QR-FROM-IDB",
      pairedAt: 1,
    });
    const w = makeWatchStub();
    const t = makeTimerStub();
    const stop = startWebClientLifecycle({
      store,
      storage,
      watch: w.watch,
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });

    // Let the async hydration IIFE settle so the durable QR is populated.
    await flush();
    await flush();

    // The hydrated QR is pushed into the store so reconnectRemote (which reads only
    // lastPairingQr) can actually dial on a cold launch — not just the resume guard.
    expect(hydrateRememberedQr).toHaveBeenCalledWith("QR-FROM-IDB");
    expect(state.lastPairingQr).toBe("QR-FROM-IDB");

    w.resume();
    await flush();
    // The controller's connect() saw the QR and called reconnectRemote, which now
    // finds a non-null lastPairingQr (the hydrated one) to dial.
    expect(reconnectRemote).toHaveBeenCalledTimes(1);
    set({}); // touch to ensure no crash on a no-op notify
    stop();
  });
});

describe("startWebClientLifecycle — durable pinned-peer persistence", () => {
  it("pins the desktop on a fresh verified connection", async () => {
    const { store, set } = makeFakeStore({ lastPairingQr: null });
    const storage = makeFakeStorage();
    const w = makeWatchStub();
    const stop = startWebClientLifecycle({ store, storage, watch: w.watch });

    // Simulate a successful connect+verify carrying the STABLE peer key + a SAS.
    set({
      remoteConnected: true,
      remoteVerified: true,
      remoteSas: "SAS-99",
      remotePeerKey: "DESKTOP-KEY-99",
      lastPairingQr: "QR-CONN",
    });
    await flush();

    expect(storage.requestPersistentStorage).toHaveBeenCalledTimes(1);
    expect(storage.getOrCreateDeviceId).toHaveBeenCalledTimes(1);
    expect(storage.savePinnedPeer).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(storage.savePinnedPeer).mock.calls[0][0];
    // The PINNED value is the stable peer key, NOT the SAS verification code.
    expect(saved.peerPublicKey).toBe("DESKTOP-KEY-99");
    expect(saved.peerPublicKey).not.toBe("SAS-99");
    expect(saved.deviceId).toBe("device-abc");
    expect(saved.qr).toBe("QR-CONN");
    expect(typeof saved.pairedAt).toBe("number");
    stop();
  });

  it("does NOT pin a verified connection that has no peer key yet (no SAS in the key slot)", async () => {
    const { store, set } = makeFakeStore({ lastPairingQr: null });
    const storage = makeFakeStorage();
    const w = makeWatchStub();
    const stop = startWebClientLifecycle({ store, storage, watch: w.watch });

    // Verified + live, a SAS present, but the stable peer key not surfaced yet:
    // we must skip pinning rather than store the SAS in the key slot.
    set({
      remoteConnected: true,
      remoteVerified: true,
      remoteSas: "SAS-ONLY",
      remotePeerKey: null,
      lastPairingQr: "QR",
    });
    await flush();
    expect(storage.savePinnedPeer).not.toHaveBeenCalled();
    stop();
  });

  it("does NOT pin a connection that is not yet SAS-verified", async () => {
    const { store, set } = makeFakeStore();
    const storage = makeFakeStorage();
    const w = makeWatchStub();
    const stop = startWebClientLifecycle({ store, storage, watch: w.watch });

    set({ remoteConnected: true, remoteVerified: false, remoteSas: "SAS-1", lastPairingQr: "QR" });
    await flush();
    expect(storage.savePinnedPeer).not.toHaveBeenCalled();
    stop();
  });

  it("clears the durable pin when the store forgets the remembered desktop", async () => {
    const { store, set } = makeFakeStore({ lastPairingQr: "QR-OLD" });
    const storage = makeFakeStorage();
    const w = makeWatchStub();
    const stop = startWebClientLifecycle({ store, storage, watch: w.watch });

    // forgetRemotePairing / disconnectRemote null out lastPairingQr.
    set({ lastPairingQr: null });
    await flush();
    expect(storage.clearPinnedPeer).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not re-pin on an unrelated state change once already live", async () => {
    const { store, set } = makeFakeStore({
      remoteConnected: true,
      remoteVerified: true,
      remoteSas: "SAS",
      lastPairingQr: "QR",
    });
    const storage = makeFakeStorage();
    const w = makeWatchStub();
    const stop = startWebClientLifecycle({ store, storage, watch: w.watch });

    // Already live at start (no false→true edge). A later unrelated change must not pin.
    set({ online: false });
    await flush();
    expect(storage.savePinnedPeer).not.toHaveBeenCalled();
    stop();
  });
});

describe("startWebClientLifecycle — teardown", () => {
  it("stop() removes the watcher and store subscription", async () => {
    const { store, set, listeners } = makeFakeStore({ lastPairingQr: null });
    const storage = makeFakeStorage();
    const w = makeWatchStub();
    const stop = startWebClientLifecycle({ store, storage, watch: w.watch });

    expect(listeners.size).toBe(1);
    stop();
    expect(w.unwatch).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);

    // After teardown a state change must not pin.
    set({ remoteConnected: true, remoteVerified: true, remoteSas: "S", lastPairingQr: "Q" });
    await flush();
    expect(storage.savePinnedPeer).not.toHaveBeenCalled();
  });
});

describe("registerServiceWorker", () => {
  const realNavigator = globalThis.navigator;
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, "navigator", {
      value: realNavigator,
      configurable: true,
    });
  });

  it("registers when serviceWorker is supported", async () => {
    const register = vi.fn(async () => ({ scope: "/" }) as unknown as ServiceWorkerRegistration);
    const nav = { serviceWorker: { register } } as unknown as Navigator;
    const reg = await registerServiceWorker("/sw.js", nav);
    expect(register).toHaveBeenCalledWith("/sw.js");
    expect(reg).not.toBeNull();
  });

  it("returns null when serviceWorker is unsupported", async () => {
    const nav = {} as Navigator;
    expect(await registerServiceWorker("/sw.js", nav)).toBeNull();
  });

  it("returns null when navigator is absent", async () => {
    expect(await registerServiceWorker("/sw.js", undefined)).toBeNull();
  });

  it("returns null (never throws) when registration fails", async () => {
    const register = vi.fn(async () => {
      throw new Error("insecure context");
    });
    const nav = { serviceWorker: { register } } as unknown as Navigator;
    expect(await registerServiceWorker("/sw.js", nav)).toBeNull();
  });

  it("defaults to navigator and /sw.js when called with no args", async () => {
    const register = vi.fn(async () => ({ scope: "/" }) as unknown as ServiceWorkerRegistration);
    Object.defineProperty(globalThis, "navigator", {
      value: { serviceWorker: { register } },
      configurable: true,
    });
    const reg = await registerServiceWorker();
    expect(register).toHaveBeenCalledWith("/sw.js");
    expect(reg).not.toBeNull();
  });
});

describe("startWebClientLifecycle — environment tolerance", () => {
  let savedOnLine: PropertyDescriptor | undefined;

  beforeEach(() => {
    savedOnLine = Object.getOwnPropertyDescriptor(navigator, "onLine");
  });
  afterEach(() => {
    if (savedOnLine) Object.defineProperty(navigator, "onLine", savedOnLine);
  });

  it("starts and stops cleanly with the default real modules (no crash)", () => {
    // Exercises the default store/storage/watch wiring (jsdom has document/window).
    const stop = startWebClientLifecycle();
    expect(() => stop()).not.toThrow();
  });
});
