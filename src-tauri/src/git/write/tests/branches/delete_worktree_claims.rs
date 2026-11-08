//! A branch claimed in the window after its source worktree was removed: the
//! combined deletion must keep the branch.

use super::super::support::*;

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
fn delete_branch_with_worktree_keeps_the_worktree_when_a_rebase_already_holds_the_branch() {
    let (repo, expected_oid) = repo_with_base_commit("delete-worktree-held-first");
    repo.git_ok(&["branch", "feature", &expected_oid]);
    let claimant = repo.0.join("claimant");
    let source = repo.0.join("source");
    let claimant_str = claimant.to_str().unwrap();
    let source_str = source.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", claimant_str, "feature"]);
    let paused = repo.git(&["-C", claimant_str, "rebase", "-x", "false", "--root"]);
    assert!(!paused.status.success(), "the rebase must stop");
    repo.git_ok(&["worktree", "add", "-q", "--force", source_str, "feature"]);

    let err = delete_branch_with_worktree_previewed(
        repo.path(),
        "feature",
        source_str,
        &expected_oid,
        &|_| {},
    )
    .expect_err("the rebase elsewhere must refuse first");

    assert!(err.contains("being rebased"), "unexpected error: {err}");
    assert!(!err.contains("Removed worktree"), "unexpected error: {err}");
    assert!(source.exists(), "the source worktree must survive");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), expected_oid);
}

#[test]
fn delete_branch_with_worktree_preserves_a_branch_rebased_after_source_removal() {
    let (repo, expected_oid) = repo_with_base_commit("delete-worktree-rebased");
    repo.git_ok(&["branch", "feature", &expected_oid]);
    let source = repo.0.join("source");
    let claimant = repo.0.join("claimant");
    let source_str = source.to_str().unwrap();
    let claimant_str = claimant.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", source_str, "feature"]);
    repo.git_ok(&["worktree", "add", "-q", "--detach", claimant_str, "main"]);

    let paused = std::cell::Cell::new(false);
    let err = delete_branch_with_worktree_previewed(
        repo.path(),
        "feature",
        source_str,
        &expected_oid,
        &|step| {
            if step == "deleteBranch" {
                let output = repo.git(&[
                    "-C",
                    claimant_str,
                    "rebase",
                    "-x",
                    "false",
                    "--root",
                    "feature",
                ]);
                paused.set(!output.status.success());
            }
        },
    )
    .expect_err("a branch paused in a rebase must be preserved");

    assert!(paused.get(), "the rebase must stop");
    assert!(
        err.contains("preserved branch") && err.contains("being rebased"),
        "unexpected error: {err}"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), expected_oid);
}
