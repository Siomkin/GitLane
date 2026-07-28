//! Race-safe worktree file access rooted at an open directory capability.
//!
//! Repository paths reach this module from IPC and Git metadata. Lexical `..`
//! checks are not sufficient: a symlink in any ancestor can redirect a later
//! pathname open outside the worktree, and a final symlink can be swapped in
//! between metadata and I/O. Resolve every directory component through a held
//! no-follow handle and open the final file with no-follow semantics too.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};

use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt as CapMetadataExt, OpenOptionsFollowExt};
#[cfg(windows)]
use cap_std::fs::MetadataExt as _;
use cap_std::fs::{Dir, File, Metadata, OpenOptions};
#[cfg(unix)]
use cap_std::fs::{MetadataExt as _, OpenOptionsExt};
use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt as _;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt as _;

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

/// Creation time of `metadata`, or `None` when the platform or filesystem does
/// not record one (cap-std reports that as an error rather than a value).
fn directory_birth_time(metadata: &Metadata) -> Option<(i64, u32)> {
    let created = metadata.created().ok()?.into_std();
    match created.duration_since(std::time::UNIX_EPOCH) {
        Ok(since) => Some((i64::try_from(since.as_secs()).ok()?, since.subsec_nanos())),
        // Created before the epoch: carry the negative offset rather than
        // dropping the field, so two pre-epoch directories stay distinct.
        Err(before) => {
            let ago = before.duration();
            Some((
                i64::try_from(ago.as_secs()).ok()?.checked_neg()?,
                ago.subsec_nanos(),
            ))
        }
    }
}

pub(crate) fn worktree_directory_identity(path: &Path) -> io::Result<WorktreeDirectoryIdentity> {
    let dir = Dir::open_ambient_dir(path, cap_std::ambient_authority())?;
    let metadata = dir.dir_metadata()?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("refusing non-directory repository scope: {path:?}"),
        ));
    }
    Ok(WorktreeDirectoryIdentity {
        device: CapMetadataExt::dev(&metadata),
        inode: CapMetadataExt::ino(&metadata),
        birth_time: directory_birth_time(&metadata),
    })
}

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

