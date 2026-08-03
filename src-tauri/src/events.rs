//! The event-emission seam.
//!
//! The Codex projection layer needs a Tauri-independent way to deliver
//! `StreamEvent`s to the desktop UI and mirror the compatible subset to a paired
//! phone. [`EventSink`] owns that one side effect.
//!
//! [`AppEventSink`] is the one production implementation: it forwards to
//! `crate::sync::emit_event`, the canonical chokepoint that publishes to the
//! desktop UI AND the Phone Sync hub.

use crate::llm::StreamEvent;
use serde::Serialize;

/// Ephemeral desktop-only events for one Codex realtime session. These events
/// never enter the shared Phone Sync wire or the durable Codex activity ledger.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CodexRealtimeEvent {
    Sdp { sdp: String },
    Started,
    Closed,
    Error { message: String },
}

/// The single side effect the Codex bridge needs from its host: deliver one
/// `StreamEvent` on a channel. `Send + Sync` so it can be shared across the run's
/// tasks (subagents, background waiters) behind an `Arc`.
///
/// Public because it appears in the Codex bridge constructor; the binary remains
/// the only production consumer of this library crate.
pub trait EventSink: Send + Sync {
    /// Emit one event on `channel` (e.g. `agent://{session}`). The same contract
    /// as the old `emit(app, channel, ev)` helpers: deliver to the desktop UI and
    /// mirror to a paired phone.
    fn emit(&self, channel: &str, ev: StreamEvent);

    /// Emit a desktop-only additive event that legacy Phone Sync peers have not
    /// negotiated. Test sinks default to recording it like any other event.
    fn emit_local(&self, channel: &str, ev: StreamEvent) {
        self.emit(channel, ev);
    }

    /// Emit realtime media-control metadata to the desktop only. Implementors
    /// must not mirror or persist this experimental, session-scoped channel.
    fn emit_realtime(&self, channel: &str, ev: CodexRealtimeEvent);
}

/// The production [`EventSink`]: forwards to `crate::sync::emit_event`, the
/// canonical chokepoint that reaches the desktop UI and the Phone Sync hub. Holds
/// an owned `AppHandle` clone (cheap, ref-counted) so it can outlive the command
/// that built it and be shared across a run's tasks.
#[cfg(desktop)]
#[derive(Clone)]
pub struct AppEventSink(pub tauri::AppHandle);

#[cfg(desktop)]
impl EventSink for AppEventSink {
    fn emit(&self, channel: &str, ev: StreamEvent) {
        // Canonical chokepoint: delivers to the desktop UI and mirrors to the phone.
        crate::sync::emit_event(&self.0, channel, ev);
    }

    fn emit_local(&self, channel: &str, ev: StreamEvent) {
        crate::sync::emit_local_event(&self.0, channel, ev);
    }

    fn emit_realtime(&self, channel: &str, ev: CodexRealtimeEvent) {
        use tauri::Emitter;
        let _ = self.0.emit(channel, ev);
    }
}
