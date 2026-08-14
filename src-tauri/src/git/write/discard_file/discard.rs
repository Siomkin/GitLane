//! Previewing and performing a single-path discard.

use super::snapshot::{capture_discard_snapshot, IndexPathState};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

use crate::git::types::DiscardFilePreview;

use super::super::cli::run_git_literal_paths;

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
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
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
