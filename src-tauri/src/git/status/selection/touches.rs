//! Walking the ordered selection to record, per file, the net blob pair and
//! whether an unselected commit edited it between two selected touches.

use std::collections::HashMap;
use std::path::Path;

use git2::{Commit, DiffOptions, Oid, Repository};

/// Net `(old, new)` blob oids for one file across the selection — `None` on a
/// side means the file is absent there (added / deleted).
pub(super) type BlobPair = (Option<Oid>, Option<Oid>);

/// Per-file accumulation over the selection. `gapped` marks a file an unselected
/// commit edited between two selected touches, so its net needs composing rather
/// than a plain `base..head` blob diff.
pub(super) struct Touch {
    pub(super) base: Option<Oid>,
    pub(super) head: Option<Oid>,
    pub(super) gapped: bool,
}

/// Blob oid of `path` in `tree`, or `None` when the file isn't present there.
pub(super) fn blob_in(tree: Option<&git2::Tree>, path: &str) -> Option<Oid> {
    tree.and_then(|t| t.get_path(Path::new(path)).ok())
        .map(|e| e.id())
}

/// Walk the ordered selection and record, per touched file, the parent blob of
/// the earliest touch (`base`), the blob of the latest touch (`head`), and
/// whether an unselected commit edited it in between (`gapped`).
pub(super) fn collect_touches(
    repo: &Repository,
    ordered: &[Commit],
) -> Result<HashMap<String, Touch>, git2::Error> {
    let mut touched: HashMap<String, Touch> = HashMap::new();
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
            let anc = blob_in(parent_tree.as_ref(), &path);
            let new = blob_in(Some(&tree), &path);
            // A mode-only delta (e.g. chmod) leaves the blob unchanged; skip it so
            // the list agrees with `touch_for_file` (which also skips it) and a
            // content-less change isn't reported.
            if anc == new {
                continue;
            }
            match touched.get_mut(&path) {
                None => {
                    touched.insert(
                        path,
                        Touch {
                            base: anc,
                            head: new,
                            gapped: false,
                        },
                    );
                }
                Some(t) => {
                    // This commit's parent blob differs from the running result →
                    // an unselected commit changed the file since the last touch.
                    if t.head != anc {
                        t.gapped = true;
                    }
                    t.head = new;
                }
            }
        }
    }
    Ok(touched)
}

/// Net `(base, head)` blob pair for a single file plus whether it's gapped (used
/// by the per-file diff so it doesn't materialise every touched path).
pub(super) fn touch_for_file(
    ordered: &[Commit],
    file: &str,
) -> Result<(BlobPair, bool), git2::Error> {
    let mut base: Option<Oid> = None;
    let mut head: Option<Oid> = None;
    let mut started = false;
    let mut gapped = false;
    for commit in ordered {
        let tree = commit.tree()?;
        let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let anc = blob_in(parent_tree.as_ref(), file);
        let cur = blob_in(Some(&tree), file);
        if anc == cur {
            continue; // this commit doesn't touch the file
        }
        if !started {
            base = anc;
            head = cur;
            started = true;
        } else {
            if head != anc {
                gapped = true;
            }
            head = cur;
        }
    }
    Ok(((base, head), gapped))
}
