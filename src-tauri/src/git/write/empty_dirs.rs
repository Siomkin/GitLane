//! Preserving empty untracked directories across a `git stash push`.
//!
//! `git stash push --include-untracked` clears the untracked files it captured
//! with a blanket `git clean --force --quiet -d :/`. The `-d` removes untracked
//! *directories* too, and a directory holding no files is removed along with the
//! rest — but a stash commit records only blobs, so nothing in the entry can put
//! it back. The directory never appeared in `git status` either, so the user
//! confirmed a stash of some file edits and silently lost part of their tree
//! layout. GL-218 fixed exactly this collateral deletion for Discard all; this
//! module is the equivalent for stash.
//!
//! Discard all could fix it at the source, by cleaning enumerated paths instead
//! of running a blanket `clean -fd`. Stash cannot: only `git stash push -u`
//! captures untracked content into an entry, and its cleanup is internal. Its
//! pathspec form (`--pathspec-from-file`) does scope the cleanup, but git then
//! runs a bare `git add -- <paths>` that fails outright on a staged deletion —
//! the path is in neither the index nor the worktree — after the entry is
//! already stored. Trading a working `git rm` + Stash for preserved directories
//! is the wrong trade.
//!
//! So this restores rather than prevents: [`capture`] records the file-free
//! directories before the push, [`restore`] recreates whichever of them git
//! removed. Nothing but their existence and mode is ever at stake, because a
//! directory that holds no file has nothing else to lose.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use super::cli::run_git_stdout_raw;

/// How deep to walk an untracked directory looking for file-free subtrees. Deep
/// enough for any real layout, shallow enough that a pathological tree (or a
/// directory cycle a future filesystem might allow) cannot exhaust the stack.
const MAX_WALK_DEPTH: usize = 64;

/// A directory that holds no file anywhere beneath it, and the mode to put back.
pub(super) struct EmptyDir {
    /// Relative to the worktree root, so it survives the push unambiguously.
    relative: PathBuf,
    #[cfg(unix)]
    mode: Option<u32>,
}

/// Record every file-free untracked directory, so the push cannot silently take
/// one with it. Enumeration is deliberately fallible: it runs before anything is
/// mutated, so a repository too broken to list is better refused than stashed
/// with directories quietly deleted.
pub(super) fn capture(repo: &str) -> Result<Vec<EmptyDir>, String> {
    let workdir = worktree_root(repo)?;
    let mut found = Vec::new();
    // `--directory` collapses each untracked tree to its shallowest untracked
    // directory, and every empty directory is inside one of those by definition
    // (an empty directory is itself untracked, so it is a root or lives under
    // one). That keeps the walk off the tracked part of the worktree entirely.
    for root in untracked_roots(repo)? {
        let absolute = workdir.join(&root);
        // Git's own cleanup skips a nested repository ("Ignoring path foo/"),
        // so it is neither at risk nor ours to walk into.
        if is_nested_repository(&absolute) {
            continue;
        }
        collect_file_free(&absolute, Path::new(&root), 0, &mut found);
    }
    Ok(found)
}

/// Recreate the captured directories git removed. Returns the ones it could not
/// put back, for the caller to qualify its outcome with; an empty result means
/// the tree layout survived the stash intact.
pub(super) fn restore(repo: &str, dirs: &[EmptyDir]) -> Vec<String> {
    if dirs.is_empty() {
        return Vec::new();
    }
    let Ok(workdir) = worktree_root(repo) else {
        return dirs.iter().map(EmptyDir::label).collect();
    };
    // Shallowest first, so a parent always exists before its children are made.
    let mut ordered: Vec<&EmptyDir> = dirs.iter().collect();
    ordered.sort_by_key(|dir| dir.relative.components().count());

    let mut failed = Vec::new();
    for dir in &ordered {
        let absolute = workdir.join(&dir.relative);
        if absolute.is_dir() {
            continue;
        }
        if std::fs::create_dir_all(&absolute).is_err() {
            failed.push(dir.label());
        }
    }
    // Modes deepest-first: restoring a read-only mode on a parent before its
    // children exist would block creating them.
    for dir in ordered.iter().rev() {
        dir.restore_mode(&workdir);
    }
    failed
}

impl EmptyDir {
    fn label(&self) -> String {
        self.relative.to_string_lossy().into_owned()
    }

