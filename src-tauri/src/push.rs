//! Phone Sync — Phase 5: Web Push from the desktop, no extra server.
//!
//! The desktop is the event source (a permission gate opens, a turn finishes), so
//! per IOS_WEB_CLIENT_PLAN §5.7/§9 it sends Web Push **directly** to the phone's
//! push service (`*.push.apple.com` for an installed iOS PWA, or any other push
//! service) using the subscription the phone registered — there is no relay or
//! push backend on Vercel.
//!
//! This module owns three things:
//!   * the **VAPID identity** — a key the desktop generates once and keeps in the
//!     OS secret store (the PRIVATE half never leaves; the PUBLIC half goes into
//!     the pairing QR so the installed PWA can `pushManager.subscribe(...)` with
//!     it). See [`vapid_public_key`].
//!   * the **per-device subscription store** — gated behind the existing
//!     device-trust gate: only a CONFIRMED device's subscription is stored
//!     ([`register_subscription`]). Backed by `crate::secrets`.
//!   * **sending** — [`send_push`] encrypts a tiny `{title, body, tag}` JSON
//!     payload for the device's subscription (VAPID + RFC 8291 via the `web-push`
//!     crate) and POSTs it through the desktop's existing `reqwest` client.
//!
//! Push is **best-effort and must never block or fail an agent run**: every entry
//! point logs and swallows its own errors, and the live event hooks fire it on a
//! detached task (see `crate::sync::emit_event`). A phone that never receives a
//! push just relies on the in-app decision queue (the source of truth, §5.7).
//!
//! DESKTOP-ONLY: the phone is a pure client and never sends push, so this module is
//! gated to `#[cfg(desktop)]` at its `mod` declaration in `lib.rs`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine as _;
use serde::Serialize;
use web_push::{ContentEncoding, SubscriptionInfo, VapidSignatureBuilder, WebPushMessageBuilder};

use crate::secrets::{self, PushSubscription};

/// How long a push service should retain an undelivered message (seconds). Both of
/// our pushes are re-engagement nudges; an hour is plenty and bounds storage on the
/// service. The in-app queue is the source of truth, so a dropped push is harmless.
const PUSH_TTL_SECS: u32 = 3600;

/// The small JSON payload the service worker receives and renders as a
/// notification. Shared wire shape with the frontend agent's `onpush` handler
/// (§5.7): `{ title, body, tag }`. `tag` lets a newer push of the same kind replace
/// an older one (e.g. a second permission prompt) rather than stack up.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct PushPayload {
    pub title: String,
    pub body: String,
    pub tag: String,
}

impl PushPayload {
    /// Serialize to the compact JSON bytes that get encrypted into the push.
    pub fn to_bytes(&self) -> Vec<u8> {
        // `PushPayload` is three owned Strings → serialization cannot fail; fall
        // back to an empty object rather than ever panicking on the push path.
        serde_json::to_vec(self).unwrap_or_else(|_| b"{}".to_vec())
    }
}

/// The desktop's VAPID **public** key (base64url-no-pad, uncompressed P-256 point),
/// derived from the persisted private key — lazily creating the key on first need.
/// This is what goes into the pairing QR ([`crate::sync::pairing::PairingPayload
/// ::with_vapid_public_key`]) so the installed PWA can subscribe to push with it as
/// its `applicationServerKey`. The private key never leaves the secret store.
pub fn vapid_public_key() -> Result<String, String> {
    let private_b64 = secrets::get_or_create_vapid_private()?;
    // `from_base64_no_sub` parses the raw private key and can derive the public
    // point without needing a subscription bound yet.
    let partial = VapidSignatureBuilder::from_base64_no_sub(&private_b64)
        .map_err(|e| format!("vapid key parse failed: {e}"))?;
    Ok(B64URL.encode(partial.get_public_key()))
}

/// Register (or replace) a CONFIRMED device's Web Push subscription. The caller
/// (`serve_connection`'s `RegisterPush` path) MUST have already passed the
/// device-trust gate — this function does not itself re-check trust, mirroring how
/// the command handler trusts its post-gate position; it only persists. Keyed by
/// the device's base64 Noise static public key.
pub fn register_subscription(device_key_b64: &str, sub: PushSubscription) -> Result<(), String> {
    secrets::set_push_subscription(device_key_b64, &sub)
}

