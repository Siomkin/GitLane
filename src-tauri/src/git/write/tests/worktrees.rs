//! `worktrees` write-path tests.

use super::support::*;

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

// ---- GL-74 worktree handoff: carry + destination picker + conflict routing ----

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
    assert_eq!(status.kind, "carry");
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
        resolved.kind, "carry",
        "carry must survive resolving the last conflict"
    );
    assert!(
        resolved.conflicts.is_empty(),
        "no conflicts remain once staged"
    );

    // Finish the carry.
    let done =
        continue_operation(repo.path(), "carry", None, None, None, false).expect("continue carry");
    assert!(
        done.contains("Carried"),
        "unexpected continue message: {done}"
    );

    // Marker cleared (no operation) and the kept stash dropped.
    let after = crate::git::conflicts::operation_status(repo.path()).expect("status after");
    assert_eq!(after.kind, "none");
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

#[test]
fn worktrees_flags_bare_and_prunable_targets_and_handoff_refuses_a_bare_destination() {
    // The bare-repo + per-branch-worktree layout: `git worktree list` reports the
    // bare repo (no working tree) and any prunable (deleted) worktree. Neither can
    // receive a branch checkout, so `worktrees()` must flag them and the handoff
    // must refuse a bare destination up front (before detaching the source).
    let seed = TempRepo::new("wt-attrs-seed");
    seed.git_ok(&["init", "-q"]);
    seed.git_ok(&["config", "user.name", "GitLane Test"]);
    seed.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(seed.0.join("f.txt"), "x\n").unwrap();
    seed.git_ok(&["add", "f.txt"]);
    seed.git_ok(&["commit", "-q", "-m", "init"]);
    seed.git_ok(&["branch", "feature"]);

    let bare = TempRepo::new("wt-attrs-bare");
    let clone = Command::new("git")
        .args(["clone", "-q", "--bare", seed.path(), bare.path()])
        .output()
        .expect("git clone --bare");
    assert!(
        clone.status.success(),
        "bare clone failed: {}",
        String::from_utf8_lossy(&clone.stderr)
    );

    let linked = LinkedDir::new("wt-attrs-linked");
    git_ok_at(
        bare.0.as_path(),
        &["worktree", "add", "-q", linked.as_str(), "feature"],
    );
    let gone = LinkedDir::new("wt-attrs-gone");
    git_ok_at(
        bare.0.as_path(),
        &["worktree", "add", "-q", "--detach", gone.as_str()],
    );
    std::fs::remove_dir_all(&gone.0).unwrap(); // now prunable

    let list = worktrees(bare.path()).expect("list worktrees");
    let main_entry = list.iter().find(|w| w.is_main).expect("main entry");
    assert!(main_entry.bare, "the bare main should be flagged bare");
    let feature = list
        .iter()
        .find(|w| w.branch.as_deref() == Some("feature"))
        .expect("feature worktree");
    assert!(
        !feature.bare && !feature.prunable,
        "the linked feature worktree is a valid target"
    );
    assert!(
        list.iter().any(|w| w.prunable),
        "the deleted worktree should be flagged prunable"
    );

    // Handing the feature branch off *into the bare repo* is refused up front.
    let err = move_branch_to_worktree(
        bare.path(),
        "feature",
        linked.as_str(),
        bare.path(),
        true,
        &|_| {},
    )
    .expect_err("handoff into a bare repo should be refused");
    assert!(err.contains("bare repository"), "got: {err}");
    // The source was not detached by the refused handoff.
    let source_head = git_at(&linked.0, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    assert_eq!(
        String::from_utf8_lossy(&source_head.stdout).trim(),
        "feature",
        "source must still be on its branch after a refused handoff"
    );
}

#[test]
fn worktrees_reports_each_entry_head_oid() {
    // A detached worktree has no branch to resolve through, so the porcelain
    // `HEAD` oid is the UI's only way to locate it in the graph.
    let repo = TempRepo::new("wt-head-oid");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("f.txt"), "x\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-head-oid");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);

    let head = git_at(&repo.0, &["rev-parse", "HEAD"]);
    let head = String::from_utf8_lossy(&head.stdout).trim().to_string();

    let list = worktrees(repo.path()).expect("list worktrees");
    let detached = list.iter().find(|w| !w.is_main).expect("linked worktree");
    assert!(detached.branch.is_none(), "worktree should be detached");
    assert_eq!(detached.head.as_deref(), Some(head.as_str()));
    // Branch-holding entries carry their HEAD oid too (the default-branch name
    // depends on the host's init.defaultBranch, so only its presence is checked).
    let main_entry = list.iter().find(|w| w.is_main).expect("main entry");
    assert!(main_entry.branch.is_some(), "main should be on a branch");
    assert_eq!(main_entry.head.as_deref(), Some(head.as_str()));
}

