//! `discard` in a linked worktree, alongside a submodule, or racing an
//! external worktree rename.

use super::super::support::*;

#[test]
fn discard_all_rejects_worktree_drift_before_mutating() {
    let repo = repo_with_file("discard-stale", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "previewed edit\n").unwrap();
    std::fs::write(repo.0.join("approved.txt"), "approved\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");

    std::fs::write(repo.0.join("new-after-preview.txt"), "new\n").unwrap();
    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("new worktree state must stale the lease");

    assert!(error.contains("changed after this confirmation"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "previewed edit\n"
    );
    assert!(repo.0.join("approved.txt").exists());
    assert!(repo.0.join("new-after-preview.txt").exists());
}

#[cfg(unix)]
#[test]
fn discard_all_rejects_an_ignored_symlink_at_a_staged_delete() {
    use std::os::unix::fs::symlink;

    let repo = repo_with_file("discard-delete-ignored-symlink", "victim.txt", b"base\n");
    std::fs::write(repo.0.join(".gitignore"), "victim.txt\n").unwrap();
    repo.git_ok(&["add", ".gitignore"]);
    repo.git_ok(&["commit", "-q", "-m", "ignore victim"]);
    repo.git_ok(&["rm", "-q", "victim.txt"]);
    symlink("precious-target", repo.0.join("victim.txt")).unwrap();

    let error = preview_discard_all(repo.path())
        .expect_err("an ignored symlink must not be silently reset");

    assert!(error.contains("staged for deletion"));
    assert_eq!(
        std::fs::read_link(repo.0.join("victim.txt")).unwrap(),
        PathBuf::from("precious-target")
    );
}

#[test]
fn discard_all_works_in_a_linked_worktree_without_touching_its_main_checkout() {
    let main = repo_with_file("discard-linked-normal", "tracked.txt", b"base\n");
    main.git_ok(&["branch", "feature"]);
    let linked = TempRepo::new("discard-linked-normal-worktree");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    std::fs::write(linked.0.join("tracked.txt"), "linked edit\n").unwrap();
    std::fs::write(linked.0.join("untracked.txt"), "remove\n").unwrap();

    discard_all_previewed(linked.path()).expect("discard linked-worktree changes");

    assert_eq!(
        std::fs::read_to_string(linked.0.join("tracked.txt")).unwrap(),
        "base\n"
    );
    assert!(!linked.0.join("untracked.txt").exists());
    assert_eq!(
        std::fs::read_to_string(main.0.join("tracked.txt")).unwrap(),
        "base\n"
    );
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
}

#[test]
fn discard_all_rejects_a_submodule_dirtied_before_reset() {
    let submodule = repo_with_file("discard-submodule-source", "nested.txt", b"nested base\n");
    let repo = repo_with_file("discard-submodule-parent", "tracked.txt", b"base\n");
    repo.git_ok(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        submodule.path(),
        "nested",
    ]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-am", "add submodule"]);
    repo.git_ok(&["config", "submodule.recurse", "true"]);
    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(repo.0.join("approved.txt"), "approved\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview clean submodule");
    let nested_file = repo.0.join("nested/nested.txt");
    let nested_for_hook = nested_file.clone();
    set_discard_all_after_cleanup_test_hook(move || {
        std::fs::write(nested_for_hook, "late nested edit\n").unwrap();
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("late submodule state must stop the superproject reset");

    assert!(error.contains("tracked state could not be rechecked"));
    assert!(!repo.0.join("approved.txt").exists());
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "changed\n",
        "the superproject edit must survive the rejected reset"
    );
    assert_eq!(
        std::fs::read_to_string(nested_file).unwrap(),
        "late nested edit\n",
        "user config must not make reset recurse into the submodule"
    );
}

#[test]
fn discard_staged_deletion_rejects_a_new_worktree_copy_then_restores_head() {
    let repo = repo_with_file("discard-staged-deletion", "gone.txt", b"committed\n");
    repo.git_ok(&["rm", "-q", "gone.txt"]);
    let preview = preview_discard_file(repo.path(), "gone.txt", None, true).expect("preview");

    std::fs::write(repo.0.join("gone.txt"), b"precious\n").unwrap();
    let error = discard_file(repo.path(), "gone.txt", None, true, &preview.expected_state)
        .expect_err("a new worktree copy invalidates the deletion preview");
    assert!(error.contains("changed"), "unexpected error: {error}");
    assert_eq!(
        std::fs::read(repo.0.join("gone.txt")).unwrap(),
        b"precious\n"
    );
    assert!(repo.git(&["diff", "--cached", "--quiet"]).status.code() == Some(1));

    discard_current(&repo, "gone.txt", None, true).expect("restore staged deletion");
    assert_eq!(
        std::fs::read(repo.0.join("gone.txt")).unwrap(),
        b"committed\n"
    );
    assert!(repo.git(&["status", "--porcelain"]).stdout.is_empty());
}

#[test]
fn discard_staged_change_rejects_an_external_worktree_rename() {
    let repo = repo_with_file("discard-staged-then-wt-rename", "old.txt", b"base\n");
    std::fs::write(repo.0.join("old.txt"), b"stage\n").unwrap();
    repo.git_ok(&["add", "old.txt"]);
    std::fs::rename(repo.0.join("old.txt"), repo.0.join("new.txt")).unwrap();
    let before_status = repo.git(&["status", "--porcelain=v1", "-z"]).stdout;
    let before_index = repo.git(&["diff", "--cached", "--binary"]).stdout;

    let error = preview_discard_file(repo.path(), "old.txt", None, true)
        .expect_err("a staged row must not strand its external worktree rename");

    assert!(
        error.contains("unstaged rename first"),
        "unexpected error: {error}"
    );
    assert_eq!(
        repo.git(&["status", "--porcelain=v1", "-z"]).stdout,
        before_status
    );
    assert_eq!(
        repo.git(&["diff", "--cached", "--binary"]).stdout,
        before_index
    );
    assert!(!repo.0.join("old.txt").exists());
    assert_eq!(std::fs::read(repo.0.join("new.txt")).unwrap(), b"stage\n");
}

#[test]
fn discard_staged_rename_rejects_a_later_external_worktree_rename() {
    let repo = repo_with_file("discard-staged-rename-chain", "old.txt", b"base\n");
    repo.git_ok(&["mv", "old.txt", "new.txt"]);
    std::fs::rename(repo.0.join("new.txt"), repo.0.join("newer.txt")).unwrap();
    let before_status = repo.git(&["status", "--porcelain=v1", "-z"]).stdout;
    let before_index = repo.git(&["diff", "--cached", "--binary"]).stdout;

    let error = preview_discard_file(repo.path(), "new.txt", Some("old.txt"), true)
        .expect_err("a staged rename must not strand the next worktree rename");

    assert!(
        error.contains("unstaged rename first"),
        "unexpected error: {error}"
    );
    assert_eq!(
        repo.git(&["status", "--porcelain=v1", "-z"]).stdout,
        before_status
    );
    assert_eq!(
        repo.git(&["diff", "--cached", "--binary"]).stdout,
        before_index
    );
    assert!(!repo.0.join("old.txt").exists());
    assert!(!repo.0.join("new.txt").exists());
    assert_eq!(std::fs::read(repo.0.join("newer.txt")).unwrap(), b"base\n");
}
