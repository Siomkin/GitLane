//! The forge domain: remote detection plus the provider layer (GL-362).
//!
//! One module owns everything about the repository's forge. **Detection**
//! ([`parsing`]/[`resolution`]) identifies the forge family from configured
//! remote URLs so unsupported providers fail with a precise message instead of
//! a generic GitHub/`gh` error. **Providers** serve accounts and pull requests:
//! like [`write`](super::write), the default engine shells out to a real binary
//! rather than embedding an HTTP/auth stack — `gh` already handles credentials,
//! multiple accounts, and host config. Each repository can be *bound* to a
//! specific account; that account's token is passed per-invocation via
//! `GH_TOKEN`, so we pin the identity without mutating the user's global
//! `gh auth switch` state. Tokens are resolved server-side and never cross the
//! IPC boundary.
//!
//! The provider layer is split by responsibility:
//!
//! - [`bounded_output`] — concurrent hard-bounded stdout/stderr capture shared
//!   by provider CLI transports.
//! - [`cli`] — the single `gh` subprocess site (`run_gh`), account/token
//!   discovery, and repo identity resolution.
//! - [`dto`] — private `gh`/GraphQL response shapes and their conversions into
//!   the public [`crate::git::types`] domain types.
//! - [`prs`] — pull-request reads and writes (`gh pr …`).
//! - [`threads`] — inline review-thread GraphQL operations (resolve/unresolve).
//! - [`diff`] — PR patch fetching and the pure unified-diff parser.
//! - [`rest`] — the shared REST shell (verbs, finishing, secret redaction)
//!   behind the [`gitlab`] and [`bitbucket`] providers.
//!
//! This file is the stable facade: it declares the submodules and re-exports
//! the public `git::forge::*` API, so callers in the command layer are
//! insulated from the internal layout. Sibling modules depend only on
//! `cli`/`dto` and the output types — never on each other or on this facade.
//!
//! A pull-request command resolves its authorised context once, then calls the
//! provider (GL-352):
//!
//! ```ignore
//! let (provider, ctx) = forge::context(&path, account.as_ref())?;
//! forge::ipc(provider.list_prs(&ctx))
//! ```
//!
//! There is deliberately no per-operation wrapper here: one could only restate
//! the trait's own parameters plus the workdir and account the context carries.
// `ipc`/`context`/`accounts` hand the IPC boundary's `CommandError` (128 bytes)
// straight to the command layer; see `commands/mod.rs` for why it is not boxed.
#![allow(clippy::result_large_err)]

mod bitbucket;
mod bounded_output;
mod cli;
mod diff;
mod domain;
mod dto;
mod gh_provider;
mod gitlab;
mod origin;
mod pagination;
mod parsing;
mod prs;
mod resolution;
mod rest;
mod service;
mod signin;
mod threads;

use crate::git::types::CommandError;
use crate::git::types::{GithubAccount, GithubAccountRef};

pub use domain::{GithubContext, GithubError};
use service::context as resolve_context;
pub use service::GithubProvider;

pub(crate) use origin::current_account as origin_account;
// The capability records the process-wide probe cache holds
// (`git::tool_probes`); detection stays inside each CLI module.
pub(crate) use cli::GhCapabilities;
pub(crate) use origin::OriginCapabilities;
pub use parsing::{credential_host_for_url, ApiAuthority};
pub use resolution::{
    bitbucket_repo, default_push_remote, detect, github_project, gitlab_project, origin_project,
    remote_credential_host_for, summary,
};
pub(crate) use resolution::{default_remote_name, remote_api_authority_for_project};

// Interactive `gh auth login --web` device flow (GL-106). Unlike the request/
// response API above it drives a long-lived PTY child, so it manages its own
// error mapping and is re-exported directly.
pub use signin::{cancel_sign_in, sign_in_web, SignInSlot};

/// Map a provider result onto the IPC boundary's [`CommandError`], so the
/// provider's category (auth / network / forge) survives the crossing.
pub fn ipc<T>(result: Result<T, domain::GithubError>) -> Result<T, CommandError> {
    result.map_err(CommandError::from)
}

/// The provider and validated context a pull-request operation runs against.
/// Every host/account authority check happens here, before the operation.
pub fn context(
    workdir: &str,
    account: Option<&GithubAccountRef>,
) -> Result<(&'static dyn GithubProvider, GithubContext), CommandError> {
    ipc(resolve_context(workdir, account))
}

