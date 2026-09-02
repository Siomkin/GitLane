//! Inline review-thread GraphQL operations (reply / resolve / unresolve).
//!
//! `gh`'s `pr` verbs surface neither file/line-anchored review threads nor their
//! resolved state, so these go through `gh api graphql` (still account-pinned
//! via `GH_TOKEN`). The query/mutation text and execution live here; transport
//! goes through [`super::cli`] and response shapes through [`super::dto`].
//!
//! Every call passes `--hostname` explicitly: `gh api` otherwise targets gh's
//! default host (github.com for anyone logged into more than one host), which
//! would send a GitHub Enterprise repo's token to the wrong endpoint and 401.

use super::cli::run_gh;
use super::domain::GithubRepository;
use super::dto::{GqlThread, GqlThreadsResp};
use super::pagination::{collect_cursor_pages, CursorPage};
use crate::git::types::ReviewThreadList;

// Threads are paginated by cursor so a review-heavy PR never silently loses
// threads past the first page. Comments stay capped per thread (nested
// pagination would multiply round-trips); `totalCount` flags the rare thread
// that exceeds the cap so the UI can say so instead of presenting the list as
// complete.
const REVIEW_THREADS_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line comments(first:50){totalCount nodes{author{login} body createdAt diffHunk}}}}}}}";

/// Hard stop for cursor pagination (100 items per page). Far beyond any real
/// PR; guards against a pathological/looping `pageInfo` from the API.
const MAX_GRAPHQL_PAGES: usize = 20;
const RESOLVE_THREAD_MUTATION: &str =
    "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}";
const UNRESOLVE_THREAD_MUTATION: &str =
    "mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}";

/// Inline review threads for a PR (file/line-anchored comments + resolve state).
pub fn review_threads(
    workdir: &str,
    repository: &GithubRepository,
    number: u64,
    token: Option<&str>,
) -> Result<ReviewThreadList, String> {
    let query_field = format!("query={REVIEW_THREADS_QUERY}");
    let owner_field = format!("owner={}", repository.owner);
    let name_field = format!("name={}", repository.name);
    let number_field = format!("number={number}");
    let result = collect_cursor_pages(MAX_GRAPHQL_PAGES, |cursor| {
        let mut args = review_threads_args(
            &repository.host,
            &query_field,
            &owner_field,
            &name_field,
            &number_field,
        );
        // Omitted on the first page so the `$cursor` variable stays null —
        // `-f cursor=` would send an empty string, which GitHub rejects.
        let cursor_field = cursor.map(|c| format!("cursor={c}"));
        if let Some(f) = cursor_field.as_deref() {
            args.push("-f");
            args.push(f);
        }
        let raw = run_gh(workdir, &args, token)?;
        let parsed: GqlThreadsResp = serde_json::from_str(&raw)
            .map_err(|e| format!("failed to parse review threads: {e}"))?;
        let connection = parsed.data.repository.pull_request.review_threads;
        let has_more = connection
            .page_info
            .as_ref()
            .is_some_and(|page| page.has_next_page);
        let end_cursor = connection.page_info.and_then(|page| page.end_cursor);
        Ok::<_, String>(CursorPage {
            items: connection
                .nodes
                .into_iter()
                .map(GqlThread::into_thread)
                .collect(),
            has_more,
            end_cursor,
        })
    })?;
    // The page cap is a runaway-loop guard set far beyond any real PR, but if it
    // ever bounds a genuinely huge thread set, don't drop the tail silently —
    // leave a breadcrumb (the reachable count is still returned).
    if result.truncated {
        eprintln!(
            "gitlane: review threads for PR #{number} hit the {MAX_GRAPHQL_PAGES}-page cap; \
             {} fetched, later threads omitted",
            result.items.len()
        );
    }
    Ok(ReviewThreadList {
        threads: result.items,
        truncated: result.truncated,
    })
}

/// Resolve (or, when `resolved` is false, unresolve) a review thread by its
/// GraphQL node id.
pub fn set_thread_resolved(
    workdir: &str,
    repository: &GithubRepository,
    thread_id: &str,
    resolved: bool,
    token: Option<&str>,
) -> Result<String, String> {
    let mutation = if resolved {
        RESOLVE_THREAD_MUTATION
    } else {
        UNRESOLVE_THREAD_MUTATION
    };
    let query_field = format!("query={mutation}");
    let id_field = format!("id={thread_id}");
    let args = thread_mutation_args(&repository.host, &query_field, &id_field);
    run_gh(workdir, &args, token)
}

fn review_threads_args<'a>(
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

fn thread_mutation_args<'a>(
    host: &'a str,
    query_field: &'a str,
    id_field: &'a str,
) -> Vec<&'a str> {
    vec![
        "api",
        "--hostname",
        host,
        "graphql",
        "-f",
        query_field,
        "-f",
        id_field,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_threads_query_requests_comment_diff_hunk() {
        assert!(REVIEW_THREADS_QUERY.contains("diffHunk"));
    }

    #[test]
    fn thread_query_args_use_validated_authority_and_slug() {
        assert_eq!(
            review_threads_args(
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

    #[test]
    fn thread_mutations_use_validated_authority() {
        assert_eq!(
            thread_mutation_args("ghe.example.test:8443", "query=m", "id=T1"),
            vec![
                "api",
                "--hostname",
                "ghe.example.test:8443",
                "graphql",
                "-f",
                "query=m",
                "-f",
                "id=T1",
            ]
        );
    }
}
