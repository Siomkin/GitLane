//! The GitLab merge-request operations (GL-140), written once against the
//! [`GitlabApi`] transport so the glab-CLI and REST paths share them.
//!
//! Each function builds a GitLab REST v4 path, runs it through the transport, and
//! maps the JSON into the shared PR DTOs via [`super::dto`]. Diffs are turned back
//! into a git patch and parsed by the GitHub provider's battle-tested unified-diff
//! parser so the frontend diff renderer is shared. Only the five basic actions in
//! scope are implemented; everything else returns an explicit "not supported yet".

use super::super::diff::parse_unified_diff;
use super::super::domain::GithubError;
use super::dto::{GitlabCommit, GitlabDiff, GitlabMr};
use super::transport::{GitlabApi, Method, DIFF_RESPONSE_LIMIT};
use crate::git::types::{FileDiff, PrCommit, PrCommitList, PullRequestDetail, PullRequestSummary};

/// Per-project page size / hard page cap for the `/diffs` walk. 100 files/page ×
/// 20 pages is far beyond any realistic MR; the cap guards a runaway loop.
const DIFF_PER_PAGE: usize = 100;
const MAX_DIFF_PAGES: usize = 20;

/// Page size / hard page cap for the `/commits` walk (2000 commits max).
const COMMIT_PER_PAGE: usize = 100;
const MAX_COMMIT_PAGES: usize = 20;

/// List merge requests (most recent 50, newest first) for the project.
/// `state=all` explicitly requests every state (opened/closed/locked/merged),
/// matching `gh pr list --state all` — so the list is state-complete regardless
/// of the endpoint's default.
pub fn list_prs(
    api: &dyn GitlabApi,
    project_id: &str,
) -> Result<Vec<PullRequestSummary>, GithubError> {
    let path = format!(
        "projects/{project_id}/merge_requests?state=all&per_page=50&order_by=created_at&sort=desc"
    );
    let raw = api.get("list merge requests", &path)?;
    let mrs: Vec<GitlabMr> = parse(&raw, "merge request list")?;
    Ok(mrs.into_iter().map(GitlabMr::into_summary).collect())
}

/// Fetch one merge request's detail plus its changed-file list and diff stats.
pub fn pr_detail(
    api: &dyn GitlabApi,
    project_id: &str,
    number: u64,
) -> Result<PullRequestDetail, GithubError> {
    let path = format!("projects/{project_id}/merge_requests/{number}?with_labels_details=true");
    let raw = api.get("merge request detail", &path)?;
    let mr: GitlabMr = parse(&raw, "merge request detail")?;

    // The single-MR endpoint carries no diff stats, so derive the file list and
    // aggregate additions/deletions from the parsed diffs (one paged read).
    let diffs = pr_diff(api, project_id, number)?;
    let files: Vec<String> = diffs.iter().map(|d| d.path.clone()).collect();
    let additions: u64 = diffs.iter().map(|d| d.add as u64).sum();
    let deletions: u64 = diffs.iter().map(|d| d.del as u64).sum();

    Ok(mr.into_detail(files, additions, deletions, Vec::new()))
}

/// Full diff of a merge request, parsed into per-file [`FileDiff`] so the shared
/// diff viewer renders it unchanged. GitLab's `/diffs` returns per-file hunk
/// bodies; [`reconstruct_patch`] wraps them in a git patch header first.
pub fn pr_diff(
    api: &dyn GitlabApi,
    project_id: &str,
    number: u64,
) -> Result<Vec<FileDiff>, GithubError> {
    let mut diffs: Vec<GitlabDiff> = Vec::new();
    let mut hit_cap = false;
    for page in 1..=MAX_DIFF_PAGES {
        let path = format!(
            "projects/{project_id}/merge_requests/{number}/diffs?per_page={DIFF_PER_PAGE}&page={page}"
        );
        let raw = api.get_with_limit("merge request diff", &path, DIFF_RESPONSE_LIMIT)?;
        let batch: Vec<GitlabDiff> = parse(&raw, "merge request diff")?;
        let full_page = batch.len() == DIFF_PER_PAGE;
        diffs.extend(batch);
        if !full_page {
            break;
        }
        hit_cap = page == MAX_DIFF_PAGES;
    }
    // Same runaway-guard breadcrumb as the gh commits reader: don't let a
    // pathologically large MR drop its tail silently.
    if hit_cap {
        eprintln!(
            "gitlane: MR !{number} diff hit the {MAX_DIFF_PAGES}-page cap; {} files fetched, later files omitted",
            diffs.len()
        );
    }
    Ok(parse_unified_diff(&reconstruct_patch(&diffs)))
}

