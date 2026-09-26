//! `finish` / `map_capture_error`: the result shaping every provider CLI
//! (`gh`, `glab`, `origin`) shares.

use super::super::{finish_bytes, map_capture_error, stderr_truncated_notice, CaptureError};
use crate::git::tool_probes::ProbeCell;

#[test]
fn bounded_finish_preserves_lossy_and_stream_order_semantics() {
    assert_eq!(
        finish_bytes(true, b"ok\xff", b"ignored stderr", false, None).unwrap(),
        "ok\u{fffd}"
    );

    let error = finish_bytes(
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
        finish_bytes(true, b"payload", b"clipped trace", true, None).unwrap(),
        "payload"
    );

    let error = finish_bytes(false, b"", b"partial trace", true, None).unwrap_err();
    assert_eq!(error, format!("partial trace{}", stderr_truncated_notice()));
}

#[test]
fn failures_scrub_the_token_this_invocation_exported() {
    // gh holds the same secret the REST clients scrub (GL-320), and a debug
    // trace can echo it back through stderr as a request header.
    let token = "ghp_live_secret";
    let error = finish_bytes(
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
        finish_bytes(true, token.as_bytes(), b"", false, Some(token)).unwrap(),
        token
    );
}

/// A `NotFound` spawn drops the cached probe so the next operation re-detects
/// the CLI (the "installed it after launch" path) and reports the tool's own
/// not-found copy; any other spawn failure leaves the probe alone.
#[test]
fn not_found_spawn_invalidates_the_probe_and_reports_the_tool_copy() {
    let probe = ProbeCell::new();
    let _ = probe.get_or_probe(|| Ok::<_, String>(()));

    let error = String::from(map_capture_error(
        CaptureError::Spawn(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
        "glab",
        "glab missing",
        &probe,
    ));
    assert!(error.starts_with("failed to launch glab: "), "{error}");
    assert!(probe.is_cached(), "non-NotFound keeps the probe");

    let error = String::from(map_capture_error(
        CaptureError::Spawn(std::io::Error::from(std::io::ErrorKind::NotFound)),
        "glab",
        "glab missing",
        &probe,
    ));
    assert_eq!(error, "glab missing");
    assert!(!probe.is_cached(), "NotFound drops the probe");

    let error = map_capture_error(
        CaptureError::ReaderStart {
            stream: "stdout",
            source: std::io::Error::other("nope"),
        },
        "glab",
        "glab missing",
        &probe,
    );
    assert!(
        matches!(error, super::super::CliError::Capture { tool: "glab", .. }),
        "{error:?}"
    );
    let error = String::from(error);
    assert!(
        error.starts_with("glab failed to start the stdout reader"),
        "{error}"
    );
}

/// An oversized provider-CLI output (a PR diff past its cap) must reach IPC as
/// `outputTooLarge`, not a `commandFailed` string the UI cannot tell apart —
/// through both the classified path (`from_command`) and the direct one.
#[test]
fn an_oversized_capture_crosses_ipc_as_output_too_large() {
    use super::super::capture;
    use super::support::{child_stdout_prefix, fake_command};
    use crate::git::forge::GithubError;
    use crate::git::types::{CommandError, CommandErrorKind};

    let oversized = || {
        let limit = child_stdout_prefix().len() + 16;
        let error = capture(&mut fake_command("stdout", 4096), limit, 1024).unwrap_err();
        map_capture_error(error, "gh", "gh missing", &ProbeCell::<()>::new())
    };
    for error in [
        GithubError::from_command("pull request diff", oversized()),
        GithubError::from(oversized()),
    ] {
        let ipc = CommandError::from(error);
        assert_eq!(ipc.kind, CommandErrorKind::Forge);
        assert_eq!(ipc.code.as_deref(), Some("outputTooLarge"), "{ipc:?}");
    }
}
