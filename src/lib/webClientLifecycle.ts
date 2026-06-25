// Session-persistence wiring for the iOS web client (docs/IOS_WEB_CLIENT_PLAN.md §5.8).
//
// This is the glue that ties the browser lifecycle primitives in `pwaLifecycle.ts`
// and the durable storage in `webStorage.ts` to the live store, started ONCE from
// the PWA entry (`web/entry.tsx`). It is the namesake of the phase: making a paired
// session survive iOS suspending/killing the webview.
//
// Three responsibilities, all web-only and confined to this module so the Tauri /
// native path never imports IndexedDB or the lifecycle watcher:
//
//   1. RECONNECT-ON-RESUME. iOS drops the connection the moment it backgrounds the
//      tab. On every resume signal (visible / pageshow / online) we treat the
//      connection as dead and, if there is a remembered pairing and no live session,
//      re-dial through a full-jitter backoff controller (createReconnectController).
//      On HIDE we proactively mark ourselves offline-ish by NOT trusting the socket;
//      the desktop holds all session state, so the phone is a resumable mirror.
//
//   2. DURABLE PINNED-PEER PERSISTENCE (§5.7/§5.8). We subscribe to the store and,
//      on a fresh verified connection, write the pinned peer (desktop key + this
//      device's id + the QR for re-dial) to IndexedDB and request persistent
//      storage; on forget/disconnect we clear it. On startup we hydrate the store's
//      remembered-QR from IndexedDB so a cold launch can one-tap reconnect. This
//      keeps IndexedDB (durable, the plan's pinned-key store) and the store's
//      existing localStorage `lastPairingQr` coherent without a second source of
//      truth: localStorage stays the fast in-store mirror; IndexedDB is authoritative
//      across an eviction of the (non-persistent) localStorage.
//
//   3. SERVICE-WORKER REGISTRATION (§5.7). A tiny guarded helper so the offline
//      shell + push stub (public/sw.js) is registered behind navigator.serviceWorker.
//
// DEPENDENCY INJECTION. Mirroring pwaLifecycle.ts / webScanner.ts, every external
// dependency is injectable (the store getter, the lifecycle watcher, the timer fn,
// the storage fns) so the whole thing is unit-testable under jsdom with no real DOM
// events, no real IndexedDB, and fake timers. The defaults wire the real modules.

import type { PinnedPeer } from "./webStorage";
import {
  clearPinnedPeer as realClearPinnedPeer,
  getOrCreateDeviceId as realGetOrCreateDeviceId,
  loadPinnedPeer as realLoadPinnedPeer,
  requestPersistentStorage as realRequestPersistentStorage,
  savePinnedPeer as realSavePinnedPeer,
} from "./webStorage";
import { createReconnectController, watchLifecycle } from "./pwaLifecycle";
import { useStore } from "../store/store";

/** The slice of the store this module reads + drives. Kept minimal so a test can
 *  supply a plain fake instead of standing up the whole zustand store. */
export interface LifecycleStoreState {
  remoteConnected: boolean;
  remoteVerified: boolean;
  remoteConnecting: boolean;
  remoteSas: string | null;
  /** The desktop's pinned static public key (the STABLE identity to persist as
   *  `PinnedPeer.peerPublicKey`), distinct from the `remoteSas` verification code. */
  remotePeerKey: string | null;
  lastPairingQr: string | null;
  online: boolean;
  reconnectRemote: () => Promise<void>;
  setOnline: (v: boolean) => void;
  /** Hydrate a remembered QR (from durable storage) into `lastPairingQr` when the
   *  slot is empty, so `reconnectRemote()` can dial on a cold launch. */
  hydrateRememberedQr: (qr: string) => void;
}

/** A zustand-shaped store handle: read with `getState`, observe with `subscribe`.
 *  The real `useStore` satisfies this; tests pass a fake. */
export interface LifecycleStore {
  getState(): LifecycleStoreState;
  subscribe(listener: () => void): () => void;
}

/** The storage surface this module uses (a subset of webStorage), injectable so a
 *  test can assert the IndexedDB side-effects without fake-indexeddb. */
