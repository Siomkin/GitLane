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
use super::dto::{BitbucketCommit, BitbucketDiffStat, BitbucketPage, BitbucketPr};
use super::transport::BitbucketApi;
use crate::git::types::{FileDiff, PrCommit, PrCommitList, PullRequestDetail, PullRequestSummary};

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
    Ok(page
        .values
        .into_iter()
        .map(BitbucketPr::into_summary)
        .collect())
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
    // additions/deletions from the reconciled `/diff` + `/diffstat` reads.
    let diffs = pr_diff(api, repo, number)?;
    let files: Vec<String> = diffs.iter().map(|d| d.path.clone()).collect();
    let additions: u64 = diffs.iter().map(|d| d.add as u64).sum();
    let deletions: u64 = diffs.iter().map(|d| d.del as u64).sum();

    Ok(pr.into_detail(files, additions, deletions, Vec::new()))
}

/// Full diff of a pull request, parsed into per-file [`FileDiff`] so the shared
/// diff viewer renders it unchanged. The paginated `/diffstat` is reconciled
/// with the raw patch because Bitbucket can elide patch bodies at its own
/// per-file, total-line, and file-count limits below our transport byte cap.
pub fn pr_diff(
    api: &dyn BitbucketApi,
    repo: &str,
    number: u64,
) -> Result<Vec<FileDiff>, GithubError> {
    let path = format!("{repo}/pullrequests/{number}/diff");
    // The `/diff` endpoint returns a raw git patch, not JSON — request text/plain
    // so Bitbucket does not answer 406 (see `BitbucketApi::get_text`).
    let patch = api.get_text("pull request diff", &path)?;
    let mut files = parse_unified_diff(&patch);
    let stats = diff_stats(api, repo, number)?;
    for stat in stats.values {
        let path = stat.path();
        if path.is_empty() {
            continue;
        }
        if let Some(file) = files.iter_mut().find(|file| file.path == path) {
            if let Some(add) = stat
                .lines_added
                .map(|count| usize::try_from(count).unwrap_or(usize::MAX))
            {
                if file.add != add {
                    file.truncated = true;
                }
                file.add = file.add.max(add);
            }
            if let Some(del) = stat
                .lines_removed
                .map(|count| usize::try_from(count).unwrap_or(usize::MAX))
            {
                if file.del != del {
                    file.truncated = true;
                }
                file.del = file.del.max(del);
            }
        } else {
            files.push(FileDiff {
                path: path.to_string(),
                status: stat.file_status().to_string(),
                add: stat
                    .lines_added
                    .map(|count| usize::try_from(count).unwrap_or(usize::MAX))
                    .unwrap_or(0),
                del: stat
                    .lines_removed
                    .map(|count| usize::try_from(count).unwrap_or(usize::MAX))
                    .unwrap_or(0),
                truncated: true,
                ..Default::default()
            });
        }
    }
    if stats.capped {
        eprintln!(
            "gitlane: Bitbucket PR #{number} diff stats hit the {MAX_PAGES}-page cap; the bounded diff is marked incomplete"
        );
        for file in &mut files {
            file.truncated = true;
        }
    }
    Ok(files)
}

struct DiffStatsResult {
    values: Vec<BitbucketDiffStat>,
    capped: bool,
}

fn diff_stats(
    api: &dyn BitbucketApi,
    repo: &str,
    number: u64,
) -> Result<DiffStatsResult, GithubError> {
    let mut stats = Vec::new();
    let resource = format!("{repo}/pullrequests/{number}/diffstat");
    let mut path = format!(
        "{resource}?pagelen={PER_PAGE}&fields=values.status,values.lines_added,values.lines_removed,values.old.path,values.new.path,next"
    );
    for _ in 0..MAX_PAGES {
        let raw = api.get("pull request diff stats", &path)?;
        let batch: BitbucketPage<BitbucketDiffStat> = parse(&raw, "pull request diff stats")?;
        stats.extend(batch.values);
        match batch.next {
            Some(next) => path = validated_next_path(&next, &resource)?,
            None => {
                return Ok(DiffStatsResult {
                    values: stats,
                    capped: false,
                })
            }
        }
    }
    Ok(DiffStatsResult {
        values: stats,
        capped: true,
    })
}

fn validated_next_path(next: &str, expected_resource: &str) -> Result<String, GithubError> {
    const API_PREFIX: &str = "https://api.bitbucket.org/2.0/";
    let path = next.strip_prefix(API_PREFIX).ok_or_else(|| {
        GithubError::InvalidResponse(
            "Bitbucket pagination returned a continuation outside api.bitbucket.org.".to_string(),
        )
    })?;
    let resource = path.split_once('?').map_or(path, |(resource, _)| resource);
    if resource != expected_resource {
        return Err(GithubError::InvalidResponse(
            "Bitbucket pagination returned a continuation for a different resource.".to_string(),
        ));
    }
    Ok(path.to_string())
}

