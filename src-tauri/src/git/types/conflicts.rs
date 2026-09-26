//! The in-progress merge/sequencer operation and the conflicted files it left.

use serde::{Deserialize, Serialize};

/// The in-progress merge/sequencer operation that left the repo in a conflicted
/// or mid-operation state — mapped from libgit2's `RepositoryState`, so a
/// rebase/cherry-pick/revert started from a terminal is detected too. `Carry`
/// is GitLane's own worktree-handoff carry (GL-74), not a git state.
///
/// Also the `kind` argument of `continue_operation` / `abort_operation` /
/// `skip_operation`, so an unknown word fails to deserialize at the command
/// boundary instead of reaching the write as "no active operation".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Carry,
    None,
}

impl OperationKind {
    /// The wire word (`"cherry-pick"`, …), used in user-facing copy.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Rebase => "rebase",
            Self::CherryPick => "cherry-pick",
            Self::Revert => "revert",
            Self::Carry => "carry",
            Self::None => "none",
        }
    }

    /// The git subcommand that drives this operation (`git <sub> --continue`),
    /// or `None` for GitLane's own worktree-handoff carry and the idle state.
    pub fn subcommand(self) -> Option<&'static str> {
        match self {
            Self::Merge | Self::Rebase | Self::CherryPick | Self::Revert => Some(self.as_str()),
            Self::Carry | Self::None => Option::None,
        }
    }
}

/// A non-drivable in-progress git state surfaced as a read-only advisory (not
/// the conflict workspace). These have no in-app continue/abort — the banner
/// points the user at the terminal — so they stay out of [`OperationKind`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationAdvisory {
    ApplyMailbox,
    Bisect,
    /// The repo is clean or in a drivable operation.
    #[serde(rename = "")]
    None,
}

/// Drives the conflict-resolution workflow.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationStatus {
    pub kind: OperationKind,
    /// True when the operation supports `--skip` (rebase/cherry-pick/revert).
    pub can_skip: bool,
    /// Unmerged (conflicted) paths still needing resolution. Empty when the
    /// operation has no outstanding conflicts (e.g. all already staged).
    pub conflicts: Vec<ConflictFile>,
    pub advisory: OperationAdvisory,
}

/// How one conflicted (unmerged) path should be resolved in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    /// Both sides changed, line-mergeable.
    Text,
    /// Both sides changed, not line-mergeable (or a symlink/gitlink).
    Binary,
    /// One side (or both) removed the file.
    Deleted,
}

/// One conflicted (unmerged) path in the index.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub kind: ConflictKind,
    /// For the [`ConflictKind::Deleted`] kind, which side removed it:
    /// "ours" | "theirs", or "both" for a both-deleted (DD) conflict. Empty
    /// for text/binary conflicts.
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
