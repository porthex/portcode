import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  savePinnedPeer,
  loadPinnedPeer,
  clearPinnedPeer,
  getOrCreateDeviceId,
  requestPersistentStorage,
  isStoragePersisted,
  resetDeviceIdCacheForTest,
  type PinnedPeer,
} from "./webStorage";

const samplePeer: PinnedPeer = {
  peerPublicKey: "abc123",
  deviceId: "device-xyz",
  qr: "phone_sync_connect://payload",
  pairedAt: 1_700_000_000_000,
};

/** Wait for any pending IndexedDB deleteDatabase to flush. */
function deleteDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase("portcode-sync");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

describe("webStorage (IndexedDB available)", () => {
  beforeEach(async () => {
    resetDeviceIdCacheForTest();
    await deleteDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips a pinned peer: save then load", async () => {
    await savePinnedPeer(samplePeer);
    const loaded = await loadPinnedPeer();
    expect(loaded).toEqual(samplePeer);
  });

  it("loadPinnedPeer returns null when nothing is stored", async () => {
    expect(await loadPinnedPeer()).toBeNull();
  });

  it("clearPinnedPeer removes a stored peer", async () => {
    await savePinnedPeer(samplePeer);
    expect(await loadPinnedPeer()).not.toBeNull();
    await clearPinnedPeer();
    expect(await loadPinnedPeer()).toBeNull();
  });

  it("clearPinnedPeer is idempotent when nothing is stored", async () => {
    await expect(clearPinnedPeer()).resolves.toBeUndefined();
  });

  it("loadPinnedPeer returns null when the stored value is corrupt JSON", async () => {
    // Write a non-JSON value under the pinned-peer key directly.
    await new Promise<void>((resolve) => {
      const open = indexedDB.open("portcode-sync", 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("kv");
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put("{not valid json", "pinned-peer");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
    expect(await loadPinnedPeer()).toBeNull();
  });

  it("getOrCreateDeviceId returns a stable id across calls", async () => {
    const first = await getOrCreateDeviceId();
    const second = await getOrCreateDeviceId();
    expect(first).toBe(second);
    expect(typeof first).toBe("string");
    expect(first.length).toBeGreaterThan(0);
  });

  it("requestPersistentStorage returns true when granted", async () => {
    vi.stubGlobal("navigator", {
      storage: { persist: vi.fn().mockResolvedValue(true) },
    });
    expect(await requestPersistentStorage()).toBe(true);
  });

  it("requestPersistentStorage returns false when denied", async () => {
    vi.stubGlobal("navigator", {
      storage: { persist: vi.fn().mockResolvedValue(false) },
    });
    expect(await requestPersistentStorage()).toBe(false);
  });

  it("requestPersistentStorage returns false when the API is absent", async () => {
    vi.stubGlobal("navigator", {});
    expect(await requestPersistentStorage()).toBe(false);
  });

  it("requestPersistentStorage returns false when navigator is undefined", async () => {
    vi.stubGlobal("navigator", undefined);
    expect(await requestPersistentStorage()).toBe(false);
  });

  it("requestPersistentStorage returns false when persist throws", async () => {
    vi.stubGlobal("navigator", {
      storage: { persist: vi.fn().mockRejectedValue(new Error("nope")) },
    });
    expect(await requestPersistentStorage()).toBe(false);
  });

  it("isStoragePersisted returns true when persisted", async () => {
    vi.stubGlobal("navigator", {
      storage: { persisted: vi.fn().mockResolvedValue(true) },
    });
    expect(await isStoragePersisted()).toBe(true);
  });

  it("isStoragePersisted returns false when not persisted", async () => {
    vi.stubGlobal("navigator", {
      storage: { persisted: vi.fn().mockResolvedValue(false) },
    });
    expect(await isStoragePersisted()).toBe(false);
  });

  it("isStoragePersisted returns false when the API is absent", async () => {
    vi.stubGlobal("navigator", {});
    expect(await isStoragePersisted()).toBe(false);
  });

  it("isStoragePersisted returns false when navigator is undefined", async () => {
    vi.stubGlobal("navigator", undefined);
    expect(await isStoragePersisted()).toBe(false);
  });

  it("isStoragePersisted returns false when persisted throws", async () => {
    vi.stubGlobal("navigator", {
      storage: { persisted: vi.fn().mockRejectedValue(new Error("nope")) },
    });
    expect(await isStoragePersisted()).toBe(false);
  });
});

describe("webStorage (IndexedDB unavailable)", () => {
  let realIndexedDB: typeof indexedDB;

  beforeEach(() => {
    resetDeviceIdCacheForTest();
    realIndexedDB = globalThis.indexedDB;
    vi.stubGlobal("indexedDB", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.indexedDB = realIndexedDB;
  });

  it("loadPinnedPeer returns null", async () => {
    expect(await loadPinnedPeer()).toBeNull();
  });

  it("savePinnedPeer resolves without throwing", async () => {
    await expect(savePinnedPeer(samplePeer)).resolves.toBeUndefined();
  });

  it("clearPinnedPeer resolves without throwing", async () => {
    await expect(clearPinnedPeer()).resolves.toBeUndefined();
  });

  it("getOrCreateDeviceId still returns a freshly generated id", async () => {
    const id = await getOrCreateDeviceId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("returns the SAME id across concurrent and sequential calls even without IDB", async () => {
    // Regression: with no IDB the write no-ops, so each call used to mint a fresh
    // UUID (and concurrent first calls could race). Memoizing the promise means all
    // callers — concurrent or later — share the first minted id for the session.
    const [a, b] = await Promise.all([getOrCreateDeviceId(), getOrCreateDeviceId()]);
    expect(a).toBe(b);
    const c = await getOrCreateDeviceId();
    expect(c).toBe(a);
  });
});

// fake-indexeddb never fires the defensive error handlers in the happy path, so
// we hand-roll a minimal IndexedDB whose requests we can drive into onerror to
// cover openDb's request.onerror, idbGet's req.onerror, and idbPut/idbDelete's
// tx.onerror branches.
describe("webStorage (IndexedDB error branches)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Build a request-like object that asynchronously fires `onsuccess` (with
   *  `result`) or `onerror`, mirroring how IndexedDB resolves microtask-later. */
  function makeRequest(opts: { fail?: boolean; result?: unknown }) {
    const req: {
      result: unknown;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      onupgradeneeded?: (() => void) | null;
    } = { result: opts.result, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (opts.fail) req.onerror?.();
      else req.onsuccess?.();
    });
    return req;
  }

  /** A fake `indexedDB.open` whose resulting DB's store operations fail per the
   *  given config, so each error handler can be exercised in isolation. */
  function stubIndexedDb(config: { openFail?: boolean; getFail?: boolean; txFail?: boolean }) {
    const db = {
      objectStoreNames: { contains: () => true },
      createObjectStore: vi.fn(),
      close: vi.fn(),
      transaction: () => {
        const tx: {
          oncomplete: (() => void) | null;
          onerror: (() => void) | null;
          objectStore: () => unknown;
        } = {
          oncomplete: null,
          onerror: null,
          objectStore: () => ({
            get: () => makeRequest({ fail: config.getFail, result: "{}" }),
            put: () => makeRequest({}),
            delete: () => makeRequest({}),
          }),
        };
        // Writes settle via tx.oncomplete/onerror, not the request handlers.
        queueMicrotask(() => {
          if (config.txFail) tx.onerror?.();
          else tx.oncomplete?.();
        });
        return tx;
      },
    };
    vi.stubGlobal("indexedDB", {
      open: () => makeRequest({ fail: config.openFail, result: db }),
    });
  }

  it("loadPinnedPeer returns null when openDb's open request errors", async () => {
    stubIndexedDb({ openFail: true });
    expect(await loadPinnedPeer()).toBeNull();
  });

  it("savePinnedPeer resolves when openDb's open request errors", async () => {
    stubIndexedDb({ openFail: true });
    await expect(savePinnedPeer(samplePeer)).resolves.toBeUndefined();
  });

  it("loadPinnedPeer returns null when the get request errors", async () => {
    stubIndexedDb({ getFail: true });
    expect(await loadPinnedPeer()).toBeNull();
  });

  it("savePinnedPeer resolves when the write transaction errors", async () => {
    stubIndexedDb({ txFail: true });
    await expect(savePinnedPeer(samplePeer)).resolves.toBeUndefined();
  });

  it("clearPinnedPeer resolves when the delete transaction errors", async () => {
    stubIndexedDb({ txFail: true });
    await expect(clearPinnedPeer()).resolves.toBeUndefined();
  });

  it("loadPinnedPeer returns null when indexedDB.open throws synchronously", async () => {
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("storage disabled");
      },
    });
    expect(await loadPinnedPeer()).toBeNull();
  });
});
