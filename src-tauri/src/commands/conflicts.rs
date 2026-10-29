//! Conflict-operation status, per-file conflict reads, and resolve/continue/abort/skip.

use super::{blocking, CommandError};
use crate::git;
use crate::git::types::{ConflictFileContent, OperationStatus};

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn operation_status(path: String) -> Result<OperationStatus, CommandError> {
    blocking(move || git::conflicts::operation_status(&path)).await
}

/// A conflicted file's worktree text; `resolved` reads one the user already
/// staged, under the same cap.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn conflict_file(
    path: String,
    file: String,
    resolved: Option<bool>,
) -> Result<ConflictFileContent, CommandError> {
    blocking(move || git::conflicts::conflict_file(&path, &file, resolved.unwrap_or(false))).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn accept_conflict_side(
    path: String,
    file: String,
    side: git::types::ConflictSide,
) -> Result<String, CommandError> {
    blocking(move || git::write::conflict_resolution::accept_conflict_side(&path, &file, side))
        .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn resolve_conflict_file(
    path: String,
    file: String,
    content: String,
) -> Result<String, CommandError> {
    blocking(move || git::write::conflict_resolution::resolve_conflict_file(&path, &file, &content))
        .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn mark_conflict_resolved(path: String, file: String) -> Result<String, CommandError> {
    blocking(move || git::write::conflict_resolution::mark_conflict_resolved(&path, &file)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn reconflict_file(path: String, file: String) -> Result<String, CommandError> {
    blocking(move || git::write::conflict_resolution::reconflict_file(&path, &file)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn continue_operation(
    path: String,
    kind: git::types::OperationKind,
    name: Option<String>,
    email: Option<String>,
    identity: git::types::CapturedIdentity,
) -> Result<String, CommandError> {
    blocking(move || {
        git::write::conflict_resolution::continue_operation(
            &path,
            kind,
            name.as_deref(),
            email.as_deref(),
            &identity,
        )
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn abort_operation(
    path: String,
    kind: git::types::OperationKind,
) -> Result<String, CommandError> {
    blocking(move || git::write::conflict_resolution::abort_operation(&path, kind)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn skip_operation(
    path: String,
    kind: git::types::OperationKind,
    name: Option<String>,
    email: Option<String>,
    identity: git::types::CapturedIdentity,
) -> Result<String, CommandError> {
    blocking(move || {
        git::write::conflict_resolution::skip_operation(
            &path,
            kind,
            name.as_deref(),
            email.as_deref(),
            &identity,
        )
    })
    .await
}
