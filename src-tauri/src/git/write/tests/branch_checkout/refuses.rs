//! When checking out a remote branch must refuse: an active merge, a paused
//! rebase, a diverged local branch, or dirty changes blocking the
//! fast-forward.

use super::super::support::*;
use crate::git::types::OperationKind;

#[test]
fn checkout_remote_branch_refuses_same_tree_with_different_parents() {
    let repo = TempRepo::new("checkout-same-tree-different-parents");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");
    let base_tree = rev_parse(&repo, "HEAD^{tree}");
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("tracked.txt"), "same result\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local"]);
    let local_tip = rev_parse(&repo, "HEAD");
    let feature_tree = rev_parse(&repo, "HEAD^{tree}");

    let alternate_parent = repo.git(&[
        "commit-tree",
        &base_tree,
        "-p",
        &base,
        "-m",
        "alternate parent",
    ]);
    assert!(alternate_parent.status.success());
    let alternate_parent = String::from_utf8_lossy(&alternate_parent.stdout)
        .trim()
        .to_string();
    let remote_tip = repo.git(&[
        "commit-tree",
        &feature_tree,
        "-p",
        &alternate_parent,
        "-m",
        "remote",
    ]);
    assert!(remote_tip.status.success());
    let remote_tip = String::from_utf8_lossy(&remote_tip.stdout)
        .trim()
        .to_string();
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", &remote_tip]);

    let error = checkout_remote_branch(repo.path(), "origin", "feature")
        .expect_err("same tree with different parents must remain divergent");

    assert!(error.contains("have diverged"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "HEAD"), local_tip);
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), local_tip);
}

#[test]
fn checkout_remote_branch_refuses_during_an_active_merge() {
    let repo = TempRepo::new("checkout-equivalent-during-merge");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local"]);
    let local_tip = rev_parse(&repo, "HEAD");
    let tree = rev_parse(&repo, "HEAD^{tree}");
    let remote_tip = repo.git(&["commit-tree", &tree, "-p", &base, "-m", "remote"]);
    assert!(remote_tip.status.success());
    let remote_tip = String::from_utf8_lossy(&remote_tip.stdout)
        .trim()
        .to_string();
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", &remote_tip]);

    repo.git_ok(&["checkout", "-q", "-b", "merge-source", &base]);
    std::fs::write(repo.0.join("merge.txt"), "merge\n").unwrap();
    repo.git_ok(&["add", "merge.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "merge source"]);
    repo.git_ok(&["checkout", "-q", "feature"]);
    repo.git_ok(&["merge", "-q", "--no-commit", "--no-ff", "merge-source"]);
    let merge_head = rev_parse(&repo, "MERGE_HEAD");

    let error = checkout_remote_branch(repo.path(), "origin", "feature")
        .expect_err("active merge must block remote checkout");

    assert!(error.contains("merge operation"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "HEAD"), local_tip);
    assert_eq!(rev_parse(&repo, "MERGE_HEAD"), merge_head);
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), local_tip);
}

#[test]
fn checkout_remote_branch_refuses_during_a_paused_rebase() {
    let repo = TempRepo::new("checkout-equivalent-during-rebase");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local"]);
    let local_tip = rev_parse(&repo, "HEAD");
    let tree = rev_parse(&repo, "HEAD^{tree}");
    let remote_tip = repo.git(&["commit-tree", &tree, "-p", &base, "-m", "remote"]);
    assert!(remote_tip.status.success());
    let remote_tip = String::from_utf8_lossy(&remote_tip.stdout)
        .trim()
        .to_string();
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", &remote_tip]);

    repo.git_ok(&["checkout", "-q", "-b", "onto", &base]);
    std::fs::write(repo.0.join("onto.txt"), "onto\n").unwrap();
    repo.git_ok(&["add", "onto.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "onto"]);
    repo.git_ok(&["checkout", "-q", "feature"]);
    let paused = repo.git(&["rebase", "--exec", "false", "onto"]);
    assert!(
        !paused.status.success(),
        "rebase should pause at the exec step"
    );
    let status = crate::git::conflicts::operation_status(repo.path()).expect("operation status");
    assert_eq!(status.kind, OperationKind::Rebase);

    let error = checkout_remote_branch(repo.path(), "origin", "feature")
        .expect_err("paused rebase must block remote checkout");

    assert!(error.contains("rebase operation"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), local_tip);
    let after = crate::git::conflicts::operation_status(repo.path()).expect("operation status");
    assert_eq!(after.kind, OperationKind::Rebase);
}

#[test]
fn checkout_remote_branch_refuses_diverged_existing_local_branch() {
    let repo = TempRepo::new("checkout-diverged-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("local.txt"), "local\n").unwrap();
    repo.git_ok(&["add", "local.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local work"]);
    let local_tip = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("remote.txt"), "remote\n").unwrap();
    repo.git_ok(&["add", "remote.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "remote work"]);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);
    let previous_head = rev_parse(&repo, "HEAD");

    let error = checkout_remote_branch(repo.path(), "origin", "feature")
        .expect_err("diverged branch must refuse fast-forward checkout");

    assert!(error.contains("have diverged"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), local_tip);
    assert_eq!(rev_parse(&repo, "HEAD"), previous_head);
    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "main");
}

#[test]
fn checkout_remote_branch_reports_switch_when_dirty_changes_block_fast_forward() {
    let repo = TempRepo::new("checkout-dirty-remote-branch");
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
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "remote work"]);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);
    repo.git_ok(&["checkout", "-q", "-b", "other", &base]);
    std::fs::write(repo.0.join("tracked.txt"), "dirty\n").unwrap();

    let error = checkout_remote_branch(repo.path(), "origin", "feature")
        .expect_err("dirty change must block the fast-forward merge");

    assert!(
        error.contains("feature is checked out"),
        "unexpected: {error}"
    );
    assert!(
        error.contains("couldn't be fast-forwarded"),
        "unexpected: {error}"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), base);
    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "dirty\n"
    );
}
