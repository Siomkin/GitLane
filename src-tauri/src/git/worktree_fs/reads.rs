//! Whole-file convenience readers and the no-follow append open, all routed
//! through the same capability-rooted resolution as everything else.

use std::io::{self, Read};
use std::path::Path;

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{File, OpenOptions};

use super::handle::open_regular_worktree_file;
use super::resolve::{open_leaf_nofollow, open_parent_path};

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
