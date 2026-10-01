//! Index capture for the discard-all lease: the stage-zero path list and digest
//! the confirmation pins before any cleanup.

use git2::Repository;

use super::super::state_lease::index_digest;
use super::{describe_lease_error, IndexSnapshot};

pub(super) fn capture_index(repository: &Repository) -> Result<IndexSnapshot, String> {
    let (digest, stage_zero_paths) =
        index_digest(repository, b"gitlane-discard-all-index-v1").map_err(describe_lease_error)?;
    Ok(IndexSnapshot {
        digest,
        stage_zero_paths,
    })
}
