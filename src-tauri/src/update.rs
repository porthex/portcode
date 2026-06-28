// Auto-updater command surface (Phase 2 #1).
//
// The `tauri-plugin-updater` plugin is registered in `lib.rs`, but the JS side
// invokes OUR OWN commands here rather than the plugin's built-in commands. That
// keeps the capability surface minimal: our commands are listed in the desktop
// `generate_handler!` only, so no `capabilities/*.json` ACL entry for the
// `updater:` plugin is needed (the plugin's own commands are never exposed to JS).
//
// Update checks are pull-only and the downloaded artifact's Ed25519 signature is
// verified by the plugin against `plugins.updater.pubkey` before install, so a
// channel override only changes WHICH signed manifest we read, never the trust
// root. We deliberately do NOT auto-restart after install — the UI prompts the
// user and then calls `update_relaunch` so an update never yanks the app out from
// under an in-flight agent turn.
//
// Everything here is `#[cfg(desktop)]`: the phone is a pure remote CLIENT and
// never self-updates.

#![cfg(desktop)]

use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

/// The compile-time release channel. Defaults to `"stable"`; a build with
/// `PORTCODE_CHANNEL=staging` (or the common aliases) opts into the rolling
/// pre-release channel. `build.rs` reruns when this env var changes so a stable
/// and a staging build never share a cached artifact.
pub fn channel() -> &'static str {
    match option_env!("PORTCODE_CHANNEL") {
        Some("staging") | Some("pre-release") | Some("prerelease") | Some("beta") => "staging",
        _ => "stable",
    }
}

/// Update metadata handed to the frontend. camelCase to match the TS client.
/// `pub(crate)` (not private): it's the return type of the `pub` `update_check`
/// command, which `generate_handler!` reaches at crate visibility — a private
/// struct there trips `-D private-interfaces` under clippy.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    /// The version offered by the remote manifest.
    version: String,
    /// The currently-running app version (so the UI can render "X → Y").
    current_version: String,
    /// Release notes / changelog body, if the manifest provided any.
    notes: Option<String>,
    /// Publish date as a display string, if the manifest provided one.
    date: Option<String>,
}

/// Build a channel-aware updater. The stable channel uses GitHub's
/// `releases/latest` redirect; the staging channel pins the rolling `staging`
/// pre-release tag. We override the endpoint at runtime instead of in
/// `tauri.conf.json` so the config's stable endpoint stays the default and only
/// a staging build diverges.
fn build_updater(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoint = match channel() {
        "staging" => "https://github.com/porthex/portcode/releases/download/staging/latest.json",
        _ => "https://github.com/porthex/portcode/releases/latest/download/latest.json",
    };
    // `reqwest::Url` IS `url::Url` (single `url` version in the lock), and reqwest
    // is already a direct dependency — so we get a correctly-typed endpoint without
    // adding `url` as a new dep.
    let url = endpoint
        .parse::<reqwest::Url>()
        .map_err(|e| e.to_string())?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

/// Check the channel's manifest for a newer signed release. Returns `None` when
/// the app is already up to date.
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = build_updater(&app)?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    // `u` is owned and dropped right after, so move each field out rather than
    // clone. `date` is an `Option<OffsetDateTime>` rendered via Display.
    Ok(update.map(|u| UpdateInfo {
        version: u.version,
        current_version: u.current_version,
        notes: u.body,
        date: u.date.map(|d| d.to_string()),
    }))
}

/// Download and install the available update, emitting progress as it goes. The
/// install step stages the new binary; the app is NOT restarted here — the UI
/// asks the user, then calls `update_relaunch`.
///
/// Events emitted (all desktop-only):
///   - `updater://progress` → `{ downloaded: u64, total: u64 | null }` per chunk
///   - `updater://finished` → `()` once the download completes (before install)
#[tauri::command]
pub async fn update_download_and_install(app: tauri::AppHandle) -> Result<bool, String> {
    let updater = build_updater(&app)?;
    let update = match updater.check().await.map_err(|e| e.to_string())? {
        Some(u) => u,
        // Already up to date (or the offer raced away) — nothing to install.
        None => return Ok(false),
    };

    // Track cumulative bytes across chunks; the crate hands us each chunk's length
    // plus the (optional) total content length so the UI can show a percentage.
    let app_progress = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk_length: usize, content_length: Option<u64>| {
                downloaded += chunk_length as u64;
                // Best-effort: a dropped listener must not abort the download.
                let _ = app_progress.emit(
                    "updater://progress",
                    serde_json::json!({ "downloaded": downloaded, "total": content_length }),
                );
            },
            move || {
                let _ = app.emit("updater://finished", ());
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(true)
}

/// Relaunch the app to apply a staged update. `AppHandle::restart` returns `!`,
/// so this command can never return — no `Result` needed. Used by the UI after
/// `update_download_and_install` succeeds and the user accepts the restart prompt.
#[tauri::command]
pub fn update_relaunch(app: tauri::AppHandle) {
    app.restart();
}

/// Report the compile-time channel so the UI can adjust copy (e.g. "staging").
#[tauri::command]
pub fn update_channel() -> &'static str {
    channel()
}
