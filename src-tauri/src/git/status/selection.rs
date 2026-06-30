//! Merged ("union") diff across an arbitrary multi-commit selection (GL-69).
//!
//! GL-68 covers a contiguous first-parent run with a single `base..head` range.
//! This generalises to a gapped / cross-lane selection: for each file the net
//! change is the diff from the file's state *just before the earliest selected
//! commit that touches it* (that commit's first-parent blob) to its state
//! *after the latest selected commit that touches it* (that commit's blob). So a
//! file added then deleted within the selection nets to nothing, add+modify nets
//! to add, modify+delete to delete — the cumulative effect of exactly the picked
//! commits. Renames aren't tracked across the union (they surface as add+delete).
//!
//! Caveats:
//! - **First parent only.** A merge commit's contribution is its diff vs its
//!   first parent (like `commit_files`), so changes visible only through a merge's
//!   other parents aren't part of the union.
//! - **Cost is linear in the selection.** One `diff_tree_to_tree` per selected
//!   commit; this runs on the blocking pool, but a very large pick (dozens of
//!   commits) is correspondingly slower.

use std::collections::HashMap;
use std::path::Path;

use git2::{Commit, DiffOptions, Oid, Patch, Repository};

use crate::git::read::open;
use crate::git::types::{FileChange, FileDiff};

use super::diff::{render_patch, DIFF_LINE_LIMIT};

/// Net `(old, new)` blob oids for one file across the selection — `None` on a
/// side means the file is absent there (added / deleted).
type BlobPair = (Option<Oid>, Option<Oid>);

/// Resolve the selected oids to commits ordered **oldest first**. Committer time
/// defines "earliest/latest touch"; ties keep the caller's order so the result
/// is deterministic.
fn ordered_commits<'r>(repo: &'r Repository, oids: &[String]) -> Result<Vec<Commit<'r>>, git2::Error> {
    let mut commits: Vec<(usize, Commit<'r>)> = Vec::with_capacity(oids.len());
    for (i, oid) in oids.iter().enumerate() {
        commits.push((i, repo.find_commit(Oid::from_str(oid)?)?));
    }
    commits.sort_by(|a, b| a.1.time().seconds().cmp(&b.1.time().seconds()).then(a.0.cmp(&b.0)));
    Ok(commits.into_iter().map(|(_, c)| c).collect())
}

/// Blob oid of `path` in `tree`, or `None` when the file isn't present there.
fn blob_in(tree: Option<&git2::Tree>, path: &str) -> Option<Oid> {
    tree.and_then(|t| t.get_path(Path::new(path)).ok()).map(|e| e.id())
}

/// One-letter status from the file's presence on each side of the net diff.
fn status_for(old: bool, new: bool) -> &'static str {
    match (old, new) {
        (false, true) => "A",
        (true, false) => "D",
        _ => "M",
    }
}

/// Walk the ordered selection and record, per touched file, the parent blob of
/// the earliest touch (`old`) and the blob of the latest touch (`new`).
fn collect_touches(
    repo: &Repository,
    ordered: &[Commit],
) -> Result<HashMap<String, BlobPair>, git2::Error> {
    let mut touched: HashMap<String, BlobPair> = HashMap::new();
    for commit in ordered {
        let tree = commit.tree()?;
        let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let mut opts = DiffOptions::new();
        let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
        for delta in diff.deltas() {
            let path = match delta.new_file().path().or_else(|| delta.old_file().path()) {
                Some(p) => p.to_string_lossy().to_string(),
                None => continue,
            };
            let new_blob = blob_in(Some(&tree), &path);
            // First touch pins `old` to that commit's first-parent blob; every
            // touch overwrites `new`, so it ends at the latest commit's blob.
            touched
                .entry(path.clone())
                .or_insert_with(|| (blob_in(parent_tree.as_ref(), &path), None))
                .1 = new_blob;
        }
    }
    Ok(touched)
}

/// Net `(old, new)` blob pair for a single file (used by the per-file diff so it
/// doesn't materialise every touched path).
fn touch_for_file(ordered: &[Commit], file: &str) -> Result<BlobPair, git2::Error> {
    let mut pair: BlobPair = (None, None);
    let mut seen = false;
    for commit in ordered {
        let tree = commit.tree()?;
        let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let cur = blob_in(Some(&tree), file);
        let par = blob_in(parent_tree.as_ref(), file);
        if cur != par {
            if !seen {
                pair.0 = par;
                seen = true;
            }
            pair.1 = cur;
        }
    }
    Ok(pair)
}

