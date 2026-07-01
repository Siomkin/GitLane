//! Shared state for the worktree branch-handoff carry flow (GL-74).
//!
//! Handing a branch off to another worktree can carry the *destination*
//! worktree's own uncommitted changes across the branch switch (stash → switch →
//! re-apply). When re-applying those changes conflicts, git leaves unmerged index
//! entries but **no** sequencer state — `RepositoryState` stays `Clean`, so the
//! normal [`crate::git::conflicts::operation_status`] can't see it. We drop a
//! small marker in the destination worktree's git dir recording the kept stash's
//! oid; conflict detection reports a `"carry"` operation **only** when the marker
//! AND unmerged entries are both present, so an unrelated terminal `git stash
//! pop` conflict is never mistaken for a handoff. Continue/abort consult the
//! marker to drop or preserve the right stash, then clear it.
//!
//! The marker lives in the worktree's own git dir (per-worktree, not the shared
//! common dir), so concurrent handoffs into different worktrees don't collide.

use std::path::{Path, PathBuf};

/// Operation kind reported for a carry-conflict — a sibling of the
/// merge/rebase/cherry-pick/revert keys the conflict workspace already drives.
pub const CARRY_KIND: &str = "carry";

const MARKER_FILE: &str = "gitlane-handoff";

fn marker_path(git_dir: &Path) -> PathBuf {
    git_dir.join(MARKER_FILE)
}

/// Record `stash_oid` as the kept carry stash for the worktree whose git dir is
/// `git_dir` (an absolute path, from `git rev-parse --absolute-git-dir` or
/// libgit2's `Repository::path`).
pub fn write_marker(git_dir: &Path, stash_oid: &str) -> Result<(), String> {
    std::fs::write(marker_path(git_dir), stash_oid.trim())
        .map_err(|e| format!("failed to write handoff marker: {e}"))
}

/// The kept carry stash oid recorded for this worktree, if a handoff carry is
/// mid-conflict. `None` when no marker is present (or it is empty).
pub fn read_marker(git_dir: &Path) -> Option<String> {
    std::fs::read_to_string(marker_path(git_dir))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Remove the marker (best-effort — a missing file is not an error).
pub fn clear_marker(git_dir: &Path) {
    let _ = std::fs::remove_file(marker_path(git_dir));
}
