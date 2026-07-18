//! The Bitbucket Cloud pull-request operations (GL-141), written once against the
//! [`BitbucketApi`] transport.
//!
//! Each function builds a Bitbucket REST 2.0 path, runs it through the transport,
//! and maps the JSON into the shared PR DTOs via [`super::dto`]. Unlike GitLab,
//! Bitbucket's `/diff` endpoint returns a ready-made git patch, so [`pr_diff`]
//! feeds it straight to the GitHub provider's battle-tested unified-diff parser —
//! no per-file reconstruction. Only the five basic actions in scope are
//! implemented; everything else returns an explicit "not supported yet".

use serde_json::json;

use super::super::diff::parse_unified_diff;
use super::super::domain::GithubError;
use super::dto::{BitbucketCommit, BitbucketPage, BitbucketPr};
use super::transport::BitbucketApi;
use crate::git::types::{FileDiff, PrCommit, PullRequestDetail, PullRequestSummary};

/// Bitbucket Cloud caps `pagelen` at 50; use the max and a hard page cap as a
/// runaway guard (50 × 40 pages = 2000 items, far beyond any real PR).
const PER_PAGE: usize = 50;
const MAX_PAGES: usize = 40;

/// List pull requests (most recent 50, newest first) for the repo. All states are
/// requested explicitly (`state` repeated) so the list is state-complete —
/// matching `gh pr list --state all` — regardless of the endpoint's OPEN default.
pub fn list_prs(
    api: &dyn BitbucketApi,
    repo: &str,
) -> Result<Vec<PullRequestSummary>, GithubError> {
    let path = format!(
        "{repo}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&pagelen={PER_PAGE}&sort=-created_on"
    );
    let raw = api.get("list pull requests", &path)?;
    let page: BitbucketPage<BitbucketPr> = parse(&raw, "pull request list")?;
    Ok(page.values.into_iter().map(BitbucketPr::into_summary).collect())
}

/// Fetch one pull request's detail plus its changed-file list and diff stats.
pub fn pr_detail(
    api: &dyn BitbucketApi,
    repo: &str,
    number: u64,
) -> Result<PullRequestDetail, GithubError> {
    let path = format!("{repo}/pullrequests/{number}");
    let raw = api.get("pull request detail", &path)?;
    let pr: BitbucketPr = parse(&raw, "pull request detail")?;

    // The PR object carries no diff stats, so derive the file list and aggregate
    // additions/deletions from the parsed `/diff` (one read).
    let diffs = pr_diff(api, repo, number)?;
    let files: Vec<String> = diffs.iter().map(|d| d.path.clone()).collect();
    let additions: u64 = diffs.iter().map(|d| d.add as u64).sum();
    let deletions: u64 = diffs.iter().map(|d| d.del as u64).sum();

    Ok(pr.into_detail(files, additions, deletions, Vec::new()))
}

/// Full diff of a pull request, parsed into per-file [`FileDiff`] so the shared
/// diff viewer renders it unchanged. Bitbucket's `/diff` returns a complete git
/// patch, so it goes straight to [`parse_unified_diff`].
pub fn pr_diff(
    api: &dyn BitbucketApi,
    repo: &str,
    number: u64,
) -> Result<Vec<FileDiff>, GithubError> {
    let path = format!("{repo}/pullrequests/{number}/diff");
    // The `/diff` endpoint returns a raw git patch, not JSON — request text/plain
    // so Bitbucket does not answer 406 (see `BitbucketApi::get_text`).
    let patch = api.get_text("pull request diff", &path)?;
    Ok(parse_unified_diff(&patch))
}

/// The pull request's commit list (`/commits`), paginated so a large PR keeps
/// every commit (parity with the gh provider's full commit read).
pub fn pr_commits(
    api: &dyn BitbucketApi,
    repo: &str,
    number: u64,
) -> Result<Vec<PrCommit>, GithubError> {
    let mut commits: Vec<PrCommit> = Vec::new();
    let mut hit_cap = false;
    for page in 1..=MAX_PAGES {
        let path = format!("{repo}/pullrequests/{number}/commits?pagelen={PER_PAGE}&page={page}");
        let raw = api.get("pull request commits", &path)?;
        let batch: BitbucketPage<BitbucketCommit> = parse(&raw, "pull request commits")?;
        let full_page = batch.values.len() == PER_PAGE;
        commits.extend(batch.values.into_iter().map(BitbucketCommit::into_commit));
        if !full_page {
            break;
        }
        hit_cap = page == MAX_PAGES;
    }
    if hit_cap {
        eprintln!(
            "gitlane: Bitbucket PR #{number} commits hit the {MAX_PAGES}-page cap; {} fetched, later commits omitted",
            commits.len()
        );
    }
    Ok(commits)
}

