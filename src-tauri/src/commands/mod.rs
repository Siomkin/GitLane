//! The Tauri command layer, one module per domain (GL-360). Each command here
//! is registered in `lib.rs`'s single path-qualified `generate_handler!` list.
//!
//! Every command rejects with a [`CommandError`] (`ipc/commands` spec): the
//! [`blocking`] / [`sync`] adapters below are the one place an internal error
//! becomes the boundary type, gets classified, and is redacted — so no command
//! can bypass either step by construction.
//!
//! `CommandError` carries five optional context strings and trips clippy's
//! 128-byte `result_large_err` threshold. It crosses IPC exactly once per
//! command and is never returned in a hot loop, so the boxing the lint asks
//! for would only add an allocation on the failure path.
#![allow(clippy::result_large_err)]

pub mod auth;
pub mod branches;
pub mod commits;
pub mod conflicts;
pub mod files;
pub mod github;
pub mod identity;
pub mod recovery;
pub mod remotes;
pub mod repo;
pub mod staging;
pub mod status;
pub mod tags;
pub mod terminal;
pub mod worktrees;

pub use crate::git::types::CommandError;

/// Run blocking work (a `git`/`gh` subprocess) off the webview's main thread.
/// Synchronous Tauri commands execute on the main thread, so a blocking
/// subprocess there freezes the whole UI (no repaint) until it returns; wrapping
/// the work in `spawn_blocking` keeps the UI responsive. In-process libgit2
/// reads stay synchronous — they're fast and don't shell out.
///
/// The closure may fail with anything that converts into [`CommandError`]
/// (`String` diagnostics are classified, `git2::Error`s are typed, the forge
/// and OAuth enums map by variant). The result is redacted before it returns.
pub async fn blocking<T, E, F>(f: F) -> Result<T, CommandError>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    E: Into<CommandError> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(result) => boundary(result),
        Err(join) => Err(CommandError::internal(format!("git task failed: {join:?}"))),
    }
}

/// The synchronous twin of [`blocking`] for commands that are instant by
/// design (lock-and-kill cancels, PTY writes, in-process metadata reads):
/// same conversion and redaction, no thread hop.
pub fn sync<T, E, F>(f: F) -> Result<T, CommandError>
where
    F: FnOnce() -> Result<T, E>,
    E: Into<CommandError>,
{
    boundary(f())
}

/// Convert + redact an already-computed result. The one adapter for commands
/// whose work is genuinely `async` (the updater's HTTP check) and so cannot sit
/// inside a `blocking` closure; `blocking` and `sync` funnel through it too.
pub fn boundary<T, E>(result: Result<T, E>) -> Result<T, CommandError>
where
    E: Into<CommandError>,
{
    result.map_err(|e| e.into().redacted())
}
/// Guard the declaration/registration/invocation parity that the compiler
/// cannot: a `#[tauri::command]` fn missing from `lib.rs`'s
/// `generate_handler!` list compiles fine and only fails at runtime with
/// "command not found" (the #1 IPC footgun), and a frontend `invoke("…")`
/// naming an unregistered command fails the same way.
#[cfg(test)]
mod registration_tests;
