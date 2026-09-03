//! The repository Files browser: worktree reads, the in-app editor's guarded write, and open/reveal.

use super::{blocking, CommandError};
use crate::git;
use crate::git::types::{RepoFileContent, RepoFileWriteResult};

/// Every file in the worktree (tracked + untracked, ignored excluded),
/// repo-relative and sorted. The status pass can be expensive on large repos,
/// so run it on the blocking pool like `commit_graph`.
#[tauri::command]
pub async fn list_repo_files(path: String) -> Result<Vec<String>, CommandError> {
    blocking(move || git::status::list_repo_files(&path).map_err(|e| e.to_string())).await
}

/// Read one worktree file's text for the read-only viewer. Binary/oversized
/// content comes back as flags, never raw bytes. Reads up to a couple MiB off
/// disk, so it runs on the blocking pool (like `read_binary_blob`).
#[tauri::command]
pub async fn repo_file_text(
    path: String,
    file: String,
    max_bytes: Option<u64>,
) -> Result<RepoFileContent, CommandError> {
    blocking(move || {
        git::status::repo_file_text(&path, &file, max_bytes).map_err(|e| e.to_string())
    })
    .await
}

/// The committed (HEAD) text of one file — the baseline for the viewer/editor's
/// uncommitted-change gutter markers. `None` when there's nothing to diff
/// against (unborn HEAD, untracked path, binary/oversized blob). Reads a blob,
/// so it runs on the blocking pool like the worktree read.
#[tauri::command]
pub async fn repo_file_head_text(
    path: String,
    file: String,
) -> Result<Option<String>, CommandError> {
    blocking(move || git::status::repo_file_head_text(&path, &file).map_err(|e| e.to_string()))
        .await
}

/// Save an edited worktree file back to disk for the in-app file editor. A
/// guarded, atomic write (overwrite-only, binary + exact-state refusals, temp +
/// rename) that runs on the blocking pool like the read; resolves with the next
/// exact-state lease for sequential saves.
#[tauri::command]
pub async fn write_repo_file(
    path: String,
    file: String,
    content: String,
    expected_size: u64,
    expected_state: String,
) -> Result<RepoFileWriteResult, CommandError> {
    blocking(move || {
        git::write::files::write_repo_file(&path, &file, &content, expected_size, &expected_state)
    })
    .await
}

#[tauri::command]
pub async fn reveal_in_file_manager(path: String, file: String) -> Result<String, CommandError> {
    blocking(move || git::write::reveal::reveal_in_file_manager(&path, &file)).await
}

#[tauri::command]
pub async fn open_path_default(path: String, file: String) -> Result<String, CommandError> {
    blocking(move || git::write::open_path::open_path_default(&path, &file)).await
}

#[tauri::command]
pub async fn open_path_difftool(path: String, file: String) -> Result<String, CommandError> {
    blocking(move || git::write::open_path::open_path_difftool(&path, &file)).await
}
