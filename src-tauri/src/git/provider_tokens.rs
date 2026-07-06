//! GitLane-owned provider transport tokens (GL-132).
//!
//! Backend orchestration over the OS keychain ([`crate::secrets`]) for provider
//! accounts GitLane authenticates itself (e.g. a GitLab/Bitbucket personal
//! access token captured in-app). This is deliberately **separate** from the git
//! credential-helper path in [`super::credentials`]:
//!
//! - here GitLane *owns* the secret — it lives in the GitLane-namespaced keychain
//!   service, and [sign-out](delete_provider_token) deletes it;
//! - the credential-helper path hands a secret to the user's own helper, where
//!   "forget saved HTTPS credential" ([`super::credentials::reject_https_credential`])
//!   removes it.
//!
//! Only non-secret [`ProviderTokenStatus`] crosses IPC. The token itself is
//! written into the keychain here and read back only inside the credential
//! bridge child process ([`super::credential_bridge`]); it is never returned to
//! the frontend, logged, or placed in a command argument.

use serde::Serialize;

use crate::secrets::{KeyringStore, SecretKey, SecretStore};

/// Non-secret status for one provider account token. Never carries the token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTokenStatus {
    pub provider: String,
    pub host: String,
    pub account_id: String,
    pub login: String,
    /// Whether a secret is currently stored in the keychain for this account.
    pub has_token: bool,
}

/// Store (or replace) `token` for a provider account in the OS keychain. The
/// token argument is a secret handled like [`super::credentials::approve_https_credential`]:
/// it is written straight to the keychain and never logged or echoed back.
pub fn save_provider_token(
    provider: &str,
    host: &str,
    account_id: &str,
    login: &str,
    token: &str,
) -> Result<ProviderTokenStatus, String> {
    save_provider_token_in(
        &KeyringStore::new(),
        provider,
        host,
        account_id,
        login,
        token,
    )
}

/// Delete a GitLane-owned provider token from the keychain — **provider sign-out**.
/// Idempotent (removing an absent token succeeds). Touches nothing but GitLane's
/// own keychain entry; the user's git credential-helper credentials are untouched.
pub fn delete_provider_token(provider: &str, host: &str, account_id: &str) -> Result<(), String> {
    delete_provider_token_in(&KeyringStore::new(), provider, host, account_id)
}

/// Report whether a keychain token is currently stored for a provider account,
/// without ever returning the token.
pub fn provider_token_status(
    provider: &str,
    host: &str,
    account_id: &str,
    login: &str,
) -> Result<ProviderTokenStatus, String> {
    provider_token_status_in(&KeyringStore::new(), provider, host, account_id, login)
}

// ---- store-injectable cores (unit-tested against MemoryStore) ----

fn save_provider_token_in(
    store: &dyn SecretStore,
    provider: &str,
    host: &str,
    account_id: &str,
    login: &str,
    token: &str,
) -> Result<ProviderTokenStatus, String> {
    let key = SecretKey::new(provider, host, account_id);
    key.validate()?;
    let login = login.trim();
    if login.is_empty() {
        return Err("Enter the account username for this token.".into());
    }
    if token.trim().is_empty() {
        return Err("Enter the token to store in your keychain.".into());
    }
    store.set(&key, token)?;
    Ok(ProviderTokenStatus {
        provider: key.provider,
        host: key.host,
        account_id: key.account_id,
        login: login.to_string(),
        has_token: true,
    })
}

fn delete_provider_token_in(
    store: &dyn SecretStore,
    provider: &str,
    host: &str,
    account_id: &str,
) -> Result<(), String> {
    let key = SecretKey::new(provider, host, account_id);
    key.validate()?;
    store.delete(&key).map_err(Into::into)
}

fn provider_token_status_in(
    store: &dyn SecretStore,
    provider: &str,
    host: &str,
    account_id: &str,
    login: &str,
) -> Result<ProviderTokenStatus, String> {
    let key = SecretKey::new(provider, host, account_id);
    let has_token = store.get(&key)?.is_some();
    Ok(ProviderTokenStatus {
        provider: key.provider,
        host: key.host,
        account_id: key.account_id,
        login: login.trim().to_string(),
        has_token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryStore;

    #[test]
    fn save_then_status_then_delete_roundtrips() {
        let store = MemoryStore::new();

        let saved = save_provider_token_in(
            &store,
            "gitlab",
            "gitlab.com",
            "42",
            "alice",
            "glpat-secret",
        )
        .unwrap();
        assert!(saved.has_token);
        assert_eq!(saved.login, "alice");

        let status =
            provider_token_status_in(&store, "gitlab", "gitlab.com", "42", "alice").unwrap();
        assert!(status.has_token);

        delete_provider_token_in(&store, "gitlab", "gitlab.com", "42").unwrap();
        let after =
            provider_token_status_in(&store, "gitlab", "gitlab.com", "42", "alice").unwrap();
        assert!(!after.has_token);
    }

    #[test]
    fn save_validates_fields_and_rejects_blank_login_or_token() {
        let store = MemoryStore::new();
        // Blank login.
        assert!(
            save_provider_token_in(&store, "gitlab", "gitlab.com", "42", "  ", "glpat").is_err()
        );
        // Blank token.
        assert!(
            save_provider_token_in(&store, "gitlab", "gitlab.com", "42", "alice", " ").is_err()
        );
        // Invalid key (empty host).
        assert!(save_provider_token_in(&store, "gitlab", "", "42", "alice", "glpat").is_err());
    }

    #[test]
    fn status_never_exposes_the_token_value() {
        // The status type has no field that could carry a token; a sign-in stores
        // the secret only in the store, and status reports presence only.
        let store = MemoryStore::new();
        save_provider_token_in(&store, "bitbucket", "bitbucket.org", "1", "bob", "s3cr3t").unwrap();
        let status =
            provider_token_status_in(&store, "bitbucket", "bitbucket.org", "1", "bob").unwrap();
        let json = serde_json::to_string(&status).unwrap();
        assert!(
            !json.contains("s3cr3t"),
            "status must not carry the token: {json}"
        );
        assert!(json.contains("\"hasToken\":true"));
    }

    #[test]
    fn delete_is_idempotent() {
        let store = MemoryStore::new();
        // Deleting a never-stored token is not an error.
        delete_provider_token_in(&store, "gitea", "gitea.example", "7").unwrap();
    }
}
