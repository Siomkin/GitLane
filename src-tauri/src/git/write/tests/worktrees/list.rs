//! Listing worktrees, and removing one.

use super::super::support::*;

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
