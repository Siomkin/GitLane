//! Linked-worktree management and the branch↔worktree hand-off flows.

use super::blocking;
use crate::git;
use crate::git::types::{DeleteWorktreeProgressEvent, HandoffProgressEvent, WorktreeInfo};

#[tauri::command]
pub async fn list_worktrees(path: String) -> Result<Vec<WorktreeInfo>, String> {
    blocking(move || git::write::worktrees::worktrees(&path)).await
}

#[tauri::command]
pub async fn add_worktree(
    path: String,
    worktree_path: String,
    reference: String,
    new_branch: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        git::write::worktrees::add_worktree(
            &path,
            &worktree_path,
            Some(&reference),
            new_branch.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn create_branch_in_worktree(
    path: String,
    worktree_path: String,
    name: String,
    expected_oid: String,
) -> Result<String, String> {
    blocking(move || {
        git::write::worktrees::create_branch_in_worktree(
            &path,
            &worktree_path,
            &name,
            &expected_oid,
        )
    })
    .await
}

#[tauri::command]
pub async fn move_branch_to_worktree(
    app: tauri::AppHandle,
    path: String,
    branch: String,
    from_worktree_path: String,
    to_worktree_path: String,
    carry: bool,
) -> Result<String, String> {
    use tauri::Emitter;
    blocking(move || {
        git::write::worktrees::move_branch_to_worktree(
            &path,
            &branch,
            &from_worktree_path,
            &to_worktree_path,
            carry,
            // Forward each phase to the webview so the hand-off dialog can tick
            // its checklist live; a lost event only degrades the progress UI.
            &|step| {
                let _ = app.emit(
                    "handoff-progress",
                    HandoffProgressEvent {
                        step: step.to_string(),
                    },
                );
            },
        )
    })
    .await
}

#[tauri::command]
pub async fn delete_branch_with_worktree(
    app: tauri::AppHandle,
    path: String,
    branch: String,
    from_worktree_path: String,
    expected_oid: String,
    expected_state: String,
) -> Result<String, String> {
    use tauri::Emitter;
    blocking(move || {
        git::write::worktrees::delete_branch_with_worktree(
            &path,
            &branch,
            &from_worktree_path,
            &expected_oid,
            &expected_state,
            // Forward each phase to the webview so the delete dialog can tick its
            // checklist live; a lost event only degrades the progress UI.
            &|step| {
                let _ = app.emit(
                    "delete-worktree-progress",
                    DeleteWorktreeProgressEvent {
                        step: step.to_string(),
                    },
                );
            },
        )
    })
    .await
}

#[tauri::command]
pub async fn preview_remove_worktree(
    path: String,
    worktree_path: String,
) -> Result<git::types::RemoveWorktreePreview, String> {
    blocking(move || {
        git::write::worktree_removal_lease::preview_remove_worktree(&path, &worktree_path)
    })
    .await
}

#[tauri::command]
pub async fn remove_worktree(
    path: String,
    worktree_path: String,
    expected_state: String,
) -> Result<String, String> {
    blocking(move || git::write::worktrees::remove_worktree(&path, &worktree_path, &expected_state))
        .await
}

/// Uncommitted work in a linked worktree, probed on demand so a removal confirm
/// can quote what a forced remove would discard (GL-296). Kept out of the
/// worktree list because that refreshes on every filesystem event.
#[tauri::command]
pub async fn worktree_dirty_state(
    worktree_path: String,
) -> Result<git::types::WorktreeDirtyState, String> {
    blocking(move || git::write::worktrees::worktree_dirty_state(&worktree_path)).await
}

/// Whether a linked worktree currently holds uncommitted work — one bit for the
/// graph's dirty dot, so a branch checked out in another worktree reads as
/// having unsaved work without opening it. A cheaper probe than
/// `worktree_dirty_state` (no ignored pass, untracked directories collapsed);
/// like it, it costs a `git status` and so never rides the worktree-list refresh.
#[tauri::command]
pub async fn worktree_is_dirty(worktree_path: String) -> Result<bool, String> {
    blocking(move || git::write::worktrees::worktree_is_dirty(&worktree_path)).await
}