#[test]
fn create_branch_in_worktree_attaches_the_detached_worktree() {
    let (repo, linked) = repo_with_feature_worktree("wt-create-branch");
    git_ok_at(&linked.0, &["checkout", "-q", "--detach"]);
    let expected_oid = rev_parse(&repo, "feature");

    let message = create_branch_in_worktree(
        repo.path(),
        linked.as_str(),
        "topic/from-detached",
        &expected_oid,
    )
    .expect("create and check out branch in detached worktree");

    assert!(message.contains("topic/from-detached"), "got: {message}");
    let branch = git_at(&linked.0, &["branch", "--show-current"]);
    assert_eq!(
        String::from_utf8_lossy(&branch.stdout).trim(),
        "topic/from-detached"
    );
    assert_eq!(rev_parse(&repo, "topic/from-detached"), expected_oid);
}

#[test]
fn create_branch_in_worktree_rejects_a_stale_detached_head() {
    let (repo, linked) = repo_with_feature_worktree("wt-create-branch-stale");
    git_ok_at(&linked.0, &["checkout", "-q", "--detach"]);
    let expected_oid = rev_parse(&repo, "feature");

    std::fs::write(repo.0.join("later.txt"), "later\n").unwrap();
    repo.git_ok(&["add", "later.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "later"]);
    git_ok_at(&linked.0, &["checkout", "-q", "--detach", "main"]);

    let err = create_branch_in_worktree(repo.path(), linked.as_str(), "topic/stale", &expected_oid)
        .expect_err("stale menu HEAD should be rejected");
    assert!(err.contains("HEAD changed"), "got: {err}");
    assert!(
        !git_at(
            &repo.0,
            &["show-ref", "--verify", "--quiet", "refs/heads/topic/stale"]
        )
        .status
        .success(),
        "the rejected action must not create the branch"
    );
}

#[test]
fn create_branch_in_worktree_rejects_an_attached_worktree() {
    let (repo, linked) = repo_with_feature_worktree("wt-create-branch-attached");
    let expected_oid = rev_parse(&repo, "feature");

    let err = create_branch_in_worktree(
        repo.path(),
        linked.as_str(),
        "topic/already-attached",
        &expected_oid,
    )
    .expect_err("branch-holding worktree should be rejected");
    assert!(err.contains("no longer detached"), "got: {err}");
}

#[cfg(unix)]
#[test]
fn worktrees_preserves_newlines_in_worktree_paths() {
    let repo = repo_with_file("wt-newline-path", "f.txt", b"x\n");
    let linked = std::env::temp_dir().join(format!(
        "gitlane-wt-newline-{}\nsecond-line",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked_str]);

    let list = worktrees(repo.path()).expect("NUL-safe worktree list");
    assert!(list.iter().any(|entry| same_path(&entry.path, linked_str)));

    repo.git_ok(&["worktree", "remove", "--force", linked_str]);
}

#[test]
fn remove_worktree_force_overrides_a_lock() {
    let repo = TempRepo::new("wt-locked");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("f.txt"), "x\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-locked");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    repo.git_ok(&["worktree", "lock", linked.as_str()]);

    // `worktrees()` flags the lock.
    let list = worktrees(repo.path()).expect("list worktrees");
    assert!(
        list.iter().any(|w| !w.is_main && w.locked),
        "the linked worktree should be flagged locked: {list:?}"
    );

    // After the lease matches, the server derives `-f -f` for a locked worktree
    // (GL-303) — execute has no client force flag to forget.
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview locked");
    assert!(preview.requires_force);
    assert!(preview.locked);
    remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect("force-remove a locked worktree");
    assert!(
        !linked.0.exists(),
        "the locked worktree directory should be gone after a forced remove"
    );
}

// GL-296: the probe that lets the removal confirm quote what a forced remove
// would destroy, instead of dead-ending on git's "contains modified or
// untracked files" refusal.

#[test]
fn worktree_dirty_state_counts_modified_and_untracked_work() {
    let repo = TempRepo::new("wt-dirty");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    std::fs::write(repo.0.join("b.txt"), "b\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-dirty");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);

    // A freshly added worktree is clean.
    let clean = worktree_dirty_state(linked.as_str()).expect("probe a clean worktree");
    assert_eq!((clean.modified, clean.untracked), (0, 0));

    // Two tracked edits plus untracked files nested in a new directory. The
    // probe must expand that directory (`--untracked-files=all`) rather than
    // collapsing it to a single entry, or the warning understates the loss.
    std::fs::write(linked.0.join("a.txt"), "changed\n").unwrap();
    std::fs::write(linked.0.join("b.txt"), "changed too\n").unwrap();
    std::fs::create_dir(linked.0.join("fresh")).unwrap();
    std::fs::write(linked.0.join("fresh/one.txt"), "1\n").unwrap();
    std::fs::write(linked.0.join("fresh/two.txt"), "2\n").unwrap();

    let dirty = worktree_dirty_state(linked.as_str()).expect("probe a dirty worktree");
    assert_eq!(
        (dirty.modified, dirty.untracked),
        (2, 2),
        "expected 2 modified and 2 untracked (directory expanded), got {dirty:?}"
    );

    // Review finding: `run_git` returns stdout and stderr combined on success,
    // so anything git writes to stderr must not be scored as a changed file.
    // Renames and conflict codes are one record each and stay counted.
    assert!(!is_porcelain_record("warning: unable to access something"));
    assert!(!is_porcelain_record("fatal: not a git repository"));
    assert!(!is_porcelain_record(""));
    assert!(!is_porcelain_record("   "));
    assert!(is_porcelain_record("?? new.txt"));
    assert!(is_porcelain_record(" M tracked.txt"));
    assert!(is_porcelain_record("R  old.txt -> new.txt"));
    assert!(is_porcelain_record("UU conflicted.txt"));
    assert!(is_porcelain_record("A  added.txt"));
    assert!(is_porcelain_record("D  deleted.txt"));

    // The probe is a read: it must not itself disturb the worktree. After the
    // lease matches, the server derives `--force` for dirty removals (GL-303).
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview dirty");
    assert!(preview.requires_force);
    assert_eq!(preview.dirty.modified, 2);
    assert_eq!(preview.dirty.untracked, 2);
    remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect("force-remove a dirty worktree");
    assert!(!linked.0.exists(), "the worktree directory should be gone");
}

