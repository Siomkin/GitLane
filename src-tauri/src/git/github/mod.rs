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
//! This file is the stable facade: it only declares the submodules and
//! re-exports the public `git::github::*` API, so callers in [`lib`](crate::lib)
//! are insulated from the internal layout. Sibling modules depend only on
//! `cli`/`dto` and the output types — never on each other or on this facade.

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

use crate::git::types::{
    FileDiff, GithubAccount, GithubAccountRef, PrCheck, PrCommitList, PrStack, PrStackMembership,
    PullRequestDetail, PullRequestMergeOutcome, PullRequestSummary, ReviewThreadList,
};

use service::GithubService;

// Interactive `gh auth login --web` device flow (GL-106). Unlike the request/
// response API above it drives a long-lived PTY child, so it manages its own
// error mapping and is re-exported directly.
pub use signin::{cancel_sign_in, sign_in_web, SignInSlot};

fn ipc<T>(result: Result<T, domain::GithubError>) -> Result<T, String> {
    result.map_err(|err| err.to_ipc_string())
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
    match GithubService::default().accounts() {
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

pub fn list_prs(
    workdir: &str,
    account: Option<&GithubAccountRef>,
) -> Result<Vec<PullRequestSummary>, String> {
    ipc(GithubService::default().list_prs(workdir, account))
}

pub fn pr_detail(
    workdir: &str,
    number: u64,
    account: Option<&GithubAccountRef>,
) -> Result<PullRequestDetail, String> {
    ipc(GithubService::default().pr_detail(workdir, number, account))
}

pub fn pr_checks(
    workdir: &str,
    number: u64,
    account: Option<&GithubAccountRef>,
) -> Result<Vec<PrCheck>, String> {
    ipc(GithubService::default().pr_checks(workdir, number, account))
}

pub fn pr_commits(
    workdir: &str,
    number: u64,
    account: Option<&GithubAccountRef>,
) -> Result<PrCommitList, String> {
    ipc(GithubService::default().pr_commits(workdir, number, account))
}

pub fn pr_stack(
    workdir: &str,
    number: u64,
    account: Option<&GithubAccountRef>,
) -> Result<Option<PrStack>, String> {
    ipc(GithubService::default().pr_stack(workdir, number, account))
}

pub fn list_stacks(
    workdir: &str,
    account: Option<&GithubAccountRef>,
) -> Result<Vec<PrStackMembership>, String> {
    ipc(GithubService::default().list_stacks(workdir, account))
}

pub fn merge_stack(
    workdir: &str,
    number: u64,
    method: &str,
    account: Option<&GithubAccountRef>,
) -> Result<String, String> {
    ipc(GithubService::default().merge_stack(workdir, number, method, account))
}

pub fn pr_diff(
    workdir: &str,
    number: u64,
    account: Option<&GithubAccountRef>,
) -> Result<Vec<FileDiff>, String> {
    ipc(GithubService::default().pr_diff(workdir, number, account))
}

pub fn review_threads(
    workdir: &str,
    number: u64,
    account: Option<&GithubAccountRef>,
) -> Result<ReviewThreadList, String> {
    ipc(GithubService::default().review_threads(workdir, number, account))
}

pub fn set_thread_resolved(
    workdir: &str,
    thread_id: &str,
    resolved: bool,
    account: Option<&GithubAccountRef>,
) -> Result<String, String> {
    ipc(GithubService::default().set_thread_resolved(workdir, thread_id, resolved, account))
}

pub fn reply_thread(
    workdir: &str,
    thread_id: &str,
    body: &str,
    account: Option<&GithubAccountRef>,
) -> Result<String, String> {
    ipc(GithubService::default().reply_thread(workdir, thread_id, body, account))
}

pub fn merge_pr(
    workdir: &str,
    number: u64,
    method: &str,
    delete_branch: bool,
    account: Option<&GithubAccountRef>,
) -> Result<PullRequestMergeOutcome, String> {
    ipc(GithubService::default().merge_pr(workdir, number, method, delete_branch, account))
}

pub fn comment_pr(
    workdir: &str,
    number: u64,
    body: &str,
    account: Option<&GithubAccountRef>,
) -> Result<String, String> {
    ipc(GithubService::default().comment_pr(workdir, number, body, account))
}

pub fn review_pr(
    workdir: &str,
    number: u64,
    action: &str,
    body: &str,
    account: Option<&GithubAccountRef>,
) -> Result<String, String> {
    ipc(GithubService::default().review_pr(workdir, number, action, body, account))
}

pub fn set_pr_state(
    workdir: &str,
    number: u64,
    action: &str,
    account: Option<&GithubAccountRef>,
) -> Result<String, String> {
    ipc(GithubService::default().set_pr_state(workdir, number, action, account))
}

pub fn create_pr(
    workdir: &str,
    base: &str,
    head: &str,
    title: &str,
    body: &str,
    draft: bool,
    account: Option<&GithubAccountRef>,
) -> Result<String, String> {
    ipc(GithubService::default().create_pr(workdir, base, head, title, body, draft, account))
}
