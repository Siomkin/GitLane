//! Shared real-`git` subprocess helpers.

use std::io::Write;
use std::process::{Command, ExitStatus, Stdio};

/// Turn a finished git process into a `Result`, guaranteeing a **non-empty**
/// error message. Some git versions fail a command without writing anything to
/// stdout/stderr — notably git 2.43 (the default on Ubuntu 24.04 LTS / Debian
/// stable) on a failed `stash push` against a locked index. Returning the raw
/// combined output there would surface an *empty* error to the user, so fall
/// back to the exit status when there's nothing else to show.
fn finish(status: ExitStatus, stdout: &str, stderr: &str, args: &[&str]) -> Result<String, String> {
    let combined = format!("{stdout}{stderr}").trim().to_string();
    if status.success() {
        Ok(combined)
    } else if combined.is_empty() {
        let how = status
            .code()
            .map(|c| format!("exit code {c}"))
            .unwrap_or_else(|| "a signal".to_string());
        Err(format!("git {} failed ({how})", args.join(" ")))
    } else {
        Err(combined)
    }
}

/// Run `git -C <repo> <args...>`, returning combined stdout/stderr on success
/// or the error output on a non-zero exit.
pub(super) fn run_git(repo: &str, args: &[&str]) -> Result<String, String> {
    run_git_env(repo, args, &[])
}

/// Like [`run_git`] but with extra environment variables — used to pass a
/// bound account's `GH_TOKEN` through git's credential helper on push.
pub(super) fn run_git_env(
    repo: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).args(args);
    // macOS GUI apps launch with a minimal PATH; use the augmented one so a
    // Homebrew git (and any credential helpers/signing tools it invokes) is found.
    cmd.env("PATH", crate::shell::path());
    for (k, v) in envs {
        cmd.env(k, v);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("failed to launch git: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    finish(output.status, &stdout, &stderr, args)
}

/// Run `git -C <repo> <args...>` with `input` connected to stdin.
pub(super) fn run_git_with_input(repo: &str, args: &[&str], input: &str) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(args)
        .env("PATH", crate::shell::path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch git: {e}"))?;
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

/// Build a `git <args>` command **without** `-C <repo>` (PATH augmented like
/// [`run_git`]), for operations that act outside an existing repository
/// (clone/init). Callers needing custom stdio/streaming — the clone progress
/// reader — build on this so git subprocess construction stays centralized here;
/// most callers use the buffered [`run_git_bare`].
pub(super) fn git_command_bare(args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args).env("PATH", crate::shell::path());
    cmd
}

/// Run `git <args>` **without** `-C <repo>`. Returns combined stdout/stderr on
/// success or the error output on a non-zero exit.
pub(super) fn run_git_bare(args: &[&str]) -> Result<String, String> {
    let output = git_command_bare(args)
        .output()
        .map_err(|e| format!("failed to launch git: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    finish(output.status, &stdout, &stderr, args)
}

pub(super) fn run_git_env_stable_diagnostics(
    repo: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let mut stable_envs = Vec::with_capacity(envs.len() + 2);
    stable_envs.extend_from_slice(envs);
    stable_envs.push(("LC_ALL", "C"));
    stable_envs.push(("LANG", "C"));
    run_git_env(repo, args, &stable_envs)
}

#[cfg(all(test, unix))]
mod tests {
    use super::finish;
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;

    // On unix a raw wait status encodes the exit code in the high byte.
    fn exit(code: i32) -> ExitStatus {
        ExitStatus::from_raw(code << 8)
    }

    #[test]
    fn failed_git_with_no_output_still_yields_a_nonempty_error() {
        // git 2.43 (Ubuntu 24.04 LTS / Debian stable) can fail a command without
        // writing to stdout/stderr; the surfaced error must never be empty or the
        // UI shows a blank failure.
        let err = finish(exit(1), "", "", &["stash", "push"]).unwrap_err();
        assert!(!err.is_empty(), "error must not be empty");
        assert!(err.contains("stash push"), "error should name the command: {err}");
    }

    #[test]
    fn failed_git_prefers_real_stderr_when_present() {
        let err = finish(exit(1), "", "fatal: boom\n", &["stash", "push"]).unwrap_err();
        assert_eq!(err, "fatal: boom");
    }

    #[test]
    fn success_returns_trimmed_combined_output() {
        let out = finish(exit(0), "ok\n", "", &["status"]).unwrap();
        assert_eq!(out, "ok");
    }
}
