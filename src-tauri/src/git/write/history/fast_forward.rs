//! Fast-forwarding HEAD, or a branch that is not checked out, to a target.

use super::super::branches::resolve_rev;
use super::super::cli::run_git;
use super::super::head::{
    current_branch, ensure_commit_exists, ensure_expected_branch_tip, ensure_expected_head,
};

/// Fast-forward the explicit local branch from the oid the user saw to a
/// captured target oid. The backend chooses the checked-out/non-checked-out
/// mechanism from live Git state, never from a stale frontend HEAD snapshot.
pub fn fast_forward_branch_at(
    repo: &str,
    branch: &str,
    expected_branch_oid: &str,
    target_oid: &str,
) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    fast_forward_branch_at_locked(repo, branch, expected_branch_oid, target_oid)
}

/// Fast-forward body for callers that already hold `lock_index_writes`
/// (remote-branch checkout).
pub(in crate::git::write) fn fast_forward_branch_at_locked(
    repo: &str,
    branch: &str,
    expected_branch_oid: &str,
    target_oid: &str,
) -> Result<String, String> {
    ensure_expected_branch_tip(repo, branch, expected_branch_oid)?;
    ensure_commit_exists(repo, target_oid)?;
    if current_branch(repo).as_deref() == Some(branch) {
        ensure_expected_head(repo, Some(branch), Some(expected_branch_oid))?;
        return run_git(repo, &["merge", "--ff-only", target_oid]);
    }

    // A branch checked out in a linked worktree cannot be moved as a bare ref:
    // doing so leaves that worktree's index and files at the old commit, which
    // immediately appears as staged changes. Advance it inside its owning
    // worktree so Git updates HEAD, index, and files together (and preserves
    // Git's dirty-worktree refusal).
    if let Some(owner) = super::super::worktrees::worktrees(repo)?
        .into_iter()
        .find(|worktree| {
            worktree.branch.as_deref() == Some(branch) && !worktree.bare && !worktree.prunable
        })
    {
        ensure_expected_head(&owner.path, Some(branch), Some(expected_branch_oid))?;
        return run_git(&owner.path, &["merge", "--ff-only", target_oid]);
    }

    let destination = format!("refs/heads/{branch}");
    if resolve_rev(repo, &destination)? == resolve_rev(repo, target_oid)? {
        return Ok("Already up to date.".to_string());
    }
    if run_git(
        repo,
        &[
            "merge-base",
            "--is-ancestor",
            expected_branch_oid,
            target_oid,
        ],
    )
    .is_err()
    {
        return Err(format!(
            "Cannot fast-forward {branch}: the target is not a descendant of its expected tip."
        ));
    }
    // Compare-and-swap the ref so even a branch move between the precondition
    // check and this write cannot be overwritten.
    run_git(
        repo,
        &["update-ref", &destination, target_oid, expected_branch_oid],
    )
}
