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
    /// True when HEAD is unborn (fresh `git init`, no commits yet) — a real
    /// state, distinct from a read failure, so the UI can say "No commits yet"
    /// (GL-115).
    pub unborn: bool,
    /// True when this checkout is a *linked* worktree (not the main one).
    pub is_worktree: bool,
    /// The main checkout's path for a linked worktree — the stable repository
    /// identity that tab grouping and per-repo state key on (GL-109/GL-110).
    /// None for the main worktree itself (its own `path` is the identity).
    pub main_path: Option<String>,
}

/// Why `open_repo` failed, classified so the frontend can give a moved/deleted
/// repository its dedicated missing-repo state instead of the raw libgit2
/// message (GL-108). This is the one command with a structured IPC error —
/// everything else stays `Result<T, String>` (architecture-rules-rust §4); the
/// classification has to happen in Rust because only this side can distinguish
/// "path gone" from "not a repo" without matching on libgit2 message strings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoOpenError {
    pub kind: RepoOpenErrorKind,
    /// Human-readable message (no libgit2 class/code jargon) for the error bar
    /// fallback when the failure isn't the missing-repo kind.
    pub message: String,
    /// The path the open was attempted with, echoed back for the missing state.
    pub path: String,
}

/// Classification of an [`RepoOpenError`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepoOpenErrorKind {
    /// The path no longer exists on disk — moved, deleted, or on an unmounted
    /// volume (so a retry after re-mounting is a real recovery path).
    Missing,
    /// The path exists but no longer resolves to a git repository.
    NotARepository,
    /// Any other open failure (permissions, corruption, …) — error-bar material.
    Other,
}

/// Presence + current branch of a previously-opened repository path, for the
/// onboarding "Recent" list and the tab strip's session-restore probe
/// (GL-109/GL-110 share this shape). `exists: false` flags a path that no
/// longer resolves on disk so the UI can mark it "Missing" / drop the tab.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentStatus {
    pub path: String,
    pub exists: bool,
    /// Currently checked-out branch (short name), or None when detached / gone.
    pub branch: Option<String>,
    /// True when the path is a *linked* worktree of some repository.
    pub is_worktree: bool,
    /// The main checkout's path when `is_worktree` (see [`RepoSummary`]).
    pub main_path: Option<String>,
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

/// A single configured git remote, for the Repository settings → Remotes panel.
/// Pure libgit2 read of `.git/config`; provider classification of the URL is
/// done on the frontend (shared with the add/edit validation).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    /// Remote name (e.g. "origin").
    pub name: String,
    /// Fetch URL.
    pub fetch_url: String,
    /// Push URL — equals the fetch URL unless a separate `pushurl` is set.
    pub push_url: String,
    /// True for the repo's default push remote (the current branch's upstream
    /// remote, else "origin", else the first remote).
    pub is_default: bool,
}

/// The commit identity pinned in a repo's *local* git config (`user.name` /
/// `user.email`). `None` from the read side means nothing is pinned locally and
/// the repo defers to global git config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoIdentity {
    pub name: String,
    pub email: String,
    /// `user.signingkey` pinned locally — a GPG key id or an SSH key path /
    /// literal. The passphrase / private key never lives here: only the
    /// reference, unlocked at use time by ssh-agent / gpg-agent / the OS
    /// keychain. Omitted from JSON when unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signing_key: Option<String>,
    /// `gpg.format` — "openpgp" or "ssh" — pinned locally, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpg_format: Option<String>,
    /// `commit.gpgsign` pinned locally, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpg_sign: Option<bool>,
    /// `tag.gpgsign` pinned locally, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_gpg_sign: Option<bool>,
}

/// A signing key the user already has, offered by the profile editor's key
/// picker. References only — a full GPG fingerprint or an SSH public-key path —
/// never private key material or a passphrase.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningKey {
    /// The value written to `user.signingkey`: a full GPG fingerprint, or an SSH
    /// public-key path.
    pub value: String,
    /// Human-readable label — the GPG uid, or the SSH key type + comment.
    pub label: String,
    /// `gpg.format` for this key: "openpgp" or "ssh".
    pub format: String,
}

