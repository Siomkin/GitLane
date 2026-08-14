//! The PR commit list: mapping, cursor paging, and truncation.

use super::support::*;

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
