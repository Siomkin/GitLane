//! OS-native secret storage for GitLane-owned provider transport tokens (GL-132).
//!
//! GitLane owns a secret **only** for provider accounts it authenticates itself
//! (e.g. a GitLab/Bitbucket PAT captured in-app). Those secrets live exclusively
//! in the platform keychain, reachable only from this Rust process — never in
//! Zustand, localStorage, repo config, command arguments, logs, or IPC
//! responses. What crosses IPC is a [`SecretKey`]-shaped *handle*
//! (provider + host + account id); it reveals nothing sensitive and cannot be
//! used from the frontend to read the secret back.
//!
//! Storage is abstracted behind [`SecretStore`] so the credential bridge and the
//! provider-token commands can be unit-tested against an in-memory double while
//! production uses [`KeyringStore`]. The keychain service is GitLane-namespaced,
//! so deleting a GitLane token on sign-out can never remove a credential the
//! user's own `git` / `gh` / Git Credential Manager stored (that is the separate
//! "forget saved HTTPS credential" path — see `git::credentials`).

use std::fmt;

/// Keychain *service* namespace for GitLane-owned provider transport tokens.
/// Every entry GitLane writes lives under this service, so sign-out only ever
/// deletes GitLane's own entries — never a credential owned by the user's git
/// credential helper / Git Credential Manager, which use their own service names.
pub const PROVIDER_TOKEN_SERVICE: &str = "space.gitlane.provider-token";

/// Unit separator used to pack the three key fields into one keychain "account"
/// string. A control byte can appear in none of the fields (see
/// [`SecretKey::validate`]), so packed keys are unambiguous — `host="a" id="b:c"`
/// and `host="a:b" id="c"` never collide.
const FIELD_SEP: char = '\u{1f}';

/// Non-secret locator for one stored provider token. The `(provider, host,
/// account_id)` tuple is stable and identifies a keychain entry without
/// revealing anything sensitive, so it is safe to cross IPC and to persist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretKey {
    /// Provider family, e.g. `gitlab`, `bitbucket`, `azure-devops`, `gitea`.
    pub provider: String,
    /// Credential host (authority, may include a custom port).
    pub host: String,
    /// Provider-owned stable account id (not assumed to equal the login).
    pub account_id: String,
}

impl SecretKey {
    /// Build a trimmed key. Fields are trimmed but not otherwise altered;
    /// [`SecretKey::validate`] rejects empty or control-bearing fields.
    pub fn new(provider: &str, host: &str, account_id: &str) -> Self {
        Self {
            provider: provider.trim().to_string(),
            host: host.trim().to_string(),
            account_id: account_id.trim().to_string(),
        }
    }

    /// The keychain "account" string for this key: the three fields packed with
    /// a unit separator. Deterministic and collision-free (see [`FIELD_SEP`]).
    pub fn keychain_account(&self) -> String {
        format!(
            "{}{FIELD_SEP}{}{FIELD_SEP}{}",
            self.provider, self.host, self.account_id
        )
    }

    /// Reject empty fields and any control characters (which could smuggle a
    /// separator or break the keychain account string). Keeps the packed
    /// account string unambiguous and free of injected separators.
    pub fn validate(&self) -> Result<(), SecretError> {
        for (label, value) in [
            ("provider", &self.provider),
            ("host", &self.host),
            ("account id", &self.account_id),
        ] {
            if value.is_empty() {
                return Err(SecretError(format!(
                    "Missing {label} for the stored token."
                )));
            }
            if value.chars().any(|c| c.is_control()) {
                return Err(SecretError(format!(
                    "Invalid {label} for the stored token."
                )));
            }
        }
        Ok(())
    }
}

/// Backend-owned secret store. Implementations keep secrets inside the Rust
/// process only — values are written and read here and handed straight to a
/// child git process, never returned across IPC.
pub trait SecretStore: Send + Sync {
    /// Store (or replace) the secret for `key`. Returns an error for an invalid
    /// key or an empty secret.
    fn set(&self, key: &SecretKey, secret: &str) -> Result<(), SecretError>;
    /// Read the secret for `key`, or `Ok(None)` when nothing is stored.
    fn get(&self, key: &SecretKey) -> Result<Option<String>, SecretError>;
    /// Delete the secret for `key`. Deleting an absent entry is a success
    /// (idempotent sign-out).
    fn delete(&self, key: &SecretKey) -> Result<(), SecretError>;
}

/// A secret-storage failure. The message is intentionally coarse and **never**
/// contains secret material — keyring backend errors describe the operation, not
/// the value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretError(pub String);

impl fmt::Display for SecretError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SecretError {}

impl From<SecretError> for String {
    fn from(err: SecretError) -> Self {
        err.0
    }
}

/// Production [`SecretStore`] backed by the OS keychain via the `keyring` crate.
/// The entry's *service* is the GitLane namespace and its *account* is the
/// packed [`SecretKey`].
pub struct KeyringStore {
    service: String,
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self {
            service: PROVIDER_TOKEN_SERVICE.to_string(),
        }
    }
}

