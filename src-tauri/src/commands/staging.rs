//! Stage/unstage (file, hunk, line, line range), revert line ranges, discard-file, ignore, and restore-from-commit.

use super::{blocking, CommandError};
use crate::git;
use crate::git::types::DiscardFilePreview;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn apply_hunk(
    path: String,
    file: String,
    staged: bool,
    hunk_index: usize,
    expected_header: String,
    expected_body: String,
) -> Result<String, CommandError> {
    blocking(move || {
        git::write::patch_staging::apply_hunk(
            &path,
            &file,
            git::status::IndexSide::from_staged(staged),
            hunk_index,
            &expected_header,
            &expected_body,
        )
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn apply_line(
    path: String,
    request: git::types::ApplyLineRequest,
) -> Result<String, CommandError> {
    blocking(move || git::write::patch_staging::apply_line(&path, &request)).await
}

/// Stage (or, with `staged`, unstage) several displayed line ranges as one patch.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn apply_line_range(
    path: String,
    request: git::types::ApplyLineRangeRequest,
) -> Result<String, CommandError> {
    blocking(move || git::write::patch_staging::apply_line_range(&path, &request)).await
}

/// Restore unstaged line ranges to the index content in the working tree.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn revert_line_range(
    path: String,
    request: git::types::ApplyLineRangeRequest,
) -> Result<String, CommandError> {
    blocking(move || git::write::patch_staging::revert_line_range(&path, &request)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn stage_files(path: String, files: Vec<String>) -> Result<String, CommandError> {
    blocking(move || git::write::staging::stage_files(&path, &files)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn unstage_files(path: String, files: Vec<String>) -> Result<String, CommandError> {
    blocking(move || git::write::staging::unstage_files(&path, &files)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn preview_discard_file(
    path: String,
    file: String,
    previous_file: Option<String>,
    staged: bool,
) -> Result<DiscardFilePreview, CommandError> {
    blocking(move || {
        git::write::discard_file::preview_discard_file(
            &path,
            &file,
            previous_file.as_deref(),
            git::status::IndexSide::from_staged(staged),
        )
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn discard_file(
    path: String,
    file: String,
    previous_file: Option<String>,
    staged: bool,
    expected_state: String,
) -> Result<String, CommandError> {
    blocking(move || {
        git::write::discard_file::discard_file(
            &path,
            &file,
            previous_file.as_deref(),
            git::status::IndexSide::from_staged(staged),
            &expected_state,
        )
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn append_ignore_pattern(
    path: String,
    pattern: String,
    local: bool,
) -> Result<String, CommandError> {
    let file = git::write::ignore::IgnoreFile::from_local(local);
    blocking(move || git::write::ignore::append_ignore_pattern(&path, &pattern, file)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn stop_tracking(path: String, file: String) -> Result<String, CommandError> {
    blocking(move || git::write::staging::stop_tracking(&path, &file)).await
}

/// ADR 0003: true when restoring `file` from `commit_oid` would change on-disk bytes.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn worktree_differs_from_commit(
    path: String,
    commit_oid: String,
    file: String,
) -> Result<bool, CommandError> {
    blocking(move || {
        git::write::restore_path::worktree_differs_from_commit(&path, &commit_oid, &file)
    })
    .await
}

/// ADR 0003: true when `file` has a restorable (non-gitlink) blob at `commit_oid`.
/// Lets the merged-selection surface probe the selection-tip commit before
/// offering Restore for a union path.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn commit_path_is_restorable(
    path: String,
    commit_oid: String,
    file: String,
) -> Result<bool, CommandError> {
    blocking(move || {
        Ok::<_, CommandError>(git::write::restore_path::commit_path_is_restorable(
            &path,
            &commit_oid,
            &file,
        ))
    })
    .await
}

/// ADR 0003: restore one path into the worktree from a commit (does not stage).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn restore_path_from_commit(
    path: String,
    commit_oid: String,
    file: String,
) -> Result<String, CommandError> {
    blocking(move || git::write::restore_path::restore_path_from_commit(&path, &commit_oid, &file))
        .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn stage_all(path: String) -> Result<String, CommandError> {
    blocking(move || git::write::staging::stage_all(&path)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn unstage_all(path: String) -> Result<String, CommandError> {
    blocking(move || git::write::staging::unstage_all(&path)).await
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    #[test]
    fn preview_discard_file_maps_the_wire_staged_flag_to_its_side() {
        let dir = std::env::temp_dir().join(format!("gitlane-cmd-discard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.email", "t@t.t"]);
        git(&dir, &["config", "user.name", "T"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        git(&dir, &["add", "f.txt"]);
        git(&dir, &["commit", "-qm", "base"]);
        std::fs::write(dir.join("f.txt"), "staged\n").unwrap();
        git(&dir, &["add", "f.txt"]);
        std::fs::write(dir.join("f.txt"), "unstaged\n").unwrap();

        let preview = |staged| {
            let path = dir.to_string_lossy().into_owned();
            tauri::async_runtime::block_on(super::preview_discard_file(
                path,
                "f.txt".to_string(),
                None,
                staged,
            ))
        };
        let staged = preview(true);
        let unstaged = preview(false);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            staged.unwrap().summary,
            "Unstage and discard changes in f.txt"
        );
        assert_eq!(
            unstaged.unwrap().summary,
            "Discard unstaged changes in f.txt"
        );
    }
}