/// Payload of the `handoff-progress` Tauri event emitted while
/// `move_branch_to_worktree` runs — one per phase as it begins, so the hand-off
/// dialog can tick its step checklist live. `step` is one of the ids documented
/// on [`crate::git::write::move_branch_to_worktree`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffProgressEvent {
    pub step: String,
}

/// Payload of the `delete-worktree-progress` Tauri event emitted while
/// `delete_branch_with_worktree` runs — one per phase as it begins, so the
/// delete-branch-and-worktree dialog can tick its step checklist live. `step` is
/// one of the ids documented on
/// [`crate::git::write::delete_branch_with_worktree`].
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

/// Read-only impact summary shown before a destructive operation runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestructivePreview {
    pub summary: String,
    pub details: Vec<String>,
    pub warnings: Vec<String>,
}

/// Reset impact plus the exact target/source tips the write must still observe.
/// Hard mode also carries an opaque worktree/index lease so confirm→execute
/// cannot discard a different repository state than the dialog previewed (GL-302).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetPreview {
    pub summary: String,
    pub details: Vec<String>,
    pub warnings: Vec<String>,
    /// Exact commit the reset will move to — never a symbolic name that can move.
    pub target_oid: String,
    /// Tip of the source branch/HEAD observed by the preview.
    pub expected_source_oid: Option<String>,
    /// Opaque repository/HEAD/index/worktree fingerprint. Present only for hard.
    pub expected_state: Option<String>,
    /// Symbolic branch observed with the hard-reset lease, or null when detached.
    pub expected_head_branch: Option<String>,
    /// HEAD commit observed with the hard-reset lease, or null when unborn.
    pub expected_head_oid: Option<String>,
}

/// Force-push impact plus the complete compare-and-swap contract shown by the
/// confirmation. The local source object, resolved push route, and destination
/// expectation all cross IPC again so the write cannot widen or silently adopt
/// newer tracking state after the dialog opened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForcePushPreview {
    pub summary: String,
    pub details: Vec<String>,
    pub warnings: Vec<String>,
    pub expected_oid: String,
    pub remote: String,
    pub destination_ref: String,
    pub destination_oid: Option<String>,
    /// SHA-256 fingerprint of the single effective push endpoint. The endpoint
    /// itself stays backend-only because a user-managed URL may be sensitive.
    pub push_endpoint_token: String,
}

/// The previewed push route that must remain exact through force-push. Grouping
/// these fields keeps the route one IPC value instead of a set of independent
/// arguments that callers could accidentally mix between previews.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForcePushRouteLease {
    pub remote: String,
    pub destination_ref: String,
    pub destination_oid: Option<String>,
    pub push_endpoint_token: String,
}

impl From<&ForcePushPreview> for ForcePushRouteLease {
    fn from(preview: &ForcePushPreview) -> Self {
        Self {
            remote: preview.remote.clone(),
            destination_ref: preview.destination_ref.clone(),
            destination_oid: preview.destination_oid.clone(),
            push_endpoint_token: preview.push_endpoint_token.clone(),
        }
    }
}

/// Branch-deletion impact plus the exact local-ref object the confirmation
/// described. The write accepts this oid again as a compare-and-swap lease, so
/// a branch advanced or rewritten after the dialog opened is never deleted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchPreview {
    pub summary: String,
    pub details: Vec<String>,
    pub warnings: Vec<String>,
    pub expected_oid: String,
}

/// Read-only impact plus the exact per-path state a later file-discard command
/// must still observe. The token is opaque to the frontend and contains no file
/// contents; Rust recomputes it immediately before the destructive write.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardFilePreview {
    pub summary: String,
    pub details: Vec<String>,
    pub warnings: Vec<String>,
    pub expected_state: String,
}

