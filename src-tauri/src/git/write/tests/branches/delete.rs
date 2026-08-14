//! Deleting a branch: the compare-and-swap on its tip, ref qualification, and
//! the owners that block it.

use super::super::support::*;

#[test]
fn delete_remote_branch_is_qualified_and_pinned_to_the_seen_tip() {
    let repo = repo_with_file("delete-remote-branch", "a.txt", b"one\n");
    repo.git_ok(&["branch", "v1"]);
    repo.git_ok(&["tag", "v1"]);
    let expected = rev_parse(&repo, "refs/heads/v1");
    let remote = TempRepo::new("delete-remote-branch-origin");
    remote.git_ok(&["init", "-q", "--bare"]);
    repo.git_ok(&["remote", "add", "origin", remote.path()]);
    repo.git_ok(&["push", "-q", "origin", "refs/heads/v1", "refs/tags/v1"]);

    // Hostile inherited push config must not widen or replace this operation.
    repo.git_ok(&["config", "push.followTags", "true"]);
    repo.git_ok(&["config", "remote.origin.mirror", "true"]);
    delete_remote_branch(
        repo.path(),
        "origin",
        "v1",
        &expected,
        &TransportCredential::None,
    )
    .expect("delete the exact branch");

    assert!(!remote
        .git(&["show-ref", "--verify", "refs/heads/v1"])
        .status
        .success());
    assert!(remote
        .git(&["show-ref", "--verify", "refs/tags/v1"])
        .status
        .success());

    // Recreate the branch at a newer commit. A delete authorized for the old
    // snapshot must be rejected and preserve the remotely advanced ref.
    repo.git_ok(&[
        "commit",
        "-q",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        "advance",
    ]);
    let advanced = rev_parse(&repo, "HEAD");
    repo.git_ok(&[
        "-c",
        "remote.origin.mirror=false",
        "push",
        "-q",
        "origin",
        "HEAD:refs/heads/v1",
    ]);
    assert!(delete_remote_branch(
        repo.path(),
        "origin",
        "v1",
        &expected,
        &TransportCredential::None,
    )
    .is_err());
    assert_eq!(rev_parse(&remote, "refs/heads/v1"), advanced);
}

#[test]
fn delete_branch_cas_removes_config_but_preserves_a_same_named_tag() {
    let (repo, head) = repo_with_base_commit("delete-branch-cas");
    repo.git_ok(&["branch", "feature", &head]);
    repo.git_ok(&["tag", "feature", &head]);
    repo.git_ok(&["config", "branch.feature.remote", "origin"]);

    let result = delete_branch(repo.path(), "feature", &head, true)
        .expect("exact branch delete should succeed");
    assert_eq!(result, "Deleted feature");
    assert!(
        !repo
            .git(&["show-ref", "--verify", "--quiet", "refs/heads/feature"])
            .status
            .success(),
        "local branch ref must be gone"
    );
    assert!(
        repo.git(&["show-ref", "--verify", "--quiet", "refs/tags/feature"])
            .status
            .success(),
        "same-named tag must survive"
    );
    assert!(
        !repo
            .git(&["config", "--get", "branch.feature.remote"])
            .status
            .success(),
        "branch-specific config must be removed after ref commit"
    );
}

#[test]
fn delete_branch_without_local_config_reports_an_unqualified_success() {
    let (repo, head) = repo_with_base_commit("delete-branch-no-config");
    repo.git_ok(&["branch", "feature", &head]);

    let result = delete_branch(repo.path(), "feature", &head, true)
        .expect("a missing branch config section is already clean");

    assert_eq!(result, "Deleted feature");
}

#[test]
fn delete_branch_cas_rejects_a_tip_changed_after_preview() {
    let (repo, expected_oid) = repo_with_base_commit("delete-branch-stale-tip");
    repo.git_ok(&["branch", "feature", &expected_oid]);
    repo.git_ok(&["config", "branch.feature.remote", "origin"]);
    std::fs::write(repo.0.join("next.txt"), "next\n").unwrap();
    repo.git_ok(&["add", "next.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "next"]);
    let advanced_oid = rev_parse(&repo, "HEAD");
    repo.git_ok(&["update-ref", "refs/heads/feature", &advanced_oid]);

    let err = delete_branch(repo.path(), "feature", &expected_oid, true)
        .expect_err("stale expected oid must reject");
    assert!(!err.is_empty());
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), advanced_oid);
    assert_eq!(
        String::from_utf8_lossy(
            &repo
                .git(&["config", "--get", "branch.feature.remote"])
                .stdout
        )
        .trim(),
        "origin",
        "failed CAS must not clean branch config"
    );
}

#[test]
fn delete_branch_rejects_current_and_linked_worktree_owners() {
    let (repo, head) = repo_with_base_commit("delete-branch-checked-out");
    assert!(delete_branch(repo.path(), "main", &head, true).is_err());
    assert_eq!(rev_parse(&repo, "refs/heads/main"), head);
    assert!(
        !repo.0.join(".git/refs/heads/main.lock").exists(),
        "aborting a prepared deletion must release the current branch lock"
    );

    repo.git_ok(&["branch", "feature", &head]);
    let linked = std::env::temp_dir().join(format!(
        "gitlane-delete-branch-owner-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);
    assert!(delete_branch(repo.path(), "feature", &head, true).is_err());
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), head);
    assert!(
        !repo.0.join(".git/refs/heads/feature.lock").exists(),
        "aborting a prepared deletion must release a linked-worktree branch lock"
    );

    let _ = repo.git(&["worktree", "remove", "--force", linked_str]);
    let _ = std::fs::remove_dir_all(&linked);
}

#[test]
fn delete_branch_rejects_symbolic_and_noncanonical_leases() {
    let (repo, head) = repo_with_base_commit("delete-branch-invalid-lease");
    repo.git_ok(&["branch", "feature", &head]);
    repo.git_ok(&["symbolic-ref", "refs/heads/alias", "refs/heads/feature"]);

    assert!(preview_delete_branch(repo.path(), "alias").is_err());
    assert!(delete_branch(repo.path(), "alias", &head, true).is_err());
    assert_eq!(
        String::from_utf8_lossy(
            &repo
                .git(&["symbolic-ref", "--quiet", "refs/heads/alias"])
                .stdout
        )
        .trim(),
        "refs/heads/feature"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), head);

    for invalid in ["refs/heads/feature".to_string(), format!("{head}\ncommit")] {
        assert!(
            delete_branch(repo.path(), "feature", &invalid, true).is_err(),
            "noncanonical lease {invalid:?} must reject"
        );
    }
    assert!(
        delete_branch(repo.path(), "feature\ncommit", &head, true).is_err(),
        "a branch name must never inject another update-ref protocol command"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), head);
}

#[test]
fn delete_branch_without_force_preserves_unmerged_safety() {
    let (repo, _) = repo_with_base_commit("delete-branch-unmerged");
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "feature"]);
    let feature_oid = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);

    let err = delete_branch(repo.path(), "feature", &feature_oid, false)
        .expect_err("non-force deletion must refuse an unmerged branch");
    assert!(err.contains("not fully merged"), "unexpected error: {err}");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), feature_oid);
    delete_branch(repo.path(), "feature", &feature_oid, true)
        .expect("force deletion may remove the unmerged branch");
}
