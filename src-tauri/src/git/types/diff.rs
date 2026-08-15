//! Unified-diff shapes: lines, hunks, whole-file diffs, and binary blobs.

use serde::Serialize;

use super::status::ChangeStatus;

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
    pub status: ChangeStatus,
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
    /// preview ([`crate::git::status::read_binary_blob`]) — image bytes for a binary
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
