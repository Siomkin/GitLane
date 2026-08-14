//! Rebase: the explicit source it uses instead of whatever is active.

use super::super::support::*;

#[test]
fn rebase_uses_explicit_source_instead_of_previously_active_branch() {
    let repo = TempRepo::new("rebase-explicit-source");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);

    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "feature work"]);

    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("main.txt"), "main\n").unwrap();
    repo.git_ok(&["add", "main.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "main work"]);
    let main_tip = rev_parse(&repo, "main");

    repo.git_ok(&["checkout", "-q", "-b", "previously-active"]);
    std::fs::write(repo.0.join("active.txt"), "active\n").unwrap();
    repo.git_ok(&["add", "active.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "previously active work"]);
    let active_tip = rev_parse(&repo, "previously-active");

    let feature_tip = rev_parse(&repo, "feature");
    rebase(repo.path(), "feature", &feature_tip, &main_tip)
        .expect("rebase explicit source onto main");

    let head = repo.git(&["branch", "--show-current"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
    assert_eq!(rev_parse(&repo, "feature^"), main_tip);
    assert_eq!(rev_parse(&repo, "previously-active"), active_tip);
    let active_is_feature_ancestor = repo.git(&[
        "merge-base",
        "--is-ancestor",
        "previously-active",
        "feature",
    ]);
    assert!(
        !active_is_feature_ancestor.status.success(),
        "the previously active branch must not become the rebase target"
    );
}

#[test]
fn rebase_keeps_detached_head_support_with_an_explicit_source() {
    let repo = TempRepo::new("rebase-detached-source");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);

    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");

    repo.git_ok(&["checkout", "-q", "--detach", &base]);
    std::fs::write(repo.0.join("detached.txt"), "detached\n").unwrap();
    repo.git_ok(&["add", "detached.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "detached work"]);
    let detached_tip = rev_parse(&repo, "HEAD");

    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("main.txt"), "main\n").unwrap();
    repo.git_ok(&["add", "main.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "main work"]);
    let main_tip = rev_parse(&repo, "main");
    repo.git_ok(&["checkout", "-q", "--detach", &detached_tip]);

    rebase(repo.path(), "HEAD", &detached_tip, &main_tip).expect("rebase detached HEAD onto main");

    let head = repo.git(&["branch", "--show-current"]);
    assert!(head.status.success());
    assert!(head.stdout.is_empty(), "HEAD should remain detached");
    assert_eq!(rev_parse(&repo, "HEAD^"), main_tip);
    let message = repo.git(&["log", "-1", "--format=%s"]);
    assert!(message.status.success());
    assert_eq!(
        String::from_utf8_lossy(&message.stdout).trim(),
        "detached work"
    );
}

#[test]
fn rebase_explicit_source_prefers_a_local_branch_over_same_named_tag() {
    let repo = TempRepo::new("rebase-ambiguous-source");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);

    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["tag", "feature"]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "feature work"]);

    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("main.txt"), "main\n").unwrap();
    repo.git_ok(&["add", "main.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "main work"]);
    let main_tip = rev_parse(&repo, "main");

    let feature_tip = rev_parse(&repo, "refs/heads/feature");
    rebase(repo.path(), "feature", &feature_tip, &main_tip)
        .expect("rebase the branch, not its tag");

    let head = repo.git(&["branch", "--show-current"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
    assert_eq!(rev_parse(&repo, "refs/heads/feature^"), main_tip);
}
