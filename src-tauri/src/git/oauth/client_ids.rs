//! Per-host OAuth client-id overrides, stored in Rust-owned app-data (GL-139).
//!
//! A public OAuth client id is not a secret, but it is deployment-specific: a
//! self-managed GitLab instance needs its own registered app, and the built-in
//! (`option_env!`) ids only cover the public hosts. This module persists
//! user-entered `{ provider → { host → client_id } }` overrides the same way
//! `terminal_agents.rs` persists agent config — a JSON file under the app-data
//! dir, atomic write, tolerant load — so they survive restarts without any
//! frontend-writable storage.
//!
//! Because a client id is public, it is fine to store here in cleartext. It is
//! *not* stored in the OS keychain (that is reserved for the token itself).

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// `provider → (host → client_id)`. `BTreeMap` keeps the file stable-ordered.
type Overrides = BTreeMap<String, BTreeMap<String, String>>;

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(dir.join("oauth-clients.json"))
}

/// Load overrides, tolerating a missing/corrupt file (returns empty).
fn load(app: &AppHandle) -> Overrides {
    match config_path(app) {
        Ok(path) => match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => Overrides::new(),
        },
        Err(_) => Overrides::new(),
    }
}

fn persist(app: &AppHandle, overrides: &Overrides) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create app data dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(overrides)
        .map_err(|e| format!("failed to serialize oauth clients: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("failed to write oauth clients: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("failed to save oauth clients: {e}"))?;
    Ok(())
}

/// The override client id for `provider`/`host`, if the user set one.
pub fn get(app: &AppHandle, provider: &str, host: &str) -> Option<String> {
    let host = normalize_host(host);
    load(app)
        .get(provider)?
        .get(&host)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Set (non-empty) or clear (empty) the override client id for `provider`/`host`.
/// Validates the id shape defensively — a public client id is an opaque printable
/// token with no whitespace or control characters.
pub fn set(app: &AppHandle, provider: &str, host: &str, client_id: &str) -> Result<(), String> {
    if super::config::provider_config(provider).is_none() {
        return Err(format!("Native OAuth is not supported for '{provider}'."));
    }
    if !super::config::is_valid_host(host) {
        return Err("Enter a valid host for the OAuth client id.".into());
    }
    let host = normalize_host(host);
    let id = client_id.trim();
    if !id.is_empty() && !is_valid_client_id(id) {
        return Err("That doesn't look like a valid OAuth client id.".into());
    }

    let mut overrides = load(app);
    if id.is_empty() {
        if let Some(hosts) = overrides.get_mut(provider) {
            hosts.remove(&host);
            if hosts.is_empty() {
                overrides.remove(provider);
            }
        }
    } else {
        overrides
            .entry(provider.to_string())
            .or_default()
            .insert(host, id.to_string());
    }
    persist(app, &overrides)
}

fn normalize_host(host: &str) -> String {
    host.trim().to_ascii_lowercase()
}

fn is_valid_client_id(id: &str) -> bool {
    id.len() <= 256
        && id
            .chars()
            .all(|c| !c.is_control() && !c.is_whitespace())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_client_id_shape() {
        assert!(is_valid_client_id("abcDEF0123-_."));
        assert!(!is_valid_client_id("has space"));
        assert!(!is_valid_client_id("has\nnewline"));
        assert!(!is_valid_client_id(&"x".repeat(257)));
    }
}
