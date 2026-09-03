//! The repo-local commit identity (identity cards, GL-130) and signing-key discovery.

use super::{blocking, sync, CommandError};
use crate::git::types::{RepoIdentity, SigningKey};
use crate::{git, signing_keys};

#[tauri::command]
pub async fn set_repo_identity(
    path: String,
    name: String,
    email: String,
    signing_key: Option<String>,
    gpg_format: Option<String>,
    gpg_sign: Option<bool>,
    tag_gpg_sign: Option<bool>,
) -> Result<String, CommandError> {
    blocking(move || {
        git::write::identity::set_repo_identity(
            &path,
            &name,
            &email,
            signing_key.as_deref(),
            gpg_format.as_deref(),
            gpg_sign,
            tag_gpg_sign,
        )
    })
    .await
}

#[tauri::command]
pub async fn list_signing_keys() -> Result<Vec<SigningKey>, CommandError> {
    blocking(|| Ok::<_, CommandError>(signing_keys::list())).await
}

#[tauri::command]
pub fn repo_identity(path: String) -> Result<Option<RepoIdentity>, CommandError> {
    sync(|| git::read::repo_identity(&path).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn default_git_identity() -> Option<RepoIdentity> {
    git::read::default_identity()
}

#[tauri::command]
pub async fn clear_repo_identity(path: String) -> Result<String, CommandError> {
    blocking(move || git::write::identity::clear_repo_identity(&path)).await
}
