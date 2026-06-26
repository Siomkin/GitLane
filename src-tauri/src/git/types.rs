//! Serializable types shared across the Rust <-> frontend (IPC) boundary.
//!
//! Everything here is the data the React layer consumes; keep field names in
//! sync with `src/lib/api.ts`.

use serde::{Deserialize, Serialize};

/// A label attached to a commit (branch tip, remote, tag, or HEAD).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub name: String,
    /// One of: "branch" | "remote" | "tag" | "head".
    pub kind: String,
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

/// High-level repository state shown in the title bar / status area.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub path: String,
    pub workdir: Option<String>,
    pub head_branch: Option<String>,
    pub head_oid: Option<String>,
    /// True when HEAD is detached (not on a branch).
    pub detached: bool,
}

/// Remote-forge summary for the toolbar provider indicator. Pure libgit2
/// detection from the configured remote URLs — no network or auth probing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoForge {
    /// True when the repo has at least one remote with a non-empty URL.
    pub has_remote: bool,
    /// Lowercase forge key ("github", "gitlab", …). None when there is no
    /// remote or the host is not a recognised forge.
    pub kind: Option<String>,
    /// Human-readable forge label ("GitHub", "GitLab", …). None when unclassified.
    pub forge: Option<String>,
    /// Remote host (e.g. "github.com"). None when no remote URL is configured.
    pub host: Option<String>,
    /// Browser URL for the repo (`https://host/owner/repo`), derived from the
    /// remote URL. None when no path can be parsed (e.g. no remote).
    pub web_url: Option<String>,
}

/// The commit identity pinned in a repo's *local* git config (`user.name` /
/// `user.email`). `None` from the read side means nothing is pinned locally and
/// the repo defers to global git config.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoIdentity {
    pub name: String,
    pub email: String,
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
    /// True for the primary (main) worktree.
    pub is_main: bool,
}

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
    pub is_head: bool,
    /// Upstream branch name, if any (local branches only).
    pub upstream: Option<String>,
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

/// A single changed file in a diff (working tree, index, or a commit).
/// `status` is a one-letter git code: M(odified) A(dded) D(eleted) R(enamed)
/// C(opied) T(ypechange) U(ntracked) or `?` when unknown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub add: usize,
    pub del: usize,
}

/// The working-tree status split into staged (index vs HEAD) and unstaged
/// (worktree vs index) buckets — what the Changes/staging view consumes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingChanges {
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    /// Unmerged (conflicted) paths, kept out of staged/unstaged so the ordinary
    /// stage view never applies normal staging to a file git considers
    /// unresolved — but surfaced here so they stay visible even when operation
    /// detection misses them (`git am`/`bisect`, a transient detection failure).
    pub conflicted: Vec<FileChange>,
}

/// One line inside a diff hunk. `kind` is "ctx" | "add" | "del". Line numbers
/// are present only on the side(s) where the line exists.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub content: String,
}

/// A contiguous run of changed/context lines, with its `@@ … @@` header.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

/// A full file diff returned to the diff/review viewer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub status: String,
    pub add: usize,
    pub del: usize,
    pub binary: bool,
    pub hunks: Vec<DiffHunk>,
    /// True when the diff was capped at the line limit and `hunks` holds only
    /// the first portion of the change (the frontend offers "show full diff").
    pub truncated: bool,
}

/// The in-progress merge/sequencer operation that left the repo in a conflicted
/// or mid-operation state. Drives the conflict-resolution workflow. `kind` is
/// "merge" | "rebase" | "cherry-pick" | "revert" | "none" — mapped from
/// libgit2's `RepositoryState`, so a rebase/cherry-pick/revert started from a
/// terminal is detected too.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationStatus {
    pub kind: String,
    /// True when the operation supports `--skip` (rebase/cherry-pick/revert).
    pub can_skip: bool,
    /// Unmerged (conflicted) paths still needing resolution. Empty when the
    /// operation has no outstanding conflicts (e.g. all already staged).
    pub conflicts: Vec<ConflictFile>,
}

/// One conflicted (unmerged) path in the index.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    /// "text" (both sides changed, line-mergeable), "binary" (both sides
    /// changed, not line-mergeable), or "deleted" (one side removed the file).
    pub kind: String,
    /// For the "deleted" kind, which side removed it: "ours" | "theirs". Empty
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

// ---- GitHub (gh CLI) ----

/// Frontend-safe account identity used to pin GitHub operations without ever
/// moving token material across IPC.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccountRef {
    /// "gh" today; future native auth can add another provider without
    /// changing the PR feature surface.
    pub provider: String,
    /// GitHub host without scheme, e.g. "github.com" or a GHES hostname.
    pub host: String,
    /// Provider-owned stable account id. For `gh`, this is the GitHub numeric
    /// user id when it can be resolved, otherwise the login as a stable fallback.
    pub account_id: String,
    /// Display/login name. `gh auth token` still requires this alongside host.
    pub login: String,
}

