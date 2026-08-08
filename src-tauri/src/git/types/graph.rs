//! Commit-graph layout and history-search results — what the graph canvas paints.

use serde::{Deserialize, Serialize};

/// A label attached to a commit (branch tip, remote, tag, or HEAD).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub name: String,
    /// One of: "branch" | "remote" | "tag" | "head".
    pub kind: String,
    /// The exact object named by the ref. Present for tags so a destructive
    /// action can compare-and-swap the tag object itself; annotated tags peel
    /// to a different commit oid for graph placement.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_oid: Option<String>,
}

/// Marks a graph node that is actually a stash rather than a commit. In-window
/// stashes (those whose base commit is inside the loaded history) are injected
/// into the layout as synthetic single-parent nodes so the reservation algorithm
/// gives each its own held-open lane — the reserved-lane treatment where the fan
/// shifts right and the stash drops straight down to its base with nothing under
/// it. The frontend renders these as the amber `stash@{index}` marker + a dashed
/// edge to the base, instead of a commit dot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashRef {
    /// Stash index `N` in `stash@{N}` (0 = most recent).
    pub index: usize,
    /// The stash subject line.
    pub message: String,
}

/// A single commit, already positioned for the graph (`lane` = column,
/// `row` = vertical index). `color` indexes into the frontend palette.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitNode {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    /// Commit message body (everything after the summary line), trimmed.
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time, seconds since the Unix epoch.
    pub timestamp: i64,
    pub parents: Vec<String>,
    pub lane: usize,
    pub row: usize,
    pub color: usize,
    pub refs: Vec<RefLabel>,
    /// `Some` when this node is an in-window stash injected into the layout (its
    /// single parent is the stash base). `None` for ordinary commits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stash: Option<StashRef>,
}

/// A connection drawn between a commit and one of its parents. Positions are
/// resolved (both endpoints exist in the same `RepoGraph`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from_row: usize,
    pub from_lane: usize,
    pub to_row: usize,
    pub to_lane: usize,
    /// Zero-based parent index on the child commit. `0` is the first-parent
    /// continuation; `> 0` is a merge parent.
    pub parent_index: usize,
    pub color: usize,
}

/// The fully laid-out commit graph returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoGraph {
    pub commits: Vec<CommitNode>,
    pub edges: Vec<GraphEdge>,
    /// Total number of lanes used — the renderer sizes the gutter from this.
    pub lane_count: usize,
    /// Lane for the synthetic WIP marker. When HEAD is also an ancestor of a
    /// newer branch tip, the checked-out HEAD lane remains the mainline and
    /// the newer branch is pushed right.
    pub wip_lane: Option<usize>,
    /// Color index for the synthetic WIP marker lane.
    pub wip_color: Option<usize>,
    /// Oid of HEAD, if resolvable.
    pub head: Option<String>,
    /// True if more commits exist beyond `limit` (graph was truncated).
    pub truncated: bool,
}

/// Repository-wide commit search filters. Non-empty fields are combined with
/// AND semantics; message and diff content accept regular expressions while
/// occurrence_text mirrors `git log -S` with a literal occurrence-count test.
/// The timestamp bounds are inclusive epoch seconds compared against the
/// committer date (matching `git log --since/--until`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchQuery {
    pub message_pattern: Option<String>,
    pub author: Option<String>,
    pub path: Option<String>,
    pub revision: Option<String>,
    pub changed_pattern: Option<String>,
    pub occurrence_text: Option<String>,
    pub since_timestamp: Option<i64>,
    pub until_timestamp: Option<i64>,
    pub limit: Option<usize>,
}

/// A commit matched by [`HistorySearchQuery`]. Search results deliberately
/// carry display metadata but no graph coordinates: layout remains owned by
/// `commit_graph`, and the frontend pages that graph before revealing a hit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchResult {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchPage {
    pub results: Vec<HistorySearchResult>,
    /// True when the requested result cap or the diff-work budget stopped the
    /// search before the reachable history was exhausted.
    pub truncated: bool,
    /// True specifically when the diff-work budget stopped the search.
    pub work_truncated: bool,
}
