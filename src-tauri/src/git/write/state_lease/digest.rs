//! The scope/HEAD header both lease tokens open with, and the budgeted leaf
//! fingerprint both feed them.

use std::ffi::OsStr;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::git::worktree_fs::{
    fingerprint_worktree_leaf_path_bounded, WorktreeLeafFingerprint, WorktreeLeafObservation,
};

use super::{hash_field, hash_os, path_label, LeaseError, RepositoryScope};

/// Hash the leased scope: its three paths, their directory identities, and
/// whether it is a linked worktree. The caller hashes its domain tag first.
pub(in crate::git::write) fn hash_scope(state: &mut Sha256, scope: &RepositoryScope) {
    hash_os(state, scope.workdir.as_os_str());
    hash_os(state, scope.gitdir.as_os_str());
    hash_os(state, scope.commondir.as_os_str());
    scope.workdir_identity.hash_into(state);
    scope.gitdir_identity.hash_into(state);
    scope.commondir_identity.hash_into(state);
    state.update([u8::from(scope.is_worktree)]);
}

/// Hash HEAD's branch, commit and tree, each marked present or absent.
pub(in crate::git::write) fn hash_head(
    state: &mut Sha256,
    branch: Option<&str>,
    oid: Option<&str>,
    tree_oid: Option<&str>,
) {
    for value in [branch, oid, tree_oid] {
        match value {
            Some(value) => {
                state.update([1]);
                hash_field(state, value.as_bytes());
            }
            None => state.update([0]),
        }
    }
}

/// Fingerprint one leaf, charging a regular file's length to `remaining_bytes`.
///
/// The observation is deliberately *not* part of the token — it carries inode
/// and timestamps, which guard **capture coherence** rather than content (see
/// `worktree_fs::WorktreeLeafObservation`). Hashing a set of files is not
/// atomic, so a leaf streamed early can be rewritten while later leaves are
/// still being read; each lease rechecks the observations afterwards.
pub(in crate::git::write) fn fingerprint_with_budget(
    workdir: &Path,
    path: &OsStr,
    remaining_bytes: &mut u64,
) -> Result<(WorktreeLeafFingerprint, WorktreeLeafObservation), LeaseError> {
    let (fingerprint, observation) =
        fingerprint_worktree_leaf_path_bounded(workdir, Path::new(path), *remaining_bytes)
            .map_err(|error| {
                let label = path_label(path);
                if error.kind() == std::io::ErrorKind::InvalidData {
                    LeaseError::FingerprintLimit {
                        label,
                        while_reading: true,
                    }
                } else {
                    LeaseError::InspectLeaf { label, error }
                }
            })?;
    if let WorktreeLeafFingerprint::Regular { len, .. } = &fingerprint {
        *remaining_bytes =
            remaining_bytes
                .checked_sub(*len)
                .ok_or_else(|| LeaseError::FingerprintLimit {
                    label: path_label(path),
                    while_reading: false,
                })?;
    }
    Ok((fingerprint, observation))
}
