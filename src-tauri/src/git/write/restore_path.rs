//! Restore one path's worktree contents from a historical commit blob.
//!
//! ADR 0003: worktree only (`git restore --source=<oid> --worktree`) — never
//! stage. Confirmations use [`worktree_differs_from_commit`] so a no-op restore
//! skips the dialog.

use std::io;
use std::path::{Component, Path};

use git2::{ObjectType, Oid, Repository};

use crate::git::read::open;
use crate::git::worktree_fs::{fingerprint_worktree_leaf, WorktreeLeafFingerprint};

use super::cli::run_git_literal_paths;
use super::operands::{ensure_exact_oid, ensure_operand};

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
    let relative = normalize_relative(file)?;
    let repository = open(repo).map_err(|e| e.to_string())?;
    let blob_oid = commit_path_blob_oid_in(&repository, commit_oid, &relative)?;
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
    let Ok(relative) = normalize_relative(file) else {
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
    let relative = normalize_relative(file)?;
    // Validate blob exists + isn't a gitlink before shelling out.
    let _ = commit_path_blob_oid(repo, commit_oid, &relative)?;

    run_git_literal_paths(
        repo,
        &[
            "restore",
            "--source",
            commit_oid,
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
fn commit_path_blob_oid(repo: &str, commit_oid: &str, file: &str) -> Result<Oid, String> {
    let repository = open(repo).map_err(|e| e.to_string())?;
    commit_path_blob_oid_in(&repository, commit_oid, file)
}

/// [`commit_path_blob_oid`] against an already-open repository.
fn commit_path_blob_oid_in(
    repository: &Repository,
    commit_oid: &str,
    file: &str,
) -> Result<Oid, String> {
    ensure_exact_oid(commit_oid)?;
    ensure_operand(commit_oid)?;
    let oid = Oid::from_str(commit_oid).map_err(|e| e.to_string())?;
    let commit = repository
        .find_commit(oid)
        .map_err(|e| format!("Couldn't resolve commit: {e}"))?;
    let tree = commit
        .tree()
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
    Ok(entry.id())
}

fn normalize_relative(file: &str) -> Result<String, String> {
    if file.is_empty() {
        return Err("Missing path to restore".to_string());
    }
    let relative = Path::new(file);
    if relative.is_absolute() {
        return Err("Restore path must be repository-relative".to_string());
    }
    if relative
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!(
            "Refusing to restore path outside the worktree: {file}"
        ));
    }
    if relative
        .components()
        .any(|c| matches!(c, Component::Normal(name) if name.eq_ignore_ascii_case(".git")))
    {
        return Err(format!(
            "Refusing to restore path outside the worktree: {file}"
        ));
    }
    let trimmed = file.trim_matches('/');
    if trimmed.is_empty() {
        return Err("Missing path to restore".to_string());
    }
    Ok(trimmed.to_string())
}

fn short_oid(oid: &str) -> &str {
    oid.get(..7).unwrap_or(oid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rejects_parent_and_git() {
        assert!(normalize_relative("../x").is_err());
        assert!(normalize_relative(".git/config").is_err());
        assert!(normalize_relative("/abs").is_err());
        assert!(normalize_relative("").is_err());
    }

    #[test]
    fn short_oid_truncates() {
        assert_eq!(short_oid("abcdef0123456789"), "abcdef0");
        assert_eq!(short_oid("abc"), "abc");
    }
}
