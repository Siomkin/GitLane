//! What the lease hashes: the status read it parses, the index digest, and
//! the budgeted per-leaf worktree fingerprint.

use super::scope::{describe_lease_error, run_scoped_git_stdout_raw};
use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::Path;

use git2::{Oid, Repository};

use crate::git::worktree_fs::{WorktreeLeafFingerprint, WorktreeLeafObservation};

use super::super::state_lease::{self, read_porcelain_z, RepositoryScope};

/// One `git status --porcelain=v1 -z` read: the records the lease hashes, and
/// the paths whose content it then fingerprints.
pub(super) struct ParsedStatus {
    pub(super) semantic_records: Vec<Vec<u8>>,
    pub(super) dirty_paths: BTreeSet<Vec<u8>>,
}

pub(super) fn effective_tree_oid_no_replace(
    scope: &RepositoryScope,
    commit_oid: &str,
) -> Result<String, String> {
    let tree_spec = format!("{commit_oid}^{{tree}}");
    let raw = run_scoped_git_stdout_raw(
        scope,
        &[
            "--no-replace-objects",
            "rev-parse",
            "--verify",
            "--end-of-options",
            &tree_spec,
        ],
    )?;
    let text = std::str::from_utf8(&raw)
        .map_err(|_| "Git returned a non-UTF-8 target tree object id.".to_string())?;
    let value = text.trim_end_matches(['\r', '\n']);
    if value.contains('\r') || value.contains('\n') {
        return Err("Git returned a malformed target tree object id.".to_string());
    }
    let oid = Oid::from_str(value)
        .map_err(|_| "Git returned a malformed target tree object id.".to_string())?;
    Ok(oid.to_string())
}

pub(super) fn capture_index_digest(repository: &Repository) -> Result<[u8; 32], String> {
    state_lease::index_digest(repository, b"gitlane-hard-reset-index-v1")
        .map(|(digest, _)| digest)
        .map_err(describe_lease_error)
}

pub(super) fn read_status(scope: &RepositoryScope) -> Result<ParsedStatus, String> {
    let records = read_porcelain_z(scope).map_err(describe_lease_error)?;
    let mut semantic_records = Vec::with_capacity(records.len());
    let mut dirty_paths = BTreeSet::new();
    for record in records {
        semantic_records.push(record.semantic());
        dirty_paths.insert(record.path);
        dirty_paths.extend(record.orig);
    }
    Ok(ParsedStatus {
        semantic_records,
        dirty_paths,
    })
}

/// Fingerprint one leaf against the capture's byte budget, in this
/// operation's words; see [`state_lease::fingerprint_with_budget`].
pub(super) fn fingerprint_with_budget(
    workdir: &Path,
    path: &OsStr,
    remaining_bytes: &mut u64,
) -> Result<(WorktreeLeafFingerprint, WorktreeLeafObservation), String> {
    state_lease::fingerprint_with_budget(workdir, path, remaining_bytes)
        .map_err(describe_lease_error)
}
