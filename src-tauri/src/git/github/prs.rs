//! Pull-request reads and writes over `gh pr`, account-pinned via `GH_TOKEN`.
//!
//! All `gh pr …` argument construction lives here — including the pure
//! argument builders exercised by tests — so the exact flag order stays in one
//! place. Transport goes through [`super::cli::run_gh`] and response shapes
//! through [`super::dto`]; the output domain types come from [`crate::git::types`].

use super::cli::{repo_selector, run_gh};
use super::domain::GithubRepository;
use super::dto::*;
use super::pagination::{collect_cursor_pages, CursorPage};
use crate::git::types::{
    PrCheck, PrCommitList, PrLabel, PrReview, PrStack, PullRequestDetail, PullRequestMergeOutcome,
    PullRequestSummary,
};

// `gh pr view --json commits` caps its commit projection and carries no
// signature data, so the authoritative commit list — full metadata plus
// per-commit verification — is read via GraphQL with cursor pagination (mirrors
// the review-threads query in `threads.rs`). A PR past the projection cap keeps
// every commit and its verified badge instead of silently losing the tail.
const PR_COMMITS_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{commit{oid messageHeadline authoredDate signature{isValid} author{name user{login}}}}}}}}";

/// Hard stop for cursor pagination (100 commits per page). At 100 pages this is
/// far beyond any real PR; it guards against a looping `pageInfo`.
const MAX_COMMIT_PAGES: usize = 100;

// The stack a PR belongs to. `gh pr view --json stack` is rejected by gh's
// projection allowlist, so this is GraphQL-only. Deliberately unpaginated: a
// stack is a review unit a human reads top to bottom, and `size` comes back
// alongside `entries` so a stack past the cap is *detectable* by the caller
// rather than silently short.
const PR_STACK_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){stackEntry{position stack{number size baseRefName entries(first:50){nodes{position pullRequest{number title state isDraft headRefName mergeable}}}}}}}}";

/// Poll budget for the asynchronous stack merge: 40 × 1.5s ≈ 60s. GitHub keeps
/// the result readable for 24h, so giving up here loses nothing — it only stops
/// GitLane from holding a worker thread on a merge that is taking unusually long.
const STACK_MERGE_POLL_ATTEMPTS: usize = 40;
const STACK_MERGE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(1500);

// `mergeable` rides the same GraphQL query (no extra round-trip); GitHub may
// report "UNKNOWN" until it computes mergeability, which the frontend tolerates.
const PR_LIST_FIELDS: &str =
    "number,title,state,headRefName,baseRefName,author,createdAt,additions,deletions,changedFiles,isDraft,url,mergeable";

// `statusCheckRollup` is deliberately excluded — it's the slowest field (extra
// API round-trips) and is fetched lazily via `pr_checks` only when needed.
// `commits` is loaded here for a fast first paint of the Commits tab, but it is
// capped by GitHub's projection limit and has no signature data — so the tab
// replaces it with the full, verified, paginated list from [`pr_commits`].
const PR_VIEW_FIELDS: &str =
    "number,title,state,headRefName,baseRefName,author,createdAt,additions,deletions,changedFiles,isDraft,url,body,comments,files,mergeable,reviewRequests,reviews,assignees,labels,milestone,commits";

/// Attach the validated repository target to a `gh pr` argument vector. Every
/// PR command in this module goes through this helper so none can infer a host
/// from the workdir's remote after the selected account token is loaded.
fn target_repository<'a>(mut args: Vec<&'a str>, repository: &'a str) -> Vec<&'a str> {
    args.push("--repo");
    args.push(repository);
    args
}

/// Argument vector for a `$owner`/`$name`/`$number` GraphQL read against the
/// validated host. Shared by every PR-scoped GraphQL query here so the hostname
/// pinning lives in exactly one place.
fn graphql_args<'a>(
    host: &'a str,
    query_field: &'a str,
    owner_field: &'a str,
    name_field: &'a str,
    number_field: &'a str,
) -> Vec<&'a str> {
    vec![
        "api",
        "--hostname",
        host,
        "graphql",
        "-f",
        query_field,
        "-f",
        owner_field,
        "-f",
        name_field,
        "-F",
        number_field,
    ]
}

