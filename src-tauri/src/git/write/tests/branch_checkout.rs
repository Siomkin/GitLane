//! `branch_checkout` write-path tests.

use super::support::*;

#[test]
fn checkout_branch_intent_never_falls_back_to_restoring_a_same_named_path() {
    let repo = repo_with_file("checkout-intent", "stale-branch", b"original\n");
    std::fs::write(repo.0.join("stale-branch"), b"precious edit\n").unwrap();

    assert!(checkout(repo.path(), "stale-branch", false).is_err());
    assert_eq!(
        std::fs::read_to_string(repo.0.join("stale-branch")).unwrap(),
        "precious edit\n"
    );

    let head = rev_parse(&repo, "HEAD");
    checkout(repo.path(), &head, true).expect("explicit detached checkout");
    assert!(repo.git(&["branch", "--show-current"]).stdout.is_empty());
}

#[test]
fn checkout_remote_branch_creates_tracking_local_branch() {
    let repo = TempRepo::new("checkout-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);

    checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout remote branch");

    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert!(
        head.status.success(),
        "HEAD branch should resolve\nstderr:\n{}",
        String::from_utf8_lossy(&head.stderr),
    );
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
    let upstream = repo.git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    assert!(
        upstream.status.success(),
        "upstream should resolve\nstderr:\n{}",
        String::from_utf8_lossy(&upstream.stderr),
    );
    assert_eq!(
        String::from_utf8_lossy(&upstream.stdout).trim(),
        "origin/feature"
    );
}

#[test]
fn checkout_remote_branch_fast_forwards_existing_local_branch() {
    let repo = TempRepo::new("checkout-existing-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["branch", "feature"]);
    std::fs::write(repo.0.join("ahead.txt"), "ahead\n").unwrap();
    repo.git_ok(&["add", "ahead.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "remote ahead"]);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);

    checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout remote branch");

    assert_eq!(rev_parse(&repo, "HEAD"), rev_parse(&repo, "origin/feature"));
    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
}

#[test]
fn checkout_remote_branch_succeeds_when_existing_local_tip_matches_remote() {
    let repo = TempRepo::new("checkout-equal-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["branch", "feature"]);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);

    checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout equal remote branch");

    assert_eq!(rev_parse(&repo, "HEAD"), rev_parse(&repo, "origin/feature"));
    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
}

#[test]
fn checkout_remote_branch_succeeds_when_existing_local_is_ahead() {
    let repo = TempRepo::new("checkout-local-ahead-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("local.txt"), "local\n").unwrap();
    repo.git_ok(&["add", "local.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local ahead"]);
    let local_tip = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);

    checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout local-ahead branch");

    assert_eq!(rev_parse(&repo, "HEAD"), local_tip);
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), local_tip);
    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
}

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
    assert_eq!(status.kind, "rebase");

    let error = checkout_remote_branch(repo.path(), "origin", "feature")
        .expect_err("paused rebase must block remote checkout");

    assert!(error.contains("rebase operation"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), local_tip);
    let after = crate::git::conflicts::operation_status(repo.path()).expect("operation status");
    assert_eq!(after.kind, "rebase");
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
