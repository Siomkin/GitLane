//! Combined branch-and-worktree deletion: the order it removes things in, and
//! the drift it refuses before touching either.

use super::super::support::*;

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
