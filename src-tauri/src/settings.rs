use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::permissions::{PermissionMode, Rule};

/// User-facing settings. Field names are camelCase to match the TS frontend.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub provider: String,
    pub model: String,
    /// Derived from the OS credential store at read time; never the source of truth.
    #[serde(default)]
    pub api_key_set: bool,
    /// Legacy global policy (allow/ask/deny). Retained for back-compat: it is the
    /// `Default` permission mode's fallthrough, so a settings file written before
    /// modes existed behaves identically. New, finer control lives in
    /// `permission_mode` + `rules`.
    pub default_policy: String,
    pub workspace: Option<String>,
    /// UI preference: reveal agent replies with a terminal-style typing
    /// animation. `default` keeps older settings.json files (written before this
    /// field existed) loading cleanly instead of resetting every setting.
    #[serde(default = "default_typing_animation")]
    pub typing_animation: bool,
    /// The permission mode (default/acceptEdits/plan/auto/bypass). `#[serde(default)]`
    /// → `Default` for older settings files, preserving today's behaviour.
    #[serde(default)]
    pub permission_mode: PermissionMode,
    /// Per-tool / per-command permission rules, evaluated before the mode default.
    /// Defaults to empty (no rules) for older settings files.
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// Whether the desktop app checks for and offers updates. Defaults to true so
    /// the safe behaviour (staying current) is opt-out, not opt-in. `default`
    /// keeps older settings.json files (written before this field existed) loading
    /// cleanly instead of unwrap_or_default()-wiping every setting.
    #[serde(default = "default_auto_update")]
    pub auto_update: bool,
}

fn default_typing_animation() -> bool {
    true
}

fn default_auto_update() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            provider: "anthropic".into(),
            model: "claude-opus-4-8".into(),
            api_key_set: false,
            default_policy: "ask".into(),
            workspace: None,
            typing_animation: default_typing_animation(),
            // A new install is never auto/bypass: Default mode + no rules → falls
            // through to default_policy = "ask".
            permission_mode: PermissionMode::Default,
            rules: Vec::new(),
            auto_update: default_auto_update(),
        }
    }
}

impl Settings {
    fn path(dir: &Path) -> std::path::PathBuf {
        dir.join("settings.json")
    }

    pub fn load(dir: &Path) -> Self {
        match std::fs::read_to_string(Self::path(dir)) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, dir: &Path) {
        if let Ok(s) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(Self::path(dir), s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::RuleDecision;

    #[test]
    fn legacy_settings_without_typing_animation_still_load() {
        // A settings.json written before `typingAnimation` existed must keep its
        // other fields and default the new one — not get wiped via
        // unwrap_or_default() because one field is missing.
        let json = r#"{
            "provider": "anthropic",
            "model": "claude-opus-4-8",
            "apiKeySet": true,
            "defaultPolicy": "allow",
            "workspace": null
        }"#;
        let s: Settings = serde_json::from_str(json).expect("legacy settings should deserialize");
        assert_eq!(s.default_policy, "allow");
        assert!(
            s.typing_animation,
            "missing typingAnimation defaults to true"
        );
        // Permission modes/rules were added later: a legacy file defaults them to
        // Default + empty, so its behaviour (allow/ask/deny via default_policy) is
        // unchanged — no silent safety downgrade or settings wipe.
        assert_eq!(s.permission_mode, PermissionMode::Default);
        assert!(s.rules.is_empty());
    }

    #[test]
    fn a_new_install_is_never_auto_or_bypass() {
        // Safety default: a fresh install must be Default mode + "ask", never a
        // mode that auto-runs mutating tools.
        let s = Settings::default();
        assert_eq!(s.permission_mode, PermissionMode::Default);
        assert_eq!(s.default_policy, "ask");
        assert!(s.rules.is_empty());
    }

    #[test]
    fn permission_mode_and_rules_round_trip_camel_case() {
        let s = Settings {
            permission_mode: PermissionMode::AcceptEdits,
            rules: vec![Rule {
                tool: "shell".into(),
                command: Some("git ".into()),
                decision: RuleDecision::Allow,
            }],
            ..Settings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"permissionMode\":\"acceptEdits\""));
        assert!(json.contains("\"tool\":\"shell\""));
        assert!(json.contains("\"command\":\"git \""));
        assert!(json.contains("\"decision\":\"allow\""));

        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.permission_mode, PermissionMode::AcceptEdits);
        assert_eq!(back.rules.len(), 1);
        assert_eq!(back.rules[0].tool, "shell");
        assert_eq!(back.rules[0].command.as_deref(), Some("git "));
        assert_eq!(back.rules[0].decision, RuleDecision::Allow);
    }

    #[test]
    fn typing_animation_serializes_as_camel_case_and_round_trips() {
        let s = Settings {
            typing_animation: false,
            ..Settings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"typingAnimation\":false"));

        let back: Settings = serde_json::from_str(&json).unwrap();
        assert!(!back.typing_animation);
    }

    #[test]
    fn legacy_settings_without_auto_update_still_load() {
        // A settings.json written before `autoUpdate` existed must keep its other
        // fields and default the new one to true — not get wiped via
        // unwrap_or_default() because one field is missing.
        let json = r#"{
            "provider": "anthropic",
            "model": "claude-opus-4-8",
            "apiKeySet": true,
            "defaultPolicy": "allow",
            "workspace": null,
            "typingAnimation": false
        }"#;
        let s: Settings = serde_json::from_str(json).expect("legacy settings should deserialize");
        assert_eq!(s.default_policy, "allow");
        assert!(!s.typing_animation, "explicit typingAnimation is preserved");
        assert!(s.auto_update, "missing autoUpdate defaults to true");
    }

    #[test]
    fn auto_update_serializes_as_camel_case_and_round_trips() {
        let s = Settings {
            auto_update: false,
            ..Settings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"autoUpdate\":false"));

        let back: Settings = serde_json::from_str(&json).unwrap();
        assert!(!back.auto_update);

        // And the default round-trips as true.
        let json_true = serde_json::to_string(&Settings::default()).unwrap();
        assert!(json_true.contains("\"autoUpdate\":true"));
    }
}
