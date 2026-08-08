//! Linked worktrees: their listing, dirty state, removal preview, and the
//! progress events the hand-off and delete flows stream to the UI.

use serde::Serialize;

/// Payload of the `handoff-progress` Tauri event emitted while
/// `move_branch_to_worktree` runs — one per phase as it begins, so the hand-off
/// dialog can tick its step checklist live. `step` is one of the ids documented
/// on [`crate::git::write::worktrees::move_branch_to_worktree`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffProgressEvent {
    pub step: String,
}

/// Payload of the `delete-worktree-progress` Tauri event emitted while
/// `delete_branch_with_worktree` runs — one per phase as it begins, so the
/// delete-branch-and-worktree dialog can tick its step checklist live. `step` is
/// one of the ids documented on
/// [`crate::git::write::worktrees::delete_branch_with_worktree`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorktreeProgressEvent {
    pub step: String,
}

/// A linked worktree entry for the sidebar's WORKTREES group.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// Leaf directory name of the worktree (display label).
    pub name: String,
    /// Absolute path to the worktree.
    pub path: String,
    /// Checked-out branch (short name), or None when detached / bare.
    pub branch: Option<String>,
    /// Commit oid the worktree's HEAD points at (`HEAD` attribute), or None for
    /// a bare entry. Lets the UI locate a detached worktree in the graph.
    pub head: Option<String>,
    /// True for the primary (main) worktree.
    pub is_main: bool,
    /// True when this is a bare repository (`git worktree list --porcelain`
    /// `bare` attribute) — it has no working tree, so a branch can't be checked
    /// out into it (it can't be a handoff destination).
    pub bare: bool,
    /// True when the worktree is prunable — its directory is gone/stale
    /// (`prunable` attribute). Also not a usable checkout target.
    pub prunable: bool,
    /// True when the worktree is locked (`locked [reason]` attribute). git
    /// refuses to remove a locked worktree without `--force --force`.
    pub locked: bool,
}

/// Shared preview for Linked Worktree Removal (GL-303). Carries the opaque
/// Worktree Removal Lease plus display fields (`requires_force`, dirty counts,
/// ignored disclosure). Combined Branch-and-Worktree Deletion consumes the same
/// `expected_state`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveWorktreePreview {
    pub summary: String,
    pub details: Vec<String>,
    pub warnings: Vec<String>,
    pub expected_state: String,
    /// Display / server-derived force bit: dirty and/or locked when the lease
    /// was captured. Execute does not take a client `force` flag.
    pub requires_force: bool,
    pub locked: bool,
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    pub dirty: WorktreeDirtyState,
}

/// Uncommitted work sitting in a linked worktree, probed on demand before a
/// destructive removal so the confirm can name what a forced remove would
/// discard. Deliberately *not* part of `WorktreeInfo`: that list is rebuilt on
/// every watcher-driven refresh, and a `git status` per worktree on that hot
/// path costs far more than the `worktree list` it would ride along with.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDirtyState {
    /// Changed tracked files (modified, added, deleted, renamed) — work that a
    /// forced removal destroys with no reflog and no stash to recover from.
    pub modified: u32,
    /// Untracked files. Counted with `--untracked-files=all` (not the default
    /// collapsed-directory form) so the confirm quotes a real file count.
    pub untracked: u32,
    /// Ignored entries (`!!` records), counted with **directories collapsed** —
    /// unlike the two fields above. `node_modules/` is one entry, not fifty
    /// thousand: expanding it is slow to produce and useless to read.
    ///
    /// Git treats ignored files as disposable — an *unforced* `git worktree
    /// remove` deletes them — so they never make a worktree "dirty" and never
    /// force a removal. They are counted anyway because "ignored" is not
    /// "worthless": a local `.env` is ignored, and deleting one without saying
    /// so is the difference between a safe cleanup and a silent loss.
    pub ignored: u32,
}
