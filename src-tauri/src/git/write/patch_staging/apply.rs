//! Stage or unstage one hunk or one line from a displayed diff.

use super::super::cli::run_git;
use super::extract::{extract_single_hunk_patch, extract_single_line_patch};
use super::runners::{apply_hunk_patch, apply_line_patch, patch_diff_args};
use crate::git::types::ApplyLineRequest;

/// Stage one hunk from the worktree diff, or unstage one hunk from the staged
/// diff when `staged` is true. Git still owns patch parsing/application; the
/// frontend only chooses a hunk index from the diff it is showing.
pub fn apply_hunk(
    repo: &str,
    file: &str,
    staged: bool,
    hunk_index: usize,
    expected_header: &str,
    expected_body: &str,
) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let args = patch_diff_args(staged, file);
    let diff = run_git(repo, &args)?;
    let patch = extract_single_hunk_patch(&diff, hunk_index, expected_header, expected_body)?;
    apply_hunk_patch(repo, &patch, staged)?;
    Ok(format!(
        "{} hunk in {file}",
        if staged { "Unstaged" } else { "Staged" }
    ))
}

/// Stage one changed line from the worktree diff, or unstage one changed line
/// from the staged diff when `staged` is true. The frontend identifies the
/// displayed line; Rust regenerates the current patch and rejects stale line
/// state before applying anything.
pub fn apply_line(repo: &str, request: &ApplyLineRequest) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let args = patch_diff_args(request.staged, &request.file);
    let diff = run_git(repo, &args)?;
    let patch = extract_single_line_patch(
        &diff,
        request.hunk_index,
        request.line_index,
        &request.expected_kind,
        &request.expected_content,
        request.expected_old_no,
        request.expected_new_no,
    )?;
    apply_line_patch(repo, &patch, request.staged)?;
    Ok(format!(
        "{} line in {}",
        if request.staged { "Unstaged" } else { "Staged" },
        request.file
    ))
}
