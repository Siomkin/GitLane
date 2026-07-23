//! Append a gitignore / exclude pattern from the file context menu.

use std::fs::create_dir_all;
use std::io::Write;
use std::path::{Component, Path};

use crate::git::read::open;
use crate::git::worktree_fs::open_worktree_append_nofollow;

/// Longest ignore pattern we accept from the UI. Real gitignore lines are short;
/// a huge paste is almost certainly accidental or hostile.
const MAX_PATTERN_BYTES: usize = 1024;

/// Append `pattern` to the repo's root `.gitignore` (`local = false`) or
/// `.git/info/exclude` (`local = true`). Creates the file (and `info/` for
/// exclude) when missing. Skips the write when an identical line already exists.
pub fn append_ignore_pattern(repo: &str, pattern: &str, local: bool) -> Result<String, String> {
    let pattern = normalize_pattern(pattern)?;
    let repository = open(repo).map_err(|e| e.to_string())?;
    let workdir = repository
        .workdir()
        .ok_or_else(|| "repository has no working directory".to_string())?;

    // `info/exclude` lives in the common git dir, not the per-worktree git dir —
    // a linked worktree's `repository.path()` is `.git/worktrees/<name>/`, and git
    // does not read an `info/exclude` placed there, so anchor on `commondir()`.
    let ignore_label = if local {
        ".git/info/exclude"
    } else {
        ".gitignore"
    };
    // The ignore file is opened no-follow, rooted at a held directory handle: a
    // repository-controlled `.gitignore` (or `info/exclude`) symlink must not
    // redirect the append outside the worktree. Git never follows a `.gitignore`
    // symlink either.
    let (root, relative) = if local {
        let common = repository.commondir();
        create_dir_all(common.join("info"))
            .map_err(|e| format!("Couldn't create .git/info: {e}"))?;
        (common.to_path_buf(), "info/exclude")
    } else {
        (workdir.to_path_buf(), ".gitignore")
    };

    let (existing, mut file) = open_worktree_append_nofollow(&root, relative)
        .map_err(|e| format!("Couldn't open ignore file: {e}"))?;

    // Compare trimmed lines so `"foo"` and `" foo "` don't both land in the file.
    if existing.lines().any(|line| line.trim() == pattern.as_str()) {
        return Ok(format!("Pattern already present in {ignore_label}"));
    }

    if !existing.is_empty() && !existing.ends_with('\n') {
        file.write_all(b"\n")
            .map_err(|e| format!("Couldn't write ignore file: {e}"))?;
    }
    writeln!(file, "{pattern}").map_err(|e| format!("Couldn't write ignore file: {e}"))?;

    Ok(format!("Added {pattern} to {ignore_label}"))
}

