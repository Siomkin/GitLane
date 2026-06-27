//! Shared real-`git` subprocess helpers.

use std::io::Write;
use std::process::{Command, Stdio};

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

    if output.status.success() {
        Ok(format!("{stdout}{stderr}").trim().to_string())
    } else {
        Err(format!("{stdout}{stderr}").trim().to_string())
    }
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

    if output.status.success() {
        Ok(format!("{stdout}{stderr}").trim().to_string())
    } else {
        Err(format!("{stdout}{stderr}").trim().to_string())
    }
}

/// Run `git <args>` **without** `-C <repo>`, for operations that act outside an
/// existing repository (clone into a new dir, init a fresh repo). PATH is
/// augmented exactly like [`run_git`]. Returns combined stdout/stderr on success
/// or the error output on a non-zero exit.
pub(super) fn run_git_bare(args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).env("PATH", crate::shell::path());

    let output = cmd
        .output()
        .map_err(|e| format!("failed to launch git: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(format!("{stdout}{stderr}").trim().to_string())
    } else {
        Err(format!("{stdout}{stderr}").trim().to_string())
    }
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
