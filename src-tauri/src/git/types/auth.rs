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
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTransportAuthRef {
    /// "system" | "ssh" | "githubGh" | "gitlabGlab" | "credentialHelper" |
    /// "providerToken".
    pub mode: String,
    /// "github" | "gitlab" | "bitbucket" | "azure-devops" | "gitea" | "forgejo"
    /// | "other".
    #[serde(default)]
    pub provider: Option<String>,
    /// Normalized display host, without scheme or port.
    pub host: String,
    /// Exact credential authority (`host[:port]`) Git sees.
    pub credential_host: String,
    /// HTTPS URL username, when one is selected.
    #[serde(default)]
    pub username: Option<String>,
    /// GitHub account metadata for `githubGh`; never contains a token.
    #[serde(default)]
    pub account_ref: Option<GithubAccountRef>,
    /// Stable, non-secret keychain locator for `providerToken` mode — the
    /// provider account id whose token GitLane stored in the OS keychain. Absent
    /// for every other mode. Never a token.
    #[serde(default)]
    pub provider_account_id: Option<String>,
    /// Whether Git should include the URL path in credential-helper lookups.
    #[serde(default)]
    pub use_http_path: bool,
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
