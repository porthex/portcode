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

/// Outstanding "ask" permission requests, keyed by request id. The value pairs the
/// owning `session_id` with the reply channel, so a cancel can deny only that
/// session's prompts instead of every concurrent session's.
pub type Pending = Arc<Mutex<HashMap<String, (String, oneshot::Sender<Decision>)>>>;

/// Resolve a request id with a decision (called from the `resolve_permission`
/// command). Returns true if a waiter was found.
pub fn resolve(pending: &Pending, id: &str, decision: Decision) -> bool {
    if let Some((_session_id, tx)) = pending.lock().unwrap().remove(id) {
        let _ = tx.send(decision);
        true
    } else {
        false
    }
}

/// Fail the outstanding requests for ONE session (e.g. on cancel) with Deny,
/// leaving other concurrent sessions' pending prompts untouched.
pub fn deny_all(pending: &Pending, session_id: &str) {
    let mut map = pending.lock().unwrap();
    let ids: Vec<String> = map
        .iter()
        .filter_map(|(id, entry)| {
            if entry.0 == session_id {
                Some(id.clone())
            } else {
                None
            }
        })
        .collect();
    for id in ids {
        if let Some((_, tx)) = map.remove(&id) {
            let _ = tx.send(Decision::Deny);
        }
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

    // The channel is `agent://{session_id}`; recover the session so a later cancel
    // denies only this session's pending prompts (not every session's).
    let session_id = channel
        .strip_prefix("agent://")
        .unwrap_or(channel)
        .to_string();
    let id = Uuid::new_v4().to_string();
    let (tx, mut rx) = oneshot::channel();
    pending.lock().unwrap().insert(id.clone(), (session_id, tx));

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_all_only_denies_the_named_session() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx_a, mut rx_a) = oneshot::channel::<Decision>();
        let (tx_b, mut rx_b) = oneshot::channel::<Decision>();
        pending
            .lock()
            .unwrap()
            .insert("req-a".into(), ("sess-a".into(), tx_a));
        pending
            .lock()
            .unwrap()
            .insert("req-b".into(), ("sess-b".into(), tx_b));

        deny_all(&pending, "sess-a");

        // sess-a's prompt was denied; sess-b's is left pending and intact.
        assert!(matches!(rx_a.try_recv(), Ok(Decision::Deny)));
        assert!(matches!(
            rx_b.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(pending.lock().unwrap().contains_key("req-b"));
    }
}
