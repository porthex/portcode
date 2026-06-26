// Installed-PWA Web Push CLIENT for the iOS web client (docs/IOS_WEB_CLIENT_PLAN.md §5.7).
//
// THE ROLE SPLIT
// --------------
// The DESKTOP is the push SENDER: it holds the VAPID private key and POSTs
// VAPID-signed payloads straight to Apple's push service (no Vercel backend — the
// plan's §9 routing). This module is the browser CLIENT half: in the installed
// iOS PWA it asks for notification permission, subscribes the service worker to
// push with the desktop's VAPID PUBLIC key as the `applicationServerKey`, and
// returns the subscription's `{ endpoint, p256dh, auth }` so the caller can hand
// it to the desktop via a `register_push` RemoteCommand (the SHARED wire contract).
//
// WHY IT'S A NO-OP ALMOST EVERYWHERE
// ----------------------------------
// Push only works for INSTALLED iOS PWAs (§4.2/§5.7), and only when the desktop
// actually advertised a VAPID key. Everywhere else — a Safari tab, a desktop
// browser without push, the Tauri native build, jsdom under test, or a desktop
// that predates push — `requestAndSubscribe` must DEGRADE GRACEFULLY to a
// no-result instead of throwing. Push is re-engagement, never core; the in-app
// decision queue is the source of truth (§5.7). So every guard returns a typed
// "skipped" result rather than raising.
//
// DEPENDENCY INJECTION
// --------------------
// Mirroring webClientLifecycle / pwaLifecycle / webScanner, EVERY browser API this
// touches is injectable: the `ServiceWorkerContainer`, the `Notification` static,
// the install-gate check, and a console for the one diagnostic log. Defaults wire
// the real globals (guarded for absence). This lets vitest exercise the whole flow
// — permission grant/deny, fresh subscribe, reuse-existing, missing key, not
// installed — under jsdom with plain fakes and no real Push/Notification APIs.

import { isStandalonePwa as realIsStandalonePwa } from "./installGate";

/** The push subscription payload to register with the desktop (the SHARED wire
 *  contract): the push service `endpoint` plus the two base64url subscription keys
 *  from `PushSubscription.getKey(...)`. Shaped to drop straight into the
 *  `register_push` {@link RemoteCommand} (`{ cmd, ...this }`). */
export interface PushRegistration {
  endpoint: string;
  /** base64url of the `p256dh` key (the client public key for payload encryption). */
  p256dh: string;
  /** base64url of the `auth` secret. */
  auth: string;
}

/** Why a subscribe attempt produced no registration — surfaced so the caller can
 *  log/telemetry without treating any of these as an error (all are expected). */
export type PushSkipReason =
  | "unsupported" // no serviceWorker / PushManager / Notification in this host
  | "not-installed" // not running as an installed (standalone) PWA — push won't fire on iOS
  | "no-vapid-key" // the desktop advertised no VAPID key (predates push)
  | "permission-denied" // the user declined (or had previously declined) notifications
  | "subscribe-failed"; // the PushManager.subscribe call threw

/** The result of {@link requestAndSubscribe}: either a registration to send to the
 *  desktop, or a typed skip reason. A discriminated union so callers `switch` on it
 *  rather than catching exceptions. */
export type PushResult =
  | { ok: true; registration: PushRegistration }
  | { ok: false; reason: PushSkipReason };

/** The slice of `ServiceWorkerContainer` we use: `ready` resolves to the active
 *  registration whose `pushManager` we subscribe through. */
export interface PushServiceWorkerContainer {
  readonly ready: Promise<PushRegistrationLike>;
}

/** The slice of `ServiceWorkerRegistration` we use. */
export interface PushRegistrationLike {
  readonly pushManager: PushManagerLike;
}

/** The slice of `PushManager` we use: read an existing subscription, or create one. */
export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(opts: {
    userVisibleOnly: boolean;
    applicationServerKey: Uint8Array | ArrayBuffer;
  }): Promise<PushSubscriptionLike>;
}

/** The slice of `PushSubscription` we use: the endpoint URL + the raw keys. */
export interface PushSubscriptionLike {
  readonly endpoint: string;
  getKey(name: "p256dh" | "auth"): ArrayBuffer | null;
}

/** The slice of the `Notification` static we use (the permission state + the
 *  request prompt). Injectable so tests don't need the real (jsdom-absent) API. */
export interface NotificationApi {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
}

/** Options for {@link requestAndSubscribe}; all injectable, defaulting to the real
 *  globals (guarded for absence) so the PWA can call it with just the VAPID key. */
export interface RequestAndSubscribeOptions {
  /** The desktop's VAPID PUBLIC key (base64url), from `ConnectInfo.vapidPublicKey`.
   *  When absent/empty the call skips with `"no-vapid-key"`. */
  vapidPublicKey?: string;
  /** The service-worker container (defaults to `navigator.serviceWorker`). */
  serviceWorker?: PushServiceWorkerContainer;
  /** The Notification static (defaults to the global `Notification`). */
  notification?: NotificationApi;
  /** Whether we are an installed PWA (defaults to {@link realIsStandalonePwa}). */
  isInstalled?: () => boolean;
  /** Console for the one diagnostic warning (defaults to the global console). */
  logger?: Pick<Console, "warn">;
}

/** Resolve the default {@link PushServiceWorkerContainer} from the global navigator,
 *  or `undefined` when there is none (Tauri / jsdom / older browsers). */
