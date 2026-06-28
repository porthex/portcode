import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isPushSupported,
  requestAndSubscribe,
  vapidKeyToBytes,
  type NotificationApi,
  type PushManagerLike,
  type PushServiceWorkerContainer,
  type PushSubscriptionLike,
} from "./pushClient";

// pushClient is the installed-PWA Web Push CLIENT (§5.7). Everything it touches is
// injectable, so these tests drive the whole flow under jsdom with plain fakes — no
// real Push/Notification/serviceWorker APIs.

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a tiny ArrayBuffer from byte values (a fake subscription key). */
function buf(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

/** A fake PushSubscription with the given endpoint + keys. */
function fakeSub(
  endpoint: string,
  keys: { p256dh: ArrayBuffer | null; auth: ArrayBuffer | null },
): PushSubscriptionLike {
  return {
    endpoint,
    getKey: (name) => keys[name],
  };
}

/** A fake serviceWorker container whose `ready` registration has a pushManager. */
function fakeServiceWorker(pm: PushManagerLike): PushServiceWorkerContainer {
  return { ready: Promise.resolve({ pushManager: pm }) };
}

/** A Notification fake with a controllable starting permission + request result. */
function fakeNotification(
  permission: NotificationPermission,
  requestResult: NotificationPermission = "granted",
): NotificationApi & { requestPermission: ReturnType<typeof vi.fn> } {
  return {
    permission,
    requestPermission: vi.fn(async () => requestResult),
  };
}

describe("isPushSupported", () => {
  const sw = {} as PushServiceWorkerContainer;
  const notification = {} as NotificationApi;
  const PM = function () {} as unknown;

  it("is true when serviceWorker, Notification, and PushManager all exist", () => {
    expect(isPushSupported(sw, notification, PM)).toBe(true);
  });

  it("is false without a serviceWorker container", () => {
    expect(isPushSupported(undefined, notification, PM)).toBe(false);
  });

  it("is false without the Notification API", () => {
    expect(isPushSupported(sw, undefined, PM)).toBe(false);
  });

  it("is false without PushManager", () => {
    expect(isPushSupported(sw, notification, undefined)).toBe(false);
  });
});

describe("vapidKeyToBytes", () => {
  it("decodes a base64url (no padding) key to the original bytes", () => {
    // "hello" → base64 "aGVsbG8=" → base64url "aGVsbG8" (padding stripped).
    const bytes = vapidKeyToBytes("aGVsbG8");
    expect(Array.from(bytes)).toEqual([..."hello"].map((c) => c.charCodeAt(0)));
  });

  it("restores the url-safe alphabet (- _ → + /)", () => {
    // Bytes [0xff,0xff,0xfe] → base64 "//7+"... use a value exercising - and _.
    // 0xfb,0xff → base64 "+/8=" ; url-safe "-_8". Round-trip via btoa for truth.
    const original = new Uint8Array([0xfb, 0xff, 0x3e]);
    let bin = "";
    for (const b of original) bin += String.fromCharCode(b);
    const b64url = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(Array.from(vapidKeyToBytes(b64url))).toEqual(Array.from(original));
  });
});

describe("requestAndSubscribe — guards", () => {
  it("skips 'unsupported' when there is no serviceWorker", async () => {
    const res = await requestAndSubscribe({
      vapidPublicKey: "key",
      serviceWorker: undefined,
      notification: fakeNotification("granted"),
      isInstalled: () => true,
    });
    expect(res).toEqual({ ok: false, reason: "unsupported" });
  });

  it("skips 'unsupported' when there is no Notification API", async () => {
    const pm: PushManagerLike = {
      getSubscription: vi.fn(),
      subscribe: vi.fn(),
    };
    const res = await requestAndSubscribe({
      vapidPublicKey: "key",
      serviceWorker: fakeServiceWorker(pm),
      notification: undefined,
      isInstalled: () => true,
    });
    expect(res).toEqual({ ok: false, reason: "unsupported" });
  });

  it("skips 'not-installed' when not a standalone PWA", async () => {
    const pm: PushManagerLike = { getSubscription: vi.fn(), subscribe: vi.fn() };
    const res = await requestAndSubscribe({
      vapidPublicKey: "key",
      serviceWorker: fakeServiceWorker(pm),
      notification: fakeNotification("granted"),
      isInstalled: () => false,
    });
    expect(res).toEqual({ ok: false, reason: "not-installed" });
    expect(pm.subscribe).not.toHaveBeenCalled();
  });

  it("skips 'no-vapid-key' when the desktop advertised no key", async () => {
    const pm: PushManagerLike = { getSubscription: vi.fn(), subscribe: vi.fn() };
    const res = await requestAndSubscribe({
      vapidPublicKey: undefined,
      serviceWorker: fakeServiceWorker(pm),
      notification: fakeNotification("granted"),
      isInstalled: () => true,
    });
    expect(res).toEqual({ ok: false, reason: "no-vapid-key" });
  });
});

describe("requestAndSubscribe — permission", () => {
  it("prompts when permission is 'default' and proceeds on grant", async () => {
    const sub = fakeSub("https://push.example/abc", { p256dh: buf(1, 2), auth: buf(3, 4) });
    const pm: PushManagerLike = {
      getSubscription: vi.fn(async () => null),
      subscribe: vi.fn(async () => sub),
    };
    const notification = fakeNotification("default", "granted");
    const res = await requestAndSubscribe({
      vapidPublicKey: "aGVsbG8",
      serviceWorker: fakeServiceWorker(pm),
      notification,
      isInstalled: () => true,
    });
    expect(notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });

  it("skips 'permission-denied' when the prompt is declined", async () => {
    const pm: PushManagerLike = {
      getSubscription: vi.fn(async () => null),
      subscribe: vi.fn(),
    };
    const notification = fakeNotification("default", "denied");
    const res = await requestAndSubscribe({
      vapidPublicKey: "aGVsbG8",
      serviceWorker: fakeServiceWorker(pm),
      notification,
      isInstalled: () => true,
    });
    expect(res).toEqual({ ok: false, reason: "permission-denied" });
    expect(pm.subscribe).not.toHaveBeenCalled();
  });

  it("does NOT re-prompt when permission was already 'denied'", async () => {
    const notification = fakeNotification("denied");
    const res = await requestAndSubscribe({
      vapidPublicKey: "aGVsbG8",
      serviceWorker: fakeServiceWorker({ getSubscription: vi.fn(), subscribe: vi.fn() }),
      notification,
      isInstalled: () => true,
    });
    expect(notification.requestPermission).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, reason: "permission-denied" });
  });

  it("folds a throwing requestPermission into 'subscribe-failed' (never throws)", async () => {
    // Some hosts reject requestPermission() (e.g. when not called from a user
    // gesture). Because the call is now inside the try/catch, the rejection must
    // become a typed skip — not crash the best-effort lifecycle caller.
    const subscribe = vi.fn();
    const pm: PushManagerLike = { getSubscription: vi.fn(), subscribe };
    const notification: NotificationApi = {
      permission: "default",
      requestPermission: vi.fn(async () => {
        throw new Error("not allowed without a user gesture");
      }),
    };
    const warn = vi.fn();
    const res = await requestAndSubscribe({
      vapidPublicKey: "aGVsbG8",
      serviceWorker: fakeServiceWorker(pm),
      notification,
      isInstalled: () => true,
      logger: { warn },
    });
    expect(res).toEqual({ ok: false, reason: "subscribe-failed" });
    expect(subscribe).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("does NOT prompt when permission is already 'granted'", async () => {
    const sub = fakeSub("https://push.example/x", { p256dh: buf(9), auth: buf(8) });
    const pm: PushManagerLike = {
      getSubscription: vi.fn(async () => null),
      subscribe: vi.fn(async () => sub),
    };
    const notification = fakeNotification("granted");
    const res = await requestAndSubscribe({
      vapidPublicKey: "aGVsbG8",
      serviceWorker: fakeServiceWorker(pm),
      notification,
      isInstalled: () => true,
    });
    expect(notification.requestPermission).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });
});

describe("requestAndSubscribe — subscribe", () => {
  it("subscribes fresh and returns the base64url-encoded registration", async () => {
    const sub = fakeSub("https://push.example/endpoint", {
      p256dh: buf(251, 255, 62), // base64 "+/8+" → url-safe "-_8-"
      auth: buf(104, 105), // "hi" → "aGk"
    });
    const subscribe: PushManagerLike["subscribe"] = vi.fn(async () => sub);
    const pm: PushManagerLike = { getSubscription: vi.fn(async () => null), subscribe };
    const res = await requestAndSubscribe({
      vapidPublicKey: "aGVsbG8",
      serviceWorker: fakeServiceWorker(pm),
      notification: fakeNotification("granted"),
      isInstalled: () => true,
    });
    expect(res).toEqual({
      ok: true,
      registration: { endpoint: "https://push.example/endpoint", p256dh: "-_8-", auth: "aGk" },
    });
    // userVisibleOnly + the decoded applicationServerKey were passed.
    expect(subscribe).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(subscribe).mock.calls[0][0];
    expect(arg.userVisibleOnly).toBe(true);
    expect(arg.applicationServerKey).toBeInstanceOf(Uint8Array);
  });

  it("is idempotent: reuses an existing subscription instead of re-subscribing", async () => {
    const existing = fakeSub("https://push.example/existing", {
      p256dh: buf(1),
      auth: buf(2),
    });
    const subscribe = vi.fn();
    const pm: PushManagerLike = { getSubscription: vi.fn(async () => existing), subscribe };
    const res = await requestAndSubscribe({
      vapidPublicKey: "aGVsbG8",
      serviceWorker: fakeServiceWorker(pm),
      notification: fakeNotification("granted"),
      isInstalled: () => true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.registration.endpoint).toBe("https://push.example/existing");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("skips 'subscribe-failed' when the subscription is missing a key", async () => {
    const sub = fakeSub("https://push.example/bad", { p256dh: buf(1), auth: null });
    const pm: PushManagerLike = {
      getSubscription: vi.fn(async () => null),
      subscribe: vi.fn(async () => sub),
    };
    const res = await requestAndSubscribe({
      vapidPublicKey: "aGVsbG8",
      serviceWorker: fakeServiceWorker(pm),
      notification: fakeNotification("granted"),
      isInstalled: () => true,
    });
    expect(res).toEqual({ ok: false, reason: "subscribe-failed" });
  });

  it("skips 'subscribe-failed' (logged, never throws) when subscribe rejects", async () => {
    const warn = vi.fn();
    const pm: PushManagerLike = {
      getSubscription: vi.fn(async () => null),
      subscribe: vi.fn(async () => {
        throw new Error("NotAllowedError");
      }),
    };
    const res = await requestAndSubscribe({
      vapidPublicKey: "aGVsbG8",
      serviceWorker: fakeServiceWorker(pm),
      notification: fakeNotification("granted"),
      isInstalled: () => true,
      logger: { warn },
    });
    expect(res).toEqual({ ok: false, reason: "subscribe-failed" });
    expect(warn).toHaveBeenCalled();
  });
});

describe("requestAndSubscribe — default-resolved deps (environment tolerance)", () => {
  it("falls back to 'unsupported' under jsdom (no serviceWorker / Notification)", async () => {
    // jsdom has navigator but no serviceWorker and no Notification → the default
    // resolvers return undefined and we skip without throwing.
    const res = await requestAndSubscribe({ vapidPublicKey: "aGVsbG8", isInstalled: () => true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unsupported");
  });
});
