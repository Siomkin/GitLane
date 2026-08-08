//! Observed filesystem state: platform metadata accessors, the coherence
//! comparison every race check funnels through, and the shared errors.

use std::io;
use std::path::Path;

use cap_fs_ext::MetadataExt as CapMetadataExt;
use cap_std::fs::Metadata;
#[cfg(unix)]
use cap_std::fs::MetadataExt as _;
#[cfg(windows)]
use cap_std::fs::MetadataExt as _;

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt as _;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt as _;

use super::WorktreeFileIdentity;

pub(super) fn changed_while_fingerprinting(file: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::WouldBlock,
        format!("worktree file changed while it was being inspected: {file:?}"),
    )
}

pub(super) fn changed_path_while_fingerprinting(file: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::WouldBlock,
        format!("worktree file changed while it was being inspected: {file:?}"),
    )
}

#[cfg(unix)]
pub(super) fn metadata_mode(metadata: &Metadata) -> u64 {
    metadata.mode() as u64
}

#[cfg(any(unix, windows))]
pub(super) fn worktree_file_identity(metadata: &Metadata) -> WorktreeFileIdentity {
    WorktreeFileIdentity {
        device: CapMetadataExt::dev(metadata),
        inode: CapMetadataExt::ino(metadata),
        mode: metadata_mode(metadata),
        len: metadata.len(),
    }
}

#[cfg(not(any(unix, windows)))]
pub(super) fn worktree_file_identity(metadata: &Metadata) -> WorktreeFileIdentity {
    WorktreeFileIdentity {
        device: 0,
        inode: 0,
        mode: metadata_mode(metadata),
        len: metadata.len(),
    }
}

#[cfg(windows)]
pub(super) fn metadata_mode(metadata: &Metadata) -> u64 {
    metadata.file_attributes() as u64
}

#[cfg(not(any(unix, windows)))]
pub(super) fn metadata_mode(metadata: &Metadata) -> u64 {
    u64::from(metadata.permissions().readonly())
}

#[cfg(any(unix, windows))]
fn same_leaf(left: &Metadata, right: &Metadata) -> bool {
    CapMetadataExt::dev(left) == CapMetadataExt::dev(right)
        && CapMetadataExt::ino(left) == CapMetadataExt::ino(right)
}

#[cfg(unix)]
fn same_change_marker(left: &Metadata, right: &Metadata) -> bool {
    left.ctime() == right.ctime() && left.ctime_nsec() == right.ctime_nsec()
}

#[cfg(windows)]
fn same_change_marker(left: &Metadata, right: &Metadata) -> bool {
    left.last_write_time() == right.last_write_time()
}

#[cfg(not(any(unix, windows)))]
fn same_leaf(left: &Metadata, right: &Metadata) -> bool {
    left.file_type() == right.file_type()
}

#[cfg(not(any(unix, windows)))]
fn same_change_marker(_left: &Metadata, _right: &Metadata) -> bool {
    true
}

pub(super) fn same_observed_state(left: &Metadata, right: &Metadata) -> bool {
    same_leaf(left, right)
        && left.file_type() == right.file_type()
        && left.len() == right.len()
        && metadata_mode(left) == metadata_mode(right)
        && left.modified().ok() == right.modified().ok()
        && same_change_marker(left, right)
}

#[cfg(unix)]
pub(super) fn path_bytes(path: &Path) -> Vec<u8> {
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
pub(super) fn path_bytes(path: &Path) -> Vec<u8> {
    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(not(any(unix, windows)))]
pub(super) fn path_bytes(path: &Path) -> Vec<u8> {
    path.to_string_lossy().into_owned().into_bytes()
}