#[cfg(test)]
std::thread_local! {
    static READ_PREFIX_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static AFTER_GUARDED_RENAME_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

/// Deterministically mutate a fixture after the bounded descriptor read but
/// before its held-FD/path coherence checks.
#[cfg(test)]
pub(crate) fn set_read_prefix_test_hook(hook: impl FnOnce() + 'static) {
    READ_PREFIX_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
fn run_read_prefix_test_hook() {
    READ_PREFIX_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_read_prefix_test_hook() {}

/// Deterministically replace the just-published editor file before its
/// post-rename identity/content verification.
#[cfg(test)]
pub(crate) fn set_after_guarded_rename_test_hook(hook: impl FnOnce() + 'static) {
    AFTER_GUARDED_RENAME_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
fn run_after_guarded_rename_test_hook() {
    AFTER_GUARDED_RENAME_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_after_guarded_rename_test_hook() {}

impl WorktreeFile {
    pub(crate) fn len(&self) -> u64 {
        self.metadata.len()
    }

    pub(crate) fn reader(&mut self) -> &mut File {
        &mut self.file
    }

    /// Read at most `max_bytes` from this held regular file plus one bounded
    /// truncation probe, then prove the descriptor and pathname still identify
    /// the same unchanged leaf. Complete reads can safely mint editor leases;
    /// truncated reads remain coherent display-only snapshots.
    pub(crate) fn read_prefix_coherent(
        &mut self,
        max_bytes: usize,
    ) -> io::Result<CoherentWorktreeRead> {
        let probe_limit = max_bytes.saturating_add(1);
        let mut bytes = Vec::with_capacity(probe_limit.min(1024 * 1024));
        Read::by_ref(&mut self.file)
            .take(probe_limit as u64)
            .read_to_end(&mut bytes)?;
        run_read_prefix_test_hook();
        let opened_after = self.file.metadata()?;
        let current = self.parent.symlink_metadata(&self.name)?;
        let expected_read = opened_after.len().min(probe_limit as u64);
        if bytes.len() as u64 != expected_read
            || !same_observed_state(&self.metadata, &opened_after)
            || !same_observed_state(&opened_after, &current)
        {
            return Err(changed_while_fingerprinting(&self.name.to_string_lossy()));
        }
        let truncated = opened_after.len() > max_bytes as u64;
        bytes.truncate(max_bytes);
        Ok(CoherentWorktreeRead {
            bytes,
            size: opened_after.len(),
            truncated,
            identity: worktree_file_identity(&opened_after),
        })
    }

    /// Replace the opened leaf through its held parent directory. A sibling
    /// temp file is created without following links, synced, then atomically
    /// renamed over the target; an attacker cannot redirect either name by
    /// swapping an ancestor after validation.
    pub(crate) fn replace_atomic(self, bytes: &[u8]) -> io::Result<()> {
        self.replace_atomic_inner(bytes, false).map(drop)
    }

    /// Atomically replace this leaf only if the pathname still identifies the
    /// exact file descriptor that was validated. The check happens after the
    /// temp file is durable, immediately before rename, closing the practical
    /// window in which an external editor's atomic replacement could be lost.
    pub(crate) fn replace_atomic_if_current(
        self,
        bytes: &[u8],
    ) -> io::Result<WorktreeFileIdentity> {
        self.replace_atomic_inner(bytes, true).and_then(|identity| {
            identity.ok_or_else(|| io::Error::other("atomic replacement lost file identity"))
        })
    }

    fn replace_atomic_inner(
        self,
        bytes: &[u8],
        require_current: bool,
    ) -> io::Result<Option<WorktreeFileIdentity>> {
        static SEQ: AtomicU64 = AtomicU64::new(0);

        let display_name = self.name.to_string_lossy();
        let pid = std::process::id();
        let mut created = None;
        let mut tmp = OsString::new();
        for _ in 0..8 {
            tmp = format!(
                ".{display_name}.gitlane-tmp-{pid}-{}",
                SEQ.fetch_add(1, Ordering::Relaxed)
            )
            .into();
            let mut options = OpenOptions::new();
            options
                .write(true)
                .create_new(true)
                .follow(FollowSymlinks::No);
            match self.parent.open_with(&tmp, &options) {
                Ok(file) => {
                    created = Some(file);
                    break;
                }
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(err),
            }
        }
        let mut temp = created
            .ok_or_else(|| io::Error::other("could not create a unique worktree temp file"))?;

        let written = (|| -> io::Result<Metadata> {
            temp.set_permissions(self.metadata.permissions())?;
            temp.write_all(bytes)?;
            temp.sync_all()?;
            let opened = temp.metadata()?;
            let current = self.parent.symlink_metadata(&tmp)?;
            if !same_observed_state(&opened, &current) {
                return Err(changed_while_fingerprinting(&tmp.to_string_lossy()));
            }
            Ok(opened)
        })();
        drop(temp);

        let result = written.and_then(|replacement_metadata| {
            // Tie the path being renamed to the exact temp descriptor that
            // received the draft; another process must not substitute the temp
            // name after it is closed.
            let current_temp = self.parent.symlink_metadata(&tmp)?;
            if !same_observed_state(&replacement_metadata, &current_temp) {
                return Err(changed_while_fingerprinting(&tmp.to_string_lossy()));
            }
            let replacement_identity = worktree_file_identity(&replacement_metadata);
            if require_current {
                let opened = self.file.metadata()?;
                let current = self.parent.symlink_metadata(&self.name)?;
                if !same_observed_state(&self.metadata, &opened)
                    || !same_observed_state(&opened, &current)
                {
                    return Err(changed_while_fingerprinting(&self.name.to_string_lossy()));
                }
            }
            // The target check above is another syscall window in which the
            // temp name could be substituted. Recheck the captured temp inode
            // once more as the final operation before rename.
            let current_temp = self.parent.symlink_metadata(&tmp)?;
            if !same_observed_state(&replacement_metadata, &current_temp) {
                return Err(changed_while_fingerprinting(&tmp.to_string_lossy()));
            }
            self.parent.rename(&tmp, &self.parent, &self.name)?;
            if require_current {
                run_after_guarded_rename_test_hook();
                validate_published_replacement(
                    &self.parent,
                    &self.name,
                    replacement_identity,
                    bytes,
                )?;
            }
            Ok(require_current.then_some(replacement_identity))
        });
        if result.is_err() {
            let _ = self.parent.remove_file(&tmp);
        }
        result
    }
}

/// Prove the just-renamed pathname still names GitLane's temp inode and that
/// the bytes on that inode are exactly the submitted draft. The bounded reopen
/// prevents an external replacement between rename and response from producing
/// a lease that the frontend would incorrectly pair with its own draft.
fn validate_published_replacement(
    parent: &Dir,
    name: &OsString,
    expected_identity: WorktreeFileIdentity,
    expected_bytes: &[u8],
) -> io::Result<()> {
    let display_name = name.to_string_lossy();
    let mut opened = open_leaf_nofollow(parent, name)?;
    let before = opened.metadata()?;
    if !before.is_file() || worktree_file_identity(&before) != expected_identity {
        return Err(changed_while_fingerprinting(&display_name));
    }

    let probe_limit = expected_bytes.len().saturating_add(1);
    let mut bytes = Vec::with_capacity(probe_limit.min(1024 * 1024));
    Read::by_ref(&mut opened)
        .take(probe_limit as u64)
        .read_to_end(&mut bytes)?;
    let after = opened.metadata()?;
    let current = parent.symlink_metadata(name)?;
    if bytes != expected_bytes
        || !same_observed_state(&before, &after)
        || !same_observed_state(&after, &current)
        || worktree_file_identity(&current) != expected_identity
    {
        return Err(changed_while_fingerprinting(&display_name));
    }
    Ok(())
}

/// Open `file` beneath `workdir` without following a symlink in any component.
/// `Ok(None)` means the stable leaf exists but is not a regular file; races and
/// missing paths stay errors so callers never silently retry by ambient path.
pub(crate) fn open_worktree_file(workdir: &Path, file: &str) -> io::Result<Option<WorktreeFile>> {
    let (parent, name) = open_parent(workdir, file)?;
    let metadata = parent.symlink_metadata(&name)?;
    if !metadata.is_file() {
        return Ok(None);
    }

    let opened = open_leaf_nofollow(&parent, &name)?;
    let metadata = opened.metadata()?;
    if !metadata.is_file() {
        return Ok(None);
    }
    Ok(Some(WorktreeFile {
        parent,
        name,
        file: opened,
        metadata,
    }))
}

fn open_leaf_nofollow(parent: &Dir, name: &OsString) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    parent.open_with(name, &options)
}

pub(crate) fn open_regular_worktree_file(workdir: &Path, file: &str) -> io::Result<WorktreeFile> {
    open_worktree_file(workdir, file)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("refusing non-regular worktree file: {file:?}"),
        )
    })
}

fn changed_while_fingerprinting(file: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::WouldBlock,
        format!("worktree file changed while it was being inspected: {file:?}"),
    )
}

