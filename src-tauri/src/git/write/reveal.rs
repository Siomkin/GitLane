//! Reveal a worktree path in the OS file manager (Finder / Explorer / …).
//!
//! Paths are validated with the same no-follow worktree guards as destructive
//! writes: a symlink in any ancestor must not redirect Reveal outside the
//! repository. Missing leaves walk up to the nearest existing ancestor that
//! those guards accept (or the worktree root).

use std::io;
use std::path::{Path, PathBuf};

use crate::git::read::open;
use crate::git::worktree_fs::worktree_leaf_exists_nofollow;

use super::path_guards::{normalize_relative, PathVerb};

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
    let relative = normalize_relative(file, PathVerb::Reveal)?;
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
    crate::shell::reveal(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
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

    #[test]
    fn reveal_path_refuses_a_leading_dash_name_without_spawning() {
        let err = reveal_path(Path::new("-dash")).expect_err("relative dash name");
        assert!(err.contains("-dash"), "{err}");
        assert!(reveal_path(Path::new("relative/foo")).is_err());
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
