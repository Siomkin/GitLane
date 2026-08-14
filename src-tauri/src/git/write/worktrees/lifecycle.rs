//! Creating, removing, and validating linked worktrees — including the
//! combined branch-and-worktree deletion.

use std::path::Path;

use super::super::cli::run_git;
use super::super::operands::{ensure_operand, ensure_opt};
use super::list::worktrees;
use super::paths::same_path;

/// Create a new linked worktree at `worktree_path`.
///
/// With `new_branch` set, a fresh branch of that name is created at `reference`
/// (its start point, defaulting to HEAD) and checked out there in one step
/// (`git worktree add -b <new> <path> <start>`) — git refuses if the branch
/// already exists, surfacing its own error.
///
/// Without `new_branch`, the worktree is checked out to `reference` directly (a
/// branch, tag, or commit; defaults to HEAD): a commit or tag detaches, an
/// existing branch is checked out (git refuses if it's already checked out
/// elsewhere, surfacing its own error).
pub fn add_worktree(
    repo: &str,
    worktree_path: &str,
    reference: Option<&str>,
    new_branch: Option<&str>,
) -> Result<String, String> {
    ensure_operand(worktree_path)?;
    ensure_opt(reference)?;
    ensure_opt(new_branch)?;
    match (new_branch, reference) {
        // `-b <new> <path> <start>` — create the branch at its start point.
        (Some(branch), Some(start)) => run_git(
            repo,
            &["worktree", "add", "-b", branch, worktree_path, start],
        ),
        (Some(branch), None) => run_git(repo, &["worktree", "add", "-b", branch, worktree_path]),
        (None, Some(r)) => run_git(repo, &["worktree", "add", worktree_path, r]),
        (None, None) => run_git(repo, &["worktree", "add", worktree_path]),
    }
}

/// Create and check out a branch in an existing detached worktree.
///
/// The menu captures the worktree's path and HEAD oid. Re-read the registered
/// worktree state and validate its detached HEAD before mutating so an external
/// checkout cannot redirect this action to a different commit or branch.
/// `git switch -c` performs the ref creation and checkout as one logical git
/// operation, avoiding a branch-created-but-not-checked-out partial result.
pub fn create_branch_in_worktree(
    repo: &str,
    worktree_path: &str,
    name: &str,
    expected_oid: &str,
) -> Result<String, String> {
    ensure_operand(worktree_path)?;
    ensure_operand(name)?;
    ensure_operand(expected_oid)?;

    let worktree = worktrees(repo)?
        .into_iter()
        .find(|worktree| same_path(&worktree.path, worktree_path))
        .ok_or_else(|| {
            format!("No worktree is registered at {worktree_path} anymore. Refresh and try again.")
        })?;
    if worktree.bare {
        return Err("A bare repository has no working tree to attach a branch to.".into());
    }
    if worktree.prunable {
        return Err("The worktree's directory is missing. Refresh and try again.".into());
    }
    if let Some(branch) = worktree.branch {
        return Err(format!(
            "The worktree is no longer detached; it has {branch} checked out. Refresh and try again."
        ));
    }
    if worktree.head.as_deref() != Some(expected_oid) {
        return Err("The worktree's HEAD changed. Refresh and try again.".into());
    }

    let _index_guard = super::super::index_lock::lock_index_writes(worktree_path)?;
    // Checked under the lock: a concurrent checkout must not redirect the
    // new branch onto a different detached HEAD than the menu captured.
    super::super::head::ensure_expected_head(worktree_path, None, Some(expected_oid))?;
    run_git(worktree_path, &["switch", "-c", name])?;
    Ok(format!("Created {name} in worktree {}", worktree.name))
}

/// Remove a linked worktree (`git worktree remove <path>`) after the Worktree
/// Removal Lease still matches (GL-303). Force is **server-derived** from the
/// validated dirty+locked state — execute takes no client `force` flag. A locked
/// worktree needs a second `--force` (`-f -f`). Git refuses the main worktree;
/// the frontend also hides that action.
pub fn remove_worktree(
    repo: &str,
    worktree_path: &str,
    expected_state: &str,
) -> Result<String, String> {
    ensure_operand(worktree_path)?;
    // Lease check immediately before spawn. Forced `git worktree remove` can
    // still delete dirt that appears after this returns and before git finishes
    // — an accepted residual TOCTOU: git offers no atomic compare-and-remove, so
    // validation can only be a precondition. The combined path stays unforced,
    // which leaves git itself rechecking dirtiness and locks there.
    let snapshot = super::super::worktree_removal_lease::validate_removal_lease(
        repo,
        worktree_path,
        expected_state,
    )?;
    // Force flags come only from the matched lease — never a post-match lock
    // re-read that could escalate beyond what the confirm disclosed.
    remove_worktree_validated(
        repo,
        &snapshot.workdir,
        snapshot.requires_force,
        snapshot.locked,
    )?;
    Ok(format!("Removed worktree {worktree_path}"))
}

