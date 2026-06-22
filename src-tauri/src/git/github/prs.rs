//! Pull-request reads and writes over `gh pr`, account-pinned via `GH_TOKEN`.
//!
//! All `gh pr …` argument construction lives here — including the pure
//! argument builders exercised by tests — so the exact flag order stays in one
//! place. Transport goes through [`super::cli::run_gh`] and response shapes
//! through [`super::dto`]; the output domain types come from [`crate::git::types`].

use super::cli::{repo_slug, run_gh};
use super::dto::*;
use crate::git::types::{
    PrCheck, PrCommitSignature, PrLabel, PrReview, PullRequestDetail, PullRequestSummary,
};

// `gh pr view --json commits` exposes no signature data, so per-commit
// verification is read separately via GraphQL. Mirrors the review-threads query
// in `threads.rs`; the 250 cap matches GitHub's commit projection limit.
const COMMIT_SIGNATURES_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(first:250){nodes{commit{oid signature{isValid}}}}}}}";

const PR_LIST_FIELDS: &str =
    "number,title,state,headRefName,baseRefName,author,createdAt,additions,deletions,changedFiles,isDraft,url";

// `statusCheckRollup` is deliberately excluded — it's the slowest field (extra
// API round-trips) and is fetched lazily via `pr_checks` only when needed.
// `commits` is loaded here (not lazily): it rides the existing GraphQL response
// without extra round-trips and GitHub caps the projection at 250 commits, so it
// stays bounded even for large PRs.
const PR_VIEW_FIELDS: &str =
    "number,title,state,headRefName,baseRefName,author,createdAt,additions,deletions,changedFiles,isDraft,url,body,comments,files,mergeable,reviewRequests,reviews,assignees,labels,milestone,commits";

/// List pull requests (all states, most recent 50) for the repo at `workdir`.
pub fn list_prs(workdir: &str, token: Option<&str>) -> Result<Vec<PullRequestSummary>, String> {
    let raw = run_gh(
        workdir,
        &[
            "pr",
            "list",
            "--state",
            "all",
            "--limit",
            "50",
            "--json",
            PR_LIST_FIELDS,
        ],
        token,
    )?;
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
        })
        .collect())
}

