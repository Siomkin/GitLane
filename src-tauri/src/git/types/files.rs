//! Repository file reads that are not diffs: file content and writes, per-file
//! history, blame, and range comparison.

use serde::Serialize;

use super::status::{ChangeStatus, FileChange};

/// The bounded repository file listing behind the Files browser. `paths` is
/// repo-relative and sorted; `truncated` means the worktree holds more paths
/// than the listing cap, so the tree shown is a prefix of the real one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFiles {
    pub paths: Vec<String>,
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
    pub status: ChangeStatus,
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
