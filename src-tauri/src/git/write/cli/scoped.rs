//! OS-string git runners pinned to a captured worktree scope.

use std::ffi::OsString;
use std::process::{Output, Stdio};

use super::command::{git_command, launch_error};
use super::finish::{failure_message, finish};

fn scoped_git_os_output(
    repo: &str,
    common_dir: &std::ffi::OsStr,
    args: &[OsString],
) -> Result<Output, String> {
    let mut cmd = git_command(repo)?;
    // `git_command` clears every inherited repository-routing variable first.
    // Restore only the canonical common directory captured by the caller so a
    // mutable linked-worktree `commondir` file cannot redirect this command.
    cmd.env("GIT_COMMON_DIR", common_dir)
        .args(args)
        .stdin(Stdio::null());

    cmd.output().map_err(launch_error)
}

/// Run an OS-string command pinned to an already validated worktree gitdir and
/// common directory. The caller supplies explicit `--git-dir`/`--work-tree`
/// arguments; this helper pins the remaining linked-worktree indirection.
pub(in crate::git::write) fn run_git_scoped_os(
    repo: &str,
    common_dir: &std::ffi::OsStr,
    args: &[OsString],
) -> Result<String, String> {
    let output = scoped_git_os_output(repo, common_dir, args)?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let labels = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let label_refs = labels.iter().map(String::as_str).collect::<Vec<_>>();

    finish(output.status, &stdout, &stderr, &label_refs)
}

/// Raw-stdout companion for NUL-delimited status/path output under the same
/// captured repository scope.
pub(in crate::git::write) fn run_git_scoped_os_stdout_raw(
    repo: &str,
    common_dir: &std::ffi::OsStr,
    args: &[OsString],
) -> Result<Vec<u8>, String> {
    let output = scoped_git_os_output(repo, common_dir, args)?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let labels = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let label_refs = labels.iter().map(String::as_str).collect::<Vec<_>>();
    Err(failure_message(
        output.status,
        &stdout,
        &stderr,
        &label_refs,
    ))
}