/// Fetch detail (body, files, comment count) for one pull request. Checks are
/// fetched separately via [`pr_checks`] so this stays fast.
pub fn pr_detail(
    workdir: &str,
    number: u64,
    token: Option<&str>,
) -> Result<PullRequestDetail, String> {
    let num = number.to_string();
    let raw = run_gh(
        workdir,
        &["pr", "view", num.as_str(), "--json", PR_VIEW_FIELDS],
        token,
    )?;
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

/// Fetch per-commit signature verification for a PR via GraphQL, loaded lazily
/// when the Commits tab is opened. `verified` is GitHub's own `signature.isValid`
/// (never inferred locally); unsigned commits come back `verified: false`.
pub fn commit_signatures(
    workdir: &str,
    number: u64,
    token: Option<&str>,
) -> Result<Vec<PrCommitSignature>, String> {
    let (owner, name) = repo_slug(workdir, token)?;
    let query_field = format!("query={COMMIT_SIGNATURES_QUERY}");
    let owner_field = format!("owner={owner}");
    let name_field = format!("name={name}");
    let number_field = format!("number={number}");
    let raw = run_gh(
        workdir,
        &[
            "api",
            "graphql",
            "-f",
            &query_field,
            "-f",
            &owner_field,
            "-f",
            &name_field,
            "-F",
            &number_field,
        ],
        token,
    )?;
    let parsed: GqlCommitsResp = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse commit signatures: {e}"))?;
    Ok(parsed
        .data
        .repository
        .pull_request
        .commits
        .nodes
        .into_iter()
        .map(GqlCommitNode::into_signature)
        .collect())
}

/// Fetch just the CI/status checks for a PR (the slow `statusCheckRollup`
/// field), loaded lazily when the Checks tab is opened.
pub fn pr_checks(workdir: &str, number: u64, token: Option<&str>) -> Result<Vec<PrCheck>, String> {
    let num = number.to_string();
    let raw = run_gh(
        workdir,
        &["pr", "view", num.as_str(), "--json", "statusCheckRollup"],
        token,
    )?;
    let parsed: GhChecksOnly = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse gh pr checks output: {e}"))?;
    Ok(parsed
        .status_check_rollup
        .iter()
        .map(|c| PrCheck {
            name: c.name(),
            ok: c.ok(),
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
    number: u64,
    method: &str,
    delete_branch: bool,
    token: Option<&str>,
) -> Result<String, String> {
    let num = number.to_string();
    let args = merge_pr_args(&num, method, delete_branch);
    run_gh(workdir, &args, token)
}

/// Pure argument builder for [`merge_pr`]. Extracted so the exact `gh` flag
/// order can be locked by tests before the module split moves this code.
fn merge_pr_args<'a>(num: &'a str, method: &'a str, delete_branch: bool) -> Vec<&'a str> {
    let method_flag = match method {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    };
    let mut args = vec!["pr", "merge", num, method_flag];
    if delete_branch {
        args.push("--delete-branch");
    }
    args
}

/// Post a discussion comment on a PR.
pub fn comment_pr(
    workdir: &str,
    number: u64,
    body: &str,
    token: Option<&str>,
) -> Result<String, String> {
    if body.trim().is_empty() {
        return Err("Comment body is empty.".to_string());
    }
    let num = number.to_string();
    let args = comment_pr_args(&num, body);
    run_gh(workdir, &args, token)
}

/// Pure argument builder for [`comment_pr`].
fn comment_pr_args<'a>(num: &'a str, body: &'a str) -> Vec<&'a str> {
    vec!["pr", "comment", num, "--body", body]
}

/// Submit a review. `action` is "approve" | "request-changes" | "comment".
/// `--comment` and `--request-changes` require a body; `--approve` doesn't.
pub fn review_pr(
    workdir: &str,
    number: u64,
    action: &str,
    body: &str,
    token: Option<&str>,
) -> Result<String, String> {
    if action != "approve" && body.trim().is_empty() {
        return Err("A review body is required to comment or request changes.".to_string());
    }
    let num = number.to_string();
    let args = review_pr_args(&num, action, body);
    run_gh(workdir, &args, token)
}

/// Pure argument builder for [`review_pr`]. `--body` is appended only when the
/// body is non-empty, so `--approve` without a body omits it (matching gh).
fn review_pr_args<'a>(num: &'a str, action: &'a str, body: &'a str) -> Vec<&'a str> {
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
    args
}

/// Change a PR's lifecycle state. `action` is "close" | "reopen" | "ready"
/// (mark a draft ready for review).
pub fn set_pr_state(
    workdir: &str,
    number: u64,
    action: &str,
    token: Option<&str>,
) -> Result<String, String> {
    let num = number.to_string();
    let args = set_pr_state_args(&num, action);
    run_gh(workdir, &args, token)
}

/// Pure argument builder for [`set_pr_state`].
fn set_pr_state_args<'a>(num: &'a str, action: &'a str) -> Vec<&'a str> {
    let sub = match action {
        "reopen" => "reopen",
        "ready" => "ready",
        _ => "close",
    };
    vec!["pr", sub, num]
}

/// Open a new PR from `head` into `base`. Returns gh's output (the new PR URL).
pub fn create_pr(
    workdir: &str,
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
    let args = create_pr_args(base, head, title, body, draft);
    run_gh(workdir, &args, token)
}

/// Pure argument builder for [`create_pr`].
fn create_pr_args<'a>(
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
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- invalid empty inputs (guards return before shelling out) ----

    #[test]
    fn comment_pr_rejects_empty_body() {
        assert_eq!(
            comment_pr(".", 1, "", None).unwrap_err(),
            "Comment body is empty."
        );
        assert_eq!(
            comment_pr(".", 1, "   \n", None).unwrap_err(),
            "Comment body is empty."
        );
    }

    #[test]
    fn review_pr_requires_body_for_comment_and_request_changes() {
        let msg = "A review body is required to comment or request changes.";
        assert_eq!(review_pr(".", 1, "comment", "", None).unwrap_err(), msg);
        assert_eq!(
            review_pr(".", 1, "request-changes", "  ", None).unwrap_err(),
            msg
        );
    }

    #[test]
    fn create_pr_rejects_empty_title() {
        let msg = "A title is required to open a pull request.";
        assert_eq!(
            create_pr(".", "main", "feat", "", "", false, None).unwrap_err(),
            msg
        );
        assert_eq!(
            create_pr(".", "main", "feat", "  ", "", false, None).unwrap_err(),
            msg
        );
    }

    // ---- gh argument vectors (pure builders) ----

    #[test]
    fn merge_pr_args_preserve_order_and_default_method() {
        assert_eq!(
            merge_pr_args("42", "squash", false),
            vec!["pr", "merge", "42", "--squash"]
        );
        assert_eq!(
            merge_pr_args("42", "rebase", false),
            vec!["pr", "merge", "42", "--rebase"]
        );
        assert_eq!(
            merge_pr_args("42", "merge", false),
            vec!["pr", "merge", "42", "--merge"]
        );
        // Unknown method keeps the historical default.
        assert_eq!(
            merge_pr_args("42", "bogus", false),
            vec!["pr", "merge", "42", "--merge"]
        );
        assert_eq!(
            merge_pr_args("42", "squash", true),
            vec!["pr", "merge", "42", "--squash", "--delete-branch"]
        );
    }

    #[test]
    fn comment_pr_args_match_existing_order() {
        assert_eq!(
            comment_pr_args("7", "hi"),
            vec!["pr", "comment", "7", "--body", "hi"]
        );
    }

    #[test]
    fn review_pr_args_omit_body_for_approve() {
        assert_eq!(
            review_pr_args("7", "approve", ""),
            vec!["pr", "review", "7", "--approve"]
        );
        assert_eq!(
            review_pr_args("7", "approve", "nice"),
            vec!["pr", "review", "7", "--approve", "--body", "nice"]
        );
        assert_eq!(
            review_pr_args("7", "request-changes", "fix"),
            vec!["pr", "review", "7", "--request-changes", "--body", "fix"]
        );
        assert_eq!(
            review_pr_args("7", "comment", "x"),
            vec!["pr", "review", "7", "--comment", "--body", "x"]
        );
        // Unknown action falls back to --comment.
        assert_eq!(
            review_pr_args("7", "bogus", ""),
            vec!["pr", "review", "7", "--comment"]
        );
    }

    #[test]
    fn set_pr_state_args_map_action_to_subcommand() {
        assert_eq!(set_pr_state_args("7", "close"), vec!["pr", "close", "7"]);
        assert_eq!(set_pr_state_args("7", "reopen"), vec!["pr", "reopen", "7"]);
        assert_eq!(set_pr_state_args("7", "ready"), vec!["pr", "ready", "7"]);
        // Unknown action defaults to close (historical behaviour).
        assert_eq!(set_pr_state_args("7", "bogus"), vec!["pr", "close", "7"]);
    }

    #[test]
    fn create_pr_args_preserve_order_and_draft_flag() {
        let base = create_pr_args("main", "feat", "t", "b", false);
        assert_eq!(
            base,
            vec!["pr", "create", "--base", "main", "--head", "feat", "--title", "t", "--body", "b"]
        );
        let mut draft = create_pr_args("main", "feat", "t", "b", true);
        assert_eq!(draft.pop(), Some("--draft"));
        assert_eq!(
            draft,
            vec!["pr", "create", "--base", "main", "--head", "feat", "--title", "t", "--body", "b"]
        );
    }
}
