//! Recapturing the tracked side of the lease after confirmation, and again
//! after untracked cleanup, before the captured tree is restored.

use std::collections::BTreeSet;
use std::path::Path;

use crate::git::worktree_fs::validate_worktree_leaf_observation_path;

use super::super::state_lease::{path_label, RepositoryScope, MAX_FINGERPRINT_BYTES};
use super::fingerprint::{
    capture_tracked_digest, digest_tracked_from_captured, enforce_fingerprint_budget,
};
use super::index::capture_index;
use super::nested::reject_tracked_paths_in_nested_repositories;
use super::snapshot::validate_observations;
use super::status::read_status;
use super::{
    command_repo, discover_scope, effective_head_tree_oid, git_path, head_state,
    DiscardAllSnapshot, TrackedCapture, TrackedDigestContext, STALE_MESSAGE,
};

pub(super) fn capture_current_tracked_from_snapshot_once(
    snapshot: &DiscardAllSnapshot,
) -> Result<[u8; 32], String> {
    let (repository, scope) = discover_scope(command_repo(&snapshot.scope)?)?;
    if scope != snapshot.scope {
        return Err(STALE_MESSAGE.to_string());
    }
    let status = read_status(&scope)?;
    reject_tracked_paths_in_nested_repositories(&scope.workdir, &status)?;
    let index = capture_index(&repository)?;
    let (branch, oid) = head_state(&repository)?;
    let tree_oid = effective_head_tree_oid(&scope, oid.as_deref())?;
    validate_observations(snapshot)?;
    reject_tracked_paths_in_nested_repositories(&scope.workdir, &status)?;
    let digest_context = TrackedDigestContext {
        scope: &scope,
        head_branch: branch.as_deref(),
        head_oid: oid.as_deref(),
        head_tree_oid: tree_oid.as_deref(),
        index: &index,
        status: &status,
    };
    digest_tracked_from_captured(
        &digest_context,
        &BTreeSet::new(),
        &snapshot.tracked_fingerprints,
    )
}

pub(super) fn capture_current_tracked_from_snapshot(
    snapshot: &DiscardAllSnapshot,
) -> Result<[u8; 32], String> {
    let initial = capture_current_tracked_from_snapshot_once(snapshot)?;
    let fresh = capture_current_tracked_from_snapshot_once(snapshot)?;
    if initial != fresh {
        return Err(
            "Tracked state changed while GitLane was rechecking it; tracked edits were preserved."
                .to_string(),
        );
    }
    Ok(fresh)
}

pub(super) fn capture_current_tracked_once(
    expected_scope: &RepositoryScope,
    normalized_missing: &BTreeSet<Vec<u8>>,
) -> Result<[u8; 32], String> {
    let (repository, scope) = discover_scope(command_repo(expected_scope)?)?;
    if scope != *expected_scope {
        return Err(STALE_MESSAGE.to_string());
    }
    let status = read_status(&scope)?;
    reject_tracked_paths_in_nested_repositories(&scope.workdir, &status)?;
    let index = capture_index(&repository)?;
    let (branch, oid) = head_state(&repository)?;
    let tree_oid = effective_head_tree_oid(&scope, oid.as_deref())?;
    let inspection_paths = status
        .tracked_paths
        .iter()
        .map(|path| git_path(path))
        .collect::<Result<Vec<_>, String>>()?;
    enforce_fingerprint_budget(&scope.workdir, inspection_paths)?;
    let mut remaining_bytes = MAX_FINGERPRINT_BYTES;
    let TrackedCapture {
        digest,
        observations,
        ..
    } = capture_tracked_digest(
        &TrackedDigestContext {
            scope: &scope,
            head_branch: branch.as_deref(),
            head_oid: oid.as_deref(),
            head_tree_oid: tree_oid.as_deref(),
            index: &index,
            status: &status,
        },
        normalized_missing,
        !normalized_missing.is_empty(),
        &mut remaining_bytes,
    )?;
    for leaf in observations {
        if !validate_worktree_leaf_observation_path(
            &scope.workdir,
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
    reject_tracked_paths_in_nested_repositories(&scope.workdir, &status)?;
    Ok(digest)
}

pub(super) fn capture_current_tracked(
    expected_scope: &RepositoryScope,
    normalized_missing: &BTreeSet<Vec<u8>>,
) -> Result<[u8; 32], String> {
    let initial = capture_current_tracked_once(expected_scope, normalized_missing)?;
    let fresh = capture_current_tracked_once(expected_scope, normalized_missing)?;
    if initial != fresh {
        return Err(
            "Tracked state changed while GitLane was rechecking it; tracked edits were preserved."
                .to_string(),
        );
    }
    Ok(fresh)
}
