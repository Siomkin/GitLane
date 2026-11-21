//! Hashing the pieces of a snapshot into its lease token — index entries,
//! diff deltas, and status records. The field and filesystem-path encodings
//! come from `write::state_lease`, which owns the one definition (GL-376).

use sha2::{Digest, Sha256};

use crate::git::worktree_fs::WorktreeLeafFingerprint;

use super::super::state_lease::{fingerprint_into, hash_field};

pub(super) fn hash_index_entry(state: &mut Sha256, entry: Option<git2::IndexEntry>, stage: i32) {
    debug_assert!(
        (0..=3).contains(&stage),
        "git index stages are 0..=3, got {stage}"
    );
    // Git index stages are 0..=3; the only caller loops over exactly those.
    state.update([u8::try_from(stage).unwrap_or(u8::MAX)]);
    let Some(entry) = entry else {
        state.update([0]);
        return;
    };
    state.update([1]);
    state.update(entry.id.as_bytes());
    state.update(entry.mode.to_le_bytes());
    state.update(entry.flags.to_le_bytes());
    state.update(entry.flags_extended.to_le_bytes());
}

pub(super) fn hash_diff_file(state: &mut Sha256, file: &git2::DiffFile<'_>) {
    state.update(file.id().as_bytes());
    state.update(i32::from(file.mode()).to_le_bytes());
    state.update(file.size().to_le_bytes());
    state.update([u8::from(file.exists()), u8::from(file.is_valid_id())]);
    match file.path_bytes() {
        Some(path) => {
            state.update([1]);
            hash_field(state, path);
        }
        None => state.update([0]),
    }
}

pub(super) fn hash_diff_delta(state: &mut Sha256, delta: Option<git2::DiffDelta<'_>>) {
    let Some(delta) = delta else {
        state.update([0]);
        return;
    };
    state.update([1, delta_byte(delta.status())]);
    state.update(delta.nfiles().to_le_bytes());
    hash_diff_file(state, &delta.old_file());
    hash_diff_file(state, &delta.new_file());
}

/// The byte a delta's status hashes as. Each value is the variant's
/// declaration-order discriminant, the encoding lease tokens were minted
/// with, so it must never change (pinned by the test below).
fn delta_byte(status: git2::Delta) -> u8 {
    match status {
        git2::Delta::Unmodified => 0,
        git2::Delta::Added => 1,
        git2::Delta::Deleted => 2,
        git2::Delta::Modified => 3,
        git2::Delta::Renamed => 4,
        git2::Delta::Copied => 5,
        git2::Delta::Ignored => 6,
        git2::Delta::Untracked => 7,
        git2::Delta::Typechange => 8,
        git2::Delta::Unreadable => 9,
        git2::Delta::Conflicted => 10,
    }
}

pub(super) fn hash_status_entry(state: &mut Sha256, entry: &git2::StatusEntry<'_>) {
    state.update(entry.status().bits().to_le_bytes());
    hash_field(state, entry.path_bytes());
    hash_diff_delta(state, entry.head_to_index());
    hash_diff_delta(state, entry.index_to_workdir());
}

pub(super) fn hash_worktree_fingerprint(
    state: &mut Sha256,
    fingerprint: &WorktreeLeafFingerprint,
    file: &str,
) -> Result<(), String> {
    fingerprint_into(state, fingerprint, file).map_err(|_| {
        format!(
            "Refusing to discard non-file worktree path {file}. Use the terminal for this repository state."
        )
    })
}

#[cfg(test)]
mod tests {
    use super::delta_byte;

    #[test]
    fn delta_bytes_match_the_discriminants_lease_tokens_were_minted_with() {
        use git2::Delta;
        let variants = [
            Delta::Unmodified,
            Delta::Added,
            Delta::Deleted,
            Delta::Modified,
            Delta::Renamed,
            Delta::Copied,
            Delta::Ignored,
            Delta::Untracked,
            Delta::Typechange,
            Delta::Unreadable,
            Delta::Conflicted,
        ];
        for (expected, variant) in (0u8..).zip(variants) {
            assert_eq!(delta_byte(variant), expected, "{variant:?}");
            #[expect(
                clippy::as_conversions,
                reason = "the test pins delta_byte to the discriminant `as` used to hash"
            )]
            let discriminant = variant as u8;
            assert_eq!(delta_byte(variant), discriminant, "{variant:?}");
        }
    }
}
