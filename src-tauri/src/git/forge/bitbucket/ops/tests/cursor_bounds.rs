//! Pagination guards: `next`-cursor validation and the hard page cap.

use super::support::*;

#[test]
fn pr_commits_accepts_a_next_cursor_that_differs_only_in_case() {
    // The remote spells the workspace/slug one way; Bitbucket may echo a
    // canonicalized case in `next`. Rejecting that would fail every page
    // past the first on any PR longer than one page.
    let first = r#"{"values":[{"hash":"first"}],"next":"https://api.bitbucket.org/2.0/Repositories/Team/App/pullrequests/7/commits?page=2"}"#;
    let second = r#"{"values":[{"hash":"second"}]}"#;
    let http = MockTransport::new(vec![ok(first), ok(second)]);
    let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");

    let result = pr_commits(&client, REPO, 7).expect("case-varied cursor");

    assert_eq!(
        result
            .commits
            .iter()
            .map(|commit| commit.oid.as_str())
            .collect::<Vec<_>>(),
        vec!["first", "second"]
    );
    assert!(!result.truncated);
    assert_eq!(http.request_count(), 2);
}

#[test]
fn pr_commits_still_rejects_a_different_resource_under_the_api_host() {
    // Case-insensitivity must not widen this to any path on the host: a
    // cursor naming another repository is still refused.
    let first = r#"{"values":[{"hash":"first"}],"next":"https://api.bitbucket.org/2.0/repositories/team/other/pullrequests/7/commits?page=2"}"#;
    let http = MockTransport::new(vec![ok(first)]);
    let client = RestClient::new(&http, "bitbucket.org", "x-token-auth", "tok");

    assert!(matches!(
        pr_commits(&client, REPO, 7),
        Err(GithubError::InvalidResponse(_))
    ));
    assert_eq!(
        http.request_count(),
        1,
        "foreign cursor was never requested"
    );
}

#[test]
fn diffstat_page_cap_returns_a_bounded_incomplete_diff() {
    let patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
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