fn changed_path_while_fingerprinting(file: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::WouldBlock,
        format!("worktree file changed while it was being inspected: {file:?}"),
    )
}

#[cfg(unix)]
fn metadata_mode(metadata: &Metadata) -> u64 {
    metadata.mode() as u64
}

#[cfg(any(unix, windows))]
fn worktree_file_identity(metadata: &Metadata) -> WorktreeFileIdentity {
    WorktreeFileIdentity {
        device: CapMetadataExt::dev(metadata),
        inode: CapMetadataExt::ino(metadata),
        mode: metadata_mode(metadata),
        len: metadata.len(),
    }
}

#[cfg(not(any(unix, windows)))]
fn worktree_file_identity(metadata: &Metadata) -> WorktreeFileIdentity {
    WorktreeFileIdentity {
        device: 0,
        inode: 0,
        mode: metadata_mode(metadata),
        len: metadata.len(),
    }
}

#[cfg(windows)]
fn metadata_mode(metadata: &Metadata) -> u64 {
    metadata.file_attributes() as u64
}

#[cfg(not(any(unix, windows)))]
fn metadata_mode(metadata: &Metadata) -> u64 {
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

fn same_observed_state(left: &Metadata, right: &Metadata) -> bool {
    same_leaf(left, right)
        && left.file_type() == right.file_type()
        && left.len() == right.len()
        && metadata_mode(left) == metadata_mode(right)
        && left.modified().ok() == right.modified().ok()
        && same_change_marker(left, right)
}

#[cfg(unix)]
fn path_bytes(path: &Path) -> Vec<u8> {
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
fn path_bytes(path: &Path) -> Vec<u8> {
    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(not(any(unix, windows)))]
fn path_bytes(path: &Path) -> Vec<u8> {
    path.to_string_lossy().into_owned().into_bytes()
}

/// Fingerprint one existing/missing worktree path without following a symlink
/// in any component. The held descriptor and a final no-follow metadata check
/// ensure the digest still names the current leaf when this function returns.
pub(crate) fn fingerprint_worktree_leaf(
    workdir: &Path,
    file: &str,
) -> io::Result<(WorktreeLeafFingerprint, WorktreeLeafObservation)> {
    fingerprint_worktree_leaf_path(workdir, Path::new(file))
}

/// Path-native variant used by whole-tree destructive leases. Git paths are
/// byte strings on Unix, so forcing them through `str` would corrupt or reject
/// a non-UTF-8 untracked filename before the confirmation can protect it.
pub(crate) fn fingerprint_worktree_leaf_path(
    workdir: &Path,
    file: &Path,
) -> io::Result<(WorktreeLeafFingerprint, WorktreeLeafObservation)> {
    fingerprint_worktree_leaf_path_inner(workdir, file, None)
}

/// Bounded-content companion for whole-tree leases. The limit is enforced on
/// bytes actually read, so a file that grows after metadata preflight cannot
/// turn a destructive confirmation into an unbounded stream.
pub(crate) fn fingerprint_worktree_leaf_path_bounded(
    workdir: &Path,
    file: &Path,
    max_regular_bytes: u64,
) -> io::Result<(WorktreeLeafFingerprint, WorktreeLeafObservation)> {
    fingerprint_worktree_leaf_path_inner(workdir, file, Some(max_regular_bytes))
}

fn fingerprint_worktree_leaf_path_inner(
    workdir: &Path,
    file: &Path,
    max_regular_bytes: Option<u64>,
) -> io::Result<(WorktreeLeafFingerprint, WorktreeLeafObservation)> {
    let (parent, name) = match open_parent_path(workdir, file) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok((
                WorktreeLeafFingerprint::Missing,
                WorktreeLeafObservation {
                    metadata: None,
                    symlink_target: None,
                },
            ));
        }
        Err(error) => return Err(error),
    };
    let before = match parent.symlink_metadata(&name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok((
                WorktreeLeafFingerprint::Missing,
                WorktreeLeafObservation {
                    metadata: None,
                    symlink_target: None,
                },
            ));
        }
        Err(error) => return Err(error),
    };

    if before.is_file() {
        let mut opened = open_leaf_nofollow(&parent, &name)?;
        let opened_before = opened.metadata()?;
        if !same_observed_state(&before, &opened_before) {
            return Err(changed_path_while_fingerprinting(file));
        }

        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut total_read = 0u64;
        loop {
            let read = opened.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            total_read = total_read.saturating_add(read as u64);
            if max_regular_bytes.is_some_and(|limit| total_read > limit) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("worktree content exceeded the bounded fingerprint limit: {file:?}"),
                ));
            }
            digest.update(&buffer[..read]);
        }

        let opened_after = opened.metadata()?;
        let current = parent.symlink_metadata(&name)?;
        if !same_observed_state(&opened_before, &opened_after)
            || !same_observed_state(&opened_after, &current)
        {
            return Err(changed_path_while_fingerprinting(file));
        }
        return Ok((
            WorktreeLeafFingerprint::Regular {
                len: current.len(),
                mode: metadata_mode(&current),
                digest: digest.finalize().into(),
            },
            WorktreeLeafObservation {
                metadata: Some(current),
                symlink_target: None,
            },
        ));
    }

    if before.is_symlink() {
        let target = parent.read_link_contents(&name)?;
        let current = parent.symlink_metadata(&name)?;
        if !same_observed_state(&before, &current) {
            return Err(changed_path_while_fingerprinting(file));
        }
        let target = path_bytes(&target);
        return Ok((
            WorktreeLeafFingerprint::Symlink {
                mode: metadata_mode(&current),
                target: target.clone(),
            },
            WorktreeLeafObservation {
                metadata: Some(current),
                symlink_target: Some(target),
            },
        ));
    }

    let kind = if before.is_dir() { 1 } else { 2 };
    Ok((
        WorktreeLeafFingerprint::Other {
            mode: metadata_mode(&before),
            kind,
        },
        WorktreeLeafObservation {
            metadata: Some(before),
            symlink_target: None,
        },
    ))
}

