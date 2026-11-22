//! Component-wise path resolution through held no-follow directory handles.

use std::ffi::OsString;
use std::io;
use std::path::{Component, Path};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
#[cfg(unix)]
use cap_std::fs::OpenOptionsExt;
use cap_std::fs::{Dir, File, OpenOptions};

pub(super) fn open_leaf_nofollow(parent: &Dir, name: &OsString) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits().cast_signed());
    parent.open_with(name, &options)
}

/// Does `path` have a component that names the `.git` directory? Matched
/// case-insensitively and with the aliases NTFS resolves to it (trailing dots or
/// spaces, an `:stream` suffix, the `git~1` short name), the same names git
/// itself refuses (`core.protectNTFS`). The one shared rule for every guard that
/// keeps paths out of repository metadata.
pub(crate) fn has_git_component(path: &Path) -> bool {
    path.components().any(|c| match c {
        Component::Normal(name) => {
            let name = name.to_string_lossy().to_ascii_lowercase();
            let stem = name
                .split(':')
                .next()
                .unwrap_or_default()
                .trim_end_matches(['.', ' ']);
            stem == ".git" || stem == "git~1"
        }
        _ => false,
    })
}

/// Refuse a repo-relative path into `.git`, so content reads cannot reach
/// repository metadata.
pub(super) fn reject_git_component(file: &str) -> io::Result<()> {
    if has_git_component(Path::new(file)) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("refusing to read repository metadata: {file:?}"),
        ));
    }
    Ok(())
}

pub(super) fn open_parent(workdir: &Path, file: &str) -> io::Result<(Dir, OsString)> {
    open_parent_path(workdir, Path::new(file))
}

pub(super) fn open_parent_path(workdir: &Path, rel: &Path) -> io::Result<(Dir, OsString)> {
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
