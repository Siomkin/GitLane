//! Aligning a local branch onto an equivalent sibling commit — the same tree
//! reached by a different commit — and everything that must refuse it.

use super::super::support::*;

#[test]
fn checkout_remote_branch_aligns_equivalent_sibling_commit() {
    let repo = TempRepo::new("checkout-equivalent-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");

    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("tracked.txt"), "same result\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local message"]);
    let local_tip = rev_parse(&repo, "HEAD");

    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("tracked.txt"), "same result\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "remote message (#123)"]);
    let remote_tip = rev_parse(&repo, "HEAD");
    assert_ne!(local_tip, remote_tip);
    assert_eq!(
        rev_parse(&repo, "feature^{tree}"),
        rev_parse(&repo, "HEAD^{tree}")
    );
    assert_eq!(rev_parse(&repo, "feature^"), base);
    assert_eq!(rev_parse(&repo, "HEAD^"), base);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);

    checkout_remote_branch(repo.path(), "origin", "feature")
        .expect("equivalent sibling should align to remote commit");

    assert_eq!(rev_parse(&repo, "HEAD"), remote_tip);
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), remote_tip);
    let status = repo.git(&["status", "--short"]);
    assert!(status.status.success());
    assert!(status.stdout.is_empty(), "worktree should stay clean");
}

#[test]
fn checkout_remote_branch_preserves_dirty_state_while_aligning_equivalent_sibling() {
    let repo = TempRepo::new("checkout-dirty-equivalent-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);

    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("tracked.txt"), "committed\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local message"]);
    let local_tip = rev_parse(&repo, "HEAD");
    let tree = rev_parse(&repo, "HEAD^{tree}");
    let parent = rev_parse(&repo, "HEAD^");
    let remote_tip_out = repo.git(&[
        "commit-tree",
        &tree,
        "-p",
        &parent,
        "-m",
        "remote message (#123)",
    ]);
    assert!(remote_tip_out.status.success());
    let remote_tip = String::from_utf8_lossy(&remote_tip_out.stdout)
        .trim()
        .to_string();
    assert_ne!(local_tip, remote_tip);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", &remote_tip]);
    std::fs::write(repo.0.join("tracked.txt"), "staged\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    std::fs::write(repo.0.join("tracked.txt"), "dirty\n").unwrap();
    std::fs::write(repo.0.join("untracked.txt"), "untracked\n").unwrap();

    checkout_remote_branch(repo.path(), "origin", "feature")
        .expect("equivalent sibling should align without resetting files");

    assert_eq!(rev_parse(&repo, "HEAD"), remote_tip);
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "dirty\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("untracked.txt")).unwrap(),
        "untracked\n"
    );
    let indexed = repo.git(&["show", ":tracked.txt"]);
    assert!(indexed.status.success());
    assert_eq!(String::from_utf8_lossy(&indexed.stdout), "staged\n");
    let status = String::from_utf8_lossy(&repo.git(&["status", "--short"]).stdout).to_string();
    assert!(
        status.contains("MM tracked.txt"),
        "unexpected status: {status}"
    );
    assert!(
        status.contains("?? untracked.txt"),
        "unexpected status: {status}"
    );
}

#[test]
fn equivalent_alignment_refuses_a_stale_remote_oid_atomically() {
    let repo = TempRepo::new("checkout-equivalent-remote-race");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("tracked.txt"), "same result\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local"]);
    let local_tip = rev_parse(&repo, "HEAD");
    let tree = rev_parse(&repo, "HEAD^{tree}");
    let classified_remote = repo.git(&["commit-tree", &tree, "-p", &base, "-m", "remote"]);
    assert!(classified_remote.status.success());
    let classified_remote = String::from_utf8_lossy(&classified_remote.stdout)
        .trim()
        .to_string();
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", &base]);

    let error = align_equivalent_sibling(
        repo.path(),
        "refs/heads/feature",
        "refs/remotes/origin/feature",
        &local_tip,
        &classified_remote,
    )
    .expect_err("a moved remote ref must abort the whole transaction");

    assert!(error.contains("cannot lock ref"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), local_tip);
    assert_eq!(rev_parse(&repo, "refs/remotes/origin/feature"), base);
}
