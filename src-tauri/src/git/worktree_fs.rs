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
    Other,
}

/// Cheap pathname observation retained while another leaf is being streamed.
/// It is deliberately separate from [`WorktreeLeafFingerprint`]: inode/times
/// guard capture coherence, while the user-facing confirmation token is based
/// only on semantic content, length, and mode.
pub(crate) struct WorktreeLeafObservation {
    metadata: Option<Metadata>,
    symlink_target: Option<Vec<u8>>,
}

/// An existing regular worktree file plus the held parent directory capability
/// needed to replace that same leaf without resolving its ancestors again.
pub(crate) struct WorktreeFile {
    parent: Dir,
    name: OsString,
    file: File,
    metadata: Metadata,
}

impl WorktreeFile {
    pub(crate) fn len(&self) -> u64 {
        self.metadata.len()
    }

    pub(crate) fn reader(&mut self) -> &mut File {
        &mut self.file
    }

    /// Replace the opened leaf through its held parent directory. A sibling
    /// temp file is created without following links, synced, then atomically
    /// renamed over the target; an attacker cannot redirect either name by
    /// swapping an ancestor after validation.
    pub(crate) fn replace_atomic(self, bytes: &[u8]) -> io::Result<()> {
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

        let written = (|| -> io::Result<()> {
            temp.set_permissions(self.metadata.permissions())?;
            temp.write_all(bytes)?;
            temp.sync_all()
        })();
        drop(temp);

        let result = written.and_then(|()| self.parent.rename(&tmp, &self.parent, &self.name));
        if result.is_err() {
            let _ = self.parent.remove_file(&tmp);
        }
        result
    }
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

#[cfg(unix)]
fn metadata_mode(metadata: &Metadata) -> u64 {
    metadata.mode() as u64
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
    let (parent, name) = match open_parent(workdir, file) {
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
            return Err(changed_while_fingerprinting(file));
        }

        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = opened.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }

        let opened_after = opened.metadata()?;
        let current = parent.symlink_metadata(&name)?;
        if !same_observed_state(&opened_before, &opened_after)
            || !same_observed_state(&opened_after, &current)
        {
            return Err(changed_while_fingerprinting(file));
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
            return Err(changed_while_fingerprinting(file));
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

    Ok((
        WorktreeLeafFingerprint::Other,
        WorktreeLeafObservation {
            metadata: Some(before),
            symlink_target: None,
        },
    ))
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
    let (parent, name) = match open_parent(workdir, file) {
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
    let rel = Path::new(file);
    if rel.is_absolute() {
        return Err(unsafe_path(file));
    }

    let mut names = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(name) => names.push(name.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(unsafe_path(file));
            }
        }
    }
    let name = names.pop().ok_or_else(|| unsafe_path(file))?;

    let mut parent = Dir::open_ambient_dir(workdir, cap_std::ambient_authority())?;
    for component in names {
        parent = parent.open_dir_nofollow(component)?;
    }
    Ok((parent, name))
}

fn unsafe_path(file: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("refusing unsafe path outside the worktree: {file:?}"),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::{open_leaf_nofollow, open_regular_worktree_file, read_regular_worktree_file};
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
}
