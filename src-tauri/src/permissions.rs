//! Permission gate for mutating tools (write / edit / shell).
//!
//! Policy "allow" runs immediately, "deny" blocks, "ask" emits a
//! `PermissionRequest` to the UI and awaits the user's decision over a oneshot
//! channel keyed by request id.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::llm::StreamEvent;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Decision {
    Allow,
    Deny,
}

pub type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Decision>>>>;

/// Resolve a request id with a decision (called from the `resolve_permission`
/// command). Returns true if a waiter was found.
pub fn resolve(pending: &Pending, id: &str, decision: Decision) -> bool {
    if let Some(tx) = pending.lock().unwrap().remove(id) {
        let _ = tx.send(decision);
        true
    } else {
        false
    }
}

/// Fail any outstanding requests (e.g. on cancel) with Deny.
pub fn deny_all(pending: &Pending) {
    let mut map = pending.lock().unwrap();
    for (_, tx) in map.drain() {
        let _ = tx.send(Decision::Deny);
    }
}

/// Decide whether a mutating tool call may proceed.
pub async fn gate(
    app: &AppHandle,
    channel: &str,
    policy: &str,
    pending: &Pending,
    cancel: &Arc<AtomicBool>,
    tool: &str,
    summary: &str,
    input: &Value,
) -> Decision {
    match policy {
        "allow" => return Decision::Allow,
        "deny" => return Decision::Deny,
        _ => {}
    }

    let id = Uuid::new_v4().to_string();
    let (tx, mut rx) = oneshot::channel();
    pending.lock().unwrap().insert(id.clone(), tx);

    // Route through the canonical emit chokepoint so a paired phone receives the
    // prompt too. Emitting directly here (the old bug) reached only the desktop, so
    // a remote turn that hit an "ask" tool hung forever with no prompt on either end.
    crate::sync::emit_event(
        app,
        channel,
        StreamEvent::PermissionRequest {
            id: id.clone(),
            tool: tool.to_string(),
            summary: summary.to_string(),
            input: input.clone(),
        },
    );

    // Await the decision while remaining responsive to cancellation.
    loop {
        tokio::select! {
            biased;
            res = &mut rx => {
                return res.unwrap_or(Decision::Deny);
            }
            _ = tokio::time::sleep(Duration::from_millis(150)) => {
                if cancel.load(Ordering::Relaxed) {
                    pending.lock().unwrap().remove(&id);
                    return Decision::Deny;
                }
            }
        }
    }
}