// Ignored files are invisible to `--untracked-files=all`, yet git deletes them
// on an *unforced* remove. Without a separate count, a worktree holding only a
// local `.env` reports "nothing to lose" and is swept away with it.

#[test]
fn worktree_dirty_state_counts_ignored_entries_git_would_delete() {
    let repo = TempRepo::new("wt-ignored");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join(".gitignore"), "secret.env\nbuild/\n").unwrap();
    repo.git_ok(&["add", ".gitignore"]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-ignored");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    std::fs::write(linked.0.join("secret.env"), "TOKEN=1\n").unwrap();
    std::fs::create_dir(linked.0.join("build")).unwrap();
    for name in ["a.o", "b.o", "c.o"] {
        std::fs::write(linked.0.join("build").join(name), "x").unwrap();
    }

    let state = worktree_dirty_state(linked.as_str()).expect("probe an ignored-only worktree");
    assert_eq!(
        (state.modified, state.untracked),
        (0, 0),
        "ignored files are neither modified nor untracked: {state:?}"
    );
    // The file plus the *collapsed* build/ directory — not the three .o files
    // inside it, which `--ignored` alone deliberately does not expand.
    assert_eq!(
        state.ignored, 2,
        "expected secret.env + collapsed build/, got {state:?}"
    );

    // Git considers this worktree clean, so the unforced removal the bulk sweep
    // uses does delete those files. That is precisely why the count must be
    // reported instead of assumed to be zero.
    remove_worktree_previewed(repo.path(), linked.as_str())
        .expect("git removes an ignored-only worktree without a force");
    assert!(!linked.0.exists(), "the worktree directory should be gone");
}

