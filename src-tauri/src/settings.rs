use atomicwrites::{AllowOverwrite, AtomicFile};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::io::Write;
use std::path::Path;

use crate::permissions::{PermissionMode, Rule};

/// User-facing settings. Field names are camelCase to match the TS frontend.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub provider: String,
    pub model: String,
    /// Provider reasoning budget. Stored as an open string because model catalogs
    /// can add new levels without requiring a Portcode release.
    #[serde(default = "default_reasoning_effort")]
    pub reasoning_effort: String,
    /// OpenAI processing tier. Kept as a narrow string for forward-compatible
    /// settings files while the UI currently exposes standard and fast.
    #[serde(default = "default_response_speed")]
    pub response_speed: String,
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
    // Streaming should feel instantaneous on a fresh or legacy install. The
    // terminal decode effect remains available as an explicit UI preference.
    false
}

fn default_reasoning_effort() -> String {
    "medium".into()
}

fn default_response_speed() -> String {
    "standard".into()
}

fn default_auto_update() -> bool {
    true
}

// Native half of the command-error contract mirrored by
// src/lib/settingsPersistence.ts::SETTINGS_COMMITTED_DURABILITY_UNCONFIRMED_PREFIX.
// Keep the two literals identical.
pub(crate) const COMMITTED_DURABILITY_UNCONFIRMED_PREFIX: &str =
    "SETTINGS_COMMITTED_DURABILITY_UNCONFIRMED:";

/// A failed atomic write has materially different recovery semantics depending
/// on whether the destination name already points at the candidate bytes.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SettingsSaveError {
    /// The destination is provably unchanged from the pre-write snapshot.
    Uncommitted(String),
    /// The candidate is visible at the destination, but its final metadata sync
    /// failed. Runtime memory must follow the candidate to avoid split-brain.
    CommittedDurabilityUnconfirmed(String),
    /// The destination could not be proven equal to either snapshot.
    StateUnknown(String),
}

impl SettingsSaveError {
    pub(crate) fn candidate_is_committed(&self) -> bool {
        matches!(self, Self::CommittedDurabilityUnconfirmed(_))
    }
}

impl fmt::Display for SettingsSaveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Uncommitted(message) | Self::StateUnknown(message) => {
                formatter.write_str(message)
            }
            Self::CommittedDurabilityUnconfirmed(message) => write!(
                formatter,
                "{COMMITTED_DURABILITY_UNCONFIRMED_PREFIX} Settings were updated, but storage durability could not be confirmed. {message}"
            ),
        }
    }
}

fn read_settings_bytes(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn confirm_parent_durability(directory: &Path) -> std::io::Result<()> {
    std::fs::File::open(directory)?.sync_all()
}

#[cfg(not(unix))]
fn confirm_parent_durability(_directory: &Path) -> std::io::Result<()> {
    // Windows' durability barrier is part of MoveFileExW(WRITE_THROUGH). If that
    // call returned an error after the destination changed, std has no separate
    // safe metadata barrier with which to upgrade the result to durable.
    Err(std::io::Error::other(
        "the write-through replacement reported an error after changing the destination",
    ))
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            provider: "anthropic".into(),
            model: "claude-opus-4-8".into(),
            reasoning_effort: default_reasoning_effort(),
            response_speed: default_response_speed(),
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

    /// Persist settings without exposing a partially-written `settings.json`.
    ///
    /// The temporary file lives beneath the destination's parent, so the final
    /// move stays on one filesystem and uses the platform's atomic replacement
    /// primitive. The replacement is made crash-durable by syncing its parent
    /// directory on Unix and using a write-through move on Windows. Failures are
    /// classified by whether the candidate reached the destination, allowing the
    /// in-memory transaction to follow an already-visible candidate without
    /// treating an unconfirmed durability barrier as a clean save.
    pub(crate) fn save(&self, dir: &Path) -> Result<(), SettingsSaveError> {
        self.save_with(
            dir,
            |destination, bytes| {
                AtomicFile::new(destination, AllowOverwrite)
                    .write(|temporary| temporary.write_all(bytes))
                    .map_err(std::io::Error::from)
            },
            confirm_parent_durability,
        )
    }

    fn save_with(
        &self,
        dir: &Path,
        persist: impl FnOnce(&Path, &[u8]) -> std::io::Result<()>,
        confirm_durability: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<(), SettingsSaveError> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| {
            SettingsSaveError::Uncommitted(format!("failed to serialize settings: {error}"))
        })?;
        std::fs::create_dir_all(dir).map_err(|error| {
            SettingsSaveError::Uncommitted(format!(
                "failed to create settings directory {}: {error}",
                dir.display()
            ))
        })?;

        let destination = Self::path(dir);
        let before = read_settings_bytes(&destination);
        let Err(error) = persist(&destination, &bytes) else {
            return Ok(());
        };
        let after = read_settings_bytes(&destination);

        if matches!(&after, Ok(Some(current)) if current.as_slice() == bytes.as_slice()) {
            return match confirm_durability(dir) {
                Ok(()) => Ok(()),
                Err(sync_error) => Err(SettingsSaveError::CommittedDurabilityUnconfirmed(
                    format!(
                        "Atomic replacement error: {error}. Parent durability retry failed: {sync_error}."
                    ),
                )),
            };
        }

        let base_message = format!(
            "failed to save settings to {}: {error}",
            destination.display()
        );
        match (before, after) {
            (Ok(previous), Ok(current)) if previous == current => {
                Err(SettingsSaveError::Uncommitted(base_message))
            }
            (before, after) => Err(SettingsSaveError::StateUnknown(format!(
                "{base_message}. The destination could not be verified against either snapshot (before: {}; after: {}); the running policy was kept unchanged.",
                snapshot_description(&before),
                snapshot_description(&after),
            ))),
        }
    }
}

