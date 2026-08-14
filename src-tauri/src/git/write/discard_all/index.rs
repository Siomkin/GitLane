//! Index capture for the discard-all lease: the stage-zero path list and digest
//! the confirmation pins before any cleanup.

use git2::{IndexEntryExtendedFlag, IndexEntryFlag, Repository};
use sha2::{Digest, Sha256};

use super::super::state_lease::hash_field;
use super::IndexSnapshot;

pub(super) fn capture_index(repository: &Repository) -> Result<IndexSnapshot, String> {
    let index = repository
        .index()
        .map_err(|error| format!("Could not inspect the index before discarding: {error}"))?;
    let mut state = Sha256::new();
    hash_field(&mut state, b"gitlane-discard-all-index-v1");
    let mut stage_zero_paths = Vec::new();
    let mut count = 0u64;
    for entry in index.iter() {
        count += 1;
        let flags = IndexEntryFlag::from_bits_truncate(entry.flags);
        let extended = IndexEntryExtendedFlag::from_bits_truncate(entry.flags_extended);
        if flags.is_valid() {
            return Err(format!(
                "{} is marked assume-unchanged. Clear that index flag before using Discard all.",
                String::from_utf8_lossy(&entry.path)
            ));
        }
        if extended.is_skip_worktree() {
            return Err(format!(
                "{} is marked skip-worktree (or belongs to a sparse index). Disable sparse/skip-worktree state before using Discard all.",
                String::from_utf8_lossy(&entry.path)
            ));
        }
        let stage = ((entry.flags >> 12) & 0x3) as u8;
        if stage != 0 {
            return Err(
                "Conflicted index entries are present. Resolve or abort the operation before using Discard all."
                    .to_string(),
            );
        }
        stage_zero_paths.push(entry.path.clone());
        hash_field(&mut state, &entry.path);
        state.update(entry.id.as_bytes());
        state.update(entry.mode.to_le_bytes());
        state.update(entry.flags.to_le_bytes());
        state.update(entry.flags_extended.to_le_bytes());
    }
    state.update(count.to_le_bytes());
    Ok(IndexSnapshot {
        digest: state.finalize().into(),
        stage_zero_paths,
    })
}
