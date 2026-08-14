//! The Worktree Removal Lease inside a combined delete: a dirty, locked, or
//! stale lease leaves both the branch and the worktree in place.

use super::super::support::*;

#[test]
fn delete_branch_with_worktree_refuses_dirty_lease_before_removal() {
    let repo = TempRepo::new("delete-wt-dirty-lease");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = LinkedDir::new("delete-wt-dirty-lease");
    repo.git_ok(&["worktree", "add", "-q", linked.as_str(), "feature"]);
    std::fs::write(linked.0.join("file.txt"), "edited\n").unwrap();

    let expected_oid = rev_parse(&repo, "refs/heads/feature");
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview dirty");
    assert!(preview.requires_force);
    let err = delete_branch_with_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        &expected_oid,
        &preview.expected_state,
        &|_| {},
    )
    .expect_err("combined path must refuse dirty lease");
    assert!(err.contains("cannot force-remove"), "got: {err}");
    assert!(linked.0.exists());
    assert!(
        repo.git(&["show-ref", "--verify", "--quiet", "refs/heads/feature"])
            .status
            .success(),
        "branch must survive"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

#[test]
fn delete_branch_with_worktree_refuses_locked_lease_before_removal() {
    let repo = TempRepo::new("delete-wt-locked-lease");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = LinkedDir::new("delete-wt-locked-lease");
    repo.git_ok(&["worktree", "add", "-q", linked.as_str(), "feature"]);
    repo.git_ok(&["worktree", "lock", linked.as_str()]);

    let expected_oid = rev_parse(&repo, "refs/heads/feature");
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview locked");
    assert!(preview.locked);
    assert!(preview.requires_force);

    let err = delete_branch_with_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        &expected_oid,
        &preview.expected_state,
        &|_| {},
    )
    .expect_err("combined path must refuse a locked lease");
    assert!(err.contains("cannot force-remove"), "got: {err}");
    assert!(linked.0.exists());
    assert!(
        repo.git(&["show-ref", "--verify", "--quiet", "refs/heads/feature"])
            .status
            .success(),
        "branch must survive"
    );
    repo.git_ok(&["worktree", "remove", "--force", "--force", linked.as_str()]);
}

#[test]
fn delete_branch_with_worktree_stale_worktree_lease_keeps_branch_and_worktree() {
    let repo = TempRepo::new("delete-wt-stale-lease");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = LinkedDir::new("delete-wt-stale-lease");
    repo.git_ok(&["worktree", "add", "-q", linked.as_str(), "feature"]);

    let expected_oid = rev_parse(&repo, "refs/heads/feature");
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview clean");
    assert!(!preview.requires_force);

    // Drift after the confirm opened: a new untracked path the lease never saw.
    std::fs::write(linked.0.join("scratch.txt"), "unsaved\n").unwrap();

    let err = delete_branch_with_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        &expected_oid,
        &preview.expected_state,
        &|_| {},
    )
    .expect_err("combined path must refuse a drifted worktree lease");
    assert!(
        err.contains("changed after this confirmation") || err.contains("cannot force-remove"),
        "got: {err}"
    );
    assert!(linked.0.exists(), "the worktree must survive");
    assert!(
        linked.0.join("scratch.txt").exists(),
        "the drifted work must survive"
    );
    assert!(
        repo.git(&["show-ref", "--verify", "--quiet", "refs/heads/feature"])
            .status
            .success(),
        "the branch must survive an aborted combined deletion"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}
