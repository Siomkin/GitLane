//! Merged ("union") diff across an arbitrary multi-commit selection (GL-69).
//!
//! GL-68 covers a contiguous first-parent run with a single `base..head` range.
//! This generalises to a gapped / cross-lane selection: the net change per file
//! is the cumulative effect of **exactly the picked commits**, so a file added
//! then deleted within the selection nets to nothing, add+modify nets to add,
//! modify+delete to delete.
//!
//! For a file whose selected touches are *connected* — every selected commit
//! that touches it builds directly on the previous selected one (no unselected
//! commit edited it in between) — the net is simply the diff from the file's
//! blob before the earliest selected touch to its blob at the latest. This is
//! the common case (all contiguous selections, plus gapped selections where the
//! skipped commits don't touch the file) and stays an oid-level blob diff.
//!
//! When an **unselected** commit edits a file *between* two selected touches
//! (a "gap"), that intermediate blob would otherwise leak into the result. Such
//! files are instead **composed**: each selected commit's change to the file is
//! replayed in order via a 3-way merge, so the unselected edit is excluded.
//!
//! Caveats:
//! - **First parent only.** A merge commit's contribution is its diff vs its
//!   first parent (like `commit_files`), so changes visible only through a
//!   merge's other parents aren't part of the union.
//! - **Composition is text-only.** A gapped file whose selected chain involves
//!   an add/delete or a binary blob, or whose composition doesn't auto-merge,
//!   can't be composed at the blob level. Its per-file diff (`selection_diff_file`)
//!   then **fails closed** with a message rather than show a blob-range that would
//!   include the intervening unselected edit. It still appears in the file list
//!   (`selection_diff`), where its counts are the approximate blob-range so the
//!   change isn't hidden — a rare case noted here rather than special-cased
//!   further with a dedicated "approximate" UI state.
//! - **Cost is linear in the selection.** One `diff_tree_to_tree` per selected
//!   commit; this runs on the blocking pool, but a very large pick (dozens of
//!   commits) is correspondingly slower.

use std::collections::HashMap;
use std::path::Path;

use git2::{merge_file, Commit, DiffOptions, MergeFileInput, Oid, Patch, Repository};

use crate::git::read::open;
use crate::git::types::{FileChange, FileDiff};

use super::diff::{render_patch, DIFF_LINE_LIMIT};

/// Net `(old, new)` blob oids for one file across the selection — `None` on a
/// side means the file is absent there (added / deleted).
type BlobPair = (Option<Oid>, Option<Oid>);

/// Per-file accumulation over the selection. `gapped` marks a file an unselected
/// commit edited between two selected touches, so its net needs composing rather
/// than a plain `base..head` blob diff.
struct Touch {
    base: Option<Oid>,
    head: Option<Oid>,
    gapped: bool,
}

