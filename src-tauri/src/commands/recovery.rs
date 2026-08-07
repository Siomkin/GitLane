//! Reflog, destructive-operation previews, discard-all, and stranded index.lock recovery.

use super::blocking;
use crate::git;
use crate::git::types::{
    DeleteBranchPreview, DestructivePreview, DiscardAllPreview, ForcePushPreview, IndexLockStatus,
    ReflogEntry, ResetPreview,
};

#[tauri::command]
pub async fn list_reflog(path: String, limit: Option<usize>) -> Result<Vec<ReflogEntry>, String> {
    // Clamp the caller-supplied limit: the UI requests 120, but the command
    // surface must not let a stray large value trigger an unbounded reflog walk.
    let limit = limit.unwrap_or(80).clamp(1, 500);
    blocking(move || git::write::recovery::reflog_entries(&path, limit)).await
}

#[tauri::command]
pub async fn preview_reset(
    path: String,
    target: String,
    mode: String,
    source: Option<String>,
) -> Result<ResetPreview, String> {
    // `source` is the ref being reset; defaults to HEAD for current-branch resets.
    let source = source.unwrap_or_else(|| "HEAD".to_string());
    blocking(move || git::write::recovery::preview_reset(&path, &target, &mode, &source)).await
}

#[tauri::command]
pub async fn preview_discard_all(path: String) -> Result<DiscardAllPreview, String> {
    blocking(move || git::write::discard_all::preview_discard_all(&path)).await
}

#[tauri::command]
pub async fn preview_delete_branch(
    path: String,
    branch: String,
) -> Result<DeleteBranchPreview, String> {
    blocking(move || git::write::recovery::preview_delete_branch(&path, &branch)).await
}

#[tauri::command]
pub async fn preview_delete_remote_branch(
    path: String,
    remote: String,
    branch: String,
) -> Result<DestructivePreview, String> {
    blocking(move || git::write::recovery::preview_delete_remote_branch(&path, &remote, &branch))
        .await
}

#[tauri::command]
pub async fn preview_force_push(path: String, branch: String) -> Result<ForcePushPreview, String> {
    blocking(move || git::write::recovery::preview_force_push(&path, &branch)).await
}

#[tauri::command]
pub async fn discard_all(
    path: String,
    expected_state: String,
    expected_head_branch: Option<String>,
    expected_head_oid: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        git::write::discard_all::discard_all(
            &path,
            &expected_state,
            expected_head_branch.as_deref(),
            expected_head_oid.as_deref(),
        )
    })
    .await
}

/// Inspect `.git/index.lock` for the stranded-lock recovery toast (GL-335).
#[tauri::command]
pub async fn inspect_index_lock(path: String) -> Result<IndexLockStatus, String> {
    blocking(move || git::write::index_lock::inspect_index_lock(&path)).await
}

/// Remove a stranded `.git/index.lock` only when the staleness gate passes.
#[tauri::command]
pub async fn remove_index_lock(path: String) -> Result<(), String> {
    blocking(move || git::write::index_lock::remove_index_lock(&path)).await
}
