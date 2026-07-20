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
    PrCheck, PrCommitList, PrLabel, PrReview, PullRequestDetail, PullRequestSummary,
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

fn pr_commits_args<'a>(
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
        let mut args = pr_commits_args(
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
// repo's bound account via `GH_TOKEN`. They return gh's combined output so the
// UI can surface the URL/confirmation (or the error) verbatim.

/// Merge a PR. `method` is "merge" | "squash" | "rebase"; `delete_branch` adds
/// `--delete-branch`. gh enforces branch protection, required checks, etc.
pub fn merge_pr(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    method: &str,
    delete_branch: bool,
    token: Option<&str>,
) -> Result<String, String> {
    let num = number.to_string();
    let repo = repo_selector(repository);
    let args = merge_pr_args(&repo, &num, method, delete_branch);
    run_gh(workdir, &args, token)
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
            pr_commits_args(
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
}