/// libgit2's `git2::Patch::from_blobs` wrapper takes non-optional `&Blob`, so it
/// can't express an added/deleted side. Diffing the blobs' bytes — an absent side
/// is just `&[]` — keeps the same hunk/stat machinery without writing an empty
/// blob to the object DB.
fn diff_bytes<'a>(old: Option<&'a [u8]>, new: Option<&'a [u8]>, path: &str, opts: &mut DiffOptions) -> Result<Patch<'a>, git2::Error> {
    Patch::from_buffers(
        old.unwrap_or(&[]),
        Some(Path::new(path)),
        new.unwrap_or(&[]),
        Some(Path::new(path)),
        Some(opts),
    )
}

fn file_change(repo: &Repository, path: &str, (old, new): BlobPair) -> Result<FileChange, git2::Error> {
    let old_blob = old.map(|o| repo.find_blob(o)).transpose()?;
    let new_blob = new.map(|o| repo.find_blob(o)).transpose()?;
    let binary = old_blob.as_ref().is_some_and(|b| b.is_binary())
        || new_blob.as_ref().is_some_and(|b| b.is_binary());

    let (add, del) = if binary {
        (0, 0)
    } else {
        let mut opts = DiffOptions::new();
        let patch = diff_bytes(
            old_blob.as_ref().map(|b| b.content()),
            new_blob.as_ref().map(|b| b.content()),
            path,
            &mut opts,
        )?;
        let (_ctx, add, del) = patch.line_stats()?;
        (add, del)
    };

    Ok(FileChange {
        path: path.to_string(),
        status: status_for(old.is_some(), new.is_some()).to_string(),
        add,
        del,
        binary,
        advanced: None,
    })
}

fn file_diff(repo: &Repository, path: &str, (old, new): BlobPair, limit: usize) -> Result<FileDiff, git2::Error> {
    let old_blob = old.map(|o| repo.find_blob(o)).transpose()?;
    let new_blob = new.map(|o| repo.find_blob(o)).transpose()?;
    let status = status_for(old.is_some(), new.is_some()).to_string();
    let binary = old_blob.as_ref().is_some_and(|b| b.is_binary())
        || new_blob.as_ref().is_some_and(|b| b.is_binary());

    if binary {
        return Ok(FileDiff {
            path: path.to_string(),
            status,
            binary: true,
            old_size: old_blob.as_ref().map(|b| b.size() as u64),
            new_size: new_blob.as_ref().map(|b| b.size() as u64),
            old_oid: old.map(|o| o.to_string()),
            new_oid: new.map(|o| o.to_string()),
            ..Default::default()
        });
    }

    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    let patch = diff_bytes(
        old_blob.as_ref().map(|b| b.content()),
        new_blob.as_ref().map(|b| b.content()),
        path,
        &mut opts,
    )?;
    let (add, del, hunks, truncated) = render_patch(&patch, limit)?;
    Ok(FileDiff { path: path.to_string(), status, add, del, hunks, truncated, ..Default::default() })
}

/// Net changed files across the merged selection (`oids` in any order). Files
/// with no net change (added then deleted, or reverted) are dropped.
pub fn selection_diff(path: &str, oids: &[String]) -> Result<Vec<FileChange>, git2::Error> {
    let repo = open(path)?;
    let ordered = ordered_commits(&repo, oids)?;
    let touched = collect_touches(&repo, &ordered)?;

    let mut out = Vec::new();
    for (file, pair) in touched {
        if pair.0 == pair.1 {
            continue; // no net change (incl. add+delete within the selection)
        }
        out.push(file_change(&repo, &file, pair)?);
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Net diff for one file across the merged selection. `full` bypasses the line cap.
pub fn selection_diff_file(
    path: &str,
    oids: &[String],
    file: &str,
    full: bool,
) -> Result<FileDiff, git2::Error> {
    let repo = open(path)?;
    let ordered = ordered_commits(&repo, oids)?;
    let pair = touch_for_file(&ordered, file)?;
    let limit = if full { usize::MAX } else { DIFF_LINE_LIMIT };
    file_diff(&repo, file, pair, limit)
}
