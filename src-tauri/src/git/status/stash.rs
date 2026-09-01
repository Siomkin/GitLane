//! Stash snapshot reads: a stash commit stores the worktree in its own tree,
//! the index in `^2`, and untracked files in an optional `^3`. First-parent
//! diffs miss the latter two; these helpers union them for inspect/restore.

use std::collections::HashSet;
use std::path::Path;

use git2::{Commit, DiffOptions, Oid, Repository, Tree};

use crate::git::types::{ChangeStatus, FileChange, FileDiff};

use super::diff::{diffs_to_changes, diffs_to_files, literal_file_options};

/// One path's old/new blobs in a stash (or first-parent) snapshot.
pub(super) struct FileBlobDelta {
    pub path: String,
    pub old: Option<Oid>,
    pub new: Option<Oid>,
    pub untracked: bool,
}

struct PathBlobs {
    path: String,
    old: Option<Oid>,
    new: Option<Oid>,
}

/// True when `oid` is the current (new) oid of a `refs/stash` reflog entry.
pub(super) fn is_stash_oid(repo: &Repository, oid: Oid) -> bool {
    let Ok(reflog) = repo.reflog("refs/stash") else {
        return false;
    };
    (0..reflog.len()).any(|i| reflog.get(i).is_some_and(|entry| entry.id_new() == oid))
}

/// Commit whose tree holds the blob `file` should restore, for a stash or a
/// normal commit. For a stash this follows the file-list precedence: WIP when
/// that blob differs from the base, else the untracked parent, else the index
/// parent when it differs. Non-stash oids return `commit.id()`.
pub(crate) fn blob_carrier_oid(repo: &Repository, commit: &Commit<'_>, file: &str) -> Oid {
    if !is_stash_oid(repo, commit.id()) {
        return commit.id();
    }
    let wip = commit.tree().ok();
    let base = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
    let wip_blob = blob_in(wip.as_ref(), file);
    let base_blob = blob_in(base.as_ref(), file);
    if wip_blob != base_blob {
        return commit.id();
    }
    if let Ok(untracked) = commit.parent(2) {
        if blob_in(untracked.tree().ok().as_ref(), file).is_some() {
            return untracked.id();
        }
    }
    if let Ok(index) = commit.parent(1) {
        let index_blob = blob_in(index.tree().ok().as_ref(), file);
        if index_blob != base_blob && index_blob.is_some() {
            return index.id();
        }
    }
    commit.id()
}

/// Changed files in a stash: worktree vs base, then index-only, then untracked.
pub(super) fn stash_files(
    repo: &Repository,
    commit: &Commit<'_>,
) -> Result<Vec<FileChange>, git2::Error> {
    let wip = commit.tree()?;
    let base = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
    let mut files = diff_changes(repo, base.as_ref(), Some(&wip))?;
    let mut seen: HashSet<String> = files.iter().map(|file| file.path.clone()).collect();

    if let Ok(index) = commit.parent(1) {
        let index_tree = index.tree()?;
        for file in diff_changes(repo, base.as_ref(), Some(&index_tree))? {
            if seen.insert(file.path.clone()) {
                files.push(file);
            }
        }
    }

    if let Ok(untracked) = commit.parent(2) {
        let untracked_tree = untracked.tree()?;
        for mut file in diff_changes(repo, None, Some(&untracked_tree))? {
            if seen.insert(file.path.clone()) {
                file.status = ChangeStatus::Untracked;
                files.push(file);
            }
        }
    }

    Ok(files)
}

