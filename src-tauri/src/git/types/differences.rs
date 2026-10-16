//! Per-difference inclusion for the commit review workspace, and the line-range
//! requests that include, exclude, or revert one difference.

use serde::{Deserialize, Serialize};

use super::diff::{DiffLine, FileDiff};

/// A contiguous run of lines `line_start..line_start + expected.len()` inside one
/// hunk of the staged or unstaged diff, guarded by the lines the UI displayed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiffLineRange {
    pub hunk_index: usize,
    pub line_start: usize,
    pub expected: Vec<DiffLine>,
}

/// `apply_line_range` / `revert_line_range` — one atomic patch over several
/// ranges of the same file and side (`staged` picks the staged diff).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyLineRangeRequest {
    pub file: String,
    pub staged: bool,
    pub ranges: Vec<DiffLineRange>,
}

/// How much of one HEAD-to-working-tree difference the index already holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Inclusion {
    Included,
    Excluded,
    Partial,
}

/// One difference: a block of changed lines in [`FileDifferences::diff`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Difference {
    /// Where the block sits in the rendered diff (lines inclusive).
    pub hunk_index: usize,
    pub line_start: usize,
    pub line_end: usize,
    pub inclusion: Inclusion,
    /// Unstaged-diff ranges that stage this difference (`staged: false`); also
    /// the ranges a revert restores when the difference is excluded.
    pub stage: Vec<DiffLineRange>,
    /// Staged-diff ranges that unstage it (`staged: true`).
    pub unstage: Vec<DiffLineRange>,
}

/// `working_file_differences` — the HEAD-to-working-tree diff of one file split
/// into differences. `differences` is empty when the file can only be included
/// as a whole (untracked, added, renamed, binary, truncated, …).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDifferences {
    pub diff: FileDiff,
    pub differences: Vec<Difference>,
    /// True when `diff` shows the whole file (one hunk, every line); false for
    /// the 3-context hunks, including a whole-file request that was too large.
    pub whole_file: bool,
}
