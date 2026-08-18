//! Forge accounts and pull-request operations, routed through the provider selected by the repo's forge.

use super::blocking;
use crate::git;
use crate::git::forge::{ipc, GithubContext, GithubProvider};
use crate::git::types::{
    FileDiff, GithubAccount, GithubAccountRef, GithubSignInResult, PrCheck, PrCommitList,
    PrCreateInput, PrReviewerCandidate, PrStack, PrStackMembership, PullRequestDetail,
    PullRequestMergeOutcome, PullRequestSummary, ReviewThreadList,
};

/// Holds the in-flight `gh auth login --web` child so [`cancel_github_sign_in`]
/// can terminate it while the device flow streams progress (GL-106). Mirrors
/// [`crate::commands::repo::CloneState`].
#[derive(Default)]
pub struct SignInState(git::forge::SignInSlot);

#[tauri::command]
pub async fn github_accounts() -> Result<Vec<GithubAccount>, String> {
    blocking(git::forge::accounts).await
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
    blocking(move || git::forge::sign_in_web(&app, slot, &host)).await
}

/// Terminate an in-flight [`github_sign_in`]. Instant (lock + kill), so it stays a
/// plain sync command and never queues behind the blocking pool.
#[tauri::command]
pub fn cancel_github_sign_in(state: tauri::State<'_, SignInState>) -> Result<(), String> {
    git::forge::cancel_sign_in(&state.0)
}

/// Sign one account out of `gh` (`gh auth logout`) — removes its credential-
/// store entry. Remotes whose URL still carries that username fall back to the
/// system credential lookup until the user re-signs-in or repoints them.
#[tauri::command]
pub async fn github_sign_out(host: String, login: String) -> Result<String, String> {
    blocking(move || git::forge::sign_out(&host, &login)).await
}

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
async fn forge_op<T, F>(path: String, account: Option<GithubAccountRef>, op: F) -> Result<T, String>
where
    F: FnOnce(&dyn GithubProvider, &GithubContext) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    blocking(move || {
        let (provider, ctx) = git::forge::context(&path, account.as_ref())?;
        op(provider, &ctx)
    })
    .await
}

#[tauri::command]
pub async fn list_pull_requests(
    path: String,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PullRequestSummary>, String> {
    forge_op(path, account, |p, ctx| ipc(p.list_prs(ctx))).await
}

#[tauri::command]
pub async fn pull_request_detail(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<PullRequestDetail, String> {
    forge_op(path, account, move |p, ctx| ipc(p.pr_detail(ctx, number))).await
}

#[tauri::command]
pub async fn pull_request_checks(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PrCheck>, String> {
    forge_op(path, account, move |p, ctx| ipc(p.pr_checks(ctx, number))).await
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
    forge_op(path, account, move |p, ctx| ipc(p.pr_commits(ctx, number))).await
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
    forge_op(path, account, move |p, ctx| ipc(p.pr_stack(ctx, number))).await
}

/// Every stack in the repo, flattened per pull request. Loaded with the PR list
/// so each row can carry its stack badge — one call for the whole list rather
/// than a per-row query.
#[tauri::command]
pub async fn repository_stacks(
    path: String,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PrStackMembership>, String> {
    forge_op(path, account, move |p, ctx| ipc(p.list_stacks(ctx))).await
}

/// Inline review threads for a PR (file/line-anchored comments + resolve state).
#[tauri::command]
pub async fn pull_request_review_threads(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<ReviewThreadList, String> {
    forge_op(path, account, move |p, ctx| {
        ipc(p.review_threads(ctx, number))
    })
    .await
}

/// Resolve or unresolve a review thread by its GraphQL node id.
#[tauri::command]
pub async fn resolve_review_thread(
    path: String,
    number: u64,
    thread_id: String,
    resolved: bool,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    forge_op(path, account, move |p, ctx| {
        ipc(p.set_thread_resolved(ctx, number, &thread_id, resolved))
    })
    .await
}

/// Add a reply to an existing review thread by its GraphQL node id.
#[tauri::command]
pub async fn reply_review_thread(
    path: String,
    number: u64,
    thread_id: String,
    body: String,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    forge_op(path, account, move |p, ctx| {
        ipc(p.reply_thread(ctx, number, &thread_id, &body))
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
    forge_op(path, account, move |p, ctx| ipc(p.pr_diff(ctx, number))).await
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
    forge_op(path, account, move |p, ctx| {
        ipc(p.merge_pr(ctx, number, &method, delete_branch))
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
    forge_op(path, account, move |p, ctx| {
        ipc(p.merge_stack(ctx, number, &method))
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
    forge_op(path, account, move |p, ctx| {
        ipc(p.comment_pr(ctx, number, &body))
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
    forge_op(path, account, move |p, ctx| {
        ipc(p.review_pr(ctx, number, &action, &body))
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
    forge_op(path, account, move |p, ctx| {
        ipc(p.set_pr_state(ctx, number, &action))
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
    forge_op(path, account, move |p, ctx| ipc(p.create_pr(ctx, &input))).await
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
    forge_op(
        path,
        account,
        move |p, ctx| ipc(p.link_stack(ctx, &numbers)),
    )
    .await
}

/// People who can be asked to review in this repository. Empty for providers
/// without a reviewer lookup, and for a caller without push access.
#[tauri::command]
pub async fn pull_request_reviewer_candidates(
    path: String,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PrReviewerCandidate>, String> {
    forge_op(path, account, move |p, ctx| ipc(p.reviewer_candidates(ctx))).await
}

/// Guard what the compiler cannot: a PR command declared as a plain sync
/// command runs its `gh` subprocess on the webview's main thread and freezes
/// the UI. [`forge_op`] makes that hard to do by accident; this makes it
/// visible when someone does it anyway.
#[cfg(test)]
mod blocking_tests {
    use std::fs;
    use std::path::Path;

    /// Instant (lock + kill), so it deliberately stays sync — see its doc.
    const SYNC_BY_DESIGN: &[&str] = &["cancel_github_sign_in"];

    #[test]
    fn every_github_command_is_async() {
        let source = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands/github.rs"),
        )
        .unwrap();
        let lines: Vec<&str> = source.lines().collect();
        let mut checked = 0;
        for (i, line) in lines.iter().enumerate() {
            if line.trim() != "#[tauri::command]" {
                continue;
            }
            let mut j = i + 1;
            while j < lines.len() && lines[j].trim_start().starts_with("#[") {
                j += 1;
            }
            // Report the offending command, not an index panic, when the
            // attribute is not followed by a signature this parser understands.
            let sig = lines
                .get(j)
                .unwrap_or_else(|| panic!("#[tauri::command] on line {} has no signature", i + 1))
                .trim_start();
            let name = sig
                .split("fn ")
                .nth(1)
                .unwrap_or_else(|| panic!("#[tauri::command] on line {} is not a fn: {sig}", i + 1))
                .split(['(', '<'])
                .next()
                .unwrap_or(sig);
            checked += 1;
            if SYNC_BY_DESIGN.contains(&name) {
                continue;
            }
            assert!(
                sig.starts_with("pub async fn"),
                "{name} is a sync #[tauri::command] — it would run on the UI thread; \
                 make it `pub async fn` and route it through `blocking`/`forge_op`"
            );
        }
        assert!(
            checked >= 18,
            "command parser found only {checked} commands"
        );
    }
}
