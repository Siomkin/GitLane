//! Moving a branch between clean worktrees: the detach/checkout sequence, the
//! progress steps it reports, and the state it must not disturb.

use super::super::support::*;

#[test]
fn move_branch_to_worktree_detaches_source_then_checks_out_branch() {
    let repo = TempRepo::new("move-worktree-branch");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = std::env::temp_dir().join(format!(
        "gitlane-move-worktree-branch-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);

    let result = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked_str,
        repo.path(),
        false,
        &|_| {},
    )
    .expect("move branch from linked worktree");
    assert!(
        result.starts_with("Moved feature to "),
        "unexpected message: {result}"
    );

    let current = repo.git(&["branch", "--show-current"]);
    assert_eq!(String::from_utf8_lossy(&current.stdout).trim(), "feature");

    let source_head = Command::new("git")
        .arg("-C")
        .arg(&linked)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .expect("git launches in linked worktree");
    assert!(
        !source_head.status.success(),
        "source worktree should be detached, got {}",
        String::from_utf8_lossy(&source_head.stdout)
    );

    let _ = repo.git(&["worktree", "remove", "--force", linked_str]);
    let _ = std::fs::remove_dir_all(&linked);
}

#[test]
fn move_branch_to_worktree_refuses_when_path_no_longer_holds_the_branch() {
    let repo = TempRepo::new("move-worktree-branch-stale");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = std::env::temp_dir().join(format!(
        "gitlane-move-worktree-branch-stale-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);
    let detach = Command::new("git")
        .arg("-C")
        .arg(&linked)
        .args(["checkout", "--detach", "-q"])
        .output()
        .expect("git detaches the linked worktree");
    assert!(detach.status.success());

    let err = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked_str,
        repo.path(),
        false,
        &|_| {},
    )
    .expect_err("a stale worktree path should abort the move");
    assert!(
        err.contains("feature"),
        "error should name the branch, got: {err}"
    );
    // The current worktree was not switched onto the branch.
    let current = repo.git(&["branch", "--show-current"]);
    assert_eq!(String::from_utf8_lossy(&current.stdout).trim(), "main");

    let _ = repo.git(&["worktree", "remove", "--force", linked_str]);
    let _ = std::fs::remove_dir_all(&linked);
}

#[test]
fn move_branch_to_worktree_reports_progress_steps_in_order() {
    let (repo, linked) = repo_with_feature_worktree("handoff-progress");
    std::fs::write(linked.0.join("file.txt"), "carried\n").unwrap();

    let steps = std::cell::RefCell::new(Vec::new());
    move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|s| steps.borrow_mut().push(s),
    )
    .expect("carry handoff");
    assert_eq!(
        steps.into_inner(),
        vec![
            "stashSource",
            "detach",
            "checkout",
            "applySource",
            "finalize"
        ]
    );
}

#[test]
fn move_branch_to_worktree_leaves_each_worktree_its_own_empty_directories() {
    // The handoff stashes both worktrees, so it inherits the same collateral
    // deletion the Stash action does — twice. Each worktree keeps its own empty
    // directories: they are local filesystem layout, not branch content (git
    // records no empty directory anywhere), so they stay where they were rather
    // than following the branch. The destination case is a plain stash-and-
    // reapply round trip within one worktree; the source keeps the scratch
    // layout of the checkout it goes on being.
    let (repo, linked) = repo_with_feature_worktree("handoff-empty-dirs");
    std::fs::write(linked.0.join("file.txt"), "carried\n").unwrap();
    std::fs::create_dir_all(linked.0.join("source-scratch/deep")).unwrap();
    std::fs::write(repo.0.join("file.txt"), "destination edit\n").unwrap();
    std::fs::create_dir_all(repo.0.join("dest-scratch")).unwrap();

    move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|_| {},
    )
    .expect("carry handoff");

    assert!(
        linked.0.join("source-scratch/deep").is_dir(),
        "the source worktree keeps its own empty directories"
    );
    assert!(
        repo.0.join("dest-scratch").is_dir(),
        "the destination's empty directory survives its own stash round trip"
    );
}