function defaultServiceWorker(): PushServiceWorkerContainer | undefined {
  if (typeof navigator === "undefined") return undefined;
  const sw = (navigator as Navigator & { serviceWorker?: unknown }).serviceWorker;
  return sw ? (sw as unknown as PushServiceWorkerContainer) : undefined;
}

/** Resolve the default {@link NotificationApi} from the global `Notification`, or
 *  `undefined` when absent (iOS only exposes it in installed PWAs; jsdom has none). */
function defaultNotification(): NotificationApi | undefined {
  const N = (globalThis as { Notification?: unknown }).Notification;
  return N ? (N as unknown as NotificationApi) : undefined;
}

/**
 * Is Web Push usable AT ALL in this host? True only when the three pieces exist: a
 * service-worker container (with a `PushManager` once `ready`), and the
 * `Notification` permission API. This is the cheap pre-flight the lifecycle uses to
 * decide whether to even attempt a subscription. Pure + side-effect-free.
 *
 * Note: this does NOT check install state or permission — those are
 * runtime/consent gates handled by {@link requestAndSubscribe}. It only answers
 * "does this browser have the APIs?".
 */
export function isPushSupported(
  sw: PushServiceWorkerContainer | undefined = defaultServiceWorker(),
  notification: NotificationApi | undefined = defaultNotification(),
  pushManager: unknown = (globalThis as { PushManager?: unknown }).PushManager,
): boolean {
  return Boolean(sw) && Boolean(notification) && Boolean(pushManager);
}

/**
 * Convert a base64url VAPID key to the `Uint8Array` (`applicationServerKey`) the
 * Push API expects. VAPID keys are base64url WITHOUT padding; we restore standard
 * base64 (`-`→`+`, `_`→`/`, pad to a multiple of 4) and `atob`-decode. Exported for
 * direct testing of the encoding (the load-bearing wire detail).
 */
export function vapidKeyToBytes(base64url: string): Uint8Array {
  const padded = base64url.padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Encode an `ArrayBuffer` (a `PushSubscription` key) as base64url WITHOUT padding
 *  — the form the desktop's web-push library expects for `p256dh` / `auth`. */
function bufferToBase64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Map a {@link PushSubscriptionLike} to the {@link PushRegistration} wire shape, or
 *  `null` when the browser didn't surface both keys (malformed subscription). */
function toRegistration(sub: PushSubscriptionLike): PushRegistration | null {
  const p256dh = sub.getKey("p256dh");
  const auth = sub.getKey("auth");
  if (!p256dh || !auth) return null;
  return {
    endpoint: sub.endpoint,
    p256dh: bufferToBase64url(p256dh),
    auth: bufferToBase64url(auth),
  };
}

/**
 * Request notification permission (if not already granted) and subscribe the
 * installed PWA to Web Push, returning the subscription to register with the
 * desktop — or a typed skip reason.
 *
 * Idempotent: if a subscription already exists for this registration we reuse it
 * (no re-prompt, no duplicate subscribe). The guard order matches the cost: cheap
 * support/install/key checks first, then the permission prompt, then the subscribe.
 *
 * Never throws: a `subscribe()` rejection becomes `{ ok: false, reason:
 * "subscribe-failed" }` (logged once) so the best-effort lifecycle caller can carry
 * on. Push is re-engagement, not core (§5.7).
 */
export async function requestAndSubscribe(opts: RequestAndSubscribeOptions): Promise<PushResult> {
  const sw = opts.serviceWorker ?? defaultServiceWorker();
  const notification = opts.notification ?? defaultNotification();
  const isInstalled = opts.isInstalled ?? realIsStandalonePwa;
  const logger = opts.logger ?? console;

  // 1. APIs present? (no serviceWorker / Notification → nothing to do)
  if (!sw || !notification) return { ok: false, reason: "unsupported" };

  // 2. Installed PWA? On iOS push only fires for Home-Screen apps; a Safari-tab
  //    subscription is useless and would also sit in the wrong storage partition.
  if (!isInstalled()) return { ok: false, reason: "not-installed" };

  // 3. Did the desktop advertise a VAPID key? Without it we can't form a valid
  //    applicationServerKey, so there's nothing to subscribe against.
  const vapid = opts.vapidPublicKey;
  if (!vapid) return { ok: false, reason: "no-vapid-key" };

  // 4 + 5. Permission + subscribe, both inside the try so neither can throw past
  //   this function. `requestPermission()` can reject in some hosts (e.g. when not
  //   called from a user gesture); letting it throw would crash the best-effort
  //   lifecycle caller, so a throw here folds into `subscribe-failed` like any other
  //   push setup failure. A clean non-granted result still maps to
  //   `permission-denied`. Subscribe is idempotent: reuse an existing subscription
  //   so a resume / repeat call doesn't churn the push service.
  try {
    // Permission. If already granted we skip the prompt; if denied (now or
    // previously) we bail — never spam the prompt, the user said no.
    let permission = notification.permission;
    if (permission === "default") {
      permission = await notification.requestPermission();
    }
    if (permission !== "granted") return { ok: false, reason: "permission-denied" };

    const registration = await sw.ready;
    const pm = registration.pushManager;
    const existing = await pm.getSubscription();
    const sub =
      existing ??
      (await pm.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyToBytes(vapid),
      }));
    const reg = toRegistration(sub);
    if (!reg) return { ok: false, reason: "subscribe-failed" };
    return { ok: true, registration: reg };
  } catch (e) {
    logger.warn("[pushClient] push subscription failed; continuing without push:", e);
    return { ok: false, reason: "subscribe-failed" };
  }
}