/// List pull requests (all states, most recent 50) for the repo at `workdir`.
pub fn list_prs(
    workdir: &str,
    repository: &GithubRepository,
    token: Option<&str>,
) -> Result<Vec<PullRequestSummary>, String> {
    let repo = repo_selector(repository);
    let args = target_repository(
        vec![
            "pr",
            "list",
            "--state",
            "all",
            "--limit",
            "50",
            "--json",
            PR_LIST_FIELDS,
        ],
        &repo,
    );
    let raw = run_gh(workdir, &args, token)?;
    let parsed: Vec<GhPrSummary> = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse gh pr list output: {e}"))?;
    Ok(parsed
        .into_iter()
        .map(|p| PullRequestSummary {
            number: p.number,
            title: p.title,
            state: p.state,
            head_ref: p.head_ref_name,
            base_ref: p.base_ref_name,
            author: p.author.into_author(),
            created_at: p.created_at,
            additions: p.additions,
            deletions: p.deletions,
            changed_files: p.changed_files,
            is_draft: p.is_draft,
            url: p.url,
            mergeable: p.mergeable,
        })
        .collect())
}

/// Fetch detail (body, files, comment count) for one pull request. Checks are
/// fetched separately via [`pr_checks`] so this stays fast.
pub fn pr_detail(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    token: Option<&str>,
) -> Result<PullRequestDetail, String> {
    let num = number.to_string();
    let repo = repo_selector(repository);
    let args = target_repository(
        vec!["pr", "view", num.as_str(), "--json", PR_VIEW_FIELDS],
        &repo,
    );
    let raw = run_gh(workdir, &args, token)?;
    let p: GhPrDetail = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse gh pr view output: {e}"))?;
    Ok(PullRequestDetail {
        number: p.number,
        title: p.title,
        state: p.state,
        head_ref: p.head_ref_name,
        base_ref: p.base_ref_name,
        author: p.author.into_author(),
        created_at: p.created_at,
        additions: p.additions,
        deletions: p.deletions,
        changed_files: p.changed_files,
        is_draft: p.is_draft,
        url: p.url,
        body: p.body,
        comments: p.comments.len() as u64,
        files: p.files.into_iter().map(|f| f.path).collect(),
        comment_list: p
            .comments
            .into_iter()
            .map(GhComment::into_comment)
            .collect(),
        mergeable: p.mergeable,
        reviewers: p
            .review_requests
            .into_iter()
            .map(GhReviewer::into_author)
            .collect(),
        reviews: p
            .reviews
            .into_iter()
            .map(|r| PrReview {
                author: r.author.into_author(),
                state: r.state,
            })
            .collect(),
        assignees: p.assignees.into_iter().map(GhAuthor::into_author).collect(),
        labels: p
            .labels
            .into_iter()
            .map(|l| PrLabel {
                name: l.name,
                color: l.color,
            })
            .collect(),
        milestone: p.milestone.map(|m| m.title).filter(|s| !s.is_empty()),
        commits: p.commits.into_iter().map(GhCommit::into_commit).collect(),
    })
}

/// Fetch the full, verified commit list for a PR via GraphQL, loaded lazily when
/// the Commits tab is opened. Unlike the capped `gh pr view` projection this
/// paginates every commit; `verified` is GitHub's own `signature.isValid` (never
/// inferred locally), so unsigned commits come back `verified: false`.
pub fn pr_commits(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    token: Option<&str>,
) -> Result<PrCommitList, String> {
    let query_field = format!("query={PR_COMMITS_QUERY}");
    let owner_field = format!("owner={}", repository.owner);
    let name_field = format!("name={}", repository.name);
    let number_field = format!("number={number}");
    let result = collect_cursor_pages(MAX_COMMIT_PAGES, |cursor| {
        let mut args = graphql_args(
            &repository.host,
            &query_field,
            &owner_field,
            &name_field,
            &number_field,
        );
        // Omitted on the first page so `$cursor` stays null (same as threads.rs).
        let cursor_field = cursor.map(|c| format!("cursor={c}"));
        if let Some(f) = cursor_field.as_deref() {
            args.push("-f");
            args.push(f);
        }
        let raw = run_gh(workdir, &args, token)?;
        let parsed: GqlCommitsResp = serde_json::from_str(&raw)
            .map_err(|e| format!("failed to parse pull request commits: {e}"))?;
        let connection = parsed.data.repository.pull_request.commits;
        let has_more = connection
            .page_info
            .as_ref()
            .is_some_and(|page| page.has_next_page);
        let end_cursor = connection.page_info.and_then(|page| page.end_cursor);
        Ok::<_, String>(CursorPage {
            items: connection
                .nodes
                .into_iter()
                .map(GqlCommitNode::into_commit)
                .collect(),
            has_more,
            end_cursor,
        })
    })?;
    // Same runaway-guard breadcrumb as review threads: don't drop the tail
    // silently if a pathologically large PR ever reaches the page cap.
    if result.truncated {
        eprintln!(
            "gitlane: commits for PR #{number} hit the {MAX_COMMIT_PAGES}-page cap; \
             {} fetched, later commits omitted",
            result.items.len()
        );
    }
    Ok(PrCommitList {
        commits: result.items,
        truncated: result.truncated,
    })
}

