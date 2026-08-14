//! Creating a branch inside a detached linked worktree.

use super::super::support::*;

#[test]
fn create_branch_in_worktree_attaches_the_detached_worktree() {
    let (repo, linked) = repo_with_feature_worktree("wt-create-branch");
    git_ok_at(&linked.0, &["checkout", "-q", "--detach"]);
    let expected_oid = rev_parse(&repo, "feature");

    let message = create_branch_in_worktree(
        repo.path(),
        linked.as_str(),
        "topic/from-detached",
        &expected_oid,
    )
    .expect("create and check out branch in detached worktree");

    assert!(message.contains("topic/from-detached"), "got: {message}");
    let branch = git_at(&linked.0, &["branch", "--show-current"]);
    assert_eq!(
        String::from_utf8_lossy(&branch.stdout).trim(),
        "topic/from-detached"
    );
    assert_eq!(rev_parse(&repo, "topic/from-detached"), expected_oid);
}

#[test]
fn create_branch_in_worktree_rejects_a_stale_detached_head() {
    let (repo, linked) = repo_with_feature_worktree("wt-create-branch-stale");
    git_ok_at(&linked.0, &["checkout", "-q", "--detach"]);
    let expected_oid = rev_parse(&repo, "feature");

    std::fs::write(repo.0.join("later.txt"), "later\n").unwrap();
    repo.git_ok(&["add", "later.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "later"]);
    git_ok_at(&linked.0, &["checkout", "-q", "--detach", "main"]);

    let err = create_branch_in_worktree(repo.path(), linked.as_str(), "topic/stale", &expected_oid)
        .expect_err("stale menu HEAD should be rejected");
    assert!(err.contains("HEAD changed"), "got: {err}");
    assert!(
        !git_at(
            &repo.0,
            &["show-ref", "--verify", "--quiet", "refs/heads/topic/stale"]
        )
        .status
        .success(),
        "the rejected action must not create the branch"
    );
}

#[test]
fn create_branch_in_worktree_rejects_an_attached_worktree() {
    let (repo, linked) = repo_with_feature_worktree("wt-create-branch-attached");
    let expected_oid = rev_parse(&repo, "feature");

    let err = create_branch_in_worktree(
        repo.path(),
        linked.as_str(),
        "topic/already-attached",
        &expected_oid,
    )
    .expect_err("branch-holding worktree should be rejected");
    assert!(err.contains("no longer detached"), "got: {err}");
}
