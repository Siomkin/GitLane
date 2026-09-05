use super::*;
use crate::git::oauth::http::{
    testing::MockTransport, DEFAULT_RESPONSE_LIMIT, PROVIDER_JSON_RESPONSE_LIMIT,
};
use std::ffi::OsStr;

#[test]
fn glab_commands_clear_repository_local_environment() {
    let command = glab_command(".", &["--version"]);
    for key in crate::git::REPOSITORY_LOCAL_ENV_VARS {
        assert!(
            command
                .get_envs()
                .any(|(name, value)| name == OsStr::new(key) && value.is_none()),
            "{key} must be removed from the glab subprocess environment"
        );
    }
}

#[test]
fn missing_glab_copy_is_preserved() {
    let error = map_glab_capture_error(
        CaptureError::Spawn(std::io::Error::from(std::io::ErrorKind::NotFound)),
        &crate::git::tool_probes::ProbeCell::new(),
    );
    assert_eq!(error, GLAB_NOT_FOUND);
}

/// A `NotFound` spawn drops the cached presence probe so the next transport
/// selection re-checks for glab; any other spawn failure leaves it alone.
#[test]
fn not_found_spawn_invalidates_the_glab_probe() {
    let probe = crate::git::tool_probes::ProbeCell::new();
    let _ = probe.get_or_probe(|| Ok::<_, String>(()));
    let _ = map_glab_capture_error(
        CaptureError::Spawn(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
        &probe,
    );
    assert!(probe.is_cached(), "non-NotFound keeps the probe");

    let _ = map_glab_capture_error(
        CaptureError::Spawn(std::io::Error::from(std::io::ErrorKind::NotFound)),
        &probe,
    );
    assert!(!probe.is_cached(), "NotFound drops the probe");
}

#[test]
fn bounded_glab_finish_preserves_lossy_and_stream_order_semantics() {
    assert_eq!(
        finish_glab_bytes(true, b"ok\xff", b"ignored stderr", false).unwrap(),
        "ok\u{fffd}"
    );

    let error = finish_glab_bytes(
        false,
        b" stdout first\n",
        b"stderr https://alice:secret@example.test/repo\xff \n",
        false,
    )
    .unwrap_err();
    assert_eq!(
        error,
        "stdout first\nstderr https://alice:***@example.test/repo\u{fffd}"
    );
}

#[test]
fn truncated_glab_diagnostics_are_disclosed_but_never_shown_on_success() {
    assert_eq!(
        finish_glab_bytes(true, b"payload", b"clipped trace", true).unwrap(),
        "payload"
    );

    let error = finish_glab_bytes(false, b"", b"partial trace", true).unwrap_err();
    assert_eq!(
        error,
        format!("partial trace{}", bounded_output::stderr_truncated_notice())
    );
}

#[test]
fn ordinary_json_can_exceed_the_oauth_response_limit() {
    let body = format!(r#"{{"padding":"{}"}}"#, "x".repeat(DEFAULT_RESPONSE_LIMIT));
    let http = MockTransport::new(vec![MockTransport::ok(200, &body)]);
    let client = RestClient::new(&http, "gitlab.com", "tok");

    assert_eq!(
        client.get("detail", "projects/1/merge_requests/1").unwrap(),
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
    let client = RestClient::new(&http, "gitlab.com", "tok");

    assert_eq!(
        client
            .send("create", Method::Post, "projects/1/merge_requests", &[])
            .unwrap(),
        body
    );
    assert_eq!(
        http.requests.lock().unwrap()[0].max_bytes,
        PROVIDER_JSON_RESPONSE_LIMIT
    );

    let oversized = "x".repeat(PROVIDER_JSON_RESPONSE_LIMIT + 1);
    let http = MockTransport::new(vec![MockTransport::ok(200, &oversized)]);
    let client = RestClient::new(&http, "gitlab.com", "tok");
    assert!(matches!(
        client.send(
            "merge",
            Method::Put,
            "projects/1/merge_requests/1/merge",
            &[]
        ),
        Err(GithubError::InvalidResponse(_))
    ));
}

#[test]
fn extracts_gitlab_error_message() {
    assert_eq!(
        gitlab_message(r#"{"message":"403 Forbidden"}"#).as_deref(),
        Some("403 Forbidden")
    );
    assert_eq!(
        gitlab_message(r#"{"error":"invalid_token"}"#).as_deref(),
        Some("invalid_token")
    );
    // Structured message is serialized rather than dropped.
    assert!(gitlab_message(r#"{"message":{"base":["nope"]}}"#).is_some());
    assert_eq!(gitlab_message("not json"), None);
}

#[test]
fn maps_http_status_to_categories() {
    // 401 → GitLab-specific guidance (glab / Settings token), never gh wording.
    match map_http_error("list", "gitlab.com", 401, "") {
        GithubError::CommandFailed(msg) => {
            assert!(msg.contains("glab auth login"), "{msg}");
            assert!(!msg.contains("gh auth"), "{msg}");
        }
        other => panic!("expected CommandFailed for 401, got {other:?}"),
    }
    assert!(matches!(
        map_http_error("merge", "gitlab.com", 403, ""),
        GithubError::PermissionDenied { .. }
    ));
    assert!(matches!(
        map_http_error("list", "gitlab.com", 429, ""),
        GithubError::RateLimited { .. }
    ));
    // A 404 surfaces GitLab's own message when present.
    match map_http_error(
        "detail",
        "gitlab.com",
        404,
        r#"{"message":"404 Not found"}"#,
    ) {
        GithubError::CommandFailed(msg) => assert!(msg.contains("Not found")),
        other => panic!("expected CommandFailed, got {other:?}"),
    }
}

/// End-to-end wiring proof: this adapter hands the shared client the Bearer
/// value and raw token as secrets. The exhaustive redaction suite
/// (encoded/padded variants, category preservation) lives in `rest.rs`.
#[test]
fn rest_errors_redact_the_active_bearer_end_to_end() {
    let token = "glpat-live-secret";
    let auth = format!("Bearer {token}");
    let body = format!(
        r#"{{"message":"token={token}; auth={auth}; url=https://alice:url-secret@gitlab.com/g/r"}}"#
    );
    let http = MockTransport::new(vec![MockTransport::ok(404, &body)]);
    let client = RestClient::new(&http, "gitlab.com", token);

    let Err(GithubError::CommandFailed(message)) =
        client.get("detail", "projects/1/merge_requests/1")
    else {
        panic!("expected command failure");
    };
    for secret in [token, auth.as_str(), "url-secret"] {
        assert!(!message.contains(secret), "leaked {secret:?}: {message}");
    }
    assert!(
        message.contains("https://alice:***@gitlab.com/g/r"),
        "{message}"
    );
}
