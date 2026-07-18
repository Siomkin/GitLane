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

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File, Metadata, OpenOptions};

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

    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let opened = parent.open_with(&name, &options)?;
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

pub(crate) fn read_regular_worktree_file(workdir: &Path, file: &str) -> io::Result<Vec<u8>> {
    let mut opened = open_regular_worktree_file(workdir, file)?;
    let mut bytes = Vec::with_capacity(opened.len().min(1024 * 1024) as usize);
    opened.reader().read_to_end(&mut bytes)?;
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
    use super::{open_regular_worktree_file, read_regular_worktree_file};
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
}
