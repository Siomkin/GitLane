//! Run git with caller-supplied stdin.

use std::io::Write;
use std::process::{Output, Stdio};

use super::command::{git_command, launch_error};
use super::finish::finish;

/// Run `git -C <repo> <args...>` with `input` connected to stdin.
pub(in crate::git::write) fn run_git_with_input(
    repo: &str,
    args: &[&str],
    input: &str,
) -> Result<String, String> {
    run_git_with_bytes(repo, args, input.as_bytes())
}

/// Like [`run_git_with_input`] but for input that is not necessarily UTF-8.
///
/// A patch is file content, so it can hold any byte sequence — a Latin-1 byte,
/// a lone CR — and passing it as `&str` would mean it had already been through
/// a lossy conversion. `git apply` reads bytes; so does this.
pub(in crate::git::write) fn run_git_with_bytes(
    repo: &str,
    args: &[&str],
    input: &[u8],
) -> Result<String, String> {
    let output = output_with_bytes(repo, args, input)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    finish(output.status, &stdout, &stderr, args)
}

/// Like [`run_git_with_input`] but returning stdout alone, for values that must
/// not pick up a warning git wrote to stderr.
pub(in crate::git::write) fn run_git_stdout_with_input(
    repo: &str,
    args: &[&str],
    input: &str,
) -> Result<String, String> {
    let output = output_with_bytes(repo, args, input.as_bytes())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    finish(output.status, &stdout, &stderr, args)
}

fn output_with_bytes(repo: &str, args: &[&str], input: &[u8]) -> Result<Output, String> {
    let mut cmd = git_command(repo)?;
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(launch_error)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input)
            .map_err(|e| format!("failed to write git stdin: {e}"))?;
    }

    child
        .wait_with_output()
        .map_err(|e| format!("failed to wait for git: {e}"))
}
