//! Guarded single-file discard previews and writes.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use git2::{Status, StatusOptions};
use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

use crate::git::types::DiscardFilePreview;
use crate::git::worktree_fs::{
    fingerprint_worktree_leaf, validate_worktree_leaf_observation, WorktreeLeafFingerprint,
    WorktreeLeafObservation,
};

use super::cli::{run_git_literal_paths, run_git_stdout_raw};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum IndexPathState {
    Missing,
    IntentToAdd,
    Present,
}

struct DiscardSnapshot {
    expected_state: String,
    workdir: PathBuf,
    in_head: bool,
    index_state: IndexPathState,
}

struct DiscardSemanticSnapshot {
    signature: [u8; 32],
    workdir: PathBuf,
    in_head: bool,
    index_state: IndexPathState,
}

#[cfg(test)]
std::thread_local! {
    static DISCARD_CAPTURE_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

/// Deterministically mutate a fixture after the expensive content pass but
/// before the fresh semantic/leaf checks. Thread-local state prevents parallel
/// tests for unrelated repositories from consuming the hook.
#[cfg(test)]
pub(crate) fn set_discard_capture_test_hook(hook: impl FnOnce() + 'static) {
    DISCARD_CAPTURE_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
fn run_discard_capture_test_hook() {
    DISCARD_CAPTURE_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_discard_capture_test_hook() {}

fn hash_field(state: &mut Sha256, bytes: &[u8]) {
    state.update((bytes.len() as u64).to_le_bytes());
    state.update(bytes);
}

#[cfg(unix)]
fn hash_filesystem_path(state: &mut Sha256, path: &Path) {
    hash_field(state, path.as_os_str().as_bytes());
}

#[cfg(windows)]
fn hash_filesystem_path(state: &mut Sha256, path: &Path) {
    let bytes: Vec<u8> = path
        .as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect();
    hash_field(state, &bytes);
}

#[cfg(not(any(unix, windows)))]
fn hash_filesystem_path(state: &mut Sha256, path: &Path) {
    hash_field(state, path.to_string_lossy().as_bytes());
}

fn hash_index_entry(state: &mut Sha256, entry: Option<git2::IndexEntry>, stage: i32) {
    state.update([stage as u8]);
    let Some(entry) = entry else {
        state.update([0]);
        return;
    };
    state.update([1]);
    state.update(entry.id.as_bytes());
    state.update(entry.mode.to_le_bytes());
    state.update(entry.flags.to_le_bytes());
    state.update(entry.flags_extended.to_le_bytes());
}

fn index_path_state(index: &git2::Index, file: &str) -> IndexPathState {
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

fn status_mentions(entry: &git2::StatusEntry<'_>, file: &str) -> bool {
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

fn source_entry_matches(
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

fn staged_change_has_external_worktree_rename(
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

fn hash_semantic_path_state(
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

fn hash_diff_file(state: &mut Sha256, file: git2::DiffFile<'_>) {
    state.update(file.id().as_bytes());
    state.update(i32::from(file.mode()).to_le_bytes());
    state.update(file.size().to_le_bytes());
    state.update([u8::from(file.exists()), u8::from(file.is_valid_id())]);
    match file.path_bytes() {
        Some(path) => {
            state.update([1]);
            hash_field(state, path);
        }
        None => state.update([0]),
    }
}

fn hash_diff_delta(state: &mut Sha256, delta: Option<git2::DiffDelta<'_>>) {
    let Some(delta) = delta else {
        state.update([0]);
        return;
    };
    state.update([1, delta.status() as u8]);
    state.update(delta.nfiles().to_le_bytes());
    hash_diff_file(state, delta.old_file());
    hash_diff_file(state, delta.new_file());
}

fn hash_status_entry(state: &mut Sha256, entry: &git2::StatusEntry<'_>) {
    state.update(entry.status().bits().to_le_bytes());
    hash_field(state, entry.path_bytes());
    hash_diff_delta(state, entry.head_to_index());
    hash_diff_delta(state, entry.index_to_workdir());
}

fn capture_discard_semantics(
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
    hash_filesystem_path(&mut state, repository.path());
    hash_filesystem_path(&mut state, workdir);
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

fn hash_worktree_fingerprint(
    state: &mut Sha256,
    fingerprint: WorktreeLeafFingerprint,
    file: &str,
) -> Result<(), String> {
    match fingerprint {
        WorktreeLeafFingerprint::Missing => state.update([0]),
        WorktreeLeafFingerprint::Regular { len, mode, digest } => {
            state.update([1]);
            state.update(len.to_le_bytes());
            state.update(mode.to_le_bytes());
            state.update(digest);
        }
        WorktreeLeafFingerprint::Symlink { mode, target } => {
            state.update([2]);
            state.update(mode.to_le_bytes());
            hash_field(state, &target);
        }
        WorktreeLeafFingerprint::Other { .. } => {
            return Err(format!(
                "Refusing to discard non-file worktree path {file}. Use the terminal for this repository state."
            ));
        }
    }
    Ok(())
}

fn capture_discard_snapshot(
    repo: &str,
    file: &str,
    previous_file: Option<&str>,
    staged: bool,
) -> Result<DiscardSnapshot, String> {
    let previous_file = previous_file.filter(|previous| *previous != file);
    let initial = capture_discard_semantics(repo, file, previous_file, staged)?;

    let mut state = Sha256::new();
    hash_field(&mut state, b"gitlane-discard-v1");
    hash_field(&mut state, &initial.signature);
    let involved = previous_file.into_iter().chain(std::iter::once(file));
    let mut observations: Vec<(&str, WorktreeLeafObservation)> = Vec::new();
    for path in involved.clone() {
        hash_field(&mut state, path.as_bytes());
        let (fingerprint, observation) = fingerprint_worktree_leaf(&initial.workdir, path)
            .map_err(|error| format!("Could not inspect {path} before discarding it: {error}"))?;
        hash_worktree_fingerprint(&mut state, fingerprint, path)?;
        observations.push((path, observation));
    }

    run_discard_capture_test_hook();

    // Status/index/HEAD may change while a large worktree file is streamed.
    // Recompute their path-local semantic signature after content capture, and
    // use this fresh capture for the mutation branch as well as the token.
    let fresh = capture_discard_semantics(repo, file, previous_file, staged)?;
    if fresh.signature != initial.signature {
        return Err(format!(
            "Changes to {file} changed while GitLane was inspecting them. Refresh and try again."
        ));
    }

    // Recheck every pathname only after all slow work. A rename's first path
    // therefore cannot change unnoticed while the second path is being hashed.
    for (path, observation) in &observations {
        let unchanged = validate_worktree_leaf_observation(&fresh.workdir, path, observation)
            .map_err(|error| format!("Could not recheck {path} before discarding it: {error}"))?;
        if !unchanged {
            return Err(format!(
                "Changes to {file} changed while GitLane was inspecting them. Refresh and try again."
            ));
        }
    }

    Ok(DiscardSnapshot {
        expected_state: format!("v1:{}", URL_SAFE_NO_PAD.encode(state.finalize())),
        workdir: fresh.workdir,
        in_head: fresh.in_head,
        index_state: fresh.index_state,
    })
}

/// Capture the exact path-local HEAD/index/worktree state that a destructive
/// per-file confirmation is asking the user to approve.
pub fn preview_discard_file(
    repo: &str,
    file: &str,
    previous_file: Option<&str>,
    staged: bool,
) -> Result<DiscardFilePreview, String> {
    let previous_file = previous_file.filter(|previous| *previous != file);
    let snapshot = capture_discard_snapshot(repo, file, previous_file, staged)?;
    let summary = match previous_file {
        Some(previous) => format!("Discard rename {previous} → {file}"),
        None if staged => format!("Unstage and discard changes in {file}"),
        None => format!("Discard unstaged changes in {file}"),
    };
    let detail = if previous_file.is_some() {
        if staged {
            "Both rename paths in the index and worktree will be restored from HEAD.".to_string()
        } else {
            "The index version at the old path will be preserved.".to_string()
        }
    } else if staged && snapshot.in_head {
        "Both the index and worktree copy will be restored from HEAD.".to_string()
    } else if staged {
        "The staged-new file will be removed from both the index and worktree.".to_string()
    } else {
        match snapshot.index_state {
            IndexPathState::Present => {
                "The staged/index version will be preserved in both the index and worktree."
                    .to_string()
            }
            IndexPathState::IntentToAdd => {
                "The intent-to-add entry and its worktree file will be removed.".to_string()
            }
            IndexPathState::Missing => "The untracked worktree file will be removed.".to_string(),
        }
    };
    Ok(DiscardFilePreview {
        summary,
        details: vec![detail],
        warnings: vec!["These file changes cannot be recovered by GitLane.".to_string()],
        expected_state: snapshot.expected_state,
    })
}

/// Discard exactly the file state captured by [`preview_discard_file`]. A change
/// to either involved worktree path, its index entries, or its HEAD tree entry
/// fails closed before spawning Git. Unstaged discards restore from the index
/// even for a staged-new file, preserving its staged blob; staged discards
/// restore/remove both index and worktree sides.
pub fn discard_file(
    repo: &str,
    file: &str,
    previous_file: Option<&str>,
    staged: bool,
    expected_state: &str,
) -> Result<String, String> {
    let previous_file = previous_file.filter(|previous| *previous != file);
    let snapshot = capture_discard_snapshot(repo, file, previous_file, staged).map_err(|_| {
        format!("Changes to {file} changed after the confirmation opened. Refresh and try again.")
    })?;
    if snapshot.expected_state != expected_state {
        return Err(format!(
            "Changes to {file} changed after the confirmation opened. Refresh and try again."
        ));
    }
    let command_repo = snapshot.workdir.to_str().ok_or_else(|| {
        "Cannot discard a file from a worktree path that is not valid UTF-8".to_string()
    })?;

    if let Some(previous) = previous_file {
        if staged {
            // Restore both index paths and the worktree in one command. Besides
            // avoiding partial index state, this is essential for case-only
            // renames: on a case-insensitive filesystem the two spellings name
            // one file, so restoring the old side and then removing the new side
            // would delete the file that was just restored.
            run_git_literal_paths(
                command_repo,
                &[
                    "restore",
                    "--source=HEAD",
                    "--staged",
                    "--worktree",
                    "--",
                    previous,
                    file,
                ],
            )?;
        } else {
            // An unstaged rename is index(old) → worktree(new). Remove the
            // untracked new side first, then restore the old side *from the
            // index*, preserving any staged content already recorded there.
            run_git_literal_paths(command_repo, &["clean", "-f", "--", file])?;
            run_git_literal_paths(command_repo, &["restore", "--worktree", "--", previous])?;
        }
        return Ok(format!("Discarded rename {previous} → {file}"));
    }

    if staged {
        if snapshot.in_head {
            run_git_literal_paths(
                command_repo,
                &[
                    "restore",
                    "--source=HEAD",
                    "--staged",
                    "--worktree",
                    "--",
                    file,
                ],
            )?;
            Ok(format!("Discarded changes in {file}"))
        } else {
            run_git_literal_paths(command_repo, &["rm", "-f", "-q", "--", file])?;
            Ok(format!("Discarded {file}"))
        }
    } else {
        match snapshot.index_state {
            IndexPathState::Present => {
                run_git_literal_paths(command_repo, &["restore", "--worktree", "--", file])?;
                Ok(format!("Discarded unstaged changes in {file}"))
            }
            IndexPathState::IntentToAdd => {
                run_git_literal_paths(command_repo, &["rm", "-f", "-q", "--", file])?;
                Ok(format!("Discarded {file}"))
            }
            IndexPathState::Missing => {
                run_git_literal_paths(command_repo, &["clean", "-f", "--", file])?;
                Ok(format!("Discarded {file}"))
            }
        }
    }
}
