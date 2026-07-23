//! `branches` write-path tests.

use super::support::*;

#[test]
fn create_branch_from_a_remote_tracking_ref_keeps_upstream_setup() {
    let (repo, base) = repo_with_base_commit("create-branch-tracking");
    repo.git_ok(&["update-ref", "refs/remotes/origin/topic", &base]);

    create_branch(repo.path(), "topic", "refs/remotes/origin/topic", &base)
        .expect("create branch from a remote-tracking start point");

    assert_eq!(rev_parse(&repo, "refs/heads/topic"), base);
    // Passing the ref (not its oid) lets `branch.autoSetupMerge` wire tracking.
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["config", "branch.topic.remote"]).stdout).trim(),
        "origin"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["config", "branch.topic.merge"]).stdout).trim(),
        "refs/heads/topic"
    );
}

#[test]
fn create_branch_rejects_a_stale_start_point() {
    let (repo, base) = repo_with_base_commit("create-branch-stale");
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "moved"]);

    assert!(
        create_branch(repo.path(), "pinned", "refs/heads/main", &base).is_err(),
        "a moved start point must fail closed"
    );
    assert!(
        repo.git(&["rev-parse", "--verify", "refs/heads/pinned"])
            .status
            .code()
            != Some(0),
        "no branch may be created from a stale snapshot"
    );
}

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
fn delete_branch_with_worktree_removes_worktree_then_deletes_branch() {
    let repo = TempRepo::new("delete-worktree-branch");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);
    repo.git_ok(&["config", "branch.feature.remote", "origin"]);

    let linked = std::env::temp_dir().join(format!(
        "gitlane-delete-worktree-branch-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);

    // The dialog's checklist depends on these ids firing in this order, one per
    // phase as it begins (GL-107).
    let steps = std::cell::RefCell::new(Vec::new());
    let expected_oid = rev_parse(&repo, "refs/heads/feature");
    let result = delete_branch_with_worktree_previewed(
        repo.path(),
        "feature",
        linked_str,
        &expected_oid,
        &|s| steps.borrow_mut().push(s),
    )
    .expect("delete branch and its worktree");
    assert_eq!(result, "Deleted feature and its worktree");
    assert_eq!(*steps.borrow(), ["removeWorktree", "deleteBranch"]);

    // The branch is gone...
    let branches = repo.git(&["branch", "--list", "feature"]);
    assert!(
        String::from_utf8_lossy(&branches.stdout).trim().is_empty(),
        "feature branch should be deleted"
    );
    // ...and so is the worktree registration (and its directory).
    let worktrees = repo.git(&["worktree", "list", "--porcelain"]);
    let listing = String::from_utf8_lossy(&worktrees.stdout);
    assert!(
        !listing.contains(linked_str),
        "linked worktree should be removed, still in: {listing}"
    );
    assert!(!linked.exists(), "linked worktree directory should be gone");
    assert!(
        !repo
            .git(&["config", "--get", "branch.feature.remote"])
            .status
            .success(),
        "successful deletion must remove branch-specific config"
    );

    let _ = std::fs::remove_dir_all(&linked);
}

#[test]
fn delete_branch_with_worktree_refuses_a_dirty_worktree() {
    let repo = TempRepo::new("delete-worktree-branch-dirty");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);
    repo.git_ok(&["config", "branch.feature.remote", "origin"]);

    let linked = std::env::temp_dir().join(format!(
        "gitlane-delete-worktree-branch-dirty-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);
    // Make the worktree dirty so the (unforced) removal must refuse.
    std::fs::write(linked.join("file.txt"), "edited\n").unwrap();

    let expected_oid = rev_parse(&repo, "refs/heads/feature");
    let err = delete_branch_with_worktree_previewed(
        repo.path(),
        "feature",
        linked_str,
        &expected_oid,
        &|_| {},
    )
    .expect_err("dirty worktree should abort the delete");
    assert!(!err.is_empty(), "expected a git error message");

    // Nothing was destroyed: the branch and worktree both survive.
    let branches = repo.git(&["branch", "--list", "feature"]);
    assert!(
        String::from_utf8_lossy(&branches.stdout).contains("feature"),
        "feature branch must survive a refused delete"
    );
    assert!(linked.exists(), "dirty worktree directory must survive");
    assert_eq!(
        String::from_utf8_lossy(
            &repo
                .git(&["config", "--get", "branch.feature.remote"])
                .stdout
        )
        .trim(),
        "origin",
        "an aborted transaction must preserve branch config"
    );

    // Abort must release the ref lock: once the dirty edit is restored, the
    // exact same preview lease can be retried successfully.
    let restore = Command::new("git")
        .arg("-C")
        .arg(&linked)
        .args(["restore", "file.txt"])
        .output()
        .expect("git restores the linked worktree");
    assert!(restore.status.success());
    delete_branch_with_worktree_previewed(
        repo.path(),
        "feature",
        linked_str,
        &expected_oid,
        &|_| {},
    )
    .expect("retry after abort should acquire the ref lock");
    assert!(!linked.exists());

    let _ = std::fs::remove_dir_all(&linked);
}

#[test]
fn delete_branch_with_worktree_refuses_when_path_no_longer_holds_the_branch() {
    // The frontend's captured path can go stale: an external checkout/detach in
    // the source worktree means it no longer owns the branch. The op must verify
    // against live `git worktree list` and abort — never remove a clean,
    // now-unrelated worktree and then delete the branch anyway.
    let repo = TempRepo::new("delete-worktree-branch-stale");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = std::env::temp_dir().join(format!(
        "gitlane-delete-worktree-branch-stale-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);
    // Simulate the external change: the source worktree detaches off `feature`.
    let detach = Command::new("git")
        .arg("-C")
        .arg(&linked)
        .args(["checkout", "--detach", "-q"])
        .output()
        .expect("git detaches the linked worktree");
    assert!(detach.status.success());

    let expected_oid = rev_parse(&repo, "refs/heads/feature");
    let err = delete_branch_with_worktree_previewed(
        repo.path(),
        "feature",
        linked_str,
        &expected_oid,
        &|_| {},
    )
    .expect_err("a stale worktree path should abort the delete");
    assert!(
        err.contains("feature"),
        "error should name the branch, got: {err}"
    );

    // Both the branch and the (now detached) worktree survive untouched.
    let branches = repo.git(&["branch", "--list", "feature"]);
    assert!(
        String::from_utf8_lossy(&branches.stdout).contains("feature"),
        "feature branch must survive a refused delete"
    );
    assert!(linked.exists(), "the worktree directory must survive");

    let _ = repo.git(&["worktree", "remove", "--force", linked_str]);
    let _ = std::fs::remove_dir_all(&linked);
}

#[test]
fn delete_branch_with_worktree_rejects_a_stale_tip_before_removing_the_worktree() {
    let (repo, expected_oid) = repo_with_base_commit("delete-worktree-stale-tip");
    repo.git_ok(&["branch", "feature", &expected_oid]);
    let linked = std::env::temp_dir().join(format!(
        "gitlane-delete-worktree-stale-tip-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);

    // Advance the checked-out branch after the preview. The worktree is clean,
    // but the old lease must fail during transaction prepare, before removal.
    std::fs::write(linked.join("next.txt"), "next\n").unwrap();
    let commit = Command::new("git")
        .arg("-C")
        .arg(&linked)
        .args(["add", "next.txt"])
        .status()
        .expect("git add launches");
    assert!(commit.success());
    let commit = Command::new("git")
        .arg("-C")
        .arg(&linked)
        .args(["commit", "-q", "-m", "advance feature"])
        .status()
        .expect("git commit launches");
    assert!(commit.success());
    let advanced_oid = rev_parse(&repo, "refs/heads/feature");
    assert_ne!(advanced_oid, expected_oid);

    let err = delete_branch_with_worktree_previewed(
        repo.path(),
        "feature",
        linked_str,
        &expected_oid,
        &|_| {},
    )
    .expect_err("stale branch tip must reject before worktree removal");
    assert!(!err.is_empty());
    assert!(linked.exists(), "stale preview must preserve the worktree");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), advanced_oid);

    let _ = repo.git(&["worktree", "remove", "--force", linked_str]);
    let _ = std::fs::remove_dir_all(&linked);
}

#[test]
fn delete_branch_with_worktree_preserves_a_branch_claimed_after_source_removal() {
    let (repo, expected_oid) = repo_with_base_commit("delete-worktree-claimed-tip");
    repo.git_ok(&["branch", "feature", &expected_oid]);
    repo.git_ok(&["config", "branch.feature.remote", "origin"]);
    let source = std::env::temp_dir().join(format!(
        "gitlane-delete-worktree-claimed-source-{}",
        std::process::id()
    ));
    let claimant = std::env::temp_dir().join(format!(
        "gitlane-delete-worktree-claimed-other-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&source);
    let _ = std::fs::remove_dir_all(&claimant);
    let source_str = source.to_str().unwrap();
    let claimant_str = claimant.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", source_str, "feature"]);
    repo.git_ok(&["worktree", "add", "-q", "--detach", claimant_str, "main"]);

    let switched = std::cell::Cell::new(false);
    let err = delete_branch_with_worktree_previewed(
        repo.path(),
        "feature",
        source_str,
        &expected_oid,
        &|step| {
            if step == "deleteBranch" {
                let output = Command::new("git")
                    .arg("-C")
                    .arg(&claimant)
                    .args(["symbolic-ref", "HEAD", "refs/heads/feature"])
                    .output()
                    .expect("claimant symbolic-ref launches");
                assert!(
                    output.status.success(),
                    "claiming a prepared branch through worktree HEAD failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                switched.set(true);
            }
        },
    )
    .expect_err("a newly claimed branch must be preserved");

    assert!(switched.get());
    assert!(err.contains("preserved branch"), "unexpected error: {err}");
    assert!(
        !source.exists(),
        "the source was already removed at this phase"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), expected_oid);
    assert_eq!(
        String::from_utf8_lossy(
            &Command::new("git")
                .arg("-C")
                .arg(&claimant)
                .args(["branch", "--show-current"])
                .output()
                .expect("claimant branch read launches")
                .stdout
        )
        .trim(),
        "feature"
    );
    assert_eq!(
        String::from_utf8_lossy(
            &repo
                .git(&["config", "--get", "branch.feature.remote"])
                .stdout
        )
        .trim(),
        "origin",
        "preserved branch must keep its config"
    );

    let _ = repo.git(&["worktree", "remove", "--force", claimant_str]);
    let _ = std::fs::remove_dir_all(&source);
    let _ = std::fs::remove_dir_all(&claimant);
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

// The locked half of the combined path's refusal — dirty was already covered,
// but a lock is the other way `requiresForce` goes true, and the combined path
// must never waive it.

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

// Story 24: a stale worktree lease must leave *both* halves alone. The combined
// path prepares a branch-deletion ref transaction before it removes the
// worktree, so a refusal after that point has to abort the transaction too —
// otherwise a stale confirm ends with the branch gone and the worktree still
// there.

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

// The graph's dirty dot: one bit per worktree, on a cheaper probe than the
// removal confirm's counts. What it must *not* dot is the interesting half —
// ignored files are git-disposable, so a worktree holding only a build
// directory is not "unsaved work".

#[test]
fn delete_branch_preview_uses_branch_not_same_named_tag() {
    let repo = TempRepo::new("delete-ambig");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git(&["commit", "-qam", "two"]);
    // Branch `dup` at the first commit, tag `dup` at HEAD. A bare `dup`
    // resolves to the tag (ref precedence); the preview must use the branch.
    repo.git(&["branch", "dup", "HEAD~1"]);
    repo.git(&["tag", "dup", "HEAD"]);
    let branch_tip =
        String::from_utf8(repo.git(&["rev-parse", "--short", "refs/heads/dup"]).stdout).unwrap();
    let branch_tip = branch_tip.trim();

    let preview = preview_delete_branch(repo.path(), "dup").expect("preview");
    assert!(
        preview.details.iter().any(|line| line.contains(branch_tip)),
        "preview must report the branch tip {branch_tip}, not the tag: {:?}",
        preview.details
    );
}

#[test]
fn delete_branch_preview_lists_unmerged_commits() {
    let repo = TempRepo::new("delete-branch-preview");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    // A feature branch with a commit that is not reachable from HEAD (main).
    repo.git(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("f.txt"), b"feature\n").unwrap();
    repo.git(&["commit", "-qam", "feature-work"]);
    repo.git(&["checkout", "-q", "main"]);

    let preview = preview_delete_branch(repo.path(), "feature").expect("preview");
    assert!(preview.summary.contains("feature"));
    assert!(preview
        .details
        .iter()
        .any(|line| line.contains("feature-work")));
    // A non-existent branch fails closed rather than showing an "unknown" tip.
    assert!(preview_delete_branch(repo.path(), "ghost").is_err());
}

#[test]
fn delete_remote_branch_preview_warns_unrecoverable() {
    let (repo, head) = repo_with_base_commit("delete-remote-preview");
    // Seed the remote-tracking ref so rev-parse resolves locally (offline).
    repo.git(&["update-ref", "refs/remotes/origin/main", &head]);

    let preview = preview_delete_remote_branch(repo.path(), "origin", "main").expect("preview");
    assert!(preview.summary.contains("main"));
    assert!(preview.summary.contains("origin"));
    assert!(preview.warnings.iter().any(|line| line.contains("recover")));
}

#[test]
fn set_upstream_writes_tracking_config() {
    let (repo, head) = repo_with_base_commit("set-upstream");
    // `--set-upstream-to` resolves the ref locally; seed it so no network is hit.
    repo.git(&["update-ref", "refs/remotes/origin/main", &head]);

    let result = set_upstream(repo.path(), "main", "origin/main");
    assert!(result.is_ok(), "set_upstream failed: {result:?}");

    let remote = String::from_utf8(repo.git(&["config", "branch.main.remote"]).stdout).unwrap();
    let merge = String::from_utf8(repo.git(&["config", "branch.main.merge"]).stdout).unwrap();
    assert_eq!(remote.trim(), "origin");
    assert_eq!(merge.trim(), "refs/heads/main");
}

#[test]
fn set_upstream_rejects_option_like_operands() {
    let repo = TempRepo::new("set-upstream-inj");
    repo.git(&["init", "-q"]);
    // Both operands flow into git unprefixed, so option-injection must fail
    // before the subprocess runs.
    assert!(set_upstream(repo.path(), "-D", "origin/main").is_err());
    assert!(set_upstream(repo.path(), "main", "--upload-pack=touch /tmp/x").is_err());
}
