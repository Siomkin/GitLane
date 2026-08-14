//! Rendering a file's net change straight from its `(old, new)` blob pair — the
//! connected case, where no unselected commit edited the file in between.

use std::path::Path;

use git2::{DiffOptions, Patch, Repository};

use crate::git::types::{ChangeStatus, FileChange, FileDiff};

use super::super::diff::render_patch;
use super::touches::BlobPair;

/// One-letter status from the file's presence on each side of the net diff.
fn status_for(old: bool, new: bool) -> ChangeStatus {
    match (old, new) {
        (false, true) => ChangeStatus::Added,
        (true, false) => ChangeStatus::Deleted,
        _ => ChangeStatus::Modified,
    }
}

/// libgit2's `git2::Patch::from_blobs` wrapper takes non-optional `&Blob`, so it
/// can't express an added/deleted side. Diffing the blobs' bytes — an absent side
/// is just `&[]` — keeps the same hunk/stat machinery without writing an empty
/// blob to the object DB.
pub(super) fn diff_bytes<'a>(
    old: Option<&'a [u8]>,
    new: Option<&'a [u8]>,
    path: &str,
    opts: &mut DiffOptions,
) -> Result<Patch<'a>, git2::Error> {
    Patch::from_buffers(
        old.unwrap_or(&[]),
        Some(Path::new(path)),
        new.unwrap_or(&[]),
        Some(Path::new(path)),
        Some(opts),
    )
}

pub(super) fn file_change(
    repo: &Repository,
    path: &str,
    (old, new): BlobPair,
) -> Result<FileChange, git2::Error> {
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
        status: status_for(old.is_some(), new.is_some()),
        add,
        del,
        binary,
        line_count_truncated: false,
        // The multi-commit union diff is keyed by a single path (renames are
        // resolved into the net add/delete), so there is no distinct old side.
        previous_path: None,
        advanced: None,
    })
}

pub(super) fn file_diff(
    repo: &Repository,
    path: &str,
    (old, new): BlobPair,
    limit: usize,
) -> Result<FileDiff, git2::Error> {
    let old_blob = old.map(|o| repo.find_blob(o)).transpose()?;
    let new_blob = new.map(|o| repo.find_blob(o)).transpose()?;
    let status = status_for(old.is_some(), new.is_some());
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
    // Text deltas carry their blob oids too (mirroring `diffs_to_files`), so
    // content previews — rendered markdown — can fetch the new side via
    // `read_binary_blob`. Sizes stay binary-only: the hunks carry the text.
    Ok(FileDiff {
        path: path.to_string(),
        status,
        add,
        del,
        hunks,
        truncated,
        old_oid: old.map(|o| o.to_string()),
        new_oid: new.map(|o| o.to_string()),
        ..Default::default()
    })
}
