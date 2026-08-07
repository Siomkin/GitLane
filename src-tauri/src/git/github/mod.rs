//! GitHub integration via the user's `gh` CLI.
//!
//! Like [`write`](super::write), this shells out to a real binary rather than
//! embedding an HTTP/auth stack: `gh` already handles credentials, multiple
//! accounts, and host config. Each repository can be *bound* to a specific
//! account; that account's token is passed per-invocation via `GH_TOKEN`, so we
//! pin the identity without mutating the user's global `gh auth switch` state.
//! Tokens are resolved server-side and never cross the IPC boundary.
//!
//! The module is split by responsibility:
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
//!
//! This file is the stable facade: it declares the submodules and re-exports the
//! public `git::github::*` API, so callers in [`lib`](crate::lib) are insulated
//! from the internal layout. Sibling modules depend only on `cli`/`dto` and the
//! output types — never on each other or on this facade.
//!
//! A pull-request command resolves its authorised context once, then calls the
//! provider (GL-352):
//!
//! ```ignore
//! let (provider, ctx) = github::context(&path, account.as_ref())?;
//! github::ipc(provider.list_prs(&ctx))
//! ```
//!
//! There is deliberately no per-operation wrapper here: one could only restate
//! the trait's own parameters plus the workdir and account the context carries.

mod bitbucket;
mod bounded_output;
mod cli;
mod diff;
mod domain;
mod dto;
mod gh_provider;
mod gitlab;
mod pagination;
mod prs;
mod service;
mod signin;
mod threads;

use crate::git::types::{GithubAccount, GithubAccountRef};

pub use domain::GithubContext;
use service::context as resolve_context;
pub use service::GithubProvider;

// Interactive `gh auth login --web` device flow (GL-106). Unlike the request/
// response API above it drives a long-lived PTY child, so it manages its own
// error mapping and is re-exported directly.
pub use signin::{cancel_sign_in, sign_in_web, SignInSlot};

/// Map a provider result onto the IPC boundary's `Result<T, String>`.
pub fn ipc<T>(result: Result<T, domain::GithubError>) -> Result<T, String> {
    result.map_err(|err| err.to_ipc_string())
}

/// The provider and validated context a pull-request operation runs against.
/// Every host/account authority check happens here, before the operation.
pub fn context(
    workdir: &str,
    account: Option<&GithubAccountRef>,
) -> Result<(&'static dyn GithubProvider, GithubContext), String> {
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
pub fn accounts() -> Result<Vec<GithubAccount>, String> {
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
