//! The write actions: create, merge, and review.

use super::support::*;

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
    let sent: serde_json::Value = serde_json::from_str(reqs[0].body.as_deref().unwrap()).unwrap();
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
