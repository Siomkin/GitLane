//! Deleting a branch that a worktree holds through a rebase or bisect, not
//! just a checkout.

use super::super::support::*;

#[test]
fn delete_branch_refuses_a_branch_paused_in_a_rebase() {
    let (repo, head) = repo_with_base_commit("delete-branch-rebasing");
    repo.git_ok(&["branch", "feature", &head]);
    let linked = repo.0.join("linked");
    let at = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", at, "feature"]);
    let paused = repo.git(&["-C", at, "rebase", "-x", "false", "--root"]);
    assert!(!paused.status.success(), "the rebase must stop");

    let error = delete_branch(repo.path(), "feature", &head, true)
        .expect_err("a branch under a paused rebase must refuse");

    assert!(
        error.contains("Cannot delete branch") && error.contains("being rebased"),
        "unexpected: {error}"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), head);
    repo.git_ok(&["-C", at, "rebase", "--continue"]);
    assert_eq!(
        repo.git(&["-C", at, "symbolic-ref", "HEAD"]).stdout,
        b"refs/heads/feature\n",
        "the rebase must finish back on its branch"
    );
}

#[test]
fn delete_branch_refuses_a_branch_rebasing_in_the_main_worktree() {
    let (repo, head) = repo_with_base_commit("delete-branch-main-rebasing");
    repo.git_ok(&["switch", "-q", "-c", "feature"]);
    let linked = repo.0.join("linked");
    let at = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", "--detach", at, "main"]);
    let paused = repo.git(&["rebase", "-x", "false", "--root"]);
    assert!(!paused.status.success(), "the rebase must stop");

    let error =
        delete_branch(at, "feature", &head, true).expect_err("the main worktree holds the branch");

    assert!(error.contains("being rebased"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), head);
}

#[test]
fn delete_branch_refuses_a_branch_queued_by_update_refs() {
    let (repo, _) = repo_with_base_commit("delete-branch-update-refs");
    repo.git_ok(&["switch", "-q", "-c", "top"]);
    let mut tips = Vec::new();
    for subject in ["one", "two"] {
        std::fs::write(repo.0.join("f.txt"), subject).unwrap();
        repo.git_ok(&["add", "f.txt"]);
        repo.git_ok(&["commit", "-qm", subject]);
        tips.push(rev_parse(&repo, "HEAD"));
    }
    repo.git_ok(&["branch", "feature", &tips[0]]);
    let paused = repo.git(&["rebase", "-x", "false", "--update-refs", "main"]);
    assert!(!paused.status.success(), "the rebase must stop");
    assert!(repo.0.join(".git/rebase-merge/update-refs").exists());

    let error = delete_branch(repo.path(), "feature", &tips[0], true)
        .expect_err("a branch queued by the rebase must refuse");

    assert!(error.contains("being rebased"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), tips[0]);
}

#[test]
fn delete_branch_works_from_a_subdirectory() {
    let (repo, head) = repo_with_base_commit("delete-branch-subdirectory");
    repo.git_ok(&["branch", "feature", &head]);
    let sub = repo.0.join("nested/dir");
    std::fs::create_dir_all(&sub).unwrap();

    delete_branch(sub.to_str().unwrap(), "feature", &head, true).expect("delete");

    assert!(!repo
        .git(&["rev-parse", "--verify", "-q", "refs/heads/feature"])
        .status
        .success());
}

#[test]
fn delete_branch_refuses_a_branch_being_bisected() {
    let (repo, head) = repo_with_base_commit("delete-branch-bisecting");
    repo.git_ok(&["branch", "feature", &head]);
    let linked = repo.0.join("linked");
    let at = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", at, "feature"]);
    repo.git_ok(&["-C", at, "bisect", "start"]);
    repo.git_ok(&["-C", at, "checkout", "-q", "--detach"]);

    let error = delete_branch(repo.path(), "feature", &head, true)
        .expect_err("a branch under a bisect must refuse");

    assert!(
        error.contains("Cannot delete branch") && error.contains("being bisected"),
        "unexpected: {error}"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), head);
}
