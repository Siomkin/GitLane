//! Pull-request operations, routed through the provider selected by the repo's
//! forge. Remote-capable: on the agent, no account ref arrives, so each CLI runs
//! as the server's own login (`remote/ssh-repos`).

use super::{blocking, CommandError};
use crate::git;
use crate::git::forge::{ipc, GithubContext, GithubProvider, PrTarget};
use crate::git::types::{
    FileDiff, ForgeServerLogin, GithubAccountRef, MergeMethod, PrCheck, PrCommitList,
    PrCreateInput, PrReviewerCandidate, PrStack, PrStackMembership, PrStateAction,
    PullRequestDetail, PullRequestMergeOutcome, PullRequestSummary, ReviewThreadList,
};

/// The prologue every pull-request command below shares: resolve the repo's
/// provider and validated context, then run `op` against them.
///
/// These shell out to the `gh` CLI (token resolution + the API call), which
/// blocks for ~1s+, so the work belongs on the blocking thread pool — a
/// synchronous command runs on the webview's main thread and freezes the whole
/// UI (no repaint, no spinner) for the duration of the subprocess. Each command
/// keeps its own `#[tauri::command] pub async fn` signature; the
/// `spawn_blocking` still happens, it just happens here once instead of at
/// eighteen call sites where a new command could forget it.
async fn forge_op<T, F>(
    path: String,
    account: Option<GithubAccountRef>,
    op: F,
) -> Result<T, CommandError>
where
    F: FnOnce(&dyn GithubProvider, &GithubContext) -> Result<T, CommandError> + Send + 'static,
    T: Send + 'static,
{
    blocking(move || {
        let (provider, ctx) = git::forge::context(&path, account.as_ref())?;
        op(provider, &ctx)
    })
    .await
}

/// [`forge_op`] for a write to existing pull requests: the write runs only after
/// each target reads back as the URL the user selected, on the one resolved
/// context the write also uses.
async fn checked_forge_op<T, F>(
    path: String,
    account: Option<GithubAccountRef>,
    targets: Vec<PrTarget>,
    op: F,
) -> Result<T, CommandError>
where
    F: FnOnce(&dyn GithubProvider, &GithubContext) -> Result<T, CommandError> + Send + 'static,
    T: Send + 'static,
{
    blocking(move || {
        let (provider, ctx) = git::forge::context(&path, account.as_ref())?;
        git::forge::check_then_write(provider, &ctx, &targets, || op(provider, &ctx))
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_pull_requests(
    path: String,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PullRequestSummary>, CommandError> {
    forge_op(path, account, |p, ctx| ipc(p.list_prs(ctx))).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pull_request_detail(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<PullRequestDetail, CommandError> {
    forge_op(path, account, move |p, ctx| ipc(p.pr_detail(ctx, number))).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pull_request_checks(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PrCheck>, CommandError> {
    forge_op(path, account, move |p, ctx| ipc(p.pr_checks(ctx, number))).await
}

/// The full, verified PR commit list (GraphQL, paginated), loaded lazily when the
/// Commits tab is opened so `pull_request_detail` stays a single fast call. This
/// supersedes the capped `gh pr view` commit projection carried on the detail.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pull_request_commits(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<PrCommitList, CommandError> {
    forge_op(path, account, move |p, ctx| ipc(p.pr_commits(ctx, number))).await
}

/// The stack a PR belongs to, or `None` when it is not stacked (the common
/// case). Loaded alongside the detail so the stack card can render with the PR
/// body rather than popping in late.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pull_request_stack(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<Option<PrStack>, CommandError> {
    forge_op(path, account, move |p, ctx| ipc(p.pr_stack(ctx, number))).await
}

/// Every stack in the repo, flattened per pull request. Loaded with the PR list
/// so each row can carry its stack badge — one call for the whole list rather
/// than a per-row query.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn repository_stacks(
    path: String,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PrStackMembership>, CommandError> {
    forge_op(path, account, move |p, ctx| ipc(p.list_stacks(ctx))).await
}

/// Inline review threads for a PR (file/line-anchored comments + resolve state).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pull_request_review_threads(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<ReviewThreadList, CommandError> {
    forge_op(path, account, move |p, ctx| {
        ipc(p.review_threads(ctx, number))
    })
    .await
}

/// Resolve or unresolve a review thread by its GraphQL node id.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn resolve_review_thread(
    path: String,
    number: u64,
    pr_url: String,
    thread_id: String,
    resolved: bool,
    account: Option<GithubAccountRef>,
) -> Result<String, CommandError> {
    checked_forge_op(path, account, vec![(number, pr_url)], move |p, ctx| {
        ipc(p.set_thread_resolved(ctx, number, &thread_id, resolved))
    })
    .await
}

/// Full unified diff of a PR, parsed server-side into `FileDiff`s for the viewer.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pull_request_diff(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<Vec<FileDiff>, CommandError> {
    forge_op(path, account, move |p, ctx| ipc(p.pr_diff(ctx, number))).await
}

/// Merge a PR with the given [`MergeMethod`]. Resolving means the
/// merge landed; the outcome carries what the provider could not finish (a
/// `--delete-branch` that did not take effect).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn merge_pull_request(
    path: String,
    number: u64,
    pr_url: String,
    method: MergeMethod,
    delete_branch: bool,
    account: Option<GithubAccountRef>,
) -> Result<PullRequestMergeOutcome, CommandError> {
    checked_forge_op(path, account, vec![(number, pr_url)], move |p, ctx| {
        ipc(p.merge_pr(ctx, number, method, delete_branch))
    })
    .await
}

/// Atomically merge a PR together with every unmerged layer below it in its
/// stack. GitHub runs this asynchronously, so the command polls until the merge
/// reaches a terminal state — it can therefore run for up to a minute, which is
/// exactly why it belongs off the UI thread like every other `gh` command.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn merge_pull_request_stack(
    path: String,
    number: u64,
    pr_url: String,
    method: MergeMethod,
    account: Option<GithubAccountRef>,
) -> Result<String, CommandError> {
    checked_forge_op(path, account, vec![(number, pr_url)], move |p, ctx| {
        ipc(p.merge_stack(ctx, number, method))
    })
    .await
}

/// Submit a bodyless approval.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn approve_pull_request(
    path: String,
    number: u64,
    pr_url: String,
    account: Option<GithubAccountRef>,
) -> Result<String, CommandError> {
    checked_forge_op(path, account, vec![(number, pr_url)], move |p, ctx| {
        ipc(p.approve_pr(ctx, number))
    })
    .await
}

