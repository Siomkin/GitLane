//! Runtime updater-channel check (GL-154). The implementation — the endpoint
//! constants and the updater rebuild — lives in `crate::updater`.

use super::{boundary, CommandError};
use crate::updater::UpdateMetadata;
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
