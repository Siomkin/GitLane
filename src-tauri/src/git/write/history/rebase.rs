//! Rebasing a source branch onto a captured target commit.

use super::super::head::{ensure_commit_exists, ensure_expected_branch_tip, ensure_expected_head};
use super::super::operands::ensure_operand;
use super::commit_runner::run_commit_git_locked;

/// Rebase `source` onto `onto`.
///
/// Passing both operands to one `git rebase <onto> <source>` process is
/// deliberate: the source branch is part of the write contract instead of
/// depending on whichever branch happens to be checked out when the command
/// starts. Git performs the source checkout itself before replaying commits.
pub fn rebase(
    repo: &str,
    source: &str,
    expected_source_oid: &str,
    onto_oid: &str,
) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    ensure_operand(source)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    let identity_args = super::super::identity::pinned_commit_args(repo)?;
    ensure_commit_exists(repo, onto_oid)?;
    if source == "HEAD" {
        ensure_expected_head(repo, None, Some(expected_source_oid))?;
    } else {
        ensure_expected_branch_tip(repo, source, expected_source_oid)?;
    }
    run_commit_git_locked(repo, &identity_args, &["rebase", onto_oid, source])
}
