//! Path encoding and the pull-request list.

use super::support::*;

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

