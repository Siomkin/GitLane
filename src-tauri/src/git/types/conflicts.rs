//! The in-progress merge/sequencer operation and the conflicted files it left.

use serde::Serialize;

/// The in-progress merge/sequencer operation that left the repo in a conflicted
/// or mid-operation state. Drives the conflict-resolution workflow. `kind` is
/// "merge" | "rebase" | "cherry-pick" | "revert" | "carry" | "none" — mapped
/// from libgit2's `RepositoryState`, so a rebase/cherry-pick/revert started from
/// a terminal is detected too.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationStatus {
    pub kind: String,
    /// True when the operation supports `--skip` (rebase/cherry-pick/revert).
    pub can_skip: bool,
    /// Unmerged (conflicted) paths still needing resolution. Empty when the
    /// operation has no outstanding conflicts (e.g. all already staged).
    pub conflicts: Vec<ConflictFile>,
    /// A non-drivable in-progress git state that GitLane surfaces as a read-only
    /// advisory (not the conflict workspace): "apply-mailbox" (`git am`) or
    /// "bisect". Empty when the repo is clean or in a drivable operation. These
    /// have no in-app continue/abort — the banner points the user at the
    /// terminal — so they stay out of `kind`.
    pub advisory: String,
}

/// One conflicted (unmerged) path in the index.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    /// "text" (both sides changed, line-mergeable), "binary" (both sides
    /// changed, not line-mergeable), or "deleted" (one side removed the file).
    pub kind: String,
    /// For the "deleted" kind, which side removed it: "ours" | "theirs", or
    /// "both" for a both-deleted (DD) conflict. Empty for text/binary conflicts.
    pub deleted_side: String,
}

/// The raw conflicted content of one text file — the worktree copy git wrote
/// with `<<<<<<< / ======= / >>>>>>>` markers — for the in-app editor to parse
/// into hunks. The frontend owns the marker parsing (pure + testable).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFileContent {
    pub path: String,
    pub content: String,
    /// True when the file is binary (no marker content; the editor offers a
    /// whole-file ours/theirs choice instead).
    pub binary: bool,
}