/// Return the logical byte length of a regular leaf without following any
/// ancestor or final-component symlink. Whole-tree destructive previews use
/// this for a bounded-I/O preflight before streaming content fingerprints.
pub(crate) fn worktree_regular_leaf_size_path(
    workdir: &Path,
    file: &Path,
) -> io::Result<Option<u64>> {
    let (parent, name) = match open_parent_path(workdir, file) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    match parent.symlink_metadata(&name) {
        Ok(metadata) if metadata.is_file() => Ok(Some(metadata.len())),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Check whether a worktree leaf is absent without following any ancestor or
/// final-component symlink. This is intentionally metadata-only so cleanup
/// verification cannot stream a concurrently recreated large file.
pub(crate) fn worktree_leaf_is_missing_path(workdir: &Path, file: &Path) -> io::Result<bool> {
    let (parent, name) = match open_parent_path(workdir, file) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };
    match parent.symlink_metadata(&name) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error),
    }
}

/// Confirm that a previously fingerprinted path still names the same leaf and
/// retains its cheap metadata/target state. This deliberately does not reread
/// regular-file content; it runs after all expensive hashing so no large delay
/// remains between this final coherence check and the destructive subprocess.
pub(crate) fn validate_worktree_leaf_observation(
    workdir: &Path,
    file: &str,
    expected: &WorktreeLeafObservation,
) -> io::Result<bool> {
    validate_worktree_leaf_observation_path(workdir, Path::new(file), expected)
}

