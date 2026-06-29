//! The event-emission seam.
//!
//! The agent core (the loop, the LLM provider, the permission gate) used to take
//! a Tauri `AppHandle` purely so it could deliver `StreamEvent`s to the desktop UI
//! and mirror them to a paired phone. That was the *only* Tauri coupling in the
//! hot path. [`EventSink`] abstracts that single side effect away, so the core
//! depends on a trait it owns rather than on Tauri — the seam a future crate split
//! lifts the core out on. Mirrors the existing trait seams in `tools.rs`
//! (`Spawner` / `Tool` / `BackgroundRunner`) and the `LlmProvider` seam in
//! `llm.rs`.
//!
//! [`AppEventSink`] is the one production implementation: it forwards to
//! `crate::sync::emit_event`, the canonical chokepoint that publishes to the
//! desktop UI AND the Phone Sync hub. Behaviour is byte-for-byte what the inline
//! `emit` helpers did before, so phone-sync mirroring does not regress.

use crate::llm::StreamEvent;

/// The single side effect the agent core needs from its host: deliver one
/// `StreamEvent` on a channel. `Send + Sync` so it can be shared across the run's
/// tasks (subagents, background waiters) behind an `Arc`.
///
/// `pub` to match the sibling seams (`tools::Spawner`/`Tool`/`BackgroundRunner`,
/// `llm::LlmProvider`), which are all `pub` so they can appear in the `pub`
/// signatures that consume them (`llm::stream_turn`, `permissions::gate`) without
/// tripping the private-interface lint. There is no external consumer — the binary
/// is the only user of this library crate.
pub trait EventSink: Send + Sync {
    /// Emit one event on `channel` (e.g. `agent://{session}`). The same contract
    /// as the old `emit(app, channel, ev)` helpers: deliver to the desktop UI and
    /// mirror to a paired phone.
    fn emit(&self, channel: &str, ev: StreamEvent);
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
}