/// Open a new pull request from `head` into `base`. Returns the new PR's web URL.
pub fn create_pr(
    api: &dyn BitbucketApi,
    repo: &str,
    base: &str,
    head: &str,
    title: &str,
    body: &str,
    draft: bool,
) -> Result<String, GithubError> {
    if title.trim().is_empty() {
        return Err(GithubError::CommandFailed(
            "A title is required to open a pull request.".to_string(),
        ));
    }
    let payload = json!({
        "title": title,
        "source": { "branch": { "name": head } },
        "destination": { "branch": { "name": base } },
        "description": body,
        "draft": draft,
    });
    let path = format!("{repo}/pullrequests");
    let raw = api.post_json("create pull request", &path, &payload.to_string())?;
    let pr: BitbucketPr = parse(&raw, "created pull request")?;
    let summary = pr.into_summary();
    Ok(if summary.url.is_empty() {
        format!("Opened pull request #{}", summary.number)
    } else {
        summary.url
    })
}

/// Merge a pull request. `method` maps to Bitbucket's merge strategy: "merge" →
/// `merge_commit`, "squash" → `squash`. Bitbucket's third strategy is
/// `fast_forward`, not a rebase-merge, so "rebase" is refused explicitly (parity
/// with the GitLab provider). `delete_branch` removes the source branch.
pub fn merge_pr(
    api: &dyn BitbucketApi,
    repo: &str,
    number: u64,
    method: &str,
    delete_branch: bool,
) -> Result<String, GithubError> {
    let strategy = match method {
        "squash" => "squash",
        "merge" | "" => "merge_commit",
        "rebase" => {
            return Err(unsupported(
                "Rebase-and-merge isn't supported for Bitbucket pull requests. Use Merge or Squash.",
            ))
        }
        other => {
            return Err(GithubError::CommandFailed(format!(
                "Unknown merge method '{other}' for Bitbucket."
            )))
        }
    };
    let payload = json!({
        "merge_strategy": strategy,
        "close_source_branch": delete_branch,
    });
    let path = format!("{repo}/pullrequests/{number}/merge");
    let raw = api.post_json("merge pull request", &path, &payload.to_string())?;
    // The merge response is the updated PR object; surface its URL when present.
    let url = parse::<BitbucketPr>(&raw, "merged pull request")
        .ok()
        .map(|pr| pr.into_summary().url)
        .filter(|u| !u.is_empty());
    Ok(url.unwrap_or_else(|| format!("Merged #{number}")))
}

/// Approve a pull request. Only `approve` is in scope; request-changes / comment
/// have no basic-API equivalent and return an explicit unsupported error.
pub fn review_pr(
    api: &dyn BitbucketApi,
    repo: &str,
    number: u64,
    action: &str,
) -> Result<String, GithubError> {
    if action != "approve" {
        return Err(unsupported(
            "Only approving a Bitbucket pull request is supported in GitLane.",
        ));
    }
    let path = format!("{repo}/pullrequests/{number}/approve");
    // The approve endpoint takes no body; send an empty JSON object.
    api.post_json("approve pull request", &path, "{}")?;
    Ok(format!("Approved #{number}"))
}

/// A "not supported yet" error for the out-of-scope PR paths (comments, review
/// threads, close/reopen), surfaced verbatim to the UI.
pub fn unsupported(message: &str) -> GithubError {
    GithubError::CommandFailed(message.to_string())
}

/// The repo base path for a Bitbucket REST URL: `repositories/{workspace}/{slug}`
/// with each segment percent-encoded. Workspace/slug are normally URL-safe, but
/// encoding defends against an unexpected character breaking the path.
pub fn repo_path(workspace: &str, slug: &str) -> String {
    if workspace.is_empty() {
        format!("repositories/{}", percent_encode(slug))
    } else {
        format!(
            "repositories/{}/{}",
            percent_encode(workspace),
            percent_encode(slug)
        )
    }
}