/// List the signed-in GitHub accounts.
///
/// `gh` is an optional dependency, so an unusable `gh` (not installed, too old,
/// missing a capability) is **not** an error here — it simply means there are no
/// GitHub accounts, which is exactly true. GitLane used to surface it as a red
/// "GitHub CLI unavailable" banner in the toolbar and the Accounts panel on
/// every launch, nagging users who only ever clone a public repo and never open
/// a pull request. The explanation is still raised — verbatim — by the calls that
/// genuinely need gh (listing PRs, signing in), i.e. exactly when the user
/// reaches for GitHub. See [`GithubError::is_gh_unusable`].
///
/// [`GithubError::is_gh_unusable`]: domain::GithubError::is_gh_unusable
pub fn accounts() -> Result<Vec<GithubAccount>, CommandError> {
    match service::accounts() {
        Err(err) if err.is_gh_unusable() => Ok(Vec::new()),
        result => ipc(result),
    }
}

/// Sign one account out of `gh` (removes its credential-store entry). Like
/// [`sign_in_web`], this is gh-plumbing rather than a provider operation, so
/// it goes straight to the CLI layer.
pub fn sign_out(host: &str, login: &str) -> Result<String, String> {
    cli::sign_out(host, login)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteForge {
    pub kind: ForgeKind,
    pub host: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgeKind {
    GitHub,
    GitLab,
    Bitbucket,
    AzureDevOps,
    Gitea,
    Forgejo,
    CursorOrigin,
}

/// Authority information carried by a repository remote. HTTP(S) URLs name the
/// exact API authority, including an explicit port. SSH/scp/git URLs name only a
/// transport host; their port (when present) is not an HTTPS API port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RemoteApiAuthority {
    Http(String),
    TransportHost(String),
}

impl ForgeKind {
    /// Canonical git host for [`Self::CursorOrigin`]. Classification is an
    /// exact match on this hostname (HTTPS and SSH).
    pub const CURSOR_ORIGIN_HOST: &'static str = "origin.cursor.com";
    /// Browser root for Cursor Origin PRs — keep in sync with the frontend
    /// `CURSOR_ORIGIN_WEB_ROOT`. Distinct from the git host.
    pub const CURSOR_ORIGIN_WEB_ROOT: &'static str = "https://cursor.com/codebase";
    /// Wire key for [`Self::CursorOrigin`] — keep in lockstep with the
    /// frontend `ForgeKind.CursorOrigin` value.
    pub const CURSOR_ORIGIN_KEY: &'static str = "cursor-origin";

    pub fn label(&self) -> &'static str {
        match self {
            Self::GitHub => "GitHub",
            Self::GitLab => "GitLab",
            Self::Bitbucket => "Bitbucket",
            Self::AzureDevOps => "Azure DevOps",
            Self::Gitea => "Gitea",
            Self::Forgejo => "Forgejo",
            Self::CursorOrigin => "Cursor Origin",
        }
    }

    /// Stable lowercase key for the frontend to switch on.
    pub fn key(&self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::GitLab => "gitlab",
            Self::Bitbucket => "bitbucket",
            Self::AzureDevOps => "azure-devops",
            Self::Gitea => "gitea",
            Self::Forgejo => "forgejo",
            Self::CursorOrigin => Self::CURSOR_ORIGIN_KEY,
        }
    }
}

/// Which configured URL a git transport operation contacts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteTransportDirection {
    Fetch,
    Push,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_stable_lowercase_keys() {
        assert_eq!(ForgeKind::GitHub.key(), "github");
        assert_eq!(ForgeKind::GitLab.key(), "gitlab");
        assert_eq!(ForgeKind::Bitbucket.key(), "bitbucket");
        assert_eq!(ForgeKind::AzureDevOps.key(), "azure-devops");
        assert_eq!(ForgeKind::Gitea.key(), "gitea");
        assert_eq!(ForgeKind::Forgejo.key(), "forgejo");
        assert_eq!(ForgeKind::CursorOrigin.key(), ForgeKind::CURSOR_ORIGIN_KEY);
        assert_eq!(ForgeKind::CURSOR_ORIGIN_HOST, "origin.cursor.com");
        assert_eq!(
            ForgeKind::CURSOR_ORIGIN_WEB_ROOT,
            "https://cursor.com/codebase"
        );
    }
}
