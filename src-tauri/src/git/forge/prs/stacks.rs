//! Stacked pull requests: per-PR stack, repo-wide list, link, atomic merge.

use super::super::cli::run_gh;
use super::super::domain::GithubRepository;
use super::super::dto::*;
use super::{gh_api_args, graphql_args};
use crate::git::types::{PrStack, PrStackMembership};

// The stack a PR belongs to. `gh pr view --json stack` is rejected by gh's
// projection allowlist, so this is GraphQL-only. Deliberately unpaginated: a
// stack is a review unit a human reads top to bottom, and `size` comes back
// alongside `entries` so a stack past the cap is *detectable* by the caller
// rather than silently short.
//
// Readiness comes from the head commit's `statusCheckRollup`, which is what
// GitHub's own stack card renders Ready/Not-ready from. Deliberately NOT
// `mergeStateStatus`: that answers BLOCKED for anything the base's ruleset
// still wants — an approving review, say — and GitHub's stack UI does not gate
// on those. Observed directly: four layers with every check green all reported
// `mergeStateStatus: BLOCKED` (unapproved) while GitHub showed each one Ready
// and offered the stack merge. Rules are enforced when the merge runs and the
// failure is reported back, which `merge_stack` already surfaces verbatim.
//
// `statusCheckRollup` is the expensive field the PR *list* deliberately skips,
// but a stack is a handful of layers, not the whole repo, so one rollup per
// entry is affordable here.
const PR_STACK_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){stackEntry{position stack{number size baseRefName entries(first:50){nodes{position pullRequest{number title state isDraft headRefName mergeable commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}}}}}";

/// Poll budget for the asynchronous stack merge: 40 attempts, 1.5s apart, so
/// roughly 60s of *waiting*. This bounds the number of polls, not wall-clock:
/// `run_gh` has no subprocess deadline, so a hung `gh` still holds the worker —
/// a property shared by every `gh` call here, not specific to this one. Giving
/// up costs nothing, since GitHub keeps the result readable for 24h.
const STACK_MERGE_POLL_ATTEMPTS: usize = 40;
const STACK_MERGE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(1500);
/// Consecutive status reads that may fail before GitLane stops guessing. A blip
/// mid-merge is ordinary; a sustained inability to read the status is not, and
/// the merge is already running by then.
const STACK_MERGE_MAX_READ_FAILURES: usize = 3;

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

/// Every stack in the repo, flattened to one membership per pull request.
///
/// This exists because the PR **list** needs a stack badge on every row, and the
/// per-PR GraphQL read only covers a PR whose detail is open. The repo-wide REST
/// endpoint answers the whole list in one call instead of one query per row.
pub fn list_stacks(
    workdir: &str,
    repository: &GithubRepository,
    token: Option<&str>,
) -> Result<Vec<PrStackMembership>, String> {
    let path = format!("repos/{}/{}/stacks", repository.owner, repository.name);
    let args = gh_api_args(&repository.host, &path);
    let raw = run_gh(workdir, &args, token)?;
    let stacks: Vec<GhStackListItem> = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse repository stacks: {e}"))?;
    Ok(stacks
        .into_iter()
        .flat_map(GhStackListItem::into_memberships)
        .collect())
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
    // A non-2xx PUT is normally a hard failure — but GitHub answers 409 when a
    // merge for this PR is *already enqueued*, and that body carries the
    // in-flight uuid. Attaching to it is the only way a retry (after a timeout,
    // or from a second client) can observe the running merge instead of
    // reporting a failure for work that is actually still going.
    let started = match run_gh(workdir, &args, token) {
        Ok(raw) => serde_json::from_str::<GhMergeAsync>(&raw)
            .map_err(|e| format!("failed to parse stack merge response: {e}"))?,
        Err(err) => match existing_merge_async(&err) {
            Some(existing) => existing,
            None => return Err(err),
        },
    };
    // A stack already merged (or already queued) answers the PUT directly with a
    // terminal status and no uuid to poll.
    if let Some(outcome) = merge_async_outcome(&started) {
        return outcome;
    }
    let uuid = started
        .details
        .as_ref()
        .and_then(|d| d.uuid.clone())
        .ok_or_else(|| indeterminate_merge("GitHub returned no id to track it"))?;
    let poll_path = format!("{path}/{uuid}");
    let poll_args = gh_api_args(&repository.host, &poll_path);
    // Past this point the merge has been ACCEPTED and is irreversible. A failure
    // to *read* its status is not a failure to merge, so a transient error must
    // never surface as one — that reads as "nothing happened" and invites a
    // retry that could submit a second operation.
    let mut consecutive_read_failures = 0usize;
    for attempt in 0..STACK_MERGE_POLL_ATTEMPTS {
        // Poll before sleeping: a fast merge is already done, and waiting first
        // just adds latency to the common case.
        if attempt > 0 {
            std::thread::sleep(STACK_MERGE_POLL_INTERVAL);
        }
        let polled = run_gh(workdir, &poll_args, token)
            .map_err(|e| e.to_string())
            .and_then(|raw| serde_json::from_str::<GhMergeAsync>(&raw).map_err(|e| e.to_string()));
        match polled {
            Ok(response) => {
                consecutive_read_failures = 0;
                if let Some(outcome) = merge_async_outcome(&response) {
                    return outcome;
                }
            }
            Err(err) => {
                consecutive_read_failures += 1;
                if consecutive_read_failures > STACK_MERGE_MAX_READ_FAILURES {
                    return Err(indeterminate_merge(&format!(
                        "its status could not be read ({err})"
                    )));
                }
            }
        }
    }
    Err(indeterminate_merge("it is still running"))
}

/// The one honest answer once the merge has been accepted but its outcome is
/// unknown: do **not** imply either result, and steer the user away from a retry
/// that could stack a second irreversible operation on top of a live one.
fn indeterminate_merge(because: &str) -> String {
    format!(
        "GitLane could not confirm the stack merge because {because}. \
         The merge may still be running on GitHub — check the pull requests there \
         before retrying, rather than merging again."
    )
}

/// Recover an in-flight merge from a failed PUT (GitHub's 409). `run_gh` returns
/// stdout+stderr concatenated on a non-zero exit, so the JSON body is in there
/// with CLI noise around it — take the first `{` onward and require a usable
/// uuid, so unrelated failures still surface as errors.
fn existing_merge_async(error: &str) -> Option<GhMergeAsync> {
    let body = &error[error.find('{')?..];
    let parsed: GhMergeAsync = serde_json::from_str(body.trim_end()).ok()?;
    let has_uuid = parsed
        .details
        .as_ref()
        .and_then(|d| d.uuid.as_deref())
        .is_some_and(|uuid| !uuid.trim().is_empty());
    has_uuid.then_some(parsed)
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
/// to a plain merge, matching `merge_pr_args`.
fn merge_async_method(method: &str) -> &str {
    if matches!(method, "squash" | "rebase") {
        method
    } else {
        "merge"
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

/// Link existing pull requests into a GitHub stack, bottom-first.
///
/// GitHub's public GraphQL exposes `PullRequest.stack` for *reading* but has no
/// mutation that creates one — `CreatePullRequestInput` carries no stack field,
/// and none of the schema's mutations mention stacks. Targeting the layer below
/// with `--base` produces the right branch chain and nothing more: the pull
/// requests stay unlinked and GitHub renders no stack.
///
/// The `gh stack` extension's `link` subcommand is the supported way to make
/// that link — it exists precisely for branches managed by other tools ("does
/// not rely on gh-stack local tracking state"). It is an extension rather than
/// core `gh`, so it may not be installed; [`stack_link_unavailable`] classifies
/// that case so the caller can say the pull request opened but the link did not.
///
/// Numbers, not branch names: `gh stack link` will *push* a branch argument and
/// open a pull request for it if none exists. Every layer here already has one,
/// and silently creating another is not something a link step should do.
///
/// `gh stack link` takes no `--repo`, so it acts on the repository at `workdir`
/// — which is the one the caller means, since that is where the pull request
/// was just created.
pub fn link_stack(workdir: &str, numbers: &[u64], token: Option<&str>) -> Result<String, String> {
    if numbers.len() < 2 {
        return Err("A stack needs at least two pull requests.".to_string());
    }
    let rendered: Vec<String> = numbers.iter().map(|n| n.to_string()).collect();
    let mut args = vec!["stack", "link"];
    args.extend(rendered.iter().map(String::as_str));
    run_gh(workdir, &args, token).map_err(|error| {
        if is_missing_extension(&error) {
            STACK_EXTENSION_MISSING.to_string()
        } else {
            error
        }
    })
}

/// Shown when `gh stack` isn't installed. Names the exact install command,
/// because "not supported" would be wrong — it is one command away.
const STACK_EXTENSION_MISSING: &str =
    "The pull request was created, but linking the stack needs GitHub's stack extension. \
     Install it with `gh extension install github/gh-stack`, then link the stack from GitHub.";

/// `gh` answers a missing extension with `unknown command "stack" for "gh"`,
/// which is the only signal separating "not installed" from a real failure.
fn is_missing_extension(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("unknown command") && lower.contains("for \"gh\"")
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn attaches_to_an_already_enqueued_merge_from_a_failed_put() {
        // GitHub answers 409 when a merge for this PR is already running, and the
        // body carries its uuid. `run_gh` hands us stdout+stderr with CLI noise
        // around the JSON, so the parse has to find the body.
        let err = "gh: Conflict (HTTP 409)\n{\"status\":\"pending\",\"details\":{\"uuid\":\"u-42\",\"message\":\"already enqueued\"}}\n";
        let recovered = existing_merge_async(err).expect("attaches to the in-flight merge");
        assert_eq!(recovered.status, "pending");
        assert_eq!(recovered.details.unwrap().uuid.unwrap(), "u-42");
    }

    #[test]
    fn an_unrelated_failure_is_not_mistaken_for_a_running_merge() {
        // Without a usable uuid there is nothing to attach to, so these must stay
        // hard errors rather than silently entering a poll loop.
        assert!(existing_merge_async("gh: Not Found (HTTP 404)").is_none());
        assert!(existing_merge_async("gh: error {not json at all").is_none());
        assert!(existing_merge_async(
            r#"gh: Conflict {"status":"pending","details":{"uuid":"  "}}"#
        )
        .is_none());
        assert!(existing_merge_async(r#"gh: Conflict {"status":"pending"}"#).is_none());
    }

    #[test]
    fn an_unreadable_outcome_never_reads_as_a_failed_merge() {
        // The message must not imply either result, and must steer away from a
        // retry — the merge is irreversible and may still be running.
        let message = indeterminate_merge("its status could not be read (boom)");
        assert!(message.contains("could not confirm"));
        assert!(message.contains("may still be running"));
        assert!(message.contains("before retrying"));
        // Never the words that would assert an outcome either way.
        assert!(!message.contains("merged successfully"));
        assert!(!message.contains("Nothing was merged"));
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
