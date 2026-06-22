//! Inline review-thread GraphQL operations (resolve / unresolve).
//!
//! `gh`'s `pr` verbs surface neither file/line-anchored review threads nor their
//! resolved state, so these go through `gh api graphql` (still account-pinned
//! via `GH_TOKEN`). The query/mutation text and execution live here; transport
//! goes through [`super::cli`] and response shapes through [`super::dto`].

use super::cli::{repo_slug, run_gh};
use super::dto::{GqlThread, GqlThreadsResp};
use crate::git::types::ReviewThread;

const REVIEW_THREADS_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:50){nodes{author{login} body createdAt}}}}}}}";
const RESOLVE_THREAD_MUTATION: &str =
    "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}";
const UNRESOLVE_THREAD_MUTATION: &str =
    "mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}";

/// Inline review threads for a PR (file/line-anchored comments + resolve state).
pub fn review_threads(
    workdir: &str,
    number: u64,
    token: Option<&str>,
) -> Result<Vec<ReviewThread>, String> {
    let (owner, name) = repo_slug(workdir, token)?;
    let query_field = format!("query={REVIEW_THREADS_QUERY}");
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
    let parsed: GqlThreadsResp =
        serde_json::from_str(&raw).map_err(|e| format!("failed to parse review threads: {e}"))?;
    Ok(parsed
        .data
        .repository
        .pull_request
        .review_threads
        .nodes
        .into_iter()
        .map(GqlThread::into_thread)
        .collect())
}

/// Resolve (or, when `resolved` is false, unresolve) a review thread by its
/// GraphQL node id.
pub fn set_thread_resolved(
    workdir: &str,
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
    run_gh(
        workdir,
        &["api", "graphql", "-f", &query_field, "-f", &id_field],
        token,
    )
}
