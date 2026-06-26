//! Wire protocol for Phone Sync — the only types that cross the phone↔desktop
//! channel. In Phase 2+ every frame travels inside the Noise session (encrypted,
//! against a blind relay); here in Phase 0 the types exist and are tested in
//! isolation, with no transport or crypto attached yet.
//!
//! Both ends are Rust, so `serde` is the entire contract. Frames are encoded as
//! JSON (`serde_json`): several inner types (`StreamEvent`, `RemoteCommand`) are
//! `#[serde(tag = …)]` internally-tagged enums, which JSON handles cleanly and a
//! compact binary format (bincode) does not.
//!
//! See `docs/PHONE_SYNC_PLAN.md` for the full design.

use serde::{Deserialize, Serialize};

use crate::wire::{MessageRow, SessionRow, StreamEvent};

// On wasm the protocol types additionally derive `Tsify` so the browser client's
// TypeScript types are generated from THIS Rust source of truth (§5.4). The derive
// expands into wasm-bindgen ABI glue, so it is cfg-gated to wasm only — the native
// desktop build never sees it. `into_wasm_abi`/`from_wasm_abi` let a value cross
// the JS boundary by serde (via `serde-wasm-bindgen`) in both directions. tsify
// reads the existing `#[serde(...)]` attributes, so the emitted `.d.ts` matches the
// JSON the protocol already speaks.
#[cfg(target_arch = "wasm32")]
use tsify::Tsify;

/// One end's high-water mark for a session: "I already hold every message up to
/// and including `seq`." A reconnecting phone sends one per known session so the
/// desktop can reply with only the newer rows (`Db::messages_since`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[cfg_attr(target_arch = "wasm32", tsify(into_wasm_abi, from_wasm_abi))]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub session_id: String,
    pub seq: i64,
}

/// A command the phone issues to drive the always-on desktop. Each maps onto an
/// existing desktop capability (`run_agent` / `cancel_agent` / `resolve_permission`
/// / `create_session`) — the phone never runs tools or touches the workspace
/// itself.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[cfg_attr(target_arch = "wasm32", tsify(into_wasm_abi, from_wasm_abi))]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum RemoteCommand {
    /// Start/continue a turn — proxies to `run_agent`.
    Run { session_id: String, text: String },
    /// Stop the active turn — proxies to `cancel_agent`.
    Cancel { session_id: String },
    /// Answer a permission gate — proxies to `resolve_permission`.
    Permission { id: String, decision: String },
    /// Open a new session — proxies to `create_session`.
    CreateSession { title: Option<String> },
    /// Register (or replace) this device's Web Push subscription so the desktop can
    /// send "permission needed" / "turn finished" pushes to the installed PWA
    /// directly (IOS_WEB_CLIENT_PLAN §5.7/§9). Sent by the phone after the user
    /// grants notification permission and `pushManager.subscribe(...)` resolves.
    /// The three fields are exactly the `PushSubscription` keys the browser yields:
    /// `endpoint` (the push-service URL the desktop POSTs the encrypted payload to)
    /// and the `p256dh` + `auth` keys (base64url) used to encrypt it (RFC 8291).
    /// The desktop only stores/uses this for a CONFIRMED-trusted device (the
    /// existing device-trust gate), so an unconfirmed peer's subscription is ignored.
    /// Wire form: `{ "cmd": "register_push", "endpoint": ..., "p256dh": ..., "auth": ... }`.
    RegisterPush {
        endpoint: String,
        p256dh: String,
        auth: String,
    },
}

/// Everything that crosses the encrypted channel, in both directions.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(target_arch = "wasm32", derive(Tsify))]
#[cfg_attr(target_arch = "wasm32", tsify(into_wasm_abi, from_wasm_abi))]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum SyncFrame {
    /// phone → desktop, on connect: identity + what the phone already holds.
    Hello {
        device_id: String,
        cursors: Vec<Cursor>,
    },
    /// desktop → phone: the current session list (reuses the desktop `SessionRow`).
    SessionList { sessions: Vec<SessionRow> },
    /// desktop → phone: append-only catch-up for one session.
    MessageDelta {
        session_id: String,
        messages: Vec<MessageRow>,
    },
    /// desktop → phone: a live agent event, forwarded verbatim from `agent://{id}`.
    Live {
        session_id: String,
        event: StreamEvent,
    },
    /// phone → desktop: drive the session.
    Command { command: RemoteCommand },
    /// phone → desktop: "applied through this seq" (lets the desktop trim resends).
    Ack { session_id: String, seq: i64 },
}

