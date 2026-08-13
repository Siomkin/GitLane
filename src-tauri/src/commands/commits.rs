//! Commit, squash, and the stash lifecycle.

use super::blocking;
use crate::git;
use crate::git::types::StashEntry;

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command shape mirrors the frontend IPC contract.
pub async fn commit(
    path: String,
    expected_branch: Option<String>,
    expected_oid: Option<String>,
    summary: String,
    description: String,
    amend: bool,
    name: Option<String>,
    email: Option<String>,
    identity: Option<git::types::RepoIdentity>,
    identity_captured: bool,
) -> Result<String, String> {
    blocking(move || {
        git::write::commits::commit_expected(
            &path,
            expected_branch.as_deref(),
            expected_oid.as_deref(),
            &summary,
            &description,
            amend,
            name.as_deref(),
            email.as_deref(),
            identity.as_ref(),
            identity_captured,
        )
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command shape mirrors the frontend IPC contract.
pub async fn squash_commits(
    path: String,
    expected_branch: Option<String>,
    expected_oid: String,
    parent_oid: String,
    summary: String,
    description: String,
    name: Option<String>,
    email: Option<String>,
    identity: Option<git::types::RepoIdentity>,
    identity_captured: bool,
) -> Result<String, String> {
    blocking(move || {
        git::write::commits::squash_commits(
            &path,
            expected_branch.as_deref(),
            &expected_oid,
            &parent_oid,
            &summary,
            &description,
            name.as_deref(),
            email.as_deref(),
            identity.as_ref(),
            identity_captured,
        )
    })
    .await
}

/// Squash a range that ends below the branch tip: the commits above it are
/// replayed onto the replacement (see `git::write::squash_range`).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command shape mirrors the frontend IPC contract.
pub async fn squash_range(
    path: String,
    expected_branch: Option<String>,
    expected_oid: String,
    newest_oid: String,
    parent_oid: String,
    summary: String,
    description: String,
    name: Option<String>,
    email: Option<String>,
    identity: Option<git::types::RepoIdentity>,
    identity_captured: bool,
) -> Result<String, String> {
    blocking(move || {
        git::write::squash_range::squash_range(
            &path,
            expected_branch.as_deref(),
            &expected_oid,
            &newest_oid,
            &parent_oid,
            &summary,
            &description,
            name.as_deref(),
            email.as_deref(),
            identity.as_ref(),
            identity_captured,
        )
    })
    .await
}

#[tauri::command]
pub async fn stash(
    path: String,
    expected_branch: Option<String>,
    expected_oid: Option<String>,
) -> Result<String, String> {
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
) -> Result<String, String> {
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
pub async fn list_stashes(path: String) -> Result<Vec<StashEntry>, String> {
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
) -> Result<String, String> {
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
) -> Result<String, String> {
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
pub async fn stash_branch(path: String, branch: String, oid: String) -> Result<String, String> {
    blocking(move || git::write::stashes::stash_branch(&path, &branch, &oid)).await
}

#[tauri::command]
pub async fn stash_pop(
    path: String,
    expected_branch: Option<String>,
    expected_oid: Option<String>,
    oid: String,
) -> Result<String, String> {
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
pub async fn stash_drop(path: String, oid: String) -> Result<String, String> {
    blocking(move || git::write::stashes::stash_drop(&path, &oid)).await
}
