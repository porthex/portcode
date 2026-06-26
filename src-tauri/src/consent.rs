//! Cross-target crash-reporting consent flag (the on-disk opt-in).
//!
//! Phase 1b/2 kept these helpers inside `telemetry.rs`, which is `#[cfg(desktop)]`
//! and so does NOT compile for the Android/iOS cross-compile. Phase 3 (Android
//! native crash capture) needs the PHONE to record consent too — the Kotlin
//! `PortcodeApplication` reads the flag before it ever calls `SentryAndroid.init`.
//! So the consent-file primitive lives HERE, in a module that is NOT cfg-gated and
//! compiles on every target (desktop, Android, iOS). `telemetry.rs` re-uses it via
//! `crate::consent::*`; mobile drives it through the (now cross-target)
//! `telemetry_set_consent` command.
//!
//! ── THE CONTRACT ────────────────────────────────────────────────────────────────
//! Consent lives ON DISK as a one-byte flag inside the app's private config dir:
//!   * content trimmed to `"1"` ⇒ consent is LIVE (opt-in)
//!   * absent, unreadable, or ANY other content ⇒ OFF (the fail-safe)
//! Every read fails safe to OFF, so a missing dir, an IO error, or a partially
//! written file can never arm reporting. This is the same flag the desktop's
//! separate (re-exec'd) crash-reporter process reads, and the same flag the Android
//! `PortcodeApplication` reads — one source of truth, no IPC.
//!
//! ── DESKTOP path ────────────────────────────────────────────────────────────────
//! `consent_path()` reproduces Tauri's own `app_config_dir()` =
//! `dirs::config_dir().join(<identifier>)` so the path resolves WITHOUT an
//! `AppHandle` (the desktop crash-reporter child and `init_desktop_with_minidump`
//! both run before/without managed state). `dirs` is a desktop-only dep (see
//! Cargo.toml), so this fn is `#[cfg(desktop)]`; mobile never calls it.
//!
//! ── MOBILE path (Android) ──────────────────────────────────────────────────────
//! On Android `dirs::config_dir()` does NOT reliably resolve to the app sandbox
//! that Kotlin's `Context.getFilesDir()` sees, so the phone must NOT use it. Instead
//! the mobile `telemetry_set_consent` command resolves the app-private dir from the
//! Tauri `AppHandle` (`app_config_dir()`, which IS inside the sandbox) and calls
//! `set_consent_in(dir, …)`. The Kotlin side reads the SAME relative file. See
//! `PortcodeApplication.kt` for the exact path agreement (and the device-verify note).

use std::path::{Path, PathBuf};

/// This app's bundle identifier — kept in lockstep with `tauri.conf.json`'s
/// `identifier` (and `secrets.rs` `SERVICE`). Used by the desktop path resolver.
pub const BUNDLE_IDENTIFIER: &str = "dev.porthex.portcode";

/// Name of the on-disk consent flag file inside the app config dir. Dotfile so it
/// reads as internal state, not a user document.
///
/// AGREEMENT WITH KOTLIN: `PortcodeApplication.kt` reads a file of this exact name
/// from the app's files dir. Keep the two in sync.
pub const CONSENT_FILE: &str = ".telemetry_consent";

