use serde::{Deserialize, Serialize};
use std::path::Path;

/// User-facing settings. Field names are camelCase to match the TS frontend.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub provider: String,
    pub model: String,
    /// Derived from the OS credential store at read time; never the source of truth.
    #[serde(default)]
    pub api_key_set: bool,
    pub default_policy: String,
    pub workspace: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            provider: "anthropic".into(),
            model: "claude-opus-4-8".into(),
            api_key_set: false,
            default_policy: "ask".into(),
            workspace: None,
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