impl KeyringStore {
    /// A store on the default GitLane service namespace.
    pub fn new() -> Self {
        Self::default()
    }

    fn entry(&self, key: &SecretKey) -> Result<keyring::Entry, SecretError> {
        key.validate()?;
        keyring::Entry::new(&self.service, &key.keychain_account())
            .map_err(|e| SecretError(format!("Keychain access failed: {e}")))
    }
}

impl SecretStore for KeyringStore {
    fn set(&self, key: &SecretKey, secret: &str) -> Result<(), SecretError> {
        if secret.is_empty() {
            return Err(SecretError("Refusing to store an empty token.".into()));
        }
        self.entry(key)?
            .set_password(secret)
            .map_err(|e| SecretError(format!("Could not save the token to the keychain: {e}")))
    }

    fn get(&self, key: &SecretKey) -> Result<Option<String>, SecretError> {
        match self.entry(key)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretError(format!("Could not read the token: {e}"))),
        }
    }

    fn delete(&self, key: &SecretKey) -> Result<(), SecretError> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(SecretError(format!("Could not remove the token: {e}"))),
        }
    }
}

/// In-memory [`SecretStore`] for tests: never touches the OS keychain, so unit
/// tests for the credential bridge and provider-token commands stay hermetic and
/// run on headless CI.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    entries: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

#[cfg(test)]
impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn set(&self, key: &SecretKey, secret: &str) -> Result<(), SecretError> {
        key.validate()?;
        if secret.is_empty() {
            return Err(SecretError("Refusing to store an empty token.".into()));
        }
        self.entries
            .lock()
            .unwrap()
            .insert(key.keychain_account(), secret.to_string());
        Ok(())
    }

    fn get(&self, key: &SecretKey) -> Result<Option<String>, SecretError> {
        key.validate()?;
        Ok(self
            .entries
            .lock()
            .unwrap()
            .get(&key.keychain_account())
            .cloned())
    }

    fn delete(&self, key: &SecretKey) -> Result<(), SecretError> {
        key.validate()?;
        self.entries.lock().unwrap().remove(&key.keychain_account());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_account_is_collision_free_across_field_boundaries() {
        let a = SecretKey::new("gitlab", "a", "b:c").keychain_account();
        let b = SecretKey::new("gitlab", "a:b", "c").keychain_account();
        assert_ne!(a, b, "packed keys must not collide across field boundaries");
    }

    #[test]
    fn validate_rejects_empty_and_control_fields() {
        assert!(SecretKey::new("", "gitlab.com", "1").validate().is_err());
        assert!(SecretKey::new("gitlab", "", "1").validate().is_err());
        assert!(SecretKey::new("gitlab", "gitlab.com", "")
            .validate()
            .is_err());
        // A trailing newline is trimmed away by `new` (safe); an *interior*
        // control character is what validation must reject.
        assert!(SecretKey::new("gitlab", "git\nlab.com", "1")
            .validate()
            .is_err());
        assert!(SecretKey::new("gitlab", "gitlab.com\u{0}", "1")
            .validate()
            .is_err());
        assert!(SecretKey::new("gitlab", "gitlab.com:8443", "42")
            .validate()
            .is_ok());
    }

    #[test]
    fn memory_store_roundtrips_and_is_idempotent_on_delete() {
        let store = MemoryStore::new();
        let key = SecretKey::new("gitlab", "gitlab.com", "42");

        assert_eq!(store.get(&key).unwrap(), None);
        store.set(&key, "glpat-secret").unwrap();
        assert_eq!(store.get(&key).unwrap().as_deref(), Some("glpat-secret"));

        // Overwrite replaces in place.
        store.set(&key, "glpat-rotated").unwrap();
        assert_eq!(store.get(&key).unwrap().as_deref(), Some("glpat-rotated"));

        store.delete(&key).unwrap();
        assert_eq!(store.get(&key).unwrap(), None);
        // Deleting again is not an error.
        store.delete(&key).unwrap();
    }

    #[test]
    fn memory_store_rejects_empty_secret() {
        let store = MemoryStore::new();
        let key = SecretKey::new("bitbucket", "bitbucket.org", "alice");
        assert!(store.set(&key, "").is_err());
    }

    #[test]
    fn distinct_accounts_on_one_host_are_isolated() {
        let store = MemoryStore::new();
        let alice = SecretKey::new("gitlab", "gitlab.com", "1");
        let bob = SecretKey::new("gitlab", "gitlab.com", "2");
        store.set(&alice, "alice-token").unwrap();
        store.set(&bob, "bob-token").unwrap();
        assert_eq!(store.get(&alice).unwrap().as_deref(), Some("alice-token"));
        assert_eq!(store.get(&bob).unwrap().as_deref(), Some("bob-token"));
        store.delete(&alice).unwrap();
        assert_eq!(store.get(&alice).unwrap(), None);
        assert_eq!(store.get(&bob).unwrap().as_deref(), Some("bob-token"));
    }
}
