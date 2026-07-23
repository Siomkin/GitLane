//! Restore-from-commit write-path tests (ADR 0003).

use super::support::*;

#[test]
fn restore_replaces_worktree_without_staging() {
    let repo = repo_with_file("restore-wt", "a.txt", b"old\n");
    let old = rev_parse(&repo, "HEAD");
    std::fs::write(repo.0.join("a.txt"), "new\n").unwrap();
    repo.git_ok(&["add", "a.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "new"]);
    // Dirty worktree on tip; restore from the older commit.
    std::fs::write(repo.0.join("a.txt"), "dirty\n").unwrap();

    assert!(worktree_differs_from_commit(repo.path(), &old, "a.txt").unwrap());
    let msg = restore_path_from_commit(repo.path(), &old, "a.txt").unwrap();
    assert!(msg.contains("Restored a.txt"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
        "old\n"
    );

    // Index still has tip's "new\n" — restore was worktree-only.
    let staged = repo.git(&["show", ":a.txt"]);
    assert!(staged.status.success());
    assert_eq!(String::from_utf8_lossy(&staged.stdout), "new\n");
    assert!(!worktree_differs_from_commit(repo.path(), &old, "a.txt").unwrap());
}

#[test]
fn restore_reports_false_when_worktree_already_matches() {
    let repo = repo_with_file("restore-match", "a.txt", b"same\n");
    let oid = rev_parse(&repo, "HEAD");
    assert!(!worktree_differs_from_commit(repo.path(), &oid, "a.txt").unwrap());
}

#[test]
fn restore_recreates_a_deleted_worktree_file() {
    let repo = repo_with_file("restore-missing", "a.txt", b"back\n");
    let oid = rev_parse(&repo, "HEAD");
    std::fs::remove_file(repo.0.join("a.txt")).unwrap();
    assert!(worktree_differs_from_commit(repo.path(), &oid, "a.txt").unwrap());
    restore_path_from_commit(repo.path(), &oid, "a.txt").unwrap();
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
        "back\n"
    );
}

#[test]
fn restore_refuses_path_absent_from_commit() {
    let repo = repo_with_file("restore-absent", "a.txt", b"x\n");
    let oid = rev_parse(&repo, "HEAD");
    let err = restore_path_from_commit(repo.path(), &oid, "nope.txt").unwrap_err();
    assert!(err.contains("not present"), "unexpected: {err}");
}

#[test]
fn restore_refuses_unsafe_paths() {
    let repo = repo_with_file("restore-unsafe", "a.txt", b"x\n");
    let oid = rev_parse(&repo, "HEAD");
    assert!(restore_path_from_commit(repo.path(), &oid, "../outside").is_err());
    assert!(restore_path_from_commit(repo.path(), &oid, ".git/config").is_err());
    assert!(worktree_differs_from_commit(repo.path(), &oid, "../outside").is_err());
}

#[test]
fn restore_refuses_a_gitlink_submodule_path() {
    let repo = repo_with_file("restore-gitlink", "seed.txt", b"x\n");
    // Hand-craft a gitlink entry and commit it (same pattern as status tests).
    {
        let git = git2::Repository::open(&repo.0).unwrap();
        let mut index = git.index().unwrap();
        let entry = git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: 0o160000,
            uid: 0,
            gid: 0,
            file_size: 0,
            id: git2::Oid::from_str("0123456789012345678901234567890123456789").unwrap(),
            flags: 0,
            flags_extended: 0,
            path: b"vendor/sub".to_vec(),
        };
        index.add(&entry).unwrap();
        index.write().unwrap();
        let tree = git.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("GitLane Test", "gitlane@example.test").unwrap();
        let parent = git.head().unwrap().peel_to_commit().unwrap();
        git.commit(Some("HEAD"), &sig, &sig, "add gitlink", &tree, &[&parent])
            .unwrap();
    }
    let oid = rev_parse(&repo, "HEAD");
    let err = restore_path_from_commit(repo.path(), &oid, "vendor/sub").unwrap_err();
    assert!(err.contains("submodule"), "unexpected: {err}");
    let err = worktree_differs_from_commit(repo.path(), &oid, "vendor/sub").unwrap_err();
    assert!(err.contains("submodule"), "unexpected: {err}");
}