/// Parse a JSON body into `T`, mapping a failure to an `InvalidResponse` category
/// with the operation label (never echoing the raw body, which could be large).
fn parse<T: serde::de::DeserializeOwned>(raw: &str, what: &str) -> Result<T, GithubError> {
    serde_json::from_str(raw)
        .map_err(|e| GithubError::InvalidResponse(format!("failed to parse {what}: {e}")))
}

/// Percent-encode everything outside the RFC 3986 unreserved set.
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::transport::RestClient;
    use super::*;
    use crate::git::oauth::http::testing::MockTransport;
    use crate::git::oauth::http::HttpResult;

    fn ok(body: &str) -> HttpResult {
        MockTransport::ok(200, body)
    }

    const REPO: &str = "repositories/team/app";

    #[test]
    fn repo_path_encodes_segments() {
        assert_eq!(repo_path("team", "app"), "repositories/team/app");
        assert_eq!(repo_path("my team", "app"), "repositories/my%20team/app");
    }

    #[test]
    fn list_prs_requests_all_states_newest_first() {
        let http = MockTransport::new(vec![ok(
            r#"{"values":[{"id":3,"title":"A","state":"MERGED","source":{"branch":{"name":"f"}},
                "destination":{"branch":{"name":"main"}},"author":{"nickname":"ada"},
                "created_on":"t","links":{"html":{"href":"https://bitbucket.org/team/app/pull-requests/3"}}}]}"#,
        )]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");
        let prs = list_prs(&client, REPO).expect("list");
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 3);
        assert_eq!(prs[0].state, "MERGED");
        let reqs = http.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "GET");
        assert!(reqs[0].url.contains("/2.0/repositories/team/app/pullrequests?state=OPEN"));
        assert!(reqs[0].url.contains("state=DECLINED"));
        assert!(reqs[0].url.contains("sort=-created_on"));
    }

    #[test]
    fn pr_detail_combines_pr_and_diff_stats() {
        let pr = r#"{"id":5,"title":"T","state":"OPEN","source":{"branch":{"name":"s"}},
            "destination":{"branch":{"name":"main"}},"author":{"nickname":"u"},
            "summary":{"raw":"Body"}}"#;
        // A full git patch: one modified file (+1/-1) and one new file (+1).
        let patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n\
                     diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+hello\n";
        let http = MockTransport::new(vec![ok(pr), ok(patch)]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");
        let detail = pr_detail(&client, REPO, 5).expect("detail");
        assert_eq!(detail.number, 5);
        assert_eq!(detail.body, "Body");
        assert_eq!(detail.files, vec!["a.txt".to_string(), "b.txt".to_string()]);
        assert_eq!(detail.changed_files, 2);
        assert_eq!(detail.additions, 2, "+new and +hello");
        assert_eq!(detail.deletions, 1, "-old");
    }

    #[test]
    fn pr_diff_parses_the_git_patch_directly() {
        let patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
        let http = MockTransport::new(vec![ok(patch)]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");
        let files = pr_diff(&client, REPO, 5).expect("diff");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].status, "M");
        let reqs = http.requests.lock().unwrap();
        assert!(reqs[0].url.ends_with("/pullrequests/5/diff"));
        // The diff GET must ask for text, not JSON — Bitbucket answers 406 to
        // `Accept: application/json` on `/diff` (GL-141).
        let accept = reqs[0]
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("accept"))
            .map(|(_, v)| v.as_str());
        assert_eq!(accept, Some("text/plain"));
    }

    #[test]
    fn pr_diff_keeps_files_after_the_shared_json_response_limit() {
        let long_line = "a".repeat(crate::git::oauth::http::DEFAULT_RESPONSE_LIMIT + 1);
        let patch = format!(
            "diff --git a/large.txt b/large.txt\nnew file mode 100644\n--- /dev/null\n+++ b/large.txt\n@@ -0,0 +1 @@\n+{long_line}\n\
             diff --git a/tail.txt b/tail.txt\nnew file mode 100644\n--- /dev/null\n+++ b/tail.txt\n@@ -0,0 +1 @@\n+tail\n"
        );
        let http = MockTransport::new(vec![ok(&patch)]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");

        let files = pr_diff(&client, REPO, 6).expect("large diff");

        assert_eq!(
            files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["large.txt", "tail.txt"]
        );
    }

    #[test]
    fn create_pr_posts_json_and_returns_web_url() {
        let http = MockTransport::new(vec![ok(
            r#"{"id":10,"title":"New","state":"OPEN","source":{"branch":{"name":"feat"}},
                "destination":{"branch":{"name":"main"}},"author":{"nickname":"u"},"created_on":"t",
                "links":{"html":{"href":"https://bitbucket.org/team/app/pull-requests/10"}}}"#,
        )]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");
        let url = create_pr(&client, REPO, "main", "feat", "New", "desc", true).expect("create");
        assert_eq!(url, "https://bitbucket.org/team/app/pull-requests/10");
        let reqs = http.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "POST");
        assert!(reqs[0].url.ends_with("/pullrequests"));
        let body = reqs[0].body.as_deref().expect("json body");
        let sent: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(sent["title"], "New");
        assert_eq!(sent["source"]["branch"]["name"], "feat");
        assert_eq!(sent["destination"]["branch"]["name"], "main");
        assert_eq!(sent["draft"], true);
    }

    #[test]
    fn create_pr_rejects_empty_title_before_calling() {
        let http = MockTransport::new(vec![]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");
        assert!(create_pr(&client, REPO, "main", "feat", "  ", "", false).is_err());
        assert_eq!(http.request_count(), 0, "no request on a rejected title");
    }

    #[test]
    fn merge_pr_rejects_rebase_before_calling() {
        let http = MockTransport::new(vec![]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");
        assert!(merge_pr(&client, REPO, 7, "rebase", false).is_err());
        assert_eq!(http.request_count(), 0, "no request on an unsupported method");
    }

    #[test]
    fn merge_pr_posts_strategy_and_close_branch() {
        let http = MockTransport::new(vec![ok(
            r#"{"id":7,"title":"T","state":"MERGED","source":{"branch":{"name":"s"}},
                "destination":{"branch":{"name":"main"}},"author":{"nickname":"u"},"created_on":"t",
                "links":{"html":{"href":"https://bitbucket.org/team/app/pull-requests/7"}}}"#,
        )]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");
        let out = merge_pr(&client, REPO, 7, "squash", true).expect("merge");
        assert!(out.contains("pull-requests/7"));
        let reqs = http.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "POST");
        assert!(reqs[0].url.ends_with("/pullrequests/7/merge"));
        let sent: serde_json::Value =
            serde_json::from_str(reqs[0].body.as_deref().unwrap()).unwrap();
        assert_eq!(sent["merge_strategy"], "squash");
        assert_eq!(sent["close_source_branch"], true);
    }

    #[test]
    fn review_pr_approves_and_rejects_other_actions() {
        let http = MockTransport::new(vec![ok(r#"{"approved":true}"#)]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");
        let out = review_pr(&client, REPO, 9, "approve").expect("approve");
        assert!(out.contains("Approved #9"));
        {
            let reqs = http.requests.lock().unwrap();
            assert_eq!(reqs[0].method, "POST");
            assert!(reqs[0].url.ends_with("/pullrequests/9/approve"));
        }
        let http2 = MockTransport::new(vec![]);
        let client2 = RestClient::new(&http2, "bitbucket.org", "x-token-auth", "tok");
        assert!(review_pr(&client2, REPO, 9, "request-changes").is_err());
        assert_eq!(http2.request_count(), 0);
    }

    #[test]
    fn pr_commits_maps_the_commit_list() {
        let http = MockTransport::new(vec![ok(
            r#"{"values":[{"hash":"deadbeef","message":"Fix\n\nbody","date":"2026-01-01",
                "author":{"raw":"Ada <a@x.io>","user":{"display_name":"Ada L.","nickname":"ada"}}}]}"#,
        )]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");
        let commits = pr_commits(&client, REPO, 2).expect("commits");
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].oid, "deadbeef");
        assert_eq!(commits[0].headline, "Fix");
        assert_eq!(commits[0].author_login, "ada");
        assert!(!commits[0].verified);
    }
}
