//! Runtime updater-channel check (GL-154) and the "What's new" release notes.
//! The implementation — the endpoint constants, the updater rebuild and the
//! Releases fetch — lives in `crate::updater`.

use super::{blocking, boundary, CommandError};
use crate::updater::{ReleaseNotes, UpdateMetadata};
use tauri::Webview;

/// Check for an update on the selected channel. The endpoint is overridden
/// **explicitly for both channels** — stable `/latest/` when `beta = false`, the
/// beta manifest when `beta = true` — rather than falling back to the build's
/// baked-in default. That default differs per build (stable builds bake
/// `/latest/`, beta builds bake the beta manifest via `tauri.beta.conf.json`), so
/// relying on it would leave a beta-built install stuck on beta after the user
/// turns the toggle off (GL-154 review). Only `.endpoints()` is overridden, so
/// the config signing pubkey is retained and signature verification stays on.
/// Resolves to `None` when already up to date.
#[tauri::command]
pub async fn check_update_on_channel(
    webview: Webview,
    beta: bool,
) -> Result<Option<UpdateMetadata>, CommandError> {
    // Genuinely async (the plugin's HTTP check), so it cannot sit inside
    // `blocking`; `boundary` still converts and redacts the error once.
    boundary(crate::updater::check(webview, beta).await)
}

/// Release notes for every release after `current_version`, up to and including
/// `offered_version`, newest first, on the selected channel (stable leaves out
/// pre-releases). One unauthenticated GET to the public GitHub Releases API, made
/// here so the webview CSP stays IPC-only. Invalid versions fail before any request.
#[tauri::command]
pub async fn list_release_notes(
    current_version: String,
    offered_version: String,
    beta: bool,
) -> Result<ReleaseNotes, CommandError> {
    blocking(move || crate::updater::release_notes(&current_version, &offered_version, beta)).await
}
