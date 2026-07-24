//! `open_path` write-path tests.
//!
//! Guard coverage only, deliberately. Both commands end in launching something
//! the OS owns — the default app or the user's configured `git difftool` — so a
//! "happy path" test would spawn a real GUI on the test machine. What is
//! asserted here is the refusal contract every caller depends on: the path is
//! worktree-bounded, and difftool never runs against a side that does not
//! exist. The launch itself stays a manual QA step (GL-337).

use super::support::*;

#[test]
fn open_path_default_refuses_paths_outside_the_worktree() {
    let repo = repo_with_file("open-default-escape", "f.txt", b"base\n");

    for escape in ["../outside.txt", "/etc/hosts", ".git/config"] {
        let error = open_path_default(repo.path(), escape)
            .expect_err("worktree escapes must not reach the OS opener");
        assert!(
            error.contains("outside the worktree") || error.contains("repository-relative"),
            "unexpected refusal for {escape}: {error}"
        );
    }
}

#[test]
fn open_path_default_refuses_a_path_that_is_not_on_disk() {
    let repo = repo_with_file("open-default-missing", "f.txt", b"base\n");
    // A staged deletion is exactly the row the menu must not offer this on.
    repo.git_ok(&["rm", "-q", "f.txt"]);

    let error =
        open_path_default(repo.path(), "f.txt").expect_err("a deleted leaf has nothing to open");
    assert!(
        error.contains("is not on disk"),
        "unexpected error: {error}"
    );
}

/// The escape the ancestor guard does not cover: `worktree_leaf_exists_nofollow`
/// answers `true` for a symlink *leaf*, and the OS opener follows it. A repo can
/// commit such a link, so cloning one must not put the user's own files one click
/// away (GL-337 review).
#[cfg(unix)]
#[test]
fn open_path_default_refuses_a_symlink_leaf_pointing_outside_the_worktree() {
    let repo = repo_with_file("open-default-symlink", "f.txt", b"base\n");
    let outside = repo.0.parent().unwrap().join("gitlane-outside-secret.txt");
    std::fs::write(&outside, b"secret\n").unwrap();
    std::os::unix::fs::symlink(&outside, repo.0.join("link.txt")).unwrap();

    let error = open_path_default(repo.path(), "link.txt")
        .expect_err("a symlink leaf must not reach the OS opener");
    assert!(
        error.contains("not a regular file"),
        "unexpected error: {error}"
    );

    // Same leaf, same reason: `diff --no-index` would otherwise inline the
    // target's bytes into the generated patch.
    let patch_error = create_working_tree_patch(repo.path(), "link.txt")
        .expect_err("a symlink leaf must not be read into a patch");
    assert!(
        patch_error.contains("not a regular file"),
        "unexpected error: {patch_error}"
    );

    let _ = std::fs::remove_file(&outside);
}

#[test]
fn open_path_difftool_refuses_before_head_is_born() {
    let repo = TempRepo::new("open-difftool-unborn");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    std::fs::write(repo.0.join("f.txt"), b"new\n").unwrap();

    let error = open_path_difftool(repo.path(), "f.txt")
        .expect_err("there is no HEAD side to diff against yet");
    assert!(error.contains("no HEAD yet"), "unexpected error: {error}");
}

#[test]
fn open_path_difftool_refuses_a_path_in_neither_head_nor_the_index() {
    let repo = repo_with_file("open-difftool-untracked", "f.txt", b"base\n");
    std::fs::write(repo.0.join("untracked.txt"), b"new\n").unwrap();

    let error = open_path_difftool(repo.path(), "untracked.txt")
        .expect_err("an untracked path has no committed or staged side");
    assert!(
        error.contains("is not in HEAD or the index"),
        "unexpected error: {error}"
    );
}

#[test]
fn open_path_difftool_accepts_a_staged_deletion_as_a_head_side() {
    // The inverse of the test above: a staged deletion is gone from the index
    // but still in HEAD, so the guard must let it through (whether the launch
    // then succeeds depends on the user's `diff.tool`, which this does not
    // exercise). Asserted through the guard helper rather than the command so
    // no diff tool is spawned.
    let repo = repo_with_file("open-difftool-staged-delete", "f.txt", b"base\n");
    repo.git_ok(&["rm", "-q", "--cached", "f.txt"]);

    assert!(
        ensure_diffable_against_head(repo.path(), "f.txt").is_ok(),
        "a path still present in HEAD must remain diffable"
    );
}

#[test]
fn open_path_difftool_refuses_paths_outside_the_worktree() {
    let repo = repo_with_file("open-difftool-escape", "f.txt", b"base\n");

    for escape in ["../outside.txt", "/etc/hosts", ".git/config"] {
        let error = open_path_difftool(repo.path(), escape)
            .expect_err("worktree escapes must not reach the diff tool");
        assert!(
            error.contains("outside the worktree") || error.contains("repository-relative"),
            "unexpected refusal for {escape}: {error}"
        );
    }
}