/// The pull request's commit list (`/commits`), paginated so a large PR keeps
/// every commit (parity with the gh provider's full commit read).
pub fn pr_commits(
    api: &dyn BitbucketApi,
    repo: &str,
    number: u64,
) -> Result<PrCommitList, GithubError> {
    let mut commits: Vec<PrCommit> = Vec::new();
    let resource = format!("{repo}/pullrequests/{number}/commits");
    let mut path = format!("{resource}?pagelen={PER_PAGE}");
    for _ in 0..MAX_PAGES {
        let raw = api.get("pull request commits", &path)?;
        let batch: BitbucketPage<BitbucketCommit> = parse(&raw, "pull request commits")?;
        commits.extend(batch.values.into_iter().map(BitbucketCommit::into_commit));
        match batch.next {
            Some(next) => path = validated_next_path(&next, &resource)?,
            None => {
                return Ok(PrCommitList {
                    commits,
                    truncated: false,
                });
            }
        }
    }
    eprintln!(
        "gitlane: Bitbucket PR #{number} commits hit the {MAX_PAGES}-page cap; {} fetched, later commits omitted",
        commits.len()
    );
    Ok(PrCommitList {
        commits,
        truncated: true,
    })
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
        "rebase" => return Err(unsupported(
            "Rebase-and-merge isn't supported for Bitbucket pull requests. Use Merge or Squash.",
        )),
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
        assert!(reqs[0]
            .url
            .contains("/2.0/repositories/team/app/pullrequests?state=OPEN"));
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
        let stat = r#"{"values":[
            {"status":"modified","lines_added":1,"lines_removed":1,"new":{"path":"a.txt"}},
            {"status":"added","lines_added":1,"lines_removed":0,"new":{"path":"b.txt"}}
        ]}"#;
        let http = MockTransport::new(vec![ok(pr), ok(patch), ok(stat)]);
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
        let patch =
            "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
        let stat = r#"{"values":[{"status":"modified","lines_added":1,"lines_removed":1,"new":{"path":"a.txt"}}]}"#;
        let http = MockTransport::new(vec![ok(patch), ok(stat)]);
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
        assert!(reqs[1].url.contains("/pullrequests/5/diffstat?"));
    }

    #[test]
    fn pr_diff_keeps_files_after_the_shared_json_response_limit() {
        let long_line = "a".repeat(crate::git::oauth::http::DEFAULT_RESPONSE_LIMIT + 1);
        let patch = format!(
            "diff --git a/large.txt b/large.txt\nnew file mode 100644\n--- /dev/null\n+++ b/large.txt\n@@ -0,0 +1 @@\n+{long_line}\n\
             diff --git a/tail.txt b/tail.txt\nnew file mode 100644\n--- /dev/null\n+++ b/tail.txt\n@@ -0,0 +1 @@\n+tail\n"
        );
        let stat = r#"{"values":[
                {"status":"added","lines_added":1,"lines_removed":0,"new":{"path":"large.txt"}},
                {"status":"added","lines_added":1,"lines_removed":0,"new":{"path":"tail.txt"}}
            ]}"#;
        let http = MockTransport::new(vec![ok(&patch), ok(stat)]);
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
    fn pr_diff_marks_elided_and_partial_files_from_diffstat() {
        let patch =
            "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
        let stat = r#"{"values":[
            {"status":"modified","lines_added":4,"lines_removed":3,"new":{"path":"a.txt"}},
            {"status":"added","lines_added":8,"lines_removed":0,"new":{"path":"missing.txt"}}
        ]}"#;
        let http = MockTransport::new(vec![ok(patch), ok(stat)]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");

        let files = pr_diff(&client, REPO, 7).expect("reconciled diff");

        assert_eq!(files.len(), 2);
        assert_eq!((files[0].add, files[0].del), (4, 3));
        assert!(files[0].truncated);
        assert_eq!(files[1].path, "missing.txt");
        assert_eq!((files[1].add, files[1].del), (8, 0));
        assert!(files[1].truncated);
    }

    #[test]
    fn pr_diff_preserves_parsed_counts_when_diffstat_omits_a_side() {
        let patch =
            "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
        let stat = r#"{"values":[
            {"status":"modified","lines_removed":2,"new":{"path":"a.txt"}}
        ]}"#;
        let http = MockTransport::new(vec![ok(patch), ok(stat)]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");

        let files = pr_diff(&client, REPO, 7).expect("partially supplied diffstat");

        assert_eq!((files[0].add, files[0].del), (1, 2));
        assert!(files[0].truncated);
    }

    #[test]
    fn diffstat_follows_an_opaque_next_even_after_a_short_page() {
        let patch = "";
        let first = format!(
            r#"{{"values":[{{"status":"added","lines_added":1,"new":{{"path":"first.txt"}}}}],"next":"https://api.bitbucket.org/2.0/{REPO}/pullrequests/8/diffstat?cursor=opaque%2Btoken"}}"#
        );
        let second =
            r#"{"values":[{"status":"added","lines_added":2,"new":{"path":"second.txt"}}]}"#;
        let http = MockTransport::new(vec![ok(patch), ok(&first), ok(second)]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");

        let files = pr_diff(&client, REPO, 8).expect("cursor pages");

        assert_eq!(
            files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["first.txt", "second.txt"]
        );
        let requests = http.requests.lock().unwrap();
        assert!(requests[1].url.contains("fields="));
        assert!(requests[2].url.ends_with("?cursor=opaque%2Btoken"));
    }

    #[test]
    fn diffstat_rejects_a_next_cursor_outside_the_expected_resource() {
        let patch = "";
        let foreign = r#"{"values":[],"next":"https://example.com/steal"}"#;
        let http = MockTransport::new(vec![ok(patch), ok(foreign)]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");

        assert!(matches!(
            pr_diff(&client, REPO, 9),
            Err(GithubError::InvalidResponse(_))
        ));
        assert_eq!(
            http.request_count(),
            2,
            "foreign cursor was never requested"
        );
    }

    #[test]
    fn diffstat_page_cap_returns_a_bounded_incomplete_diff() {
        let patch =
            "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
        let mut responses = vec![ok(patch)];
        for page in 0..MAX_PAGES {
            let values = if page == 0 {
                r#"[{"status":"modified","lines_added":1,"lines_removed":1,"new":{"path":"a.txt"}}]"#
            } else {
                "[]"
            };
            let body = format!(
                r#"{{"values":{values},"next":"https://api.bitbucket.org/2.0/{REPO}/pullrequests/10/diffstat?cursor={page}"}}"#
            );
            responses.push(ok(&body));
        }
        let http = MockTransport::new(responses);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");

        let files = pr_diff(&client, REPO, 10).expect("bounded diffstat");

        assert_eq!(files.len(), 1);
        assert_eq!((files[0].add, files[0].del), (1, 1));
        assert!(files[0].truncated);
        assert_eq!(http.request_count(), MAX_PAGES + 1);
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
        assert_eq!(
            http.request_count(),
            0,
            "no request on an unsupported method"
        );
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
        let result = pr_commits(&client, REPO, 2).expect("commits");
        assert_eq!(result.commits.len(), 1);
        assert_eq!(result.commits[0].oid, "deadbeef");
        assert_eq!(result.commits[0].headline, "Fix");
        assert_eq!(result.commits[0].author_login, "ada");
        assert!(!result.commits[0].verified);
        assert!(!result.truncated);
    }

    #[test]
    fn pr_commits_follows_an_opaque_next_after_a_short_page() {
        let first = format!(
            r#"{{"values":[{{"hash":"first"}}],"next":"https://api.bitbucket.org/2.0/{REPO}/pullrequests/3/commits?cursor=opaque%2Btoken"}}"#
        );
        let second = r#"{"values":[{"hash":"second"}]}"#;
        let http = MockTransport::new(vec![ok(&first), ok(second)]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");

        let result = pr_commits(&client, REPO, 3).expect("cursor pages");

        assert_eq!(
            result
                .commits
                .iter()
                .map(|commit| commit.oid.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert!(!result.truncated);
        let requests = http.requests.lock().unwrap();
        assert!(requests[0]
            .url
            .ends_with("/pullrequests/3/commits?pagelen=50"));
        assert!(requests[1]
            .url
            .ends_with("/pullrequests/3/commits?cursor=opaque%2Btoken"));
    }

    #[test]
    fn pr_commits_treats_a_full_final_page_as_complete_without_next() {
        let values = (0..PER_PAGE)
            .map(|index| serde_json::json!({ "hash": format!("commit-{index}") }))
            .collect::<Vec<_>>();
        let body = serde_json::json!({ "values": values }).to_string();
        let http = MockTransport::new(vec![ok(&body)]);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");

        let result = pr_commits(&client, REPO, 4).expect("full final page");

        assert_eq!(result.commits.len(), PER_PAGE);
        assert!(!result.truncated);
        assert_eq!(http.request_count(), 1);
    }

    #[test]
    fn pr_commits_marks_results_truncated_when_next_remains_after_the_cap() {
        let responses = (0..MAX_PAGES)
            .map(|page| {
                ok(&format!(
                    r#"{{"values":[],"next":"https://api.bitbucket.org/2.0/{REPO}/pullrequests/5/commits?cursor={page}"}}"#
                ))
            })
            .collect();
        let http = MockTransport::new(responses);
        let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");

        let result = pr_commits(&client, REPO, 5).expect("bounded commit pages");

        assert!(result.commits.is_empty());
        assert!(result.truncated);
        assert_eq!(http.request_count(), MAX_PAGES);
    }
}
