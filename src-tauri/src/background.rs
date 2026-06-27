//! Live background shell tasks (the `shell` tool's `background` mode), tracked so a
//! session-wide Stop can kill the ones it launched. Each entry holds the waiter
//! task's [`AbortHandle`]; the child process is spawned `kill_on_drop`, so aborting
//! the waiter (which owns the child) kills the process. Desktop-only: only the
//! desktop runs the agent loop that launches background tasks.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::task::AbortHandle;

/// One live background task: which session launched it, what command it runs, and
/// the handle that aborts its waiter (and thereby kills the kill-on-drop child).
pub struct BackgroundEntry {
    pub session_id: String,
    pub command: String,
    pub abort: AbortHandle,
}

/// Live background tasks keyed by task id. Shared like the other registries.
pub type Background = Arc<Mutex<HashMap<String, BackgroundEntry>>>;

/// A fresh, empty registry (one per `AppState`).
pub fn new() -> Background {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Record a launched background task.
pub fn register(bg: &Background, id: &str, session_id: &str, command: &str, abort: AbortHandle) {
    bg.lock().unwrap().insert(
        id.to_string(),
        BackgroundEntry {
            session_id: session_id.to_string(),
            command: command.to_string(),
            abort,
        },
    );
}

/// Deregister a task once its waiter has reported completion. (The waiter is the
/// task being removed; it has finished, so no abort is needed.)
pub fn finish(bg: &Background, id: &str) {
    bg.lock().unwrap().remove(id);
}

/// Kill every background task of a session — the session-wide Stop. Each waiter is
/// aborted (its child is kill-on-drop, so the process dies) and removed. Returns
/// how many were killed.
pub fn cancel_session(bg: &Background, session_id: &str) -> usize {
    let mut map = bg.lock().unwrap();
    let ids: Vec<String> = map
        .iter()
        .filter(|(_, e)| e.session_id == session_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in &ids {
        if let Some(entry) = map.remove(id) {
            entry.abort.abort();
        }
    }
    ids.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A task that never completes on its own, so the only way it ends is an abort —
    /// which is exactly what `cancel_session` must do.
    fn spawn_idle() -> tokio::task::JoinHandle<()> {
        tokio::spawn(std::future::pending::<()>())
    }

    #[tokio::test]
    async fn register_then_finish_adds_and_removes_the_entry() {
        let bg = new();
        let h = spawn_idle();
        register(&bg, "t1", "s1", "npm run dev", h.abort_handle());
        assert!(bg.lock().unwrap().contains_key("t1"));
        finish(&bg, "t1");
        assert!(!bg.lock().unwrap().contains_key("t1"));
        h.abort(); // clean up the idle task
    }

    #[tokio::test]
    async fn cancel_session_aborts_and_removes_only_that_sessions_tasks() {
        let bg = new();
        let h1 = spawn_idle();
        let h2 = spawn_idle();
        register(&bg, "t1", "s1", "cmd1", h1.abort_handle());
        register(&bg, "t2", "s2", "cmd2", h2.abort_handle());

        let killed = cancel_session(&bg, "s1");

        assert_eq!(killed, 1);
        assert!(!bg.lock().unwrap().contains_key("t1"));
        assert!(bg.lock().unwrap().contains_key("t2"));
        // s1's waiter was aborted; awaiting it yields a cancelled JoinError.
        assert!(h1.await.unwrap_err().is_cancelled());
        // s2's task is untouched and still running.
        assert!(!h2.is_finished());
        h2.abort();
    }

    #[tokio::test]
    async fn cancel_session_for_an_unknown_session_is_a_noop() {
        let bg = new();
        let h = spawn_idle();
        register(&bg, "t1", "s1", "cmd", h.abort_handle());
        assert_eq!(cancel_session(&bg, "nope"), 0);
        assert!(bg.lock().unwrap().contains_key("t1"));
        h.abort();
    }
}