/// Resolve the selected oids to commits ordered **oldest first by ancestry**, so
/// a parent always precedes its descendant regardless of commit timestamps —
/// which can run backwards after amend/rebase/import or clock skew, and would
/// otherwise make `collect_touches`/`compose_text` derive the wrong base/head.
///
/// Order key per commit: the number of *other selected* commits that are its
/// ancestors (so ancestors rank before descendants). Commits with no ancestry
/// relationship in the pick share a rank and fall back to committer time, then
/// input order, for a deterministic result.
fn ordered_commits<'r>(repo: &'r Repository, oids: &[String]) -> Result<Vec<Commit<'r>>, git2::Error> {
    let mut commits: Vec<Commit<'r>> = Vec::with_capacity(oids.len());
    for oid in oids {
        commits.push(repo.find_commit(Oid::from_str(oid)?)?);
    }
    let ids: Vec<Oid> = commits.iter().map(|c| c.id()).collect();
    let times: Vec<i64> = commits.iter().map(|c| c.time().seconds()).collect();
    let n = commits.len();

    // `graph_descendant_of(a, b)` is true when a descends from b, i.e. b is an
    // ancestor of a — so this counts selected ancestors of each commit.
    let mut rank = vec![0usize; n];
    for i in 0..n {
        for j in 0..n {
            if i != j && repo.graph_descendant_of(ids[i], ids[j]).unwrap_or(false) {
                rank[i] += 1;
            }
        }
    }

    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| rank[a].cmp(&rank[b]).then(times[a].cmp(&times[b])).then(a.cmp(&b)));

    // Reorder the owned commits by `order` without cloning.
    let mut slots: Vec<Option<Commit<'r>>> = commits.into_iter().map(Some).collect();
    Ok(order.into_iter().map(|i| slots[i].take().expect("each index used once")).collect())
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
/// the earliest touch (`base`), the blob of the latest touch (`head`), and
/// whether an unselected commit edited it in between (`gapped`).
fn collect_touches(repo: &Repository, ordered: &[Commit]) -> Result<HashMap<String, Touch>, git2::Error> {
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
            match touched.get_mut(&path) {
                None => {
                    touched.insert(path, Touch { base: anc, head: new, gapped: false });
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
fn touch_for_file(ordered: &[Commit], file: &str) -> Result<(BlobPair, bool), git2::Error> {
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

/// 3-way merge three text buffers, returning the merged bytes only when it
/// auto-merges (a conflict means the selected edits genuinely overlap — the
/// caller falls back rather than emit conflict markers into a diff).
fn merge_text(ancestor: &[u8], ours: &[u8], theirs: &[u8], path: &str) -> Option<Vec<u8>> {
    let mut a = MergeFileInput::new();
    a.content(ancestor).path(path);
    let mut o = MergeFileInput::new();
    o.content(ours).path(path);
    let mut t = MergeFileInput::new();
    t.content(theirs).path(path);
    let res = merge_file(&a, &o, &t, None).ok()?;
    res.is_automergeable().then(|| res.content().to_vec())
}

/// Compose **only the selected commits'** changes to `file` into `(base, new)`
/// text buffers, excluding any unselected edit. Each selected touch is replayed
/// onto the running result: connected touches apply cleanly, a gap is resolved
/// by 3-way merging that commit's change onto the composed-so-far content.
/// Returns `None` (caller falls back to the blob-range) when the chain isn't
/// pure text — an add/delete side or a binary blob — or a compose step
/// conflicts, since those can't be composed at the blob level.
fn compose_text(repo: &Repository, ordered: &[Commit], file: &str) -> Result<Option<(Vec<u8>, Vec<u8>)>, git2::Error> {
    let mut base: Option<Vec<u8>> = None;
    let mut acc: Vec<u8> = Vec::new();
    for commit in ordered {
        let tree = commit.tree()?;
        let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let anc_oid = blob_in(parent_tree.as_ref(), file);
        let new_oid = blob_in(Some(&tree), file);
        if anc_oid == new_oid {
            continue; // this commit doesn't touch the file
        }
        // Only pure text modifications compose; add/delete or binary in the
        // chain can't be replayed at the blob level.
        let (anc_oid, new_oid) = match (anc_oid, new_oid) {
            (Some(a), Some(n)) => (a, n),
            _ => return Ok(None),
        };
        let anc_blob = repo.find_blob(anc_oid)?;
        let new_blob = repo.find_blob(new_oid)?;
        if anc_blob.is_binary() || new_blob.is_binary() {
            return Ok(None);
        }
        let anc_bytes = anc_blob.content().to_vec();
        let new_bytes = new_blob.content().to_vec();
        if base.is_none() {
            base = Some(anc_bytes.clone());
            acc = anc_bytes.clone();
        }
        if acc == anc_bytes {
            acc = new_bytes; // connected (or first) touch: apply directly
        } else {
            match merge_text(&anc_bytes, &acc, &new_bytes, file) {
                Some(merged) => acc = merged,
                None => return Ok(None),
            }
        }
    }
    Ok(base.map(|b| (b, acc)))
}

fn text_change(path: &str, base: &[u8], new: &[u8]) -> Result<FileChange, git2::Error> {
    let mut opts = DiffOptions::new();
    let patch = diff_bytes(Some(base), Some(new), path, &mut opts)?;
    let (_ctx, add, del) = patch.line_stats()?;
    Ok(FileChange { path: path.to_string(), status: "M".to_string(), add, del, binary: false, advanced: None })
}

fn text_diff(path: &str, base: &[u8], new: &[u8], limit: usize) -> Result<FileDiff, git2::Error> {
    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    let patch = diff_bytes(Some(base), Some(new), path, &mut opts)?;
    let (add, del, hunks, truncated) = render_patch(&patch, limit)?;
    Ok(FileDiff { path: path.to_string(), status: "M".to_string(), add, del, hunks, truncated, ..Default::default() })
}

/// Net changed files across the merged selection (`oids` in any order). Files
/// with no net change (added then deleted, or reverted) are dropped.
pub fn selection_diff(path: &str, oids: &[String]) -> Result<Vec<FileChange>, git2::Error> {
    let repo = open(path)?;
    let ordered = ordered_commits(&repo, oids)?;
    let touched = collect_touches(&repo, &ordered)?;

    let mut out = Vec::new();
    for (file, t) in touched {
        if t.gapped {
            // Exclude the intervening unselected edit by composing the selected
            // deltas; falls through to the blob-range when not compose-eligible.
            if let Some((base, acc)) = compose_text(&repo, &ordered, &file)? {
                if base != acc {
                    out.push(text_change(&file, &base, &acc)?);
                }
                continue;
            }
        }
        if t.base == t.head {
            continue; // no net change (incl. add+delete within the selection)
        }
        out.push(file_change(&repo, &file, (t.base, t.head))?);
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
    let limit = if full { usize::MAX } else { DIFF_LINE_LIMIT };
    let (pair, gapped) = touch_for_file(&ordered, file)?;
    if gapped {
        if let Some((base, acc)) = compose_text(&repo, &ordered, file)? {
            return text_diff(file, &base, &acc, limit);
        }
        // Fail closed: the selected-only diff can't be composed (an add/delete or
        // binary blob, or a conflicting compose). Rather than return the
        // blob-range — which would include the intervening unselected edit and
        // misrepresent "exactly the picked commits" — surface an explicit message.
        return Err(git2::Error::from_str(
            "This file also changed in commits between the ones you selected, so its exact merged diff can't be shown for this selection.",
        ));
    }
    file_diff(&repo, file, pair, limit)
}