/// Change a PR's lifecycle state (close, reopen, or mark a draft ready).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_pull_request_state(
    path: String,
    number: u64,
    pr_url: String,
    action: PrStateAction,
    account: Option<GithubAccountRef>,
) -> Result<String, CommandError> {
    checked_forge_op(path, account, vec![(number, pr_url)], move |p, ctx| {
        ipc(p.set_pr_state(ctx, number, action))
    })
    .await
}

/// Open a new PR from `input.head` into `input.base`. Returns the new PR URL.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn create_pull_request(
    path: String,
    input: PrCreateInput,
    account: Option<GithubAccountRef>,
) -> Result<String, CommandError> {
    forge_op(path, account, move |p, ctx| ipc(p.create_pr(ctx, &input))).await
}

/// Link existing pull requests into a GitHub stack, bottom-first. Separate from
/// `create_pull_request` so a link failure reports as itself — the pull request
/// exists either way, and saying otherwise would be a lie.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn link_pull_request_stack(
    path: String,
    numbers: Vec<u64>,
    pr_urls: Vec<String>,
    account: Option<GithubAccountRef>,
) -> Result<String, CommandError> {
    let targets = ipc(git::forge::pr_targets(&numbers, pr_urls))?;
    checked_forge_op(path, account, targets, move |p, ctx| {
        ipc(p.link_stack(ctx, &numbers))
    })
    .await
}

/// People who can be asked to review in this repository. Empty for providers
/// without a reviewer lookup, and for a caller without push access.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn pull_request_reviewer_candidates(
    path: String,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PrReviewerCandidate>, CommandError> {
    forge_op(path, account, move |p, ctx| ipc(p.reviewer_candidates(ctx))).await
}

/// Whether the forge CLI behind the repo's remote (`gh`/`glab`) is usable and
/// logged in, and as whom. For a remote repository the agent answers for the
/// server, so the UI can name the login a write runs as, or say what to run.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn forge_server_login(path: String) -> Result<ForgeServerLogin, CommandError> {
    blocking(move || Ok::<_, CommandError>(git::forge::server_login(&path))).await
}
