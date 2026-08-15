//! PR list / detail / checks reads over `gh pr` (the fast projections).

use super::super::cli::{repo_selector, run_gh};
use super::super::domain::GithubRepository;
use super::super::dto::*;
use super::target_repository;
use crate::git::types::{PrCheck, PrLabel, PrReview, PullRequestDetail, PullRequestSummary};

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
            state: p.state.into(),
            head_ref: p.head_ref_name,
            base_ref: p.base_ref_name,
            author: p.author.into_author(),
            created_at: p.created_at,
            additions: p.additions,
            deletions: p.deletions,
            changed_files: p.changed_files,
            is_draft: p.is_draft,
            url: p.url,
            mergeable: p.mergeable.into(),
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
        state: p.state.into(),
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
        mergeable: p.mergeable.into(),
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
                state: r.state.into(),
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
            state: c.status(),
        })
        .collect())
}
