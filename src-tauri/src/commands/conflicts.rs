//! Conflict-operation status, per-file conflict reads, and resolve/continue/abort/skip.

use super::blocking;
use crate::git;
use crate::git::types::{ConflictFileContent, OperationStatus};

#[tauri::command]
pub async fn operation_status(path: String) -> Result<OperationStatus, String> {
    blocking(move || git::conflicts::operation_status(&path).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn conflict_file(path: String, file: String) -> Result<ConflictFileContent, String> {
    blocking(move || git::conflicts::conflict_file(&path, &file).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn accept_conflict_side(
    path: String,
    file: String,
    side: String,
) -> Result<String, String> {
    blocking(move || git::write::conflict_resolution::accept_conflict_side(&path, &file, &side))
        .await
}

#[tauri::command]
pub async fn resolve_conflict_file(
    path: String,
    file: String,
    content: String,
) -> Result<String, String> {
    blocking(move || git::write::conflict_resolution::resolve_conflict_file(&path, &file, &content))
        .await
}

#[tauri::command]
pub async fn mark_conflict_resolved(path: String, file: String) -> Result<String, String> {
    blocking(move || git::write::conflict_resolution::mark_conflict_resolved(&path, &file)).await
}

#[tauri::command]
pub async fn reconflict_file(path: String, file: String) -> Result<String, String> {
    blocking(move || git::write::conflict_resolution::reconflict_file(&path, &file)).await
}

#[tauri::command]
pub async fn continue_operation(
    path: String,
    kind: String,
    name: Option<String>,
    email: Option<String>,
    identity: git::types::CapturedIdentity,
) -> Result<String, String> {
    blocking(move || {
        git::write::conflict_resolution::continue_operation(
            &path,
            &kind,
            name.as_deref(),
            email.as_deref(),
            &identity,
        )
    })
    .await
}

#[tauri::command]
pub async fn abort_operation(path: String, kind: String) -> Result<String, String> {
    blocking(move || git::write::conflict_resolution::abort_operation(&path, &kind)).await
}

#[tauri::command]
pub async fn skip_operation(
    path: String,
    kind: String,
    name: Option<String>,
    email: Option<String>,
    identity: git::types::CapturedIdentity,
) -> Result<String, String> {
    blocking(move || {
        git::write::conflict_resolution::skip_operation(
            &path,
            &kind,
            name.as_deref(),
            email.as_deref(),
            &identity,
        )
    })
    .await
}
