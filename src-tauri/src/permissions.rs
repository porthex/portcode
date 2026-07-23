//! Persisted permission preferences projected onto Codex app-server policies.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    #[default]
    Default,
    AcceptEdits,
    Plan,
    Auto,
    Bypass,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleDecision {
    Allow,
    Ask,
    Deny,
}

/// Kept for settings-file compatibility. Codex is the sole enforcement engine;
/// Portcode does not run a second tool gate.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub decision: RuleDecision,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_modes_and_rules_keep_the_existing_wire_shape() {
        let mode = serde_json::to_value(PermissionMode::AcceptEdits).unwrap();
        assert_eq!(mode, "acceptEdits");
        let rule = Rule {
            tool: "run_command".into(),
            command: Some("git status".into()),
            decision: RuleDecision::Ask,
        };
        assert_eq!(serde_json::to_value(rule).unwrap()["decision"], "ask");
    }
}