/// Fetch the stack a pull request belongs to, or `None` when it is not stacked.
///
/// Not being in a stack is the common case and a perfectly successful read —
/// GitHub returns `stackEntry: null` — so it must not surface as an error the
/// UI has to filter out.
pub fn pr_stack(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    token: Option<&str>,
) -> Result<Option<PrStack>, String> {
    let query_field = format!("query={PR_STACK_QUERY}");
    let owner_field = format!("owner={}", repository.owner);
    let name_field = format!("name={}", repository.name);
    let number_field = format!("number={number}");
    let args = graphql_args(
        &repository.host,
        &query_field,
        &owner_field,
        &name_field,
        &number_field,
    );
    let raw = run_gh(workdir, &args, token)?;
    let parsed: GqlStackResp = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse pull request stack: {e}"))?;
    Ok(parsed
        .data
        .repository
        .pull_request
        .stack_entry
        .map(GqlStackEntry::into_stack))
}

/// Fetch just the CI/status checks for a PR (the slow `statusCheckRollup`
/// field), loaded lazily when the Checks tab is opened.
pub fn pr_checks(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    token: Option<&str>,
) -> Result<Vec<PrCheck>, String> {
    let num = number.to_string();
    let repo = repo_selector(repository);
    let args = target_repository(
        vec!["pr", "view", num.as_str(), "--json", "statusCheckRollup"],
        &repo,
    );
    let raw = run_gh(workdir, &args, token)?;
    let parsed: GhChecksOnly = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse gh pr checks output: {e}"))?;
    Ok(parsed
        .status_check_rollup
        .iter()
        .map(|c| PrCheck {
            name: c.name(),
            state: c.status().to_string(),
        })
        .collect())
}

// ---- PR write operations ----
//
// Each shells out to `gh pr <verb>` exactly like the reads above, pinned to the
// repo's bound account via `GH_TOKEN`. Most return gh's output so the UI can
// surface the URL/confirmation (or the error) verbatim; `merge_pr` returns a
// structured outcome instead, because what it must report is not in that output.

/// Merge a PR. `method` is "merge" | "squash" | "rebase"; `delete_branch` adds
/// `--delete-branch`. gh enforces branch protection, required checks, etc.
pub fn merge_pr(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    method: &str,
    delete_branch: bool,
    token: Option<&str>,
) -> Result<PullRequestMergeOutcome, String> {
    let num = number.to_string();
    let repo = repo_selector(repository);
    let args = merge_pr_args(&repo, &num, method, delete_branch);
    run_gh(workdir, &args, token)?;
    // The merge landed. `--delete-branch` is best-effort in gh — a protected
    // branch or a missing permission leaves it in place and gh still exits 0,
    // reporting that only on stderr, which the success path drops (see
    // `cli::finish_gh_bytes`). So verify the outcome instead of reading the
    // narration.
    Ok(PullRequestMergeOutcome {
        undeleted_branch: delete_branch
            .then(|| surviving_head_ref(workdir, repository, number, token))
            .flatten(),
    })
}

// One probe, not a parse: GitHub nulls `headRef` once the branch is gone, so a
// non-null answer alongside its name — on a PR that is *confirmed merged* — is
// evidence the delete did not take. Both fields matter: `gh pr merge` also exits
// 0 when it only enables auto-merge or enqueues the PR (see the comment in
// `PrMergeMenu.tsx`), and the head branch is *supposed* to survive that, so
// `merged` is what separates a failed delete from a PR that simply hasn't merged
// yet. The query is locale-independent and survives any change to gh's wording.
const PR_HEAD_REF_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){merged headRefName headRef{name}}}}";

/// The head branch's name when a merge asked for its deletion, the PR is
/// confirmed merged, and the branch still exists — else `None`.
///
/// Every failure resolves to `None`. The merge call already succeeded, so a
/// probe that errors, times out, or comes back partial must not fail the command
/// or invent a warning — silence is the safe answer. A head ref the caller
/// cannot read (a fork they lack access to) reads as `None` for the same reason,
/// so this under-reports rather than crying wolf.
fn surviving_head_ref(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    token: Option<&str>,
) -> Option<String> {
    let num = number.to_string();
    let query_field = format!("query={PR_HEAD_REF_QUERY}");
    let owner_field = format!("owner={}", repository.owner);
    let name_field = format!("name={}", repository.name);
    let number_field = format!("number={num}");
    let args = head_ref_args(
        &repository.host,
        &query_field,
        &owner_field,
        &name_field,
        &number_field,
    );
    let raw = run_gh(workdir, &args, token).ok()?;
    parse_surviving_head_ref(&raw)
}