/// Whole-worktree discard impact plus the exact repository, HEAD, index, and
/// affected-leaf snapshot the later write must still observe. The opaque state
/// commits to raw path bytes and file fingerprints; the explicit HEAD fields
/// make the user-visible subject inspectable across IPC as well.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardAllPreview {
    pub summary: String,
    pub details: Vec<String>,
    pub warnings: Vec<String>,
    pub expected_state: String,
    pub expected_head_branch: Option<String>,
    pub expected_head_oid: Option<String>,
}

/// Per-path advanced repository state that would be misleading as a plain file
/// change. `kind` is one of the discriminants below, matched by the frontend to
/// suppress write verbs (e.g. Restore) that don't apply to the path.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAdvancedState {
    pub kind: String,
    pub message: String,
}

/// `FileAdvancedState::kind` for a submodule gitlink.
pub const ADVANCED_KIND_SUBMODULE: &str = "submodule";
/// `FileAdvancedState::kind` for a path outside the sparse checkout.
pub const ADVANCED_KIND_SPARSE: &str = "sparse";

/// A single changed file in a diff (working tree, index, or a commit).
/// `status` is a one-letter git code: M(odified) A(dded) D(eleted) R(enamed)
/// C(opied) T(ypechange) U(ntracked) or `?` when unknown.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub add: usize,
    pub del: usize,
    /// True when git treats this delta as binary (no line stats / text hunks).
    /// Lets file lists mark it as binary instead of showing a misleading "+0 −0".
    pub binary: bool,
    /// True when `add` is only a lower bound because the backend deliberately
    /// capped a large worktree-file probe. Omitted when false so ordinary diff
    /// payloads stay compact.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub line_count_truncated: bool,
    /// For a rename ("R") — or copy ("C") — the delta's old-side path (the
    /// rename/copy source). For a rename it is carried so staging/unstaging can
    /// act on both the old and new path atomically: a bare `git add <new>` stages
    /// only the addition and leaves the old path's deletion behind as a separate
    /// unstaged "D" (GL-127). For a copy the source path is unchanged, so this is
    /// informational only (a copy must not stage/restore its source). `None` for
    /// every other change, where `path` already names the only affected file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced: Option<FileAdvancedState>,
}

/// Status of one configured submodule in the superproject.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleState {
    pub path: String,
    pub name: String,
    pub url: Option<String>,
    pub status: String,
    pub details: Vec<String>,
    pub dirty: bool,
    pub initialized: bool,
}

/// Git LFS presence and local-tooling state. GitLane does not manage LFS yet;
/// this tells the UI when plain file operations need caution.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsState {
    pub detected: bool,
    pub installed: Option<bool>,
    pub issues: Vec<String>,
    pub patterns: Vec<String>,
}

/// Sparse checkout visibility state for status/diff/history surfaces.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SparseCheckoutState {
    pub enabled: bool,
    pub mode: Option<String>,
    pub patterns: Vec<String>,
    /// True when `patterns` is a prefix of a longer sparse-checkout file (capped
    /// for payload size). The frontend must not treat a non-match against a
    /// truncated list as "outside sparse checkout" — a later, unsent pattern may
    /// include the path — so it falls back to the authoritative per-file
    /// skip-worktree annotation instead of pattern matching.
    pub truncated: bool,
}

/// Advanced repository features that are read-only indicators for now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedRepoState {
    pub submodules: Vec<SubmoduleState>,
    pub lfs: LfsState,
    pub sparse_checkout: SparseCheckoutState,
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
    pub advanced: AdvancedRepoState,
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
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub status: String,
    pub add: usize,
    pub del: usize,
    pub binary: bool,
    pub hunks: Vec<DiffHunk>,
    /// True when the diff was capped at a line limit and `hunks` holds only the
    /// first portion of the change. Callers may offer an uncapped reload when
    /// their endpoint supports one.
    pub truncated: bool,
    /// Byte size of the file on the old / new side of a **binary** change, so the
    /// UI can show "old → new (±delta)" in place of a meaningless "+0 −0". `None`
    /// when that side is absent (added has no old, deleted has no new) or for text
    /// diffs (whose change is already expressed as line hunks).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_size: Option<u64>,
    /// Blob oids for each side of the change, used to fetch content for a
    /// preview ([`super::status::read_binary_blob`]) — image bytes for a binary
    /// delta, markdown source for a text one. `None` when the side is absent or
    /// libgit2 left no blob oid. The working-tree side of an unstaged diff is
    /// unreliable by oid (zero for binary; a computed hash that need not exist
    /// in the ODB for text) — the frontend reads that side from disk by `path`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_oid: Option<String>,
    /// Attribution when the diff came from a per-commit patch (`gh pr diff
    /// --patch` emits one message per commit): the owning commit's full oid and
    /// its subject line (folded continuations joined, `[PATCH n/m]` prefix
    /// stripped). The Diff tab groups same-commit files under one header.
    /// `None` for libgit2/status diffs and bare unified patches.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_subject: Option<String>,
}

