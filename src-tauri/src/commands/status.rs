//! Working-tree status and every diff read (commit, range, selection, compare, history, blame).

use super::{blocking, CommandError};
use crate::git;
use crate::git::types::{
    BinaryBlob, CompareResult, FileBlame, FileChange, FileDiff, FileHistoryPage, WorkingChanges,
};

// Every read here scales with the working tree, the commit, or the range it
// inspects — a status walk over tens of thousands of files, a tree diff, a
// blob diff. Like `commit_graph`, all of them run on the blocking pool so the
// webview keeps repainting while they work (`ipc/commands` spec); the non-Send
// Repository is opened and dropped inside each closure.

#[tauri::command]
pub async fn working_changes(path: String) -> Result<WorkingChanges, CommandError> {
    blocking(move || git::status::working_changes(&path)).await
}

#[tauri::command]
pub async fn file_diff(
    path: String,
    file: String,
    staged: bool,
    full: Option<bool>,
) -> Result<FileDiff, CommandError> {
    blocking(move || git::status::file_diff(&path, &file, staged, full.unwrap_or(false))).await
}

#[tauri::command]
pub async fn commit_files(path: String, oid: String) -> Result<Vec<FileChange>, CommandError> {
    blocking(move || git::status::commit_files(&path, &oid)).await
}

/// Read a binary blob's bytes (base64) for an inline preview. `oid` selects a
/// committed/staged blob; omit it (with `file` set) to read the working-tree
/// file by path — the side libgit2 leaves without a blob oid in an unstaged diff.
///
/// Reads up to a few MiB off disk/ODB and base64-encodes it, so it runs on the
/// blocking pool (like `commit_graph`) to keep the webview thread responsive when
/// several image panes load at once.
#[tauri::command]
pub async fn read_binary_blob(
    path: String,
    oid: Option<String>,
    file: Option<String>,
    max_bytes: Option<u64>,
) -> Result<BinaryBlob, CommandError> {
    blocking(move || {
        git::status::read_binary_blob(&path, oid.as_deref(), file.as_deref(), max_bytes)
    })
    .await
}

#[tauri::command]
pub async fn commit_file_diff(
    path: String,
    oid: String,
    file: String,
    full: Option<bool>,
) -> Result<FileDiff, CommandError> {
    blocking(move || git::status::commit_file_diff(&path, &oid, &file, full.unwrap_or(false))).await
}

#[tauri::command]
pub async fn diff_range(
    path: String,
    base: String,
    head: String,
) -> Result<Vec<FileChange>, CommandError> {
    blocking(move || git::status::diff_range(&path, &base, &head)).await
}

#[tauri::command]
pub async fn diff_range_file(
    path: String,
    base: String,
    head: String,
    file: String,
    full: Option<bool>,
) -> Result<FileDiff, CommandError> {
    blocking(move || {
        git::status::diff_range_file(&path, &base, &head, &file, full.unwrap_or(false))
    })
    .await
}

// The heaviest of the reads: a multi-thousand-commit history walk (each step
// diffing one file), blame over a long file, or a full-tree comparison.
#[tauri::command]
pub async fn file_history(
    path: String,
    file: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<FileHistoryPage, CommandError> {
    blocking(move || git::status::file_history(&path, &file, offset, limit)).await
}

#[tauri::command]
pub async fn file_blame(
    path: String,
    file: String,
    revision: Option<String>,
    limit: Option<usize>,
) -> Result<FileBlame, CommandError> {
    blocking(move || git::status::file_blame(&path, &file, revision, limit)).await
}

#[tauri::command]
pub async fn compare_refs(
    path: String,
    base: String,
    head: Option<String>,
) -> Result<CompareResult, CommandError> {
    blocking(move || git::status::compare_refs(&path, &base, head.as_deref())).await
}

#[tauri::command]
pub async fn compare_file_diff(
    path: String,
    base: String,
    head: Option<String>,
    file: String,
    full: Option<bool>,
) -> Result<FileDiff, CommandError> {
    blocking(move || {
        git::status::compare_file_diff(&path, &base, head.as_deref(), &file, full.unwrap_or(false))
    })
    .await
}

/// Merged ("union") diff across a multi-commit selection (GL-69): the net change
/// per file across an arbitrary `oids` set. Walks one tree diff per selected
/// commit, so it runs on the blocking pool like the other range reads.
#[tauri::command]
pub async fn selection_diff(
    path: String,
    oids: Vec<String>,
) -> Result<Vec<FileChange>, CommandError> {
    blocking(move || git::status::selection_diff(&path, &oids)).await
}

#[tauri::command]
pub async fn selection_diff_file(
    path: String,
    oids: Vec<String>,
    file: String,
    full: Option<bool>,
) -> Result<FileDiff, CommandError> {
    blocking(move || git::status::selection_diff_file(&path, &oids, &file, full.unwrap_or(false)))
        .await
}

#[cfg(test)]
mod tests {
    use crate::git::types::CommandErrorKind;

    #[test]
    fn a_read_outside_a_repository_keeps_its_libgit2_kind() {
        // The git2 error used to be stringified here and re-classified as
        // `kind: git`; it must cross IPC with the kind libgit2 reported.
        let dir = std::env::temp_dir().join(format!("gitlane-not-a-repo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().into_owned();
        let error = tauri::async_runtime::block_on(super::working_changes(path)).unwrap_err();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(error.kind, CommandErrorKind::NotARepository, "{error:?}");
    }
}
