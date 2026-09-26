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

/// One tree a stash stores changes in: the worktree (the stash commit itself),
/// the index (`^2`), or the untracked files (`^3`).
struct StashSource<'repo> {
    /// The commit carrying `tree`, for callers that restore from it.
    oid: Oid,
    tree: Tree<'repo>,
    /// Untracked files diff against nothing; the other two against the base.
    untracked: bool,
}

/// The stash's base tree (`^1`) and its change trees in file-list precedence:
/// worktree, then index, then untracked. Tracked and untracked paths are
/// disjoint in a stash, so one order serves every lookup below.
fn stash_sources<'repo>(
    commit: &Commit<'repo>,
) -> Result<(Option<Tree<'repo>>, Vec<StashSource<'repo>>), git2::Error> {
    let base = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
    let mut sources = vec![StashSource {
        oid: commit.id(),
        tree: commit.tree()?,
        untracked: false,
    }];
    for (index, untracked) in [(1, false), (2, true)] {
        if let Ok(parent) = commit.parent(index) {
            sources.push(StashSource {
                oid: parent.id(),
                tree: parent.tree()?,
                untracked,
            });
        }
    }
    Ok((base, sources))
}

impl<'repo> StashSource<'repo> {
    /// The tree this source's changes are measured against.
    fn old<'a>(&self, base: Option<&'a Tree<'repo>>) -> Option<&'a Tree<'repo>> {
        if self.untracked {
            None
        } else {
            base
        }
    }
}

/// The first source (in precedence order) that changes `file`.
fn source_for<'s, 'repo>(
    base: Option<&Tree<'repo>>,
    sources: &'s [StashSource<'repo>],
    file: &str,
) -> Option<&'s StashSource<'repo>> {
    sources
        .iter()
        .find(|source| blob_in(Some(&source.tree), file) != blob_in(source.old(base), file))
}

/// Commit whose tree holds the blob `file` should restore, for a stash or a
/// normal commit. For a stash this is the first source that changes the file
/// and still holds it; otherwise the stash commit. Non-stash oids return
/// `commit.id()`.
pub(crate) fn blob_carrier_oid(repo: &Repository, commit: &Commit<'_>, file: &str) -> Oid {
    if !is_stash_oid(repo, commit.id()) {
        return commit.id();
    }
    let Ok((base, sources)) = stash_sources(commit) else {
        return commit.id();
    };
    source_for(base.as_ref(), &sources, file)
        .filter(|source| blob_in(Some(&source.tree), file).is_some())
        .map_or(commit.id(), |source| source.oid)
}

/// Changed files in a stash: worktree vs base, then index-only, then untracked.
pub(super) fn stash_files(
    repo: &Repository,
    commit: &Commit<'_>,
) -> Result<Vec<FileChange>, git2::Error> {
    let (base, sources) = stash_sources(commit)?;
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    for source in &sources {
        for mut file in diff_changes(repo, source.old(base.as_ref()), Some(&source.tree))? {
            if seen.insert(file.path.clone()) {
                if source.untracked {
                    file.status = ChangeStatus::Untracked;
                }
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
    let (base, sources) = stash_sources(commit)?;
    // Nothing changes `file`: diff the worktree tree, which yields no hunks.
    let source = source_for(base.as_ref(), &sources, file).unwrap_or(&sources[0]);

    let mut opts = literal_file_options(file);
    let diff = repo.diff_tree_to_tree(
        source.old(base.as_ref()),
        Some(&source.tree),
        Some(&mut opts),
    )?;
    let mut files = diffs_to_files(&diff, limit)?;
    let mut out = files.pop().unwrap_or_else(|| FileDiff {
        path: file.to_string(),
        status: ChangeStatus::Modified,
        ..Default::default()
    });
    if source.untracked {
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
    let (base, sources) = stash_sources(commit)?;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for source in &sources {
        for delta in tree_diff_blobs(repo, source.old(base.as_ref()), Some(&source.tree))? {
            if seen.insert(delta.path.clone()) {
                out.push(FileBlobDelta {
                    path: delta.path,
                    old: delta.old,
                    new: delta.new,
                    untracked: source.untracked,
                });
            }
        }
    }
    Ok(out)
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

/// Blob oid of `path` in `tree`, or `None` when the file isn't present there.
pub(super) fn blob_in(tree: Option<&Tree<'_>>, path: &str) -> Option<Oid> {
    tree.and_then(|tree| tree.get_path(Path::new(path)).ok())
        .map(|entry| entry.id())
}
