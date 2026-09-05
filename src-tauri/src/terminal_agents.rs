//! User-configurable terminal agents — the source of truth for the launchable
//! AI-CLI entries shown in the Terminal toolbar.
//!
//! Agents live in a JSON file under the app data dir (`terminal-agents.json`)
//! so the user can add, edit, reorder, hide, or remove them from Settings
//! without rebuilding. On load each agent's `available` flag is probed fresh
//! against PATH (missing binaries grey out in the toolbar). The file holds the
//! *editable* fields only ([`AgentEntry`]); `available` is computed, never
//! persisted — it would go stale the moment PATH changes.

mod agents;
mod defaults;
mod messages;
mod migrations;
mod probe;

pub use agents::{load, reset_to_defaults, save, TerminalAgent};
pub use messages::{load_messages, reset_messages_to_defaults, save_messages, CommitAgentMessages};
pub use probe::probe;

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The per-app data dir holding both configs
/// (e.g. `~/Library/Application Support/space.gitlane.desktop/`).
///
/// Split from the readers and writers below so they take a plain directory:
/// `AppHandle::path()` resolves to the developer's real Application Support
/// even under `tauri::test`'s mock runtime, so a test driven through the handle
/// would read and write their own config rather than a temp dir.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
}

/// Write `json` to `path` via tmp + rename — atomic on one filesystem, so a
/// crash mid-write can never leave a half-written config behind. Creates the
/// data dir on first write.
fn write_atomically(path: &Path, json: &str, what: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create app data dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("failed to write {what}: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("failed to save {what}: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests;
