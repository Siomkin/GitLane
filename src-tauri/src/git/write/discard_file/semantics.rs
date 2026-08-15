//! Reading a path's index semantics: whether it is staged, deleted,
//! intent-to-add or renamed, and whether a rename's source still matches.

use super::hash::{hash_index_entry, hash_status_entry};
use super::snapshot::{DiscardSemanticSnapshot, IndexPathState};
use std::path::Path;

use git2::{Status, StatusOptions};
use sha2::{Digest, Sha256};

use super::super::cli::run_git_stdout_raw;
use super::super::state_lease::{hash_field, hash_os};

pub(super) fn index_path_state(index: &git2::Index, file: &str) -> IndexPathState {
    let Some(entry) = index.get_path(Path::new(file), 0) else {
        return IndexPathState::Missing;
    };
    let flags = git2::IndexEntryExtendedFlag::from_bits_truncate(entry.flags_extended);
    if entry.id.is_zero() || flags.contains(git2::IndexEntryExtendedFlag::INTENT_TO_ADD) {
        IndexPathState::IntentToAdd
    } else {
        IndexPathState::Present
    }
}

pub(super) fn status_mentions(entry: &git2::StatusEntry<'_>, file: &str) -> bool {
    entry.path().ok() == Some(file)
        || entry.head_to_index().is_some_and(|delta| {
            delta.old_file().path() == Some(Path::new(file))
                || delta.new_file().path() == Some(Path::new(file))
        })
        || entry.index_to_workdir().is_some_and(|delta| {
            delta.old_file().path() == Some(Path::new(file))
                || delta.new_file().path() == Some(Path::new(file))
        })
}

pub(super) fn source_entry_matches(
    entry: &git2::StatusEntry<'_>,
    index: &git2::Index,
    file: &str,
    previous_file: Option<&str>,
    staged: bool,
) -> bool {
    let status = entry.status();
    let entry_path = entry.path().ok().unwrap_or_default();
    let intent_to_add = index_path_state(index, entry_path) == IndexPathState::IntentToAdd;
    let source_present = if staged {
        !intent_to_add
            && status.intersects(
                Status::INDEX_NEW
                    | Status::INDEX_MODIFIED
                    | Status::INDEX_DELETED
                    | Status::INDEX_RENAMED
                    | Status::INDEX_TYPECHANGE,
            )
    } else {
        intent_to_add
            || status.intersects(
                Status::WT_NEW
                    | Status::WT_MODIFIED
                    | Status::WT_DELETED
                    | Status::WT_RENAMED
                    | Status::WT_TYPECHANGE,
            )
    };
    if !source_present {
        return false;
    }

    let is_rename = if staged {
        status.contains(Status::INDEX_RENAMED)
    } else {
        status.contains(Status::WT_RENAMED)
    };
    let delta = if staged {
        entry.head_to_index()
    } else {
        entry.index_to_workdir()
    };
    let target = delta
        .as_ref()
        .and_then(|delta| delta.new_file().path().or_else(|| delta.old_file().path()))
        .or_else(|| entry.path().ok().map(Path::new));
    if target != Some(Path::new(file)) {
        return false;
    }

    match previous_file {
        Some(previous) => {
            is_rename
                && delta.as_ref().and_then(|delta| delta.old_file().path())
                    == Some(Path::new(previous))
        }
        None => !is_rename,
    }
}

pub(super) fn staged_change_has_external_worktree_rename(
    statuses: &git2::Statuses<'_>,
    file: &str,
    previous_file: Option<&str>,
) -> bool {
    let is_operand = |path: Option<&Path>| {
        path.is_some_and(|path| {
            path == Path::new(file)
                || previous_file.is_some_and(|previous| path == Path::new(previous))
        })
    };
    statuses.iter().any(|entry| {
        if !entry.status().contains(Status::WT_RENAMED) {
            return false;
        }
        let Some(delta) = entry.index_to_workdir() else {
            return false;
        };
        let old_inside = is_operand(delta.old_file().path());
        let new_inside = is_operand(delta.new_file().path());
        old_inside != new_inside
    })
}

