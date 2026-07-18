//! Commit file-list and per-file commit diff reads.

use git2::{DiffOptions, Oid, Repository};

use crate::git::read::open;
use crate::git::types::{FileChange, FileDiff};

use super::diff::{diffs_to_changes, diffs_to_files, literal_file_options, DIFF_LINE_LIMIT};

/// Resolve a commit's tree and its first parent's tree (or `None` for a root
/// commit) so a diff can be computed.
fn commit_trees<'repo>(
    repo: &'repo Repository,
    oid: &str,
) -> Result<(git2::Tree<'repo>, Option<git2::Tree<'repo>>), git2::Error> {
    let oid = Oid::from_str(oid)?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let parent = commit.parent(0).ok().and_then(|p| p.tree().ok());
    Ok((tree, parent))
}

/// Changed files in a commit (diff vs its first parent, or the empty tree for a
/// root commit).
pub fn commit_files(path: &str, oid: &str) -> Result<Vec<FileChange>, git2::Error> {
    let repo = open(path)?;
    let (tree, parent) = commit_trees(&repo, oid)?;

    let mut opts = DiffOptions::new();
    let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut opts))?;
    diffs_to_changes(&diff)
}

/// Full diff for one file within a commit (vs its first parent).
pub fn commit_file_diff(
    path: &str,
    oid: &str,
    file: &str,
    full: bool,
) -> Result<FileDiff, git2::Error> {
    let repo = open(path)?;
    let (tree, parent) = commit_trees(&repo, oid)?;
    let limit = if full { usize::MAX } else { DIFF_LINE_LIMIT };

    let mut opts = literal_file_options(file);
    let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut opts))?;

    let mut files = diffs_to_files(&diff, limit)?;
    Ok(files.pop().unwrap_or_else(|| FileDiff {
        path: file.to_string(),
        status: "M".to_string(),
        ..Default::default()
    }))
}
