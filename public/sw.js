// Service worker for the Vercel-hosted iOS web client (docs/IOS_WEB_CLIENT_PLAN.md
// §5.7). Two jobs at this phase:
//
//   1. OFFLINE SHELL. Cache the app shell at install so a cold launch paints even
//      with no network (then the live iroh-in-browser connection is made at runtime,
//      which the SW never touches — it only serves the static UI).
//   2. PUSH SCAFFOLDING. A `push` handler stub (no real VAPID payloads until Phase 5)
//      and a `notificationclick` handler that focuses/opens the PWA, so tapping a
//      future "permission needed" / "turn finished" push cold-starts the app →
//      reconnect-on-resume (§5.8).
//
// This file is shipped verbatim to the browser (it is NOT bundled or type-checked);
// the testable registration helper lives in src/lib/webClientLifecycle.ts.

const CACHE = "portcode-shell-v1";

// The minimal shell. Hashed JS/CSS assets are cached on demand by the fetch handler
// (their names change per build, so we can't list them here); these are the stable
// entry points + PWA metadata.
const SHELL = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  // Pre-cache the shell, then take over immediately so the first load is controlled.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // Drop stale shell caches from older deploys, then claim open clients.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Only GET navigations / static assets are cacheable. Anything else (the relay
  // WebSocket upgrade, POSTs) falls through to the network untouched.
  if (request.method !== "GET") return;

  // NAVIGATIONS → network-first. The HTML shell is the one resource whose contents
  // change every deploy (new hashed asset URLs); serving it cache-first would pin
  // an old shell that references deleted asset hashes until the SW updates. So we
  // try the network, refresh the cached shell on success, and fall back to the
  // cached shell only when offline — preserving the offline launch.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && new URL(request.url).origin === self.location.origin) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/index.html"))),
    );
    return;
  }

  // NON-NAVIGATION GETs (hashed JS/CSS, manifest, icons) → cache-first. Their URLs
  // are content-hashed and immutable, so a cache hit is always correct and fast.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          // Cache same-origin successful responses for the next offline launch.
          if (response.ok && new URL(request.url).origin === self.location.origin) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => Response.error());
    }),
  );
});

// Web Push handler (Phase 5). The desktop (the push SENDER) posts a VAPID-signed
// JSON payload shaped `{ title, body, tag?, badge? }`:
//   - title / body: the visible notification copy (iOS requires a VISIBLE
//     notification per push — `userVisibleOnly: true`).
//   - tag: collapses repeats so a re-sent "permission needed" replaces the prior
//     one instead of stacking (keyed e.g. by the pending decision id).
//   - badge: the pending-decision count to mirror on the app icon (App Badging),
//     so the badge stays correct even when the app is closed and only the SW runs.
// Missing/non-JSON payloads fall back to generic copy so a malformed push still
// pulls the user back (the in-app decision queue is the source of truth — §5.7).
self.addEventListener("push", (event) => {
  let title = "Portcode";
  let body = "Your desktop has an update.";
  let tag;
  let badge;
  try {
    if (event.data) {
      const payload = event.data.json();
      title = payload.title || title;
      body = payload.body || body;
      if (typeof payload.tag === "string") tag = payload.tag;
      if (typeof payload.badge === "number") badge = payload.badge;
    }
  } catch {
    // Non-JSON / empty payload — keep the generic copy.
  }

  const options = { body, icon: "/icon-192.png", badge: "/icon-192.png" };
  // `tag` (when present) collapses duplicate notifications for the same event.
  if (tag !== undefined) options.tag = tag;

  // Show the notification, and best-effort sync the app icon badge from the payload
  // count (guarded — `setAppBadge`/`clearAppBadge` aren't in every SW global).
  const work = [self.registration.showNotification(title, options)];
  if (typeof badge === "number" && typeof self.navigator !== "undefined") {
    if (badge > 0 && self.navigator.setAppBadge) {
      work.push(self.navigator.setAppBadge(badge).catch(() => {}));
    } else if (badge <= 0 && self.navigator.clearAppBadge) {
      work.push(self.navigator.clearAppBadge().catch(() => {}));
    }
  }
  event.waitUntil(Promise.all(work));
});

// Tapping a notification focuses an existing PWA window or opens a new one. A
// cold-start lands on "/", where the web client's reconnect-on-resume re-dials the
// pinned desktop (§5.8).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("/");
    }),
  );
});
