//! Forge accounts and pull-request operations, routed through the provider selected by the repo's forge.

use super::blocking;
use crate::git;
use crate::git::types::{
    FileDiff, GithubAccount, GithubAccountRef, GithubSignInResult, PrCheck, PrCommitList,
    PrCreateInput, PrReviewerCandidate, PrStack, PrStackMembership, PullRequestDetail,
    PullRequestMergeOutcome, PullRequestSummary, ReviewThreadList,
};

/// Holds the in-flight `gh auth login --web` child so [`cancel_github_sign_in`]
/// can terminate it while the device flow streams progress (GL-106). Mirrors
/// [`CloneState`].
#[derive(Default)]
pub struct SignInState(git::github::SignInSlot);

#[tauri::command]
pub async fn github_accounts() -> Result<Vec<GithubAccount>, String> {
    blocking(git::github::accounts).await
}

/// Sign in a GitHub account in-app via `gh auth login --web` (GL-106). Streams
/// `github-signin-progress` events; the child is parked in [`SignInState`] so
/// [`cancel_github_sign_in`] can stop it. Returns the newly added `{host, login}`.
#[tauri::command]
pub async fn github_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, SignInState>,
    host: String,
) -> Result<GithubSignInResult, String> {
    let slot = state.0.clone();
    blocking(move || git::github::sign_in_web(&app, slot, &host)).await
}

/// Terminate an in-flight [`github_sign_in`]. Instant (lock + kill), so it stays a
/// plain sync command and never queues behind the blocking pool.
#[tauri::command]
pub fn cancel_github_sign_in(state: tauri::State<'_, SignInState>) -> Result<(), String> {
    git::github::cancel_sign_in(&state.0)
}

/// Sign one account out of `gh` (`gh auth logout`) — removes its credential-
/// store entry. Remotes whose URL still carries that username fall back to the
/// system credential lookup until the user re-signs-in or repoints them.
#[tauri::command]
pub async fn github_sign_out(host: String, login: String) -> Result<String, String> {
    blocking(move || git::github::sign_out(&host, &login)).await
}

// These shell out to the `gh` CLI (token resolution + the API call), which
// blocks for ~1s+. They are `async` and run the blocking work on the blocking
// thread pool so the webview's main thread stays free — a synchronous command
// runs on the main thread and freezes the whole UI (no repaint, no spinner)
// for the duration of the subprocess.
#[tauri::command]
pub async fn list_pull_requests(
    path: String,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PullRequestSummary>, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.list_prs(&ctx))
    })
    .await
}

#[tauri::command]
pub async fn pull_request_detail(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<PullRequestDetail, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.pr_detail(&ctx, number))
    })
    .await
}

#[tauri::command]
pub async fn pull_request_checks(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PrCheck>, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.pr_checks(&ctx, number))
    })
    .await
}

/// The full, verified PR commit list (GraphQL, paginated), loaded lazily when the
/// Commits tab is opened so `pull_request_detail` stays a single fast call. This
/// supersedes the capped `gh pr view` commit projection carried on the detail.
#[tauri::command]
pub async fn pull_request_commits(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<PrCommitList, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.pr_commits(&ctx, number))
    })
    .await
}

/// The stack a PR belongs to, or `None` when it is not stacked (the common
/// case). Loaded alongside the detail so the stack card can render with the PR
/// body rather than popping in late.
#[tauri::command]
pub async fn pull_request_stack(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<Option<PrStack>, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.pr_stack(&ctx, number))
    })
    .await
}

/// Every stack in the repo, flattened per pull request. Loaded with the PR list
/// so each row can carry its stack badge — one call for the whole list rather
/// than a per-row query.
#[tauri::command]
pub async fn repository_stacks(
    path: String,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PrStackMembership>, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.list_stacks(&ctx))
    })
    .await
}

/// Inline review threads for a PR (file/line-anchored comments + resolve state).
#[tauri::command]
pub async fn pull_request_review_threads(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<ReviewThreadList, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.review_threads(&ctx, number))
    })
    .await
}

/// Resolve or unresolve a review thread by its GraphQL node id.
#[tauri::command]
pub async fn resolve_review_thread(
    path: String,
    thread_id: String,
    resolved: bool,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.set_thread_resolved(&ctx, &thread_id, resolved))
    })
    .await
}

/// Add a reply to an existing review thread by its GraphQL node id.
#[tauri::command]
pub async fn reply_review_thread(
    path: String,
    thread_id: String,
    body: String,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.reply_thread(&ctx, &thread_id, &body))
    })
    .await
}

/// Full unified diff of a PR, parsed server-side into `FileDiff`s for the viewer.
#[tauri::command]
pub async fn pull_request_diff(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<Vec<FileDiff>, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.pr_diff(&ctx, number))
    })
    .await
}

/// Merge a PR. `method` is "merge" | "squash" | "rebase". Resolving means the
/// merge landed; the outcome carries what the provider could not finish (a
/// `--delete-branch` that did not take effect).
#[tauri::command]
pub async fn merge_pull_request(
    path: String,
    number: u64,
    method: String,
    delete_branch: bool,
    account: Option<GithubAccountRef>,
) -> Result<PullRequestMergeOutcome, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.merge_pr(&ctx, number, &method, delete_branch))
    })
    .await
}

/// Atomically merge a PR together with every unmerged layer below it in its
/// stack. GitHub runs this asynchronously, so the command polls until the merge
/// reaches a terminal state — it can therefore run for up to a minute, which is
/// exactly why it belongs off the UI thread like every other `gh` command.
#[tauri::command]
pub async fn merge_pull_request_stack(
    path: String,
    number: u64,
    method: String,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.merge_stack(&ctx, number, &method))
    })
    .await
}

/// Post a discussion comment on a PR.
#[tauri::command]
pub async fn comment_pull_request(
    path: String,
    number: u64,
    body: String,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.comment_pr(&ctx, number, &body))
    })
    .await
}

/// Submit a review. `action` is "approve" | "request-changes" | "comment".
#[tauri::command]
pub async fn review_pull_request(
    path: String,
    number: u64,
    action: String,
    body: String,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.review_pr(&ctx, number, &action, &body))
    })
    .await
}

/// Change a PR's lifecycle state. `action` is "close" | "reopen" | "ready".
#[tauri::command]
pub async fn set_pull_request_state(
    path: String,
    number: u64,
    action: String,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.set_pr_state(&ctx, number, &action))
    })
    .await
}

/// Open a new PR from `input.head` into `input.base`. Returns the new PR URL.
#[tauri::command]
pub async fn create_pull_request(
    path: String,
    input: PrCreateInput,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.create_pr(&ctx, &input))
    })
    .await
}

/// Link existing pull requests into a GitHub stack, bottom-first. Separate from
/// `create_pull_request` so a link failure reports as itself — the pull request
/// exists either way, and saying otherwise would be a lie.
#[tauri::command]
pub async fn link_pull_request_stack(
    path: String,
    numbers: Vec<u64>,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.link_stack(&ctx, &numbers))
    })
    .await
}

/// People who can be asked to review in this repository. Empty for providers
/// without a reviewer lookup, and for a caller without push access.
#[tauri::command]
pub async fn pull_request_reviewer_candidates(
    path: String,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PrReviewerCandidate>, String> {
    blocking(move || {
        let (p, ctx) = git::github::context(&path, account.as_ref())?;
        git::github::ipc(p.reviewer_candidates(&ctx))
    })
    .await
}
