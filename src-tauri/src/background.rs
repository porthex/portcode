//! Live background command tasks (`run_command` with `background: true`), tracked so a
//! session-wide Stop can kill the ones it launched. Each entry holds a one-shot
//! cancellation signal for the waiter, which remains responsible for terminating
//! and reaping its child before reporting a terminal event. Desktop-only: only the
//! desktop runs the agent loop that launches background tasks.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

/// The waiter's half of a background-task cancellation signal.
pub type Cancellation = oneshot::Receiver<()>;

/// One live background task: which session launched it, what command it runs, and
/// the signal used to ask its waiter to cancel and clean up the child.
pub struct BackgroundEntry {
    pub session_id: String,
    pub command: String,
    cancel: Option<oneshot::Sender<()>>,
}

/// Live background tasks keyed by task id. Shared like the other registries.
pub type Background = Arc<Mutex<HashMap<String, BackgroundEntry>>>;

/// A fresh, empty registry (one per `AppState`).
pub fn new() -> Background {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Record a launched background task and return the signal its waiter must watch.
pub fn register(bg: &Background, id: &str, session_id: &str, command: &str) -> Cancellation {
    let (cancel, cancelled) = oneshot::channel();
    bg.lock().unwrap().insert(
        id.to_string(),
        BackgroundEntry {
            session_id: session_id.to_string(),
            command: command.to_string(),
            cancel: Some(cancel),
        },
    );
    cancelled
}

/// Deregister a task once its waiter has reported completion. (The waiter is the
/// task being removed; it has finished, so no cancellation signal is needed.)
pub fn finish(bg: &Background, id: &str) {
    bg.lock().unwrap().remove(id);
}

/// Whether the session still owns an executing background command.
pub fn has_session(bg: &Background, session_id: &str) -> bool {
    bg.lock()
        .unwrap()
        .values()
        .any(|entry| entry.session_id == session_id)
}

/// Ask every background task of a session to stop. The waiter owns process-tree
/// termination, terminal event emission, receipt cleanup, and final deregistration.
/// Returns how many newly-live cancellation signals were sent.
pub fn cancel_session(bg: &Background, session_id: &str) -> usize {
    let mut map = bg.lock().unwrap();
    let mut cancelled = 0;
    for entry in map.values_mut() {
        if entry.session_id == session_id {
            if let Some(signal) = entry.cancel.take() {
                let _ = signal.send(());
                cancelled += 1;
            }
        }
    }
    cancelled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_then_finish_adds_and_removes_the_entry() {
        let bg = new();
        let _cancelled = register(&bg, "t1", "s1", "npm run dev");
        assert!(bg.lock().unwrap().contains_key("t1"));
        finish(&bg, "t1");
        assert!(!bg.lock().unwrap().contains_key("t1"));
    }

    #[tokio::test]
    async fn cancel_session_signals_only_that_sessions_tasks_without_early_removal() {
        let bg = new();
        let cancelled1 = register(&bg, "t1", "s1", "cmd1");
        let mut cancelled2 = register(&bg, "t2", "s2", "cmd2");

        let signalled = cancel_session(&bg, "s1");

        assert_eq!(signalled, 1);
        assert!(bg.lock().unwrap().contains_key("t1"));
        assert!(bg.lock().unwrap().contains_key("t2"));
        cancelled1.await.expect("s1 waiter receives Stop");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut cancelled2)
                .await
                .is_err(),
            "s2 waiter must remain live"
        );
        assert_eq!(cancel_session(&bg, "s1"), 0, "Stop is signalled once");
        finish(&bg, "t1");
        finish(&bg, "t2");
    }

    #[tokio::test]
    async fn cancel_session_for_an_unknown_session_is_a_noop() {
        let bg = new();
        let mut cancelled = register(&bg, "t1", "s1", "cmd");
        assert_eq!(cancel_session(&bg, "nope"), 0);
        assert!(bg.lock().unwrap().contains_key("t1"));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut cancelled)
                .await
                .is_err()
        );
        finish(&bg, "t1");
    }
}