/// Per-file stash diff using the same tree as [`stash_files`] for `file`.
pub(super) fn stash_file_diff(
    repo: &Repository,
    commit: &Commit<'_>,
    file: &str,
    limit: usize,
) -> Result<FileDiff, git2::Error> {
    let wip = commit.tree()?;
    let base = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
    let index = index_tree(commit)?;
    let untracked = untracked_tree(commit)?;
    let wip_blob = blob_in(Some(&wip), file);
    let base_blob = blob_in(base.as_ref(), file);

    enum Source {
        Wip,
        Untracked,
        Index,
    }
    let source = if wip_blob != base_blob {
        Source::Wip
    } else if untracked
        .as_ref()
        .is_some_and(|tree| blob_in(Some(tree), file).is_some())
    {
        Source::Untracked
    } else if index
        .as_ref()
        .is_some_and(|tree| blob_in(Some(tree), file) != base_blob)
    {
        Source::Index
    } else {
        Source::Wip
    };

    let (old, new, is_untracked) = match source {
        Source::Wip => (base.as_ref(), Some(&wip), false),
        Source::Untracked => (None, untracked.as_ref(), true),
        Source::Index => (base.as_ref(), index.as_ref(), false),
    };

    let mut opts = literal_file_options(file);
    let diff = repo.diff_tree_to_tree(old, new, Some(&mut opts))?;
    let mut files = diffs_to_files(&diff, limit)?;
    let mut out = files.pop().unwrap_or_else(|| FileDiff {
        path: file.to_string(),
        status: ChangeStatus::Modified,
        ..Default::default()
    });
    if is_untracked {
        out.status = ChangeStatus::Untracked;
    }
    Ok(out)
}

/// Blob pairs a stash contributes to a multi-commit union. WIP rows win on
/// path overlap.
pub(super) fn stash_file_blobs(
    repo: &Repository,
    commit: &Commit<'_>,
) -> Result<Vec<FileBlobDelta>, git2::Error> {
    let wip = commit.tree()?;
    let base = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for delta in tree_diff_blobs(repo, base.as_ref(), Some(&wip))? {
        seen.insert(delta.path.clone());
        out.push(FileBlobDelta {
            path: delta.path,
            old: delta.old,
            new: delta.new,
            untracked: false,
        });
    }

    if let Ok(index) = commit.parent(1) {
        let index_tree = index.tree()?;
        for delta in tree_diff_blobs(repo, base.as_ref(), Some(&index_tree))? {
            if seen.insert(delta.path.clone()) {
                out.push(FileBlobDelta {
                    path: delta.path,
                    old: delta.old,
                    new: delta.new,
                    untracked: false,
                });
            }
        }
    }

    if let Ok(untracked) = commit.parent(2) {
        let untracked_tree = untracked.tree()?;
        for delta in tree_diff_blobs(repo, None, Some(&untracked_tree))? {
            if seen.insert(delta.path.clone()) {
                out.push(FileBlobDelta {
                    path: delta.path,
                    old: delta.old,
                    new: delta.new,
                    untracked: true,
                });
            }
        }
    }

    Ok(out)
}

fn untracked_tree<'repo>(commit: &Commit<'repo>) -> Result<Option<Tree<'repo>>, git2::Error> {
    match commit.parent(2) {
        Ok(parent) => Ok(Some(parent.tree()?)),
        Err(_) => Ok(None),
    }
}

fn index_tree<'repo>(commit: &Commit<'repo>) -> Result<Option<Tree<'repo>>, git2::Error> {
    match commit.parent(1) {
        Ok(parent) => Ok(Some(parent.tree()?)),
        Err(_) => Ok(None),
    }
}

fn diff_changes(
    repo: &Repository,
    old: Option<&Tree<'_>>,
    new: Option<&Tree<'_>>,
) -> Result<Vec<FileChange>, git2::Error> {
    let mut opts = DiffOptions::new();
    let diff = repo.diff_tree_to_tree(old, new, Some(&mut opts))?;
    diffs_to_changes(&diff)
}

fn tree_diff_blobs(
    repo: &Repository,
    old: Option<&Tree<'_>>,
    new: Option<&Tree<'_>>,
) -> Result<Vec<PathBlobs>, git2::Error> {
    let mut opts = DiffOptions::new();
    let diff = repo.diff_tree_to_tree(old, new, Some(&mut opts))?;
    let mut out = Vec::new();
    for delta in diff.deltas() {
        let path = match delta.new_file().path().or_else(|| delta.old_file().path()) {
            Some(path) => path.to_string_lossy().to_string(),
            None => continue,
        };
        let anc = blob_in(old, &path);
        let cur = blob_in(new, &path);
        if anc == cur {
            continue;
        }
        out.push(PathBlobs {
            path,
            old: anc,
            new: cur,
        });
    }
    Ok(out)
}

fn blob_in(tree: Option<&Tree<'_>>, path: &str) -> Option<Oid> {
    tree.and_then(|tree| tree.get_path(Path::new(path)).ok())
        .map(|entry| entry.id())
}
