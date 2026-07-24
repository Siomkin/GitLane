//! Open a worktree path with the OS default app or `git difftool`.
//!
//! Paths use the same no-follow worktree guards as Reveal: a symlink in any
//! ancestor must not redirect outside the repository. Opening goes one step
//! further than Reveal and refuses a symlink *leaf* too — the OS opener follows
//! it, so unlike a git-mediated read it would reach the link's target.

use std::path::{Component, Path, PathBuf};
#[cfg(not(target_os = "windows"))]
use std::process::Command;

use crate::git::read::open;
use crate::git::worktree_fs::{open_worktree_file, worktree_leaf_exists_nofollow};

use super::cli::{run_git, run_git_literal_paths};

/// Open `file` (repo-relative) with the OS default application. The leaf must
/// exist inside the worktree; missing/deleted paths and symlink escapes fail.
pub fn open_path_default(repo: &str, file: &str) -> Result<String, String> {
    let absolute = resolve_existing_leaf(repo, file)?;
    open_default(&absolute)?;
    Ok(format!("Opened {}", absolute.display()))
}

/// Open `file` in the configured `git difftool` against HEAD
/// (`git difftool --no-prompt HEAD -- <path>`). Requires `diff.tool` (or
/// `diff.guitool`). The path must exist in HEAD or the index so staged
/// additions and deletions both have a side to compare.
pub fn open_path_difftool(repo: &str, file: &str) -> Result<String, String> {
    let relative = normalize_relative(file)?;
    ensure_diffable_against_head(repo, &relative)?;
    let tool = configured_diff_tool(repo)?;
    // Explicit HEAD base so a fully-staged modification (index == worktree)
    // still opens a meaningful diff, unlike the default index↔worktree mode.
    run_git_literal_paths(repo, &["difftool", "--no-prompt", "HEAD", "--", &relative])?;
    Ok(format!("Opened {relative} in {tool}"))
}

fn configured_diff_tool(repo: &str) -> Result<String, String> {
    for key in ["diff.tool", "diff.guitool"] {
        if let Ok(value) = run_git(repo, &["config", "--get", key]) {
            let tool = value.trim();
            if !tool.is_empty() {
                return Ok(tool.to_string());
            }
        }
    }
    Err(
        "No diff tool configured. Set `git config diff.tool <name>` (for example `opendiff` or `vscode`)."
            .to_string(),
    )
}

pub(super) fn ensure_diffable_against_head(repo: &str, file: &str) -> Result<(), String> {
    if !has_head(repo) {
        return Err(
            "Diff tool needs a commit to compare against; this repository has no HEAD yet."
                .to_string(),
        );
    }
    // Staged deletions leave the index; HEAD still has the blob. Staged new
    // files are the inverse — index has them, HEAD does not.
    if path_in_head(repo, file) || path_in_index(repo, file) {
        return Ok(());
    }
    Err(format!("{file} is not in HEAD or the index"))
}

fn has_head(repo: &str) -> bool {
    run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
}

fn path_in_head(repo: &str, file: &str) -> bool {
    // `HEAD:path` must be passed as one rev; literal-pathspecs is irrelevant
    // here and `cat-file -e` is the cheap existence probe.
    run_git(
        repo,
        &[
            "--literal-pathspecs",
            "cat-file",
            "-e",
            &format!("HEAD:{file}"),
        ],
    )
    .is_ok()
}

fn path_in_index(repo: &str, file: &str) -> bool {
    run_git_literal_paths(repo, &["ls-files", "--error-unmatch", "--", file]).is_ok()
}

fn resolve_existing_leaf(repo: &str, file: &str) -> Result<PathBuf, String> {
    let relative = normalize_relative(file)?;
    let repository = open(repo).map_err(|e| e.to_string())?;
    let workdir = repository
        .workdir()
        .ok_or_else(|| "repository has no working directory".to_string())?;
    match worktree_leaf_exists_nofollow(workdir, &relative) {
        Ok(true) => {
            ensure_regular_leaf(workdir, &relative)?;
            Ok(workdir.join(&relative))
        }
        Ok(false) => Err(format!("{relative} is not on disk")),
        Err(error) => Err(format!("Couldn't open {relative}: {error}")),
    }
}

