//! GitLane's own git commands must not rewrite `.git/index` as a side effect.
//! A read-only `git status` normally refreshes the index's stat cache and
//! writes it back; the repository watcher reports that write as a change, so
//! every status probe would trigger another refresh.

use std::ffi::OsStr;
use std::time::{Duration, SystemTime};

use super::super::cli::{git_command, git_command_bare, run_git};
use super::support::*;

#[test]
fn every_git_command_disables_optional_locks() {
    for command in [
        git_command(".").expect("repository command"),
        git_command_bare(&["--version"]).expect("bare command"),
    ] {
        assert!(
            command.get_envs().any(|(name, value)| {
                name == OsStr::new("GIT_OPTIONAL_LOCKS") && value == Some(OsStr::new("0"))
            }),
            "GIT_OPTIONAL_LOCKS=0 must be set on the git subprocess"
        );
    }
}

#[test]
fn a_status_probe_leaves_the_index_untouched() {
    let repo = repo_with_file("optional-locks-status", "tracked.txt", b"same\n");
    // Same content, newer mtime: the index's stat cache is now stale, which is
    // exactly when a plain `git status` would refresh and rewrite it.
    let later = SystemTime::now() + Duration::from_secs(120);
    std::fs::File::options()
        .write(true)
        .open(repo.0.join("tracked.txt"))
        .unwrap()
        .set_modified(later)
        .unwrap();
    let index = repo.0.join(".git/index");
    let before = std::fs::read(&index).unwrap();
    let before_modified = std::fs::metadata(&index).unwrap().modified().unwrap();

    let status = run_git(repo.path(), &["status", "--porcelain"]).expect("status runs");

    assert_eq!(status, "", "content is unchanged, so the worktree is clean");
    assert_eq!(
        std::fs::read(&index).unwrap(),
        before,
        "the index must not be rewritten"
    );
    assert_eq!(
        std::fs::metadata(&index).unwrap().modified().unwrap(),
        before_modified,
        "the index file must not be replaced"
    );
}
