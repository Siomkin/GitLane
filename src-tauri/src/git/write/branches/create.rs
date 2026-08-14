//! Creating a branch, renaming one, and pointing it at an upstream.

use super::super::cli::run_git;
use super::super::head::ensure_revision_at;
use super::super::operands::ensure_operand;

/// Create a branch `name` at the validated `start_point`, pinned to the
/// `expected_oid` the user saw. The start point is handed to git as the ref
/// the user picked rather than its resolved oid, so branching from a
/// remote-tracking ref keeps git's automatic upstream setup
/// (`branch.autoSetupMerge`).
pub fn create_branch(
    repo: &str,
    name: &str,
    start_point: &str,
    expected_oid: &str,
) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_revision_at(repo, start_point, expected_oid)?;
    run_git(repo, &["branch", name, start_point])
}

/// Rename a branch.
///
/// `-m` (not `-M`) is deliberate: the lowercase form refuses to overwrite an
/// existing branch at `new`, so a rename can never silently clobber another
/// branch's ref. `-M` would force that overwrite — a data-loss risk we don't
/// want behind a plain rename. Callers that need to reuse a name must delete the
/// target branch first.
pub fn rename_branch(repo: &str, old: &str, new: &str) -> Result<String, String> {
    ensure_operand(old)?;
    ensure_operand(new)?;
    run_git(repo, &["branch", "-m", old, new])
}

/// Set the upstream tracking ref for `branch` (`git branch --set-upstream-to`).
/// `upstream` is a remote-tracking ref like `origin/main`; it must already exist.
pub fn set_upstream(repo: &str, branch: &str, upstream: &str) -> Result<String, String> {
    ensure_operand(branch)?;
    ensure_operand(upstream)?;
    let arg = format!("--set-upstream-to={upstream}");
    run_git(repo, &["branch", &arg, branch])
}
