//! The full, verified, cursor-paginated PR commit list (GraphQL).

use super::super::cli::run_gh;
use super::super::domain::GithubRepository;
use super::super::dto::*;
use super::super::pagination::{collect_cursor_pages, CursorPage};
use super::graphql_args;
use crate::git::types::PrCommitList;

// `gh pr view --json commits` caps its commit projection and carries no
// signature data, so the authoritative commit list — full metadata plus
// per-commit verification — is read via GraphQL with cursor pagination (mirrors
// the review-threads query in `threads.rs`). A PR past the projection cap keeps
// every commit and its verified badge instead of silently losing the tail.
const PR_COMMITS_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{commit{oid messageHeadline authoredDate signature{isValid} author{name user{login}}}}}}}}";

/// Hard stop for cursor pagination (100 commits per page). At 100 pages this is
/// far beyond any real PR; it guards against a looping `pageInfo`.
const MAX_COMMIT_PAGES: usize = 100;

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
        crate::log::warn!(
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
