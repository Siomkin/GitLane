//! Content fingerprinting for the tracked side of the lease: the byte budget
//! that bounds how much a capture will read, and the SHA-256 digest that pins
//! the tracked working-tree state the confirmation was shown.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::git::worktree_fs::{
    fingerprint_worktree_leaf_path_bounded, worktree_regular_leaf_size_path,
    WorktreeLeafFingerprint, WorktreeLeafObservation,
};

use super::super::state_lease::{hash_field, hash_os, path_label, MAX_FINGERPRINT_BYTES};
use super::{
    fingerprint_into, git_bytes, git_path, TrackedCapture, TrackedDigestContext, TrackedLeaf,
    STALE_MESSAGE,
};

pub(super) fn enforce_fingerprint_budget(
    workdir: &Path,
    paths: impl IntoIterator<Item = OsString>,
) -> Result<(), String> {
    let mut unique = BTreeMap::new();
    for path in paths {
        unique.insert(git_bytes(&path)?, path);
    }
    let mut total = 0u64;
    for path in unique.values() {
        let size = worktree_regular_leaf_size_path(workdir, Path::new(path)).map_err(|error| {
            format!(
                "Could not inspect the size of {} before discarding: {error}",
                path_label(path)
            )
        })?;
        if let Some(size) = size {
            total = total.checked_add(size).ok_or_else(|| {
                "Discard all safety inspection size overflowed; use the terminal for this repository state."
                    .to_string()
            })?;
            if total > MAX_FINGERPRINT_BYTES {
                return Err(format!(
                    "Discard all would need to fingerprint more than {} MiB of changed or removable file content. Use the terminal for this unusually large repository state.",
                    MAX_FINGERPRINT_BYTES / (1024 * 1024)
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn fingerprint_with_budget(
    workdir: &Path,
    path: &OsStr,
    remaining_bytes: &mut u64,
    context: &str,
) -> Result<(WorktreeLeafFingerprint, WorktreeLeafObservation), String> {
    let (fingerprint, observation) =
        fingerprint_worktree_leaf_path_bounded(workdir, Path::new(path), *remaining_bytes)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::InvalidData {
                    format!(
                        "Discard all exceeded its {} MiB content-fingerprint limit while inspecting {}. Use the terminal for this unusually large or actively growing repository state.",
                        MAX_FINGERPRINT_BYTES / (1024 * 1024),
                        path_label(path)
                    )
                } else {
                    format!("{context}: {error}")
                }
            })?;
    if let WorktreeLeafFingerprint::Regular { len, .. } = &fingerprint {
        #[cfg(test)]
        super::hooks::DISCARD_ALL_FINGERPRINT_BYTES_TEST.with(|count| {
            if let Some(current) = count.get() {
                count.set(Some(current.saturating_add(*len)));
            }
        });
        *remaining_bytes = remaining_bytes.checked_sub(*len).ok_or_else(|| {
            format!(
                "Discard all exceeded its {} MiB content-fingerprint limit while inspecting {}. Use the terminal for this unusually large repository state.",
                MAX_FINGERPRINT_BYTES / (1024 * 1024),
                path_label(path)
            )
        })?;
    }
    Ok((fingerprint, observation))
}

pub(super) fn begin_tracked_digest(context: &TrackedDigestContext<'_>) -> Sha256 {
    let TrackedDigestContext {
        scope,
        head_branch,
        head_oid,
        head_tree_oid,
        index,
        status,
    } = context;
    let mut state = Sha256::new();
    hash_field(&mut state, b"gitlane-discard-all-tracked-v1");
    hash_os(&mut state, scope.workdir.as_os_str());
    hash_os(&mut state, scope.gitdir.as_os_str());
    hash_os(&mut state, scope.commondir.as_os_str());
    scope.workdir_identity.hash_into(&mut state);
    scope.gitdir_identity.hash_into(&mut state);
    scope.commondir_identity.hash_into(&mut state);
    state.update([u8::from(scope.is_worktree)]);
    match head_branch {
        Some(branch) => {
            state.update([1]);
            hash_field(&mut state, branch.as_bytes());
        }
        None => state.update([0]),
    }
    match head_oid {
        Some(oid) => {
            state.update([1]);
            hash_field(&mut state, oid.as_bytes());
        }
        None => state.update([0]),
    }
    match head_tree_oid {
        Some(oid) => {
            state.update([1]);
            hash_field(&mut state, oid.as_bytes());
        }
        None => state.update([0]),
    }
    hash_field(&mut state, &index.digest);
    let tracked_records = status
        .semantic_records
        .iter()
        .filter(|record| !record.starts_with(b"?? ") && !record.starts_with(b"!! "))
        .collect::<Vec<_>>();
    state.update((tracked_records.len() as u64).to_le_bytes());
    for record in tracked_records {
        hash_field(&mut state, record);
    }
    state.update((status.tracked_paths.len() as u64).to_le_bytes());
    state
}

pub(super) fn capture_tracked_digest(
    context: &TrackedDigestContext<'_>,
    normalized_missing: &BTreeSet<Vec<u8>>,
    verify_normalized_missing: bool,
    remaining_bytes: &mut u64,
) -> Result<TrackedCapture, String> {
    let mut state = begin_tracked_digest(context);
    let mut observations = Vec::new();
    let mut fingerprints = BTreeMap::new();
    for raw_path in &context.status.tracked_paths {
        hash_field(&mut state, raw_path);
        let path = git_path(raw_path)?;
        if normalized_missing.contains(raw_path) {
            if verify_normalized_missing {
                let (fingerprint, observation) = fingerprint_with_budget(
                    &context.scope.workdir,
                    &path,
                    remaining_bytes,
                    &format!(
                        "Could not inspect cleaned path {} before reset",
                        path_label(&path)
                    ),
                )?;
                if !matches!(&fingerprint, WorktreeLeafFingerprint::Missing) {
                    return Err(format!(
                        "Approved cleanup path {} was recreated before reset; the newer file was preserved.",
                        path_label(&path)
                    ));
                }
                let observation = Arc::new(observation);
                fingerprints.insert(raw_path.clone(), (fingerprint, Arc::clone(&observation)));
                observations.push(TrackedLeaf { path, observation });
            }
            state.update([0]);
            continue;
        }
        let (fingerprint, observation) = fingerprint_with_budget(
            &context.scope.workdir,
            &path,
            remaining_bytes,
            &format!("Could not inspect {} before discarding", path_label(&path)),
        )?;
        fingerprint_into(&mut state, &fingerprint, &path_label(&path))?;
        let observation = Arc::new(observation);
        fingerprints.insert(raw_path.clone(), (fingerprint, Arc::clone(&observation)));
        observations.push(TrackedLeaf { path, observation });
    }
    Ok(TrackedCapture {
        digest: state.finalize().into(),
        observations,
        fingerprints,
    })
}

pub(super) fn digest_tracked_from_captured(
    context: &TrackedDigestContext<'_>,
    normalized_missing: &BTreeSet<Vec<u8>>,
    fingerprints: &BTreeMap<Vec<u8>, (WorktreeLeafFingerprint, Arc<WorktreeLeafObservation>)>,
) -> Result<[u8; 32], String> {
    let mut state = begin_tracked_digest(context);
    for raw_path in &context.status.tracked_paths {
        hash_field(&mut state, raw_path);
        if normalized_missing.contains(raw_path) {
            state.update([0]);
            continue;
        }
        let (fingerprint, _) = fingerprints
            .get(raw_path)
            .ok_or_else(|| STALE_MESSAGE.to_string())?;
        fingerprint_into(&mut state, fingerprint, &path_label(&git_path(raw_path)?))?;
    }
    Ok(state.finalize().into())
}
