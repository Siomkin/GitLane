//! The backend → webview event contract: every event name, declared once.
//!
//! An event name is a string on both sides of IPC, so a rename on one side
//! compiles and passes every test while silently going quiet at runtime. The
//! names live here as constants, `src/lib/api/events.ts` declares the same set
//! for the listeners, and [`crate::commands::registration_tests`] asserts the
//! two sets are equal — the same technique that guards the command registry.
//!
//! [`emit`] is the crate's only `Emitter::emit` call site, so an event cannot
//! be published under an undeclared name. Emission is deliberately
//! fire-and-forget: every one of these events is progress or invalidation
//! signalling, and a dropped tick degrades a checklist rather than failing the
//! operation that reported it.
//!
//! Payloads: the small event-only DTOs live here next to their names. Three
//! payloads stay in their domain modules because they are also those modules'
//! function-signature types — [`crate::git::write::lifecycle::CloneProgress`],
//! [`crate::acp::AcpProgress`], and
//! [`crate::git::oauth::types::ProviderOauthProgress`]. All of them are
//! `rename_all = "camelCase"`, mirroring the TS payload types.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// A repository's worktree or git state changed on disk (filesystem watcher).
pub const REPO_CHANGED: &str = "repo-changed";
/// A PTY session produced output.
pub const PTY_DATA: &str = "pty-data";
/// A PTY session's shell exited.
pub const PTY_EXIT: &str = "pty-exit";
/// A clone advanced to the next phase / percentage.
pub const CLONE_PROGRESS: &str = "clone-progress";
/// An ACP agent turn reported what it is doing.
pub const ACP_PROGRESS: &str = "acp-progress";
/// A branch hand-off between worktrees advanced a step.
pub const HANDOFF_PROGRESS: &str = "handoff-progress";
/// A branch+worktree delete advanced a step.
pub const DELETE_WORKTREE_PROGRESS: &str = "delete-worktree-progress";
/// An in-app `gh auth login` advanced a step.
pub const GITHUB_SIGNIN_PROGRESS: &str = "github-signin-progress";
/// A native provider OAuth sign-in advanced a step.
pub const PROVIDER_OAUTH_PROGRESS: &str = "provider-oauth-progress";

/// Every name above, for the parity test. Keep in step with the constants.
#[cfg(test)]
#[allow(dead_code)] // consumed once the events.ts parity test lands
pub(crate) const ALL: &[&str] = &[
    REPO_CHANGED,
    PTY_DATA,
    PTY_EXIT,
    CLONE_PROGRESS,
    ACP_PROGRESS,
    HANDOFF_PROGRESS,
    DELETE_WORKTREE_PROGRESS,
    GITHUB_SIGNIN_PROGRESS,
    PROVIDER_OAUTH_PROGRESS,
];

/// Publish `payload` to the webview under a declared event `name`.
///
/// The result is intentionally discarded: every event here is advisory, and a
/// webview that has gone away must not fail the git operation reporting to it.
pub(crate) fn emit<P: Serialize + Clone>(app: &AppHandle, name: &str, payload: P) {
    let _ = app.emit(name, payload);
}

/// [`REPO_CHANGED`] payload: what changed, and which open path it belongs to
/// (`summary.path`) so the frontend can route it to the matching tab.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoChangedEvent {
    pub(crate) kind: crate::watcher::ChangeKind,
    pub(crate) path: String,
}

/// [`PTY_DATA`] payload: raw bytes read from the session's master side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyDataEvent {
    pub(crate) session_id: u64,
    pub(crate) data: Vec<u8>,
}

/// [`PTY_EXIT`] payload: the session whose shell exited.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyExitEvent {
    pub(crate) session_id: u64,
}

/// [`HANDOFF_PROGRESS`] payload — one per phase as it begins, so the hand-off
/// dialog can tick its step checklist live. `step` is one of the ids documented
/// on [`crate::git::write::worktrees::move_branch_to_worktree`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffProgressEvent {
    pub step: String,
}

/// [`DELETE_WORKTREE_PROGRESS`] payload — one per phase as it begins. `step` is
/// one of the ids documented on
/// [`crate::git::write::worktrees::delete_branch_with_worktree`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorktreeProgressEvent {
    pub step: String,
}

/// [`GITHUB_SIGNIN_PROGRESS`] payload. `code`/`url` are present only on the
/// initial `"code"` step.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignInProgress {
    /// `"code"` | `"browser"` | `"authorized"`.
    pub(crate) step: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
}
