//! GitHub (`gh`) accounts on this computer: list, in-app sign-in, sign-out.
//! Pull-request commands live in [`super::pulls`].

use super::{blocking, sync, CommandError};
use crate::git;
use crate::git::types::{GithubAccount, GithubSignInResult};

/// Holds the in-flight `gh auth login --web` child so [`cancel_github_sign_in`]
/// can terminate it while the device flow streams progress (GL-106). Mirrors
/// [`crate::commands::repo::CloneState`].
#[derive(Default)]
pub struct SignInState(git::forge::SignInSlot);

#[tauri::command]
pub async fn github_accounts() -> Result<Vec<GithubAccount>, CommandError> {
    blocking(git::forge::accounts).await
}

/// Sign in a GitHub account in-app via `gh auth login --web` (GL-106). Streams
/// `github-signin-progress` events; the child is parked in [`SignInState`] so
/// [`cancel_github_sign_in`] can stop it. Returns the newly added `{host, login}`.
#[tauri::command]
pub async fn github_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, SignInState>,
    host: String,
) -> Result<GithubSignInResult, CommandError> {
    let slot = state.0.clone();
    // The sign-in's PTY reader thread reports milestones through this; forwarding
    // them to the webview is the command layer's job, so `git/` never sees Tauri.
    let progress: git::forge::SignInProgressSink =
        std::sync::Arc::new(move |p: &crate::events::SignInProgress| {
            crate::events::emit(&app, crate::events::GITHUB_SIGNIN_PROGRESS, p.clone());
        });
    // Arm before scheduling, so a Cancel that lands while the worker is queued
    // is still recorded (and one that lands after it finished is not).
    git::forge::arm_sign_in(&slot);
    blocking(move || git::forge::sign_in_web(progress, slot, &host)).await
}

/// Terminate an in-flight [`github_sign_in`]. Instant (lock + kill), so it stays a
/// plain sync command and never queues behind the blocking pool.
#[tauri::command]
pub fn cancel_github_sign_in(state: tauri::State<'_, SignInState>) -> Result<(), CommandError> {
    sync(|| git::forge::cancel_sign_in(&state.0))
}

/// Sign one account out of `gh` (`gh auth logout`) — removes its credential-
/// store entry. Remotes whose URL still carries that username fall back to the
/// system credential lookup until the user re-signs-in or repoints them.
#[tauri::command]
pub async fn github_sign_out(host: String, login: String) -> Result<String, CommandError> {
    blocking(move || git::forge::sign_out(&host, &login)).await
}
