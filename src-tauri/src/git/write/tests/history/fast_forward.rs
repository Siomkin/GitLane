//! Fast-forward: the explicit branch it moves, the linked worktree it updates,
//! and the no-ops.

use super::super::support::*;

#[test]
fn fast_forward_and_reset_mutate_only_the_explicit_branch() {
    let (repo, base) = repo_with_base_commit("explicit-fast-forward-reset");
    repo.git_ok(&["branch", "moving"]);
    repo.git_ok(&["checkout", "-q", "-b", "target"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "target"]);
    let target_tip = rev_parse(&repo, "target");
    repo.git_ok(&["checkout", "-q", "-b", "previously-active", &base]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "active"]);
    let active_tip = rev_parse(&repo, "previously-active");

    fast_forward_branch_at(repo.path(), "moving", &base, &target_tip)
        .expect("fast-forward explicit branch");
    assert_eq!(rev_parse(&repo, "moving"), target_tip);
    assert_eq!(rev_parse(&repo, "previously-active"), active_tip);
    assert!(
        fast_forward_branch_at(repo.path(), "moving", &base, &target_tip).is_err(),
        "a stale expected tip must not overwrite the moved branch"
    );

    // Hard-reset lease is of the worktree being reset: check out `moving`
    // before preview so tip preparation does not change the leased state.
    repo.git_ok(&["checkout", "-q", "moving"]);
    let preview = preview_reset(repo.path(), &base, "hard", "moving").expect("hard-reset preview");
    reset_branch(
        repo.path(),
        &base,
        ResetRequest::parse(
            Some("moving"),
            Some(&target_tip),
            "hard",
            preview.expected_state.as_deref(),
            preview.expected_head_branch.as_deref(),
            preview.expected_head_oid.as_deref(),
        )
        .expect("valid reset request"),
    )
    .expect("reset explicit branch");
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "moving"
    );
    assert_eq!(rev_parse(&repo, "moving"), base);
    assert_eq!(rev_parse(&repo, "previously-active"), active_tip);
}

#[test]
fn fast_forward_updates_a_linked_worktree_instead_of_only_its_ref() {
    let (repo, base) = repo_with_base_commit("fast-forward-linked-worktree");
    repo.git_ok(&["branch", "moving"]);
    repo.git_ok(&["checkout", "-q", "-b", "target"]);
    std::fs::write(repo.0.join("target.txt"), "target\n").unwrap();
    repo.git_ok(&["add", "target.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "target"]);
    let target_tip = rev_parse(&repo, "target");
    repo.git_ok(&["checkout", "-q", "main"]);

    let linked = TempRepo::new("fast-forward-linked-owner");
    repo.git_ok(&["worktree", "add", "-q", linked.path(), "moving"]);

    fast_forward_branch_at(repo.path(), "moving", &base, &target_tip)
        .expect("fast-forward in owning worktree");

    assert_eq!(rev_parse(&repo, "moving"), target_tip);
    assert_eq!(rev_parse(&linked, "HEAD"), target_tip);
    assert!(linked.0.join("target.txt").is_file());
    assert!(
        linked.git(&["status", "--porcelain"]).stdout.is_empty(),
        "the owning worktree must stay clean after its branch advances"
    );
}

#[test]
fn fast_forward_refuses_dirty_changes_in_the_owning_worktree() {
    let (repo, base) = repo_with_base_commit("fast-forward-dirty-linked-worktree");
    repo.git_ok(&["branch", "moving"]);
    repo.git_ok(&["checkout", "-q", "-b", "target"]);
    std::fs::write(repo.0.join("f.txt"), "target\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "target"]);
    let target_tip = rev_parse(&repo, "target");
    repo.git_ok(&["checkout", "-q", "main"]);

    let linked = TempRepo::new("fast-forward-dirty-linked-owner");
    repo.git_ok(&["worktree", "add", "-q", linked.path(), "moving"]);
    std::fs::write(linked.0.join("f.txt"), "dirty\n").unwrap();

    fast_forward_branch_at(repo.path(), "moving", &base, &target_tip)
        .expect_err("dirty owning worktree must block fast-forward");

    assert_eq!(rev_parse(&repo, "moving"), base);
    assert_eq!(rev_parse(&linked, "HEAD"), base);
    assert_eq!(
        std::fs::read_to_string(linked.0.join("f.txt")).unwrap(),
        "dirty\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&linked.git(&["status", "--porcelain"]).stdout).trim_end(),
        " M f.txt"
    );
}

#[test]
fn head_guarded_writes_reject_a_different_active_branch() {
    let (repo, base) = repo_with_base_commit("guarded-head-writes");
    repo.git_ok(&["checkout", "-q", "-b", "pick-source"]);
    std::fs::write(repo.0.join("picked.txt"), "picked\n").unwrap();
    repo.git_ok(&["add", "picked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "picked"]);
    let picked = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&["checkout", "-q", "-b", "unexpected"]);
    let unexpected_tip = rev_parse(&repo, "HEAD");
    std::fs::write(repo.0.join("staged.txt"), "staged\n").unwrap();
    repo.git_ok(&["add", "staged.txt"]);

    assert!(cherry_pick_onto(repo.path(), Some("main"), &base, &picked).is_err());
    assert!(revert_onto(repo.path(), Some("main"), &base, &picked).is_err());
    assert!(commit_expected(
        repo.path(),
        Some("main"),
        Some(&base),
        "must not commit",
        "",
        false,
        None,
        None,
        &crate::git::types::CapturedIdentity::NotCaptured,
    )
    .is_err());
    assert_eq!(rev_parse(&repo, "unexpected"), unexpected_tip);
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "unexpected"
    );
}

#[test]
fn fast_forward_is_a_no_op_on_equal_tips() {
    let repo = TempRepo::new("ff-equal-tips");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("file.txt"), b"base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["branch", "-M", "main"]);
    repo.git_ok(&["branch", "feature"]);

    let head_out = repo.git(&["rev-parse", "HEAD"]);
    let head = String::from_utf8_lossy(&head_out.stdout).trim().to_string();

    // The probe now reports equal tips as fast-forwardable (GL-113), so both
    // write paths the menu can dispatch to must treat them as an up-to-date
    // no-op rather than fail: `merge --ff-only` on the checked-out branch and
    // `fetch . <target>:<branch>` on a branch that isn't checked out.
    fast_forward(repo.path(), "feature").expect("ff-only merge of an equal tip succeeds");
    fast_forward_branch(repo.path(), "feature", "main")
        .expect("in-place ff of an equal tip succeeds");

    // Nothing moved: both refs still point at the original commit.
    for rev in ["HEAD", "refs/heads/feature"] {
        let out = repo.git(&["rev-parse", rev]);
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            head,
            "{rev} must be unchanged by a no-op fast-forward"
        );
    }
}

#[test]
fn fast_forward_branch_no_op_when_equal_tip_branch_is_checked_out_in_worktree() {
    let repo = TempRepo::new("ff-equal-linked-worktree");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("file.txt"), b"base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["branch", "-M", "main"]);
    repo.git_ok(&["branch", "feature"]);
    let linked = repo.0.with_file_name(format!(
        "gitlane-ff-equal-linked-worktree-linked-{}",
        std::process::id()
    ));
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);

    let head = rev_parse(&repo, "main");

    let out = fast_forward_branch(repo.path(), "feature", "main")
        .expect("equal-tip branch held by another worktree is already current");

    assert!(out.contains("Already up to date"));
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), head);
    let _ = std::fs::remove_dir_all(linked);
}
