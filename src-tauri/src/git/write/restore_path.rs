//! Restore one path's worktree contents from a historical commit blob.
//!
//! ADR 0003: worktree only (`git restore --source=<oid> --worktree`) — never
//! stage. Confirmations use [`worktree_differs_from_commit`] so a no-op restore
//! skips the dialog.

use std::io;
use std::path::Path;

use git2::{ObjectType, Oid, Repository};

use crate::git::read::open;
use crate::git::worktree_fs::{fingerprint_worktree_leaf, WorktreeLeafFingerprint};

use super::cli::run_git_literal_paths;
use super::operands::{ensure_exact_oid, ensure_operand};
use super::path_guards::{normalize_relative, PathVerb};

/// True when restoring `file` from `commit_oid` would overwrite different
/// on-disk bytes (or create a missing leaf). False when the worktree already
/// matches the commit blob. Errors when the path has no restoreable blob at
/// that commit (deleted, submodule/gitlink, bad path).
///
/// Compares git blob oids (tree entry vs `git hash-object` of the worktree
/// leaf) so large files are never fully loaded into the Rust process.
pub fn worktree_differs_from_commit(
    repo: &str,
    commit_oid: &str,
    file: &str,
) -> Result<bool, String> {
    let relative = normalize_relative(file, PathVerb::Restore)?;
    let repository = open(repo).map_err(|e| e.to_string())?;
    let blob_oid = commit_path_blob_oid_in(&repository, commit_oid, &relative)?.0;
    let workdir = repository
        .workdir()
        .ok_or_else(|| "repository has no working directory".to_string())?;

    match fingerprint_worktree_leaf(workdir, &relative) {
        Ok((WorktreeLeafFingerprint::Missing, _)) => Ok(true),
        Ok((WorktreeLeafFingerprint::Regular { .. }, _))
        | Ok((WorktreeLeafFingerprint::Symlink { .. }, _)) => {
            let hashed = run_git_literal_paths(repo, &["hash-object", "--", &relative])?;
            let work_oid = Oid::from_str(hashed.trim()).map_err(|e| e.to_string())?;
            Ok(work_oid != blob_oid)
        }
        Ok((WorktreeLeafFingerprint::Other { .. }, _)) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(format!("Couldn't inspect {relative}: {error}")),
    }
}

/// True when `file` has a restorable (non-gitlink) blob at `commit_oid`. Used by
/// the merged multi-commit selection surface, whose union file list has no
/// per-file owning commit: it probes the selection-tip commit so Restore is only
/// offered for paths actually present there, instead of offering it and failing
/// on click. Fails closed — any resolution error resolves to `false` so the menu
/// simply omits Restore (the write path re-validates before touching the disk).
pub fn commit_path_is_restorable(repo: &str, commit_oid: &str, file: &str) -> bool {
    let Ok(relative) = normalize_relative(file, PathVerb::Restore) else {
        return false;
    };
    commit_path_blob_oid(repo, commit_oid, &relative).is_ok()
}

/// Replace the worktree leaf at `file` with the blob from `commit_oid`. Leaves
/// the index alone. Refuses submodules, missing commit paths, and unsafe
/// pathspecs.
pub fn restore_path_from_commit(
    repo: &str,
    commit_oid: &str,
    file: &str,
) -> Result<String, String> {
    let _index_guard = super::index_lock::lock_index_writes(repo)?;
    let relative = normalize_relative(file, PathVerb::Restore)?;
    // Validate blob exists + isn't a gitlink before shelling out.
    let (_blob, source) = commit_path_blob_oid(repo, commit_oid, &relative)?;

    run_git_literal_paths(
        repo,
        &[
            "restore",
            "--source",
            &source,
            "--worktree",
            "--",
            &relative,
        ],
    )?;
    Ok(format!(
        "Restored {relative} from {}",
        short_oid(commit_oid)
    ))
}

/// Resolve the blob oid for `file` at `commit_oid`, refusing gitlinks and
/// non-blob tree entries without loading blob content into memory. Opens the
/// repository fresh — callers that already hold a handle use
/// [`commit_path_blob_oid_in`] to avoid a second open.
fn commit_path_blob_oid(repo: &str, commit_oid: &str, file: &str) -> Result<(Oid, String), String> {
    let repository = open(repo).map_err(|e| e.to_string())?;
    commit_path_blob_oid_in(&repository, commit_oid, file)
}

/// [`commit_path_blob_oid`] against an already-open repository. Returns the blob
/// oid and the commit to pass to `git restore --source` (a stash parent when the
/// path lives off the WIP tree).
fn commit_path_blob_oid_in(
    repository: &Repository,
    commit_oid: &str,
    file: &str,
) -> Result<(Oid, String), String> {
    ensure_exact_oid(commit_oid)?;
    ensure_operand(commit_oid)?;
    let oid = Oid::from_str(commit_oid).map_err(|e| e.to_string())?;
    let commit = repository
        .find_commit(oid)
        .map_err(|e| format!("Couldn't resolve commit: {e}"))?;
    let source = crate::git::status::blob_carrier_oid(repository, &commit, file);
    let tree = repository
        .find_commit(source)
        .and_then(|commit| commit.tree())
        .map_err(|e| format!("Couldn't read commit tree: {e}"))?;
    let entry = tree.get_path(Path::new(file)).map_err(|_| {
        format!(
            "“{file}” is not present in commit {}",
            short_oid(commit_oid)
        )
    })?;

    // gitlink / submodule — not a file blob restore.
    if entry.kind() == Some(ObjectType::Commit) {
        return Err(format!(
            "“{file}” is a submodule at {}; restore isn't supported.",
            short_oid(commit_oid)
        ));
    }
    if entry.kind() != Some(ObjectType::Blob) {
        return Err(format!(
            "“{file}” is not a file in commit {}",
            short_oid(commit_oid)
        ));
    }
    Ok((entry.id(), source.to_string()))
}

fn short_oid(oid: &str) -> &str {
    oid.get(..7).unwrap_or(oid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rejects_parent_and_git() {
        assert!(normalize_relative("../x", PathVerb::Restore).is_err());
        assert!(normalize_relative(".git/config", PathVerb::Restore).is_err());
        assert!(normalize_relative("/abs", PathVerb::Restore).is_err());
        assert!(normalize_relative("", PathVerb::Restore).is_err());
    }

    #[test]
    fn short_oid_truncates() {
        assert_eq!(short_oid("abcdef0123456789"), "abcdef0");
        assert_eq!(short_oid("abc"), "abc");
    }
}
