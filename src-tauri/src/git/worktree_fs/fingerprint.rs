//! Destructive-write preconditions: streaming leaf fingerprints, the cheap
//! pathname observations retained alongside them, and their revalidation.

use std::io::{self, Read};
use std::path::Path;

use sha2::{Digest, Sha256};

use super::meta::{
    changed_path_while_fingerprinting, metadata_mode, path_bytes, same_observed_state,
};
use super::resolve::{open_leaf_nofollow, open_parent_path};
use super::{WorktreeLeafFingerprint, WorktreeLeafObservation};

/// Fingerprint one existing/missing worktree path without following a symlink
/// in any component. The held descriptor and a final no-follow metadata check
/// ensure the digest still names the current leaf when this function returns.
pub(crate) fn fingerprint_worktree_leaf(
    workdir: &Path,
    file: &str,
) -> io::Result<(WorktreeLeafFingerprint, WorktreeLeafObservation)> {
    fingerprint_worktree_leaf_path(workdir, Path::new(file))
}

/// Path-native variant used by whole-tree destructive leases. Git paths are
/// byte strings on Unix, so forcing them through `str` would corrupt or reject
/// a non-UTF-8 untracked filename before the confirmation can protect it.
fn fingerprint_worktree_leaf_path(
    workdir: &Path,
    file: &Path,
) -> io::Result<(WorktreeLeafFingerprint, WorktreeLeafObservation)> {
    fingerprint_worktree_leaf_path_inner(workdir, file, None)
}

/// Bounded-content companion for whole-tree leases. The limit is enforced on
/// bytes actually read, so a file that grows after metadata preflight cannot
/// turn a destructive confirmation into an unbounded stream.
pub(crate) fn fingerprint_worktree_leaf_path_bounded(
    workdir: &Path,
    file: &Path,
    max_regular_bytes: u64,
) -> io::Result<(WorktreeLeafFingerprint, WorktreeLeafObservation)> {
    fingerprint_worktree_leaf_path_inner(workdir, file, Some(max_regular_bytes))
}

fn fingerprint_worktree_leaf_path_inner(
    workdir: &Path,
    file: &Path,
    max_regular_bytes: Option<u64>,
) -> io::Result<(WorktreeLeafFingerprint, WorktreeLeafObservation)> {
    let (parent, name) = match open_parent_path(workdir, file) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok((
                WorktreeLeafFingerprint::Missing,
                WorktreeLeafObservation {
                    metadata: None,
                    symlink_target: None,
                },
            ));
        }
        Err(error) => return Err(error),
    };
    let before = match parent.symlink_metadata(&name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok((
                WorktreeLeafFingerprint::Missing,
                WorktreeLeafObservation {
                    metadata: None,
                    symlink_target: None,
                },
            ));
        }
        Err(error) => return Err(error),
    };

    if before.is_file() {
        let mut opened = open_leaf_nofollow(&parent, &name)?;
        let opened_before = opened.metadata()?;
        if !same_observed_state(&before, &opened_before) {
            return Err(changed_path_while_fingerprinting(file));
        }

        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut total_read = 0u64;
        loop {
            let read = opened.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            total_read = total_read.saturating_add(read as u64);
            if max_regular_bytes.is_some_and(|limit| total_read > limit) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("worktree content exceeded the bounded fingerprint limit: {file:?}"),
                ));
            }
            digest.update(&buffer[..read]);
        }

        let opened_after = opened.metadata()?;
        let current = parent.symlink_metadata(&name)?;
        if !same_observed_state(&opened_before, &opened_after)
            || !same_observed_state(&opened_after, &current)
        {
            return Err(changed_path_while_fingerprinting(file));
        }
        return Ok((
            WorktreeLeafFingerprint::Regular {
                len: current.len(),
                mode: metadata_mode(&current),
                digest: digest.finalize().into(),
            },
            WorktreeLeafObservation {
                metadata: Some(current),
                symlink_target: None,
            },
        ));
    }

    if before.is_symlink() {
        let target = parent.read_link_contents(&name)?;
        let current = parent.symlink_metadata(&name)?;
        if !same_observed_state(&before, &current) {
            return Err(changed_path_while_fingerprinting(file));
        }
        let target = path_bytes(&target);
        return Ok((
            WorktreeLeafFingerprint::Symlink {
                mode: metadata_mode(&current),
                target: target.clone(),
            },
            WorktreeLeafObservation {
                metadata: Some(current),
                symlink_target: Some(target),
            },
        ));
    }

    let kind = if before.is_dir() { 1 } else { 2 };
    Ok((
        WorktreeLeafFingerprint::Other {
            mode: metadata_mode(&before),
            kind,
        },
        WorktreeLeafObservation {
            metadata: Some(before),
            symlink_target: None,
        },
    ))
}

