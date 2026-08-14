//! PR detail and diff: patch parsing, diffstat reconciliation, and the
//! response-limit behaviour.

use super::support::*;

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

