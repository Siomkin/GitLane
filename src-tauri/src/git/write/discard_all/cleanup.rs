//! Removing the untracked leaves the lease captured. Paths go to `git clean` in
//! batches bounded by argument count and total bytes, because the captured set
//! can be far larger than one command line holds.

use std::collections::BTreeSet;
use std::path::Path;

use crate::git::worktree_fs::{
    validate_worktree_leaf_observation_path, worktree_leaf_is_missing_path,
};

use super::super::state_lease::{os_bytes, path_label, RepositoryScope};
use super::hooks::run_after_first_clean_batch_test_hook;
use super::nested::nested_repository_root;
use super::{
    git_bytes, run_scoped_git_paths, validate_repository_scope, CleanupKind, CleanupLeaf,
    DiscardAllSnapshot, CLEAN_PATH_BATCH_MAX_ARGS, CLEAN_PATH_BATCH_MAX_BYTES, STALE_MESSAGE,
};

pub(super) fn cleanup_paths<'a>(
    scope: &RepositoryScope,
    leaves: impl Iterator<Item = &'a CleanupLeaf>,
    include_ignored: bool,
) -> Result<bool, String> {
    let leaves = leaves.collect::<Vec<_>>();
    if leaves.is_empty() {
        return Ok(false);
    }
    let mut start = 0usize;
    while start < leaves.len() {
        let mut end = start;
        let mut bytes = 0usize;
        while end < leaves.len() && end - start < CLEAN_PATH_BATCH_MAX_ARGS {
            let next = os_bytes(&leaves[end].path).len() + 1;
            if end > start && bytes + next > CLEAN_PATH_BATCH_MAX_BYTES {
                break;
            }
            bytes += next;
            end += 1;
        }
        validate_repository_scope(scope).map_err(|error| {
            if start > 0 {
                format!(
                    "Approved untracked cleanup partially completed, but the repository scope changed before the next cleanup batch; the remaining files were preserved: {error}"
                )
            } else {
                error
            }
        })?;
        for leaf in &leaves[start..end] {
            if let Some(root) = nested_repository_root(&scope.workdir, &leaf.path) {
                return Err(if start > 0 {
                    format!(
                        "Approved untracked cleanup partially completed, but {} is now inside nested Git repository {}; the remaining files were preserved.",
                        path_label(&leaf.path),
                        path_label(&root)
                    )
                } else {
                    format!(
                        "Repository state changed after confirmation: {} is now inside nested Git repository {}; no files were removed. Refresh and preview again.",
                        path_label(&leaf.path),
                        path_label(&root)
                    )
                });
            }
            let unchanged = validate_worktree_leaf_observation_path(
                &scope.workdir,
                Path::new(&leaf.path),
                &leaf.observation,
            )
            .map_err(|error| {
                if start > 0 {
                    format!(
                        "Approved untracked cleanup partially completed, but {} could not be rechecked before its cleanup batch; the remaining files were preserved: {error}",
                        path_label(&leaf.path)
                    )
                } else {
                    format!(
                        "Could not recheck approved cleanup path {}: {error}",
                        path_label(&leaf.path)
                    )
                }
            })?;
            if !unchanged {
                return Err(if start > 0 {
                    format!(
                        "Approved untracked cleanup partially completed, but {} changed before its cleanup batch; the newer file was preserved.",
                        path_label(&leaf.path)
                    )
                } else {
                    STALE_MESSAGE.to_string()
                });
            }
        }
        let prefix: &[&str] = if include_ignored {
            &["--literal-pathspecs", "clean", "-f", "-x", "--"]
        } else {
            &["--literal-pathspecs", "clean", "-f", "--"]
        };
        let batch_paths = leaves[start..end]
            .iter()
            .map(|leaf| leaf.path.clone())
            .collect::<Vec<_>>();
        run_scoped_git_paths(scope, prefix, &batch_paths).map_err(|error| {
            format!(
                "Approved untracked cleanup could not finish; some approved files may already have been removed: {error}"
            )
        })?;
        if start == 0 {
            run_after_first_clean_batch_test_hook();
        }
        start = end;
    }
    validate_repository_scope(scope).map_err(|error| {
        format!(
            "Approved untracked cleanup ran, but the repository scope changed before GitLane could verify it: {error}"
        )
    })?;
    for leaf in &leaves {
        let missing = worktree_leaf_is_missing_path(&scope.workdir, Path::new(&leaf.path))
            .map_err(|error| {
                format!(
                    "Approved untracked cleanup ran, but GitLane could not verify removal of {}: {error}",
                    path_label(&leaf.path)
                )
            })?;
        if !missing {
            return Err(format!(
                "Approved untracked cleanup ran, but did not remove {}.",
                path_label(&leaf.path)
            ));
        }
    }
    Ok(true)
}

pub(super) fn cleanup_set(
    snapshot: &DiscardAllSnapshot,
    kind: CleanupKind,
) -> Result<BTreeSet<Vec<u8>>, String> {
    snapshot
        .cleanup
        .iter()
        .filter(|leaf| leaf.kind == kind)
        .map(|leaf| git_bytes(&leaf.path))
        .collect()
}
