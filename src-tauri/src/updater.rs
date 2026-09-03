//! Runtime updater channel selection (GL-154) — the implementation behind
//! `commands::updater::check_update_on_channel`.
//!
//! The stable update endpoint is baked into `tauri.conf.json`
//! (`releases/latest/download/latest.json`); the beta channel points at a
//! rolling manifest on a fixed `beta` release (see `docs/release-channels.md`).
//! The JS `@tauri-apps/plugin-updater` `check()` can't switch endpoints at
//! runtime — its options are headers/timeout/proxy/target only — so opting into
//! beta needs a Rust rebuild of the updater with the beta endpoint.
//!
//! [`check`] mirrors the plugin's own `check` command exactly (build the
//! updater, check, park the resulting `Update` in the **webview** resource
//! table, return its metadata by `rid`) so the frontend can reconstruct the
//! plugin's `Update` handle and drive the *unchanged* plugin download/install
//! path. Two invariants make that safe:
//!   * `updater_builder()` seeds the config's signing **pubkey**, so overriding
//!     only `.endpoints()` keeps signature verification on for both channels.
//!   * The `Update` is added to `webview.resources_table()` — the same
//!     per-webview table the plugin's `download`/`install` read — so the `rid`
//!     resolves at download time (the app-global table would not).

use serde::Serialize;

use tauri::{Manager, Webview};
use tauri_plugin_updater::UpdaterExt;

/// The stable channel's update manifest — the newest non-pre-release via GitHub's
/// `/latest/` alias. Mirrors the endpoint baked into `src-tauri/tauri.conf.json`.
const STABLE_ENDPOINT: &str =
    "https://github.com/Siomkin/GitLane/releases/latest/download/latest.json";

/// The beta channel's rolling update manifest. Mirrors the endpoint in
/// `src-tauri/tauri.beta.conf.json`; keep in sync with `docs/release-channels.md`.
const BETA_ENDPOINT: &str = "https://github.com/Siomkin/GitLane/releases/download/beta/latest.json";

/// The endpoint for the channel the user picked.
fn endpoint_for(beta: bool) -> &'static str {
    if beta {
        BETA_ENDPOINT
    } else {
        STABLE_ENDPOINT
    }
}

/// Metadata for a found update, shaped to construct the plugin's JS `Update`
/// (`UpdateMetadata` in `@tauri-apps/plugin-updater`, hence camelCase). `rid`
/// indexes the live `Update` handle parked in the webview resource table, so the
/// frontend's `update.downloadAndInstall()` (plugin `download`/`install`
/// commands) finds it — the exact contract the plugin's own `check` returns.
///
/// The plugin's `check` also returns `date` (RFC3339); it's deliberately omitted
/// here — the JS `Update` class treats it as optional and the updates store
/// never reads it (only `version`/`body` reach the UI, and `pub_date` remains
/// inside `rawJson`). Skipping it keeps this DTO off the `time` formatting
/// dependency.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    body: Option<String>,
    raw_json: serde_json::Value,
}

/// Check for an update on the selected channel, overriding the endpoint
/// **explicitly for both channels** so a beta-built install is not stuck on
/// beta after the user turns the toggle off (GL-154 review). Only
/// `.endpoints()` is overridden, so the config signing pubkey is retained and
/// signature verification stays on. Resolves to `None` when already up to date.
pub async fn check(webview: Webview, beta: bool) -> Result<Option<UpdateMetadata>, String> {
    let url = endpoint_for(beta)
        .parse()
        .map_err(|e| format!("Invalid update endpoint: {e}"))?;
    let updater = webview
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        None => Ok(None),
        Some(update) => {
            // Snapshot the display fields before the handle is moved into the
            // resource table (which consumes it and hands back the rid).
            let current_version = update.current_version.clone();
            let version = update.version.clone();
            let body = update.body.clone();
            let raw_json = update.raw_json.clone();
            let rid = webview.resources_table().add(update);
            Ok(Some(UpdateMetadata {
                rid,
                current_version,
                version,
                body,
                raw_json,
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{endpoint_for, BETA_ENDPOINT, STABLE_ENDPOINT};

    // The command itself needs a live Tauri runtime, so it isn't unit-testable
    // here; guard the two things that can silently drift — the manifest URLs.
    // The beta URL must stay the fixed-`beta`-release download path, and the
    // stable URL must mirror the `/latest/` endpoint baked into tauri.conf.json
    // (a typo either way sends update checks to a 404).
    #[test]
    fn beta_endpoint_is_the_fixed_beta_release_manifest() {
        assert_eq!(
            BETA_ENDPOINT,
            "https://github.com/Siomkin/GitLane/releases/download/beta/latest.json"
        );
        assert!(BETA_ENDPOINT.ends_with("/releases/download/beta/latest.json"));
    }

    #[test]
    fn stable_endpoint_mirrors_the_latest_alias_in_tauri_conf() {
        assert_eq!(
            STABLE_ENDPOINT,
            "https://github.com/Siomkin/GitLane/releases/latest/download/latest.json"
        );
        assert!(STABLE_ENDPOINT.ends_with("/releases/latest/download/latest.json"));
    }

    // The toggle must resolve to a *different* endpoint each way — the regression
    // the review caught was `beta = false` silently reusing the build default.
    #[test]
    fn each_channel_selects_its_own_endpoint() {
        assert_eq!(endpoint_for(true), BETA_ENDPOINT);
        assert_eq!(endpoint_for(false), STABLE_ENDPOINT);
        assert_ne!(endpoint_for(true), endpoint_for(false));
        assert!(STABLE_ENDPOINT.starts_with("https://"));
        assert!(BETA_ENDPOINT.starts_with("https://"));
    }
}