/// Internal remove after the lease (or an equivalent unforced combined-path
/// refuse) has already decided whether force is required. `locked` must be the
/// leased lock bit: a second `--force` overrides git's lock only when that
/// state was part of the matched snapshot.
///
/// `workdir` must be the canonical path the lease was *validated* over
/// (`RemovalLeaseSnapshot::workdir`), never the caller's raw pathname: the two
/// can diverge if the client path is a symlink that is retargeted after the
/// compare, and git would then delete a directory nobody confirmed.
fn remove_worktree_validated(
    repo: &str,
    workdir: &Path,
    force: bool,
    locked: bool,
) -> Result<(), String> {
    let operand = workdir.to_str().ok_or_else(|| {
        format!("The worktree path {workdir:?} is not valid UTF-8, so git cannot be given it.")
    })?;
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
        if locked {
            args.push("--force");
        }
    }
    args.push(operand);
    run_git(repo, &args)?;
    Ok(())
}

/// Why Combined Branch-and-Worktree Deletion refuses instead of forcing: it is
/// deliberately unforced (GL-303), so dirty or locked contents are the user's to
/// resolve. Shared by both of its lease checks so the two cannot drift apart.
const COMBINED_FORCE_REFUSAL: &str = "The worktree has uncommitted work or is locked. Combined branch-and-worktree deletion cannot force-remove it. Remove the worktree separately, or clean it first.";

/// Re-check the Worktree Removal Lease and, on a still-matching unforced lease,
/// remove the worktree in one step — so nothing but `run_git` runs between the
/// compare and the spawn. Used by the combined path, whose entry-time validation
/// is separated from the removal by the branch-deletion preparation.
fn revalidate_then_remove(
    repo: &str,
    worktree_path: &str,
    expected_state: &str,
) -> Result<(), String> {
    let lease = super::super::worktree_removal_lease::validate_removal_lease(
        repo,
        worktree_path,
        expected_state,
    )?;
    if lease.requires_force {
        return Err(COMBINED_FORCE_REFUSAL.into());
    }
    remove_worktree_validated(repo, &lease.workdir, false, false)
}

/// Re-read the worktree list and confirm `from_worktree_path` is still registered
/// and still has `branch` checked out. The frontend captures the path when its
/// menu opens; an external `git worktree`/checkout in between could move the
/// branch elsewhere (or detach that worktree), so verify against live state and
/// fail closed *before* removing/detaching anything — otherwise we could destroy
/// a clean, unrelated worktree and delete the branch regardless.
pub(super) fn ensure_worktree_has_branch(
    repo: &str,
    from_worktree_path: &str,
    branch: &str,
) -> Result<(), String> {
    match worktrees(repo)?
        .into_iter()
        .find(|w| same_path(&w.path, from_worktree_path))
    {
        Some(w) if w.branch.as_deref() == Some(branch) => Ok(()),
        Some(_) => Err(format!(
            "{branch} is no longer checked out at {from_worktree_path}. Refresh and try again."
        )),
        None => Err(format!(
            "No worktree is registered at {from_worktree_path} anymore. Refresh and try again."
        )),
    }
}

/// The destination must be a real, registered worktree of this repo, distinct
/// from the source, and one a branch can actually be checked out into — verified
/// against live state before we detach anything. A bare repo (no working tree) or
/// a prunable worktree (directory gone) would fail the checkout after we'd already
/// detached the source, so reject them up front with a clear message.
pub(super) fn ensure_worktree_registered(repo: &str, to: &str, from: &str) -> Result<(), String> {
    if same_path(to, from) {
        return Err("The destination is the same worktree as the source.".into());
    }
    match worktrees(repo)?.into_iter().find(|w| same_path(&w.path, to)) {
        Some(w) if w.bare => Err(
            "The destination is a bare repository — it has no working tree to check the branch out into.".into(),
        ),
        Some(w) if w.prunable => {
            Err("The destination worktree's directory is missing. Refresh and try again.".into())
        }
        Some(_) => Ok(()),
        None => Err(format!(
            "No worktree is registered at {to}. Refresh and try again."
        )),
    }
}

