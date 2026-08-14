//! Commit identity: the pinned card that overrides worktree signing, and the
//! captures a commit must reject.

use super::super::support::*;

#[test]
fn pinned_identity_overrides_worktree_signing_for_gitlane_commits_and_tags() {
    let repo = TempRepo::new("identity-worktree-signing");
    repo.git_ok(&["init", "-q"]);
    set_repo_identity(
        repo.path(),
        "GitLane Author",
        "author@example.test",
        Some(""),
        Some(""),
        Some(false),
        Some(false),
    )
    .expect("set unsigned identity");

    // Worktree config has higher precedence than local config. Without the
    // command-scoped card policy these writes would try to sign with a missing
    // SSH key and both operations would fail.
    repo.git_ok(&["config", "extensions.worktreeConfig", "true"]);
    repo.git_ok(&["config", "--worktree", "gpg.format", "ssh"]);
    repo.git_ok(&[
        "config",
        "--worktree",
        "user.signingkey",
        "/missing/gitlane-signing-key.pub",
    ]);
    repo.git_ok(&["config", "--worktree", "commit.gpgsign", "true"]);
    repo.git_ok(&["config", "--worktree", "tag.gpgsign", "true"]);
    repo.git_ok(&["config", "--worktree", "user.name", "Worktree Override"]);
    repo.git_ok(&[
        "config",
        "--worktree",
        "user.email",
        "worktree-override@example.test",
    ]);

    std::fs::write(repo.0.join("file.txt"), "content\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    let captured_identity = repo_identity(repo.path())
        .expect("read selected identity")
        .expect("selected identity exists");
    super::super::super::commits::commit(
        repo.path(),
        "unsigned by selected card",
        "",
        false,
        Some("GitLane Author"),
        Some("author@example.test"),
        Some(&captured_identity),
        true,
    )
    .expect("card's commit.gpgsign=false overrides worktree config");
    create_annotated_tag(repo.path(), "v1", "release", None)
        .expect("card's tag.gpgsign=false overrides worktree config");
    let tagger = repo.git(&[
        "for-each-ref",
        "--format=%(taggername)|%(taggeremail)",
        "refs/tags/v1",
    ]);
    assert_eq!(
        String::from_utf8_lossy(&tagger.stdout).trim(),
        "GitLane Author|<author@example.test>",
        "annotated tagger must use the selected card, not worktree config"
    );

    let base_branch = String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout)
        .trim()
        .to_string();
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&[
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "feature",
    ]);
    repo.git_ok(&["checkout", "-q", &base_branch]);
    merge(repo.path(), "feature")
        .expect("implicit merge commit uses the selected card's signing policy");
}

#[test]
fn commit_rejects_a_captured_card_when_only_its_signing_policy_changes() {
    let repo = TempRepo::new("identity-stale-commit");
    repo.git_ok(&["init", "-q"]);
    set_repo_identity(
        repo.path(),
        "Shared Author",
        "shared@example.test",
        Some("FIRST-SIGNING-KEY"),
        Some("openpgp"),
        Some(false),
        Some(false),
    )
    .expect("set first identity");
    let first_identity = repo_identity(repo.path())
        .expect("read first identity")
        .expect("first identity exists");

    std::fs::write(repo.0.join("file.txt"), "content\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    set_repo_identity(
        repo.path(),
        "Shared Author",
        "shared@example.test",
        Some("SECOND-SIGNING-KEY"),
        Some("ssh"),
        Some(false),
        Some(false),
    )
    .expect("replace identity before stale commit arrives");

    let error = super::super::super::commits::commit(
        repo.path(),
        "must not use a mixed identity",
        "",
        false,
        Some("Shared Author"),
        Some("shared@example.test"),
        Some(&first_identity),
        true,
    )
    .expect_err("stale captured card must fail closed");
    assert!(error.contains("identity changed"), "{error}");
    assert!(
        !repo
            .git(&["rev-parse", "--verify", "HEAD"])
            .status
            .success(),
        "the rejected operation must not create a commit"
    );
}

#[test]
fn commit_rejects_a_card_applied_after_this_computer_was_captured() {
    let repo = TempRepo::new("identity-default-became-card");
    repo.git_ok(&["init", "-q"]);
    std::fs::write(repo.0.join("file.txt"), "content\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);

    // The composer captured no repo-local identity. A card lands before the
    // commit gets the identity lock; captured absence is still an expectation,
    // not permission to silently use whatever card is current now.
    set_repo_identity(
        repo.path(),
        "Late Card",
        "late@example.test",
        Some(""),
        Some(""),
        Some(false),
        Some(false),
    )
    .expect("apply card after composer snapshot");
    let error = super::super::super::commits::commit(
        repo.path(),
        "must not adopt the late card",
        "",
        false,
        None,
        None,
        None,
        true,
    )
    .expect_err("captured this-computer state must fail closed");
    assert!(error.contains("identity changed"), "{error}");
    assert!(
        !repo
            .git(&["rev-parse", "--verify", "HEAD"])
            .status
            .success(),
        "the rejected operation must not create a commit"
    );
}
