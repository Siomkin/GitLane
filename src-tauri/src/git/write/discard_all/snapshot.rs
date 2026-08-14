//! The exact-state lease itself: what the confirmation captured, and the
//! re-captures the write validates against before it mutates anything.
//!
//! `capture_once` reads the repository under one observation; `capture_stable`
//! runs it exactly twice and fails unless both reads agree, so a worktree
//! changing under the user cannot produce a lease that never existed.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};

use crate::git::worktree_fs::{validate_worktree_leaf_observation_path, WorktreeLeafFingerprint};

use super::super::state_lease::{hash_field, hash_os, path_label, MAX_FINGERPRINT_BYTES};
use super::fingerprint::{
    capture_tracked_digest, digest_tracked_from_captured, enforce_fingerprint_budget,
    fingerprint_with_budget,
};
use super::hooks::run_capture_test_hook;
use super::index::capture_index;
use super::nested::nested_repository_root;
use super::status::{read_status, untracked_paths};
use super::{
    command_repo, discover_scope, effective_head_tree_oid, ensure_no_replace_refs,
    fingerprint_into, git_bytes, git_path, head_state, validate_repository_scope, CleanupKind,
    CleanupLeaf, DiscardAllSnapshot, TrackedDigestContext, STALE_MESSAGE,
};

pub(super) fn validate_head_lease(snapshot: &DiscardAllSnapshot) -> Result<(), String> {
    let (repository, current_scope) = discover_scope(command_repo(&snapshot.scope)?)?;
    if current_scope != snapshot.scope {
        return Err(STALE_MESSAGE.to_string());
    }
    ensure_no_replace_refs(&snapshot.scope)?;
    let (branch, oid) = head_state(&repository)?;
    let tree_oid = effective_head_tree_oid(&snapshot.scope, oid.as_deref())?;
    if branch != snapshot.expected_head_branch
        || oid != snapshot.expected_head_oid
        || tree_oid != snapshot.expected_head_tree_oid
    {
        return Err(STALE_MESSAGE.to_string());
    }
    Ok(())
}

