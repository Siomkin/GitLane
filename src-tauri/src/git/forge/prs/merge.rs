use super::super::cli::{repo_selector, run_gh};
use super::super::domain::GithubRepository;
use super::super::dto::*;
use super::target_repository;
use crate::git::types::PullRequestMergeOutcome;

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

#[cfg(test)]
mod tests {
    use super::super::TARGET;
    use super::*;

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
}
