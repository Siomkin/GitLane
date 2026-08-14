//! Locale-stable git diagnostics for pattern-matched output.

use super::runners::run_git_env;

pub(in crate::git::write) fn run_git_env_stable_diagnostics(
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

pub(in crate::git::write) fn run_git_env_stable_diagnostics_redacted(
    repo: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    run_git_env_stable_diagnostics(repo, args, envs)
        .map(|output| crate::redact::redact_secrets(&output))
}