/// A GitHub account `gh` is logged into. A repo is bound to one of these; its
/// `email`/`name` drive commit identity and its account ref drives PR/push auth.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccount {
    pub provider: String,
    pub host: String,
    pub account_id: String,
    pub login: String,
    /// Legacy display alias kept stable for existing frontend code.
    pub username: String,
    pub name: String,
    pub email: String,
    /// Numeric GitHub user id (0 when it could not be resolved).
    pub id: u64,
    /// True for the account `gh` currently treats as active.
    pub active: bool,
}

/// Authentication status for a non-GitHub forge. This is auth-only metadata for
/// Settings; it does not imply PR feature support.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeAuthStatus {
    /// Stable provider key, e.g. "gitlab" or "bitbucket".
    pub provider: String,
    pub forge: String,
    pub cli: Option<String>,
    pub auth_method: String,
    pub available: bool,
    /// None means GitLane cannot safely probe auth state for this provider.
    /// For tea-backed providers (Gitea/Forgejo) `Some(true)` means tea has *any*
    /// configured login, not necessarily one scoped to this repo's host.
    pub authenticated: Option<bool>,
    pub login_command: String,
    pub docs_url: String,
    pub notes: String,
}

/// PR author (GitHub login + display name).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrAuthor {
    pub login: String,
    pub name: String,
}

/// One discussion comment on a PR (issue-level, not a file review comment).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    pub author: PrAuthor,
    pub body: String,
    /// ISO-8601 timestamp; the frontend renders a relative age.
    pub created_at: String,
}

/// A label on a PR (`color` is a 6-hex RGB string without the leading `#`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrLabel {
    pub name: String,
    pub color: String,
}

/// A submitted review's verdict. `state` is the raw gh value
/// (`APPROVED` | `CHANGES_REQUESTED` | `COMMENTED` | `DISMISSED` | …).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReview {
    pub author: PrAuthor,
    pub state: String,
}

/// One inline review thread on a PR — a file/line-anchored discussion plus its
/// resolve state. Sourced from the GraphQL API (gh's `pr` verbs don't expose
/// threads); `id` is the GraphQL node id used to resolve/unresolve the thread.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub id: String,
    pub path: String,
    /// Line on the new side; None when the thread is outdated / unanchored.
    pub line: Option<u32>,
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub comments: Vec<PrComment>,
}

/// One status check on a PR (CI job or commit status), as a display result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    /// "pass" | "fail" | "pending" | "skipped". In-flight checks are reported
    /// as "pending" rather than collapsed into "fail"; skipped/neutral checks
    /// stay distinct so the frontend does not call them passed.
    pub state: String,
}

/// One commit included in a PR, sourced from GitHub (the authoritative PR commit
/// set) rather than local history. `oid` is the full SHA; the frontend slices a
/// short form for display and copies the full value. Author fields fall back to
/// empty strings when GitHub returns no author metadata.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommit {
    pub oid: String,
    /// First line of the commit message.
    pub headline: String,
    /// ISO-8601 authored timestamp; the frontend renders a relative age.
    pub authored_date: String,
    /// Author display name (falls back to the login, then empty when unknown).
    pub author_name: String,
    /// Author GitHub login; empty when GitHub returns no author.
    pub author_login: String,
}

/// Per-commit signature verification for a PR, fetched lazily via GraphQL (the
/// `gh pr view` projection carries no signature data). `verified` is GitHub's
/// own `signature.isValid` — reliable structured data, never inferred locally.
/// Commits without a signature are simply absent / `verified: false`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommitSignature {
    pub oid: String,
    pub verified: bool,
}

/// A pull request as shown in the PRs list. `state` is the raw gh value
/// (`OPEN` | `MERGED` | `CLOSED`); the frontend lowercases it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub head_ref: String,
    pub base_ref: String,
    pub author: PrAuthor,
    /// ISO-8601 creation timestamp; the frontend renders a relative age.
    pub created_at: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub is_draft: bool,
    pub url: String,
    /// gh mergeability verdict ("UNKNOWN" until GitHub computes it); lets the
    /// frontend invalidate a cached detail when it flips to a definitive value.
    pub mergeable: String,
}

/// Full pull-request detail for the center pane (body, files, checks).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub head_ref: String,
    pub base_ref: String,
    pub author: PrAuthor,
    pub created_at: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub is_draft: bool,
    pub url: String,
    /// Markdown body of the PR.
    pub body: String,
    pub comments: u64,
    pub files: Vec<String>,
    /// Discussion comments in order (the `comments` field above is just the count).
    pub comment_list: Vec<PrComment>,
    /// Mergeability as gh reports it: "MERGEABLE" | "CONFLICTING" | "UNKNOWN".
    /// Drives whether the merge button is offered; empty when not resolved.
    pub mergeable: String,
    /// Requested reviewers still pending (users + teams, by login/slug).
    pub reviewers: Vec<PrAuthor>,
    /// Submitted reviews (one per submission; the frontend dedupes to latest).
    pub reviews: Vec<PrReview>,
    pub assignees: Vec<PrAuthor>,
    pub labels: Vec<PrLabel>,
    /// Milestone title, when one is set.
    pub milestone: Option<String>,
    /// Commits included in the PR, in GitHub's order (oldest → newest).
    pub commits: Vec<PrCommit>,
}
