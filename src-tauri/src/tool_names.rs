//! Stable names for the tools exposed to language models.
//!
//! The canonical names are the only names advertised in model tool specs. The
//! original Portcode names remain accepted at runtime so an in-flight response,
//! an older model transcript, or a persisted permission rule keeps working after
//! the rename.

pub const READ_FILE: &str = "read_file";
pub const LIST_DIRECTORY: &str = "list_directory";
pub const FIND_FILES: &str = "find_files";
pub const SEARCH_TEXT: &str = "search_text";
pub const WRITE_FILE: &str = "write_file";
pub const EDIT_FILE: &str = "edit_file";
pub const RUN_COMMAND: &str = "run_command";
pub const DELEGATE_TASK: &str = "delegate_task";

#[cfg(test)]
pub const CANONICAL_NAMES: [&str; 8] = [
    READ_FILE,
    LIST_DIRECTORY,
    FIND_FILES,
    SEARCH_TEXT,
    WRITE_FILE,
    EDIT_FILE,
    RUN_COMMAND,
    DELEGATE_TASK,
];

/// Legacy name to canonical name pairs. Keep this list explicit: aliases are a
/// compatibility surface, not additional names that should leak into tool specs.
#[cfg(test)]
pub const LEGACY_ALIASES: [(&str, &str); 8] = [
    ("fs_read", READ_FILE),
    ("list", LIST_DIRECTORY),
    ("glob", FIND_FILES),
    ("grep", SEARCH_TEXT),
    ("fs_write", WRITE_FILE),
    ("fs_edit", EDIT_FILE),
    ("shell", RUN_COMMAND),
    ("task", DELEGATE_TASK),
];

/// Return the stable model-facing name for either a canonical name or one of the
/// original Portcode aliases. Unknown names pass through unchanged so callers can
/// still produce a useful "unknown tool" error containing the model's exact input.
pub fn canonical(name: &str) -> &str {
    match name {
        "fs_read" => READ_FILE,
        "list" => LIST_DIRECTORY,
        "glob" => FIND_FILES,
        "grep" => SEARCH_TEXT,
        "fs_write" => WRITE_FILE,
        "fs_edit" => EDIT_FILE,
        "shell" => RUN_COMMAND,
        "task" => DELEGATE_TASK,
        _ => name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_legacy_alias_maps_to_one_unique_canonical_name() {
        let mapped: Vec<&str> = LEGACY_ALIASES
            .iter()
            .map(|(legacy, _)| canonical(legacy))
            .collect();
        assert_eq!(mapped, CANONICAL_NAMES);

        let mut unique = mapped.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), CANONICAL_NAMES.len());
    }

    #[test]
    fn canonical_and_unknown_names_are_stable() {
        for name in CANONICAL_NAMES {
            assert_eq!(canonical(name), name);
        }
        assert_eq!(canonical("future_tool"), "future_tool");
    }
}
