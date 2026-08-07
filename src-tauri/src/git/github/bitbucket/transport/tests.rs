use super::*;
use crate::git::oauth::http::{
    testing::MockTransport, DEFAULT_RESPONSE_LIMIT, PROVIDER_JSON_RESPONSE_LIMIT,
};

#[test]
fn ordinary_json_can_exceed_the_oauth_response_limit() {
    let body = format!(r#"{{"padding":"{}"}}"#, "x".repeat(DEFAULT_RESPONSE_LIMIT));
    let http = MockTransport::new(vec![MockTransport::ok(200, &body)]);
    let client = RestClient::new(&http, "bitbucket.org", OAUTH_USERNAME, "tok");

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
    let client = RestClient::new(&http, "bitbucket.org", OAUTH_USERNAME, "tok");

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
    let client = RestClient::new(&http, "bitbucket.org", OAUTH_USERNAME, "tok");
    assert!(matches!(
        client.post_json("merge", "repositories/a/b/pullrequests/1/merge", "{}"),
        Err(GithubError::InvalidResponse(_))
    ));
}

fn auth_header_for(username: &str) -> String {
    let http = MockTransport::new(vec![MockTransport::ok(200, "{}")]);
    let client = RestClient::new(&http, "bitbucket.org", username, "tok");
    client.get("probe", "user").expect("get");
    let reqs = http.requests.lock().unwrap();
    reqs[0]
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        .map(|(_, v)| v.clone())
        .expect("authorization header")
}

#[test]
fn oauth_username_uses_bearer_others_use_basic() {
    // OAuth sentinel (and an empty username) → Bearer.
    assert_eq!(auth_header_for(OAUTH_USERNAME), "Bearer tok");
    assert_eq!(auth_header_for(""), "Bearer tok");
    // A real username (API token / app password) → Basic base64(user:token).
    let expected = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode("alice:tok")
    );
    assert_eq!(auth_header_for("alice"), expected);
}

/// Bind the padded-payload fixture in `rest.rs`'s redaction suite to the
/// real encoder: a token whose Basic payload ends in `==` must encode to
/// exactly the payload that suite declares as an extra secret.
#[test]
fn auth_header_encodes_the_padded_basic_payload() {
    assert_eq!(
        auth_header("alice", "bit bucket=Z!"),
        "Basic YWxpY2U6Yml0IGJ1Y2tldD1aIQ=="
    );
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
    // 401 → Bitbucket-specific guidance, never gh wording.
    match map_http_error("list", "bitbucket.org", 401, "") {
        GithubError::CommandFailed(msg) => {
            assert!(msg.contains("Bitbucket"), "{msg}");
            assert!(!msg.contains("gh auth"), "{msg}");
        }
        other => panic!("expected CommandFailed for 401, got {other:?}"),
    }
    // A bare 403 (no body) stays a generic permission error.
    assert!(matches!(
        map_http_error("merge", "bitbucket.org", 403, ""),
        GithubError::PermissionDenied { .. }
    ));
    // A 403 whose body names insufficient scopes surfaces that text plus a
    // re-authorize hint (an OAuth grant predating the PR scopes, GL-141).
    match map_http_error(
        "approve",
        "bitbucket.org",
        403,
        r#"{"type":"error","error":{"message":"Your credentials lack one or more required privilege scopes."}}"#,
    ) {
        GithubError::CommandFailed(msg) => {
            assert!(msg.contains("privilege scopes"), "{msg}");
            assert!(msg.contains("Re-authorize"), "{msg}");
        }
        other => panic!("expected CommandFailed for a scope 403, got {other:?}"),
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

/// End-to-end wiring proof: this adapter declares the Basic payload as an
/// extra secret alongside the raw token, and `get_text` speaks
/// `Accept: text/plain` under the diff limit. The exhaustive redaction
/// suite (encoded/padded variants) lives in `rest.rs`.
#[test]
fn basic_errors_redact_token_and_payload_end_to_end() {
    let token = "bitbucket-app-password";
    let payload = base64::engine::general_purpose::STANDARD.encode(format!("alice:{token}"));
    let auth = format!("Basic {payload}");
    let json = format!(
        r#"{{"error":{{"message":"token={token}; auth={auth}; payload={payload}; url=https://alice:url-secret@bitbucket.org/a/b"}}}}"#
    );
    let http = MockTransport::new(vec![MockTransport::ok(404, &json)]);
    let client = RestClient::new(&http, "bitbucket.org", "alice", token);

    let Err(GithubError::CommandFailed(message)) =
        client.get("detail", "repositories/a/b/pullrequests/1")
    else {
        panic!("expected command failure");
    };
    for secret in [token, auth.as_str(), payload.as_str(), "url-secret"] {
        assert!(!message.contains(secret), "leaked {secret:?}: {message}");
    }
    assert!(
        message.contains("https://alice:***@bitbucket.org/a/b"),
        "{message}"
    );
}

#[test]
fn diff_get_text_sends_text_accept_under_the_diff_limit() {
    let http = MockTransport::new(vec![MockTransport::ok(200, "diff --git a/x b/x")]);
    let client = RestClient::new(&http, "bitbucket.org", "alice", "tok");

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
fn bearer_rest_errors_are_redacted_and_scope_categorization_is_unchanged() {
    // The active secret itself contains "scope". The 403 upgrade must inspect
    // that original detail before redaction removes the token from the outward
    // message, otherwise the re-authorization guidance would be lost.
    let token = "required-scope-secret";
    let body = format!(r#"{{"error":{{"message":"{token}"}}}}"#);
    let http = MockTransport::new(vec![MockTransport::ok(403, &body)]);
    let client = RestClient::new(&http, "bitbucket.org", OAUTH_USERNAME, token);
    let response = client.get("approve", "repositories/a/b/pullrequests/1/approve");
    let Err(GithubError::CommandFailed(message)) = response else {
        panic!("expected categorized scope failure");
    };
    assert!(!message.contains(token), "{message}");
    assert!(message.contains("Re-authorize"), "{message}");

    let http = MockTransport::new(vec![MockTransport::ok(
        404,
        r#"{"error":{"message":"Bearer authentication failed"}}"#,
    )]);
    let empty = RestClient::new(&http, "bitbucket.org", OAUTH_USERNAME, "");
    let response = empty.get("detail", "repositories/a/b/pullrequests/1");
    assert_eq!(
        response,
        Err(GithubError::CommandFailed(
            "Bearer authentication failed".to_string()
        ))
    );
}
