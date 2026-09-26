//! Shared state for the worktree branch-handoff carry flow (GL-74).
//!
//! Handing a branch off to another worktree can carry the *destination*
//! worktree's own uncommitted changes across the branch switch (stash → switch →
//! re-apply). When re-applying those changes conflicts, git leaves unmerged index
//! entries but **no** sequencer state — `RepositoryState` stays `Clean`, so the
//! normal [`crate::git::conflicts::operation_status`] can't see it. We drop a
//! small marker in the destination worktree's git dir listing the oids of the
//! stashes the handoff kept for recovery, one per line. Conflict detection
//! reports a carry operation while the marker exists **and** at least one of
//! those stashes is still on the stack — deliberately *not* gated on unmerged
//! entries, since staging the last conflict must keep "Finish carry" available
//! (GL-74 P1). A marker whose stashes are all gone is stale and is cleared, so
//! it cannot hijack an unrelated later conflict. Continue drops the listed
//! stashes, abort preserves them; both then clear the marker.
//!
//! The marker lives in the worktree's own git dir (per-worktree, not the shared
//! common dir), so concurrent handoffs into different worktrees don't collide.

use std::path::{Path, PathBuf};

const MARKER_FILE: &str = "gitlane-handoff";

fn marker_path(git_dir: &Path) -> PathBuf {
    git_dir.join(MARKER_FILE)
}

/// Record `stash_oids` as the kept carry stashes for the worktree whose git dir
/// is `git_dir` (an absolute path, from `git rev-parse --absolute-git-dir` or
/// libgit2's `Repository::path`).
pub fn write_marker(git_dir: &Path, stash_oids: &[&str]) -> Result<(), String> {
    std::fs::write(marker_path(git_dir), stash_oids.join("\n").trim())
        .map_err(|e| format!("failed to write handoff marker: {e}"))
}

/// The kept carry stash oids recorded for this worktree. Empty when no marker
/// is present (or it lists nothing).
pub fn read_marker(git_dir: &Path) -> Vec<String> {
    std::fs::read_to_string(marker_path(git_dir))
        .map(|text| {
            text.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Remove the marker (best-effort — a missing file is not an error).
pub fn clear_marker(git_dir: &Path) {
    let _ = std::fs::remove_file(marker_path(git_dir));
}