/// Pure argument builder for [`surviving_head_ref`]. `--hostname` is explicit
/// for the same reason as in `threads.rs`: `gh api` otherwise targets gh's
/// default host and would send a GitHub Enterprise repo's token elsewhere.
fn head_ref_args<'a>(
    host: &'a str,
    query_field: &'a str,
    owner_field: &'a str,
    name_field: &'a str,
    number_field: &'a str,
) -> Vec<&'a str> {
    vec![
        "api",
        "--hostname",
        host,
        "graphql",
        "-f",
        query_field,
        "-f",
        owner_field,
        "-f",
        name_field,
        "-F",
        number_field,
    ]
}

/// Pure response reader for [`surviving_head_ref`]: `Some(name)` only when the
/// payload proves the PR merged, the branch outlived it, *and* names it.
/// Unparseable JSON, any GraphQL error, an unmerged PR, a null anywhere on the
/// path, or a surviving ref with no usable name all mean "cannot tell" → `None`.
fn parse_surviving_head_ref(raw: &str) -> Option<String> {
    let resp = serde_json::from_str::<GqlHeadRefResp>(raw).ok()?;
    // A 200 can carry `data` *and* `errors` for a partially resolved query; a
    // half-answered probe is not evidence of anything.
    if resp.errors.is_some_and(|errors| !errors.is_empty()) {
        return None;
    }
    let pr = resp.data?.repository?.pull_request?;
    if pr.merged != Some(true) {
        return None;
    }
    pr.head_ref?;
    pr.head_ref_name.filter(|name| !name.trim().is_empty())
}

/// Merge a stack atomically: `number` and every unmerged layer below it land in
/// one all-or-nothing operation, or none of them do.
///
/// This is the only merge path GitHub offers for a stack — `gh pr merge` merges
/// one PR — and it is **asynchronous**: the PUT enqueues the work and returns a
/// uuid, and the real outcome only arrives from polling. Returning right after
/// the PUT would report success for a merge that is still deciding, so this
/// blocks on the poll (inside `blocking()`, off the UI thread) and reports what
/// actually happened.
pub fn merge_stack(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    method: &str,
    token: Option<&str>,
) -> Result<String, String> {
    let path = merge_async_path(repository, number);
    let method_field = format!("merge_method={}", merge_async_method(method));
    let args = merge_async_start_args(&repository.host, &path, &method_field);
    let raw = run_gh(workdir, &args, token)?;
    let started: GhMergeAsync = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse stack merge response: {e}"))?;
    // A stack already merged (or already queued) answers the PUT directly with a
    // terminal status and no uuid to poll.
    if let Some(outcome) = merge_async_outcome(&started) {
        return outcome;
    }
    let uuid = started
        .details
        .as_ref()
        .and_then(|d| d.uuid.clone())
        .ok_or_else(|| {
            "GitHub accepted the stack merge but returned no id to track it. \
             Check the pull requests on GitHub before retrying."
                .to_string()
        })?;
    let poll_path = format!("{path}/{uuid}");
    let poll_args = merge_async_poll_args(&repository.host, &poll_path);
    for _ in 0..STACK_MERGE_POLL_ATTEMPTS {
        std::thread::sleep(STACK_MERGE_POLL_INTERVAL);
        let raw = run_gh(workdir, &poll_args, token)?;
        let polled: GhMergeAsync = serde_json::from_str(&raw)
            .map_err(|e| format!("failed to parse stack merge status: {e}"))?;
        if let Some(outcome) = merge_async_outcome(&polled) {
            return outcome;
        }
    }
    // The merge is still GitHub's to finish — say so instead of claiming either
    // outcome. Results stay readable for 24h, so nothing is lost by stopping here.
    Err(format!(
        "The stack merge is still running on GitHub after {}s. \
         Refresh the pull requests to see the result.",
        (STACK_MERGE_POLL_ATTEMPTS as u64 * STACK_MERGE_POLL_INTERVAL.as_millis() as u64) / 1000
    ))
}