#[test]
fn worktree_is_dirty_flags_real_work_but_not_ignored_files() {
    let repo = TempRepo::new("wt-is-dirty");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join(".gitignore"), "build/\n").unwrap();
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-is-dirty");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    assert!(
        !worktree_is_dirty(linked.as_str()).expect("probe a clean worktree"),
        "a freshly added worktree has no uncommitted work"
    );

    // Ignored output only: git deletes it on an unforced remove, so it must not
    // read as unsaved work.
    std::fs::create_dir(linked.0.join("build")).unwrap();
    std::fs::write(linked.0.join("build/out.o"), "x").unwrap();
    assert!(
        !worktree_is_dirty(linked.as_str()).expect("probe an ignored-only worktree"),
        "ignored entries must not dot a worktree"
    );

    // A tracked edit is work.
    std::fs::write(linked.0.join("a.txt"), "changed\n").unwrap();
    assert!(
        worktree_is_dirty(linked.as_str()).expect("probe a modified worktree"),
        "a modified tracked file is uncommitted work"
    );

    // So is an untracked file — even nested, where `--untracked-files=normal`
    // reports the collapsed directory rather than the file. One record is all
    // the answer needs, which is why the probe can afford to collapse.
    git_ok_at(&linked.0, &["checkout", "--", "a.txt"]);
    std::fs::create_dir(linked.0.join("fresh")).unwrap();
    std::fs::write(linked.0.join("fresh/note.txt"), "1\n").unwrap();
    assert!(
        worktree_is_dirty(linked.as_str()).expect("probe an untracked-only worktree"),
        "an untracked file nested in a new directory is uncommitted work"
    );

    // Staged-but-uncommitted work counts too — it is exactly what a forced
    // remove would throw away.
    std::fs::remove_dir_all(linked.0.join("fresh")).unwrap();
    std::fs::write(linked.0.join("staged.txt"), "s\n").unwrap();
    git_ok_at(&linked.0, &["add", "staged.txt"]);
    assert!(
        worktree_is_dirty(linked.as_str()).expect("probe a staged-only worktree"),
        "staged-but-uncommitted work is uncommitted work"
    );

    // A worktree whose directory is gone errors rather than answering "clean".
    // The frontend degrades that to "no dot" — a false negative, which is the
    // safe direction for a hint: it never claims work is saved when it isn't.
    std::fs::remove_dir_all(&linked.0).unwrap();
    assert!(
        worktree_is_dirty(linked.as_str()).is_err(),
        "a missing worktree directory must not report clean"
    );
}

// A conflicted merge is the state most worth a dot — the worktree is mid-merge
// with unresolved files, and a forced removal there loses the resolution work.

#[test]
fn worktree_is_dirty_flags_an_unresolved_conflict() {
    let repo = TempRepo::new("wt-dirty-conflict");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);
    repo.git_ok(&["checkout", "-q", "-b", "other"]);
    std::fs::write(repo.0.join("a.txt"), "other\n").unwrap();
    repo.git_ok(&["commit", "-q", "-am", "other"]);
    repo.git_ok(&["checkout", "-q", "-"]);
    std::fs::write(repo.0.join("a.txt"), "main\n").unwrap();
    repo.git_ok(&["commit", "-q", "-am", "main"]);

    let linked = LinkedDir::new("wt-dirty-conflict");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    // Conflict inside the *linked* worktree, leaving `UU` records behind.
    let merge = git_at(&linked.0, &["merge", "other"]);
    assert!(!merge.status.success(), "the merge is expected to conflict");
    assert!(
        worktree_is_dirty(linked.as_str()).expect("probe a conflicted worktree"),
        "an unresolved conflict is uncommitted work"
    );
}
