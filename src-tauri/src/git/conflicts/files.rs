//! Conflict index listing and conflict-kind classification.

use git2::{IndexConflict, IndexEntry, Repository};

use crate::git::types::ConflictFile;

/// Every unmerged path in the index, classified as text / binary / deleted.
pub(super) fn conflict_files(repo: &Repository) -> Result<Vec<ConflictFile>, git2::Error> {
    let index = repo.index()?;
    if !index.has_conflicts() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    for entry in index.conflicts()? {
        let conflict = entry?;
        // Take the path from whichever stage exists (a deletion leaves one side
        // empty); skip the pathological all-empty conflict.
        let path = conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .or(conflict.ancestor.as_ref())
            .map(|e| String::from_utf8_lossy(&e.path).to_string());
        let Some(path) = path else { continue };
        let (kind, deleted_side) = classify(repo, &conflict);
        out.push(ConflictFile {
            path,
            kind: kind.to_string(),
            deleted_side: deleted_side.to_string(),
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Classify a single index conflict: a missing side means a delete/modify
/// conflict; otherwise it's a content conflict, binary when either present side
/// is a binary blob.
fn classify(repo: &Repository, conflict: &IndexConflict) -> (&'static str, &'static str) {
    match (&conflict.our, &conflict.their) {
        (Some(_), None) => ("deleted", "theirs"),
        (None, Some(_)) => ("deleted", "ours"),
        (Some(our), Some(their)) => {
            // Symlinks (120000) and submodule gitlinks (160000) aren't blobs we
            // can line-merge — and their IDs aren't blobs, so `is_binary`'s
            // `find_blob` would fail and misclassify them as "text". Route them to
            // the whole-file picker so the user stages a manual resolution.
            if is_special_mode(our)
                || is_special_mode(their)
                || is_binary(repo, our)
                || is_binary(repo, their)
            {
                ("binary", "")
            } else {
                ("text", "")
            }
        }
        // Both sides deleted (DD) — nothing to merge; treat as a deletion both
        // already agree on, surfaced as "deleted by theirs" for the UI's card.
        (None, None) => ("deleted", "theirs"),
    }
}

/// True for a symlink (`120000`) or submodule gitlink (`160000`) index entry —
/// not a regular blob, so it can't be line-merged or safely read from the
/// worktree path and must be handled as a whole-file conflict.
fn is_special_mode(entry: &IndexEntry) -> bool {
    matches!(entry.mode & 0o170000, 0o120000 | 0o160000)
}

/// True when an index entry's blob is binary (libgit2's NUL-byte heuristic).
fn is_binary(repo: &Repository, entry: &IndexEntry) -> bool {
    repo.find_blob(entry.id)
        .map(|blob| blob.is_binary())
        .unwrap_or(false)
}
