//! Reveal a worktree path in the OS file manager (Finder / Explorer / …).
//!
//! Paths are validated with the same no-follow worktree guards as destructive
//! writes: a symlink in any ancestor must not redirect Reveal outside the
//! repository. Missing leaves walk up to the nearest existing ancestor that
//! those guards accept (or the worktree root).

use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use crate::git::read::open;
use crate::git::worktree_fs::worktree_leaf_exists_nofollow;

/// Reveal `file` (repo-relative) in the system file manager. The path must stay
/// inside the worktree; `.git` components and ambient symlink escapes are
/// refused. If the leaf is missing (e.g. a discarded/deleted path), the nearest
/// existing parent under the worktree is revealed.
pub fn reveal_in_file_manager(repo: &str, file: &str) -> Result<String, String> {
    let absolute = resolve_reveal_target(repo, file)?;
    reveal_path(&absolute)?;
    Ok(format!("Revealed {}", absolute.display()))
}

fn resolve_reveal_target(repo: &str, file: &str) -> Result<PathBuf, String> {
    let relative = normalize_relative(file)?;
    let repository = open(repo).map_err(|e| e.to_string())?;
    let workdir = repository
        .workdir()
        .ok_or_else(|| "repository has no working directory".to_string())?;

    let mut candidate = relative.as_str();
    loop {
        // Reveal only needs existence + path safety, not a content digest, so this
        // probes metadata no-follow rather than fingerprinting the leaf's bytes.
        match worktree_leaf_exists_nofollow(workdir, candidate) {
            Ok(false) => {
                candidate = match parent_relative(candidate) {
                    Some(parent) => parent,
                    None => return Ok(workdir.to_path_buf()),
                };
            }
            Ok(true) => return Ok(workdir.join(candidate)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                candidate = match parent_relative(candidate) {
                    Some(parent) => parent,
                    None => return Ok(workdir.to_path_buf()),
                };
            }
            // Symlink-in-path / other unsafe opens: walk to the parent so we can
            // still reveal the offending leaf when it itself is a worktree symlink.
            Err(error) => {
                candidate = match parent_relative(candidate) {
                    Some(parent) => parent,
                    None => {
                        return Err(format!("Couldn't reveal {file}: {error}"));
                    }
                };
            }
        }
    }
}

fn normalize_relative(file: &str) -> Result<String, String> {
    if file.is_empty() {
        return Err("Missing path to reveal".to_string());
    }
    let relative = Path::new(file);
    if relative.is_absolute() {
        return Err("Reveal path must be repository-relative".to_string());
    }
    if relative
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!(
            "Refusing to reveal path outside the worktree: {file}"
        ));
    }
    if relative
        .components()
        .any(|c| matches!(c, Component::Normal(name) if name.eq_ignore_ascii_case(".git")))
    {
        return Err(format!(
            "Refusing to reveal path outside the worktree: {file}"
        ));
    }
    let trimmed = file.trim_matches('/');
    if trimmed.is_empty() {
        return Err("Missing path to reveal".to_string());
    }
    Ok(trimmed.to_string())
}

fn parent_relative(path: &str) -> Option<&str> {
    let trimmed = path.trim_matches('/');
    let slash = trimmed.rfind('/')?;
    let parent = &trimmed[..slash];
    if parent.is_empty() {
        None
    } else {
        Some(parent)
    }
}

fn reveal_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .args(["-R"])
            .arg(path)
            .status()
            .map_err(|e| format!("Couldn't open Finder: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("Finder exited with {status}"))
        }
    }

    #[cfg(target_os = "windows")]
    {
        // `explorer /select,` returns non-zero even on success on many Windows
        // builds, so exit status alone is not a reliable failure signal. Refuse
        // only when the process cannot be spawned; otherwise treat as best-effort.
        Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|e| format!("Couldn't open Explorer: {e}"))?
            .wait()
            .map_err(|e| format!("Couldn't wait for Explorer: {e}"))?;
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // `symlink_metadata` (no-follow): a symlink leaf that resolve_reveal_target
        // fell back to must be treated as a file so we open its containing dir,
        // never `xdg-open` the followed target directory outside the worktree.
        let is_directory = std::fs::symlink_metadata(path)
            .map(|meta| meta.is_dir())
            .unwrap_or(false);
        let dir = if is_directory {
            path.to_path_buf()
        } else {
            path.parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| path.to_path_buf())
        };
        let status = Command::new("xdg-open")
            .arg(&dir)
            .status()
            .map_err(|e| format!("Couldn't open file manager: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("File manager exited with {status}"))
        }
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
                "gitlane-reveal-{tag}-{}-{}",
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
    fn resolves_a_worktree_relative_file() {
        let repo = TestRepo::new("ok");
        fs::write(repo.0.join("a.txt"), "x\n").unwrap();
        let absolute = resolve_reveal_target(repo.path(), "a.txt").unwrap();
        // macOS temp paths may be `/var/...` while libgit2 reports `/private/var/...`.
        assert_eq!(
            absolute.canonicalize().unwrap(),
            repo.0.join("a.txt").canonicalize().unwrap()
        );
    }

    #[test]
    fn rejects_parent_dir_and_git_components() {
        let repo = TestRepo::new("bad");
        assert!(resolve_reveal_target(repo.path(), "../outside").is_err());
        assert!(resolve_reveal_target(repo.path(), ".git/config").is_err());
        assert!(resolve_reveal_target(repo.path(), "/abs").is_err());
    }

    #[test]
    fn missing_leaf_walks_to_parent() {
        let repo = TestRepo::new("missing");
        fs::create_dir_all(repo.0.join("src")).unwrap();
        let absolute = resolve_reveal_target(repo.path(), "src/gone.txt").unwrap();
        assert_eq!(
            absolute.canonicalize().unwrap(),
            repo.0.join("src").canonicalize().unwrap()
        );
    }

    #[test]
    fn missing_nested_walks_to_worktree_root() {
        let repo = TestRepo::new("missing-root");
        let absolute = resolve_reveal_target(repo.path(), "no/such/file.txt").unwrap();
        assert_eq!(
            absolute.canonicalize().unwrap(),
            repo.0.canonicalize().unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_follow_an_ancestor_symlink_outside_the_worktree() {
        let repo = TestRepo::new("symlink-escape");
        let outside = std::env::temp_dir().join(format!(
            "gitlane-reveal-outside-{}-{}",
            std::process::id(),
            NEXT_REPO_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret\n").unwrap();
        std::os::unix::fs::symlink(&outside, repo.0.join("escape")).unwrap();

        // Walking through the symlink is refused by worktree_fs; we fall back to
        // revealing the symlink leaf itself (still inside the worktree). Do not
        // canonicalize — that would follow the link out of the repo.
        let absolute = resolve_reveal_target(repo.path(), "escape/secret.txt").unwrap();
        let workdir = git2::Repository::open(&repo.0)
            .unwrap()
            .workdir()
            .unwrap()
            .to_path_buf();
        assert_eq!(absolute, workdir.join("escape"));
        let _ = fs::remove_dir_all(&outside);
    }
}
