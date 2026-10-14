//! Remote checkout that something else blocks: another worktree holding the
//! branch (even one whose directory is gone), or dirty changes on the branch
//! that is already checked out.

use super::super::support::*;
use super::behind_remote;

#[test]
fn checkout_remote_branch_refuses_a_branch_held_by_another_worktree() {
    let repo = TempRepo::new("checkout-remote-held-elsewhere");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");
    repo.git_ok(&["branch", "feature"]);
    std::fs::write(repo.0.join("tracked.txt"), "remote\n").unwrap();
    repo.git_ok(&["commit", "-q", "-am", "remote work"]);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);
    repo.git_ok(&["reset", "-q", "--hard", &base]);
    let linked = repo.0.with_file_name(format!(
        "gitlane-checkout-remote-held-elsewhere-linked-{}",
        std::process::id()
    ));
    repo.git_ok(&["worktree", "add", "-q", linked.to_str().unwrap(), "feature"]);

    let error = checkout_remote_branch(repo.path(), "origin", "feature")
        .expect_err("a branch held by another worktree must refuse");

    assert!(error.contains("another worktree"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), base);
    assert_eq!(rev_parse(&repo, "HEAD"), base);
    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "main");
    assert_eq!(
        std::fs::read_to_string(linked.join("tracked.txt")).unwrap(),
        "base\n"
    );
    assert!(repo.git(&["status", "--porcelain"]).stdout.is_empty());
    let _ = std::fs::remove_dir_all(linked);
}

#[test]
fn checkout_remote_branch_refuses_a_branch_held_by_a_prunable_worktree() {
    let (repo, base, _remote_tip) = behind_remote("checkout-remote-held-prunable");
    let linked = repo.0.with_file_name(format!(
        "gitlane-checkout-remote-held-prunable-linked-{}",
        std::process::id()
    ));
    repo.git_ok(&["worktree", "add", "-q", linked.to_str().unwrap(), "feature"]);
    // An unmounted volume looks the same: the worktree is prunable, but git
    // still refuses to check its branch out anywhere else.
    std::fs::remove_dir_all(&linked).unwrap();

    let error = checkout_remote_branch(repo.path(), "origin", "feature")
        .expect_err("a branch held by a prunable worktree must refuse");

    assert!(error.contains("another worktree"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), base);
    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "main");
}

#[test]
fn checkout_remote_branch_reports_dirty_changes_blocking_the_checked_out_branch() {
    let (repo, base, _remote_tip) = behind_remote("checkout-remote-current-dirty");
    repo.git_ok(&["checkout", "-q", "feature"]);
    std::fs::write(repo.0.join("tracked.txt"), "dirty\n").unwrap();

    let error = checkout_remote_branch(repo.path(), "origin", "feature")
        .expect_err("dirty change must block the fast-forward");

    assert!(
        error.contains("feature is checked out, but it couldn't be updated"),
        "unexpected: {error}"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), base);
    assert_eq!(rev_parse(&repo, "HEAD"), base);
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "dirty\n"
    );
}
