use std::process::Command;

use super::super::bounded_output::{self, DEFAULT_STDOUT_LIMIT, STDERR_LIMIT};
use super::super::domain::GithubRepository;
use super::repo_selector::repo_selector;
use crate::git::tool_probes::TOOL_PROBES;

/// Run `gh <args...>` in `workdir`. When `token` is set it is exported as the
/// auth token, pinning the call to a specific account. Returns stdout on
/// success or a readable error (including the gh-not-installed case).
pub(super) fn gh_command(workdir: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new("gh");
    cmd.current_dir(workdir).args(args);
    // macOS GUI apps launch with a minimal PATH that excludes Homebrew's
    // `/opt/homebrew/bin`, where `gh` typically lives. Use the augmented PATH so
    // the binary is found regardless of how the app was started.
    cmd.env("PATH", crate::shell::path());
    // gh infers repository/host context from cwd. Inherited GIT_DIR and its
    // siblings would override that directory and could route an authenticated
    // command to another repository or provider host.
    crate::git::clear_repository_local_env(&mut cmd);
    crate::shell::hide_console(&mut cmd);
    cmd
}

pub(in crate::git::forge) fn run_gh(
    workdir: &str,
    args: &[&str],
    token: Option<&str>,
) -> Result<String, String> {
    run_gh_with_limit(workdir, args, token, DEFAULT_STDOUT_LIMIT)
}

/// Like [`gh_command`], but with the repository and host pinned through the
/// environment `gh` and go-gh extensions honour ahead of git remotes. For the
/// one call that accepts no `--repo` (`gh stack link`), this is what keeps the
/// bound account's token addressed to the repository GitLane validated rather
/// than one the extension derives from `.git/config` — and it overrides any
/// `GH_REPO` / `GH_HOST` GitLane itself inherited from its launching shell.
pub(super) fn gh_command_in_repository(
    workdir: &str,
    repository: &GithubRepository,
    args: &[&str],
) -> Command {
    let mut cmd = gh_command(workdir, args);
    cmd.env("GH_REPO", repo_selector(repository));
    cmd.env("GH_HOST", repository.host.to_string());
    cmd
}

pub(in crate::git::forge) fn run_gh_in_repository(
    workdir: &str,
    repository: &GithubRepository,
    args: &[&str],
    token: Option<&str>,
) -> Result<String, String> {
    let cmd = gh_command_in_repository(workdir, repository, args);
    run_gh_command(cmd, token, DEFAULT_STDOUT_LIMIT)
}

pub(in crate::git::forge) fn run_gh_with_limit(
    workdir: &str,
    args: &[&str],
    token: Option<&str>,
    stdout_limit: usize,
) -> Result<String, String> {
    run_gh_command(gh_command(workdir, args), token, stdout_limit)
}

/// Token export, bounded capture, and redaction for every `gh` invocation —
/// one place, whichever builder produced the command.
fn run_gh_command(
    mut cmd: Command,
    token: Option<&str>,
    stdout_limit: usize,
) -> Result<String, String> {
    if let Some(t) = token {
        // gh reads GH_TOKEN for github.com / *.ghe.com hosts and
        // GH_ENTERPRISE_TOKEN for GitHub Enterprise Server hosts, consulting only
        // the one that matches the operative host and ignoring the other. Export
        // the bound-account token under both names so the call stays pinned to
        // that account on every host; otherwise GHES requests silently fall back
        // to gh's stored credentials and run as the wrong user.
        cmd.env("GH_TOKEN", t);
        cmd.env("GH_ENTERPRISE_TOKEN", t);
    }

    let output =
        bounded_output::capture(&mut cmd, stdout_limit, STDERR_LIMIT).map_err(|error| {
            bounded_output::map_capture_error(error, "gh", GH_NOT_FOUND, &TOOL_PROBES.gh)
        })?;

    bounded_output::finish(output, token)
}

pub(super) const GH_NOT_FOUND: &str =
    "GitHub CLI (gh) not found on PATH — install it from https://cli.github.com to use pull requests.";
