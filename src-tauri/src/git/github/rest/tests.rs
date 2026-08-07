use super::*;
use crate::git::oauth::http::testing::MockTransport;

/// A minimal forge mapping: echo the body for message-bearing statuses,
/// keep a message-free category for 403 so pass-through is observable.
fn map_error(operation: &'static str, _host: &str, status: u16, body: &str) -> GithubError {
    match status {
        403 => GithubError::PermissionDenied { operation },
        _ => GithubError::CommandFailed(body.to_string()),
    }
}

fn bearer_client<'a>(http: &'a MockTransport, token: &'a str) -> RestClient<'a> {
    RestClient::new(
        http,
        RestConfig {
            provider: "GitLab",
            base_url: "https://gitlab.com/api/v4".to_string(),
            host: "gitlab.com",
            auth: format!("Bearer {token}"),
            token,
            extra_secrets: &[],
            map_error,
        },
    )
}

#[test]
fn errors_redact_active_auth_and_url_credentials() {
    let token = "glpat-live-secret";
    let http = MockTransport::new(vec![]);
    let client = bearer_client(&http, token);
    let auth = format!("Bearer {token}");
    let header = format!("Authorization: {auth}");
    let body = format!(
        "token={token}; auth={auth}; header={header}; url=https://alice:url-secret@gitlab.com/g/r"
    );

    let Err(GithubError::CommandFailed(message)) =
        client.finish("detail", MockTransport::ok(404, &body))
    else {
        panic!("expected command failure");
    };
    for secret in [token, auth.as_str(), header.as_str(), "url-secret"] {
        assert!(!message.contains(secret), "leaked {secret:?}: {message}");
    }
    assert!(
        message.contains("https://alice:***@gitlab.com/g/r"),
        "{message}"
    );

    let transport = format!("request failed with {header} at https://alice:url-secret@gitlab.com");
    let Err(GithubError::Network(message)) =
        client.finish("detail", Err(HttpError::Transport(transport)))
    else {
        panic!("expected network failure");
    };
    for secret in [token, auth.as_str(), header.as_str(), "url-secret"] {
        assert!(!message.contains(secret), "leaked {secret:?}: {message}");
    }
}

#[test]
fn errors_redact_encoded_active_values_from_queries_and_userinfo() {
    let token = "live secret=Z";
    let encoded_token = "live+secret%3d%5A";
    let encoded_auth = "Bearer+live%20secret%3D%5a";
    let encoded_header = "Authorization%3a+Bearer%20live+secret=%5A";
    let http = MockTransport::new(vec![]);
    let client = bearer_client(&http, token);
    let body = format!(
        "https://{encoded_token}@gitlab.com/g/r?token={encoded_token}&auth={encoded_auth}&header={encoded_header}"
    );

    let error = client
        .finish("detail", MockTransport::ok(404, &body))
        .expect_err("encoded credential echo must fail");

    let debug = format!("{error:?}");
    let ipc = error.to_ipc_string();
    for exposed in [
        token,
        encoded_token,
        encoded_auth,
        encoded_header,
        "live secret%3D%5a",
    ] {
        assert!(
            !debug.contains(exposed),
            "debug leaked {exposed:?}: {debug}"
        );
        assert!(!ipc.contains(exposed), "IPC leaked {exposed:?}: {ipc}");
    }
    assert!(ipc.contains("https://***@gitlab.com/g/r"), "{ipc}");
}

