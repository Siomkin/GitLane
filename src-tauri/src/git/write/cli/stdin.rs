//! Run git with caller-supplied stdin.

use std::io::Write;
use std::process::Stdio;

use super::command::{git_command, launch_error};
use super::finish::finish;

/// Run `git -C <repo> <args...>` with `input` connected to stdin.
pub(in crate::git::write) fn run_git_with_input(
    repo: &str,
    args: &[&str],
    input: &str,
) -> Result<String, String> {
    let mut cmd = git_command(repo)?;
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(launch_error)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| format!("failed to write git stdin: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("failed to wait for git: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    finish(output.status, &stdout, &stderr, args)
}
