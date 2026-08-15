//! Provider accounts and the non-secret refs that cross IPC to select one.
//! Tokens never appear here — a ref carries only a locator (GL-129/GL-132).

use serde::{Deserialize, Serialize};

/// Frontend-safe account identity used to pin GitHub operations without ever
/// moving token material across IPC.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccountRef {
    /// "gh" today; future native auth can add another provider without
    /// changing the PR feature surface.
    pub provider: String,
    /// GitHub host without scheme, e.g. "github.com" or a GHES hostname.
    pub host: String,
    /// Provider-owned stable account id. For `gh`, this is the GitHub numeric
    /// user id when it can be resolved, otherwise the login as a stable fallback.
    pub account_id: String,
    /// Display/login name. `gh auth token` still requires this alongside host.
    pub login: String,
}

/// The forge a transport-auth ref authenticates against — GitLane's own
/// classification vocabulary, mirrored by the TS `GitTransportProvider` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum ForgeProvider {
    #[serde(rename = "github")]
    Github,
    #[serde(rename = "gitlab")]
    Gitlab,
    #[serde(rename = "bitbucket")]
    Bitbucket,
    #[serde(rename = "azure-devops")]
    AzureDevOps,
    #[serde(rename = "gitea")]
    Gitea,
    #[serde(rename = "forgejo")]
    Forgejo,
    #[serde(rename = "other")]
    Other,
}

impl ForgeProvider {
    /// The wire word for this provider — the same string its serde renames
    /// emit, for call sites that build helper payloads from the enum.
    pub fn as_wire_str(&self) -> &'static str {
        match self {
            ForgeProvider::Github => "github",
            ForgeProvider::Gitlab => "gitlab",
            ForgeProvider::Bitbucket => "bitbucket",
            ForgeProvider::AzureDevOps => "azure-devops",
            ForgeProvider::Gitea => "gitea",
            ForgeProvider::Forgejo => "forgejo",
            ForgeProvider::Other => "other",
        }
    }
}

/// Provider-neutral git transport auth for clone/fetch/pull/push.
///
/// This is intentionally not a token carrier. For HTTPS remotes the account
/// selector is the URL username (`gitcredentials(7)`); GitHub can additionally
/// ask `gh auth git-credential` for that username's token per invocation. Other
/// providers use the user's configured credential helper / GCM. When GitLane
/// owns the secret for a provider account (`providerToken` mode, GL-132) the
/// token is fetched from the OS keychain by the backend credential bridge and
/// handed to git via `GIT_ASKPASS`; `providerAccountId` is the non-secret
/// keychain locator, never the token itself.
///
/// One tagged variant per mode, carrying exactly the fields that mode needs —
/// `githubGh` cannot arrive without its account ref, and `providerToken`
/// cannot arrive without its keychain locator. `host`/`credentialHost` are
/// common to every variant (a `#[serde(flatten)]`ed shared struct would be
/// simpler, but flatten inside internally-tagged variants silently drops
/// nested-struct fields, so the two fields are spelled out per variant and
/// read through the accessors below).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum GitTransportAuthRef {
    /// No inline handling: the user's own credential helper / GCM.
    #[serde(rename_all = "camelCase")]
    System {
        /// Normalized display host, without scheme or port.
        host: String,
        /// Exact credential authority (`host[:port]`) Git sees.
        credential_host: String,
    },
    /// SSH remotes authenticate by key; nothing is injected.
    #[serde(rename_all = "camelCase")]
    Ssh {
        host: String,
        credential_host: String,
    },
    /// GitHub `gh` credential helper; the account ref is part of the variant
    /// and never carries a token.
    #[serde(rename_all = "camelCase")]
    GithubGh {
        host: String,
        credential_host: String,
        /// HTTPS URL username, when one is selected.
        #[serde(default)]
        username: Option<String>,
        account_ref: GithubAccountRef,
    },
    /// GitLab `glab` credential helper: glab answers git's credential prompt
    /// from its own token store (GL-139). The mode is GitLab-only — `provider`
    /// pins that.
    #[serde(rename_all = "camelCase")]
    GitlabGlab {
        host: String,
        credential_host: String,
        #[serde(default)]
        username: Option<String>,
        provider: ForgeProvider,
    },
    /// The user's configured credential helper, optionally with path-aware
    /// matching.
    #[serde(rename_all = "camelCase")]
    CredentialHelper {
        host: String,
        credential_host: String,
        #[serde(default)]
        username: Option<String>,
        /// Whether Git should include the URL path in credential-helper
        /// lookups.
        #[serde(default)]
        use_http_path: bool,
    },
    /// A GitLane-owned provider token, fed to git through the parent-owned
    /// `GIT_ASKPASS` bridge after it is read from the OS keychain. All fields
    /// are non-secret locators.
    #[serde(rename_all = "camelCase")]
    ProviderToken {
        host: String,
        credential_host: String,
        username: String,
        provider: ForgeProvider,
        /// The provider account id whose token GitLane stored in the OS
        /// keychain. Never a token.
        provider_account_id: String,
    },
}

impl GitTransportAuthRef {
    /// Exact credential authority (`host[:port]`) Git sees — common to every
    /// mode.
    pub fn credential_host(&self) -> &str {
        match self {
            GitTransportAuthRef::System {
                credential_host, ..
            }
            | GitTransportAuthRef::Ssh {
                credential_host, ..
            }
            | GitTransportAuthRef::GithubGh {
                credential_host, ..
            }
            | GitTransportAuthRef::GitlabGlab {
                credential_host, ..
            }
            | GitTransportAuthRef::CredentialHelper {
                credential_host, ..
            }
            | GitTransportAuthRef::ProviderToken {
                credential_host, ..
            } => credential_host,
        }
    }
}

