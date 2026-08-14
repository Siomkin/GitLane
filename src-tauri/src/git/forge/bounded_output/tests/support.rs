//! Shared fixtures: the command that re-enters this binary as the fake CLI
//! child, and the libtest prefix its stdout carries.

use std::process::Command;

use super::super::capture;

pub(super) const CHILD_MODE: &str = "GITLANE_BOUNDED_OUTPUT_CHILD_MODE";
pub(super) const CHILD_SIZE: &str = "GITLANE_BOUNDED_OUTPUT_CHILD_SIZE";

pub(super) fn fake_command(mode: &str, size: usize) -> Command {
    let mut command = Command::new(std::env::current_exe().expect("current test executable"));
    command
        .args([
            "--exact",
            "git::forge::bounded_output::tests::fake_cli_child",
            "--quiet",
        ])
        .env(CHILD_MODE, mode)
        .env(CHILD_SIZE, size.to_string());
    command
}

pub(super) fn child_stdout_prefix() -> Vec<u8> {
    // libtest writes a small platform-dependent prefix before invoking the
    // selected test. Capture it dynamically so byte-limit assertions stay
    // exact across harness versions and newline conventions.
    capture(&mut fake_command("stdout", 0), 1024, 1024)
        .unwrap()
        .stdout
}