fn snapshot_description(snapshot: &std::io::Result<Option<Vec<u8>>>) -> &'static str {
    match snapshot {
        Ok(Some(_)) => "readable",
        Ok(None) => "missing",
        Err(_) => "unreadable",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::RuleDecision;
    use uuid::Uuid;

    struct TestDir(std::path::PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("portcode-settings-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("create settings test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn has_atomic_write_debris(dir: &Path) -> bool {
        std::fs::read_dir(dir).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".atomicwrite")
        })
    }

    #[test]
    fn committed_durability_warning_keeps_the_frontend_prefix_contract() {
        let error = SettingsSaveError::CommittedDurabilityUnconfirmed("sync failed".into());
        assert!(error
            .to_string()
            .starts_with("SETTINGS_COMMITTED_DURABILITY_UNCONFIRMED:"));
    }

    #[test]
    fn save_succeeds_and_reloads_the_committed_settings() {
        let dir = TestDir::new();
        Settings::default()
            .save(&dir.0)
            .expect("initial settings save should succeed");
        let expected = Settings {
            provider: "openai".into(),
            model: "gpt-5".into(),
            permission_mode: PermissionMode::AcceptEdits,
            default_policy: "deny".into(),
            ..Settings::default()
        };

        expected
            .save(&dir.0)
            .expect("replacement settings save should succeed");

        let loaded = Settings::load(&dir.0);
        assert_eq!(loaded.provider, expected.provider);
        assert_eq!(loaded.model, expected.model);
        assert_eq!(loaded.permission_mode, expected.permission_mode);
        assert_eq!(loaded.default_policy, expected.default_policy);
        assert!(
            !has_atomic_write_debris(&dir.0),
            "a successful save must not leave atomic-write debris behind"
        );
    }

    #[test]
    fn save_failure_leaves_the_last_committed_file_unchanged() {
        let dir = TestDir::new();
        let committed = Settings {
            model: "committed-model".into(),
            ..Settings::default()
        };
        committed.save(&dir.0).expect("commit baseline settings");
        let destination = Settings::path(&dir.0);
        let committed_bytes = std::fs::read(&destination).expect("read committed settings");

        let attempted = Settings {
            model: "must-not-commit".into(),
            ..committed
        };
        let error = attempted
            .save_with(
                &dir.0,
                |_destination, _bytes| Err(std::io::Error::other("injected replacement failure")),
                |_directory| panic!("durability retry must not run before replacement"),
            )
            .expect_err("an atomic replacement failure must be returned");

        assert!(matches!(error, SettingsSaveError::Uncommitted(_)));
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            committed_bytes,
            "a failed replacement must preserve the exact prior file"
        );
        assert_eq!(Settings::load(&dir.0).model, "committed-model");
        assert!(
            !has_atomic_write_debris(&dir.0),
            "a failed save must not leave atomic-write debris behind"
        );
    }

    #[test]
    fn post_replace_sync_failure_is_reported_as_committed_but_unconfirmed() {
        let dir = TestDir::new();
        let candidate = Settings {
            model: "candidate-on-disk".into(),
            ..Settings::default()
        };

        let error = candidate
            .save_with(
                &dir.0,
                |destination, bytes| {
                    std::fs::write(destination, bytes)?;
                    Err(std::io::Error::other("injected post-replace failure"))
                },
                |_directory| Err(std::io::Error::other("injected sync retry failure")),
            )
            .expect_err("a failed durability retry must remain visible");

        assert!(matches!(
            error,
            SettingsSaveError::CommittedDurabilityUnconfirmed(_)
        ));
        assert!(error.candidate_is_committed());
        assert_eq!(Settings::load(&dir.0).model, "candidate-on-disk");
    }

    #[test]
    fn successful_parent_sync_retry_upgrades_visible_candidate_to_durable() {
        let dir = TestDir::new();
        let candidate = Settings {
            model: "candidate-retried".into(),
            ..Settings::default()
        };

        candidate
            .save_with(
                &dir.0,
                |destination, bytes| {
                    std::fs::write(destination, bytes)?;
                    Err(std::io::Error::other("injected post-replace failure"))
                },
                |_directory| Ok(()),
            )
            .expect("a successful metadata retry confirms durability");

        assert_eq!(Settings::load(&dir.0).model, "candidate-retried");
    }

    #[test]
    fn unexpected_destination_after_failure_is_state_unknown() {
        let dir = TestDir::new();
        Settings::default().save(&dir.0).unwrap();
        let candidate = Settings {
            model: "candidate".into(),
            ..Settings::default()
        };

        let error = candidate
            .save_with(
                &dir.0,
                |destination, _bytes| {
                    std::fs::write(destination, b"externally changed")?;
                    Err(std::io::Error::other("injected replacement race"))
                },
                |_directory| panic!("durability retry requires exact candidate bytes"),
            )
            .expect_err("a third destination state cannot be classified as uncommitted");

        assert!(matches!(error, SettingsSaveError::StateUnknown(_)));
        assert!(!error.candidate_is_committed());
    }

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
        assert_eq!(s.reasoning_effort, "medium");
        assert_eq!(s.response_speed, "standard");
        assert!(
            !s.typing_animation,
            "missing typingAnimation defaults to lag-free false"
        );
        // Permission modes/rules were added later: a legacy file defaults them to
        // Default + empty, so its behaviour (allow/ask/deny via default_policy) is
        // unchanged — no silent safety downgrade or settings wipe.
        assert_eq!(s.permission_mode, PermissionMode::Default);
        assert!(s.rules.is_empty());
    }

    #[test]
    fn reasoning_effort_is_camel_case_and_legacy_safe() {
        let s = Settings {
            reasoning_effort: "high".into(),
            ..Settings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"reasoningEffort\":\"high\""));
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.reasoning_effort, "high");
    }

    #[test]
    fn response_speed_is_camel_case_and_legacy_safe() {
        let s = Settings {
            response_speed: "fast".into(),
            ..Settings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"responseSpeed\":\"fast\""));
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.response_speed, "fast");
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
    fn permission_mode_and_legacy_and_canonical_rules_round_trip_camel_case() {
        let s = Settings {
            permission_mode: PermissionMode::AcceptEdits,
            rules: vec![
                Rule {
                    // Persisted pre-rename rules stay intact; the permission matcher
                    // resolves this alias when it is evaluated.
                    tool: "shell".into(),
                    command: Some("git ".into()),
                    decision: RuleDecision::Allow,
                },
                Rule {
                    tool: "write_file".into(),
                    command: None,
                    decision: RuleDecision::Ask,
                },
            ],
            ..Settings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"permissionMode\":\"acceptEdits\""));
        assert!(json.contains("\"tool\":\"shell\""));
        assert!(json.contains("\"tool\":\"write_file\""));
        assert!(json.contains("\"command\":\"git \""));
        assert!(json.contains("\"decision\":\"allow\""));

        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.permission_mode, PermissionMode::AcceptEdits);
        assert_eq!(back.rules.len(), 2);
        assert_eq!(back.rules[0].tool, "shell");
        assert_eq!(back.rules[0].command.as_deref(), Some("git "));
        assert_eq!(back.rules[0].decision, RuleDecision::Allow);
        assert_eq!(back.rules[1].tool, "write_file");
        assert_eq!(back.rules[1].command, None);
        assert_eq!(back.rules[1].decision, RuleDecision::Ask);
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
