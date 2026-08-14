//! Hashing the pieces of a snapshot into its lease token — index entries,
//! diff deltas, status records, and the per-platform filesystem path.

use std::path::Path;

use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

use crate::git::worktree_fs::WorktreeLeafFingerprint;

pub(super) fn hash_field(state: &mut Sha256, bytes: &[u8]) {
    state.update((bytes.len() as u64).to_le_bytes());
    state.update(bytes);
}

#[cfg(unix)]
pub(super) fn hash_filesystem_path(state: &mut Sha256, path: &Path) {
    hash_field(state, path.as_os_str().as_bytes());
}

#[cfg(windows)]
pub(super) fn hash_filesystem_path(state: &mut Sha256, path: &Path) {
    let bytes: Vec<u8> = path
        .as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect();
    hash_field(state, &bytes);
}

#[cfg(not(any(unix, windows)))]
pub(super) fn hash_filesystem_path(state: &mut Sha256, path: &Path) {
    hash_field(state, path.to_string_lossy().as_bytes());
}

pub(super) fn hash_index_entry(state: &mut Sha256, entry: Option<git2::IndexEntry>, stage: i32) {
    state.update([stage as u8]);
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

pub(super) fn hash_diff_file(state: &mut Sha256, file: git2::DiffFile<'_>) {
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
    state.update([1, delta.status() as u8]);
    state.update(delta.nfiles().to_le_bytes());
    hash_diff_file(state, delta.old_file());
    hash_diff_file(state, delta.new_file());
}

pub(super) fn hash_status_entry(state: &mut Sha256, entry: &git2::StatusEntry<'_>) {
    state.update(entry.status().bits().to_le_bytes());
    hash_field(state, entry.path_bytes());
    hash_diff_delta(state, entry.head_to_index());
    hash_diff_delta(state, entry.index_to_workdir());
}

pub(super) fn hash_worktree_fingerprint(
    state: &mut Sha256,
    fingerprint: WorktreeLeafFingerprint,
    file: &str,
) -> Result<(), String> {
    match fingerprint {
        WorktreeLeafFingerprint::Missing => state.update([0]),
        WorktreeLeafFingerprint::Regular { len, mode, digest } => {
            state.update([1]);
            state.update(len.to_le_bytes());
            state.update(mode.to_le_bytes());
            state.update(digest);
        }
        WorktreeLeafFingerprint::Symlink { mode, target } => {
            state.update([2]);
            state.update(mode.to_le_bytes());
            hash_field(state, &target);
        }
        WorktreeLeafFingerprint::Other { .. } => {
            return Err(format!(
                "Refusing to discard non-file worktree path {file}. Use the terminal for this repository state."
            ));
        }
    }
    Ok(())
}
