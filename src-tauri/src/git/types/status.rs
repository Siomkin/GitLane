//! Working-tree status: per-file changes, the staged/unstaged/conflicted
//! buckets, and the advanced states (submodule, LFS, sparse) that guard writes.

use serde::Serialize;

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
