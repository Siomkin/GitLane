//! Local tag creation/deletion and patch-file exports.

use super::blocking;
use crate::git;

#[tauri::command]
pub async fn create_tag(path: String, name: String, sha: String) -> Result<String, String> {
    blocking(move || git::write::tags::create_tag(&path, &name, Some(&sha))).await
}

#[tauri::command]
pub async fn create_annotated_tag(
    path: String,
    name: String,
    message: String,
    sha: String,
) -> Result<String, String> {
    blocking(move || git::write::tags::create_annotated_tag(&path, &name, &message, Some(&sha)))
        .await
}

#[tauri::command]
pub async fn create_patch(path: String, sha: String) -> Result<String, String> {
    blocking(move || git::write::patches::create_patch(&path, &sha)).await
}

#[tauri::command]
pub async fn create_patch_range(
    path: String,
    base: String,
    head: String,
) -> Result<String, String> {
    blocking(move || git::write::patches::create_patch_range(&path, &base, &head)).await
}

#[tauri::command]
pub async fn create_working_tree_patch(path: String, file: String) -> Result<String, String> {
    blocking(move || git::write::patches::create_working_tree_patch(&path, &file)).await
}

#[tauri::command]
pub async fn delete_tag(
    path: String,
    name: String,
    expected_oid: String,
) -> Result<String, String> {
    blocking(move || git::write::tags::delete_tag(&path, &name, &expected_oid)).await
}