/// The merge request's commit list (`/commits`), paginated so a large MR keeps
/// every commit (parity with the gh provider's full commit read).
pub fn pr_commits(
    api: &dyn GitlabApi,
    project_id: &str,
    number: u64,
) -> Result<PrCommitList, GithubError> {
    let mut commits: Vec<PrCommit> = Vec::new();
    let mut hit_cap = false;
    for page in 1..=MAX_COMMIT_PAGES {
        let path = format!(
            "projects/{project_id}/merge_requests/{number}/commits?per_page={COMMIT_PER_PAGE}&page={page}"
        );
        let raw = api.get("merge request commits", &path)?;
        let batch: Vec<GitlabCommit> = parse(&raw, "merge request commits")?;
        let full_page = batch.len() == COMMIT_PER_PAGE;
        commits.extend(batch.into_iter().map(GitlabCommit::into_commit));
        if !full_page {
            break;
        }
        hit_cap = page == MAX_COMMIT_PAGES;
    }
    if hit_cap {
        eprintln!(
            "gitlane: MR !{number} commits hit the {MAX_COMMIT_PAGES}-page cap; {} fetched, later commits omitted",
            commits.len()
        );
    }
    Ok(PrCommitList {
        commits,
        truncated: hit_cap,
    })
}

/// Open a new merge request from `head` into `base`. Returns the new MR's web URL.
pub fn create_pr(
    api: &dyn GitlabApi,
    project_id: &str,
    base: &str,
    head: &str,
    title: &str,
    body: &str,
    draft: bool,
) -> Result<String, GithubError> {
    if title.trim().is_empty() {
        return Err(GithubError::CommandFailed(
            "A title is required to open a merge request.".to_string(),
        ));
    }
    // GitLab marks a draft MR by a `Draft:` title prefix rather than a flag —
    // add it only when the title isn't already a draft, so a user who typed
    // "Draft: …" and also ticked the box doesn't get "Draft: Draft: …".
    let draft_title;
    let title = if draft && !is_draft_title(title) {
        draft_title = format!("Draft: {title}");
        draft_title.as_str()
    } else {
        title
    };
    let path = format!("projects/{project_id}/merge_requests");
    let form = [
        ("source_branch", head),
        ("target_branch", base),
        ("title", title),
        ("description", body),
    ];
    let raw = api.send("create merge request", Method::Post, &path, &form)?;
    let mr: GitlabMr = parse(&raw, "created merge request")?;
    Ok(if mr.web_url.is_empty() {
        format!("Opened merge request !{}", mr.iid)
    } else {
        mr.web_url
    })
}

/// Merge a merge request. `method` "squash" sets `squash=true`; GitLab's merge
/// endpoint has no rebase-merge, so "rebase"/"merge" both do a plain merge.
/// `delete_branch` removes the source branch.
pub fn merge_pr(
    api: &dyn GitlabApi,
    project_id: &str,
    number: u64,
    method: &str,
    delete_branch: bool,
) -> Result<String, GithubError> {
    // GitLab's merge endpoint has no rebase-merge (rebase is a separate async
    // job), so refuse it explicitly rather than silently doing a plain merge.
    if method == "rebase" {
        return Err(unsupported(
            "Rebase-and-merge isn't supported for GitLab merge requests. Use Merge or Squash.",
        ));
    }
    let path = format!("projects/{project_id}/merge_requests/{number}/merge");
    let mut form: Vec<(&str, &str)> = Vec::new();
    if method == "squash" {
        form.push(("squash", "true"));
    }
    if delete_branch {
        form.push(("should_remove_source_branch", "true"));
    }
    let raw = api.send("merge merge request", Method::Put, &path, &form)?;
    let mr: GitlabMr = parse(&raw, "merged merge request")?;
    Ok(if mr.web_url.is_empty() {
        format!("Merged !{number}")
    } else {
        mr.web_url
    })
}

