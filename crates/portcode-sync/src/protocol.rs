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
    /// Stop ONE subagent (and its descendants) from the agents panel — proxies to
    /// `cancel_agent_by_id`. Leaves the rest of the session running.
    CancelAgent { agent_id: String },
    /// Answer a permission gate — proxies to `resolve_permission`.
    Permission { id: String, decision: String },
    /// Open a new session — proxies to `create_session`.
    CreateSession { title: Option<String> },
    /// Request an older page of a session's history for scroll-up pagination. The
    /// initial catch-up ships only the most-recent `SYNC_CACHE_WINDOW` rows
    /// (`Db::messages_tail`), so scrolling up past them asks the desktop for the
    /// rows STRICTLY BEFORE `before_seq` (up to `limit`). The desktop answers with a
    /// [`SyncFrame::MessagePage`]. `before_seq` is the smallest seq the client
    /// currently holds for the session.
    FetchMessages {
        session_id: String,
        before_seq: i64,
        limit: u32,
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
    /// desktop → phone: an OLDER page of one session's history, answering a
    /// [`RemoteCommand::FetchMessages`] (scroll-up pagination). `messages` are the
    /// rows before the requested cursor, ascending; `has_more` is true when still
    /// older history exists beyond this page (so the client keeps offering "load
    /// more"). Distinct from `MessageDelta` (which is the append-only catch-up of
    /// recent/new rows): a page is PREPENDED to the held history, a delta appended.
    MessagePage {
        session_id: String,
        messages: Vec<MessageRow>,
        has_more: bool,
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
    /// EITHER direction, during pairing: the peer declined the SAS verification.
    /// A reject is otherwise a silent local disconnect the other end never learns
    /// about — this frame lets the rejecter tell the peer BEFORE dropping, so the
    /// desktop prompt cancels (no 60s park) and the phone surfaces the decline
    /// instead of a bare connection drop. `reason` is an optional human string.
    PairingReject { reason: Option<String> },
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
                branch: Some("main".into()),
                workspace: Some("C:/ws".into()),
                model: Some("claude-opus-4-8".into()),
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
    fn pairing_reject_round_trips_with_and_without_a_reason() {
        // With a reason: the tag + reason both survive.
        let with_reason = SyncFrame::PairingReject {
            reason: Some("declined".into()),
        };
        let json = serde_json::to_string(&with_reason).expect("encode");
        assert!(json.contains("\"t\":\"pairing_reject\""), "{json}");
        assert!(json.contains("\"reason\":\"declined\""), "{json}");
        round_trips(&with_reason);

        // Without a reason: serde encodes the Option as JSON null.
        let no_reason = SyncFrame::PairingReject { reason: None };
        let json = serde_json::to_string(&no_reason).expect("encode");
        assert!(json.contains("\"t\":\"pairing_reject\""), "{json}");
        assert!(json.contains("\"reason\":null"), "{json}");
        round_trips(&no_reason);
    }

    #[test]
    fn fetch_messages_command_round_trips_with_snake_case_fields() {
        let frame = SyncFrame::Command {
            command: RemoteCommand::FetchMessages {
                session_id: "s1".into(),
                before_seq: 42,
                limit: 100,
            },
        };
        let json = serde_json::to_string(&frame).expect("encode");
        // Variant tag is snake_case; the fields keep their snake_case names so the
        // TS `{ cmd: "fetch_messages"; session_id; before_seq; limit }` matches.
        assert!(json.contains("\"cmd\":\"fetch_messages\""), "{json}");
        assert!(json.contains("\"session_id\":\"s1\""), "{json}");
        assert!(json.contains("\"before_seq\":42"), "{json}");
        assert!(json.contains("\"limit\":100"), "{json}");
        round_trips(&frame);
    }

    #[test]
    fn message_page_frame_round_trips_with_has_more() {
        let frame = SyncFrame::MessagePage {
            session_id: "s1".into(),
            messages: vec![MessageRow {
                id: "m1".into(),
                session_id: "s1".into(),
                seq: 2,
                role: "user".into(),
                content: vec![Block::Text {
                    text: "older".into(),
                }],
                created_at: 999,
            }],
            has_more: true,
        };
        let json = serde_json::to_string(&frame).expect("encode");
        assert!(json.contains("\"t\":\"message_page\""), "{json}");
        assert!(json.contains("\"has_more\":true"), "{json}");
        round_trips(&frame);
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
}