/// Raw bytes of one blob / working-tree file, base64-encoded for an inline
/// preview (images today). Returned by `read_binary_blob`; large blobs come back
/// with `base64: None` + `truncated: true` so the UI shows size only.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryBlob {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    pub size: u64,
    pub truncated: bool,
}

/// One worktree file's text for the read-only file viewer. Binary and
/// oversized files come back as flags (`text: None` / `truncated`), never as
/// raw bytes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFileContent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
    /// Opaque compare-and-swap lease for the exact repository/worktree/path,
    /// leaf identity, and bytes represented by `text`. Present only when the
    /// read is complete, non-binary, and valid UTF-8, so its absence is also the
    /// backend-owned signal that editing is unsafe.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_state: Option<String>,
}

/// Result of one guarded in-app editor save. The returned state is the lease
/// for the bytes just written, allowing another save without a redundant read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFileWriteResult {
    pub size: u64,
    pub expected_state: String,
}

/// One commit in a repository-relative file's history.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub oid: String,
    pub short_oid: String,
    pub subject: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub status: String,
    pub path: String,
    /// Lines added to this file in the commit.
    pub add: usize,
    /// Lines removed from this file in the commit.
    pub del: usize,
    /// Previous repository-relative path when the commit renamed this file.
    pub previous_path: Option<String>,
}

/// Bounded file-history result. `has_more` means another request can continue
/// from `next_offset`; `truncated` means the backend stopped at its scan cap.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryPage {
    pub entries: Vec<FileHistoryEntry>,
    pub next_offset: usize,
    pub has_more: bool,
    pub truncated: bool,
}

/// One text line annotated by git blame.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line_no: usize,
    pub content: String,
    pub oid: String,
    pub short_oid: String,
    /// Summary line of the commit that last touched this line ("" if unknown /
    /// uncommitted).
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub original_path: String,
    pub original_line: usize,
}

/// Blame result for a repository-relative text file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBlame {
    pub path: String,
    pub revision: Option<String>,
    pub binary: bool,
    pub truncated: bool,
    pub lines: Vec<BlameLine>,
}

/// Changed-file list plus aggregate stats for a `base..head` comparison, where
/// `head` is either another commit-ish or — when the request omits it — the
/// working tree. `ahead`/`behind` are commit-distance counts between the two
/// endpoints (both zero for a working-tree comparison).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    pub files: Vec<FileChange>,
    pub add: usize,
    pub del: usize,
    pub ahead: usize,
    pub behind: usize,
}

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

