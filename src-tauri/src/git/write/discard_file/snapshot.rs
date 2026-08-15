//! The snapshot a discard is leased against: the index/worktree state it
//! captures, and the semantic view of that state the confirm compares.

use super::super::state_lease::hash_field;
use super::hash::hash_worktree_fingerprint;
use super::hooks::run_discard_capture_test_hook;
use super::semantics::capture_discard_semantics;
use std::path::PathBuf;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};

use crate::git::worktree_fs::{
    fingerprint_worktree_leaf, validate_worktree_leaf_observation, WorktreeLeafObservation,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum IndexPathState {
    Missing,
    IntentToAdd,
    Present,
}

pub(super) struct DiscardSnapshot {
    pub(super) expected_state: String,
    pub(super) workdir: PathBuf,
    pub(super) in_head: bool,
    pub(super) index_state: IndexPathState,
}

pub(super) struct DiscardSemanticSnapshot {
    pub(super) signature: [u8; 32],
    pub(super) workdir: PathBuf,
    pub(super) in_head: bool,
    pub(super) index_state: IndexPathState,
}

pub(super) fn capture_discard_snapshot(
    repo: &str,
    file: &str,
    previous_file: Option<&str>,
    staged: bool,
) -> Result<DiscardSnapshot, String> {
    let previous_file = previous_file.filter(|previous| *previous != file);
    let initial = capture_discard_semantics(repo, file, previous_file, staged)?;

    let mut state = Sha256::new();
    hash_field(&mut state, b"gitlane-discard-v1");
    hash_field(&mut state, &initial.signature);
    let involved = previous_file.into_iter().chain(std::iter::once(file));
    let mut observations: Vec<(&str, WorktreeLeafObservation)> = Vec::new();
    for path in involved.clone() {
        hash_field(&mut state, path.as_bytes());
        let (fingerprint, observation) = fingerprint_worktree_leaf(&initial.workdir, path)
            .map_err(|error| format!("Could not inspect {path} before discarding it: {error}"))?;
        hash_worktree_fingerprint(&mut state, fingerprint, path)?;
        observations.push((path, observation));
    }

    run_discard_capture_test_hook();

    // Status/index/HEAD may change while a large worktree file is streamed.
    // Recompute their path-local semantic signature after content capture, and
    // use this fresh capture for the mutation branch as well as the token.
    let fresh = capture_discard_semantics(repo, file, previous_file, staged)?;
    if fresh.signature != initial.signature {
        return Err(format!(
            "Changes to {file} changed while GitLane was inspecting them. Refresh and try again."
        ));
    }

    // Recheck every pathname only after all slow work. A rename's first path
    // therefore cannot change unnoticed while the second path is being hashed.
    for (path, observation) in &observations {
        let unchanged = validate_worktree_leaf_observation(&fresh.workdir, path, observation)
            .map_err(|error| format!("Could not recheck {path} before discarding it: {error}"))?;
        if !unchanged {
            return Err(format!(
                "Changes to {file} changed while GitLane was inspecting them. Refresh and try again."
            ));
        }
    }

    Ok(DiscardSnapshot {
        expected_state: format!("v1:{}", URL_SAFE_NO_PAD.encode(state.finalize())),
        workdir: fresh.workdir,
        in_head: fresh.in_head,
        index_state: fresh.index_state,
    })
}
