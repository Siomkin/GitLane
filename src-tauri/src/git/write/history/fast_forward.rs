//! Fast-forwarding HEAD, or a branch that is not checked out, to a target.

use super::super::branches::resolve_rev;
use super::super::cli::run_git;
use super::super::head::{
    current_branch, ensure_commit_exists, ensure_expected_branch_tip, ensure_expected_head,
};
// Only the test-only entry points guard their operands here; the oid-based
// paths validate through ensure_expected_branch_tip / ensure_commit_exists.
#[cfg(test)]
use super::super::operands::ensure_operand;

/// Fast-forward the current HEAD to `target`. Fails (no merge commit) if the
/// move isn't a fast-forward — callers should only offer this when it is.
#[cfg(test)]
pub fn fast_forward(repo: &str, target: &str) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    ensure_operand(target)?;
    run_git(repo, &["merge", "--ff-only", target])
}

/// Fast-forward a branch that is **not** checked out to `target`, in place,
/// without switching the working tree. `git fetch . <target>:<branch>` updates
/// the local branch ref and — unlike `update-ref` — refuses a non-fast-forward
/// move (no `+` prefix), so it keeps the same FF-only safety as `fast_forward`.
/// Git rejects this on the currently checked-out branch; callers must route the
/// current branch through `fast_forward` instead.
#[cfg(test)]
pub fn fast_forward_branch(repo: &str, branch: &str, target: &str) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    // `git fetch . <target>:<branch>` has no `--` end-of-options guard, so a
    // dash-prefixed target/branch (e.g. `--upload-pack=…`) would be parsed as an
    // option and reach command execution. Reject those operands outright.
    ensure_operand(branch)?;
    ensure_operand(target)?;
    let branch_ref = format!("refs/heads/{branch}");
    if resolve_rev(repo, &branch_ref)? == resolve_rev(repo, target)? {
        return Ok("Already up to date.".to_string());
    }
    run_git(repo, &["fetch", ".", &format!("{target}:{branch}")])
}

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
