//! Live subagent registry: tracks each running subagent's cancel flag so a
//! per-agent Stop (the agents panel) or a session-wide Stop (the composer's Stop)
//! can reach it.
//!
//! In PR1 a subagent simply shared its parent's cancel flag. PR2 gives each its
//! OWN flag, registered here, so the UI can cancel one subagent without stopping
//! the rest — while a session-wide Stop still cancels every subagent at once by
//! flipping all of a session's flags. Desktop-only: the spawner and the command
//! handlers that drive this are `#[cfg(desktop)]`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// One live subagent: which session it belongs to, which subagent (if any)
/// launched it, and its cancel flag.
pub struct AgentEntry {
    pub session_id: String,
    /// The launching subagent's id, or `None` for one launched directly by the
    /// top-level run. Used to cascade a per-agent cancel to descendants.
    pub parent_id: Option<String>,
    pub cancel: Arc<AtomicBool>,
}

/// Live subagents keyed by agent id. Shared like `permissions::Pending` and the
/// per-session `cancels` map.
pub type Agents = Arc<Mutex<HashMap<String, AgentEntry>>>;

/// A fresh, empty registry (one per `AppState`).
pub fn new() -> Agents {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Register a freshly spawned subagent and hand back its cancel flag (which the
/// child loop then observes). The flag starts un-cancelled.
pub fn register(
    agents: &Agents,
    agent_id: &str,
    session_id: &str,
    parent_id: Option<String>,
) -> Arc<AtomicBool> {
    let cancel = Arc::new(AtomicBool::new(false));
    agents.lock().unwrap().insert(
        agent_id.to_string(),
        AgentEntry {
            session_id: session_id.to_string(),
            parent_id,
            cancel: cancel.clone(),
        },
    );
    cancel
}

/// Deregister a subagent once its run returns (success, error, or cancel).
pub fn finish(agents: &Agents, agent_id: &str) {
    agents.lock().unwrap().remove(agent_id);
}

/// Cancel every live subagent of a session — the session-wide Stop. The
/// top-level run's own cancel flag lives in the separate `cancels` map and is
/// flipped by the caller alongside this.
pub fn cancel_session(agents: &Agents, session_id: &str) {
    let map = agents.lock().unwrap();
    for entry in map.values() {
        if entry.session_id == session_id {
            entry.cancel.store(true, Ordering::Relaxed);
        }
    }
}

/// Cancel one subagent AND all of its descendants (the per-agent Stop). Cancelling
/// a parent without its children would leave the parent blocked awaiting a child
/// that keeps running, so the cancel cascades down the `parent_id` chain.
pub fn cancel_one(agents: &Agents, agent_id: &str) {
    let map = agents.lock().unwrap();
    // Grow the target set to a fixpoint: the agent itself, then anything whose
    // parent is already a target, repeatedly. The live set is small (bounded by
    // the depth/parallel caps), so this terminates quickly.
    let mut targets: HashSet<String> = HashSet::new();
    targets.insert(agent_id.to_string());
    loop {
        let mut added = false;
        for (id, entry) in map.iter() {
            if let Some(parent) = &entry.parent_id {
                if targets.contains(parent) && targets.insert(id.clone()) {
                    added = true;
                }
            }
        }
        if !added {
            break;
        }
    }
    for (id, entry) in map.iter() {
        if targets.contains(id) {
            entry.cancel.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_cancelled(flag: &Arc<AtomicBool>) -> bool {
        flag.load(Ordering::Relaxed)
    }

    #[test]
    fn register_then_finish_adds_and_removes_the_entry() {
        let agents = new();
        let flag = register(&agents, "a1", "s1", None);
        assert!(!is_cancelled(&flag));
        assert!(agents.lock().unwrap().contains_key("a1"));
        finish(&agents, "a1");
        assert!(!agents.lock().unwrap().contains_key("a1"));
    }

    #[test]
    fn cancel_session_flips_only_that_sessions_agents() {
        let agents = new();
        let a = register(&agents, "a", "s1", None);
        let b = register(&agents, "b", "s1", None);
        let other = register(&agents, "c", "s2", None);

        cancel_session(&agents, "s1");

        assert!(is_cancelled(&a));
        assert!(is_cancelled(&b));
        // A different session's subagent is untouched.
        assert!(!is_cancelled(&other));
    }

    #[test]
    fn cancel_one_flips_the_agent_and_cascades_to_descendants() {
        let agents = new();
        // a1 -> a2 -> a3 (a chain), plus an unrelated sibling a4 under the root.
        let a1 = register(&agents, "a1", "s1", None);
        let a2 = register(&agents, "a2", "s1", Some("a1".into()));
        let a3 = register(&agents, "a3", "s1", Some("a2".into()));
        let a4 = register(&agents, "a4", "s1", None);

        cancel_one(&agents, "a1");

        // The whole subtree rooted at a1 is cancelled...
        assert!(is_cancelled(&a1));
        assert!(is_cancelled(&a2));
        assert!(is_cancelled(&a3));
        // ...but an unrelated sibling is not.
        assert!(!is_cancelled(&a4));
    }

    #[test]
    fn cancel_one_on_a_leaf_does_not_touch_its_ancestors() {
        let agents = new();
        let a1 = register(&agents, "a1", "s1", None);
        let a2 = register(&agents, "a2", "s1", Some("a1".into()));

        cancel_one(&agents, "a2");

        // Only the leaf is cancelled; its parent keeps running.
        assert!(is_cancelled(&a2));
        assert!(!is_cancelled(&a1));
    }

    #[test]
    fn cancel_one_for_an_unknown_agent_is_a_noop() {
        let agents = new();
        let a = register(&agents, "a", "s1", None);
        cancel_one(&agents, "does-not-exist");
        assert!(!is_cancelled(&a));
    }
}