    #[cfg(unix)]
    fn restore_mode(&self, workdir: &Path) {
        use std::os::unix::fs::PermissionsExt;
        if let Some(mode) = self.mode {
            let _ = std::fs::set_permissions(
                workdir.join(&self.relative),
                std::fs::Permissions::from_mode(mode),
            );
        }
    }

    #[cfg(not(unix))]
    fn restore_mode(&self, _workdir: &Path) {}
}

/// Record `directory` and every file-free directory beneath it. Returns whether
/// `directory` itself holds no file anywhere — a subtree can be file-free while
/// its parent is not (`build/logs/` beside `build/out.txt`), and that subtree is
/// just as unrecoverable, so both cases have to be walked.
fn collect_file_free(
    absolute: &Path,
    relative: &Path,
    depth: usize,
    found: &mut Vec<EmptyDir>,
) -> bool {
    if depth >= MAX_WALK_DEPTH {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(absolute) else {
        // Unreadable: treat as holding files rather than claim it is empty, so
        // a directory we cannot inspect is never recreated on a guess.
        return false;
    };

    let mut file_free = true;
    let mut children = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Ok(kind) = entry.file_type() else {
            file_free = false;
            continue;
        };
        // Symlinks are entries git's clean removes as files, never descended
        // into — following one could also walk outside the worktree entirely.
        if !kind.is_dir() {
            file_free = false;
            continue;
        }
        if name == OsStr::new(".git") {
            file_free = false;
            continue;
        }
        let child_absolute = entry.path();
        let child_relative = relative.join(&name);
        if !collect_file_free(&child_absolute, &child_relative, depth + 1, found) {
            file_free = false;
        } else {
            children.push((child_absolute, child_relative));
        }
    }

    for (child_absolute, child_relative) in children {
        found.push(EmptyDir::new(&child_absolute, child_relative));
    }
    if file_free {
        found.push(EmptyDir::new(absolute, relative.to_path_buf()));
    }
    file_free
}

impl EmptyDir {
    #[cfg(unix)]
    fn new(absolute: &Path, relative: PathBuf) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(absolute)
            .ok()
            .map(|meta| meta.permissions().mode());
        Self { relative, mode }
    }

    #[cfg(not(unix))]
    fn new(_absolute: &Path, relative: PathBuf) -> Self {
        Self { relative }
    }
}

/// The shallowest untracked directory of each untracked tree, as git sees it —
/// so `.gitignore` and the user's exclude files decide what is at risk, exactly
/// as they decide what the cleanup will remove.
fn untracked_roots(repo: &str) -> Result<Vec<OsString>, String> {
    let raw = run_git_stdout_raw(
        repo,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "--directory",
            "-z",
        ],
    )?;
    Ok(raw
        .split(|byte| *byte == 0)
        .filter(|entry| entry.ends_with(b"/"))
        .filter_map(|entry| git_path(&entry[..entry.len() - 1]))
        .collect())
}

fn worktree_root(repo: &str) -> Result<PathBuf, String> {
    let raw = run_git_stdout_raw(repo, &["rev-parse", "--show-toplevel"])?;
    let trimmed = raw
        .iter()
        .copied()
        .take_while(|byte| *byte != b'\n' && *byte != b'\r')
        .collect::<Vec<u8>>();
    git_path(&trimmed)
        .map(PathBuf::from)
        .ok_or_else(|| "The repository worktree path could not be read.".to_string())
}

/// A directory git treats as its own repository — `.git` may be a directory
/// (ordinary clone) or a file (linked worktree or submodule).
fn is_nested_repository(candidate: &Path) -> bool {
    std::fs::symlink_metadata(candidate.join(".git")).is_ok()
}

#[cfg(unix)]
fn git_path(bytes: &[u8]) -> Option<OsString> {
    use std::os::unix::ffi::OsStringExt;
    (!bytes.is_empty()).then(|| OsString::from_vec(bytes.to_vec()))
}

#[cfg(not(unix))]
fn git_path(bytes: &[u8]) -> Option<OsString> {
    // A non-UTF-8 path cannot be represented here, so it is left out rather than
    // failing the stash: the cost is one unpreserved directory, not a blocked
    // operation. Unix — where such names actually occur — takes the branch above.
    std::str::from_utf8(bytes)
        .ok()
        .filter(|value| !value.is_empty())
        .map(OsString::from)
}