pub(super) fn capture_once(repo: &str) -> Result<DiscardAllSnapshot, String> {
    let (repository, scope) = discover_scope(repo)?;
    ensure_no_replace_refs(&scope)?;
    let status = read_status(&scope)?;
    let index = capture_index(&repository)?;
    let (expected_head_branch, expected_head_oid) = head_state(&repository)?;
    if expected_head_oid.is_none() {
        return Err(
            "Discard all is unavailable before the first commit because there is no committed tree to restore. Unstage or remove files individually, or use the terminal."
                .to_string(),
        );
    }
    let expected_head_tree_oid = effective_head_tree_oid(&scope, expected_head_oid.as_deref())?;

    let mut cleanup_by_path: BTreeMap<Vec<u8>, (OsString, CleanupKind)> = BTreeMap::new();
    let reported_untracked = untracked_paths(&scope)?;
    let mut nested_roots = BTreeMap::new();
    for path in &reported_untracked {
        if let Some(root) = nested_repository_root(&scope.workdir, path) {
            nested_roots.insert(git_bytes(&root)?, root);
        }
    }
    for raw_path in &status.tracked_paths {
        let path = git_path(raw_path)?;
        if let Some(root) = nested_repository_root(&scope.workdir, &path) {
            nested_roots.insert(git_bytes(&root)?, root);
        }
    }
    let preserved_nested_repos = nested_roots.values().cloned().collect::<Vec<_>>();
    for raw_path in &status.tracked_paths {
        let path = git_path(raw_path)?;
        if let Some(root) = preserved_nested_repos
            .iter()
            .find(|root| Path::new(&path).starts_with(Path::new(root)))
        {
            return Err(format!(
                "Nested Git repository {} has staged or tracked parent-repository changes. Refusing Discard all because a global tracked-tree restore could damage it; unstage or move it outside this worktree first.",
                path_label(root)
            ));
        }
    }
    for path in reported_untracked {
        if preserved_nested_repos
            .iter()
            .any(|root| Path::new(&path).starts_with(Path::new(root)))
        {
            continue;
        }
        cleanup_by_path.insert(git_bytes(&path)?, (path, CleanupKind::Ordinary));
    }
    let cleanup_raw = cleanup_by_path.keys().cloned().collect::<BTreeSet<_>>();
    let inspection_paths = status
        .tracked_paths
        .iter()
        .map(|path| git_path(path))
        .chain(cleanup_by_path.values().map(|(path, _)| Ok(path.clone())))
        .collect::<Result<Vec<_>, String>>()?;
    enforce_fingerprint_budget(&scope.workdir, inspection_paths)?;
    let mut remaining_bytes = MAX_FINGERPRINT_BYTES;
    let digest_context = TrackedDigestContext {
        scope: &scope,
        head_branch: expected_head_branch.as_deref(),
        head_oid: expected_head_oid.as_deref(),
        head_tree_oid: expected_head_tree_oid.as_deref(),
        index: &index,
        status: &status,
    };
    let tracked_capture = capture_tracked_digest(
        &digest_context,
        &BTreeSet::new(),
        false,
        &mut remaining_bytes,
    )?;
    let stage_zero_paths = index
        .stage_zero_paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    for raw_path in &status.tracked_paths {
        if stage_zero_paths.contains(raw_path) || cleanup_raw.contains(raw_path) {
            continue;
        }
        let (fingerprint, _) = tracked_capture.fingerprints.get(raw_path).ok_or_else(|| {
            format!(
                "Could not inspect the staged deletion at {}.",
                String::from_utf8_lossy(raw_path)
            )
        })?;
        if !matches!(fingerprint, WorktreeLeafFingerprint::Missing) {
            return Err(format!(
                "{} is staged for deletion but currently contains an ignored or otherwise unapproved replacement. Remove or preserve that replacement manually before using Discard all.",
                path_label(&git_path(raw_path)?)
            ));
        }
    }
    let tracked_state = tracked_capture.digest;
    let post_cleanup_tracked_state = if cleanup_raw
        .iter()
        .any(|path| status.tracked_paths.contains(path))
    {
        digest_tracked_from_captured(&digest_context, &cleanup_raw, &tracked_capture.fingerprints)?
    } else {
        tracked_state
    };

    let mut full = Sha256::new();
    hash_field(&mut full, b"gitlane-discard-all-v1");
    hash_field(&mut full, &tracked_state);
    hash_field(&mut full, &post_cleanup_tracked_state);
    full.update((cleanup_by_path.len() as u64).to_le_bytes());
    let mut cleanup = Vec::with_capacity(cleanup_by_path.len());
    for (raw_path, (path, kind)) in cleanup_by_path {
        hash_os(&mut full, &path);
        full.update([match kind {
            CleanupKind::Ordinary => 0,
        }]);
        let observation = match tracked_capture.fingerprints.get(&raw_path) {
            Some((fingerprint, observation)) => {
                fingerprint_into(&mut full, fingerprint, &path_label(&path))?;
                Arc::clone(observation)
            }
            None => {
                let (fingerprint, observation) = fingerprint_with_budget(
                    &scope.workdir,
                    &path,
                    &mut remaining_bytes,
                    &format!(
                        "Could not inspect removable path {} before discarding",
                        path_label(&path)
                    ),
                )?;
                fingerprint_into(&mut full, &fingerprint, &path_label(&path))?;
                Arc::new(observation)
            }
        };
        cleanup.push(CleanupLeaf {
            path,
            kind,
            observation,
        });
    }
    full.update((preserved_nested_repos.len() as u64).to_le_bytes());
    for path in &preserved_nested_repos {
        hash_os(&mut full, path);
    }
    let mut display_status = Vec::new();
    for entry in &status.display {
        let mut protected = false;
        for raw_path in &entry.paths {
            let path = git_path(raw_path)?;
            if preserved_nested_repos
                .iter()
                .any(|root| Path::new(&path).starts_with(Path::new(root)))
            {
                protected = true;
                break;
            }
        }
        if !protected {
            display_status.push(entry.label.clone());
        }
    }
    Ok(DiscardAllSnapshot {
        expected_state: format!("v1:{}", URL_SAFE_NO_PAD.encode(full.finalize())),
        tracked_state,
        post_cleanup_tracked_state,
        scope,
        expected_head_branch,
        expected_head_oid,
        expected_head_tree_oid,
        cleanup,
        tracked: tracked_capture.observations,
        tracked_fingerprints: tracked_capture.fingerprints,
        preserved_nested_repos,
        display_status,
    })
}

pub(super) fn validate_observations(snapshot: &DiscardAllSnapshot) -> Result<(), String> {
    validate_repository_scope(&snapshot.scope)?;
    for leaf in &snapshot.tracked {
        if !validate_worktree_leaf_observation_path(
            &snapshot.scope.workdir,
            Path::new(&leaf.path),
            &leaf.observation,
        )
        .map_err(|error| {
            format!(
                "Could not recheck tracked path {}: {error}",
                path_label(&leaf.path)
            )
        })? {
            return Err(STALE_MESSAGE.to_string());
        }
    }
    for leaf in &snapshot.cleanup {
        if !validate_worktree_leaf_observation_path(
            &snapshot.scope.workdir,
            Path::new(&leaf.path),
            &leaf.observation,
        )
        .map_err(|error| {
            format!(
                "Could not recheck removable path {}: {error}",
                path_label(&leaf.path)
            )
        })? {
            return Err(STALE_MESSAGE.to_string());
        }
    }
    Ok(())
}

pub(super) fn capture_stable(repo: &str) -> Result<DiscardAllSnapshot, String> {
    let initial = capture_once(repo)?;
    run_capture_test_hook();
    let fresh = capture_once(repo)?;
    if initial.expected_state != fresh.expected_state {
        return Err(
            "The working tree changed while GitLane was preparing the discard preview. Try again."
                .to_string(),
        );
    }
    validate_observations(&fresh)?;
    Ok(fresh)
}