/// Approve a merge request. Only `approve` is in scope; request-changes / comment
/// have no basic-API equivalent and return an explicit unsupported error.
pub fn review_pr(
    api: &dyn GitlabApi,
    project_id: &str,
    number: u64,
    action: &str,
) -> Result<String, GithubError> {
    if action != "approve" {
        return Err(unsupported(
            "Only approving a GitLab merge request is supported in GitLane.",
        ));
    }
    let path = format!("projects/{project_id}/merge_requests/{number}/approve");
    api.send("approve merge request", Method::Post, &path, &[])?;
    Ok(format!("Approved !{number}"))
}

/// A "not supported yet" error for an out-of-scope option on an operation this
/// provider does implement (an unsupported merge method or review action).
/// Whole operations decline through the trait's default (GL-354).
fn unsupported(message: &str) -> GithubError {
    GithubError::CommandFailed(message.to_string())
}

/// Parse a JSON body into `T`, mapping a failure to an `InvalidResponse` category
/// with the operation label (never echoing the raw body, which could be large).
fn parse<T: serde::de::DeserializeOwned>(raw: &str, what: &str) -> Result<T, GithubError> {
    serde_json::from_str(raw)
        .map_err(|e| GithubError::InvalidResponse(format!("failed to parse {what}: {e}")))
}

/// The GitLab project id for the REST path: the URL-encoded namespace path
/// (`group[/subgroup]/repo` → `group%2F…%2Frepo`). A blank namespace (a
/// single-segment path) encodes the name alone, never a leading `%2F`.
pub fn project_id(owner: &str, name: &str) -> String {
    let path = if owner.is_empty() {
        name.to_string()
    } else {
        format!("{owner}/{name}")
    };
    percent_encode(&path)
}

/// Whether a title is already a GitLab draft, so `create_pr` doesn't double the
/// prefix. Mirrors GitLab's own draft detection (case-insensitive `Draft:` /
/// `[Draft]` / the legacy `WIP:`).
fn is_draft_title(title: &str) -> bool {
    let t = title.trim_start().to_ascii_lowercase();
    t.starts_with("draft:") || t.starts_with("[draft]") || t.starts_with("wip:")
}

/// Percent-encode everything outside the RFC 3986 unreserved set — critically
/// `/` → `%2F`, so a nested-namespace project path is one path segment.
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

