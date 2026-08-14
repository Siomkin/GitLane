//! What the lease hashes: the status read it parses, the index digest, and
//! the budgeted per-leaf worktree fingerprint.

use super::scope::run_scoped_git_stdout_raw;
use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::Path;

use git2::{IndexEntryExtendedFlag, IndexEntryFlag, Oid, Repository};
use sha2::{Digest, Sha256};

use crate::git::worktree_fs::{
    fingerprint_worktree_leaf_path_bounded, WorktreeDirectoryIdentity, WorktreeLeafFingerprint,
    WorktreeLeafObservation,
};

use super::super::state_lease::{hash_field, path_label, RepositoryScope, MAX_FINGERPRINT_BYTES};

/// One `git status --porcelain=v1 -z` read: the records the lease hashes, and
/// the paths whose content it then fingerprints.
pub(super) struct ParsedStatus {
    pub(super) semantic_records: Vec<Vec<u8>>,
    pub(super) dirty_paths: BTreeSet<Vec<u8>>,
}

pub(super) fn hash_identity(state: &mut Sha256, identity: &WorktreeDirectoryIdentity) {
    identity.hash_into(state);
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
    let index = repository
        .index()
        .map_err(|error| format!("Could not inspect the index before hard reset: {error}"))?;
    let mut state = Sha256::new();
    hash_field(&mut state, b"gitlane-hard-reset-index-v1");
    let mut count = 0u64;
    for entry in index.iter() {
        count += 1;
        let flags = IndexEntryFlag::from_bits_truncate(entry.flags);
        let extended = IndexEntryExtendedFlag::from_bits_truncate(entry.flags_extended);
        if flags.is_valid() {
            return Err(format!(
                "{} is marked assume-unchanged. Clear that index flag before hard reset.",
                String::from_utf8_lossy(&entry.path)
            ));
        }
        if extended.is_skip_worktree() {
            return Err(format!(
                "{} is marked skip-worktree (or belongs to a sparse index). Disable sparse/skip-worktree state before hard reset.",
                String::from_utf8_lossy(&entry.path)
            ));
        }
        let stage = ((entry.flags >> 12) & 0x3) as u8;
        if stage != 0 {
            return Err(
                "Conflicted index entries are present. Resolve or abort the operation before hard reset."
                    .to_string(),
            );
        }
        hash_field(&mut state, &entry.path);
        state.update(entry.id.as_bytes());
        state.update(entry.mode.to_le_bytes());
        state.update(entry.flags.to_le_bytes());
        state.update(entry.flags_extended.to_le_bytes());
    }
    state.update(count.to_le_bytes());
    Ok(state.finalize().into())
}

pub(super) fn read_status(scope: &RepositoryScope) -> Result<ParsedStatus, String> {
    let raw = run_scoped_git_stdout_raw(
        scope,
        &[
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )?;
    let mut semantic_records = Vec::new();
    let mut paths = BTreeSet::new();
    let mut cursor = 0usize;
    while cursor < raw.len() {
        let end = raw[cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| cursor + offset)
            .ok_or_else(|| "Git returned a malformed status record.".to_string())?;
        let record = &raw[cursor..end];
        cursor = end + 1;
        if record.is_empty() {
            continue;
        }
        if record.len() < 4 || record[2] != b' ' {
            return Err("Git returned a malformed status record.".to_string());
        }
        let code = &record[..2];
        let path = record[3..].to_vec();
        let rename = code.iter().any(|byte| matches!(*byte, b'R' | b'C'));
        let second = if rename {
            let second_end = raw[cursor..]
                .iter()
                .position(|byte| *byte == 0)
                .map(|offset| cursor + offset)
                .ok_or_else(|| "Git returned a malformed rename status record.".to_string())?;
            let value = raw[cursor..second_end].to_vec();
            cursor = second_end + 1;
            Some(value)
        } else {
            None
        };
        let mut semantic = record.to_vec();
        if let Some(other) = &second {
            semantic.push(0);
            semantic.extend_from_slice(other);
        }
        semantic_records.push(semantic);
        paths.insert(path);
        if let Some(other) = second {
            paths.insert(other);
        }
    }
    Ok(ParsedStatus {
        semantic_records,
        dirty_paths: paths,
    })
}

/// Fingerprint one leaf, returning the cheap pathname observation alongside it.
///
/// The observation is deliberately *not* part of the token — it carries inode
/// and timestamps, which guard **capture coherence** rather than content (see
/// `worktree_fs::WorktreeLeafObservation`). Hashing a set of files is not
/// atomic, so a leaf streamed early can be rewritten while later leaves are
/// still being read; its digest would then record the pre-edit bytes and the
/// token would still match. [`validate_observations`] closes that window.
pub(super) fn fingerprint_with_budget(
    workdir: &Path,
    path: &OsStr,
    remaining_bytes: &mut u64,
) -> Result<(WorktreeLeafFingerprint, WorktreeLeafObservation), String> {
    let (fingerprint, observation) =
        fingerprint_worktree_leaf_path_bounded(workdir, Path::new(path), *remaining_bytes)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::InvalidData {
                    format!(
                        "Hard reset exceeded its {} MiB content-fingerprint limit while inspecting {}. Use the terminal for this unusually large repository state.",
                        MAX_FINGERPRINT_BYTES / (1024 * 1024),
                        path_label(path)
                    )
                } else {
                    format!(
                        "Could not inspect {} before hard reset: {error}",
                        path_label(path)
                    )
                }
            })?;
    if let WorktreeLeafFingerprint::Regular { len, .. } = &fingerprint {
        *remaining_bytes = remaining_bytes.checked_sub(*len).ok_or_else(|| {
            format!(
                "Hard reset exceeded its {} MiB content-fingerprint limit while inspecting {}. Use the terminal for this unusually large repository state.",
                MAX_FINGERPRINT_BYTES / (1024 * 1024),
                path_label(path)
            )
        })?;
    }
    Ok((fingerprint, observation))
}