/// One `remote → auth` pair for the multi-remote fetch.
/// Input-only: remotes without an entry fetch through the system credential
/// helpers / SSH.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccountRef {
    pub remote: String,
    pub auth: GitTransportAuthRef,
}

pub use crate::git::credentials::{
    CredentialForgetResult, CredentialHelperStatus, CredentialSaveResult,
};
pub use crate::git::oauth::types::{OauthClientStatus, ProviderOauthResult};
pub use crate::git::provider_tokens::ProviderTokenStatus;

/// A GitHub account `gh` is logged into. Its account ref drives GitHub PR/API
/// auth and can be used for git transport auth; commit identity is configured
/// separately through repo-local git identity settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccount {
    pub provider: String,
    pub host: String,
    pub account_id: String,
    pub login: String,
    /// Legacy display alias kept stable for existing frontend code.
    pub username: String,
    pub name: String,
    pub email: String,
    /// Numeric GitHub user id (0 when it could not be resolved).
    pub id: u64,
    /// True for the account `gh` currently treats as active.
    pub active: bool,
    /// False when `gh auth status` reported the account's credentials as
    /// broken (revoked/expired token, or the check timed out) — the UI shows
    /// a "needs re-auth" badge instead of treating the account as usable.
    pub healthy: bool,
    /// Human-readable failure detail when `healthy` is false; empty otherwise.
    pub health_error: String,
}

/// Result of an in-app `gh auth login --web` sign-in (GL-106): the host and the
/// login that was just added, so the UI can refresh the account list and offer to
/// bind the new account to the open repo. No token material.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubSignInResult {
    pub host: String,
    pub login: String,
}

/// Authentication status for a non-GitHub forge. This is auth-only metadata for
/// Settings; it does not imply PR feature support.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeAuthStatus {
    /// Stable provider key, e.g. "gitlab" or "bitbucket".
    pub provider: String,
    pub forge: String,
    pub cli: Option<String>,
    pub auth_method: String,
    pub available: bool,
    /// None means GitLane cannot safely probe auth state for this provider.
    /// For tea-backed providers (Gitea/Forgejo) `Some(true)` means tea has *any*
    /// configured login, not necessarily one scoped to this repo's host.
    pub authenticated: Option<bool>,
    pub login_command: String,
    pub docs_url: String,
    pub notes: String,
    /// Real account identity, when the provider CLI is authenticated and GitLane
    /// can fetch it (provider whoami). Identity metadata only — never a token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<ForgeAccount>,
}

/// The signed-in account on a non-GitHub provider, from its CLI whoami.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeAccount {
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_ref_deserializes_the_frontend_wire_payloads() {
        // The exact payloads the frontend sends today — flat objects with the
        // mode key plus whichever fields that mode fills (including leftovers
        // the old struct accepted, like provider on githubGh) — must parse
        // into their variants.
        let cases = [
            (
                serde_json::json!({"mode": "system", "host": "example.test", "credentialHost": "example.test"}),
                "system",
            ),
            (
                serde_json::json!({"mode": "ssh", "host": "example.test", "credentialHost": "example.test"}),
                "ssh",
            ),
            (
                serde_json::json!({
                    "mode": "githubGh", "provider": "github",
                    "host": "github.com", "credentialHost": "github.com",
                    "username": "octocat",
                    "accountRef": {"provider": "gh", "host": "github.com", "accountId": "1", "login": "octocat"},
                    "providerAccountId": null, "useHttpPath": false
                }),
                "githubGh",
            ),
            (
                serde_json::json!({
                    "mode": "gitlabGlab", "provider": "gitlab",
                    "host": "gitlab.com", "credentialHost": "gitlab.com",
                    "username": null, "accountRef": null,
                    "providerAccountId": null, "useHttpPath": false
                }),
                "gitlabGlab",
            ),
            (
                serde_json::json!({
                    "mode": "credentialHelper", "provider": "other",
                    "host": "example.test", "credentialHost": "example.test",
                    "username": "alice"
                }),
                "credentialHelper",
            ),
            (
                serde_json::json!({
                    "mode": "providerToken", "provider": "gitlab",
                    "host": "gitlab.com", "credentialHost": "gitlab.com",
                    "username": "oauth2", "providerAccountId": "42"
                }),
                "providerToken",
            ),
        ];
        for (payload, expected_mode) in cases {
            let auth: GitTransportAuthRef =
                serde_json::from_value(payload.clone()).expect("payload must parse");
            let mode = serde_json::to_value(&auth).unwrap()["mode"]
                .as_str()
                .unwrap()
                .to_string();
            assert_eq!(mode, expected_mode, "payload: {payload}");
        }
    }

    #[test]
    fn github_gh_without_an_account_ref_fails_to_parse() {
        // The old struct made a missing account a runtime error; the variant
        // now requires it, so the payload fails at the boundary instead.
        assert!(
            serde_json::from_value::<GitTransportAuthRef>(serde_json::json!({
                "mode": "githubGh",
                "host": "github.com", "credentialHost": "github.com"
            }))
            .is_err()
        );
    }
}
