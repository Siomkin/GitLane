use std::ffi::OsStr;

use super::support::*;

#[test]
fn gh_commands_clear_repository_local_environment() {
    let command = gh_command(".", &["version"]);
    for key in crate::git::REPOSITORY_LOCAL_ENV_VARS {
        assert!(
            command
                .get_envs()
                .any(|(name, value)| name == OsStr::new(key) && value.is_none()),
            "{key} must be removed from the gh subprocess environment"
        );
    }
}

#[test]
fn missing_gh_copy_is_preserved() {
    let error = map_gh_capture_error(
        CaptureError::Spawn(std::io::Error::from(std::io::ErrorKind::NotFound)),
        &crate::git::tool_probes::ProbeCell::new(),
    );
    assert_eq!(
        error,
        "GitHub CLI (gh) not found on PATH — install it from https://cli.github.com to use pull requests."
    );
}

/// A `NotFound` spawn drops the cached capability probe so the next gh
/// operation re-detects the CLI (the "installed gh after launch" path); any
/// other spawn failure leaves the probe alone.
#[test]
fn not_found_spawn_invalidates_the_gh_probe() {
    let probe = crate::git::tool_probes::ProbeCell::new();
    let _ = probe.get_or_probe(|| {
        Ok::<_, String>(GhCapabilities {
            version: MIN_GH_VERSION,
            auth_status_json: true,
            auth_token_host_user: true,
            pr_diff_patch: true,
            graphql: true,
        })
    });
    let _ = map_gh_capture_error(
        CaptureError::Spawn(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
        &probe,
    );
    assert!(probe.is_cached(), "non-NotFound keeps the probe");

    let _ = map_gh_capture_error(
        CaptureError::Spawn(std::io::Error::from(std::io::ErrorKind::NotFound)),
        &probe,
    );
    assert!(!probe.is_cached(), "NotFound drops the probe");
}

#[test]
fn bounded_finish_preserves_lossy_and_stream_order_semantics() {
    assert_eq!(
        finish_gh_bytes(true, b"ok\xff", b"ignored stderr", false, None).unwrap(),
        "ok\u{fffd}"
    );

    let error = finish_gh_bytes(
        false,
        b" stdout first\n",
        b"stderr https://alice:secret@example.test/repo\xff \n",
        false,
        None,
    )
    .unwrap_err();
    assert_eq!(
        error,
        "stdout first\nstderr https://alice:***@example.test/repo\u{fffd}"
    );
}

#[test]
fn truncated_diagnostics_are_disclosed_but_never_shown_on_success() {
    // Truncation must not silently pass a clipped tail off as the whole
    // message; on success stderr is unread, so it stays invisible.
    assert_eq!(
        finish_gh_bytes(true, b"payload", b"clipped trace", true, None).unwrap(),
        "payload"
    );

    let error = finish_gh_bytes(false, b"", b"partial trace", true, None).unwrap_err();
    assert_eq!(
        error,
        format!("partial trace{}", bounded_output::stderr_truncated_notice())
    );
}

#[test]
fn failures_scrub_the_token_this_invocation_exported() {
    // gh holds the same secret the REST clients scrub (GL-320), and a debug
    // trace can echo it back through stderr as a request header.
    let token = "ghp_live_secret";
    let error = finish_gh_bytes(
        false,
        b"",
        format!("GET /repos: Authorization: token {token}\nauth=ghp_live%5Fsecret").as_bytes(),
        false,
        Some(token),
    )
    .unwrap_err();
    assert!(!error.contains(token), "{error}");
    assert!(!error.contains("ghp_live%5Fsecret"), "{error}");
    assert!(error.contains("GET /repos"), "{error}");

    // Success returns the payload untouched — rewriting stdout would corrupt
    // a body the caller is about to parse.
    assert_eq!(
        finish_gh_bytes(true, token.as_bytes(), b"", false, Some(token)).unwrap(),
        token
    );
}
