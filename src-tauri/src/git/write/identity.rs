//! Local repository identity configuration.

use super::cli::run_git;

/// Bind a repo's commit identity by writing `user.name`/`user.email` into its
/// local git config, so commits are authored as the associated account.
pub fn set_repo_identity(repo: &str, name: &str, email: &str) -> Result<String, String> {
    run_git(repo, &["config", "--local", "user.name", name])?;
    run_git(repo, &["config", "--local", "user.email", email])?;
    Ok(format!("Identity set to {name} <{email}>"))
}

/// Remove the pinned commit identity from a repo's local git config so it
/// defers to global config again (the "No identity" choice). Best-effort:
/// `--unset` on an already-absent key exits non-zero, which is the desired end
/// state, so unset failures aren't surfaced as errors.
pub fn clear_repo_identity(repo: &str) -> Result<String, String> {
    let _ = run_git(repo, &["config", "--local", "--unset", "user.name"]);
    let _ = run_git(repo, &["config", "--local", "--unset", "user.email"]);
    Ok("Identity cleared".into())
}