/// Build the encrypted, VAPID-signed Web Push request fields for one subscription +
/// payload, WITHOUT sending. Split out from [`send_push`] so the message-shaping +
/// VAPID signing logic is unit-testable without a network call. Returns the push
/// service endpoint, the encrypted body, and the headers (TTL + crypto headers +
/// content encoding) to attach.
fn build_push(
    sub: &PushSubscription,
    private_b64: &str,
    payload: &PushPayload,
) -> Result<PreparedPush, String> {
    let info = SubscriptionInfo::new(sub.endpoint.clone(), sub.p256dh.clone(), sub.auth.clone());

    let signature = VapidSignatureBuilder::from_base64(private_b64, &info)
        .map_err(|e| format!("vapid signature setup failed: {e}"))?
        .build()
        .map_err(|e| format!("vapid signature build failed: {e}"))?;

    let body = payload.to_bytes();
    let mut builder = WebPushMessageBuilder::new(&info);
    builder.set_ttl(PUSH_TTL_SECS);
    builder.set_payload(ContentEncoding::Aes128Gcm, &body);
    builder.set_vapid_signature(signature);

    let message = builder
        .build()
        .map_err(|e| format!("web push message build failed: {e}"))?;

    let endpoint = message.endpoint.to_string();
    let ttl = message.ttl;
    let payload = message
        .payload
        .ok_or_else(|| "web push message had no encrypted payload".to_string())?;
    // `crypto_headers` carries Authorization (VAPID) + the encryption headers.
    let mut headers: Vec<(String, String)> = payload
        .crypto_headers
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    headers.push((
        "Content-Encoding".to_string(),
        payload.content_encoding.to_str().to_string(),
    ));
    headers.push(("TTL".to_string(), ttl.to_string()));

    Ok(PreparedPush {
        endpoint,
        headers,
        body: payload.content,
    })
}

/// An encrypted Web Push request, ready to POST to a push service.
struct PreparedPush {
    endpoint: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

/// Send a Web Push to a device's stored subscription. **Best-effort**: a missing
/// subscription, a key/encryption error, or a non-2xx response is logged and
/// swallowed — this never returns an error that could surface to (or block) an
/// agent run. `tag` collapses repeats of the same notification kind.
///
/// No-op (logged at debug level) when the device has no registered subscription,
/// which is the common case before the phone has granted notification permission.
pub async fn send_push(
    http: &reqwest::Client,
    device_key_b64: &str,
    title: &str,
    body: &str,
    tag: &str,
) {
    let Some(sub) = secrets::get_push_subscription(device_key_b64) else {
        // No subscription for this device — nothing to do (not an error).
        return;
    };

    let private_b64 = match secrets::get_or_create_vapid_private() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("push: could not load VAPID key — skipping push: {e}");
            return;
        }
    };

    let payload = PushPayload {
        title: title.to_string(),
        body: body.to_string(),
        tag: tag.to_string(),
    };

    let prepared = match build_push(&sub, &private_b64, &payload) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("push: failed to build encrypted push — skipping: {e}");
            return;
        }
    };

    let mut req = http.post(&prepared.endpoint).body(prepared.body);
    for (k, v) in &prepared.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    match req.send().await {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => {
            let status = resp.status();
            // 404/410 mean the subscription is gone (the PWA was uninstalled / the
            // user revoked). Drop it so we stop trying. Other statuses are logged
            // but the subscription is kept (could be transient/rate-limit).
            if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::GONE {
                let _ = secrets::remove_push_subscription(device_key_b64);
                eprintln!("push: subscription gone ({status}) — removed for device");
            } else {
                eprintln!("push: push service returned {status}");
            }
        }
        Err(e) => eprintln!("push: send failed (best-effort, ignored): {e}"),
    }
}

