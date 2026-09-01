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

mod blob_diff;
mod compose;
mod ordering;
mod touches;

use crate::git::read::open;
use crate::git::types::{FileChange, FileDiff};

use super::diff::DIFF_LINE_LIMIT;
use blob_diff::{file_change, file_diff};
use compose::{compose_text, text_change, text_diff};
use ordering::ordered_commits;
use touches::{collect_touches, touch_for_file};

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
        let mut change = file_change(&repo, &file, (t.base, t.head))?;
        if t.untracked {
            change.status = crate::git::types::ChangeStatus::Untracked;
        }
        out.push(change);
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
    let touch = touch_for_file(&repo, &ordered, file)?;
    if touch.gapped {
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
    let mut diff = file_diff(&repo, file, (touch.base, touch.head), limit)?;
    if touch.untracked {
        diff.status = crate::git::types::ChangeStatus::Untracked;
    }
    Ok(diff)
}
