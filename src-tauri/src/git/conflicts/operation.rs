//! Active merge/rebase/cherry-pick/revert state reads.

use git2::{Repository, RepositoryState};

use crate::git::handoff;
use crate::git::read::open;
use crate::git::types::{OperationAdvisory, OperationKind, OperationStatus};

use super::files::conflict_files;

/// Map libgit2's `RepositoryState` to the operation key the frontend expects.
/// Anything that isn't a merge/rebase/cherry-pick/revert (Clean, Bisect,
/// ApplyMailbox, …) reports [`OperationKind::None`] — the conflict workflow
/// only covers the operations GitLane can drive to completion.
/// Non-drivable-but-active states (`git am`, bisect) are surfaced separately
/// via [`advisory_kind`].
fn operation_kind(state: RepositoryState) -> OperationKind {
    match state {
        RepositoryState::Merge => OperationKind::Merge,
        RepositoryState::Revert | RepositoryState::RevertSequence => OperationKind::Revert,
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => {
            OperationKind::CherryPick
        }
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => OperationKind::Rebase,
        _ => OperationKind::None,
    }
}

/// Map the non-drivable-but-active states to a read-only advisory. GitLane
/// can't drive `git am` or bisect to completion, but it must not pretend the
/// repo is clean either — the frontend shows a read-only banner pointing the
/// user at the terminal. `ApplyMailboxOrRebase` is git's ambiguous "am or
/// rebase" state; treat it as apply-mailbox since the drivable rebase states
/// above are matched first.
fn advisory_kind(state: RepositoryState) -> OperationAdvisory {
    match state {
        RepositoryState::ApplyMailbox | RepositoryState::ApplyMailboxOrRebase => {
            OperationAdvisory::ApplyMailbox
        }
        RepositoryState::Bisect => OperationAdvisory::Bisect,
        _ => OperationAdvisory::None,
    }
}

/// The active operation (if any) plus its outstanding conflicts.
pub fn operation_status(path: &str) -> Result<OperationStatus, git2::Error> {
    let mut repo = open(path)?;
    let state = repo.state();
    let mut kind = operation_kind(state);
    // Read-only advisory (git am / bisect); independent of the drivable `kind`.
    let advisory = advisory_kind(state);
    // A worktree-handoff carry (GL-74) leaves unmerged index entries but no
    // sequencer state (`RepositoryState::Clean`), so libgit2 reports "none".
    // Recognise it from the handoff marker — but gate on the marker's recovery
    // stashes still being on the stack, NOT on `has_conflicts()`. Two reasons:
    //   * Staging the last carry conflict clears the index conflicts; keying off
    //     `has_conflicts()` would drop the operation right then and remove "Finish
    //     carry" before it can drop those stashes / clear the marker (GL-74 P1).
    //   * A stale marker (carry finished/aborted outside the app) whose stashes
    //     are gone must NOT hijack a later unrelated conflict — so we self-heal it.
    if kind == OperationKind::None {
        if let Some(marker) = handoff::read_marker(repo.path()) {
            if carry_stashes_live(&mut repo, &marker) {
                kind = OperationKind::Carry;
            } else {
                handoff::clear_marker(repo.path());
            }
        }
    }
    // Conflicts can exist only inside an operation; skip the index walk for a
    // clean repo so the common case stays cheap.
    let conflicts = if kind == OperationKind::None {
        Vec::new()
    } else {
        conflict_files(&repo)?
    };
    Ok(OperationStatus {
        kind,
        can_skip: matches!(
            kind,
            OperationKind::Rebase | OperationKind::CherryPick | OperationKind::Revert
        ),
        advisory,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drivable_states_map_to_their_kind_and_no_advisory() {
        for (state, kind) in [
            (RepositoryState::Merge, OperationKind::Merge),
            (RepositoryState::Revert, OperationKind::Revert),
            (RepositoryState::RevertSequence, OperationKind::Revert),
            (RepositoryState::CherryPick, OperationKind::CherryPick),
            (
                RepositoryState::CherryPickSequence,
                OperationKind::CherryPick,
            ),
            (RepositoryState::Rebase, OperationKind::Rebase),
            (RepositoryState::RebaseInteractive, OperationKind::Rebase),
            (RepositoryState::RebaseMerge, OperationKind::Rebase),
        ] {
            assert_eq!(operation_kind(state), kind);
            assert_eq!(advisory_kind(state), OperationAdvisory::None);
        }
    }

    #[test]
    fn non_drivable_states_map_to_a_read_only_advisory_not_a_kind() {
        // git am / bisect are surfaced as read-only advisories, never as a
        // drivable operation `kind` (which stays "none").
        for (state, advisory) in [
            (
                RepositoryState::ApplyMailbox,
                OperationAdvisory::ApplyMailbox,
            ),
            (
                RepositoryState::ApplyMailboxOrRebase,
                OperationAdvisory::ApplyMailbox,
            ),
            (RepositoryState::Bisect, OperationAdvisory::Bisect),
        ] {
            assert_eq!(operation_kind(state), OperationKind::None);
            assert_eq!(advisory_kind(state), advisory);
        }
    }

    #[test]
    fn a_clean_repo_has_neither_kind_nor_advisory() {
        assert_eq!(operation_kind(RepositoryState::Clean), OperationKind::None);
        assert_eq!(
            advisory_kind(RepositoryState::Clean),
            OperationAdvisory::None
        );
    }

    #[test]
    fn operation_status_serializes_to_the_wire_words() {
        // "cherry-pick" is the one value where the kebab-case rename is
        // non-trivial; the clean case pins the advisory's empty-string
        // sentinel. "carry" and "apply-mailbox" pin GitLane's own compounds.
        for (kind, word) in [
            (OperationKind::Merge, "merge"),
            (OperationKind::Rebase, "rebase"),
            (OperationKind::CherryPick, "cherry-pick"),
            (OperationKind::Revert, "revert"),
            (OperationKind::Carry, "carry"),
            (OperationKind::None, "none"),
        ] {
            let status = OperationStatus {
                kind,
                can_skip: false,
                conflicts: Vec::new(),
                advisory: OperationAdvisory::None,
            };
            assert_eq!(serde_json::to_value(&status).unwrap()["kind"], word);
        }
        let status = OperationStatus {
            kind: OperationKind::None,
            can_skip: false,
            conflicts: Vec::new(),
            advisory: OperationAdvisory::ApplyMailbox,
        };
        let wire = serde_json::to_value(&status).unwrap();
        assert_eq!(wire["advisory"], "apply-mailbox");

        let clean = OperationStatus {
            kind: OperationKind::None,
            can_skip: false,
            conflicts: Vec::new(),
            advisory: OperationAdvisory::None,
        };
        assert_eq!(serde_json::to_value(&clean).unwrap()["advisory"], "");
    }
}
