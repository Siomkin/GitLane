//! The index digest both leases pin.

use git2::{IndexEntryExtendedFlag, IndexEntryFlag, Repository};
use sha2::{Digest, Sha256};

use super::{hash_field, LeaseError};

/// Digest every index entry under `domain`, returning the digest and the
/// stage-zero paths in index order.
///
/// Refuses assume-unchanged and skip-worktree entries (the worktree content
/// behind them is not what the index claims) and any conflict stage.
pub(in crate::git::write) fn index_digest(
    repository: &Repository,
    domain: &[u8],
) -> Result<([u8; 32], Vec<Vec<u8>>), LeaseError> {
    let index = repository.index().map_err(LeaseError::InspectIndex)?;
    let mut state = Sha256::new();
    hash_field(&mut state, domain);
    let mut stage_zero_paths = Vec::new();
    let mut count = 0u64;
    for entry in index.iter() {
        count += 1;
        let flags = IndexEntryFlag::from_bits_truncate(entry.flags);
        let extended = IndexEntryExtendedFlag::from_bits_truncate(entry.flags_extended);
        if flags.is_valid() {
            return Err(LeaseError::AssumeUnchanged(
                String::from_utf8_lossy(&entry.path).into_owned(),
            ));
        }
        if extended.is_skip_worktree() {
            return Err(LeaseError::SkipWorktree(
                String::from_utf8_lossy(&entry.path).into_owned(),
            ));
        }
        if (entry.flags >> 12) & 0x3 != 0 {
            return Err(LeaseError::ConflictedIndex);
        }
        hash_field(&mut state, &entry.path);
        state.update(entry.id.as_bytes());
        state.update(entry.mode.to_le_bytes());
        state.update(entry.flags.to_le_bytes());
        state.update(entry.flags_extended.to_le_bytes());
        stage_zero_paths.push(entry.path);
    }
    state.update(count.to_le_bytes());
    Ok((state.finalize().into(), stage_zero_paths))
}
