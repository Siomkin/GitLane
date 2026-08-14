//! Running a git subprocess under the repo's pinned commit identity.

use super::super::cli::{run_git, run_git_env_stable_diagnostics};

pub(super) fn run_commit_git_locked(
    repo: &str,
    identity_args: &[String],
    command: &[&str],
) -> Result<String, String> {
    let mut args = identity_args.to_vec();
    args.extend(command.iter().map(|arg| (*arg).to_string()));
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_git(repo, &refs)
}

pub(super) fn run_commit_git_stable_locked(
    repo: &str,
    identity_args: &[String],
    command: &[&str],
) -> Result<String, String> {
    let mut args = identity_args.to_vec();
    args.extend(command.iter().map(|arg| (*arg).to_string()));
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_git_env_stable_diagnostics(repo, &refs, &[])
}
