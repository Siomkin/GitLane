//! Moving a branch when either worktree has work in it: what is carried, what
//! is refused, and how a failed step is rolled back.

use super::super::support::*;
use crate::git::types::OperationKind;

#[test]
fn move_branch_to_worktree_skips_stash_steps_when_clean() {
    let (repo, linked) = repo_with_feature_worktree("handoff-progress-clean");

    let steps = std::cell::RefCell::new(Vec::new());
    move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|s| steps.borrow_mut().push(s),
    )
    .expect("clean handoff");
    assert_eq!(steps.into_inner(), vec!["detach", "checkout", "finalize"]);
}

#[test]
fn move_branch_to_worktree_carries_dirty_source_changes() {
    let (repo, linked) = repo_with_feature_worktree("handoff-carry");
    // The AI-worktree case: uncommitted work in the linked (source) worktree.
    std::fs::write(linked.0.join("file.txt"), "carried\n").unwrap();
    std::fs::write(linked.0.join("new.txt"), "brand new\n").unwrap(); // untracked rides along

    let msg = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|_| {},
    )
    .expect("carry handoff");
    assert!(
        msg.contains("feature"),
        "message should name the branch: {msg}"
    );

    // The destination (main worktree) is now on feature with the carried work.
    let current = repo.git(&["branch", "--show-current"]);
    assert_eq!(String::from_utf8_lossy(&current.stdout).trim(), "feature");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        "carried\n"
    );
    assert!(
        repo.0.join("new.txt").exists(),
        "untracked file should carry"
    );
    // Source worktree left detached; no stashes linger.
    assert!(is_detached(&linked.0), "source worktree should be detached");
    let stashes = repo.git(&["stash", "list"]);
    assert!(
        String::from_utf8_lossy(&stashes.stdout).trim().is_empty(),
        "carry should drop its stashes on success"
    );
}

#[test]
fn move_branch_to_worktree_sees_untracked_files_even_when_status_hides_them() {
    let (repo, linked) = repo_with_feature_worktree("handoff-hidden-untracked");
    repo.git_ok(&["config", "status.showUntrackedFiles", "no"]);
    std::fs::write(linked.0.join("hidden.txt"), "carry me\n").unwrap();

    move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|_| {},
    )
    .expect("explicit porcelain status must see hidden untracked files");

    assert_eq!(
        std::fs::read_to_string(repo.0.join("hidden.txt")).unwrap(),
        "carry me\n"
    );
}

#[test]
fn move_branch_to_worktree_refuses_dirty_source_without_carry() {
    let (repo, linked) = repo_with_feature_worktree("handoff-nocarry");
    std::fs::write(linked.0.join("file.txt"), "dirty\n").unwrap();

    let err = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        false,
        &|_| {},
    )
    .expect_err("a dirty source without carry should be refused");
    assert!(err.contains("uncommitted"), "error should explain: {err}");

    // Nothing moved or stashed: source still on feature, destination still on main.
    assert!(!is_detached(&linked.0), "source must not be detached");
    let current = repo.git(&["branch", "--show-current"]);
    assert_eq!(String::from_utf8_lossy(&current.stdout).trim(), "main");
    let stashes = repo.git(&["stash", "list"]);
    assert!(String::from_utf8_lossy(&stashes.stdout).trim().is_empty());
}

#[test]
fn move_branch_to_worktree_reapplies_dirty_destination() {
    let (repo, linked) = repo_with_feature_worktree("handoff-dirtydest");
    // Destination (main worktree) carries its own uncommitted work on a file that
    // doesn't diverge between branches, so it re-applies cleanly after the switch.
    std::fs::write(repo.0.join("dest-wip.txt"), "dest work\n").unwrap();

    let msg = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|_| {},
    )
    .expect("handoff onto a dirty destination");
    assert!(
        msg.contains("feature"),
        "message should name the branch: {msg}"
    );

    let current = repo.git(&["branch", "--show-current"]);
    assert_eq!(String::from_utf8_lossy(&current.stdout).trim(), "feature");
    // The destination's own prior work survives the switch.
    assert_eq!(
        std::fs::read_to_string(repo.0.join("dest-wip.txt")).unwrap(),
        "dest work\n"
    );
    let stashes = repo.git(&["stash", "list"]);
    assert!(
        String::from_utf8_lossy(&stashes.stdout).trim().is_empty(),
        "a clean re-apply should drop the destination stash"
    );
}

