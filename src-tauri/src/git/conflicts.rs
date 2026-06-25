//! Conflict + in-progress-operation detection (libgit2 reads).
//!
//! Like the other read modules, every function takes a path and opens the repo
//! fresh — `git2::Repository` is not `Send`, so we never hold one across the
//! async Tauri command boundary. This module only *reports* the conflicted
//! state; *resolving* it (accept ours/theirs, stage, continue/abort/skip)
//! shells out to the real `git` binary in [`super::write`], per the read/write
//! split.

use git2::{IndexConflict, IndexEntry, Repository, RepositoryState};

use super::read::open;
use super::types::{ConflictFile, ConflictFileContent, OperationStatus};

/// Map libgit2's `RepositoryState` to the operation key the frontend expects.
/// Anything that isn't a merge/rebase/cherry-pick/revert (Clean, Bisect,
/// ApplyMailbox, …) reports "none" — the conflict workflow only covers the
/// operations GitLane can drive to completion.
fn operation_kind(state: RepositoryState) -> &'static str {
    match state {
        RepositoryState::Merge => "merge",
        RepositoryState::Revert | RepositoryState::RevertSequence => "revert",
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => "cherry-pick",
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => "rebase",
        _ => "none",
    }
}

/// The active operation (if any) plus its outstanding conflicts.
pub fn operation_status(path: &str) -> Result<OperationStatus, git2::Error> {
    let repo = open(path)?;
    let kind = operation_kind(repo.state());
    // Conflicts can exist only inside an operation; skip the index walk for a
    // clean repo so the common case stays cheap.
    let conflicts = if kind == "none" {
        Vec::new()
    } else {
        conflict_files(&repo)?
    };
    Ok(OperationStatus {
        kind: kind.to_string(),
        can_skip: matches!(kind, "rebase" | "cherry-pick" | "revert"),
        conflicts,
    })
}

/// Every unmerged path in the index, classified as text / binary / deleted.
fn conflict_files(repo: &Repository) -> Result<Vec<ConflictFile>, git2::Error> {
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
            if is_binary(repo, our) || is_binary(repo, their) {
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

/// True when an index entry's blob is binary (libgit2's NUL-byte heuristic).
fn is_binary(repo: &Repository, entry: &IndexEntry) -> bool {
    repo.find_blob(entry.id)
        .map(|blob| blob.is_binary())
        .unwrap_or(false)
}

/// The worktree copy of a conflicted text file, including git's merge markers,
/// for the in-app editor to parse. Binary files come back with empty content and
/// `binary: true` (the UI offers a whole-file choice instead of a line editor).
pub fn conflict_file(path: &str, file: &str) -> Result<ConflictFileContent, git2::Error> {
    let repo = open(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("bare repository has no worktree"))?;
    // `file` crosses the IPC boundary; reject absolute paths and `..`/prefix
    // traversal so a read can never escape the worktree (conflicted paths come
    // from git's index, which already forbids these — validated defensively).
    let rel = std::path::Path::new(file);
    if rel.is_absolute()
        || rel.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(git2::Error::from_str(&format!(
            "refusing unsafe path outside the worktree: {file:?}"
        )));
    }
    // Only a genuine unmerged path may be read here — not any safe relative file.
    let conflicted = repo.index()?.conflicts()?.flatten().any(|c| {
        c.our
            .as_ref()
            .or(c.their.as_ref())
            .or(c.ancestor.as_ref())
            .map_or(false, |entry| &*String::from_utf8_lossy(&entry.path) == file)
    });
    if !conflicted {
        return Err(git2::Error::from_str(&format!(
            "{file:?} is not a conflicted path"
        )));
    }
    let bytes = std::fs::read(workdir.join(rel))
        .map_err(|e| git2::Error::from_str(&format!("read {file}: {e}")))?;
    let binary = bytes.contains(&0);
    let content = if binary {
        String::new()
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    };
    Ok(ConflictFileContent {
        path: file.to_string(),
        content,
        binary,
    })
}
