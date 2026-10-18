use super::*;
use crate::git::oauth::http::{
    testing::MockTransport, DEFAULT_RESPONSE_LIMIT, PROVIDER_JSON_RESPONSE_LIMIT,
};

#[test]
fn ordinary_json_can_exceed_the_oauth_response_limit() {
    let body = format!(r#"{{"padding":"{}"}}"#, "x".repeat(DEFAULT_RESPONSE_LIMIT));
    let http = MockTransport::new(vec![MockTransport::ok(200, &body)]);
    let client = RestClient::new(&http, "bitbucket.org", "tok");

    assert_eq!(
        client
            .get("detail", "repositories/a/b/pullrequests/1")
            .unwrap(),
        body
    );
    assert_eq!(
        http.requests.lock().unwrap()[0].max_bytes,
        PROVIDER_JSON_RESPONSE_LIMIT
    );
}

#[test]
fn mutation_json_uses_the_provider_response_limit() {
    let body = format!(r#"{{"padding":"{}"}}"#, "x".repeat(DEFAULT_RESPONSE_LIMIT));
    let http = MockTransport::new(vec![MockTransport::ok(200, &body)]);
    let client = RestClient::new(&http, "bitbucket.org", "tok");

    assert_eq!(
        client
            .post_json("create", "repositories/a/b/pullrequests", "{}")
            .unwrap(),
        body
    );
    assert_eq!(
        http.requests.lock().unwrap()[0].max_bytes,
        PROVIDER_JSON_RESPONSE_LIMIT
    );

    let oversized = "x".repeat(PROVIDER_JSON_RESPONSE_LIMIT + 1);
    let http = MockTransport::new(vec![MockTransport::ok(200, &oversized)]);
    let client = RestClient::new(&http, "bitbucket.org", "tok");
    assert!(matches!(
        client.post_json("merge", "repositories/a/b/pullrequests/1/merge", "{}"),
        Err(GithubError::Capture(
            crate::git::forge::CaptureError::TooLarge { .. }
        ))
    ));
}

#[test]
fn every_token_is_sent_as_bearer() {
    // OAuth and API tokens alike: the username never reaches the REST API.
    let http = MockTransport::new(vec![MockTransport::ok(200, "{}")]);
    let client = RestClient::new(&http, "bitbucket.org", "tok");
    client.get("probe", "user").expect("get");
    let reqs = http.requests.lock().unwrap();
    let auth = reqs[0]
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        .map(|(_, v)| v.as_str());
    assert_eq!(auth, Some("Bearer tok"));
}

#[test]
fn extracts_bitbucket_error_message() {
    assert_eq!(
        bitbucket_message(r#"{"type":"error","error":{"message":"Bad request"}}"#).as_deref(),
        Some("Bad request")
    );
    // Falls back to `detail` when `message` is absent.
    assert_eq!(
        bitbucket_message(r#"{"error":{"detail":"nope"}}"#).as_deref(),
        Some("nope")
    );
    assert_eq!(bitbucket_message("not json"), None);
    assert_eq!(bitbucket_message(r#"{"error":{}}"#), None);
}

#[test]
fn maps_http_status_to_categories() {
    // 401 → an auth error (so the toast offers "Fix authentication…") saying the
    // saved token was rejected — never the "no sign-in found" text, never gh wording.
    let err = map_http_error("list", "bitbucket.org", 401, "");
    let msg = err.to_ipc_string();
    assert!(msg.contains("rejected the saved token"), "{msg}");
    assert!(!msg.contains("No Bitbucket PR sign-in found"), "{msg}");
    assert!(!msg.contains("gh auth"), "{msg}");
    assert_eq!(
        crate::git::types::CommandError::from(err).kind,
        crate::git::types::CommandErrorKind::Auth
    );
    // Any 403 that is not a scope problem, bare or bodied, is a permission error.
    for body in [
        "",
        r#"{"type":"error","error":{"message":"You do not have access to this repository."}}"#,
    ] {
        assert!(matches!(
            map_http_error("merge", "bitbucket.org", 403, body),
            GithubError::PermissionDenied { .. }
        ));
    }
    // A 403 whose body names insufficient scopes is an auth error carrying that
    // text plus a re-authorize hint (an OAuth grant predating the PR scopes, GL-141).
    let err = map_http_error(
        "approve",
        "bitbucket.org",
        403,
        r#"{"type":"error","error":{"message":"Your credentials lack one or more required privilege scopes."}}"#,
    );
    match &err {
        GithubError::NotAuthenticated {
            host,
            hint: Some(msg),
            ..
        } => {
            assert_eq!(host, "bitbucket.org");
            assert!(msg.contains("privilege scopes"), "{msg}");
            assert!(msg.contains("Re-authorize"), "{msg}");
            assert!(!err.to_ipc_string().contains("gh auth"));
        }
        other => panic!("expected NotAuthenticated for a scope 403, got {other:?}"),
    }
    assert!(matches!(
        map_http_error("list", "bitbucket.org", 429, ""),
        GithubError::RateLimited { .. }
    ));
    // A 404 surfaces Bitbucket's own message when present.
    match map_http_error(
        "detail",
        "bitbucket.org",
        404,
        r#"{"type":"error","error":{"message":"No such pull request"}}"#,
    ) {
        GithubError::CommandFailed(msg) => assert!(msg.contains("No such pull request")),
        other => panic!("expected CommandFailed, got {other:?}"),
    }
}

/// A failing `get_text` (non-JSON 5xx body echoing the Bearer credential) must
/// come back categorized *and* scrubbed — the text endpoint and redaction
/// joined in one case. The exhaustive redaction suite lives in `rest.rs`.
#[test]
fn get_text_errors_redact_bearer_credentials() {
    let token = "bitbucket-api-token";
    let body = format!("upstream echoed Authorization: Bearer {token}");
    let http = MockTransport::new(vec![MockTransport::ok(500, &body)]);
    let client = RestClient::new(&http, "bitbucket.org", token);

    let Err(GithubError::CommandFailed(message)) =
        client.get_text("pull request diff", "repositories/a/b/pullrequests/1/diff")
    else {
        panic!("expected command failure");
    };
    assert!(!message.contains(token), "leaked token: {message}");
}

#[test]
fn diff_get_text_sends_text_accept_under_the_diff_limit() {
    let http = MockTransport::new(vec![MockTransport::ok(200, "diff --git a/x b/x")]);
    let client = RestClient::new(&http, "bitbucket.org", "tok");

    client
        .get_text("pull request diff", "repositories/a/b/pullrequests/1/diff")
        .unwrap();

    let requests = http.requests.lock().unwrap();
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].max_bytes, DIFF_RESPONSE_LIMIT);
    assert_eq!(
        requests[0]
            .headers
            .iter()
            .find(|(key, _)| key == "Accept")
            .map(|(_, value)| value.as_str()),
        Some("text/plain")
    );
}

#[test]
fn bearer_rest_errors_are_redacted_including_the_scope_403_auth_hint() {
    // The active secret itself contains "scope". The 403 upgrade must inspect
    // that original detail before redaction removes the token from the outward
    // message, otherwise the re-authorization guidance would be lost.
    let token = "required-scope-secret";
    let body = format!(r#"{{"error":{{"message":"{token}"}}}}"#);
    let http = MockTransport::new(vec![MockTransport::ok(403, &body)]);
    let client = RestClient::new(&http, "bitbucket.org", token);
    let response = client.get("approve", "repositories/a/b/pullrequests/1/approve");
    let Err(GithubError::NotAuthenticated {
        hint: Some(message),
        ..
    }) = response
    else {
        panic!("expected categorized scope failure");
    };
    assert!(!message.contains(token), "{message}");
    assert!(message.contains("Re-authorize"), "{message}");

    let http = MockTransport::new(vec![MockTransport::ok(
        404,
        r#"{"error":{"message":"Bearer authentication failed"}}"#,
    )]);
    let empty = RestClient::new(&http, "bitbucket.org", "");
    let response = empty.get("detail", "repositories/a/b/pullrequests/1");
    assert!(
        matches!(&response, Err(GithubError::CommandFailed(m)) if m == "Bearer authentication failed"),
        "{response:?}"
    );
}
