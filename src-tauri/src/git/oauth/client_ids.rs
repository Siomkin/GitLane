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
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// `provider → (host → client_id)`. `BTreeMap` keeps the file stable-ordered.
type Overrides = BTreeMap<String, BTreeMap<String, String>>;

/// The app-data dir the overrides live in. Split from the readers and writers
/// so they take a plain directory: `AppHandle::path()` resolves to the real
/// Application Support even under `tauri::test`'s mock runtime, so a test
/// driven through the handle would write the developer's own config.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
}

fn config_path_in(dir: &Path) -> PathBuf {
    dir.join("oauth-clients.json")
}

/// Load overrides, tolerating a missing/corrupt file (returns empty).
fn load_in(dir: &Path) -> Overrides {
    match fs::read_to_string(config_path_in(dir)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Overrides::new(),
    }
}

fn persist_in(dir: &Path, overrides: &Overrides) -> Result<(), String> {
    let path = config_path_in(dir);
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
    get_in(&data_dir(app).ok()?, provider, host)
}

fn get_in(dir: &Path, provider: &str, host: &str) -> Option<String> {
    let host = normalize_host(host);
    load_in(dir)
        .get(provider)?
        .get(&host)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Set (non-empty) or clear (empty) the override client id for `provider`/`host`.
/// Validates the id shape defensively — a public client id is an opaque printable
/// token with no whitespace or control characters.
pub fn set(app: &AppHandle, provider: &str, host: &str, client_id: &str) -> Result<(), String> {
    set_in(&data_dir(app)?, provider, host, client_id)
}

fn set_in(dir: &Path, provider: &str, host: &str, client_id: &str) -> Result<(), String> {
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

    let mut overrides = load_in(dir);
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
    persist_in(dir, &overrides)
}

fn normalize_host(host: &str) -> String {
    host.trim().to_ascii_lowercase()
}

fn is_valid_client_id(id: &str) -> bool {
    id.len() <= 256 && id.chars().all(|c| !c.is_control() && !c.is_whitespace())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway app-data dir that cleans itself up on drop.
    struct TempData(PathBuf);

    impl TempData {
        fn new(tag: &str) -> Self {
            static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("gitlane-oauth-{tag}-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            TempData(dir)
        }
    }

    impl Drop for TempData {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn an_override_round_trips_and_the_host_is_normalized() {
        let dir = TempData::new("round-trip");

        set_in(&dir.0, "gitlab", "  GitLab.Example.COM  ", "abc123").unwrap();

        // Host casing and padding must not create a second, unreachable entry.
        assert_eq!(
            get_in(&dir.0, "gitlab", "gitlab.example.com").as_deref(),
            Some("abc123")
        );
        assert_eq!(
            get_in(&dir.0, "gitlab", "GITLAB.EXAMPLE.COM").as_deref(),
            Some("abc123")
        );
    }

    #[test]
    fn an_empty_id_clears_the_override() {
        let dir = TempData::new("clear");
        set_in(&dir.0, "gitlab", "gitlab.example.com", "abc123").unwrap();

        set_in(&dir.0, "gitlab", "gitlab.example.com", "").unwrap();

        assert_eq!(get_in(&dir.0, "gitlab", "gitlab.example.com"), None);
        // The now-empty provider map is pruned rather than left as a husk.
        let text = fs::read_to_string(config_path_in(&dir.0)).unwrap();
        assert!(!text.contains("gitlab"), "{text}");
    }

    #[test]
    fn an_unknown_provider_or_host_is_refused_before_any_write() {
        let dir = TempData::new("refused");

        assert!(set_in(&dir.0, "not-a-forge", "example.com", "abc").is_err());
        assert!(set_in(&dir.0, "gitlab", "", "abc").is_err());
        assert!(set_in(&dir.0, "gitlab", "has space", "abc").is_err());
        assert!(set_in(&dir.0, "gitlab", "example.com", "has space").is_err());

        assert!(
            !config_path_in(&dir.0).exists(),
            "a rejected set must not create the config"
        );
    }

    #[test]
    fn a_missing_or_corrupt_file_reads_as_no_overrides() {
        let dir = TempData::new("corrupt");
        assert_eq!(get_in(&dir.0, "gitlab", "example.com"), None);

        fs::write(config_path_in(&dir.0), "{not json").unwrap();

        assert_eq!(get_in(&dir.0, "gitlab", "example.com"), None);
    }

    #[test]
    fn overrides_for_several_hosts_and_providers_coexist() {
        let dir = TempData::new("multi");

        set_in(&dir.0, "gitlab", "one.example.com", "id-one").unwrap();
        set_in(&dir.0, "gitlab", "two.example.com", "id-two").unwrap();
        set_in(&dir.0, "bitbucket", "bitbucket.org", "id-bb").unwrap();

        assert_eq!(
            get_in(&dir.0, "gitlab", "one.example.com").as_deref(),
            Some("id-one")
        );
        assert_eq!(
            get_in(&dir.0, "gitlab", "two.example.com").as_deref(),
            Some("id-two")
        );
        assert_eq!(
            get_in(&dir.0, "bitbucket", "bitbucket.org").as_deref(),
            Some("id-bb")
        );
    }

    #[test]
    fn validates_client_id_shape() {
        assert!(is_valid_client_id("abcDEF0123-_."));
        assert!(!is_valid_client_id("has space"));
        assert!(!is_valid_client_id("has\nnewline"));
        assert!(!is_valid_client_id(&"x".repeat(257)));
    }
}
