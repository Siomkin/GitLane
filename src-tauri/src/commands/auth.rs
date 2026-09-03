//! Credential-helper and provider-token management, plus native provider OAuth sign-in.

use super::{blocking, sync, CommandError};
use crate::git::types::{
    CredentialForgetResult, CredentialHelperStatus, CredentialSaveResult, ForgeAccount,
    ForgeAuthStatus, OauthClientStatus, ProviderOauthResult, ProviderTokenStatus,
};
use crate::{auth_providers, git};

/// Holds the in-flight native provider OAuth sign-in (GL-139) so
/// [`cancel_provider_oauth_sign_in`] can stop it while it streams progress.
/// Mirrors [`crate::commands::github::SignInState`].
#[derive(Default)]
pub struct OauthState(git::oauth::SignInSlot);

#[tauri::command]
pub async fn forge_auth_statuses() -> Result<Vec<ForgeAuthStatus>, CommandError> {
    blocking(|| Ok::<_, CommandError>(auth_providers::statuses())).await
}

#[tauri::command]
pub async fn forge_account(provider: String) -> Result<Option<ForgeAccount>, CommandError> {
    blocking(move || Ok::<_, CommandError>(auth_providers::account(&provider))).await
}

#[tauri::command]
pub async fn forge_sign_out(provider: String) -> Result<String, CommandError> {
    blocking(move || auth_providers::sign_out(&provider)).await
}

#[tauri::command]
pub async fn credential_helper_status() -> Result<CredentialHelperStatus, CommandError> {
    blocking(|| Ok::<_, CommandError>(git::credentials::helper_status())).await
}

#[tauri::command]
pub async fn approve_https_credential(
    credential_host: String,
    path: Option<String>,
    username: String,
    password: String,
) -> Result<CredentialSaveResult, CommandError> {
    blocking(move || {
        git::credentials::approve_https_credential(
            &credential_host,
            path.as_deref(),
            &username,
            &password,
        )
    })
    .await
}

/// Forget a saved HTTPS credential from the user's Git credential helper
/// (`git credential reject`). This is "forget saved HTTPS credential" — distinct
/// from provider sign-out ([`delete_provider_token`]), which removes a
/// GitLane-owned keychain token. Touches only the helper entry matching this
/// host/path/username.
#[tauri::command]
pub async fn reject_https_credential(
    credential_host: String,
    path: Option<String>,
    username: String,
) -> Result<CredentialForgetResult, CommandError> {
    blocking(move || {
        git::credentials::reject_https_credential(&credential_host, path.as_deref(), &username)
    })
    .await
}

/// Store a provider account's transport token in the OS keychain (GL-132). The
/// `token` is a secret: it is written straight to the keychain and never logged,
/// echoed, or returned — only the non-secret [`ProviderTokenStatus`] comes back.
#[tauri::command]
pub async fn save_provider_token(
    provider: String,
    host: String,
    account_id: String,
    login: String,
    token: String,
) -> Result<ProviderTokenStatus, CommandError> {
    blocking(move || {
        git::provider_tokens::save_provider_token(&provider, &host, &account_id, &login, &token)
    })
    .await
}

/// Delete a GitLane-owned provider token from the keychain — **provider
/// sign-out**. Idempotent; removes only GitLane's own keychain entry and leaves
/// the user's git credential-helper credentials untouched.
#[tauri::command]
pub async fn delete_provider_token(
    provider: String,
    host: String,
    account_id: String,
) -> Result<(), CommandError> {
    blocking(move || git::provider_tokens::delete_provider_token(&provider, &host, &account_id))
        .await
}

/// Whether a keychain token is currently stored for a provider account, without
/// ever returning the token itself.
#[tauri::command]
pub async fn provider_token_status(
    provider: String,
    host: String,
    account_id: String,
    login: String,
) -> Result<ProviderTokenStatus, CommandError> {
    blocking(move || {
        git::provider_tokens::provider_token_status(&provider, &host, &account_id, &login)
    })
    .await
}

/// Run a native OAuth sign-in for a non-GitHub provider (GL-139) — GitLab's
/// device flow or Bitbucket's PKCE loopback. Streams `provider-oauth-progress`
/// events; the flow is parked in [`OauthState`] so [`cancel_provider_oauth_sign_in`]
/// can stop it. The resolved token is written straight to the OS keychain and
/// never crosses IPC; only the non-secret [`ProviderOauthResult`] comes back.
#[tauri::command]
pub async fn provider_oauth_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, OauthState>,
    provider: String,
    host: String,
) -> Result<ProviderOauthResult, CommandError> {
    let slot = state.0.clone();
    blocking(move || git::oauth::run_sign_in(&app, slot, &provider, &host)).await
}

/// Terminate an in-flight [`provider_oauth_sign_in`], discarding any device /
/// authorization codes. Instant (lock + flag), so it stays a plain sync command.
#[tauri::command]
pub fn cancel_provider_oauth_sign_in(
    state: tauri::State<'_, OauthState>,
) -> Result<(), CommandError> {
    sync(|| git::oauth::cancel_sign_in(&state.0))
}

/// Whether native OAuth is configured for a provider/host (GL-139) and where its
/// public client id comes from. Never returns the client id itself.
#[tauri::command]
pub async fn oauth_client_status(
    app: tauri::AppHandle,
    provider: String,
    host: String,
) -> Result<OauthClientStatus, CommandError> {
    blocking(move || Ok::<_, CommandError>(git::oauth::client_status(&app, &provider, &host))).await
}

/// Set (or clear, when empty) the per-host public OAuth client-id override
/// (GL-139), stored in Rust-owned app-data. The client id is public, not a
/// secret.
#[tauri::command]
pub async fn set_oauth_client_id(
    app: tauri::AppHandle,
    provider: String,
    host: String,
    client_id: String,
) -> Result<(), CommandError> {
    blocking(move || git::oauth::set_client_id(&app, &provider, &host, &client_id)).await
}
