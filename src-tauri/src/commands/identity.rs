//! The repo-local commit identity (identity cards, GL-130) and signing-key discovery.

use super::{blocking, CommandError};
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

/// The identity pinned in the repo's local git config, if any. Opens the
/// repository, so it runs on the blocking pool like every libgit2 read.
#[tauri::command]
pub async fn repo_identity(path: String) -> Result<Option<RepoIdentity>, CommandError> {
    blocking(move || git::read::repo_identity(&path).map_err(|e| e.to_string())).await
}

/// The "this computer" identity from the global git config. Reads config
/// files off disk (including any `include`d ones), so it stays off the
/// webview thread too; the wrapper only ever sees the `Ok` payload.
#[tauri::command]
pub async fn default_git_identity() -> Result<Option<RepoIdentity>, CommandError> {
    blocking(|| Ok::<_, CommandError>(git::read::default_identity())).await
}

#[tauri::command]
pub async fn clear_repo_identity(path: String) -> Result<String, CommandError> {
    blocking(move || git::write::identity::clear_repo_identity(&path)).await
}
