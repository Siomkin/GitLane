//! Two-endpoint comparison reads: branch/commit ranges and working-tree diffs.
//!
//! `head = Some(spec)` compares two commit-ishes (`base..head`); `head = None`
//! compares `base` against the current working tree (index + worktree). Both
//! reuse the shared diff helpers so the file list and per-file diffs match the
//! rest of the review surfaces.

use git2::{DiffOptions, Oid, Repository};

use crate::git::read::open;
use crate::git::types::{CompareResult, FileChange, FileDiff};

use super::diff::{diffs_to_changes, diffs_to_files, DIFF_LINE_LIMIT};

fn tree_for<'a>(repo: &'a Repository, spec: &str) -> Result<git2::Tree<'a>, git2::Error> {
    repo.revparse_single(spec)?.peel_to_tree()
}

fn commit_oid(repo: &Repository, spec: &str) -> Result<Oid, git2::Error> {
    Ok(repo.revparse_single(spec)?.peel_to_commit()?.id())
}

/// Build the diff for `base..head`, where `head = None` means the working tree.
fn build_diff<'a>(
    repo: &'a Repository,
    base: &str,
    head: Option<&str>,
    opts: &mut DiffOptions,
) -> Result<git2::Diff<'a>, git2::Error> {
    let base_tree = tree_for(repo, base)?;
    match head {
        Some(head) => {
            let head_tree = tree_for(repo, head)?;
            repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(opts))
        }
        None => repo.diff_tree_to_workdir_with_index(Some(&base_tree), Some(opts)),
    }
}

/// Changed files plus aggregate add/del and ahead/behind for a comparison.
pub fn compare_refs(
    path: &str,
    base: &str,
    head: Option<&str>,
) -> Result<CompareResult, git2::Error> {
    let repo = open(path)?;
    let mut opts = DiffOptions::new();
    let mut diff = build_diff(&repo, base, head, &mut opts)?;
    diff.find_similar(None)?;
    let files: Vec<FileChange> = diffs_to_changes(&diff)?;

    let add = files.iter().map(|f| f.add).sum();
    let del = files.iter().map(|f| f.del).sum();

    // Commit distance is only meaningful between two commits; a working-tree
    // comparison has no second commit to count against.
    let (ahead, behind) = match head {
        Some(head) => {
            let base_oid = commit_oid(&repo, base)?;
            let head_oid = commit_oid(&repo, head)?;
            repo.graph_ahead_behind(head_oid, base_oid)?
        }
        None => (0, 0),
    };

    Ok(CompareResult { files, add, del, ahead, behind })
}

/// Full diff for one file within a comparison (see [`compare_refs`]).
pub fn compare_file_diff(
    path: &str,
    base: &str,
    head: Option<&str>,
    file: &str,
    full: bool,
) -> Result<FileDiff, git2::Error> {
    let repo = open(path)?;
    let limit = if full { usize::MAX } else { DIFF_LINE_LIMIT };
    let mut opts = DiffOptions::new();
    opts.pathspec(file).context_lines(3);
    let mut diff = build_diff(&repo, base, head, &mut opts)?;
    diff.find_similar(None)?;

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
