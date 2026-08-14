//! Taking the snapshot the confirm holds, and re-taking it at the mutation
//! boundary so nothing that moved in between goes unnoticed.

use super::fingerprint::{
    capture_index_digest, effective_tree_oid_no_replace, fingerprint_with_budget, hash_identity,
    read_status, ParsedStatus,
};
use super::hooks::{run_after_fingerprint_test_hook, run_capture_test_hook};
use super::obstructions::{case_insensitive_paths, target_obstruction_paths};
use super::scope::{
    discover_scope, effective_head_tree_oid, ensure_no_replace_refs, fingerprint_into, git_path,
    head_state, ValidatedScope, STALE_MESSAGE, UNVERIFIABLE_MESSAGE,
};
use std::collections::BTreeMap;
use std::path::Path;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};

use crate::git::worktree_fs::{validate_worktree_leaf_observation_path, WorktreeLeafObservation};

use super::super::state_lease::{
    hash_field, hash_os, path_label, RepositoryScope, MAX_FINGERPRINT_BYTES,
};

struct HardResetSnapshot {
    expected_state: String,
    expected_head_branch: Option<String>,
    expected_head_oid: Option<String>,
    target_oid: String,
    /// The scope this snapshot was taken in, kept so the mutation can be routed
    /// through the very scope that was validated — see [`ValidatedScope`].
    scope: RepositoryScope,
    /// Cheap per-leaf metadata, by raw git path. Not hashed into the token —
    /// consumed by [`validate_observations`] to close the intra-capture window.
    observations: BTreeMap<Vec<u8>, WorktreeLeafObservation>,
}

/// Recheck every fingerprinted leaf's cheap metadata after the content pass.
///
/// Mirrors `discard_all`'s check of the same name, and runs at the same two
/// points: the end of the stable preview capture, and the mutation boundary. It
/// rereads no content, so almost no delay remains between it and the destructive
/// subprocess — that is the whole point (GL-302 review).
fn validate_observations(snapshot: &HardResetSnapshot) -> Result<(), String> {
    for (raw_path, observation) in &snapshot.observations {
        let path = git_path(raw_path)?;
        if !validate_worktree_leaf_observation_path(
            &snapshot.scope.workdir,
            Path::new(&path),
            observation,
        )
        .map_err(|error| {
            format!(
                "Could not recheck {} before hard reset: {error}",
                path_label(&path)
            )
        })? {
            return Err(STALE_MESSAGE.to_string());
        }
    }
    Ok(())
}

fn capture_once(repo: &str, target_oid: &str) -> Result<HardResetSnapshot, String> {
    let (repository, scope) = discover_scope(repo)?;
    ensure_no_replace_refs(&scope)?;
    let (expected_head_branch, expected_head_oid) = head_state(&repository)?;
    let expected_head_tree_oid = effective_head_tree_oid(&scope, expected_head_oid.as_deref())?;
    let target_tree_oid = effective_tree_oid_no_replace(&scope, target_oid)?;
    let index_digest = capture_index_digest(&repository)?;
    let ParsedStatus {
        semantic_records,
        dirty_paths,
    } = read_status(&scope)?;
    let case_insensitive = case_insensitive_paths(&repository);
    let obstruction_paths = target_obstruction_paths(&scope, target_oid, case_insensitive)?;

    let mut remaining_bytes = MAX_FINGERPRINT_BYTES;
    let mut fingerprints = BTreeMap::new();
    let mut observations = BTreeMap::new();
    for raw_path in dirty_paths.iter().chain(obstruction_paths.iter()) {
        if fingerprints.contains_key(raw_path) {
            continue;
        }
        let path = git_path(raw_path)?;
        let (fingerprint, observation) =
            fingerprint_with_budget(&scope.workdir, &path, &mut remaining_bytes)?;
        fingerprints.insert(raw_path.clone(), fingerprint);
        observations.insert(raw_path.clone(), observation);
    }
    run_after_fingerprint_test_hook();

    let mut full = Sha256::new();
    hash_field(&mut full, b"gitlane-hard-reset-v2");
    hash_os(&mut full, scope.workdir.as_os_str());
    hash_os(&mut full, scope.gitdir.as_os_str());
    hash_os(&mut full, scope.commondir.as_os_str());
    hash_identity(&mut full, &scope.workdir_identity);
    hash_identity(&mut full, &scope.gitdir_identity);
    hash_identity(&mut full, &scope.commondir_identity);
    full.update([u8::from(scope.is_worktree)]);
    // Flipping core.ignorecase changes which paths count as obstructions, so it
    // belongs in the token: the preview expires rather than silently leasing a
    // different set than the write would compute.
    full.update([u8::from(case_insensitive)]);
    match &expected_head_branch {
        Some(branch) => {
            full.update([1]);
            hash_field(&mut full, branch.as_bytes());
        }
        None => full.update([0]),
    }
    match &expected_head_oid {
        Some(oid) => {
            full.update([1]);
            hash_field(&mut full, oid.as_bytes());
        }
        None => full.update([0]),
    }
    match &expected_head_tree_oid {
        Some(oid) => {
            full.update([1]);
            hash_field(&mut full, oid.as_bytes());
        }
        None => full.update([0]),
    }
    hash_field(&mut full, target_tree_oid.as_bytes());
    full.update(index_digest);
    full.update((semantic_records.len() as u64).to_le_bytes());
    for record in &semantic_records {
        hash_field(&mut full, record);
    }
    full.update((obstruction_paths.len() as u64).to_le_bytes());
    for raw_path in &obstruction_paths {
        hash_field(&mut full, raw_path);
    }
    full.update((fingerprints.len() as u64).to_le_bytes());
    for (raw_path, fingerprint) in &fingerprints {
        hash_field(&mut full, raw_path);
        let label = String::from_utf8_lossy(raw_path);
        fingerprint_into(&mut full, fingerprint, &label)?;
    }
    hash_field(&mut full, target_oid.as_bytes());

    Ok(HardResetSnapshot {
        expected_state: format!("v2:{}", URL_SAFE_NO_PAD.encode(full.finalize())),
        expected_head_branch,
        expected_head_oid,
        target_oid: target_oid.to_string(),
        scope,
        observations,
    })
}

