//! Active merge/rebase/cherry-pick/revert state reads.

use git2::RepositoryState;

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
    let repo = open(path)?;
    let kind = operation_kind(repo.state());
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