#[cfg(test)]
mod tests {
    use super::*;
    // SessionRow/MessageRow/StreamEvent come via `use super::*`; only Block is new.
    use crate::wire::Block;

    /// Round-trip a frame through JSON and assert the decoded value re-encodes to
    /// the same JSON — the property both ends rely on.
    fn round_trips(frame: &SyncFrame) {
        let json = serde_json::to_string(frame).expect("encode");
        let back: SyncFrame = serde_json::from_str(&json).expect("decode");
        let rejson = serde_json::to_string(&back).expect("re-encode");
        assert_eq!(json, rejson, "frame did not round-trip: {json}");
    }

    #[test]
    fn hello_round_trips_with_cursors() {
        round_trips(&SyncFrame::Hello {
            device_id: "phone-1".into(),
            cursors: vec![
                Cursor {
                    session_id: "s1".into(),
                    seq: 7,
                },
                Cursor {
                    session_id: "s2".into(),
                    seq: -1,
                },
            ],
        });
    }

    #[test]
    fn live_frame_carries_a_streamevent_verbatim() {
        let frame = SyncFrame::Live {
            session_id: "s1".into(),
            event: StreamEvent::TextDelta { text: "hi".into() },
        };
        let json = serde_json::to_string(&frame).expect("encode");
        // The outer tag and the inner StreamEvent tag both survive.
        assert!(json.contains("\"t\":\"live\""), "{json}");
        assert!(json.contains("\"type\":\"text_delta\""), "{json}");
        round_trips(&frame);
    }

    #[test]
    fn command_frame_nests_the_internally_tagged_remote_command() {
        let frame = SyncFrame::Command {
            command: RemoteCommand::Run {
                session_id: "s1".into(),
                text: "fix the bug".into(),
            },
        };
        let json = serde_json::to_string(&frame).expect("encode");
        assert!(json.contains("\"t\":\"command\""), "{json}");
        assert!(json.contains("\"cmd\":\"run\""), "{json}");
        round_trips(&frame);
    }

    #[test]
    fn session_list_frame_round_trips_with_all_session_row_fields() {
        round_trips(&SyncFrame::SessionList {
            sessions: vec![SessionRow {
                id: "s1".into(),
                title: "Alpha".into(),
                workspace: Some("C:/ws".into()),
                created_at: 1_000_000,
                updated_at: 2_000_000,
            }],
        });
    }

    #[test]
    fn message_delta_frame_round_trips_with_message_rows() {
        // The catch-up frame a reconnecting phone receives — the most
        // load-bearing frame in the protocol.
        round_trips(&SyncFrame::MessageDelta {
            session_id: "s1".into(),
            messages: vec![MessageRow {
                id: "m1".into(),
                session_id: "s1".into(),
                seq: 3,
                role: "assistant".into(),
                content: vec![Block::Text { text: "hi".into() }],
                created_at: 12345,
            }],
        });
    }

    #[test]
    fn ack_and_remote_command_variants_round_trip() {
        round_trips(&SyncFrame::Ack {
            session_id: "s1".into(),
            seq: 42,
        });
        for command in [
            RemoteCommand::Cancel {
                session_id: "s1".into(),
            },
            RemoteCommand::Permission {
                id: "p1".into(),
                decision: "allow".into(),
            },
            RemoteCommand::CreateSession {
                title: Some("New".into()),
            },
            RemoteCommand::CreateSession { title: None },
        ] {
            round_trips(&SyncFrame::Command { command });
        }
    }

    // The RegisterPush wire contract (§5.7/§9) is shared with the browser/JS half:
    // the phone sends `{ "cmd": "register_push", endpoint, p256dh, auth }`, which
    // MUST deserialize into the new variant. Assert both the exact JSON the JS side
    // emits decodes AND that the variant round-trips inside a Command frame.
    #[test]
    fn register_push_decodes_the_shared_js_wire_form_and_round_trips() {
        let json = r#"{"cmd":"register_push","endpoint":"https://web.push.apple.com/abc","p256dh":"BPp256dhKey","auth":"AuthSecret"}"#;
        let cmd: RemoteCommand = serde_json::from_str(json).expect("decode register_push");
        assert!(matches!(
            &cmd,
            RemoteCommand::RegisterPush { endpoint, p256dh, auth }
                if endpoint == "https://web.push.apple.com/abc"
                    && p256dh == "BPp256dhKey"
                    && auth == "AuthSecret"
        ));
        // And it survives the full SyncFrame::Command round-trip both ends rely on.
        round_trips(&SyncFrame::Command { command: cmd });
    }
}
