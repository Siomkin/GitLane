//! Branch checkout/create/delete/rename and history-rewriting operations (merge, rebase, reset, cherry-pick, revert).

use super::blocking;
use crate::git;

#[tauri::command]
pub async fn checkout(path: String, target: String, detached: bool) -> Result<String, String> {
    blocking(move || git::write::branch_checkout::checkout(&path, &target, detached)).await
}

#[tauri::command]
pub async fn checkout_remote_branch(
    path: String,
    remote: String,
    branch: String,
) -> Result<String, String> {
    blocking(move || git::write::branch_checkout::checkout_remote_branch(&path, &remote, &branch))
        .await
}

#[tauri::command]
pub async fn create_branch(
    path: String,
    name: String,
    start_point: String,
    expected_oid: String,
) -> Result<String, String> {
    blocking(move || git::write::branches::create_branch(&path, &name, &start_point, &expected_oid))
        .await
}

#[tauri::command]
pub async fn delete_branch(
    path: String,
    name: String,
    expected_oid: String,
    force: bool,
) -> Result<String, String> {
    blocking(move || git::write::branches::delete_branch(&path, &name, &expected_oid, force)).await
}

#[tauri::command]
pub async fn rename_branch(path: String, old: String, new: String) -> Result<String, String> {
    blocking(move || git::write::branches::rename_branch(&path, &old, &new)).await
}

#[tauri::command]
pub async fn set_upstream(
    path: String,
    branch: String,
    upstream: String,
) -> Result<String, String> {
    blocking(move || git::write::branches::set_upstream(&path, &branch, &upstream)).await
}

#[tauri::command]
pub async fn merge_branch(
    path: String,
    source: String,
    expected_source_oid: String,
    destination: Option<String>,
    expected_destination_oid: String,
) -> Result<String, String> {
    blocking(move || {
        git::write::history::merge_into(
            &path,
            &source,
            &expected_source_oid,
            destination.as_deref(),
            &expected_destination_oid,
        )
    })
    .await
}

#[tauri::command]
pub async fn fast_forward_branch(
    path: String,
    branch: String,
    expected_branch_oid: String,
    target_oid: String,
) -> Result<String, String> {
    blocking(move || {
        git::write::history::fast_forward_branch_at(
            &path,
            &branch,
            &expected_branch_oid,
            &target_oid,
        )
    })
    .await
}

#[tauri::command]
pub async fn rebase_onto(
    path: String,
    source: String,
    expected_source_oid: String,
    onto_oid: String,
) -> Result<String, String> {
    blocking(move || git::write::history::rebase(&path, &source, &expected_source_oid, &onto_oid))
        .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command shape mirrors the frontend IPC contract.
pub async fn reset_to(
    path: String,
    source: Option<String>,
    expected_source_oid: Option<String>,
    target_oid: String,
    mode: String,
    expected_state: Option<String>,
    expected_head_branch: Option<String>,
    expected_head_oid: Option<String>,
) -> Result<String, String> {
    let request = git::write::reset::ResetRequest::parse(
        source.as_deref(),
        expected_source_oid.as_deref(),
        &mode,
        expected_state.as_deref(),
        expected_head_branch.as_deref(),
        expected_head_oid.as_deref(),
    )?;
    blocking(move || git::write::reset::reset_branch(&path, &target_oid, request)).await
}

#[tauri::command]
pub async fn cherry_pick(
    path: String,
    expected_branch: Option<String>,
    expected_oid: String,
    commit: String,
) -> Result<String, String> {
    blocking(move || {
        git::write::history::cherry_pick_onto(
            &path,
            expected_branch.as_deref(),
            &expected_oid,
            &commit,
        )
    })
    .await
}

#[tauri::command]
pub async fn cherry_pick_many(
    path: String,
    expected_branch: Option<String>,
    expected_oid: String,
    commits: Vec<String>,
) -> Result<String, String> {
    blocking(move || {
        git::write::history::cherry_pick_many_onto(
            &path,
            expected_branch.as_deref(),
            &expected_oid,
            &commits,
        )
    })
    .await
}

#[tauri::command]
pub async fn revert_commit(
    path: String,
    expected_branch: Option<String>,
    expected_oid: String,
    commit: String,
) -> Result<String, String> {
    blocking(move || {
        git::write::history::revert_onto(&path, expected_branch.as_deref(), &expected_oid, &commit)
    })
    .await
}

#[tauri::command]
pub async fn revert_many(
    path: String,
    expected_branch: Option<String>,
    expected_oid: String,
    commits: Vec<String>,
) -> Result<String, String> {
    blocking(move || {
        git::write::history::revert_many_onto(
            &path,
            expected_branch.as_deref(),
            &expected_oid,
            &commits,
        )
    })
    .await
}