export interface LifecycleStorage {
  loadPinnedPeer(): Promise<PinnedPeer | null>;
  savePinnedPeer(peer: PinnedPeer): Promise<void>;
  clearPinnedPeer(): Promise<void>;
  getOrCreateDeviceId(): Promise<string>;
  requestPersistentStorage(): Promise<boolean>;
}

/** Options for {@link startWebClientLifecycle}; all injectable, defaulting to the
 *  real modules so the PWA entry can call it with no arguments. */
export interface WebClientLifecycleOptions {
  store?: LifecycleStore;
  storage?: LifecycleStorage;
  /** The lifecycle watcher (defaults to the real {@link watchLifecycle}). */
  watch?: typeof watchLifecycle;
  /** Injected timer for the reconnect backoff. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

const realStore: LifecycleStore = {
  getState: () => useStore.getState() as unknown as LifecycleStoreState,
  subscribe: (listener) => useStore.subscribe(listener),
};

const realStorage: LifecycleStorage = {
  loadPinnedPeer: realLoadPinnedPeer,
  savePinnedPeer: realSavePinnedPeer,
  clearPinnedPeer: realClearPinnedPeer,
  getOrCreateDeviceId: realGetOrCreateDeviceId,
  requestPersistentStorage: realRequestPersistentStorage,
};

/** A live session is established AND SAS-verified — only then is the desktop key
 *  trustworthy enough to pin. (An unverified connection might be a MITM we haven't
 *  ruled out yet, so we never pin its key.) */
function isVerifiedLive(s: LifecycleStoreState): boolean {
  return s.remoteConnected && s.remoteVerified;
}

/**
 * Start the web-client lifecycle. Returns a stop function that tears down every
 * listener + subscription it installed (the lifecycle watcher, the store
 * subscription, and any pending reconnect timer). Idempotent stop.
 *
 * Call once from the PWA entry. Safe in any environment: the lifecycle watcher is a
 * no-op without `document`/`window`, and the storage calls degrade to no-ops when
 * IndexedDB is unavailable, so nothing here throws for environmental reasons.
 */
export function startWebClientLifecycle(opts: WebClientLifecycleOptions = {}): () => void {
  const store = opts.store ?? realStore;
  const storage = opts.storage ?? realStorage;
  const watch = opts.watch ?? watchLifecycle;

  // The QR hydrated from IndexedDB on cold start, used by the resume path when the
  // store's own lastPairingQr is still empty (localStorage evicted). The store's
  // localStorage mirror always wins when present — this is the durable fallback.
  let rememberedQr: string | null = null;

  // ── Hydrate the remembered pairing from durable storage on cold start ─────────
  // If the store has no remembered QR but a pinned peer with a cached QR survives in
  // IndexedDB, stash it so the resume path can one-tap reconnect. We don't dial here
  // (there is no resume signal yet) — the lifecycle resume path picks it up.
  void (async () => {
    if (store.getState().lastPairingQr) return; // localStorage mirror already has it
    const pinned = await storage.loadPinnedPeer();
    if (pinned?.qr && !store.getState().lastPairingQr) {
      rememberedQr = pinned.qr;
      // Push the hydrated QR into the store too, so `reconnectRemote()` (which only
      // reads `store.lastPairingQr`) can actually dial on a cold launch — not just
      // the resume guard, which reads `rememberedQr` directly. `hydrateRememberedQr`
      // only fills an empty slot, so a localStorage value that arrives first wins.
      store.getState().hydrateRememberedQr(pinned.qr);
    }
  })();

  // ── Durable pinned-peer persistence (subscribe to the store) ──────────────────
  let lastVerifiedLive = isVerifiedLive(store.getState());
  let lastQr = store.getState().lastPairingQr;

  const unsubscribe = store.subscribe(() => {
    const s = store.getState();
    const live = isVerifiedLive(s);

    // Fresh verified connection (the false→true edge): pin the desktop's STABLE
    // public key durably. We require `remotePeerKey` (the actual pinned identity) —
    // NOT the SAS, which is only a one-time verification code. If the key isn't
    // surfaced yet, skip pinning rather than storing the wrong value in the key slot.
    if (live && !lastVerifiedLive && s.remotePeerKey !== null && s.lastPairingQr) {
      void persistPinnedPeer(storage, s.lastPairingQr, s.remotePeerKey);
    }

    // The store forgot the remembered desktop (explicit disconnect / forget pairing):
    // clear the durable pin too so a cold start can't silently reconnect to a desktop
    // the user unpaired.
    if (lastQr !== null && s.lastPairingQr === null) {
      rememberedQr = null;
      void storage.clearPinnedPeer();
    }

    lastVerifiedLive = live;
    lastQr = s.lastPairingQr;
  });

  // ── Reconnect-on-resume ───────────────────────────────────────────────────────
  // The connect attempt the controller drives: re-dial the remembered desktop, but
  // only when there IS a remembered desktop and we are not already live/connecting.
  // Resolves (no-op success) when there's nothing to do, so the controller idles.
  const controller = createReconnectController({
    connect: async () => {
      const s = store.getState();
      const qr = s.lastPairingQr ?? rememberedQr;
      // Nothing remembered, or a session is already live / a dial is in flight →
      // nothing to reconnect. Resolve so the controller stops retrying.
      if (!qr || isVerifiedLive(s) || s.remoteConnecting) return;
      // Ensure the QR is in the store before dialing: `reconnectRemote()` reads only
      // `store.lastPairingQr`, so on a cold launch where it's still empty (and the QR
      // came from the durable `rememberedQr`), hydrate it first or the dial no-ops.
      if (!s.lastPairingQr) s.hydrateRememberedQr(qr);
      await store.getState().reconnectRemote();
    },
    setTimeoutFn: opts.setTimeoutFn,
    clearTimeoutFn: opts.clearTimeoutFn,
  });

  const unwatch = watch({
    onResume: () => {
      // Treat the connection as dead on resume — never trust stale state. The radio
      // may also have flapped, so keep `online` truthful before dialing.
      if (typeof navigator !== "undefined" && "onLine" in navigator) {
        store.getState().setOnline(navigator.onLine);
      }
      // Only kick the reconnect loop if there's a remembered desktop and we're not
      // already live. start() is idempotent while running, so repeated resume signals
      // (visible + pageshow firing together) don't stack dials.
      const s = store.getState();
      if ((s.lastPairingQr ?? rememberedQr) && !isVerifiedLive(s)) controller.start();
    },
    onHide: () => {
      // We're being suspended; the socket is as good as dead. We don't proactively
      // disconnect the store (the desktop holds the session and will reclaim its own
      // side on its timeout) — but we stop any in-flight reconnect loop so it can't
      // burn retries against a frozen JS context, and a resume will restart it fresh.
      controller.stop();
    },
  });

  return () => {
    controller.stop();
    unwatch();
    unsubscribe();
  };
}

/** Write the pinned desktop identity to durable storage (and request persistence).
 *  `peerPublicKey` is the desktop's STABLE static public key (from `ConnectInfo`),
 *  the identity reconnects authenticate against — NOT the SAS verification code.
 *  `qr` is stored alongside as the re-dial source. Best-effort: never throws
 *  (webStorage swallows storage errors). */
async function persistPinnedPeer(
  storage: LifecycleStorage,
  qr: string,
  peerPublicKey: string,
): Promise<void> {
  // Ask for durable storage at pair time (iOS grants it only for installed PWAs —
  // exactly the gate we want). Fire-and-forget the grant; the pin write below is
  // valuable even if persistence isn't granted (it just becomes eviction-eligible).
  void storage.requestPersistentStorage();
  const deviceId = await storage.getOrCreateDeviceId();
  await storage.savePinnedPeer({
    peerPublicKey,
    deviceId,
    qr,
    pairedAt: Date.now(),
  });
}

/**
 * Register the PWA service worker (offline shell + push stub), behind a
 * `navigator.serviceWorker` guard so it is a no-op on hosts without it (Tauri,
 * jsdom, older browsers). Returns the registration, or `null` when unsupported /
 * registration failed — never throws. The scope/URL are injectable for tests.
 */
export async function registerServiceWorker(
  url = "/sw.js",
  nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator,
): Promise<ServiceWorkerRegistration | null> {
  if (!nav || !("serviceWorker" in nav)) return null;
  try {
    return await nav.serviceWorker.register(url);
  } catch {
    // A failed registration (e.g. served over http, or the file 404s in a preview)
    // must not crash the app — the PWA still runs online without the offline shell.
    return null;
  }
}
