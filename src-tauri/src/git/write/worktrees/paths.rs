//! Worktree path helpers shared by the rest of the module.

use std::path::PathBuf;

use super::super::cli::run_git;

/// Compare two worktree paths on their resolved real path: git's porcelain
/// output canonicalizes (e.g. macOS `/var` → `/private/var`), so a raw string
/// compare against a UI-supplied path can spuriously miss. Falls back to a
/// trimmed compare when a path can't be resolved (e.g. it's already gone).
pub(super) fn same_path(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.trim_end_matches('/') == b.trim_end_matches('/'),
    }
}

/// The absolute git dir of a (possibly linked) worktree — where the handoff
/// marker lives. Matches libgit2's `Repository::path` on the read side. Shared
/// with `conflict_resolution` so continue/abort resolve the same marker.
pub(in crate::git::write) fn worktree_git_dir(worktree: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(
        run_git(worktree, &["rev-parse", "--absolute-git-dir"])?.trim(),
    ))
}