/// Path-native companion to [`fingerprint_worktree_leaf_path`].
pub(crate) fn validate_worktree_leaf_observation_path(
    workdir: &Path,
    file: &Path,
    expected: &WorktreeLeafObservation,
) -> io::Result<bool> {
    let (parent, name) = match open_parent_path(workdir, file) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(expected.metadata.is_none());
        }
        Err(error) => return Err(error),
    };
    let current = match parent.symlink_metadata(&name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(expected.metadata.is_none());
        }
        Err(error) => return Err(error),
    };
    let Some(metadata) = expected.metadata.as_ref() else {
        return Ok(false);
    };
    if !same_observed_state(metadata, &current) {
        return Ok(false);
    }
    if let Some(expected_target) = expected.symlink_target.as_ref() {
        if !current.is_symlink() {
            return Ok(false);
        }
        return parent
            .read_link_contents(&name)
            .map(|target| path_bytes(&target) == *expected_target);
    }
    Ok(true)
}

pub(crate) fn read_regular_worktree_file(workdir: &Path, file: &str) -> io::Result<Vec<u8>> {
    let mut opened = open_regular_worktree_file(workdir, file)?;
    let mut bytes = Vec::with_capacity(opened.len().min(1024 * 1024) as usize);
    opened.reader().read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Read a regular worktree file through the capability boundary with a hard
/// byte ceiling. Check both the opened metadata and a one-byte streaming probe:
/// a repository-controlled file can grow after `metadata()` but must never make
/// a best-effort status read allocate without bound.
pub(crate) fn read_regular_worktree_file_bounded(
    workdir: &Path,
    file: &str,
    max_bytes: usize,
) -> io::Result<Vec<u8>> {
    let mut opened = open_regular_worktree_file(workdir, file)?;
    if opened.len() > max_bytes as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("worktree file exceeds the {max_bytes}-byte limit: {file:?}"),
        ));
    }
    let probe_limit = max_bytes.saturating_add(1);
    let mut bytes = Vec::with_capacity(probe_limit.min(1024 * 1024));
    opened
        .reader()
        .take(probe_limit as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("worktree file exceeds the {max_bytes}-byte limit: {file:?}"),
        ));
    }
    Ok(bytes)
}