// Test-only per-thread override for the consent-file path (desktop tests). `cargo
// test` runs tests in parallel threads sharing this module's statics, so a
// THREAD-LOCAL (not a global) lets each test drive its OWN on-disk consent at a
// unique temp path — isolated, race-free, never touching the user's real config
// dir. In production this hook does not exist; `consent_path` resolves the real path.
#[cfg(all(test, desktop))]
thread_local! {
    static CONSENT_PATH_OVERRIDE: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// DESKTOP: absolute path of the consent file:
/// `<app_config_dir>/.telemetry_consent`, where `<app_config_dir>` reproduces
/// Tauri's `app_config_dir()` = `dirs::config_dir().join(<identifier>)`. Returns
/// `None` only if the platform has no config dir (then consent reads as off — fail
/// safe). Desktop-only: `dirs` is a desktop-only dependency.
#[cfg(desktop)]
pub fn consent_path() -> Option<PathBuf> {
    #[cfg(test)]
    {
        if let Some(p) = CONSENT_PATH_OVERRIDE.with(|c| c.borrow().clone()) {
            return Some(p);
        }
    }
    Some(
        dirs::config_dir()?
            .join(BUNDLE_IDENTIFIER)
            .join(CONSENT_FILE),
    )
}

/// TEST-ONLY (desktop): point this thread's desktop `consent_path()` at an explicit
/// file (or clear the override with `None`). Lets sibling modules' tests
/// (`telemetry.rs`) drive the desktop consent gate at a unique temp path without
/// touching the real config dir. Compiled only under `cfg(all(test, desktop))`, so
/// it never widens the runtime API.
#[cfg(all(test, desktop))]
pub fn test_set_consent_path_override(path: Option<PathBuf>) {
    CONSENT_PATH_OVERRIDE.with(|c| *c.borrow_mut() = path);
}

/// The consent file inside an explicit app-config dir. Used by the MOBILE command
/// (which resolves the dir from the Tauri `AppHandle`) and by tests. Pure path join
/// — no IO, no platform assumptions.
pub fn consent_path_in(dir: &Path) -> PathBuf {
    dir.join(CONSENT_FILE)
}

/// The AUTHORITATIVE consent check for the DESKTOP host, readable from BOTH the
/// main and re-exec'd crash-reporter processes. Reads the on-disk flag: trimmed
/// `"1"` ⇒ live; absent, unreadable, or anything else ⇒ off. Fails safe to OFF on
/// every error path. Desktop-only (uses the desktop `consent_path`); the Android
/// consent check lives in Kotlin (`PortcodeApplication.kt`), reading the same flag.
#[cfg(desktop)]
pub fn consent_is_live() -> bool {
    match consent_path() {
        Some(p) => is_live_at(&p),
        None => false,
    }
}

/// Read the flag at an explicit path: trimmed `"1"` ⇒ live, everything else ⇒ off.
/// The shared fail-safe read used by both the desktop and dir-scoped checks.
pub fn is_live_at(path: &Path) -> bool {
    matches!(std::fs::read_to_string(path), Ok(s) if s.trim() == "1")
}

/// DESKTOP: write/clear the authoritative on-disk consent flag at the desktop
/// `consent_path()`. Best-effort IO (errors swallowed); the fail-safe is OFF, so a
/// failed write on opt-IN simply means nothing is sent — never the reverse. See
/// `set_consent_at` for the actual write logic.
#[cfg(desktop)]
pub fn set_consent(enabled: bool) {
    let Some(path) = consent_path() else { return };
    set_consent_at(&path, enabled);
}

/// MOBILE / dir-scoped: write/clear the consent flag inside an explicit app-config
/// dir. The Android `telemetry_set_consent` command resolves `dir` from the Tauri
/// `AppHandle` (`app_config_dir()`, inside the sandbox) and calls this. Best-effort
/// IO with the same OFF fail-safe as the desktop writer.
pub fn set_consent_in(dir: &Path, enabled: bool) {
    set_consent_at(&consent_path_in(dir), enabled);
}

/// Shared writer: `true` ⇒ write `"1"`; `false` ⇒ remove the file (best-effort),
/// falling back to overwriting it with `"0"` so a failed removal still reads as off.
/// Ensures the parent dir exists on opt-in (it normally does — settings/db live
/// there). All IO is best-effort; the OFF fail-safe makes a failed opt-in write the
/// privacy-safe direction.
fn set_consent_at(path: &Path, enabled: bool) {
    if enabled {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, "1");
    } else if std::fs::remove_file(path).is_err() {
        // Removing is enough on success; if removal fails the leftover content is
        // "1", so as belt-and-suspenders overwrite with "0" (read as off).
        let _ = std::fs::write(path, "0");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "portcode-consent-test-{}-{}-{:?}",
            tag,
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn off_when_file_absent() {
        let dir = temp_dir("absent");
        assert!(!is_live_at(&consent_path_in(&dir)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn off_for_non_one_content() {
        let dir = temp_dir("noncontent");
        let path = consent_path_in(&dir);
        std::fs::write(&path, "0").unwrap();
        assert!(!is_live_at(&path));
        std::fs::write(&path, "yes").unwrap();
        assert!(!is_live_at(&path));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn live_only_for_exact_trimmed_one() {
        let dir = temp_dir("one");
        let path = consent_path_in(&dir);
        std::fs::write(&path, "1").unwrap();
        assert!(is_live_at(&path));
        // Trailing whitespace/newline is trimmed, still live.
        std::fs::write(&path, "1\n").unwrap();
        assert!(is_live_at(&path));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_consent_in_writes_then_clears() {
        let dir = temp_dir("setin");
        let path = consent_path_in(&dir);
        set_consent_in(&dir, true);
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), "1");
        assert!(is_live_at(&path));

        set_consent_in(&dir, false);
        assert!(!is_live_at(&path));
        // Either removed, or overwritten to "0" — both read as off.
        assert!(!path.exists() || std::fs::read_to_string(&path).unwrap().trim() != "1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_consent_in_creates_missing_parent_dir() {
        let dir = temp_dir("mkparent").join("nested").join("deep");
        // dir does NOT exist yet; opt-in must create it.
        set_consent_in(&dir, true);
        assert!(is_live_at(&consent_path_in(&dir)));
        let _ = std::fs::remove_dir_all(dir.parent().unwrap().parent().unwrap());
    }
}