/// Remove the linked worktree at `from_worktree_path`, then delete `branch`.
///
/// Git refuses to delete a branch that is checked out in a worktree, so this is
/// the one-step path for "I'm done with this branch and its worktree": free the
/// branch by removing its worktree, then force-delete the branch. Requires both
/// the branch tip `expected_oid` and the shared Worktree Removal Lease
/// `expected_state` (GL-303). Worktree removal stays **unforced**: a dirty or
/// locked matched lease refuses before removal.
///
/// `progress` is invoked as each phase *begins* (step ids: `removeWorktree`,
/// `deleteBranch`) so the UI can show a live checklist. The command layer
/// forwards them as `delete-worktree-progress` Tauri events; a lost event only
/// degrades the progress UI.
pub fn delete_branch_with_worktree(
    repo: &str,
    branch: &str,
    from_worktree_path: &str,
    expected_oid: &str,
    expected_state: &str,
    progress: &dyn Fn(&'static str),
) -> Result<String, String> {
    ensure_operand(branch)?;
    ensure_operand(from_worktree_path)?;
    ensure_worktree_has_branch(repo, from_worktree_path, branch)?;

    // Validate the worktree lease before preparing the branch deletion so a
    // stale confirm cannot start a ref transaction against drifted contents.
    let worktree_lease = super::super::worktree_removal_lease::validate_removal_lease(
        repo,
        from_worktree_path,
        expected_state,
    )?;
    if worktree_lease.requires_force {
        return Err(COMBINED_FORCE_REFUSAL.into());
    }
    if worktree_lease.branch.as_deref() != Some(branch) {
        return Err(format!(
            "{branch} is no longer checked out at {from_worktree_path}. Refresh and try again."
        ));
    }

    // Lock the exact previewed branch tip before removing its checkout. A stale
    // tip fails during `prepare`, while both the branch and worktree still
    // exist. The transaction stays prepared across the unforced removal and is
    // aborted if that removal refuses (dirty/locked/missing worktree).
    let deletion = super::super::branches::prepare_branch_deletion(repo, branch, expected_oid)?;
    super::super::branches::ensure_branch_ref_is_direct(repo, branch)?;
    ensure_worktree_has_branch(repo, from_worktree_path, branch)?;
    progress("removeWorktree");
    // Re-validate immediately before the spawn. The entry-time check guards the
    // ref transaction, but `prepare_branch_deletion` and the ownership re-reads
    // above each run a git subprocess — a path-reuse/ABA swap in that window
    // would otherwise remove a *replacement* worktree the confirm never leased,
    // which is the exact failure GL-303 exists to close.
    if let Err(error) = revalidate_then_remove(repo, from_worktree_path, expected_state) {
        let abort_error = deletion.abort().err();
        return Err(match abort_error {
            Some(abort) => format!(
                "{error}\nThe prepared branch deletion also could not close cleanly: {abort}"
            ),
            None => error,
        });
    }
    progress("deleteBranch");
    // The prepared ref lock does not stop another worktree from checking out
    // this branch. Re-read ownership after the source removal and abort the ref
    // transaction if another checkout claimed it in that window.
    if let Err(error) = super::super::branches::ensure_branch_not_checked_out(repo, branch) {
        let abort_error = deletion.abort().err();
        let abort_note = abort_error
            .map(|abort| format!(" The prepared deletion also could not close cleanly: {abort}"))
            .unwrap_or_default();
        return Err(format!(
            "Removed worktree {from_worktree_path}, but preserved branch {branch} because it became checked out elsewhere: {error}.{abort_note} Refresh before trying again."
        ));
    }
    deletion.commit().map_err(|error| {
        format!(
            "Removed worktree {from_worktree_path}, but Git could not commit deletion of branch {branch}: {error}. The branch may still exist; refresh before taking another action."
        )
    })?;
    let branch_message = super::super::branches::deleted_branch_message(repo, branch);
    if branch_message == format!("Deleted {branch}") {
        Ok(format!("Deleted {branch} and its worktree"))
    } else {
        Ok(format!(
            "Deleted {branch} and its worktree. {branch_message}"
        ))
    }
}