pub(super) fn hash_semantic_path_state(
    state: &mut Sha256,
    repo: &str,
    has_head: bool,
    index: &git2::Index,
    file: &str,
) -> Result<bool, String> {
    hash_field(state, file.as_bytes());

    // Use real Git for tree membership. Besides honoring partial-clone
    // promisor fetches, a missing/corrupt tree is now an error instead of being
    // misclassified as a staged-new file that the destructive path may remove.
    let head_entry = if has_head {
        run_git_stdout_raw(
            repo,
            &["--literal-pathspecs", "ls-tree", "-z", "HEAD", "--", file],
        )?
    } else {
        Vec::new()
    };
    let in_head = !head_entry.is_empty();
    state.update([u8::from(in_head)]);
    if in_head {
        hash_field(state, &head_entry);
    }

    for stage in 0..=3 {
        hash_index_entry(state, index.get_path(Path::new(file), stage), stage);
    }
    Ok(in_head)
}

pub(super) fn capture_discard_semantics(
    repo: &str,
    file: &str,
    previous_file: Option<&str>,
    staged: bool,
) -> Result<DiscardSemanticSnapshot, String> {
    let repository = git2::Repository::discover(repo)
        .map_err(|error| format!("Could not inspect {file} before discarding it: {error}"))?;
    let workdir = repository
        .workdir()
        .ok_or_else(|| "Cannot discard a file in a bare repository".to_string())?;
    let command_repo = workdir.to_str().ok_or_else(|| {
        "Cannot discard a file from a worktree path that is not valid UTF-8".to_string()
    })?;
    let index = repository.index().map_err(|error| {
        format!("Could not inspect the index before discarding {file}: {error}")
    })?;

    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repository
        .statuses(Some(&mut options))
        .map_err(|error| format!("Could not inspect {file} before discarding it: {error}"))?;

    let involved = previous_file.into_iter().chain(std::iter::once(file));
    for path in involved.clone() {
        let conflicted = (1..=3).any(|stage| index.get_path(Path::new(path), stage).is_some())
            || statuses.iter().any(|entry| {
                entry.status().contains(Status::CONFLICTED) && status_mentions(&entry, path)
            });
        if conflicted {
            return Err(format!(
                "{path} is conflicted. Resolve or abort the operation before discarding this file."
            ));
        }
    }

    if staged && staged_change_has_external_worktree_rename(&statuses, file, previous_file) {
        return Err(format!(
            "The staged change for {file} has an unstaged rename outside this row. Discard the unstaged rename first, then retry the staged change."
        ));
    }

    let source_exists = statuses
        .iter()
        .any(|entry| source_entry_matches(&entry, &index, file, previous_file, staged));
    if !source_exists {
        return Err(format!(
            "The {} change for {file} is no longer available. Refresh and try again.",
            if staged { "staged" } else { "unstaged" }
        ));
    }

    let has_head = match repository.head() {
        Ok(head) => {
            head.peel_to_commit().map_err(|error| {
                format!("Could not inspect HEAD before discarding {file}: {error}")
            })?;
            true
        }
        Err(error) if error.code() == git2::ErrorCode::UnbornBranch => false,
        Err(error) => {
            return Err(format!(
                "Could not inspect HEAD before discarding {file}: {error}"
            ));
        }
    };
    let index_state = index_path_state(&index, file);

    let mut state = Sha256::new();
    hash_field(&mut state, b"gitlane-discard-semantics-v1");
    // Keep repository/worktree ownership in the signature even when two
    // worktrees happen to contain byte-identical path state.
    hash_os(&mut state, repository.path().as_os_str());
    hash_os(&mut state, workdir.as_os_str());
    state.update([u8::from(staged)]);
    match previous_file {
        Some(previous) => {
            state.update([1]);
            hash_semantic_path_state(&mut state, command_repo, has_head, &index, previous)?;
        }
        None => state.update([0]),
    }
    let in_head = hash_semantic_path_state(&mut state, command_repo, has_head, &index, file)?;

    let relevant_count = statuses
        .iter()
        .filter(|entry| involved.clone().any(|path| status_mentions(entry, path)))
        .count() as u64;
    state.update(relevant_count.to_le_bytes());
    for entry in statuses
        .iter()
        .filter(|entry| involved.clone().any(|path| status_mentions(entry, path)))
    {
        hash_status_entry(&mut state, &entry);
    }

    Ok(DiscardSemanticSnapshot {
        signature: state.finalize().into(),
        workdir: workdir.to_path_buf(),
        in_head,
        index_state,
    })
}
