//! Guarded soft, mixed, and hard reset writes.

use super::branches::qualify_branch_if_ambiguous;
use super::cli::run_git;
use super::head::{checkout_expected_branch, ensure_commit_exists, ensure_expected_head};
use super::operands::ensure_operand;

/// Reset the current branch to `target`. `mode` is one of soft|mixed|hard.
///
/// Like `merge`/`rebase`, a bare `target` that is both a branch and a tag is
/// qualified to `refs/heads/` so the reset lands on the branch rather than the
/// tag git's rev resolution would otherwise pick first.
pub fn reset(repo: &str, target: &str, mode: &str) -> Result<String, String> {
    ensure_operand(target)?;
    let flag = match mode {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    let target = qualify_branch_if_ambiguous(repo, target);
    run_git(repo, &["reset", flag, &target])
}

/// Reset the explicit source branch/HEAD snapshot to a captured target oid.
/// Named branches are checked out and revalidated inside this backend call.
pub fn reset_branch(
    repo: &str,
    source: Option<&str>,
    expected_source_oid: Option<&str>,
    target_oid: &str,
    mode: &str,
) -> Result<String, String> {
    match (source, expected_source_oid) {
        (Some(branch), Some(oid)) => checkout_expected_branch(repo, branch, oid)?,
        (None, oid) => ensure_expected_head(repo, None, oid)?,
        (Some(_), None) => {
            return Err("The branch has no expected commit. Refresh and try again.".to_string())
        }
    }
    ensure_commit_exists(repo, target_oid)?;
    reset(repo, target_oid, mode)
}
