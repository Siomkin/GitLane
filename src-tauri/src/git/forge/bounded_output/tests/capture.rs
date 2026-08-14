//! End-to-end captures of a real child process: limits, concurrency, exit
//! status, and spawn failures.

use std::io;
use std::process::Command;
use std::time::{Duration, Instant};

use super::super::{capture, CaptureError, DEFAULT_STDOUT_LIMIT, DIFF_STDOUT_LIMIT, STDERR_LIMIT};
use super::support::{child_stdout_prefix, fake_command};

#[test]
fn configured_caps_match_the_provider_contract() {
    assert_eq!(DEFAULT_STDOUT_LIMIT, 4 * 1024 * 1024);
    assert_eq!(DIFF_STDOUT_LIMIT, 32 * 1024 * 1024);
    assert_eq!(STDERR_LIMIT, 1024 * 1024);
}

#[test]
fn accepts_the_exact_stdout_limit() {
    let prefix = child_stdout_prefix();
    let payload_size = 4096;
    let limit = prefix.len() + payload_size;
    let output = capture(&mut fake_command("stdout", payload_size), limit, 1024).unwrap();
    assert!(output.status.success());
    assert!(output.stdout.starts_with(&prefix));
    assert_eq!(&output.stdout[prefix.len()..], vec![b'o'; payload_size]);
    assert!(output.stderr.is_empty());
}

#[test]
fn accepts_the_exact_stderr_limit() {
    let prefix = child_stdout_prefix();
    let limit = 4096;
    let output = capture(&mut fake_command("stderr", limit), prefix.len(), limit).unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, prefix);
    assert_eq!(output.stderr, vec![b'e'; limit]);
}

#[test]
fn rejects_limit_plus_one_without_partial_output() {
    let prefix = child_stdout_prefix();
    let payload_size = 4096;
    let limit = prefix.len() + payload_size - 1;
    let error = capture(&mut fake_command("stdout", payload_size), limit, 1024).unwrap_err();
    assert!(matches!(
        error,
        CaptureError::TooLarge {
            stream: "stdout",
            limit: reported
        } if reported == limit
    ));
}

#[test]
fn drains_stdout_and_stderr_concurrently() {
    // This exceeds ordinary pipe capacity on every supported platform. A
    // stdout-to-EOF-then-stderr implementation deadlocks here because the
    // child fills stderr before it can close stdout.
    let prefix = child_stdout_prefix();
    let payload_size = 512 * 1024;
    let stdout_limit = prefix.len() + payload_size;
    let output = capture(
        &mut fake_command("both", payload_size),
        stdout_limit,
        payload_size,
    )
    .unwrap();
    assert!(output.stdout.starts_with(&prefix));
    assert_eq!(&output.stdout[prefix.len()..], vec![b'o'; payload_size]);
    assert_eq!(output.stderr, vec![b'e'; payload_size]);
}

#[test]
fn overflow_kills_and_reaps_a_still_running_child() {
    let limit = 4096;
    let started = Instant::now();
    let error = capture(&mut fake_command("overflow-sleep", limit + 1), limit, 1024).unwrap_err();

    assert!(matches!(
        error,
        CaptureError::TooLarge {
            stream: "stdout",
            ..
        }
    ));
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "overflow must kill rather than wait for the child sleep"
    );
}

#[test]
fn oversized_stderr_truncates_instead_of_failing_a_successful_call() {
    // stderr is discarded on success, so overflowing a stream nobody reads
    // must not fail an operation whose stdout arrived complete — a verbose
    // CLI (`GH_DEBUG=api`) would otherwise break every provider call.
    let prefix = child_stdout_prefix();
    let limit = 2048;
    let output = capture(
        &mut fake_command("stderr", limit + 1),
        prefix.len().max(1),
        limit,
    )
    .unwrap();

    assert!(output.status.success());
    assert_eq!(output.stdout, prefix);
    assert_eq!(output.stderr, vec![b'e'; limit]);
    assert!(output.stderr_truncated);
}

#[test]
fn exact_stderr_limit_is_not_reported_as_truncated() {
    let limit = 2048;
    let output = capture(&mut fake_command("stderr", limit), 4096, limit).unwrap();
    assert_eq!(output.stderr, vec![b'e'; limit]);
    assert!(!output.stderr_truncated);
}

#[test]
fn preserves_exit_status_and_stream_identity() {
    let prefix = child_stdout_prefix();
    let output = capture(&mut fake_command("exit", 0), 1024, 1024).unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.starts_with(&prefix));
    assert_eq!(&output.stdout[prefix.len()..], b"stdout");
    assert_eq!(output.stderr, b"stderr");
}

#[test]
fn missing_cli_is_reported_as_a_not_found_spawn() {
    let mut command = Command::new("gitlane-provider-cli-that-does-not-exist-321");
    let error = capture(&mut command, 1024, 1024).unwrap_err();
    assert!(matches!(
        error,
        CaptureError::Spawn(source) if source.kind() == io::ErrorKind::NotFound
    ));
}