fn capture_stable(repo: &str, target_oid: &str) -> Result<HardResetSnapshot, String> {
    let initial = capture_once(repo, target_oid)?;
    run_capture_test_hook();
    let fresh = capture_once(repo, target_oid)?;
    if initial.expected_state != fresh.expected_state
        || initial.expected_head_branch != fresh.expected_head_branch
        || initial.expected_head_oid != fresh.expected_head_oid
        || initial.target_oid != fresh.target_oid
    {
        return Err(
            "The repository changed while GitLane was preparing the hard-reset preview. Try again."
                .to_string(),
        );
    }
    validate_observations(&fresh)?;
    Ok(fresh)
}

/// Capture the opaque exact-state lease shown by a hard-reset confirmation.
pub(in crate::git::write) fn capture(
    repo: &str,
    target_oid: &str,
) -> Result<(String, Option<String>, Option<String>), String> {
    let snapshot = capture_stable(repo, target_oid)?;
    Ok((
        snapshot.expected_state,
        snapshot.expected_head_branch,
        snapshot.expected_head_oid,
    ))
}

/// Hard reset leases the already-checked-out worktree. Reject a named source
/// that is not HEAD so preview cannot describe one branch while fingerprinting
/// another (GL-302 review).
pub(in crate::git::write) fn ensure_source_is_checked_out(
    repo: &str,
    source: &str,
) -> Result<(), String> {
    if source == "HEAD" {
        return Ok(());
    }
    match super::super::head::current_branch(repo) {
        Some(branch) if branch == source => Ok(()),
        _ => Err(format!(
            "Hard reset requires '{source}' to already be checked out. Check it out, then preview again."
        )),
    }
}

/// Re-capture and reject any drift immediately before `git reset --hard`.
/// Callers must finish tip/HEAD preparation first so this sits at the mutation
/// boundary (GL-302 review).
///
/// Only a *mismatch* proves the preview expired; a failed re-capture reports
/// [`UNVERIFIABLE_MESSAGE`] with the underlying cause instead, since it may be a
/// scope retarget (real drift) or an unreadable index (not drift at all).
///
/// Returns the [`ValidatedScope`] the check ran in — the caller must mutate
/// through it rather than through the repo path it started from.
pub(in crate::git::write) fn validate_at_mutation_boundary(
    repo: &str,
    target_oid: &str,
    expected_state: &str,
    expected_head_branch: Option<&str>,
    expected_head_oid: Option<&str>,
) -> Result<ValidatedScope, String> {
    let snapshot = capture_once(repo, target_oid)
        .map_err(|error| format!("{UNVERIFIABLE_MESSAGE} {error}"))?;
    if snapshot.expected_state != expected_state
        || snapshot.expected_head_branch.as_deref() != expected_head_branch
        || snapshot.expected_head_oid.as_deref() != expected_head_oid
        || snapshot.target_oid != target_oid
    {
        return Err(STALE_MESSAGE.to_string());
    }
    // Last, and deliberately cheap: rereads no content, so the gap between this
    // and `git reset --hard` stays as small as it can without a worktree lock.
    validate_observations(&snapshot)?;
    Ok(ValidatedScope(snapshot.scope))
}