/// Map a terminal `merge-async` status to the value [`merge_stack`] returns.
/// `None` means "still pending" — keep polling.
fn merge_async_outcome(response: &GhMergeAsync) -> Option<Result<String, String>> {
    let message = response
        .details
        .as_ref()
        .and_then(|d| d.message.clone())
        .filter(|m| !m.trim().is_empty());
    match response.status.as_str() {
        "merged" => Some(Ok(message.unwrap_or_else(|| "Stack merged.".to_string()))),
        "enqueued" => {
            Some(Ok(message.unwrap_or_else(|| {
                "Stack added to the merge queue.".to_string()
            })))
        }
        // GitHub evaluates branch protection and repository rules at merge time,
        // so its own message is the actionable one — surface it verbatim.
        "failed" => Some(Err(message.unwrap_or_else(|| {
            "GitHub could not merge the stack. Nothing was merged.".to_string()
        }))),
        _ => None,
    }
}

/// `merge_method` accepts `merge` | `squash` | `rebase`; anything else falls back
/// to a plain merge, matching [`merge_pr_args`].
fn merge_async_method(method: &str) -> &str {
    match method {
        "squash" => "squash",
        "rebase" => "rebase",
        _ => "merge",
    }
}

fn merge_async_path(repository: &GithubRepository, number: u64) -> String {
    format!(
        "repos/{}/{}/pulls/{number}/merge-async",
        repository.owner, repository.name
    )
}

fn merge_async_start_args<'a>(host: &'a str, path: &'a str, method_field: &'a str) -> Vec<&'a str> {
    vec![
        "api",
        "--hostname",
        host,
        "-X",
        "PUT",
        path,
        "-f",
        method_field,
    ]
}

fn merge_async_poll_args<'a>(host: &'a str, path: &'a str) -> Vec<&'a str> {
    vec!["api", "--hostname", host, path]
}

/// Pure argument builder for [`merge_pr`]. Extracted so the exact `gh` flag
/// order can be locked by tests before the module split moves this code.
fn merge_pr_args<'a>(
    repository: &'a str,
    num: &'a str,
    method: &'a str,
    delete_branch: bool,
) -> Vec<&'a str> {
    let method_flag = match method {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    };
    let mut args = vec!["pr", "merge", num, method_flag];
    if delete_branch {
        args.push("--delete-branch");
    }
    target_repository(args, repository)
}

/// Post a discussion comment on a PR.
pub fn comment_pr(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    body: &str,
    token: Option<&str>,
) -> Result<String, String> {
    if body.trim().is_empty() {
        return Err("Comment body is empty.".to_string());
    }
    let num = number.to_string();
    let repo = repo_selector(repository);
    let args = comment_pr_args(&repo, &num, body);
    run_gh(workdir, &args, token)
}

/// Pure argument builder for [`comment_pr`].
fn comment_pr_args<'a>(repository: &'a str, num: &'a str, body: &'a str) -> Vec<&'a str> {
    target_repository(vec!["pr", "comment", num, "--body", body], repository)
}

/// Submit a review. `action` is "approve" | "request-changes" | "comment".
/// `--comment` and `--request-changes` require a body; `--approve` doesn't.
pub fn review_pr(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    action: &str,
    body: &str,
    token: Option<&str>,
) -> Result<String, String> {
    if action != "approve" && body.trim().is_empty() {
        return Err("A review body is required to comment or request changes.".to_string());
    }
    let num = number.to_string();
    let repo = repo_selector(repository);
    let args = review_pr_args(&repo, &num, action, body);
    run_gh(workdir, &args, token)
}

/// Pure argument builder for [`review_pr`]. `--body` is appended only when the
/// body is non-empty, so `--approve` without a body omits it (matching gh).
fn review_pr_args<'a>(
    repository: &'a str,
    num: &'a str,
    action: &'a str,
    body: &'a str,
) -> Vec<&'a str> {
    let action_flag = match action {
        "approve" => "--approve",
        "request-changes" => "--request-changes",
        _ => "--comment",
    };
    let mut args = vec!["pr", "review", num, action_flag];
    if !body.trim().is_empty() {
        args.push("--body");
        args.push(body);
    }
    target_repository(args, repository)
}

/// Change a PR's lifecycle state. `action` is "close" | "reopen" | "ready"
/// (mark a draft ready for review).
pub fn set_pr_state(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    action: &str,
    token: Option<&str>,
) -> Result<String, String> {
    let num = number.to_string();
    let repo = repo_selector(repository);
    let args = set_pr_state_args(&repo, &num, action);
    run_gh(workdir, &args, token)
}

/// Pure argument builder for [`set_pr_state`].
fn set_pr_state_args<'a>(repository: &'a str, num: &'a str, action: &'a str) -> Vec<&'a str> {
    let sub = match action {
        "reopen" => "reopen",
        "ready" => "ready",
        _ => "close",
    };
    target_repository(vec!["pr", sub, num], repository)
}

