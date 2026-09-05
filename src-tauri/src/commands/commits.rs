//! Commit, squash, and the stash lifecycle.

use super::{blocking, CommandError};
use crate::git;
use crate::git::types::{
    CommitRequest, SquashBranchRequest, SquashCommitsRequest, SquashRangeRequest, StashEntry,
};

#[tauri::command]
pub async fn commit(path: String, request: CommitRequest) -> Result<String, CommandError> {
    blocking(move || git::write::commits::commit_expected(&path, &request)).await
}

#[tauri::command]
pub async fn squash_commits(
    path: String,
    request: SquashCommitsRequest,
) -> Result<String, CommandError> {
    blocking(move || git::write::commits::squash_commits(&path, &request)).await
}

/// Squash a range that ends below the branch tip: the commits above it are
/// replayed onto the replacement (see `git::write::squash_range`).
#[tauri::command]
pub async fn squash_range(
    path: String,
    request: SquashRangeRequest,
) -> Result<String, CommandError> {
    blocking(move || git::write::squash_range::squash_range(&path, &request)).await
}

/// Rewrite an explicitly leased local branch without touching HEAD or the index.
#[tauri::command]
pub async fn squash_branch(
    path: String,
    request: SquashBranchRequest,
) -> Result<String, CommandError> {
    blocking(move || git::write::squash_range::squash_branch(&path, &request)).await
}

#[tauri::command]
pub async fn stash(
    path: String,
    expected_branch: Option<String>,
    expected_oid: Option<String>,
) -> Result<String, CommandError> {
    blocking(move || {
        git::write::stashes::stash_expected(
            &path,
            expected_branch.as_deref(),
            expected_oid.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn stash_paths(
    path: String,
    expected_branch: Option<String>,
    expected_oid: Option<String>,
    files: Vec<String>,
) -> Result<String, CommandError> {
    blocking(move || {
        git::write::stashes::stash_paths_expected(
            &path,
            expected_branch.as_deref(),
            expected_oid.as_deref(),
            &files,
        )
    })
    .await
}

#[tauri::command]
pub async fn list_stashes(path: String) -> Result<Vec<StashEntry>, CommandError> {
    blocking(move || git::write::stashes::stash_list(&path)).await
}

// Stashes are addressed by commit oid, not `stash@{n}` — indices are
// reflog-relative and global across worktrees, so one captured at list time can
// point at a different stash by the time the user acts (GL-117).
#[tauri::command]
pub async fn stash_apply(
    path: String,
    expected_branch: Option<String>,
    expected_oid: Option<String>,
    oid: String,
) -> Result<String, CommandError> {
    blocking(move || {
        git::write::stashes::stash_apply_onto(
            &path,
            expected_branch.as_deref(),
            expected_oid.as_deref(),
            &oid,
        )
    })
    .await
}

#[tauri::command]
pub async fn stash_apply_index(
    path: String,
    expected_branch: Option<String>,
    expected_oid: Option<String>,
    oid: String,
) -> Result<String, CommandError> {
    blocking(move || {
        git::write::stashes::stash_apply_index_onto(
            &path,
            expected_branch.as_deref(),
            expected_oid.as_deref(),
            &oid,
        )
    })
    .await
}

#[tauri::command]
pub async fn stash_branch(
    path: String,
    branch: String,
    oid: String,
) -> Result<String, CommandError> {
    blocking(move || git::write::stashes::stash_branch(&path, &branch, &oid)).await
}

#[tauri::command]
pub async fn stash_pop(
    path: String,
    expected_branch: Option<String>,
    expected_oid: Option<String>,
    oid: String,
) -> Result<String, CommandError> {
    blocking(move || {
        git::write::stashes::stash_pop_onto(
            &path,
            expected_branch.as_deref(),
            expected_oid.as_deref(),
            &oid,
        )
    })
    .await
}

#[tauri::command]
pub async fn stash_drop(path: String, oid: String) -> Result<String, CommandError> {
    blocking(move || git::write::stashes::stash_drop(&path, &oid)).await
}