fn normalize_pattern(pattern: &str) -> Result<String, String> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err("Ignore pattern is empty".to_string());
    }
    if trimmed.len() > MAX_PATTERN_BYTES {
        return Err(format!(
            "Ignore pattern is longer than {MAX_PATTERN_BYTES} bytes"
        ));
    }
    if trimmed.contains('\0') || trimmed.contains('\n') || trimmed.contains('\r') {
        return Err("Ignore pattern must be a single line".to_string());
    }
    // A leading `!` negation is allowed (custom patterns); refuse path escape
    // attempts that would be meaningless in gitignore and confusing in the UI.
    if Path::new(trimmed)
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("Ignore pattern must not contain '..'".to_string());
    }
    Ok(trimmed.to_string())
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
                "gitlane-ignore-{tag}-{}-{}",
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
    fn appends_to_gitignore_and_skips_duplicates() {
        let repo = TestRepo::new("gitignore");
        let msg = append_ignore_pattern(repo.path(), "secret.env", false).unwrap();
        assert!(msg.contains("secret.env"));
        let body = fs::read_to_string(repo.0.join(".gitignore")).unwrap();
        assert_eq!(body, "secret.env\n");

        let again = append_ignore_pattern(repo.path(), "secret.env", false).unwrap();
        assert!(again.contains("already present"));
        let body = fs::read_to_string(repo.0.join(".gitignore")).unwrap();
        assert_eq!(body, "secret.env\n");
    }

    #[test]
    fn appends_to_exclude_and_creates_info_dir() {
        let repo = TestRepo::new("exclude");
        let msg = append_ignore_pattern(repo.path(), "/tmp/local.json", true).unwrap();
        assert!(msg.contains(".git/info/exclude"));
        let body = fs::read_to_string(repo.0.join(".git/info/exclude")).unwrap();
        assert!(body.lines().any(|l| l == "/tmp/local.json"));
    }

    #[test]
    fn exclude_from_a_linked_worktree_lands_in_the_common_git_dir() {
        // A linked worktree's git dir is `.git/worktrees/<name>/`, but git only
        // reads `info/exclude` from the common dir — write there, not per-worktree.
        let repo = TestRepo::new("exclude-wt");
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .current_dir(&repo.0)
                .args(args)
                .output()
                .expect("git runs")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "Test"]);
        git(&["commit", "--allow-empty", "-m", "init"]);
        let wt = repo.0.join("wt");
        git(&["worktree", "add", wt.to_str().unwrap()]);

        let msg = append_ignore_pattern(wt.to_str().unwrap(), "/tmp/local.json", true).unwrap();
        assert!(msg.contains(".git/info/exclude"));

        // The pattern belongs to the shared `.git/info/exclude`...
        let common = fs::read_to_string(repo.0.join(".git/info/exclude")).unwrap();
        assert!(common.lines().any(|l| l == "/tmp/local.json"));
        // ...never the per-worktree git dir git would ignore.
        assert!(!repo.0.join(".git/worktrees/wt/info/exclude").exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_append_through_a_symlinked_gitignore() {
        // A crafted repo shipping `.gitignore` as a symlink must not redirect the
        // append outside the worktree — git never follows a `.gitignore` symlink.
        let repo = TestRepo::new("symlink-gitignore");
        let outside = std::env::temp_dir().join(format!(
            "gitlane-ignore-outside-{}-{}",
            std::process::id(),
            NEXT_REPO_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&outside, "victim\n").unwrap();
        std::os::unix::fs::symlink(&outside, repo.0.join(".gitignore")).unwrap();

        let result = append_ignore_pattern(repo.path(), "secret.env", false);
        assert!(result.is_err(), "symlinked .gitignore must be refused");
        // The file the symlink points at is untouched.
        assert_eq!(fs::read_to_string(&outside).unwrap(), "victim\n");
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn rejects_empty_and_multiline_patterns() {
        let repo = TestRepo::new("bad");
        assert!(append_ignore_pattern(repo.path(), "  ", false).is_err());
        assert!(append_ignore_pattern(repo.path(), "a\nb", false).is_err());
        assert!(append_ignore_pattern(repo.path(), "foo/../bar", false).is_err());
    }

    #[test]
    fn preserves_missing_trailing_newline_then_appends() {
        let repo = TestRepo::new("newline");
        fs::write(repo.0.join(".gitignore"), "a").unwrap();
        append_ignore_pattern(repo.path(), "b", false).unwrap();
        let body = fs::read_to_string(repo.0.join(".gitignore")).unwrap();
        assert_eq!(body, "a\nb\n");
    }

    #[test]
    fn treats_whitespace_padded_duplicates_as_already_present() {
        let repo = TestRepo::new("dup-ws");
        fs::write(repo.0.join(".gitignore"), "  secret.env  \n").unwrap();
        let again = append_ignore_pattern(repo.path(), "secret.env", false).unwrap();
        assert!(again.contains("already present"));
        let body = fs::read_to_string(repo.0.join(".gitignore")).unwrap();
        assert_eq!(body, "  secret.env  \n");
    }
}