#[test]
fn move_branch_to_worktree_restores_the_source_stash_when_dest_stash_fails() {
    let (repo, linked) = repo_with_feature_worktree("handoff-destfail");
    // Source (linked) is dirty → its changes are stashed first.
    std::fs::write(linked.0.join("file.txt"), "carried\n").unwrap();
    // Destination (main) is dirty → its stash will be attempted, but we sabotage
    // it by holding the destination's index lock: `git status` still reads (so we
    // reach the stash step), but `git stash push` there fails on the lock.
    std::fs::write(repo.0.join("file.txt"), "dest wip\n").unwrap();
    let lock = repo.0.join(".git").join("index.lock");
    std::fs::write(&lock, b"").unwrap();

    let err = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|_| {},
    )
    .expect_err("a failed destination stash should abort the handoff");
    let _ = std::fs::remove_file(&lock); // let the TempRepo Drop clean up
    assert!(!err.is_empty(), "expected a git error, got empty");

    // The source's carried changes were restored (not stranded in a stash), and the
    // structural move never happened.
    assert_eq!(
        std::fs::read_to_string(linked.0.join("file.txt")).unwrap(),
        "carried\n",
        "the source's changes must be restored on rollback"
    );
    assert!(
        !is_detached(&linked.0),
        "source must not be detached after a rollback"
    );
    let current = repo.git(&["branch", "--show-current"]);
    assert_eq!(
        String::from_utf8_lossy(&current.stdout).trim(),
        "main",
        "the destination must not have switched branches"
    );
    let stashes = repo.git(&["stash", "list"]);
    assert!(
        String::from_utf8_lossy(&stashes.stdout).trim().is_empty(),
        "no stash should linger after the rollback"
    );
}

#[test]
fn move_branch_to_worktree_routes_carry_conflict_and_continues() {
    let (repo, _linked, msg) = handoff_into_conflict("handoff-conflict");
    assert!(
        msg.contains("resolve"),
        "message should ask to resolve: {msg}"
    );

    // The conflict surfaces as a "carry" operation (marker + unmerged entries).
    let status = crate::git::conflicts::operation_status(repo.path()).expect("operation status");
    assert_eq!(status.kind, OperationKind::Carry);
    assert!(!status.can_skip);
    assert!(
        status.conflicts.iter().any(|c| c.path == "file.txt"),
        "file.txt should be conflicted: {:?}",
        status.conflicts
    );

    // Resolve + stage the conflict.
    std::fs::write(repo.0.join("file.txt"), "resolved\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    // GL-74 P1: staging the last conflict clears the index conflicts, but the
    // carry must STAY active (its recovery stash is still on the stack) so the
    // frontend's worktree refresh doesn't drop "Finish carry" before it can run.
    let resolved = crate::git::conflicts::operation_status(repo.path()).expect("status resolved");
    assert_eq!(
        resolved.kind,
        OperationKind::Carry,
        "carry must survive resolving the last conflict"
    );
    assert!(
        resolved.conflicts.is_empty(),
        "no conflicts remain once staged"
    );

    // Finish the carry.
    let done = continue_operation(
        repo.path(),
        "carry",
        None,
        None,
        &crate::git::types::CapturedIdentity::NotCaptured,
    )
    .expect("continue carry");
    assert!(
        done.contains("Carried"),
        "unexpected continue message: {done}"
    );

    // Marker cleared (no operation) and the kept stash dropped.
    let after = crate::git::conflicts::operation_status(repo.path()).expect("status after");
    assert_eq!(after.kind, OperationKind::None);
    let stashes = repo.git(&["stash", "list"]);
    assert!(
        String::from_utf8_lossy(&stashes.stdout).trim().is_empty(),
        "continue should drop the kept stash"
    );

    let content_before = std::fs::read_to_string(repo.0.join("file.txt")).unwrap();
    assert!(
        abort_operation(repo.path(), "carry").is_err(),
        "a stale abort after finish must be refused before reset --hard"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        content_before
    );
}

#[test]
fn move_branch_to_worktree_refuses_a_source_with_unresolved_conflicts() {
    let (repo, linked) = repo_with_feature_worktree("handoff-unmerged");
    let l = linked.0.as_path();
    // Leave the linked (source) worktree mid-conflict: commit a change on feature,
    // a divergent one on a sibling, then merge → unresolved conflict on feature.
    std::fs::write(l.join("file.txt"), "AAA\n").unwrap();
    git_ok_at(l, &["commit", "-q", "-am", "A"]);
    git_ok_at(l, &["checkout", "-q", "-b", "sibling", "HEAD~1"]);
    std::fs::write(l.join("file.txt"), "BBB\n").unwrap();
    git_ok_at(l, &["commit", "-q", "-am", "B"]);
    git_ok_at(l, &["checkout", "-q", "feature"]);
    let merge = git_at(l, &["merge", "sibling"]);
    assert!(
        !merge.status.success(),
        "merge should conflict for the test setup"
    );

    let err = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|_| {},
    )
    .expect_err("a source mid-conflict should be refused up front");
    assert!(
        err.contains("unresolved conflicts"),
        "error should explain the conflict, got: {err}"
    );
    // Nothing was stashed or moved by the refused handoff.
    let stashes = repo.git(&["stash", "list"]);
    assert!(String::from_utf8_lossy(&stashes.stdout).trim().is_empty());
}
