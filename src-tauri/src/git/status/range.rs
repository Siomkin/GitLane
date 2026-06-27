//! Commit-range file-list and per-file diff reads.

use git2::{DiffOptions, Repository};

use crate::git::read::open;
use crate::git::types::{FileChange, FileDiff};

use super::diff::{diffs_to_changes, diffs_to_files, DIFF_LINE_LIMIT};

/// Resolve any commit-ish (a SHA, "HEAD", a branch/tag name) to its tree.
/// Used by the range-diff helpers so they accept the same specifiers git does.
fn tree_for<'a>(repo: &'a Repository, spec: &str) -> Result<git2::Tree<'a>, git2::Error> {
    let obj = repo.revparse_single(spec)?;
    obj.peel_to_tree()
}

/// Changed files across a range `base..head`. Either side accepts any
/// commit-ish ("HEAD", a SHA, a branch), so this serves both "commit vs HEAD"
/// and "range between two commits". `base` is the older side (left tree).
pub fn diff_range(path: &str, base: &str, head: &str) -> Result<Vec<FileChange>, git2::Error> {
    let repo = open(path)?;
    let base_tree = tree_for(&repo, base)?;
    let head_tree = tree_for(&repo, head)?;

    let mut opts = DiffOptions::new();
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;
    diffs_to_changes(&diff)
}

/// Full diff for one file within a range `base..head` (see [`diff_range`]).
pub fn diff_range_file(
    path: &str,
    base: &str,
    head: &str,
    file: &str,
    full: bool,
) -> Result<FileDiff, git2::Error> {
    let repo = open(path)?;
    let base_tree = tree_for(&repo, base)?;
    let head_tree = tree_for(&repo, head)?;
    let limit = if full { usize::MAX } else { DIFF_LINE_LIMIT };

    let mut opts = DiffOptions::new();
    opts.pathspec(file).context_lines(3);
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;

    let mut files = diffs_to_files(&diff, limit)?;
    Ok(files.pop().unwrap_or_else(|| FileDiff {
        path: file.to_string(),
        status: "M".to_string(),
        add: 0,
        del: 0,
        binary: false,
        hunks: Vec::new(),
        truncated: false,
    }))
}
