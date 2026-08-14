//! Constructing the centralized `git` subprocess.

use std::process::{Command, Output, Stdio};

use super::version::ensure_supported_git;
use crate::git::{clear_repository_local_env, isolated_git_command};

// Stops git's own HTTPS username/password prompts from blocking the app/dev
// terminal. SSH and external askpass helpers have their own prompting paths.
const GIT_TERMINAL_PROMPT_DISABLED: &str = "0";

pub(super) fn git_output(
    repo: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<Output, String> {
    let mut cmd = git_command(repo)?;
    cmd.args(args);
    // GitLane must surface missing credentials through IPC instead of letting
    // git block the dev/app terminal with an invisible password prompt.
    cmd.stdin(Stdio::null());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    // Keep the repository argument authoritative even if a future caller
    // accidentally forwards one of Git's process-global routing variables.
    clear_repository_local_env(&mut cmd);

    cmd.output()
        .map_err(|e| format!("failed to launch git: {e}"))
}

pub(in crate::git::write) fn git_command(repo: &str) -> Result<Command, String> {
    ensure_supported_git()?;
    let mut cmd = isolated_git_command();
    cmd.arg("-C").arg(repo);
    // macOS GUI apps launch with a minimal PATH; use the augmented one so a
    // Homebrew git (and any credential helpers/signing tools it invokes) is found.
    cmd.env("PATH", crate::shell::path());
    cmd.env("GIT_TERMINAL_PROMPT", GIT_TERMINAL_PROMPT_DISABLED);
    clear_repository_local_env(&mut cmd);
    crate::shell::hide_console(&mut cmd);
    Ok(cmd)
}

/// Build a `git <args>` command **without** `-C <repo>` (PATH augmented like
/// [`run_git`]), for operations that act outside an existing repository
/// (clone/init). Callers needing custom stdio/streaming — the clone progress
/// reader — build on this so git subprocess construction stays centralized here;
/// most callers use the buffered [`run_git_bare`].
pub(in crate::git::write) fn git_command_bare(args: &[&str]) -> Result<Command, String> {
    ensure_supported_git()?;
    let mut cmd = isolated_git_command();
    cmd.args(args)
        .env("PATH", crate::shell::path())
        .env("GIT_TERMINAL_PROMPT", GIT_TERMINAL_PROMPT_DISABLED)
        .stdin(Stdio::null());
    clear_repository_local_env(&mut cmd);
    crate::shell::hide_console(&mut cmd);
    Ok(cmd)
}
