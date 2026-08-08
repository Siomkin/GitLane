//! The held-file handle: an opened regular leaf plus its parent directory
//! capability, and the coherent read / atomic replace operations on it.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File, Metadata, OpenOptions};

use super::hooks::{run_after_guarded_rename_test_hook, run_read_prefix_test_hook};
use super::meta::{changed_while_fingerprinting, same_observed_state, worktree_file_identity};
use super::resolve::{open_leaf_nofollow, open_parent};
use super::{CoherentWorktreeRead, WorktreeFile, WorktreeFileIdentity};

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

pub(crate) fn open_regular_worktree_file(workdir: &Path, file: &str) -> io::Result<WorktreeFile> {
    open_worktree_file(workdir, file)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("refusing non-regular worktree file: {file:?}"),
        )
    })
}
