// Durable browser storage for the iOS web (PWA) Phone Sync client.
//
// The iOS client pairs with a desktop once (camera-scan QR → SAS confirm) and
// then must survive iOS aggressively suspending/killing the webview: when the
// user re-opens the PWA we want to *reconnect*, not re-pair. That requires two
// things to outlive a process death — and `localStorage` is not enough, because
// iOS treats it as evictable and clears it under storage pressure for sites that
// aren't "installed". So this module persists in **IndexedDB** and asks the UA to
// mark our origin as persistent (`navigator.storage.persist()`), implementing the
// storage half of docs/IOS_WEB_CLIENT_PLAN.md §5.7/§5.8:
//
//   • the **pinned peer** — the desktop's static public key (pinned trust-on-
//     first-use after SAS), so reconnects use the fast KK handshake against a key
//     we already trust instead of re-running pairing;
//   • a **stable device id** — a per-install identifier the desktop can recognise
//     across reconnects, generated once and reused forever after.
//
// Everything here is deliberately defensive about the host environment. The same
// frontend bundle also runs under jsdom (unit tests), the desktop Tauri shell,
// and the Android client — hosts where `indexedDB` or `navigator.storage` may be
// absent. None of the public functions throw for environmental reasons: a missing
// store reads as "nothing persisted" and writes become silent no-ops, so callers
// can treat storage as best-effort and degrade to a re-pair instead of crashing.
//
// We talk to the raw IndexedDB API through a tiny internal promise wrapper rather
// than pulling in `idb`/`localforage`: this code stores a single key per value in
// one object store, so a dependency would be pure weight on a bundle we ship to
// phones over the network.

/** The single IndexedDB database this client owns. */
const DB_NAME = "portcode-sync";
/** The single object store: a flat key→value map (we store one value per key). */
const STORE_NAME = "kv";
/** Key under which the pinned desktop identity is stored (as JSON). */
const PINNED_PEER_KEY = "pinned-peer";
/** Key under which the stable per-install device id is stored. */
const DEVICE_ID_KEY = "device-id";

/**
 * The pinned desktop peer the phone reconnects to without re-pairing.
 *
 * `peerPublicKey` is the desktop's static identity key, pinned after the user
 * confirmed the SAS at pair time (trust-on-first-use); reconnects run the KK
 * handshake against exactly this key. `deviceId` is *this phone's* stable id (see
 * {@link getOrCreateDeviceId}), echoed back so the desktop recognises the device.
 * `qr` optionally caches the original pairing payload so a stale/expired pin can
 * be re-dialled without rescanning. `pairedAt` is an epoch-ms timestamp for UX
 * ("paired 3 days ago") and for expiry policy.
 */
export interface PinnedPeer {
  peerPublicKey: string;
  deviceId: string;
  qr?: string;
  pairedAt: number;
}

/**
 * Open (and lazily create) the one object store. Resolves `null` instead of
 * rejecting when IndexedDB is unavailable — a non-DOM host or a UA that blocks
 * storage in private mode — so callers can fold "no store" into a sensible
 * default rather than handling an exception on every access.
 */
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      // Some UAs throw synchronously when storage is disabled.
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/** Read one value by key, or `null` when absent / storage is unavailable. */
async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => {
      const value = req.result as T | undefined;
      resolve(value === undefined ? null : value);
      db.close();
    };
    req.onerror = () => {
      resolve(null);
      db.close();
    };
  });
}

/** Write one value by key. Resolves (silently) even if storage is unavailable. */
async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => {
      resolve();
      db.close();
    };
    tx.onerror = () => {
      resolve();
      db.close();
    };
  });
}

/** Delete one value by key. Resolves even if the key or store is missing. */
async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => {
      resolve();
      db.close();
    };
    tx.onerror = () => {
      resolve();
      db.close();
    };
  });
}

/**
 * Persist the pinned desktop identity so the next cold start can reconnect.
 * Called once after a successful SAS confirmation. A no-op (no throw) when
 * IndexedDB is unavailable — the caller simply falls back to requiring a re-pair.
 */
export async function savePinnedPeer(peer: PinnedPeer): Promise<void> {
  await idbPut(PINNED_PEER_KEY, JSON.stringify(peer));
}

/**
 * Load the pinned desktop identity, or `null` if the phone has never paired (or
 * the pin was evicted / storage is unavailable). Returns `null` rather than
 * throwing on any read failure so the UI defaults cleanly to the pairing screen.
 */
export async function loadPinnedPeer(): Promise<PinnedPeer | null> {
  const raw = await idbGet<string>(PINNED_PEER_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PinnedPeer;
  } catch {
    // Corrupt/partial value — treat as unpaired rather than crashing.
    return null;
  }
}

/**
 * Forget the pinned desktop identity (explicit unpair / "forget this device").
 * Best-effort and idempotent.
 */
export async function clearPinnedPeer(): Promise<void> {
  await idbDelete(PINNED_PEER_KEY);
}

/**
 * Return a stable per-install device id, generating and persisting one on first
 * use. The desktop uses this to recognise the same phone across reconnects, so it
 * must be the *same* value on every call once minted — hence we read-through
 * IndexedDB and only mint when nothing is stored.
 *
 * When storage is unavailable the write silently no-ops. To keep the id STABLE
 * within a session regardless — and to make concurrent first calls race-free — we
 * memoize the in-flight resolution in a module-level promise: the first call mints
 * (or reads) once, and every later call awaits the same promise, so all callers
 * see one id even when IndexedDB can't persist it across a reload.
 */
let deviceIdPromise: Promise<string> | null = null;

export function getOrCreateDeviceId(): Promise<string> {
  if (deviceIdPromise === null) {
    deviceIdPromise = (async () => {
      const existing = await idbGet<string>(DEVICE_ID_KEY);
      if (existing !== null) return existing;
      const id = crypto.randomUUID();
      await idbPut(DEVICE_ID_KEY, id);
      return id;
    })();
  }
  return deviceIdPromise;
}

/**
 * Reset the memoized device id (test-only seam). Production never needs this — the
 * id is meant to live for the whole session — but tests that swap IndexedDB in/out
 * must clear the cache so each scenario mints fresh.
 */
export function resetDeviceIdCacheForTest(): void {
  deviceIdPromise = null;
}

/**
 * Ask the UA to make this origin's storage persistent (exempt from eviction).
 * On iOS this is effectively granted only for installed PWAs, which is exactly
 * the gate we want — call it at pair time. Returns whether persistence is now
 * granted, and `false` (never throwing) when the Storage API is unavailable.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    !navigator.storage ||
    typeof navigator.storage.persist !== "function"
  ) {
    return false;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * Report whether this origin's storage is already marked persistent, so the UI
 * can verify the grant after {@link requestPersistentStorage} (§5.7). Returns
 * `false` when the Storage API is unavailable.
 */
export async function isStoragePersisted(): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    !navigator.storage ||
    typeof navigator.storage.persisted !== "function"
  ) {
    return false;
  }
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}