/// Refuse a leaf that is not a regular file. [`worktree_leaf_exists_nofollow`]
/// blocks a symlink in any *ancestor*, but it is existence-only about the leaf
/// itself: a symlink there answers `true`. That is safe for git-mediated reads
/// (git diffs a symlink as its link text) and unsafe here, because the OS
/// opener — `open`, `xdg-open`, `ShellExecuteW` — follows it, so a committed
/// `link -> /etc/passwd` would open a file outside the repository. Cloning a
/// repository must never expose the user's own files to one click.
///
/// `open_worktree_file` is the existing no-follow gate for this (it answers
/// `None` for anything that is not a regular file); the handle it returns is
/// dropped immediately — only the verdict is wanted.
fn ensure_regular_leaf(workdir: &Path, relative: &str) -> Result<(), String> {
    match open_worktree_file(workdir, relative) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(format!(
            "Refusing to open {relative}: not a regular file. Symlinks and special files can point outside the worktree."
        )),
        Err(error) => Err(format!("Couldn't open {relative}: {error}")),
    }
}

fn normalize_relative(file: &str) -> Result<String, String> {
    if file.is_empty() {
        return Err("Missing path to open".to_string());
    }
    let relative = Path::new(file);
    if relative.is_absolute() {
        return Err("Open path must be repository-relative".to_string());
    }
    if relative
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!(
            "Refusing to open path outside the worktree: {file}"
        ));
    }
    if relative
        .components()
        .any(|c| matches!(c, Component::Normal(name) if name.eq_ignore_ascii_case(".git")))
    {
        return Err(format!(
            "Refusing to open path outside the worktree: {file}"
        ));
    }
    let trimmed = file.trim_matches('/');
    if trimmed.is_empty() {
        return Err("Missing path to open".to_string());
    }
    Ok(trimmed.to_string())
}

fn open_default(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg(path)
            .status()
            .map_err(|e| format!("Couldn't open file: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("open exited with {status}"))
        }
    }

    #[cfg(target_os = "windows")]
    {
        // ShellExecuteW opens via the file association without routing through
        // `cmd.exe`, so repository-controlled filenames containing `&` / `|`
        // cannot inject extra commands (GL-337 review).
        open_default_windows(path)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let status = Command::new("xdg-open")
            .arg(path)
            .status()
            .map_err(|e| format!("Couldn't open file: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("xdg-open exited with {status}"))
        }
    }
}

#[cfg(target_os = "windows")]
fn open_default_windows(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    // ShellExecuteW returns a value > 32 on success (HINSTANCE cast to pointer).
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as usize > 32 {
        Ok(())
    } else {
        Err(format!(
            "Couldn't open file (ShellExecuteW returned {})",
            result as usize
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_REPO_ID: AtomicU64 = AtomicU64::new(0);

    struct TestRepo(PathBuf);

    impl TestRepo {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "gitlane-open-path-{tag}-{}-{}",
                std::process::id(),
                NEXT_REPO_ID.fetch_add(1, Ordering::Relaxed)
            ));
            git2::Repository::init(&path).expect("test repository should initialize");
            Self(path)
        }

        fn path(&self) -> &str {
            self.0.to_str().expect("utf-8 path")
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn resolves_an_existing_leaf() {
        let repo = TestRepo::new("ok");
        fs::write(repo.0.join("a.txt"), "x\n").unwrap();
        let absolute = resolve_existing_leaf(repo.path(), "a.txt").unwrap();
        assert_eq!(
            absolute.canonicalize().unwrap(),
            repo.0.join("a.txt").canonicalize().unwrap()
        );
    }

    #[test]
    fn rejects_missing_and_unsafe_paths() {
        let repo = TestRepo::new("bad");
        assert!(resolve_existing_leaf(repo.path(), "gone.txt").is_err());
        assert!(normalize_relative("../outside").is_err());
        assert!(normalize_relative(".git/config").is_err());
        assert!(normalize_relative("/abs").is_err());
    }

    #[test]
    fn resolves_filenames_with_shell_metacharacters() {
        // Regression for the Windows cmd-injection class: the path must be
        // accepted as a literal worktree leaf, never parsed by a shell.
        let repo = TestRepo::new("meta");
        let name = "a&b|c.txt";
        fs::write(repo.0.join(name), "x\n").unwrap();
        let absolute = resolve_existing_leaf(repo.path(), name).unwrap();
        assert_eq!(
            absolute.canonicalize().unwrap(),
            repo.0.join(name).canonicalize().unwrap()
        );
    }
}