/// Provider-neutral git transport auth for clone/fetch/pull/push.
///
/// This is intentionally not a token carrier. For HTTPS remotes the account
/// selector is the URL username (`gitcredentials(7)`); GitHub can additionally
/// ask `gh auth git-credential` for that username's token per invocation. Other
/// providers use the user's configured credential helper / GCM. When GitLane
/// owns the secret for a provider account (`providerToken` mode, GL-132) the
/// token is fetched from the OS keychain by the backend credential bridge and
/// handed to git via `GIT_ASKPASS`; `providerAccountId` is the non-secret
/// keychain locator, never the token itself.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTransportAuthRef {
    /// "system" | "ssh" | "githubGh" | "gitlabGlab" | "credentialHelper" |
    /// "providerToken".
    pub mode: String,
    /// "github" | "gitlab" | "bitbucket" | "azure-devops" | "gitea" | "forgejo"
    /// | "other".
    #[serde(default)]
    pub provider: Option<String>,
    /// Normalized display host, without scheme or port.
    pub host: String,
    /// Exact credential authority (`host[:port]`) Git sees.
    pub credential_host: String,
    /// HTTPS URL username, when one is selected.
    #[serde(default)]
    pub username: Option<String>,
    /// GitHub account metadata for `githubGh`; never contains a token.
    #[serde(default)]
    pub account_ref: Option<GithubAccountRef>,
    /// Stable, non-secret keychain locator for `providerToken` mode — the
    /// provider account id whose token GitLane stored in the OS keychain. Absent
    /// for every other mode. Never a token.
    #[serde(default)]
    pub provider_account_id: Option<String>,
    /// Whether Git should include the URL path in credential-helper lookups.
    #[serde(default)]
    pub use_http_path: bool,
}

/// One `remote → auth` pair for the multi-remote fetch.
/// Input-only: remotes without an entry fetch through the system credential
/// helpers / SSH.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccountRef {
    pub remote: String,
    pub auth: GitTransportAuthRef,
}

pub use crate::git::credentials::{
    CredentialForgetResult, CredentialHelperStatus, CredentialSaveResult,
};
pub use crate::git::oauth::types::{OauthClientStatus, ProviderOauthResult};
pub use crate::git::provider_tokens::ProviderTokenStatus;

/// A GitHub account `gh` is logged into. Its account ref drives GitHub PR/API
/// auth and can be used for git transport auth; commit identity is configured
/// separately through repo-local git identity settings.
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
    /// False when `gh auth status` reported the account's credentials as
    /// broken (revoked/expired token, or the check timed out) — the UI shows
    /// a "needs re-auth" badge instead of treating the account as usable.
    pub healthy: bool,
    /// Human-readable failure detail when `healthy` is false; empty otherwise.
    pub health_error: String,
}

/// Result of an in-app `gh auth login --web` sign-in (GL-106): the host and the
/// login that was just added, so the UI can refresh the account list and offer to
/// bind the new account to the open repo. No token material.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubSignInResult {
    pub host: String,
    pub login: String,
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
    /// Real account identity, when the provider CLI is authenticated and GitLane
    /// can fetch it (provider whoami). Identity metadata only — never a token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<ForgeAccount>,
}

/// The signed-in account on a non-GitHub provider, from its CLI whoami.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeAccount {
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
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
    /// True when the thread holds more comments than the per-thread query cap
    /// fetched — the UI should say so instead of presenting the list as complete.
    pub comments_truncated: bool,
    pub comments: Vec<PrComment>,
}

/// Bounded review-thread pagination result. `truncated` distinguishes the
/// runaway safety cap from a complete thread list at the IPC boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThreadList {
    pub threads: Vec<ReviewThread>,
    pub truncated: bool,
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
    /// GitHub's own `signature.isValid` — reliable structured data, never
    /// inferred locally. `false` for unsigned commits, and for the fast-path
    /// commits from `gh pr view` (which carries no signature data) until the
    /// paginated GraphQL commit read replaces them.
    pub verified: bool,
}

/// Bounded PR-commit pagination result. `truncated` is true when the provider
/// reported another page after GitLane reached its safety cap.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommitList {
    pub commits: Vec<PrCommit>,
    pub truncated: bool,
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
    /// gh mergeability verdict: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
    /// ("UNKNOWN" until GitHub finishes computing it), or "" when gh reports no
    /// value. Lets the frontend invalidate a cached detail when it flips to a
    /// definitive value.
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
    /// gh mergeability verdict — same value set as [`PullRequestSummary`]'s:
    /// "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | "" (the last two while GitHub
    /// is still computing it or gh reports no value). Drives whether the merge
    /// button is offered.
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