/// Open a worktree-rooted file for appending with no-follow semantics: a symlink
/// final component (or symlinked ancestor) is refused, so a repository-controlled
/// `.gitignore` / `info/exclude` cannot redirect the append outside `root`. Git
/// itself never follows a `.gitignore` symlink; neither do we. Returns the current
/// contents (for dedup / trailing-newline decisions) alongside the append handle.
/// Parent directories must already exist.
pub(crate) fn open_worktree_append_nofollow(root: &Path, file: &str) -> io::Result<(String, File)> {
    let (parent, name) = open_parent_path(root, Path::new(file))?;
    let existing = match open_leaf_nofollow(&parent, &name) {
        Ok(mut existing) => {
            let mut text = String::new();
            existing.read_to_string(&mut text)?;
            text
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    let mut options = OpenOptions::new();
    options.append(true).create(true).follow(FollowSymlinks::No);
    let handle = parent.open_with(&name, &options)?;
    Ok((existing, handle))
}

/// Existence + path-safety probe for a worktree leaf using no-follow semantics,
/// WITHOUT digesting its contents — for callers like Reveal that only need to
/// know a safe leaf is present, not a content fingerprint. `Ok(false)` means the
/// leaf is absent; a symlinked ancestor (or other unsafe open) surfaces as `Err`,
/// exactly like [`fingerprint_worktree_leaf`].
pub(crate) fn worktree_leaf_exists_nofollow(workdir: &Path, file: &str) -> io::Result<bool> {
    let (parent, name) = open_parent_path(workdir, Path::new(file))?;
    match parent.symlink_metadata(&name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn open_parent(workdir: &Path, file: &str) -> io::Result<(Dir, OsString)> {
    open_parent_path(workdir, Path::new(file))
}

fn open_parent_path(workdir: &Path, rel: &Path) -> io::Result<(Dir, OsString)> {
    if rel.is_absolute() {
        return Err(unsafe_path(rel));
    }

    let mut names = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(name) => names.push(name.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(unsafe_path(rel));
            }
        }
    }
    let name = names.pop().ok_or_else(|| unsafe_path(rel))?;

    let mut parent = Dir::open_ambient_dir(workdir, cap_std::ambient_authority())?;
    for component in names {
        parent = parent.open_dir_nofollow(component)?;
    }
    Ok((parent, name))
}

fn unsafe_path(file: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("refusing unsafe path outside the worktree: {file:?}"),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::{
        fingerprint_worktree_leaf_path_bounded, open_leaf_nofollow, open_regular_worktree_file,
        read_regular_worktree_file, worktree_directory_identity, WorktreeDirectoryIdentity,
    };
    use cap_std::fs::Dir;
    use sha2::{Digest, Sha256};
    use std::ffi::OsString;
    use std::os::unix::fs::symlink;

    fn identity_digest(identity: &WorktreeDirectoryIdentity) -> [u8; 32] {
        let mut state = Sha256::new();
        identity.hash_into(&mut state);
        state.finalize().into()
    }

    /// The load-bearing property, asserted without depending on the filesystem
    /// to recycle an inode: this machine's APFS never does, while the Linux CI
    /// runner does so almost every time. Constructing the collision directly is
    /// what makes the guarantee testable on both.
    #[test]
    fn directories_sharing_a_recycled_inode_are_still_distinct() {
        let recycled = WorktreeDirectoryIdentity {
            device: 42,
            inode: 1234,
            birth_time: Some((1_700_000_000, 0)),
        };
        let replacement = WorktreeDirectoryIdentity {
            birth_time: Some((1_700_000_001, 0)),
            ..recycled
        };

        assert_ne!(
            recycled, replacement,
            "a replacement handed the same inode must not compare equal"
        );
        assert_ne!(
            identity_digest(&recycled),
            identity_digest(&replacement),
            "the lease digest must separate them too, not just the struct"
        );
    }

    /// Sub-second resolution matters: a remove/recreate takes microseconds, so a
    /// creation time truncated to whole seconds would collide in exactly the
    /// case this guards.
    #[test]
    fn birth_time_separates_directories_created_within_the_same_second() {
        let first = WorktreeDirectoryIdentity {
            device: 42,
            inode: 1234,
            birth_time: Some((1_700_000_000, 0)),
        };
        let second = WorktreeDirectoryIdentity {
            birth_time: Some((1_700_000_000, 1)),
            ..first
        };

        assert_ne!(identity_digest(&first), identity_digest(&second));
    }

    /// A filesystem that reports no creation time must degrade to the previous
    /// device/inode behaviour rather than erroring or silently matching a
    /// directory that does report one.
    #[test]
    fn a_missing_birth_time_degrades_to_device_and_inode() {
        let without = WorktreeDirectoryIdentity {
            device: 42,
            inode: 1234,
            birth_time: None,
        };
        let with = WorktreeDirectoryIdentity {
            birth_time: Some((1_700_000_000, 0)),
            ..without
        };

        assert_eq!(
            identity_digest(&without),
            identity_digest(&WorktreeDirectoryIdentity {
                birth_time: None,
                ..without
            }),
            "absent creation time must hash stably"
        );
        assert_ne!(
            identity_digest(&without),
            identity_digest(&with),
            "absent must not collide with present"
        );
    }

    #[test]
    fn directory_identity_reports_a_birth_time_on_this_platform() {
        let root =
            std::env::temp_dir().join(format!("gitlane-dir-identity-btime-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let identity = worktree_directory_identity(&root).expect("identity for a real directory");

        assert!(
            identity.birth_time.is_some(),
            "macOS and Linux both record a creation time; losing it here would \
             silently drop the guard back to a reusable inode"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The other half of the contract, and the more dangerous one to get wrong:
    /// an identity that drifted between two reads of the same directory would
    /// expire every preview before the user could confirm it.
    #[test]
    fn identity_is_stable_across_repeated_reads_and_writes_inside_the_directory() {
        let root = std::env::temp_dir().join(format!(
            "gitlane-dir-identity-stable-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let first = worktree_directory_identity(&root).expect("first read");
        // Mutating the contents changes mtime, never the directory's identity.
        std::fs::write(root.join("file.txt"), "content").unwrap();
        std::fs::create_dir_all(root.join("nested")).unwrap();
        let second = worktree_directory_identity(&root).expect("second read");

        assert_eq!(
            first, second,
            "identity must not drift while the directory stands, or every \
             confirm would go stale under the user"
        );
        assert_eq!(identity_digest(&first), identity_digest(&second));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recreating_a_directory_at_the_same_path_changes_its_identity() {
        let root = std::env::temp_dir().join(format!(
            "gitlane-dir-identity-recreate-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let before = worktree_directory_identity(&root).expect("identity before");

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let after = worktree_directory_identity(&root).expect("identity after");

        assert_ne!(
            before, after,
            "a directory rebuilt at the same pathname is a different incarnation"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_final_and_ancestor_symlinks() {
        let root = std::env::temp_dir().join(format!(
            "gitlane-worktree-capability-{}",
            std::process::id()
        ));
        let outside = root.with_extension("outside");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(root.join("safe")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("safe/file.txt"), "inside").unwrap();
        std::fs::write(outside.join("secret.txt"), "outside").unwrap();
        symlink(outside.join("secret.txt"), root.join("leaf-link")).unwrap();
        symlink(&outside, root.join("ancestor-link")).unwrap();

        assert_eq!(
            read_regular_worktree_file(&root, "safe/file.txt").unwrap(),
            b"inside"
        );
        assert!(open_regular_worktree_file(&root, "leaf-link").is_err());
        assert!(open_regular_worktree_file(&root, "ancestor-link/secret.txt").is_err());
        assert!(open_regular_worktree_file(&root, "../secret.txt").is_err());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn leaf_open_does_not_block_when_a_fifo_wins_the_race() {
        let root =
            std::env::temp_dir().join(format!("gitlane-worktree-fifo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let status = std::process::Command::new("mkfifo")
            .arg(root.join("leaf"))
            .status()
            .unwrap();
        assert!(status.success());

        let parent = Dir::open_ambient_dir(&root, cap_std::ambient_authority()).unwrap();
        let opened = open_leaf_nofollow(&parent, &OsString::from("leaf")).unwrap();

        assert!(!opened.metadata().unwrap().is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn bounded_fingerprint_rejects_content_over_the_actual_read_limit() {
        let root = std::env::temp_dir().join(format!(
            "gitlane-worktree-bounded-fingerprint-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("large.bin"), vec![0_u8; 2_048]).unwrap();

        let error =
            fingerprint_worktree_leaf_path_bounded(&root, std::path::Path::new("large.bin"), 1_024)
                .err()
                .expect("content over the byte limit must fail");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        let _ = std::fs::remove_dir_all(&root);
    }
}