/// Map a live agent [`StreamEvent`] to the push notification it should raise, if
/// any. Only the two re-engagement events in §5.7 produce a push:
///   * `PermissionRequest` → "permission needed" (tag `"permission"`, so a second
///     prompt replaces the first rather than stacking).
///   * `TurnEnd` → "turn finished" (tag `"turn"`).
/// Every other event (text deltas, tool calls, usage, errors) returns `None` — we
/// must NOT push on the high-frequency streaming events.
pub fn payload_for_event(event: &crate::llm::StreamEvent) -> Option<PushPayload> {
    use crate::llm::StreamEvent;
    match event {
        StreamEvent::PermissionRequest { summary, .. } => Some(PushPayload {
            title: "Permission needed".to_string(),
            // The tool summary is the most useful one-liner for the lock-screen.
            body: summary.clone(),
            tag: "permission".to_string(),
        }),
        StreamEvent::TurnEnd { .. } => Some(PushPayload {
            title: "Turn finished".to_string(),
            body: "Your coding turn is done.".to_string(),
            tag: "turn".to_string(),
        }),
        _ => None,
    }
}

/// Best-effort hook: if `event` is a push-worthy event (§5.7), fan a Web Push out
/// to EVERY subscribed device on a detached task and return immediately. Called
/// from the `emit_event` chokepoint, so it sees the same events the phone's live
/// frames carry. NEVER blocks the caller (the agent loop) and NEVER propagates an
/// error — a failed push is logged inside `send_push` and otherwise ignored.
///
/// Resolves the desktop's shared `reqwest` client from managed state; if state is
/// absent (e.g. very early startup) it silently no-ops.
pub fn notify_event(app: &tauri::AppHandle, event: &crate::llm::StreamEvent) {
    use tauri::Manager as _;
    let Some(payload) = payload_for_event(event) else {
        return; // not a push-worthy event — the common case, no allocation beyond match
    };
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };
    let http = state.http.clone();
    let subs = crate::secrets::list_push_subscriptions();
    if subs.is_empty() {
        return; // no phone has registered for push yet
    }
    // Detach: the send awaits a network round-trip to the push service, which must
    // never sit on the agent's emit path. Each device gets its own best-effort send.
    tauri::async_runtime::spawn(async move {
        for (device_key, _sub) in subs {
            send_push(
                &http,
                &device_key,
                &payload.title,
                &payload.body,
                &payload.tag,
            )
            .await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub() -> PushSubscription {
        PushSubscription {
            // A real subscription shape: `p256dh` is a GENUINE uncompressed P-256
            // public point (65 bytes, base64url-no-pad → 87 chars, leading 0x04 → "B")
            // freshly minted with the `p256` crate, and `auth` is 16 bytes. They must
            // be cryptographically valid because `web-push`'s `ece` payload
            // encryption does a real ECDH against `p256dh` — a fabricated point fails
            // with "invalid cryptographic keys". The matching private half is
            // discarded (we never decrypt in the test; we only assert encryption +
            // headers succeed).
            endpoint: "https://web.push.apple.com/example".into(),
            p256dh: "BN4IGjkv-w5yilZU_FEt95mh5eDawQwDNuI-7uPWsMCU9KQTxK5AGPL_Q05anRFBmX0v-3iJKDT_MlnShGkTcZY".into(),
            auth: "BwcHBwcHBwcHBwcHBwcHBw".into(),
        }
    }

    // A randomly-generated VAPID private key the way `get_or_create_vapid_private`
    // produces them: 32 base64url-no-pad bytes. Fixed here for determinism.
    fn vapid_private() -> String {
        // 32 bytes, base64url-no-pad (43 chars).
        "VyVZ_p0sJV7n2v3l9w8oQ1cX4mZ6kR3aT5bU7nP9dGc".into()
    }

    #[test]
    fn payload_serializes_to_the_shared_json_shape() {
        let p = PushPayload {
            title: "Permission needed".into(),
            body: "Allow shell command?".into(),
            tag: "permission".into(),
        };
        let json = String::from_utf8(p.to_bytes()).unwrap();
        // The frontend's onpush handler reads exactly these three keys.
        assert!(json.contains("\"title\":\"Permission needed\""), "{json}");
        assert!(json.contains("\"body\":\"Allow shell command?\""), "{json}");
        assert!(json.contains("\"tag\":\"permission\""), "{json}");
    }

    #[test]
    fn build_push_produces_an_encrypted_body_and_vapid_headers() {
        let prepared = build_push(
            &sub(),
            &vapid_private(),
            &PushPayload {
                title: "Turn finished".into(),
                body: "Your turn is done".into(),
                tag: "turn".into(),
            },
        )
        .expect("build_push should succeed with valid keys");

        // POSTs to the subscription's push-service endpoint.
        assert_eq!(prepared.endpoint, "https://web.push.apple.com/example");
        // The body is ENCRYPTED (aes128gcm), so it must not contain our plaintext.
        let body_str = String::from_utf8_lossy(&prepared.body);
        assert!(
            !body_str.contains("Turn finished"),
            "payload must be encrypted"
        );
        assert!(
            !prepared.body.is_empty(),
            "encrypted body must be non-empty"
        );

        // The required headers are present: a VAPID Authorization, the aes128gcm
        // content encoding, and a TTL.
        let names: Vec<String> = prepared
            .headers
            .iter()
            .map(|(k, _)| k.to_ascii_lowercase())
            .collect();
        assert!(
            names.iter().any(|n| n == "authorization"),
            "missing VAPID Authorization header: {names:?}"
        );
        assert!(
            prepared
                .headers
                .iter()
                .any(|(k, v)| k == "Content-Encoding" && v == "aes128gcm"),
            "missing/incorrect Content-Encoding: {:?}",
            prepared.headers
        );
        assert!(
            prepared
                .headers
                .iter()
                .any(|(k, v)| k == "TTL" && v == PUSH_TTL_SECS.to_string()),
            "missing TTL header"
        );
    }

    #[test]
    fn only_permission_and_turn_end_events_produce_a_push() {
        use crate::llm::StreamEvent;
        use serde_json::json;

        // PermissionRequest → "permission needed", carrying the tool summary, tag
        // "permission" (so a repeat replaces it).
        let perm = payload_for_event(&StreamEvent::PermissionRequest {
            id: "p1".into(),
            tool: "shell".into(),
            summary: "Run `rm -rf build`".into(),
            input: json!({}),
        })
        .expect("permission request should push");
        assert_eq!(perm.title, "Permission needed");
        assert_eq!(perm.body, "Run `rm -rf build`");
        assert_eq!(perm.tag, "permission");

        // TurnEnd → "turn finished", tag "turn".
        let turn = payload_for_event(&StreamEvent::TurnEnd {
            stop_reason: "end_turn".into(),
        })
        .expect("turn end should push");
        assert_eq!(turn.title, "Turn finished");
        assert_eq!(turn.tag, "turn");

        // The high-frequency / non-actionable events must NOT push.
        assert!(payload_for_event(&StreamEvent::TextDelta { text: "hi".into() }).is_none());
        assert!(payload_for_event(&StreamEvent::TurnStart {
            message_id: "m".into()
        })
        .is_none());
        assert!(payload_for_event(&StreamEvent::Usage {
            input_tokens: 1,
            output_tokens: 2
        })
        .is_none());
        assert!(payload_for_event(&StreamEvent::Error {
            message: "boom".into()
        })
        .is_none());
    }

    #[test]
    fn vapid_public_key_derivation_is_stable_for_a_fixed_private_key() {
        // `from_base64_no_sub(...).get_public_key()` derives the public point; for a
        // fixed private key it must be deterministic and a valid uncompressed point
        // (65 bytes → 0x04 prefix).
        let partial =
            VapidSignatureBuilder::from_base64_no_sub(&vapid_private()).expect("parse private key");
        let pubkey = partial.get_public_key();
        assert_eq!(pubkey.len(), 65, "uncompressed P-256 point is 65 bytes");
        assert_eq!(pubkey[0], 0x04, "uncompressed point prefix");

        let again = VapidSignatureBuilder::from_base64_no_sub(&vapid_private())
            .unwrap()
            .get_public_key();
        assert_eq!(pubkey, again, "derivation must be deterministic");
    }
}