/// Reconstruct a git patch from GitLab's per-file `/diffs` payload so the shared
/// unified-diff parser can consume it. GitLab returns only the hunk body (from
/// `@@`), plus rename/new/deleted flags — so the `diff --git`, mode, and rename
/// headers are synthesized here. An empty diff on a non-rename is treated as a
/// binary change (GitLab omits the hunk body for binaries).
fn reconstruct_patch(diffs: &[GitlabDiff]) -> String {
    let mut out = String::new();
    for d in diffs {
        let old = if d.old_path.is_empty() {
            &d.new_path
        } else {
            &d.old_path
        };
        let new = if d.new_path.is_empty() {
            &d.old_path
        } else {
            &d.new_path
        };
        out.push_str(&format!("diff --git a/{old} b/{new}\n"));
        if d.new_file {
            out.push_str("new file mode 100644\n");
        } else if d.deleted_file {
            out.push_str("deleted file mode 100644\n");
        } else if d.renamed_file {
            out.push_str(&format!("rename from {old}\nrename to {new}\n"));
        }
        if d.diff.trim().is_empty() {
            // A pure rename legitimately has no hunk body; only flag a binary when
            // there is a content change with no textual diff.
            if !d.renamed_file {
                out.push_str(&format!("Binary files a/{old} and b/{new} differ\n"));
            }
            continue;
        }
        let old_side = if d.new_file {
            "/dev/null".to_string()
        } else {
            format!("a/{old}")
        };
        let new_side = if d.deleted_file {
            "/dev/null".to_string()
        } else {
            format!("b/{new}")
        };
        out.push_str(&format!("--- {old_side}\n+++ {new_side}\n"));
        out.push_str(&d.diff);
        if !d.diff.ends_with('\n') {
            out.push('\n');
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
    use crate::git::types::ChangeStatus;

    fn ok(body: &str) -> HttpResult {
        MockTransport::ok(200, body)
    }

    #[test]
    fn project_id_encodes_nested_namespace() {
        assert_eq!(project_id("group", "repo"), "group%2Frepo");
        assert_eq!(project_id("group/sub", "repo"), "group%2Fsub%2Frepo");
    }

    #[test]
    fn list_prs_hits_the_project_mr_endpoint_and_maps_state() {
        let http = MockTransport::new(vec![ok(
            r#"[{"iid":3,"title":"A","state":"merged","source_branch":"f","target_branch":"main",
                "author":{"username":"ada"},"created_at":"t","web_url":"https://gitlab.com/x/-/merge_requests/3"}]"#,
        )]);
        let client = RestClient::new(&http, "gitlab.com", "tok");
        let prs = list_prs(&client, "group%2Frepo").expect("list");
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 3);
        assert_eq!(prs[0].state, "MERGED");
        let reqs = http.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "GET");
        assert!(reqs[0]
            .url
            .contains("/api/v4/projects/group%2Frepo/merge_requests?state=all&per_page=50"));
    }

    #[test]
    fn pr_detail_combines_mr_and_diff_stats() {
        let mr = r#"{"iid":5,"title":"T","state":"opened","source_branch":"s","target_branch":"main",
            "author":{"username":"u"},"created_at":"t","description":"Body"}"#;
        // One added line, one removed line across two files.
        let diffs = r#"[
            {"old_path":"a.txt","new_path":"a.txt","diff":"@@ -1 +1 @@\n-old\n+new\n"},
            {"old_path":"b.txt","new_path":"b.txt","new_file":true,"diff":"@@ -0,0 +1 @@\n+hello\n"}
        ]"#;
        // Page 2 is empty (< per_page ends the loop after page 1 is full? here page 1 is short).
        let http = MockTransport::new(vec![ok(mr), ok(diffs)]);
        let client = RestClient::new(&http, "gitlab.com", "tok");
        let detail = pr_detail(&client, "p", 5).expect("detail");
        assert_eq!(detail.number, 5);
        assert_eq!(detail.body, "Body");
        assert_eq!(detail.files, vec!["a.txt".to_string(), "b.txt".to_string()]);
        assert_eq!(detail.changed_files, 2);
        assert_eq!(detail.additions, 2, "+new and +hello");
        assert_eq!(detail.deletions, 1, "-old");
    }

    #[test]
    fn pr_diff_reconstructs_and_parses_new_and_modified_files() {
        let diffs = r#"[
            {"old_path":"a.txt","new_path":"a.txt","diff":"@@ -1 +1 @@\n-old\n+new\n"},
            {"old_path":"b.txt","new_path":"b.txt","new_file":true,"diff":"@@ -0,0 +1 @@\n+hi\n"},
            {"old_path":"c.bin","new_path":"c.bin","diff":""}
        ]"#;
        let http = MockTransport::new(vec![ok(diffs)]);
        let client = RestClient::new(&http, "gitlab.com", "tok");
        let files = pr_diff(&client, "p", 5).expect("diff");
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].status, ChangeStatus::Modified);
        assert_eq!(files[1].status, ChangeStatus::Added);
        assert!(
            files[2].binary,
            "empty diff on a non-rename reads as binary"
        );
        let requests = http.requests.lock().unwrap();
        assert_eq!(requests[0].max_bytes, DIFF_RESPONSE_LIMIT);
    }

    #[test]
    fn create_pr_posts_form_and_returns_web_url() {
        let http = MockTransport::new(vec![ok(
            r#"{"iid":10,"title":"New","state":"opened","source_branch":"feat","target_branch":"main",
                "author":{"username":"u"},"created_at":"t","web_url":"https://gitlab.com/x/-/merge_requests/10"}"#,
        )]);
        let client = RestClient::new(&http, "gitlab.com", "tok");
        let url = create_pr(&client, "p", "main", "feat", "New", "desc", true).expect("create");
        assert_eq!(url, "https://gitlab.com/x/-/merge_requests/10");
        let reqs = http.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "POST");
        let form = &reqs[0].form;
        assert!(form
            .iter()
            .any(|(k, v)| k == "source_branch" && v == "feat"));
        assert!(form
            .iter()
            .any(|(k, v)| k == "target_branch" && v == "main"));
        assert!(
            form.iter().any(|(k, v)| k == "title" && v == "Draft: New"),
            "draft prefixes the title"
        );
    }

    #[test]
    fn create_pr_rejects_empty_title_before_calling() {
        let http = MockTransport::new(vec![]);
        let client = RestClient::new(&http, "gitlab.com", "tok");
        assert!(create_pr(&client, "p", "main", "feat", "  ", "", false).is_err());
        assert_eq!(http.request_count(), 0, "no request on a rejected title");
    }

    #[test]
    fn create_pr_does_not_double_the_draft_prefix() {
        let http = MockTransport::new(vec![ok(
            r#"{"iid":11,"title":"Draft: New","state":"opened","source_branch":"f","target_branch":"main",
                "author":{"username":"u"},"created_at":"t","web_url":"https://gitlab.com/x/-/merge_requests/11"}"#,
        )]);
        let client = RestClient::new(&http, "gitlab.com", "tok");
        // User already typed a draft title AND ticked draft → prefix added once.
        create_pr(&client, "p", "main", "f", "Draft: New", "", true).expect("create");
        let reqs = http.requests.lock().unwrap();
        assert!(reqs[0]
            .form
            .iter()
            .any(|(k, v)| k == "title" && v == "Draft: New"));
    }

    #[test]
    fn merge_pr_rejects_rebase_before_calling() {
        let http = MockTransport::new(vec![]);
        let client = RestClient::new(&http, "gitlab.com", "tok");
        let err = merge_pr(&client, "p", 7, "rebase", false).unwrap_err();
        assert!(matches!(err, GithubError::CommandFailed(_)));
        assert_eq!(
            http.request_count(),
            0,
            "no request on an unsupported method"
        );
    }

    #[test]
    fn merge_pr_puts_with_squash_and_delete_flags() {
        let http = MockTransport::new(vec![ok(
            r#"{"iid":7,"title":"T","state":"merged","source_branch":"s","target_branch":"main",
                "author":{"username":"u"},"created_at":"t","web_url":"https://gitlab.com/x/-/merge_requests/7"}"#,
        )]);
        let client = RestClient::new(&http, "gitlab.com", "tok");
        let out = merge_pr(&client, "p", 7, "squash", true).expect("merge");
        assert!(out.contains("merge_requests/7"));
        let reqs = http.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "PUT");
        assert!(reqs[0].url.ends_with("/merge_requests/7/merge"));
        let form = &reqs[0].form;
        assert!(form.iter().any(|(k, v)| k == "squash" && v == "true"));
        assert!(form
            .iter()
            .any(|(k, v)| k == "should_remove_source_branch" && v == "true"));
    }

    #[test]
    fn review_pr_approves_and_rejects_other_actions() {
        let http = MockTransport::new(vec![ok(r#"{"id":1,"state":"approved"}"#)]);
        let client = RestClient::new(&http, "gitlab.com", "tok");
        let out = review_pr(&client, "p", 9, "approve").expect("approve");
        assert!(out.contains("Approved !9"));
        {
            let reqs = http.requests.lock().unwrap();
            assert_eq!(reqs[0].method, "POST");
            assert!(reqs[0].url.ends_with("/merge_requests/9/approve"));
        }
        // request-changes / comment aren't in scope.
        let http2 = MockTransport::new(vec![]);
        let client2 = RestClient::new(&http2, "gitlab.com", "tok");
        assert!(review_pr(&client2, "p", 9, "request-changes").is_err());
        assert_eq!(http2.request_count(), 0);
    }

    #[test]
    fn pr_commits_maps_the_commit_list() {
        let http = MockTransport::new(vec![ok(
            r#"[{"id":"deadbeef","title":"Fix","author_name":"Ada","authored_date":"2026-01-01"}]"#,
        )]);
        let client = RestClient::new(&http, "gitlab.com", "tok");
        let result = pr_commits(&client, "p", 2).expect("commits");
        assert_eq!(result.commits.len(), 1);
        assert_eq!(result.commits[0].oid, "deadbeef");
        assert_eq!(result.commits[0].headline, "Fix");
        assert!(!result.commits[0].verified);
        assert!(!result.truncated);
    }
}
