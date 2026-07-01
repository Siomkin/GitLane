//! Active merge/rebase/cherry-pick/revert state reads.

use git2::{Repository, RepositoryState};

use crate::git::handoff;
use crate::git::read::open;
use crate::git::types::OperationStatus;

use super::files::conflict_files;

/// Map libgit2's `RepositoryState` to the operation key the frontend expects.
/// Anything that isn't a merge/rebase/cherry-pick/revert (Clean, Bisect,
/// ApplyMailbox, …) reports "none" — the conflict workflow only covers the
/// operations GitLane can drive to completion.
fn operation_kind(state: RepositoryState) -> &'static str {
    match state {
        RepositoryState::Merge => "merge",
        RepositoryState::Revert | RepositoryState::RevertSequence => "revert",
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => "cherry-pick",
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => "rebase",
        _ => "none",
    }
}

/// The active operation (if any) plus its outstanding conflicts.
pub fn operation_status(path: &str) -> Result<OperationStatus, git2::Error> {
    let mut repo = open(path)?;
    let mut kind = operation_kind(repo.state());
    // A worktree-handoff carry (GL-74) leaves unmerged index entries but no
    // sequencer state (`RepositoryState::Clean`), so libgit2 reports "none".
    // Recognise it from the handoff marker — but gate on the marker's recovery
    // stashes still being on the stack, NOT on `has_conflicts()`. Two reasons:
    //   * Staging the last carry conflict clears the index conflicts; keying off
    //     `has_conflicts()` would drop the operation right then and remove "Finish
    //     carry" before it can drop those stashes / clear the marker (GL-74 P1).
    //   * A stale marker (carry finished/aborted outside the app) whose stashes
    //     are gone must NOT hijack a later unrelated conflict — so we self-heal it.
    if kind == "none" {
        if let Some(marker) = handoff::read_marker(repo.path()) {
            if carry_stashes_live(&mut repo, &marker) {
                kind = handoff::CARRY_KIND;
            } else {
                handoff::clear_marker(repo.path());
            }
        }
    }
    // Conflicts can exist only inside an operation; skip the index walk for a
    // clean repo so the common case stays cheap.
    let conflicts = if kind == "none" {
        Vec::new()
    } else {
        conflict_files(&repo)?
    };
    Ok(OperationStatus {
        kind: kind.to_string(),
        can_skip: matches!(kind, "rebase" | "cherry-pick" | "revert"),
        conflicts,
    })
}

/// True when at least one stash oid recorded in the handoff `marker` is still on
/// the stack — i.e. the carry's recovery stashes exist and the marker is live.
/// A marker whose stashes are all gone is stale (finished/aborted/dropped outside
/// the app) and must not be treated as an active carry.
fn carry_stashes_live(repo: &mut Repository, marker: &str) -> bool {
    let wanted: Vec<String> = marker
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    if wanted.is_empty() {
        return false;
    }
    let mut present = false;
    // `stash_foreach` walks `refs/stash`; the oid is the stash commit — exactly
    // what the marker recorded (`rev-parse refs/stash`). Stop at the first match.
    let _ = repo.stash_foreach(|_index, _message, oid| {
        if wanted.iter().any(|w| w == &oid.to_string()) {
            present = true;
            false
        } else {
            true
        }
    });
    present
}
