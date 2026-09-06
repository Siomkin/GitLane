//! Stage/unstage (file, hunk, line), discard-file, ignore, and restore-from-commit.

use super::{blocking, CommandError};
use crate::git;
use crate::git::types::DiscardFilePreview;

#[tauri::command]
pub async fn apply_hunk(
    path: String,
    file: String,
    staged: bool,
    hunk_index: usize,
    expected_header: String,
    expected_body: String,
) -> Result<String, CommandError> {
    blocking(move || {
        git::write::patch_staging::apply_hunk(
            &path,
            &file,
            staged,
            hunk_index,
            &expected_header,
            &expected_body,
        )
    })
    .await
}

#[tauri::command]
pub async fn apply_line(
    path: String,
    request: git::types::ApplyLineRequest,
) -> Result<String, CommandError> {
    blocking(move || git::write::patch_staging::apply_line(&path, &request)).await
}

#[tauri::command]
pub async fn stage_files(path: String, files: Vec<String>) -> Result<String, CommandError> {
    blocking(move || git::write::staging::stage_files(&path, &files)).await
}

#[tauri::command]
pub async fn unstage_files(path: String, files: Vec<String>) -> Result<String, CommandError> {
    blocking(move || git::write::staging::unstage_files(&path, &files)).await
}

#[tauri::command]
pub async fn preview_discard_file(
    path: String,
    file: String,
    previous_file: Option<String>,
    staged: bool,
) -> Result<DiscardFilePreview, CommandError> {
    blocking(move || {
        git::write::discard_file::preview_discard_file(
            &path,
            &file,
            previous_file.as_deref(),
            staged,
        )
    })
    .await
}

#[tauri::command]
pub async fn discard_file(
    path: String,
    file: String,
    previous_file: Option<String>,
    staged: bool,
    expected_state: String,
) -> Result<String, CommandError> {
    blocking(move || {
        git::write::discard_file::discard_file(
            &path,
            &file,
            previous_file.as_deref(),
            staged,
            &expected_state,
        )
    })
    .await
}

#[tauri::command]
pub async fn append_ignore_pattern(
    path: String,
    pattern: String,
    local: bool,
) -> Result<String, CommandError> {
    blocking(move || git::write::ignore::append_ignore_pattern(&path, &pattern, local)).await
}

#[tauri::command]
pub async fn stop_tracking(path: String, file: String) -> Result<String, CommandError> {
    blocking(move || git::write::staging::stop_tracking(&path, &file)).await
}

/// ADR 0003: true when restoring `file` from `commit_oid` would change on-disk bytes.
#[tauri::command]
pub async fn worktree_differs_from_commit(
    path: String,
    commit_oid: String,
    file: String,
) -> Result<bool, CommandError> {
    blocking(move || {
        git::write::restore_path::worktree_differs_from_commit(&path, &commit_oid, &file)
    })
    .await
}

/// ADR 0003: true when `file` has a restorable (non-gitlink) blob at `commit_oid`.
/// Lets the merged-selection surface probe the selection-tip commit before
/// offering Restore for a union path.
#[tauri::command]
pub async fn commit_path_is_restorable(
    path: String,
    commit_oid: String,
    file: String,
) -> Result<bool, CommandError> {
    blocking(move || {
        Ok::<_, CommandError>(git::write::restore_path::commit_path_is_restorable(
            &path,
            &commit_oid,
            &file,
        ))
    })
    .await
}

/// ADR 0003: restore one path into the worktree from a commit (does not stage).
#[tauri::command]
pub async fn restore_path_from_commit(
    path: String,
    commit_oid: String,
    file: String,
) -> Result<String, CommandError> {
    blocking(move || git::write::restore_path::restore_path_from_commit(&path, &commit_oid, &file))
        .await
}

#[tauri::command]
pub async fn stage_all(path: String) -> Result<String, CommandError> {
    blocking(move || git::write::staging::stage_all(&path)).await
}

#[tauri::command]
pub async fn unstage_all(path: String) -> Result<String, CommandError> {
    blocking(move || git::write::staging::unstage_all(&path)).await
}
