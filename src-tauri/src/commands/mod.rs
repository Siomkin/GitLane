//! The Tauri command layer, one module per domain (GL-360). Each command here
//! is registered in `lib.rs`'s single path-qualified `generate_handler!` list.

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

/// Run blocking work (a `git`/`gh` subprocess) off the webview's main thread.
/// Synchronous Tauri commands execute on the main thread, so a blocking
/// subprocess there freezes the whole UI (no repaint) until it returns; wrapping
/// the work in `spawn_blocking` keeps the UI responsive. In-process libgit2
/// reads stay synchronous — they're fast and don't shell out.
pub async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("git task failed: {e:?}"))?
}
