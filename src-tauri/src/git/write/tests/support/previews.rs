//! Preview-then-execute helpers: each runs the confirm the UI would run and
//! feeds its lease straight into the write, so a test states the operation
//! rather than the two-step protocol.

use super::*;

pub(in crate::git::write::tests) const CLEAN_PATH_BATCH_MAX_ARGS: usize = 500;

pub(in crate::git::write::tests) fn discard_all_previewed(repo: &str) -> Result<String, String> {
    let preview = preview_discard_all(repo)?;
    discard_all(
        repo,
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
}

pub(in crate::git::write::tests) fn remove_worktree_previewed(
    repo: &str,
    worktree_path: &str,
) -> Result<String, String> {
    let preview = preview_remove_worktree(repo, worktree_path)?;
    remove_worktree(repo, worktree_path, &preview.expected_state)
}

pub(in crate::git::write::tests) fn delete_branch_with_worktree_previewed(
    repo: &str,
    branch: &str,
    from_worktree_path: &str,
    expected_oid: &str,
    progress: &dyn Fn(&'static str),
) -> Result<String, String> {
    let preview = preview_remove_worktree(repo, from_worktree_path)?;
    delete_branch_with_worktree(
        repo,
        branch,
        from_worktree_path,
        expected_oid,
        &preview.expected_state,
        progress,
    )
}

pub(in crate::git::write::tests) fn discard_current(
    repo: &TempRepo,
    file: &str,
    previous_file: Option<&str>,
    staged: bool,
) -> Result<String, String> {
    let preview = preview_discard_file(repo.path(), file, previous_file, staged)?;
    discard_file(
        repo.path(),
        file,
        previous_file,
        staged,
        &preview.expected_state,
    )
}

pub(in crate::git::write::tests) fn repo_file_lease(repo: &str, file: &str) -> (u64, String) {
    let content = crate::git::status::repo_file_text(repo, file, None).expect("editable read");
    (
        content.size,
        content.expected_state.expect("lossless text has a lease"),
    )
}
