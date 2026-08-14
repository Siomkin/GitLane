//! Checking out a remote branch: creating the tracking local branch, and the
//! existing local tips it may fast-forward or leave alone.

use super::super::support::*;

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