/// Return the logical byte length of a regular leaf without following any
/// ancestor or final-component symlink. Whole-tree destructive previews use
/// this for a bounded-I/O preflight before streaming content fingerprints.
pub(crate) fn worktree_regular_leaf_size_path(
    workdir: &Path,
    file: &Path,
) -> io::Result<Option<u64>> {
    let (parent, name) = match open_parent_path(workdir, file) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    match parent.symlink_metadata(&name) {
        Ok(metadata) if metadata.is_file() => Ok(Some(metadata.len())),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Check whether a worktree leaf is absent without following any ancestor or
/// final-component symlink. This is intentionally metadata-only so cleanup
/// verification cannot stream a concurrently recreated large file.
pub(crate) fn worktree_leaf_is_missing_path(workdir: &Path, file: &Path) -> io::Result<bool> {
    let (parent, name) = match open_parent_path(workdir, file) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };
    match parent.symlink_metadata(&name) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error),
    }
}

/// Confirm that a previously fingerprinted path still names the same leaf and
/// retains its cheap metadata/target state. This deliberately does not reread
/// regular-file content; it runs after all expensive hashing so no large delay
/// remains between this final coherence check and the destructive subprocess.
pub(crate) fn validate_worktree_leaf_observation(
    workdir: &Path,
    file: &str,
    expected: &WorktreeLeafObservation,
) -> io::Result<bool> {
    validate_worktree_leaf_observation_path(workdir, Path::new(file), expected)
}

/// Path-native companion to [`fingerprint_worktree_leaf_path`].
pub(crate) fn validate_worktree_leaf_observation_path(
    workdir: &Path,
    file: &Path,
    expected: &WorktreeLeafObservation,
) -> io::Result<bool> {
    let (parent, name) = match open_parent_path(workdir, file) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(expected.metadata.is_none());
        }
        Err(error) => return Err(error),
    };
    let current = match parent.symlink_metadata(&name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(expected.metadata.is_none());
        }
        Err(error) => return Err(error),
    };
    let Some(metadata) = expected.metadata.as_ref() else {
        return Ok(false);
    };
    if !same_observed_state(metadata, &current) {
        return Ok(false);
    }
    if let Some(expected_target) = expected.symlink_target.as_ref() {
        if !current.is_symlink() {
            return Ok(false);
        }
        return parent
            .read_link_contents(&name)
            .map(|target| path_bytes(&target) == *expected_target);
    }
    Ok(true)
}

/// Existence + path-safety probe for a worktree leaf using no-follow semantics,
/// WITHOUT digesting its contents — for callers like Reveal that only need to
/// know a safe leaf is present, not a content fingerprint. `Ok(false)` means the
/// leaf is absent; a symlinked ancestor (or other unsafe open) surfaces as `Err`,
/// exactly like [`fingerprint_worktree_leaf`].
pub(crate) fn worktree_leaf_exists_nofollow(workdir: &Path, file: &str) -> io::Result<bool> {
    let (parent, name) = open_parent_path(workdir, Path::new(file))?;
    match parent.symlink_metadata(&name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}
