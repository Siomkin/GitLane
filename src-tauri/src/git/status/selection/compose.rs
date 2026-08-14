//! Composing **only the selected commits'** edits to a gapped file, so the
//! intervening unselected edit is excluded from the result.

use git2::{merge_file, Commit, DiffOptions, MergeFileInput, Repository};

use crate::git::types::{ChangeStatus, FileChange, FileDiff};

use super::super::diff::render_patch;
use super::blob_diff::diff_bytes;
use super::touches::blob_in;

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
pub(super) type TextComposition = Option<(Vec<u8>, Vec<u8>)>;

pub(super) fn compose_text(
    repo: &Repository,
    ordered: &[Commit],
    file: &str,
) -> Result<TextComposition, git2::Error> {
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

pub(super) fn text_change(path: &str, base: &[u8], new: &[u8]) -> Result<FileChange, git2::Error> {
    let mut opts = DiffOptions::new();
    let patch = diff_bytes(Some(base), Some(new), path, &mut opts)?;
    let (_ctx, add, del) = patch.line_stats()?;
    Ok(FileChange {
        path: path.to_string(),
        status: ChangeStatus::Modified,
        add,
        del,
        binary: false,
        line_count_truncated: false,
        previous_path: None,
        advanced: None,
    })
}

/// Diff two composed text buffers. Unlike `file_diff`, no blob oids travel: the
/// composed result exists only in memory (it need not match any blob in the
/// ODB), so content previews for a gapped file fall back to their empty state
/// rather than fetch a blob that would include the unselected edit.
pub(super) fn text_diff(
    path: &str,
    base: &[u8],
    new: &[u8],
    limit: usize,
) -> Result<FileDiff, git2::Error> {
    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    let patch = diff_bytes(Some(base), Some(new), path, &mut opts)?;
    let (add, del, hunks, truncated) = render_patch(&patch, limit)?;
    Ok(FileDiff {
        path: path.to_string(),
        status: ChangeStatus::Modified,
        add,
        del,
        hunks,
        truncated,
        ..Default::default()
    })
}