#[test]
fn extra_secrets_cover_basic_payloads_including_padded_encodings() {
    let token = "bit bucket=Z!";
    let payload = "YWxpY2U6Yml0IGJ1Y2tldD1aIQ==";
    let encoded_token = "bit+bucket%3d%5A%21";
    let encoded_payload = "YWxpY2U6Yml0IGJ1Y2tldD1aIQ%3d%3D";
    let encoded_auth = "Basic+YWxpY2U6Yml0IGJ1Y2tldD1aIQ%3D%3d";
    let encoded_header = "Authorization%3a+Basic%20YWxpY2U6Yml0IGJ1Y2tldD1aIQ=%3D";
    let http = MockTransport::new(vec![]);
    let client = RestClient::new(
        &http,
        RestConfig {
            provider: "Bitbucket",
            base_url: "https://api.bitbucket.org/2.0".to_string(),
            host: "bitbucket.org",
            auth: format!("Basic {payload}"),
            token,
            extra_secrets: &[payload],
            map_error,
        },
    );
    let body = format!(
        "https://{encoded_token}@bitbucket.org/a/b?token={encoded_token}&payload={encoded_payload}&auth={encoded_auth}&header={encoded_header}"
    );

    let error = client
        .finish("detail", MockTransport::ok(404, &body))
        .expect_err("encoded credential echo must fail");

    let debug = format!("{error:?}");
    let ipc = error.to_ipc_string();
    for exposed in [
        token,
        payload,
        encoded_token,
        encoded_payload,
        encoded_auth,
        encoded_header,
    ] {
        assert!(
            !debug.contains(exposed),
            "debug leaked {exposed:?}: {debug}"
        );
        assert!(!ipc.contains(exposed), "IPC leaked {exposed:?}: {ipc}");
    }
    assert!(ipc.contains("https://***@bitbucket.org/a/b"), "{ipc}");
}

#[test]
fn redaction_keeps_categories_and_ignores_an_empty_token() {
    let http = MockTransport::new(vec![]);
    let client = bearer_client(&http, "glpat-live-secret");
    // Message-free categories pass through the redaction untouched.
    assert!(matches!(
        client.finish("merge", MockTransport::ok(403, "glpat-live-secret")),
        Err(GithubError::PermissionDenied { operation: "merge" })
    ));

    // An empty token has nothing to redact; the message survives verbatim.
    let empty = bearer_client(&http, "");
    assert_eq!(
        empty.finish(
            "detail",
            MockTransport::ok(404, "Bearer authentication failed")
        ),
        Err(GithubError::CommandFailed(
            "Bearer authentication failed".to_string()
        ))
    );
}

#[test]
fn oversized_response_is_a_typed_invalid_response_naming_the_provider() {
    let http = MockTransport::new(vec![]);
    let client = bearer_client(&http, "tok");

    let result = client.finish(
        "pull request diff",
        Err(HttpError::ResponseTooLarge { limit: 1024 }),
    );
    match result {
        Err(GithubError::InvalidResponse(message)) => {
            assert!(message.starts_with("GitLab pull request diff"), "{message}");
            assert!(message.contains("1024-byte"), "{message}");
            assert!(
                message.contains("partial response was discarded"),
                "{message}"
            );
        }
        other => panic!("expected typed invalid response, got {other:?}"),
    }
}

#[test]
fn verbs_attach_auth_accept_and_limits() {
    let responses = vec![
        MockTransport::ok(200, "{}"),
        MockTransport::ok(200, "patch"),
        MockTransport::ok(200, "{}"),
    ];
    let http = MockTransport::new(responses);
    let client = bearer_client(&http, "tok");

    client.get_json("detail", "projects/1").unwrap();
    client.get_text("diff", "projects/1/diff", 4096).unwrap();
    client.post_json("create", "projects/1/prs", "{}").unwrap();

    let requests = http.requests.lock().unwrap();
    assert_eq!(requests[0].url, "https://gitlab.com/api/v4/projects/1");
    assert_eq!(requests[0].max_bytes, PROVIDER_JSON_RESPONSE_LIMIT);
    let accept = |i: usize| {
        requests[i]
            .headers
            .iter()
            .find(|(k, _)| k == "Accept")
            .map(|(_, v)| v.clone())
    };
    let auth = |i: usize| {
        requests[i]
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
            .map(|(_, v)| v.clone())
    };
    assert_eq!(accept(0).as_deref(), Some("application/json"));
    assert_eq!(accept(1).as_deref(), Some("text/plain"));
    assert_eq!(requests[1].max_bytes, 4096);
    assert_eq!(accept(2).as_deref(), Some("application/json"));
    for i in 0..3 {
        assert_eq!(auth(i).as_deref(), Some("Bearer tok"));
    }
}
