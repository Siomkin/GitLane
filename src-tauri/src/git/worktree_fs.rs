//! Race-safe worktree file access rooted at an open directory capability.
//!
//! Repository paths reach this module from IPC and Git metadata. Lexical `..`
//! checks are not sufficient: a symlink in any ancestor can redirect a later
//! pathname open outside the worktree, and a final symlink can be swapped in
//! between metadata and I/O. Resolve every directory component through a held
//! no-follow handle and open the final file with no-follow semantics too.
//!
//! The shared data types live here in the facade — every submodule reads them,
//! and a parent module's private items (fields included) are visible to its
//! children. The behaviour is split by responsibility: `resolve` walks paths
//! component-by-component through held no-follow handles, `meta` compares
//! observed filesystem states, `handle` owns the held-file read/replace
//! operations, `fingerprint` produces the destructive-write preconditions,
//! `reads` are the whole-file convenience readers, `dir_identity` captures a
//! directory's filesystem incarnation, and `hooks` holds the test-only race
//! injection points.

use std::ffi::OsString;

use cap_std::fs::{Dir, File, Metadata};
use sha2::{Digest, Sha256};

mod dir_identity;
mod fingerprint;
mod handle;
mod hooks;
mod meta;
mod reads;
mod resolve;
#[cfg(all(test, unix))]
mod tests;

pub(crate) use dir_identity::worktree_directory_identity;
pub(crate) use fingerprint::{
    fingerprint_worktree_leaf, fingerprint_worktree_leaf_path_bounded,
    validate_worktree_leaf_observation, validate_worktree_leaf_observation_path,
    worktree_leaf_exists_nofollow, worktree_leaf_is_missing_path, worktree_regular_leaf_size_path,
};
pub(crate) use handle::{open_regular_worktree_file, open_worktree_file};
#[cfg(test)]
pub(crate) use hooks::{set_after_guarded_rename_test_hook, set_read_prefix_test_hook};
pub(crate) use reads::{
    open_worktree_append_nofollow, read_regular_worktree_file, read_regular_worktree_file_bounded,
};

pub(crate) struct CoherentWorktreeRead {
    pub(crate) bytes: Vec<u8>,
    pub(crate) size: u64,
    pub(crate) truncated: bool,
    pub(crate) identity: WorktreeFileIdentity,
}

/// An existing regular worktree file plus the held parent directory capability
/// needed to replace that same leaf without resolving its ancestors again.
pub(crate) struct WorktreeFile {
    parent: Dir,
    name: OsString,
    file: File,
    metadata: Metadata,
}

/// Stable, bounded representation of one worktree leaf for destructive-write
/// preconditions. File content is streamed into the digest; it is never held in
/// memory merely to guard an operation.
pub(crate) enum WorktreeLeafFingerprint {
    Missing,
    Regular {
        len: u64,
        mode: u64,
        digest: [u8; 32],
    },
    Symlink {
        mode: u64,
        target: Vec<u8>,
    },
    Other {
        mode: u64,
        kind: u8,
    },
}

/// Cheap pathname observation retained while another leaf is being streamed.
/// It is deliberately separate from [`WorktreeLeafFingerprint`]: inode/times
/// guard capture coherence, while the user-facing confirmation token is based
/// only on semantic content, length, and mode.
pub(crate) struct WorktreeLeafObservation {
    metadata: Option<Metadata>,
    symlink_target: Option<Vec<u8>>,
}

/// Stable identity and editor-relevant metadata for one opened regular file.
/// The device/inode pair (or platform file id exposed by cap-std) makes an
/// atomic replacement a different state even when its bytes are identical.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct WorktreeFileIdentity {
    pub(crate) device: u64,
    pub(crate) inode: u64,
    pub(crate) mode: u64,
    pub(crate) len: u64,
}

/// Stable filesystem incarnation for a repository/worktree directory. Device
/// and inode (or their cap-std platform equivalents) distinguish a replacement
/// recreated at the same pathname from the directory the preview inspected.
///
/// Device and inode alone are **not** sufficient: an inode number is reusable,
/// and a directory removed and recreated at the same pathname is routinely
/// handed the same one straight back — 19 of 20 remove/recreate cycles on ext4
/// (0 of 20 on macOS, which is why this only reproduces off a developer's
/// machine). Creation time separates those incarnations, taking the same ext4
/// case from 19 of 20 undetected to 0 of 20.
///
/// The guard is strong rather than absolute. Creation time comes from the
/// kernel's coarse clock, so two incarnations born inside the same timestamp
/// tick still collide: measured against a synthetic recreate issued
/// microseconds after the original, 18 of 20 slipped through. From a 1 ms gap
/// upward it was 0 of 20, and a real replacement is separated from the
/// directory a preview inspected by at least the round trip through the
/// confirmation dialog.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct WorktreeDirectoryIdentity {
    pub(crate) device: u64,
    pub(crate) inode: u64,
    /// Creation time as `(seconds relative to the Unix epoch, subsec nanos)`,
    /// or `None` where the filesystem does not record one — in which case the
    /// identity degrades to exactly the device/inode pair it was before.
    pub(crate) birth_time: Option<(i64, u32)>,
}

impl WorktreeDirectoryIdentity {
    /// Fold this identity into a lease digest. The single canonical encoding
    /// keeps every lease that guards a directory scope in step; a lease that
    /// hashed device and inode by hand would silently miss the creation time.
    pub(crate) fn hash_into(&self, state: &mut Sha256) {
        state.update(self.device.to_le_bytes());
        state.update(self.inode.to_le_bytes());
        match self.birth_time {
            Some((seconds, nanos)) => {
                state.update([1u8]);
                state.update(seconds.to_le_bytes());
                state.update(nanos.to_le_bytes());
            }
            None => state.update([0u8]),
        }
    }
}
