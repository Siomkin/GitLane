//! Deleting a local branch: the preconditions the deletion transaction is
//! wrapped in, and the config cleanup that follows a committed ref removal.

use super::super::cli::{run_git, run_git_allow_exit_codes};
use super::super::operands::ensure_operand;
use super::deletion_transaction::prepare_branch_deletion;
use super::refs::{checked_branch_ref, ensure_canonical_object_id};

pub(in crate::git::write) fn ensure_branch_ref_is_direct(
    repo: &str,
    name: &str,
) -> Result<(), String> {
    let branch_ref = checked_branch_ref(repo, name)?;
    let symbolic_target =
        run_git_allow_exit_codes(repo, &["symbolic-ref", "--quiet", &branch_ref], &[1])?;
    if symbolic_target.trim().is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{branch_ref} became a symbolic ref. Refresh and preview the deletion again."
        ))
    }
}

pub(in crate::git::write) fn ensure_branch_not_checked_out(
    repo: &str,
    name: &str,
) -> Result<(), String> {
    if let Some(owner) = super::super::worktrees::worktrees(repo)?
        .into_iter()
        .find(|worktree| worktree.branch.as_deref() == Some(name))
    {
        return Err(format!(
            "Cannot delete branch {name}: it is checked out at {}.",
            owner.path
        ));
    }
    Ok(())
}

fn ensure_branch_merged(repo: &str, name: &str, expected_oid: &str) -> Result<(), String> {
    let branch_ref = format!("refs/heads/{name}");
    let upstream = run_git(
        repo,
        &[
            "for-each-ref",
            "--format=%(upstream)",
            "--count=1",
            &branch_ref,
        ],
    )?;
    let destination = upstream.lines().next().unwrap_or("").trim();
    let destination = if destination.is_empty() {
        "HEAD"
    } else {
        destination
    };
    if run_git(
        repo,
        &["merge-base", "--is-ancestor", expected_oid, destination],
    )
    .is_err()
    {
        return Err(format!(
            "The branch {name} is not fully merged into {destination}. Use force delete to remove it."
        ));
    }
    Ok(())
}

pub(super) fn cleanup_deleted_branch_config(repo: &str, name: &str) -> Result<(), String> {
    ensure_operand(name)?;
    run_git_allow_exit_codes(
        repo,
        &[
            "config",
            "--local",
            "--remove-section",
            &format!("branch.{name}"),
        ],
        &[128],
    )
    .map(|_| ())
}

pub(in crate::git::write) fn deleted_branch_message(repo: &str, name: &str) -> String {
    match cleanup_deleted_branch_config(repo, name) {
        Ok(()) => format!("Deleted {name}"),
        Err(error) => {
            format!("Deleted {name}, but its local branch settings could not be removed: {error}")
        }
    }
}

/// Delete the exact local branch ref the caller previewed. `force=false`
/// preserves `git branch -d`'s merged-safety check; either mode refuses a
/// checked-out branch and uses a prepared compare-and-swap ref transaction.
pub fn delete_branch(
    repo: &str,
    name: &str,
    expected_oid: &str,
    force: bool,
) -> Result<String, String> {
    checked_branch_ref(repo, name)?;
    ensure_canonical_object_id(repo, expected_oid)?;
    if !force {
        ensure_branch_merged(repo, name, expected_oid)?;
    }

    let deletion = prepare_branch_deletion(repo, name, expected_oid)?;
    ensure_branch_ref_is_direct(repo, name)?;
    ensure_branch_not_checked_out(repo, name)?;
    deletion.commit()?;
    // The ref commit is authoritative. Config cleanup is a secondary hygiene
    // step and must not turn a completed destructive mutation into a reported
    // total failure; preserve the success while surfacing a qualified warning.
    Ok(deleted_branch_message(repo, name))
}
