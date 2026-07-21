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
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct WorktreeDirectoryIdentity {
    pub(crate) device: u64,
    pub(crate) inode: u64,
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
        read_regular_worktree_file,
    };
    use cap_std::fs::Dir;
    use std::ffi::OsString;
    use std::os::unix::fs::symlink;

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
