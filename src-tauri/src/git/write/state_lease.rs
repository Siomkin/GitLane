//! Primitives shared by the destructive-write state leases (GL-332).
//!
//! `discard_all` and `hard_reset_lease` both fingerprint repository state at
//! preview time and re-validate it immediately before mutating. The pattern was
//! established by the first and copied into the second, and the copies drifted —
//! most seriously when the hard-reset lease dropped the post-hashing observation
//! sweep and became able to destroy content the user never previewed (GL-302).
//!
//! What lives here is deliberately **policy-neutral and message-free**: each
//! operation keeps its own answer to which paths are affected, what it refuses,
//! and how it words that refusal. Anything phrased for the user stays in the
//! caller, so the shared core cannot quietly unify two different wordings.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

use crate::git::worktree_fs::WorktreeDirectoryIdentity;

/// Ceiling on the bytes one capture will hash before refusing to continue, so a
/// pathological worktree cannot stall a destructive confirmation indefinitely.
pub(super) const MAX_FINGERPRINT_BYTES: u64 = 256 * 1024 * 1024;

/// The filesystem incarnation a lease was taken against.
///
/// Paths alone are not enough: device/inode identity is what distinguishes a
/// directory recreated at the same pathname from the one the preview inspected,
/// which is how the close/reopen ABA case is caught.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct RepositoryScope {
    pub(super) workdir: PathBuf,
    pub(super) gitdir: PathBuf,
    pub(super) commondir: PathBuf,
    pub(super) workdir_identity: WorktreeDirectoryIdentity,
    pub(super) gitdir_identity: WorktreeDirectoryIdentity,
    pub(super) commondir_identity: WorktreeDirectoryIdentity,
    pub(super) is_worktree: bool,
}

/// Pin a git invocation to a captured scope with explicit `--git-dir` and
/// `--work-tree`, so it cannot be redirected by a `.git`-file retarget between
/// validation and launch (GL-302).
pub(super) fn scoped_git_args(scope: &RepositoryScope, args: &[&str]) -> Vec<OsString> {
    let mut scoped = Vec::with_capacity(args.len() + 4);
    scoped.push(OsString::from("--git-dir"));
    scoped.push(scope.gitdir.as_os_str().to_os_string());
    scoped.push(OsString::from("--work-tree"));
    scoped.push(scope.workdir.as_os_str().to_os_string());
    scoped.extend(args.iter().map(OsString::from));
    scoped
}

/// Length-prefix before hashing, so no combination of field values can be
/// rearranged into the same digest by moving a separator.
pub(super) fn hash_field(state: &mut Sha256, bytes: &[u8]) {
    state.update((bytes.len() as u64).to_le_bytes());
    state.update(bytes);
}

#[cfg(unix)]
pub(super) fn os_bytes(value: &OsStr) -> Vec<u8> {
    value.as_bytes().to_vec()
}

#[cfg(windows)]
pub(super) fn os_bytes(value: &OsStr) -> Vec<u8> {
    value.encode_wide().flat_map(u16::to_le_bytes).collect()
}

#[cfg(not(any(unix, windows)))]
pub(super) fn os_bytes(value: &OsStr) -> Vec<u8> {
    value.to_string_lossy().as_bytes().to_vec()
}

pub(super) fn hash_os(state: &mut Sha256, value: &OsStr) {
    hash_field(state, &os_bytes(value));
}

/// Lossy rendering of a path, for embedding in a message. Lossy is acceptable
/// here precisely because the result is never hashed or compared — only shown.
pub(super) fn path_label(path: &OsStr) -> String {
    path.to_string_lossy().into_owned()
}
