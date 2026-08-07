//! Provider-neutral GitHub domain types and internal error categories.
//!
//! These types sit below the Tauri IPC surface. Commands still return
//! `Result<T, String>` today, but the service/provider boundary keeps stable
//! categories internally so a future IPC error code can be added without
//! rewriting the GitHub feature modules.

use crate::git::types::GithubAccountRef;

pub const GH_PROVIDER: &str = "gh";
pub const DEFAULT_GITHUB_HOST: &str = "github.com";
pub const GH_UPGRADE_URL: &str = "https://cli.github.com";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubRepository {
    pub host: String,
    pub owner: String,
    pub name: String,
}

/// A repository plus the account authorised to act on it. The fields are
/// deliberately not `pub`: the type is re-exported from `git::github` because it
/// appears in [`context`](super::context)'s signature, and if a caller out there
/// could build or edit one, it could point a validated provider at a host
/// `validate_repository_authority` never approved — and the provider would then
/// resolve this account's keychain token against it. Constructing one stays the
/// privilege of `service::context`, which is where that check lives.
#[derive(Debug, Clone)]
pub struct GithubContext {
    pub(in crate::git::github) workdir: String,
    pub(in crate::git::github) repository: GithubRepository,
    pub(in crate::git::github) account: Option<GithubAccountRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GithubError {
    ProviderUnavailable {
        provider: String,
    },
    UnsupportedVersion {
        installed: String,
        required: String,
    },
    /// `gh` is installed but GitLane cannot drive it: it is missing a capability
    /// from the baseline, or it printed a version banner we could not read.
    GhUnusable {
        detail: String,
    },
    UnsupportedForge {
        forge: String,
        host: String,
    },
    NotAuthenticated {
        host: String,
        account: Option<String>,
    },
    RepositoryNotFound {
        workdir: String,
    },
    HostMismatch {
        repo_host: String,
        account_host: String,
    },
    PermissionDenied {
        operation: &'static str,
    },
    RateLimited {
        reset_at: Option<String>,
    },
    Network(String),
    InvalidResponse(String),
    CommandFailed(String),
}

impl GithubError {
    /// True when the failure means `gh` simply cannot serve GitHub for us: it is
    /// not installed, is older than the capability baseline, is missing a
    /// capability, or printed a version banner we could not read.
    ///
    /// `gh` is an **optional** dependency — cloning a public repo, committing,
    /// fetching and pushing all work without it, and a user who never opens a
    /// pull request has no reason to install it. So callers that merely
    /// *enumerate* accounts degrade this to "no GitHub accounts" rather than
    /// raising an app-level error that nags from the toolbar and the Accounts
    /// panel. Callers that genuinely need `gh` (listing PRs, signing in) still
    /// surface the message, at the moment the user reaches for GitHub.
    pub fn is_gh_unusable(&self) -> bool {
        match self {
            Self::ProviderUnavailable { provider } => provider == GH_PROVIDER,
            Self::UnsupportedVersion { .. } | Self::GhUnusable { .. } => true,
            _ => false,
        }
    }

    pub fn from_command(operation: &'static str, err: String) -> Self {
        let lower = err.to_ascii_lowercase();
        if lower.contains("gh) not found")
            || lower.contains("github cli") && lower.contains("not found")
        {
            Self::ProviderUnavailable {
                provider: GH_PROVIDER.to_string(),
            }
        } else if lower.contains("not logged in")
            || lower.contains("authentication")
            || lower.contains("bad credentials")
            || lower.contains("gh auth login")
        {
            Self::NotAuthenticated {
                host: DEFAULT_GITHUB_HOST.to_string(),
                account: None,
            }
        } else if lower.contains("permission")
            || lower.contains("forbidden")
            || lower.contains("http 403")
            || lower.contains("resource not accessible")
        {
            Self::PermissionDenied { operation }
        } else if lower.contains("rate limit") {
            Self::RateLimited { reset_at: None }
        } else if lower.contains("could not resolve host")
            || lower.contains("no such host")
            || lower.contains("network")
            || lower.contains("timed out")
            || lower.contains("connection refused")
        {
            Self::Network(err)
        } else if lower.contains("failed to parse")
            || lower.contains("unexpected")
            || lower.contains("missing")
        {
            Self::InvalidResponse(err)
        } else {
            Self::CommandFailed(err)
        }
    }

    pub fn to_ipc_string(&self) -> String {
        match self {
            Self::ProviderUnavailable { provider } => {
                if provider == GH_PROVIDER {
                    format!("GitHub CLI (gh) not found on PATH — install it from {GH_UPGRADE_URL} to use pull requests.")
                } else {
                    format!("GitHub provider '{provider}' is not available.")
                }
            }
            Self::UnsupportedVersion { installed, required } => format!(
                "GitHub CLI version {installed} is unsupported. GitLane requires gh {required} or newer; upgrade from {GH_UPGRADE_URL}."
            ),
            Self::GhUnusable { detail } => detail.clone(),
            Self::UnsupportedForge { forge, host } => {
                format!("GitLane supports GitHub pull requests, GitLab merge requests, and Bitbucket pull requests; the {forge} remote at {host} isn't supported yet.")
            }
            Self::NotAuthenticated { host, account } => match account {
                Some(login) => format!("GitHub account @{login} is not authenticated for {host}. Run `gh auth login --hostname {host}` or refresh accounts."),
                None => format!("No authenticated GitHub account is available for {host}. Run `gh auth login --hostname {host}`."),
            },
            Self::RepositoryNotFound { workdir } => {
                format!("Could not resolve a GitHub repository for {workdir}. Check that the repo has a GitHub remote.")
            }
            Self::HostMismatch { repo_host, account_host } => format!(
                "The selected account is for {account_host}, but this repository resolves to {repo_host}. Choose an account for the same host before continuing."
            ),
            // Provider-neutral: this variant is produced by both the gh and the
            // GitLab REST paths, so the wording must not name one forge.
            Self::PermissionDenied { operation } => {
                format!("Permission denied for {operation}. Check the selected account and repository access.")
            }
            Self::RateLimited { reset_at } => match reset_at {
                Some(reset) => format!("Rate limit reached. Try again after {reset}."),
                None => "Rate limit reached. Try again later.".to_string(),
            },
            Self::Network(msg) | Self::InvalidResponse(msg) | Self::CommandFailed(msg) => msg.clone(),
        }
    }
}

pub fn normalize_host(host: &str) -> String {
    host.trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

pub fn normalize_account_ref(account: &GithubAccountRef) -> GithubAccountRef {
    GithubAccountRef {
        provider: account.provider.trim().to_ascii_lowercase(),
        host: normalize_host(&account.host),
        account_id: account.account_id.trim().to_string(),
        login: account.login.trim().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_host_strips_scheme_and_slash() {
        assert_eq!(normalize_host("https://GitHub.com/"), "github.com");
        assert_eq!(normalize_host("github.example.com"), "github.example.com");
    }

    #[test]
    fn host_mismatch_maps_to_actionable_ipc_string() {
        let err = GithubError::HostMismatch {
            repo_host: "github.example.com".into(),
            account_host: "github.com".into(),
        };
        assert!(err.to_ipc_string().contains("github.example.com"));
        assert!(err.to_ipc_string().contains("github.com"));
    }
}
