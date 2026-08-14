//! The Worktree Removal Lease preview: what drift invalidates a captured
//! snapshot, and what deliberately does not.

use super::super::support::*;

#[test]
fn preview_remove_worktree_lease_ignored_only_drift_does_not_invalidate() {
    let repo = TempRepo::new("wt-lease-drift");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join(".gitignore"), "secret.env\n").unwrap();
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-drift");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);

    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview clean");
    assert!(!preview.requires_force);
    assert_eq!(preview.dirty.ignored, 0);

    std::fs::write(linked.0.join("secret.env"), "TOKEN=1\n").unwrap();
    // Ignored-only drift must not invalidate the lease (disclosure only).
    remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect("ignored-only drift does not invalidate");
}

#[test]
fn preview_remove_worktree_lease_rejects_new_untracked_path() {
    let repo = TempRepo::new("wt-lease-untracked");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-untracked");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");
    std::fs::write(linked.0.join("new.txt"), "x\n").unwrap();
    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("new untracked path must invalidate");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

#[test]
fn preview_remove_worktree_lease_rejects_lock_drift() {
    let repo = TempRepo::new("wt-lease-lock");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-lock");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview unlocked");
    assert!(!preview.locked);
    assert!(!preview.requires_force);

    repo.git_ok(&["worktree", "lock", linked.as_str()]);
    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("locking after preview must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    // Worktree must still exist — execute must not escalate to -f -f off-lease.
    assert!(
        linked.0.exists(),
        "lock drift must refuse, not force-remove"
    );
    repo.git_ok(&["worktree", "remove", "--force", "--force", linked.as_str()]);
}

#[test]
fn preview_remove_worktree_lease_rejects_gitdir_registration_replacement() {
    use std::path::PathBuf;

    let repo = TempRepo::new("wt-lease-gitdir");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-gitdir");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");

    // Replace the private admin gitdir at the same pathname so the workdir
    // inode is unchanged but registration identity (gitdir inode) flips — the
    // ADR's registration half of the lease must fail closed.
    let gitfile = std::fs::read_to_string(linked.0.join(".git")).unwrap();
    let gitdir = PathBuf::from(
        gitfile
            .trim()
            .strip_prefix("gitdir: ")
            .expect("linked worktree gitfile"),
    );
    let gitdir = if gitdir.is_absolute() {
        gitdir
    } else {
        linked.0.join(gitdir)
    };
    let gitdir = gitdir.canonicalize().unwrap();
    StagedDirReplacement::stage(&gitdir)
        .expect("stage the private gitdir")
        .apply()
        .expect("swap in a gitdir with the same contents and a new inode");

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("replaced registration must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

#[test]
fn preview_remove_worktree_lease_survives_same_status_in_place_edit() {
    let (repo, linked, tracked) = repo_with_dirty_linked_worktree("wt-lease-inplace");

    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview dirty");
    assert!(preview.requires_force, "an edited tracked file is dirty");
    assert_eq!(preview.dirty.modified, 1);

    // Same path, same ` M` status code — only the bytes differ.
    std::fs::write(&tracked, "edited again, at greater length\n").unwrap();

    remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect("an in-place edit keeping the same porcelain status must not invalidate");
    assert!(!linked.0.exists(), "the worktree directory should be gone");
}

#[test]
fn preview_remove_worktree_lease_rejects_status_code_change() {
    let (repo, linked, _tracked) = repo_with_dirty_linked_worktree("wt-lease-status");

    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview dirty");
    assert_eq!(preview.dirty.modified, 1);

    git_ok_at(&linked.0, &["add", "a.txt"]);

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("a status-code change must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

#[test]
fn preview_remove_worktree_lease_rejects_head_movement() {
    let repo = TempRepo::new("wt-lease-head");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-head");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");
    assert!(
        preview.head_oid.is_some(),
        "detached worktrees lease a HEAD"
    );

    // Commit inside the worktree: the tree is clean again afterwards, so only
    // the leased HEAD oid catches this.
    std::fs::write(linked.0.join("b.txt"), "b\n").unwrap();
    git_ok_at(&linked.0, &["add", "b.txt"]);
    git_ok_at(
        &linked.0,
        &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "moved"],
    );

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("HEAD movement must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

#[test]
fn preview_remove_worktree_lease_rejects_attach_to_detach() {
    let repo = TempRepo::new("wt-lease-detach");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = LinkedDir::new("wt-lease-detach");
    repo.git_ok(&["worktree", "add", "-q", linked.as_str(), "feature"]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview attached");
    assert_eq!(preview.branch.as_deref(), Some("feature"));

    // Same commit, no branch — the HEAD oid alone would not notice.
    git_ok_at(&linked.0, &["checkout", "-q", "--detach"]);

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("detaching after preview must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

#[test]
fn preview_remove_worktree_lease_rejects_workdir_directory_replacement() {
    let repo = TempRepo::new("wt-lease-workdir-aba");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-workdir-aba");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");

    // Rebuild the workdir at the same pathname with the same bytes: registration
    // and porcelain output are unchanged, the directory inode is not.
    StagedDirReplacement::stage(&linked.0)
        .expect("stage the workdir")
        .apply()
        .expect("swap in a workdir with the same contents and a new inode");

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("a replaced workdir must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

#[test]
fn preview_remove_worktree_lease_rejects_concurrent_prune() {
    let repo = TempRepo::new("wt-lease-prune");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-prune");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");

    std::fs::remove_dir_all(&linked.0).expect("simulate the directory going away");
    repo.git_ok(&["worktree", "prune"]);

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("a pruned registration must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
}
