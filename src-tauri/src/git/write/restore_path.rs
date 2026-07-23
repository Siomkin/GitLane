//! Restore one path's worktree contents from a historical commit blob.
//!
//! ADR 0003: worktree only (`git restore --source=<oid> --worktree`) — never
//! stage. Confirmations use [`worktree_differs_from_commit`] so a no-op restore
//! skips the dialog.

use std::io;
use std::path::{Component, Path};

use git2::{ObjectType, Oid};
use sha2::{Digest, Sha256};

use crate::git::read::open;
use crate::git::worktree_fs::{fingerprint_worktree_leaf, WorktreeLeafFingerprint};

use super::cli::run_git_literal_paths;
use super::operands::{ensure_exact_oid, ensure_operand};

/// True when restoring `file` from `commit_oid` would overwrite different
/// on-disk bytes (or create a missing leaf). False when the worktree already
/// matches the commit blob. Errors when the path has no restoreable blob at
/// that commit (deleted, submodule/gitlink, bad path).
pub fn worktree_differs_from_commit(
    repo: &str,
    commit_oid: &str,
    file: &str,
) -> Result<bool, String> {
    let relative = normalize_relative(file)?;
    let blob = commit_blob(repo, commit_oid, &relative)?;
    let repository = open(repo).map_err(|e| e.to_string())?;
    let workdir = repository
        .workdir()
        .ok_or_else(|| "repository has no working directory".to_string())?;

    match fingerprint_worktree_leaf(workdir, &relative) {
        Ok((WorktreeLeafFingerprint::Missing, _)) => Ok(true),
        Ok((WorktreeLeafFingerprint::Regular { digest, .. }, _)) => {
            Ok(digest != sha256_bytes(&blob.bytes))
        }
        Ok((WorktreeLeafFingerprint::Symlink { target, .. }, _)) => Ok(target != blob.bytes),
        Ok((WorktreeLeafFingerprint::Other { .. }, _)) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(format!("Couldn't inspect {relative}: {error}")),
    }
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
    let _ = commit_blob(repo, commit_oid, &relative)?;

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

struct CommitBlob {
    bytes: Vec<u8>,
}

fn commit_blob(repo: &str, commit_oid: &str, file: &str) -> Result<CommitBlob, String> {
    ensure_exact_oid(commit_oid)?;
    ensure_operand(commit_oid)?;
    let repository = open(repo).map_err(|e| e.to_string())?;
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

    let object = entry
        .to_object(&repository)
        .map_err(|e| format!("Couldn't read {file}: {e}"))?;
    let blob = object
        .peel_to_blob()
        .map_err(|_| format!("“{file}” is not a file in commit {}", short_oid(commit_oid)))?;
    Ok(CommitBlob {
        bytes: blob.content().to_vec(),
    })
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

fn sha256_bytes(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
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
}