/// Open a new PR from `head` into `base`. Returns gh's output (the new PR URL).
#[allow(clippy::too_many_arguments)] // Keeps the validated repository target explicit beside PR fields.
pub fn create_pr(
    workdir: &str,
    repository: &GithubRepository,
    base: &str,
    head: &str,
    title: &str,
    body: &str,
    draft: bool,
    token: Option<&str>,
) -> Result<String, String> {
    if title.trim().is_empty() {
        return Err("A title is required to open a pull request.".to_string());
    }
    let repo = repo_selector(repository);
    let args = create_pr_args(&repo, base, head, title, body, draft);
    run_gh(workdir, &args, token)
}

/// Pure argument builder for [`create_pr`].
fn create_pr_args<'a>(
    repository: &'a str,
    base: &'a str,
    head: &'a str,
    title: &'a str,
    body: &'a str,
    draft: bool,
) -> Vec<&'a str> {
    let mut args = vec![
        "pr", "create", "--base", base, "--head", head, "--title", title, "--body", body,
    ];
    if draft {
        args.push("--draft");
    }
    target_repository(args, repository)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TARGET: &str = "ghe.example.test:8443/octo/app";

    fn repository() -> GithubRepository {
        GithubRepository {
            host: "ghe.example.test:8443".into(),
            owner: "octo".into(),
            name: "app".into(),
        }
    }

    // ---- invalid empty inputs (guards return before shelling out) ----

    #[test]
    fn comment_pr_rejects_empty_body() {
        assert_eq!(
            comment_pr(".", &repository(), 1, "", None).unwrap_err(),
            "Comment body is empty."
        );
        assert_eq!(
            comment_pr(".", &repository(), 1, "   \n", None).unwrap_err(),
            "Comment body is empty."
        );
    }

    #[test]
    fn review_pr_requires_body_for_comment_and_request_changes() {
        let msg = "A review body is required to comment or request changes.";
        assert_eq!(
            review_pr(".", &repository(), 1, "comment", "", None).unwrap_err(),
            msg
        );
        assert_eq!(
            review_pr(".", &repository(), 1, "request-changes", "  ", None,).unwrap_err(),
            msg
        );
    }

    #[test]
    fn create_pr_rejects_empty_title() {
        let msg = "A title is required to open a pull request.";
        assert_eq!(
            create_pr(".", &repository(), "main", "feat", "", "", false, None,).unwrap_err(),
            msg
        );
        assert_eq!(
            create_pr(".", &repository(), "main", "feat", "  ", "", false, None,).unwrap_err(),
            msg
        );
    }

    // ---- gh argument vectors (pure builders) ----

    #[test]
    fn merge_pr_args_preserve_order_and_default_method() {
        assert_eq!(
            merge_pr_args(TARGET, "42", "squash", false),
            vec!["pr", "merge", "42", "--squash", "--repo", TARGET]
        );
        assert_eq!(
            merge_pr_args(TARGET, "42", "rebase", false),
            vec!["pr", "merge", "42", "--rebase", "--repo", TARGET]
        );
        assert_eq!(
            merge_pr_args(TARGET, "42", "merge", false),
            vec!["pr", "merge", "42", "--merge", "--repo", TARGET]
        );
        // Unknown method keeps the historical default.
        assert_eq!(
            merge_pr_args(TARGET, "42", "bogus", false),
            vec!["pr", "merge", "42", "--merge", "--repo", TARGET]
        );
        assert_eq!(
            merge_pr_args(TARGET, "42", "squash", true),
            vec![
                "pr",
                "merge",
                "42",
                "--squash",
                "--delete-branch",
                "--repo",
                TARGET,
            ]
        );
    }

    #[test]
    fn head_ref_args_pin_the_hostname() {
        // `gh api` defaults to gh's own host; without --hostname a GHES repo's
        // token would go to github.com.
        assert_eq!(
            head_ref_args(
                "ghe.example.test:8443",
                "query=q",
                "owner=octo",
                "name=app",
                "number=42",
            ),
            vec![
                "api",
                "--hostname",
                "ghe.example.test:8443",
                "graphql",
                "-f",
                "query=q",
                "-f",
                "owner=octo",
                "-f",
                "name=app",
                "-F",
                "number=42",
            ]
        );
    }

    #[test]
    fn surviving_head_ref_reports_a_branch_that_outlived_the_merge() {
        let raw = r#"{"data":{"repository":{"pullRequest":{"merged":true,"headRefName":"feature/x","headRef":{"name":"feature/x"}}}}}"#;
        assert_eq!(parse_surviving_head_ref(raw), Some("feature/x".to_string()));
    }

    #[test]
    fn surviving_head_ref_is_silent_when_the_branch_is_gone() {
        // The delete worked: GitHub keeps `headRefName` but nulls `headRef`.
        let raw = r#"{"data":{"repository":{"pullRequest":{"merged":true,"headRefName":"feature/x","headRef":null}}}}"#;
        assert_eq!(parse_surviving_head_ref(raw), None);
    }

    #[test]
    fn surviving_head_ref_is_silent_when_the_pr_is_not_merged_yet() {
        // `gh pr merge` exits 0 for auto-merge / merge-queue enrollment too. The
        // head branch is SUPPOSED to survive that, so warning would be a lie.
        for raw in [
            r#"{"data":{"repository":{"pullRequest":{"merged":false,"headRefName":"feature/x","headRef":{"name":"feature/x"}}}}}"#,
            // Field absent entirely (older/partial projection) — still not proof.
            r#"{"data":{"repository":{"pullRequest":{"headRefName":"feature/x","headRef":{"name":"feature/x"}}}}}"#,
            r#"{"data":{"repository":{"pullRequest":{"merged":null,"headRefName":"feature/x","headRef":{"name":"feature/x"}}}}}"#,
        ] {
            assert_eq!(parse_surviving_head_ref(raw), None, "raw: {raw}");
        }
    }

    #[test]
    fn surviving_head_ref_is_silent_on_a_partially_errored_response() {
        // GraphQL answers 200 with both `data` and `errors` for a partly
        // resolved query; a half-answered probe proves nothing.
        let raw = r#"{"data":{"repository":{"pullRequest":{"merged":true,"headRefName":"feature/x","headRef":{"name":"feature/x"}}}},"errors":[{"message":"Something went wrong"}]}"#;
        assert_eq!(parse_surviving_head_ref(raw), None);
        // An empty `errors` array is not an error.
        let clean = r#"{"data":{"repository":{"pullRequest":{"merged":true,"headRefName":"feature/x","headRef":{"name":"feature/x"}}}},"errors":[]}"#;
        assert_eq!(
            parse_surviving_head_ref(clean),
            Some("feature/x".to_string())
        );
    }

    #[test]
    fn surviving_head_ref_is_silent_when_it_cannot_tell() {
        // Every "cannot tell" shape must stay quiet rather than raise a false
        // alarm on a merge that already succeeded.
        for raw in [
            // GraphQL error payload (no `data`).
            r#"{"errors":[{"message":"Could not resolve to a Repository"}]}"#,
            // GraphQL error payload with an explicit null `data`.
            r#"{"data":null,"errors":[{"message":"Could not resolve to a Repository"}]}"#,
            // Nulls anywhere on the path.
            r#"{"data":{"repository":null}}"#,
            r#"{"data":{"repository":{"pullRequest":null}}}"#,
            // Merged with a surviving ref, but no usable name to report — these
            // carry `merged` so they exercise the name filter, not the gate above.
            r#"{"data":{"repository":{"pullRequest":{"merged":true,"headRefName":null,"headRef":{"name":"x"}}}}}"#,
            r#"{"data":{"repository":{"pullRequest":{"merged":true,"headRefName":"  ","headRef":{"name":"x"}}}}}"#,
            // Not JSON at all.
            "not json",
            "",
        ] {
            assert_eq!(parse_surviving_head_ref(raw), None, "raw: {raw}");
        }
    }

    #[test]
    fn comment_pr_args_match_existing_order() {
        assert_eq!(
            comment_pr_args(TARGET, "7", "hi"),
            vec!["pr", "comment", "7", "--body", "hi", "--repo", TARGET]
        );
    }

    #[test]
    fn review_pr_args_omit_body_for_approve() {
        assert_eq!(
            review_pr_args(TARGET, "7", "approve", ""),
            vec!["pr", "review", "7", "--approve", "--repo", TARGET]
        );
        assert_eq!(
            review_pr_args(TARGET, "7", "approve", "nice"),
            vec![
                "pr",
                "review",
                "7",
                "--approve",
                "--body",
                "nice",
                "--repo",
                TARGET,
            ]
        );
        assert_eq!(
            review_pr_args(TARGET, "7", "request-changes", "fix"),
            vec![
                "pr",
                "review",
                "7",
                "--request-changes",
                "--body",
                "fix",
                "--repo",
                TARGET,
            ]
        );
        assert_eq!(
            review_pr_args(TARGET, "7", "comment", "x"),
            vec![
                "pr",
                "review",
                "7",
                "--comment",
                "--body",
                "x",
                "--repo",
                TARGET,
            ]
        );
        // Unknown action falls back to --comment.
        assert_eq!(
            review_pr_args(TARGET, "7", "bogus", ""),
            vec!["pr", "review", "7", "--comment", "--repo", TARGET]
        );
    }

    #[test]
    fn set_pr_state_args_map_action_to_subcommand() {
        assert_eq!(
            set_pr_state_args(TARGET, "7", "close"),
            vec!["pr", "close", "7", "--repo", TARGET]
        );
        assert_eq!(
            set_pr_state_args(TARGET, "7", "reopen"),
            vec!["pr", "reopen", "7", "--repo", TARGET]
        );
        assert_eq!(
            set_pr_state_args(TARGET, "7", "ready"),
            vec!["pr", "ready", "7", "--repo", TARGET]
        );
        // Unknown action defaults to close (historical behaviour).
        assert_eq!(
            set_pr_state_args(TARGET, "7", "bogus"),
            vec!["pr", "close", "7", "--repo", TARGET]
        );
    }

    #[test]
    fn create_pr_args_preserve_order_and_draft_flag() {
        let base = create_pr_args(TARGET, "main", "feat", "t", "b", false);
        assert_eq!(
            base,
            vec![
                "pr", "create", "--base", "main", "--head", "feat", "--title", "t", "--body", "b",
                "--repo", TARGET
            ]
        );
        let draft = create_pr_args(TARGET, "main", "feat", "t", "b", true);
        assert_eq!(
            draft,
            vec![
                "pr", "create", "--base", "main", "--head", "feat", "--title", "t", "--body", "b",
                "--draft", "--repo", TARGET
            ]
        );
    }

    #[test]
    fn graphql_commit_args_target_the_validated_authority() {
        assert_eq!(
            graphql_args(
                "ghe.example.test:8443",
                "query=q",
                "owner=octo",
                "name=app",
                "number=7",
            ),
            vec![
                "api",
                "--hostname",
                "ghe.example.test:8443",
                "graphql",
                "-f",
                "query=q",
                "-f",
                "owner=octo",
                "-f",
                "name=app",
                "-F",
                "number=7",
            ]
        );
    }

    // ---- stack merge (asynchronous, poll-until-terminal) ----

    fn merge_async(status: &str, message: Option<&str>, uuid: Option<&str>) -> GhMergeAsync {
        serde_json::from_value(serde_json::json!({
            "status": status,
            "details": { "message": message, "uuid": uuid },
        }))
        .unwrap()
    }

    #[test]
    fn a_pending_stack_merge_keeps_polling() {
        // The whole point of the poll loop: "accepted" is not "merged".
        assert!(merge_async_outcome(&merge_async("pending", None, Some("u-1"))).is_none());
    }

    #[test]
    fn terminal_stack_merge_statuses_resolve() {
        let merged = merge_async_outcome(&merge_async("merged", Some("Merged 3 PRs"), None));
        assert_eq!(merged.unwrap(), Ok("Merged 3 PRs".to_string()));

        let queued = merge_async_outcome(&merge_async("enqueued", None, None));
        assert_eq!(
            queued.unwrap(),
            Ok("Stack added to the merge queue.".to_string())
        );

        // A failed stack merge is all-or-nothing, and GitHub's own message names
        // the rule that blocked it — surface it rather than a generic error.
        let failed =
            merge_async_outcome(&merge_async("failed", Some("Required check failed"), None));
        assert_eq!(failed.unwrap(), Err("Required check failed".to_string()));
    }

    #[test]
    fn a_terminal_status_without_a_message_still_reads_clearly() {
        // Blank messages must not produce an empty error/success string.
        let failed = merge_async_outcome(&merge_async("failed", Some("   "), None));
        assert_eq!(
            failed.unwrap(),
            Err("GitHub could not merge the stack. Nothing was merged.".to_string())
        );
    }

    #[test]
    fn stack_merge_targets_the_validated_authority_and_method() {
        let repository = GithubRepository {
            host: "ghe.example.test:8443".into(),
            owner: "octo".into(),
            name: "app".into(),
        };
        let path = merge_async_path(&repository, 7);
        assert_eq!(path, "repos/octo/app/pulls/7/merge-async");
        let method_field = format!("merge_method={}", merge_async_method("squash"));
        assert_eq!(
            merge_async_start_args(&repository.host, &path, &method_field),
            vec![
                "api",
                "--hostname",
                "ghe.example.test:8443",
                "-X",
                "PUT",
                "repos/octo/app/pulls/7/merge-async",
                "-f",
                "merge_method=squash",
            ]
        );
        // An unknown method falls back to a plain merge rather than being sent
        // through to the API verbatim.
        assert_eq!(merge_async_method("nonsense"), "merge");
    }
}
