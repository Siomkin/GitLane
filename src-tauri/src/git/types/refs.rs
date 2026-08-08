//! Refs the navigator lists: local and remote branches with their sync state,
//! stash entries, and reflog entries.

use serde::Serialize;

/// A stash entry for the sidebar's STASHES group.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// Stash index `N` in `stash@{N}` (0 = most recent).
    pub index: usize,
    /// The stash subject line.
    pub message: String,
    /// The stash commit oid (diffable like a commit vs its first parent).
    pub oid: String,
    /// Committer timestamp of the stash commit itself, used to slot the stash
    /// into the date-ordered history at the point it was created (stashes sit at
    /// their own time, not next to their base commit).
    pub timestamp: i64,
    /// First parent of the stash commit: the commit the stash was created from.
    pub base_oid: Option<String>,
    /// Author timestamp of `base_oid`, used to place dangling-base stashes near
    /// their chronological position when the exact base is outside the graph.
    pub base_timestamp: Option<i64>,
    /// Bounded first-parent chain from `base_oid`, used only when the exact base
    /// is outside the visible branch graph but rejoins it shortly after.
    pub context: Vec<StashContextCommit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashContextCommit {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
}

/// A branch entry for the sidebar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    /// "local" | "remote".
    pub kind: String,
    pub target: Option<String>,
    /// Committer time (epoch seconds) of the branch's tip commit. Git records
    /// no branch *creation* time, so this is the proxy for "last updated" that
    /// the navigator orders branches by. `None` when the tip can't be peeled.
    pub tip_time: Option<i64>,
    pub is_head: bool,
    /// Upstream branch name, if any (local branches only).
    pub upstream: Option<String>,
    /// For a remote branch (`kind == "remote"`), the configured remote it
    /// belongs to — resolved by matching the ref against the known remote list,
    /// so a slash-containing remote name is handled correctly. `None` for local
    /// branches. Lets the frontend address the remote/branch split without
    /// re-guessing it from the first `/`.
    pub remote: Option<String>,
    /// For a local branch, its fetch/upstream remote
    /// (`branch.<name>.remote`) when set. Git's `"."` value denotes another
    /// branch in the same repository. `None` for remote branches.
    pub upstream_remote: Option<String>,
    /// For a local branch, the actual push remote after Git's precedence:
    /// `branch.<name>.pushRemote` → `remote.pushDefault` →
    /// `branch.<name>.remote` → `origin`. `None` for remote branches.
    pub push_remote: Option<String>,
    /// Ahead/behind state against the configured upstream. Remote branches do
    /// not have their own upstream state, so this is `None` for them.
    pub sync: Option<BranchSyncState>,
}

/// Local branch sync state resolved by libgit2.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSyncState {
    /// "noRemote" | "noUpstream" | "staleUpstream" | "unknown" |
    /// "upToDate" | "ahead" | "behind" | "diverged".
    pub status: String,
    /// Configured upstream display name (e.g. `origin/main`), including stale
    /// upstreams that no longer resolve to a remote-tracking ref.
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
}

/// One recent reflog entry from HEAD or a local ref. Recovery operations use
/// `oid`, while the selectors make the original reflog source visible.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    pub oid: String,
    pub short_oid: String,
    pub selector: String,
    pub short_selector: String,
    pub ref_name: String,
    pub subject: String,
    pub committer_name: String,
    pub committer_email: String,
    pub timestamp: i64,
}
