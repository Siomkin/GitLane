//! `discard` write-path tests.

use super::support::*;

#[test]
fn discard_all_preview_rejects_an_unborn_repository() {
    let repo = TempRepo::new("discard-unborn");
    repo.git_ok(&["init", "-q"]);
    std::fs::write(repo.0.join("staged.txt"), b"hello").unwrap();
    repo.git_ok(&["add", "staged.txt"]);

    let error = preview_discard_all(repo.path())
        .expect_err("an unborn repository has no safe committed restore tree");

    assert!(error.contains("unavailable before the first commit"));
    assert!(repo.0.join("staged.txt").exists());
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["ls-files", "--cached"]).stdout).trim(),
        "staged.txt"
    );
}

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

#[test]
fn discard_all_keeps_untracked_files_created_after_final_validation() {
    let repo = repo_with_file("discard-late-untracked", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(repo.0.join("approved.txt"), "approved\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");
    let late = repo.0.join("late.txt");
    let late_for_hook = late.clone();
    set_discard_all_after_validation_test_hook(move || {
        std::fs::write(late_for_hook, "late\n").unwrap();
    });

    discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("discard approved state");

    assert!(!repo.0.join("approved.txt").exists());
    assert_eq!(std::fs::read_to_string(late).unwrap(), "late\n");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "base\n"
    );
}

#[test]
fn discard_all_normalizes_an_approved_untracked_copy_at_a_staged_delete() {
    let repo = repo_with_file("discard-delete-recreated", "victim.txt", b"base\n");
    repo.git_ok(&["rm", "-q", "victim.txt"]);
    std::fs::write(repo.0.join("victim.txt"), "replacement\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview staged delete and replacement");

    discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("clean replacement then restore tracked file");

    assert_eq!(
        std::fs::read_to_string(repo.0.join("victim.txt")).unwrap(),
        "base\n"
    );
    assert!(String::from_utf8_lossy(
        &repo
            .git(&["status", "--porcelain", "--untracked-files=all"])
            .stdout
    )
    .trim()
    .is_empty());
}

#[test]
fn discard_all_rejects_an_ignored_replacement_at_a_staged_delete() {
    let repo = repo_with_file(
        "discard-delete-ignored-replacement",
        "victim.txt",
        b"base\n",
    );
    std::fs::write(repo.0.join(".gitignore"), "victim.txt\n").unwrap();
    repo.git_ok(&["add", ".gitignore"]);
    repo.git_ok(&["commit", "-q", "-m", "ignore victim"]);
    repo.git_ok(&["rm", "-q", "victim.txt"]);
    std::fs::write(repo.0.join("victim.txt"), "precious ignored replacement\n").unwrap();

    let error = preview_discard_all(repo.path())
        .expect_err("an ignored replacement must not be silently reset");

    assert!(
        error.contains("staged for deletion") && error.contains("unapproved replacement"),
        "unexpected refusal: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("victim.txt")).unwrap(),
        "precious ignored replacement\n"
    );
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
fn discard_all_confirmation_reuses_tracked_content_fingerprints() {
    let repo = repo_with_file("discard-reuse-fingerprints", "tracked.bin", b"base\n");
    let edited = vec![b'x'; 512 * 1024];
    std::fs::write(repo.0.join("tracked.bin"), &edited).unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");

    start_discard_all_fingerprint_byte_count();
    discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("discard previewed edit");
    let fingerprinted = take_discard_all_fingerprint_byte_count();

    assert_eq!(
        fingerprinted,
        4 * edited.len() as u64,
        "confirmation should hash two stable captures and two post-clean captures"
    );
}

#[test]
fn discard_all_reports_when_cleanup_ran_but_a_path_reappeared() {
    let repo = repo_with_file("discard-clean-reappeared", "tracked.txt", b"base\n");
    let approved = repo.0.join("approved.txt");
    std::fs::write(&approved, "approved\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");
    let approved_for_hook = approved.clone();
    set_discard_all_after_first_clean_batch_test_hook(move || {
        std::fs::write(approved_for_hook, "precious late content\n").unwrap();
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("a recreated path must stop the reset");

    assert!(
        error.contains("cleanup ran") && error.contains("did not remove"),
        "unexpected post-clean diagnostic: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(approved).unwrap(),
        "precious late content\n"
    );
}

#[test]
fn discard_all_preserves_a_staged_delete_path_recreated_after_cleanup() {
    let repo = repo_with_file("discard-delete-late-recreate", "victim.txt", b"base\n");
    repo.git_ok(&["rm", "-q", "victim.txt"]);
    std::fs::write(repo.0.join("victim.txt"), "approved replacement\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");
    let victim = repo.0.join("victim.txt");
    let victim_for_hook = victim.clone();
    set_discard_all_after_cleanup_test_hook(move || {
        std::fs::write(victim_for_hook, "precious late replacement\n").unwrap();
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("a recreated overlap must stop reset");

    assert!(error.contains("cleanup completed") && error.contains("recreated before reset"));
    assert_eq!(
        std::fs::read_to_string(victim).unwrap(),
        "precious late replacement\n"
    );
}

#[test]
fn discard_all_revalidates_each_cleanup_batch() {
    let repo = repo_with_file("discard-clean-batch-race", "tracked.txt", b"base\n");
    for index in 0..=CLEAN_PATH_BATCH_MAX_ARGS {
        std::fs::write(repo.0.join(format!("batch-{index:04}.txt")), "approved\n").unwrap();
    }
    let preview = preview_discard_all(repo.path()).expect("preview");
    let late_batch_path = repo
        .0
        .join(format!("batch-{CLEAN_PATH_BATCH_MAX_ARGS:04}.txt"));
    let late_for_hook = late_batch_path.clone();
    set_discard_all_after_first_clean_batch_test_hook(move || {
        std::fs::write(late_for_hook, "precious late content\n").unwrap();
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("later cleanup batch must revalidate its files");

    assert!(error.contains("partially completed") && error.contains("changed before its cleanup"));
    assert!(!repo.0.join("batch-0000.txt").exists());
    assert_eq!(
        std::fs::read_to_string(late_batch_path).unwrap(),
        "precious late content\n"
    );
}

#[cfg(unix)]
#[test]
fn discard_all_reports_partial_cleanup_before_a_later_validation_error() {
    use std::os::unix::fs::symlink;

    let repo = repo_with_file("discard-clean-batch-io", "tracked.txt", b"base\n");
    for index in 0..CLEAN_PATH_BATCH_MAX_ARGS {
        std::fs::write(repo.0.join(format!("batch-{index:04}.txt")), "approved\n").unwrap();
    }
    let late_parent = repo.0.join("z-late");
    std::fs::create_dir(&late_parent).unwrap();
    std::fs::write(late_parent.join("target.txt"), "approved\n").unwrap();
    let outside = TempRepo::new("discard-clean-batch-io-outside");
    std::fs::write(outside.0.join("target.txt"), "precious outside\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");
    let late_parent_for_hook = late_parent.clone();
    let outside_for_hook = outside.0.clone();
    set_discard_all_after_first_clean_batch_test_hook(move || {
        std::fs::remove_dir_all(&late_parent_for_hook).unwrap();
        symlink(outside_for_hook, late_parent_for_hook).unwrap();
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("an unreadable later path must stop its cleanup batch");

    assert!(
        error.contains("partially completed")
            && error.contains("could not be rechecked before its cleanup batch"),
        "unexpected partial-clean diagnostic: {error}"
    );
    assert!(!repo.0.join("batch-0000.txt").exists());
    assert_eq!(
        std::fs::read_to_string(outside.0.join("target.txt")).unwrap(),
        "precious outside\n"
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
fn discard_all_rejects_a_linked_worktree_gitfile_retarget_before_reset() {
    let main = repo_with_file("discard-linked-gitfile", "tracked.txt", b"base\n");
    main.git_ok(&["branch", "feature"]);
    let linked = TempRepo::new("discard-linked-gitfile-worktree");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    let decoy = repo_with_file("discard-linked-gitfile-decoy", "tracked.txt", b"decoy\n");
    std::fs::write(linked.0.join("tracked.txt"), "approved linked edit\n").unwrap();
    let preview = preview_discard_all(linked.path()).expect("preview linked edit");
    let gitfile = linked.0.join(".git");
    let original_gitfile = std::fs::read(&gitfile).unwrap();
    let gitfile_for_hook = gitfile.clone();
    let decoy_gitdir = decoy.0.join(".git").canonicalize().unwrap();
    set_discard_all_before_tracked_reset_test_hook(move || {
        std::fs::write(
            gitfile_for_hook,
            format!("gitdir: {}\n", decoy_gitdir.display()),
        )
        .unwrap();
    });

    let result = discard_all(
        linked.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::write(&gitfile, original_gitfile).unwrap();
    let error = result.expect_err("retargeted gitfile must invalidate the captured scope");

    assert!(
        error.contains("working tree changed after this confirmation"),
        "unexpected scope error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(linked.0.join("tracked.txt")).unwrap(),
        "approved linked edit\n"
    );
    assert_eq!(
        std::fs::read_to_string(decoy.0.join("tracked.txt")).unwrap(),
        "decoy\n"
    );
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
}

#[test]
fn discard_all_scoped_reset_cannot_be_redirected_after_final_validation() {
    let main = repo_with_file("discard-linked-scoped-reset", "tracked.txt", b"base\n");
    main.git_ok(&["branch", "feature"]);
    let linked = TempRepo::new("discard-linked-scoped-reset-worktree");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    let decoy = repo_with_file(
        "discard-linked-scoped-reset-decoy",
        "tracked.txt",
        b"decoy\n",
    );
    std::fs::write(linked.0.join("tracked.txt"), "approved linked edit\n").unwrap();
    let preview = preview_discard_all(linked.path()).expect("preview linked edit");
    let gitfile = linked.0.join(".git");
    let original_gitfile = std::fs::read(&gitfile).unwrap();
    let gitfile_for_hook = gitfile.clone();
    let decoy_gitdir = decoy.0.join(".git").canonicalize().unwrap();
    set_discard_all_after_tracked_scope_validation_test_hook(move || {
        std::fs::write(
            gitfile_for_hook,
            format!("gitdir: {}\n", decoy_gitdir.display()),
        )
        .unwrap();
    });

    let result = discard_all(
        linked.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::write(&gitfile, original_gitfile).unwrap();
    let error = result.expect_err("the post-reset scope check must report the retarget");

    assert!(
        error.contains("tracked changes were reset") && error.contains("scope or HEAD changed"),
        "unexpected post-reset diagnostic: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(linked.0.join("tracked.txt")).unwrap(),
        "base\n",
        "the reset must remain bound to the approved linked worktree"
    );
    assert_eq!(
        std::fs::read_to_string(decoy.0.join("tracked.txt")).unwrap(),
        "decoy\n",
        "the retargeted repository must not be mutated"
    );
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
}

#[test]
fn discard_all_exact_tree_restore_ignores_a_final_commondir_retarget() {
    let main = repo_with_file("discard-linked-scoped-common", "tracked.txt", b"base\n");
    main.git_ok(&["branch", "feature"]);
    main.git_ok(&["checkout", "-q", "-b", "other"]);
    std::fs::write(main.0.join("tracked.txt"), "other branch\n").unwrap();
    main.git_ok(&["add", "tracked.txt"]);
    main.git_ok(&["commit", "-q", "-m", "other content"]);
    let other_oid = rev_parse(&main, "HEAD");
    main.git_ok(&["checkout", "-q", "main"]);
    let linked = TempRepo::new("discard-linked-scoped-common-worktree");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    let decoy = repo_with_file(
        "discard-linked-scoped-common-decoy",
        "tracked.txt",
        b"decoy\n",
    );
    std::fs::create_dir_all(decoy.0.join(".git/refs/heads")).unwrap();
    std::fs::write(
        decoy.0.join(".git/refs/heads/feature"),
        format!("{other_oid}\n"),
    )
    .unwrap();
    std::fs::write(linked.0.join("tracked.txt"), "approved linked edit\n").unwrap();
    let preview = preview_discard_all(linked.path()).expect("preview linked edit");
    let gitfile = std::fs::read_to_string(linked.0.join(".git")).unwrap();
    let linked_gitdir = PathBuf::from(
        gitfile
            .trim()
            .strip_prefix("gitdir: ")
            .expect("linked worktree gitfile"),
    );
    let commondir_file = linked_gitdir.join("commondir");
    let original_commondir = std::fs::read(&commondir_file).unwrap();
    let commondir_for_hook = commondir_file.clone();
    let decoy_common = decoy.0.join(".git").canonicalize().unwrap();
    set_discard_all_after_tracked_scope_validation_test_hook(move || {
        std::fs::write(commondir_for_hook, format!("{}\n", decoy_common.display())).unwrap();
    });

    let result = discard_all(
        linked.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::write(&commondir_file, original_commondir).unwrap();
    let error = result.expect_err("the post-restore lease check must report the retarget");

    assert!(
        error.contains("reset to the previewed commit") && error.contains("scope or HEAD changed"),
        "unexpected post-restore diagnostic: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(linked.0.join("tracked.txt")).unwrap(),
        "base\n",
        "a retargeted branch ref must not select the restored tree"
    );
    assert_eq!(
        std::fs::read_to_string(decoy.0.join(".git/refs/heads/feature")).unwrap(),
        format!("{other_oid}\n"),
        "restoring the worktree must not update a retargeted branch ref"
    );
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
}

#[test]
fn discard_all_exact_tree_restore_ignores_a_final_head_retarget() {
    let repo = repo_with_file("discard-scoped-head", "tracked.txt", b"base\n");
    repo.git_ok(&["checkout", "-q", "-b", "other"]);
    std::fs::write(repo.0.join("tracked.txt"), "other branch\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "other content"]);
    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("tracked.txt"), "approved main edit\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview main edit");
    let head_file = repo.0.join(".git/HEAD");
    let original_head = std::fs::read(&head_file).unwrap();
    let head_for_hook = head_file.clone();
    set_discard_all_after_tracked_scope_validation_test_hook(move || {
        std::fs::write(head_for_hook, "ref: refs/heads/other\n").unwrap();
    });

    let result = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::write(&head_file, original_head).unwrap();
    let error = result.expect_err("the post-restore lease check must report the HEAD retarget");

    assert!(
        error.contains("reset to the previewed commit") && error.contains("scope or HEAD changed"),
        "unexpected post-restore diagnostic: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "base\n",
        "a retargeted HEAD must not select the restored tree"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "main"
    );
}

#[test]
fn discard_all_preview_rejects_active_replace_refs() {
    let repo = repo_with_file("discard-replace-active", "tracked.txt", b"base\n");
    let base_oid = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "-b", "replacement"]);
    std::fs::write(repo.0.join("tracked.txt"), "replacement tree\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "replacement content"]);
    let replacement_oid = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&["replace", &base_oid, &replacement_oid]);
    std::fs::write(repo.0.join("tracked.txt"), "approved edit\n").unwrap();

    let error = preview_discard_all(repo.path())
        .expect_err("replacement refs can redirect trees and blobs below HEAD");

    assert!(error.contains("replacement refs are active"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "approved edit\n"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/main"), base_oid);
    assert_eq!(
        rev_parse(&repo, &format!("refs/replace/{base_oid}")),
        replacement_oid
    );
}

#[test]
fn discard_all_preview_rejects_tree_subtree_and_blob_replace_refs() {
    let repo = TempRepo::new("discard-replace-noncommit");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::create_dir(repo.0.join("dir")).unwrap();
    std::fs::write(repo.0.join("dir/tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "dir/tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["checkout", "-q", "-b", "replacement"]);
    std::fs::write(repo.0.join("dir/tracked.txt"), "replacement\n").unwrap();
    repo.git_ok(&["add", "dir/tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "replacement"]);

    let replacements = [
        (
            rev_parse(&repo, "main^{tree}"),
            rev_parse(&repo, "replacement^{tree}"),
        ),
        (
            rev_parse(&repo, "main:dir"),
            rev_parse(&repo, "replacement:dir"),
        ),
        (
            rev_parse(&repo, "main:dir/tracked.txt"),
            rev_parse(&repo, "replacement:dir/tracked.txt"),
        ),
    ];
    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("dir/tracked.txt"), "approved edit\n").unwrap();

    for (original, replacement) in replacements {
        repo.git_ok(&["replace", &original, &replacement]);
        let error = preview_discard_all(repo.path())
            .expect_err("all replacement-object types must fail closed");
        assert!(error.contains("replacement refs are active"));
        repo.git_ok(&["replace", "-d", &original]);
    }

    assert_eq!(
        std::fs::read_to_string(repo.0.join("dir/tracked.txt")).unwrap(),
        "approved edit\n"
    );
}

#[test]
fn discard_all_exact_tree_restore_ignores_a_final_replace_ref() {
    let repo = repo_with_file("discard-replace-late", "tracked.txt", b"base\n");
    let base_oid = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "-b", "replacement"]);
    std::fs::write(repo.0.join("tracked.txt"), "replacement tree\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "replacement content"]);
    let replacement_oid = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("tracked.txt"), "approved edit\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview main edit");
    let replace_ref = repo.0.join(format!(".git/refs/replace/{base_oid}"));
    let replace_ref_for_hook = replace_ref.clone();
    set_discard_all_after_tracked_scope_validation_test_hook(move || {
        std::fs::create_dir_all(replace_ref_for_hook.parent().unwrap()).unwrap();
        std::fs::write(replace_ref_for_hook, format!("{replacement_oid}\n")).unwrap();
    });

    let result = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::remove_file(&replace_ref).unwrap();
    let error = result.expect_err("the post-restore lease check must report the replace ref");

    assert!(
        error.contains("reset to the previewed commit") && error.contains("scope or HEAD changed"),
        "unexpected post-restore diagnostic: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "base\n",
        "a late replace ref must not select the restored tree"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/main"), base_oid);
}

#[test]
fn discard_all_rejects_a_linked_worktree_commondir_retarget_before_reset() {
    let main = repo_with_file("discard-linked-common", "tracked.txt", b"base\n");
    main.git_ok(&["branch", "feature"]);
    let linked = TempRepo::new("discard-linked-common-worktree");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    let decoy = repo_with_file("discard-linked-common-decoy", "tracked.txt", b"decoy\n");
    std::fs::write(linked.0.join("tracked.txt"), "approved linked edit\n").unwrap();
    let preview = preview_discard_all(linked.path()).expect("preview linked edit");
    let gitfile = std::fs::read_to_string(linked.0.join(".git")).unwrap();
    let linked_gitdir = PathBuf::from(
        gitfile
            .trim()
            .strip_prefix("gitdir: ")
            .expect("linked worktree gitfile"),
    );
    let commondir_file = linked_gitdir.join("commondir");
    let original_commondir = std::fs::read(&commondir_file).unwrap();
    let commondir_for_hook = commondir_file.clone();
    let decoy_common = decoy.0.join(".git").canonicalize().unwrap();
    set_discard_all_before_tracked_reset_test_hook(move || {
        std::fs::write(commondir_for_hook, format!("{}\n", decoy_common.display())).unwrap();
    });

    let result = discard_all(
        linked.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::write(&commondir_file, original_commondir).unwrap();
    let error = result.expect_err("retargeted commondir must invalidate the captured scope");

    assert!(
        error.contains("working tree changed after this confirmation"),
        "unexpected scope error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(linked.0.join("tracked.txt")).unwrap(),
        "approved linked edit\n"
    );
    assert_eq!(
        std::fs::read_to_string(decoy.0.join("tracked.txt")).unwrap(),
        "decoy\n"
    );
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
}

#[test]
fn discard_all_preserves_tracked_edits_created_after_cleanup() {
    let repo = repo_with_file("discard-late-tracked", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "previewed edit\n").unwrap();
    std::fs::write(repo.0.join("approved.txt"), "approved\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");
    let tracked = repo.0.join("tracked.txt");
    let tracked_for_hook = tracked.clone();
    set_discard_all_after_cleanup_test_hook(move || {
        std::fs::write(tracked_for_hook, "late edit\n").unwrap();
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("late tracked edit must stop reset");

    assert!(error.contains("cleanup completed") && error.contains("tracked edits were preserved"));
    assert!(!repo.0.join("approved.txt").exists());
    assert_eq!(std::fs::read_to_string(tracked).unwrap(), "late edit\n");
}

#[test]
fn discard_all_preserves_state_after_a_head_switch_during_cleanup() {
    let repo = repo_with_file("discard-late-head-switch", "tracked.txt", b"base\n");
    repo.git_ok(&["branch", "other"]);
    std::fs::write(repo.0.join("tracked.txt"), "previewed edit\n").unwrap();
    std::fs::write(repo.0.join("approved.txt"), "approved\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");
    let repo_for_hook = repo.0.clone();
    set_discard_all_after_cleanup_test_hook(move || {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo_for_hook)
            .args(["switch", "-q", "other"])
            .output()
            .unwrap();
        assert!(output.status.success());
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("HEAD drift must stop reset");

    assert!(error.contains("cleanup completed"));
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "other"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "previewed edit\n"
    );
    assert!(!repo.0.join("approved.txt").exists());
}

#[test]
fn discard_all_preview_rejects_assume_unchanged_files() {
    let repo = repo_with_file("discard-assume-unchanged", "tracked.txt", b"base\n");
    repo.git_ok(&["update-index", "--assume-unchanged", "tracked.txt"]);
    std::fs::write(repo.0.join("tracked.txt"), "hidden edit\n").unwrap();

    let error = preview_discard_all(repo.path())
        .expect_err("hidden tracked changes cannot be safely previewed");

    assert!(error.contains("assume-unchanged"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "hidden edit\n"
    );
}

#[test]
fn discard_all_preview_rejects_skip_worktree_files() {
    let repo = repo_with_file("discard-skip-worktree", "tracked.txt", b"base\n");
    repo.git_ok(&["update-index", "--skip-worktree", "tracked.txt"]);
    std::fs::write(repo.0.join("tracked.txt"), "hidden edit\n").unwrap();

    let error = preview_discard_all(repo.path())
        .expect_err("skip-worktree changes cannot be safely previewed");

    assert!(error.contains("skip-worktree"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "hidden edit\n"
    );
}

#[test]
fn discard_all_preview_rejects_ignored_directory_obstructions() {
    let repo = repo_with_file("discard-obstruction", "victim", b"base\n");
    std::fs::write(repo.0.join(".gitignore"), "victim/\n").unwrap();
    repo.git_ok(&["add", ".gitignore"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "ignore obstruction"]);
    repo.git_ok(&["rm", "-q", "victim"]);
    std::fs::create_dir(repo.0.join("victim")).unwrap();
    std::fs::write(repo.0.join("victim/secret"), "keep\n").unwrap();

    let error =
        preview_discard_all(repo.path()).expect_err("reset would erase an ignored descendant");

    assert!(error.contains("non-file worktree path victim"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("victim/secret")).unwrap(),
        "keep\n"
    );
}

#[test]
fn discard_all_preview_rejects_an_unstable_capture() {
    let repo = repo_with_file("discard-unstable-preview", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "first edit\n").unwrap();
    let tracked = repo.0.join("tracked.txt");
    set_discard_all_capture_test_hook(move || {
        std::fs::write(tracked, "second edit\n").unwrap();
    });

    let error = preview_discard_all(repo.path())
        .expect_err("a preview assembled from two states must fail closed");

    assert!(error.contains("changed while GitLane was preparing"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "second edit\n"
    );
}

#[test]
fn discard_all_preview_bounds_large_content_fingerprinting() {
    let repo = repo_with_file("discard-large-sparse", "tracked.txt", b"base\n");
    let sparse = std::fs::File::create(repo.0.join("huge.bin")).unwrap();
    sparse.set_len(257 * 1024 * 1024).unwrap();

    let error =
        preview_discard_all(repo.path()).expect_err("oversized safety inspection must fail fast");

    assert!(error.contains("more than 256 MiB") && error.contains("terminal"));
    assert_eq!(
        std::fs::metadata(repo.0.join("huge.bin")).unwrap().len(),
        257 * 1024 * 1024
    );
}

#[test]
fn discard_all_preview_counts_overlapping_file_content_once() {
    let repo = repo_with_file("discard-overlap-budget", "victim.bin", b"base\n");
    repo.git_ok(&["rm", "-q", "victim.bin"]);
    let replacement = std::fs::File::create(repo.0.join("victim.bin")).unwrap();
    replacement.set_len(129 * 1024 * 1024).unwrap();

    let preview = preview_discard_all(repo.path())
        .expect("one overlapping file below the unique-content cap must preview");

    assert!(preview.expected_state.starts_with("v1:"));
    assert_eq!(
        std::fs::metadata(repo.0.join("victim.bin")).unwrap().len(),
        129 * 1024 * 1024
    );
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

#[cfg(unix)]
#[test]
fn discard_all_uses_the_validated_worktree_when_repo_symlink_is_repointed() {
    use std::os::unix::fs::symlink;

    let approved = repo_with_file("discard-symlink-approved", "tracked.txt", b"base\n");
    std::fs::write(approved.0.join("tracked.txt"), "approved edit\n").unwrap();
    std::fs::write(approved.0.join("approved-untracked.txt"), "remove\n").unwrap();
    let other = repo_with_file("discard-symlink-other", "tracked.txt", b"other base\n");
    std::fs::write(other.0.join("tracked.txt"), "precious other edit\n").unwrap();
    std::fs::write(other.0.join("precious.txt"), "keep\n").unwrap();
    let holder = TempRepo::new("discard-symlink-holder");
    let link = holder.0.join("repo");
    symlink(&approved.0, &link).unwrap();
    let link_arg = link.to_string_lossy().into_owned();
    let preview = preview_discard_all(&link_arg).expect("preview through symlink");
    let link_for_hook = link.clone();
    let other_for_hook = other.0.clone();
    set_discard_all_after_validation_test_hook(move || {
        std::fs::remove_file(&link_for_hook).unwrap();
        symlink(other_for_hook, link_for_hook).unwrap();
    });

    discard_all(
        &link_arg,
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("operate on the captured worktree");

    assert_eq!(
        std::fs::read_to_string(approved.0.join("tracked.txt")).unwrap(),
        "base\n"
    );
    assert!(!approved.0.join("approved-untracked.txt").exists());
    assert_eq!(
        std::fs::read_to_string(other.0.join("tracked.txt")).unwrap(),
        "precious other edit\n"
    );
    assert_eq!(
        std::fs::read_to_string(other.0.join("precious.txt")).unwrap(),
        "keep\n"
    );
}

#[test]
fn discard_all_preserves_empty_untracked_directories() {
    let repo = TempRepo::new("discard-empty-dir");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "initial"]);

    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::create_dir(repo.0.join("untracked-dir")).unwrap();
    std::fs::write(repo.0.join("untracked-dir/file.txt"), "new\n").unwrap();
    std::fs::create_dir(repo.0.join("empty-dir")).unwrap();

    discard_all_previewed(repo.path()).expect("discard_all");

    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "base\n"
    );
    assert!(!repo.0.join("untracked-dir/file.txt").exists());
    assert!(
        repo.0.join("untracked-dir").is_dir(),
        "only the reported untracked file is removed; the directory shell remains"
    );
    assert!(
        repo.0.join("empty-dir").is_dir(),
        "empty directories are not Git changes and must be preserved"
    );
    let status = repo.git(&["status", "--porcelain", "--untracked-files=all"]);
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "repo should be clean after discard"
    );
}

#[test]
fn discard_all_preserves_nested_empty_directories_inside_cleaned_trees() {
    let repo = TempRepo::new("discard-nested-empty");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "initial"]);

    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::create_dir_all(repo.0.join("untracked-dir/empty-nested")).unwrap();
    std::fs::write(repo.0.join("untracked-dir/file.txt"), "new\n").unwrap();

    discard_all_previewed(repo.path()).expect("discard_all");

    assert!(!repo.0.join("untracked-dir/file.txt").exists());
    assert!(
        repo.0.join("untracked-dir/empty-nested").is_dir(),
        "nested empty directories must survive cleanup of sibling untracked files"
    );
}

#[test]
fn discard_all_preserves_nested_git_repositories_and_resets_other_changes() {
    let repo = repo_with_file("discard-nested-repo", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(repo.0.join("untracked.txt"), "remove me\n").unwrap();
    std::fs::create_dir(repo.0.join("nested")).unwrap();
    repo.git_ok(&["-C", "nested", "init", "-q"]);
    std::fs::write(repo.0.join("nested/file.txt"), "nested\n").unwrap();

    let result =
        discard_all_previewed(repo.path()).expect("nested repositories are a protected exception");

    assert!(
        result.contains("preserved nested Git repositories") && result.contains("nested/"),
        "success must report the protected path: {result}"
    );
    assert!(
        repo.0.join("nested/.git").is_dir(),
        "a single -f must preserve an untracked nested repository"
    );
    assert!(
        !repo.0.join("untracked.txt").exists(),
        "ordinary untracked files should still be removed"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "base\n",
        "tracked edits should still be reset"
    );
}

#[test]
fn discard_all_preserves_a_nested_repository_created_after_confirmation() {
    let repo = repo_with_file("discard-late-nested-repo", "tracked.txt", b"base\n");
    std::fs::create_dir(repo.0.join("nested")).unwrap();
    std::fs::write(repo.0.join("nested/approved.txt"), "keep\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview ordinary untracked file");
    let nested_for_hook = repo.0.join("nested");
    set_discard_all_after_validation_test_hook(move || {
        let output = Command::new("git")
            .arg("-C")
            .arg(&nested_for_hook)
            .args(["init", "-q"])
            .output()
            .unwrap();
        assert!(output.status.success());
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("a newly nested repository must stop cleanup");

    assert!(error.contains("now inside nested Git repository"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("nested/approved.txt")).unwrap(),
        "keep\n"
    );
    assert!(repo.0.join("nested/.git").is_dir());
}

#[test]
fn discard_all_preserves_tracked_files_wrapped_in_a_nested_repo_after_confirmation() {
    let repo = TempRepo::new("discard-late-nested-tracked");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::create_dir(repo.0.join("nested")).unwrap();
    std::fs::write(repo.0.join("nested/tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "nested/tracked.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "seed"]);
    std::fs::write(repo.0.join("nested/tracked.txt"), "approved edit\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview tracked edit");
    let nested_for_hook = repo.0.join("nested");
    set_discard_all_after_cleanup_test_hook(move || {
        let output = Command::new("git")
            .arg("-C")
            .arg(&nested_for_hook)
            .args(["init", "-q"])
            .output()
            .unwrap();
        assert!(output.status.success());
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("a newly nested repository must stop the parent reset");

    assert!(error.contains("now inside nested Git repository"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("nested/tracked.txt")).unwrap(),
        "approved edit\n"
    );
    assert!(repo.0.join("nested/.git").is_dir());
}

#[test]
fn discard_all_preserves_nested_bare_git_repositories() {
    let repo = repo_with_file("discard-nested-bare-repo", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(repo.0.join("ordinary.txt"), "remove\n").unwrap();
    std::fs::create_dir(repo.0.join("nested.git")).unwrap();
    repo.git_ok(&["-C", "nested.git", "init", "--bare", "-q"]);

    let preview = preview_discard_all(repo.path()).expect("preview nested bare repository");
    assert!(preview
        .details
        .iter()
        .any(|line| line.contains("Nested Git repositories") && line.contains("nested.git")));
    assert!(!preview
        .details
        .iter()
        .filter(|line| line.starts_with("Files that will be reset or removed:"))
        .any(|line| line.contains("nested.git/")));
    discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("preserve nested bare repository");

    assert!(repo.0.join("nested.git/HEAD").is_file());
    assert!(repo.0.join("nested.git/objects").is_dir());
    assert!(!repo.0.join("ordinary.txt").exists());
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "base\n"
    );
}

#[test]
fn discard_all_rejects_staged_nested_bare_repository_metadata() {
    let repo = repo_with_file("discard-staged-nested-bare", "tracked.txt", b"base\n");
    std::fs::create_dir(repo.0.join("nested.git")).unwrap();
    repo.git_ok(&["-C", "nested.git", "init", "--bare", "-q"]);
    repo.git_ok(&["add", "nested.git/HEAD", "nested.git/config"]);

    let error = preview_discard_all(repo.path())
        .expect_err("parent reset must not delete staged bare-repository metadata");

    assert!(error.contains("Nested Git repository nested.git"));
    assert!(repo.0.join("nested.git/HEAD").is_file());
    assert!(repo.0.join("nested.git/config").is_file());
}

#[cfg(unix)]
#[test]
fn discard_all_preserves_directories_with_dangling_git_markers() {
    use std::os::unix::fs::symlink;

    let repo = repo_with_file("discard-dangling-git-marker", "tracked.txt", b"base\n");
    std::fs::create_dir(repo.0.join("nested")).unwrap();
    symlink("missing-gitdir", repo.0.join("nested/.git")).unwrap();
    std::fs::write(repo.0.join("nested/precious"), "keep\n").unwrap();

    let preview = preview_discard_all(repo.path()).expect("preview protected marker");
    assert!(preview
        .details
        .iter()
        .any(|line| line.contains("Nested Git repositories") && line.contains("nested")));
    assert!(!preview
        .details
        .iter()
        .filter(|line| line.starts_with("Files that will be reset or removed:"))
        .any(|line| line.contains("nested/precious")));
    discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("preserve marker directory");

    assert_eq!(
        std::fs::read_to_string(repo.0.join("nested/precious")).unwrap(),
        "keep\n"
    );
    assert!(std::fs::symlink_metadata(repo.0.join("nested/.git")).is_ok());
}

#[test]
fn discard_all_reports_when_reset_fails_after_untracked_cleanup() {
    let repo = repo_with_file("discard-reset-failure", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(repo.0.join("untracked.txt"), "new\n").unwrap();
    std::fs::write(repo.0.join(".git/index.lock"), "locked\n").unwrap();

    let result = discard_all_previewed(repo.path());

    std::fs::remove_file(repo.0.join(".git/index.lock")).unwrap();
    let error = result.expect_err("the index lock should block reset");
    assert!(
        error.contains(
            "Approved untracked cleanup completed, but tracked changes could not be reset"
        ),
        "unexpected partial-failure diagnostic: {error}"
    );
    assert!(
        !repo.0.join("untracked.txt").exists(),
        "untracked cleanup should finish before reset starts"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "changed\n",
        "failed reset should leave tracked edits intact"
    );
}

#[test]
fn discard_all_cleans_untracked_paths_across_argument_batches() {
    let repo = repo_with_file("discard-batches", "tracked.txt", b"base\n");
    for index in 0..=CLEAN_PATH_BATCH_MAX_ARGS {
        std::fs::write(repo.0.join(format!("untracked-{index}.txt")), "new\n").unwrap();
    }

    discard_all_previewed(repo.path()).expect("discard_all");

    let status = repo.git(&["status", "--porcelain", "--untracked-files=all"]);
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "every untracked path should be cleaned across batches"
    );
}

#[test]
fn discard_all_preserves_leading_whitespace_in_untracked_paths() {
    let repo = repo_with_file("discard-leading-space", "tracked.txt", b"base\n");
    let path = repo.0.join(" leading-space.txt");
    std::fs::write(&path, "new\n").unwrap();

    discard_all_previewed(repo.path()).expect("discard_all");

    assert!(
        !path.exists(),
        "the exact leading-space path should be cleaned"
    );
}

#[cfg(not(windows))]
#[test]
fn discard_all_treats_pathspec_magic_as_a_literal_filename() {
    let repo = repo_with_file("discard-pathspec-magic", "tracked.txt", b"base\n");
    let path = repo.0.join(":(");
    std::fs::write(&path, "new\n").unwrap();

    discard_all_previewed(repo.path()).expect("discard_all");

    assert!(
        !path.exists(),
        "the pathspec-like filename should be cleaned"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn discard_all_removes_non_utf8_untracked_paths() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let repo = repo_with_file("discard-non-utf8", "tracked.txt", b"base\n");
    let path = OsStr::from_bytes(b"untracked\xff.txt");
    std::fs::write(repo.0.join(path), b"new\n").unwrap();

    discard_all_previewed(repo.path()).expect("discard_all");

    assert!(
        !repo.0.join(path).exists(),
        "non-UTF-8 untracked paths must be removed, not lossy-skipped"
    );
}

#[test]
fn discard_all_preview_warns_about_untracked_limits() {
    let repo = TempRepo::new("discard-preview");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), b"one\n").unwrap();
    repo.git(&["add", "tracked.txt"]);
    repo.git(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("tracked.txt"), b"two\n").unwrap();
    std::fs::write(repo.0.join("new.txt"), b"new\n").unwrap();

    let preview = preview_discard_all(repo.path()).expect("preview");
    assert!(preview
        .details
        .iter()
        .any(|line| line.contains("tracked.txt")));
    assert!(preview.details.iter().any(|line| line.contains("new.txt")));
    assert!(preview
        .warnings
        .iter()
        .any(|line| line.contains("Untracked files")));
    assert!(preview
        .warnings
        .iter()
        .any(|line| line.contains("empty directories are preserved")));
}

#[test]
fn discard_all_preview_lists_preserved_nested_git_repositories() {
    let repo = repo_with_file("discard-preview-nested-repo", "tracked.txt", b"base\n");
    std::fs::create_dir(repo.0.join("nested")).unwrap();
    repo.git_ok(&["-C", "nested", "init", "-q"]);
    std::fs::write(repo.0.join("nested/file.txt"), "nested\n").unwrap();

    let preview = preview_discard_all(repo.path()).expect("preview");

    assert!(preview.summary.contains("removable untracked"));
    assert!(preview
        .details
        .iter()
        .any(|line| line.contains("Nested Git repositories") && line.contains("nested/")));
    assert!(preview
        .warnings
        .iter()
        .any(|line| line.contains("protected") && line.contains("will remain")));
}

#[test]
fn discard_all_preview_fails_closed_on_non_repo() {
    // A path that isn't a git repo must error, not report "already clean".
    let dir = TempRepo::new("discard-non-repo");
    assert!(preview_discard_all(dir.path()).is_err());
}

#[test]
fn discard_preview_rejects_a_stale_source_bucket() {
    // The preview is now the source-of-truth boundary: a staged-only file must
    // not be accepted as an unstaged target. The former stale-flag fallback made
    // this case indistinguishable from a staged-new file with additional
    // worktree edits, whose staged blob must be preserved.
    let repo = TempRepo::new("discard-staged-new");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&[
        "commit",
        "-q",
        "--no-gpg-sign",
        "--allow-empty",
        "-m",
        "root",
    ]);

    std::fs::write(repo.0.join("staged_new.txt"), "new\n").unwrap();
    repo.git_ok(&["add", "staged_new.txt"]);
    std::fs::write(repo.0.join("untracked.txt"), "loose\n").unwrap();

    let error = preview_discard_file(repo.path(), "staged_new.txt", None, false)
        .expect_err("a staged-only file has no unstaged discard target");
    assert!(error.contains("unstaged"), "unexpected error: {error}");
    assert_eq!(index_entries(&repo), ["staged_new.txt"]);
    assert!(repo.0.join("staged_new.txt").exists());

    discard_current(&repo, "staged_new.txt", None, true).expect("discard staged-new file");
    assert!(
        index_entries(&repo).is_empty(),
        "staged-new file leaves the index"
    );
    assert!(
        !repo.0.join("staged_new.txt").exists(),
        "staged-new file leaves the worktree"
    );

    // The genuinely untracked path still goes through `git clean`.
    discard_current(&repo, "untracked.txt", None, false).expect("discard untracked file");
    assert!(
        !repo.0.join("untracked.txt").exists(),
        "untracked file is cleaned"
    );
}

#[test]
fn discard_file_preserves_empty_directory_shells() {
    let repo = repo_with_file("discard-file-empty-dirs", "tracked.txt", b"base\n");
    std::fs::create_dir_all(repo.0.join("untracked/empty-nested")).unwrap();
    std::fs::write(repo.0.join("untracked/file.txt"), "new\n").unwrap();

    discard_current(&repo, "untracked/file.txt", None, false).expect("discard untracked file");

    assert!(!repo.0.join("untracked/file.txt").exists());
    assert!(repo.0.join("untracked/empty-nested").is_dir());
}

#[test]
fn discard_file_restores_both_sides_of_unstaged_and_staged_renames() {
    for staged in [false, true] {
        let repo = repo_with_file(
            if staged {
                "discard-staged-rename"
            } else {
                "discard-unstaged-rename"
            },
            "old.txt",
            b"original\n",
        );
        if staged {
            repo.git_ok(&["mv", "old.txt", "new.txt"]);
        } else {
            std::fs::rename(repo.0.join("old.txt"), repo.0.join("new.txt")).unwrap();
        }

        discard_current(&repo, "new.txt", Some("old.txt"), staged)
            .expect("discard both rename sides");

        assert_eq!(
            std::fs::read(repo.0.join("old.txt")).unwrap(),
            b"original\n"
        );
        assert!(!repo.0.join("new.txt").exists());
        assert!(
            String::from_utf8_lossy(&repo.git(&["status", "--porcelain"]).stdout)
                .trim()
                .is_empty()
        );
    }
}

#[test]
fn discard_file_preserves_staged_content_when_discarding_an_unstaged_rename() {
    let repo = repo_with_file("discard-partially-staged-rename", "old.txt", b"original\n");
    std::fs::write(repo.0.join("old.txt"), b"staged edit\n").unwrap();
    repo.git_ok(&["add", "old.txt"]);
    std::fs::rename(repo.0.join("old.txt"), repo.0.join("new.txt")).unwrap();

    discard_current(&repo, "new.txt", Some("old.txt"), false)
        .expect("discard only the worktree rename");

    assert_eq!(
        std::fs::read(repo.0.join("old.txt")).unwrap(),
        b"staged edit\n"
    );
    assert!(!repo.0.join("new.txt").exists());
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["show", ":old.txt"]).stdout),
        "staged edit\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["status", "--porcelain=v1"]).stdout),
        "M  old.txt\n"
    );
}

#[test]
fn discard_file_handles_a_case_only_staged_rename() {
    let repo = repo_with_file("discard-case-only-rename", "case.txt", b"original\n");
    repo.git_ok(&["mv", "case.txt", "case-intermediate.txt"]);
    repo.git_ok(&["mv", "case-intermediate.txt", "CASE.txt"]);

    discard_current(&repo, "CASE.txt", Some("case.txt"), true)
        .expect("discard the case-only rename");

    assert_eq!(
        std::fs::read(repo.0.join("case.txt")).unwrap(),
        b"original\n"
    );
    let worktree_names: Vec<_> = std::fs::read_dir(&repo.0)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .collect();
    assert!(worktree_names.iter().any(|name| name == "case.txt"));
    assert!(!worktree_names.iter().any(|name| name == "CASE.txt"));
    assert!(
        String::from_utf8_lossy(&repo.git(&["status", "--porcelain=v1"]).stdout)
            .trim()
            .is_empty()
    );
}

#[test]
fn discard_file_refuses_a_stale_rename_pair_before_mutating_either_path() {
    for staged in [false, true] {
        let repo = repo_with_file(
            if staged {
                "discard-stale-staged-rename"
            } else {
                "discard-stale-unstaged-rename"
            },
            "old.txt",
            b"old base\n",
        );
        std::fs::write(repo.0.join("new.txt"), b"new base\n").unwrap();
        repo.git_ok(&["add", "new.txt"]);
        repo.git_ok(&["commit", "-q", "-m", "track both paths"]);
        std::fs::write(repo.0.join("old.txt"), b"precious old edit\n").unwrap();
        std::fs::write(repo.0.join("new.txt"), b"precious new edit\n").unwrap();
        if staged {
            repo.git_ok(&["add", "old.txt", "new.txt"]);
        }
        let before_status = repo.git(&["status", "--porcelain=v1", "-z"]);
        let before_index = repo.git(&["diff", "--cached", "--binary"]);

        let error = preview_discard_file(repo.path(), "new.txt", Some("old.txt"), staged)
            .expect_err("stale rename metadata must fail closed");

        assert!(
            error.contains("changed") || error.contains("no longer available"),
            "unexpected error: {error}"
        );
        assert_eq!(
            std::fs::read(repo.0.join("old.txt")).unwrap(),
            b"precious old edit\n"
        );
        assert_eq!(
            std::fs::read(repo.0.join("new.txt")).unwrap(),
            b"precious new edit\n"
        );
        let after_status = repo.git(&["status", "--porcelain=v1", "-z"]);
        let after_index = repo.git(&["diff", "--cached", "--binary"]);
        assert_eq!(
            after_status.stdout, before_status.stdout,
            "worktree status must stay unchanged"
        );
        assert_eq!(
            after_index.stdout, before_index.stdout,
            "the index must stay unchanged"
        );
    }
}

#[cfg(not(windows))]
#[test]
fn discard_file_does_not_expand_an_untracked_pathspec_magic_filename() {
    let repo = TempRepo::new("discard-file-pathspec-magic");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked-a.txt"), "a\n").unwrap();
    std::fs::write(repo.0.join("tracked-b.txt"), "b\n").unwrap();
    repo.git_ok(&["add", "-A"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    let magic = ":(glob)*";
    std::fs::write(repo.0.join(magic), "untracked\n").unwrap();

    discard_current(&repo, magic, None, false).expect("discard literal magic filename");

    assert!(!repo.0.join(magic).exists());
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked-a.txt")).unwrap(),
        "a\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked-b.txt")).unwrap(),
        "b\n"
    );
    let status = repo.git(&["status", "--porcelain", "--untracked-files=all"]);
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "tracked files must not be removed or staged: {}",
        String::from_utf8_lossy(&status.stdout)
    );
}

#[test]
fn discard_removes_a_staged_new_file_with_staged_true_on_a_born_repo() {
    // GL-115 Bug 2 regression: the new `git rm -f` path must behave like the
    // old restore-then-clean flow for the staged=true case on a repo that does
    // have history — clearing the staged-new file from index and worktree.
    let repo = TempRepo::new("discard-staged-true-born");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&[
        "commit",
        "-q",
        "--no-gpg-sign",
        "--allow-empty",
        "-m",
        "root",
    ]);

    std::fs::write(repo.0.join("staged_new.txt"), "new\n").unwrap();
    repo.git_ok(&["add", "staged_new.txt"]);

    discard_current(&repo, "staged_new.txt", None, true).expect("discard staged=true new file");
    assert!(
        index_entries(&repo).is_empty(),
        "staged-new file leaves the index"
    );
    assert!(
        !repo.0.join("staged_new.txt").exists(),
        "staged-new file leaves the worktree"
    );
}

#[test]
fn discard_staged_file_works_on_an_unborn_repo() {
    // GL-115 Bug 1 interplay: discard(staged=true) used to open with
    // `restore --staged`, which dies on an unborn HEAD. The `git rm -f` path
    // needs no HEAD at all.
    let repo = TempRepo::new("unborn-discard");
    repo.git_ok(&["init", "-q"]);
    std::fs::write(repo.0.join("new.txt"), "new\n").unwrap();
    stage_file(repo.path(), "new.txt").expect("stage on unborn HEAD");

    discard_current(&repo, "new.txt", None, true).expect("discard staged file on unborn HEAD");
    assert!(index_entries(&repo).is_empty(), "file leaves the index");
    assert!(!repo.0.join("new.txt").exists(), "file leaves the worktree");
}

#[test]
fn discard_staged_file_fails_closed_when_head_tree_cannot_be_read() {
    let repo = repo_with_file("discard-missing-head-tree", "root.txt", b"root\n");
    std::fs::create_dir(repo.0.join("nested")).unwrap();
    std::fs::write(repo.0.join("nested/tracked.txt"), b"committed\n").unwrap();
    repo.git_ok(&["add", "nested/tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "add nested file"]);
    std::fs::write(repo.0.join("nested/tracked.txt"), b"staged edit\n").unwrap();
    repo.git_ok(&["add", "nested/tracked.txt"]);

    let subtree = rev_parse(&repo, "HEAD:nested");
    let object_path = repo
        .0
        .join(".git/objects")
        .join(&subtree[..2])
        .join(&subtree[2..]);
    std::fs::remove_file(&object_path).expect("fixture subtree object should be loose");

    let error = preview_discard_file(repo.path(), "nested/tracked.txt", None, true)
        .expect_err("an unreadable HEAD tree must never be treated as a staged-new file");
    assert!(
        error.contains("Could not inspect") || error.contains("unable to read tree"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read(repo.0.join("nested/tracked.txt")).unwrap(),
        b"staged edit\n"
    );
    assert_eq!(index_entries(&repo), ["nested/tracked.txt", "root.txt"]);
}

#[test]
fn discard_file_refuses_a_same_size_edit_after_preview() {
    let repo = repo_with_file("discard-stale-same-size", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("loose.txt"), b"one\n").unwrap();
    let preview = preview_discard_file(repo.path(), "loose.txt", None, false).expect("preview");

    // Same byte length and line count: a size/stat-only precondition would miss
    // this replacement and delete content created while the dialog was open.
    std::fs::write(repo.0.join("loose.txt"), b"two\n").unwrap();
    let error = discard_file(
        repo.path(),
        "loose.txt",
        None,
        false,
        &preview.expected_state,
    )
    .expect_err("changed content must invalidate the preview");

    assert!(error.contains("changed"), "unexpected error: {error}");
    assert_eq!(std::fs::read(repo.0.join("loose.txt")).unwrap(), b"two\n");
    assert_eq!(index_entries(&repo), ["tracked.txt"]);
}

#[test]
fn discard_unstaged_side_of_staged_new_preserves_the_staged_blob() {
    let repo = repo_with_file("discard-staged-new-edited", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("new.txt"), b"staged version\n").unwrap();
    repo.git_ok(&["add", "new.txt"]);
    std::fs::write(repo.0.join("new.txt"), b"working edit!!\n").unwrap();

    discard_current(&repo, "new.txt", None, false)
        .expect("discard only the unstaged side of a staged-new file");

    assert_eq!(
        std::fs::read(repo.0.join("new.txt")).unwrap(),
        b"staged version\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["show", ":new.txt"]).stdout),
        "staged version\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["status", "--porcelain=v1"]).stdout),
        "A  new.txt\n"
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
fn discard_intent_to_add_rejects_a_real_stage_transition_and_removes_a_live_ita() {
    let repo = repo_with_file("discard-intent-to-add", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("intent.txt"), b"draft\n").unwrap();
    repo.git_ok(&["add", "-N", "intent.txt"]);
    let preview = preview_discard_file(repo.path(), "intent.txt", None, false).expect("preview");

    repo.git_ok(&["add", "intent.txt"]);
    let error = discard_file(
        repo.path(),
        "intent.txt",
        None,
        false,
        &preview.expected_state,
    )
    .expect_err("turning intent-to-add into staged content must fail closed");
    assert!(
        error.contains("no longer available") || error.contains("changed"),
        "unexpected error: {error}"
    );
    assert!(repo.0.join("intent.txt").exists());
    assert!(index_entries(&repo).contains(&"intent.txt".to_string()));

    repo.git_ok(&["reset", "-q", "HEAD", "--", "intent.txt"]);
    repo.git_ok(&["add", "-N", "intent.txt"]);
    discard_current(&repo, "intent.txt", None, false)
        .expect("git rm -f removes an intent-to-add entry and worktree copy");
    assert!(!repo.0.join("intent.txt").exists());
    assert!(!index_entries(&repo).contains(&"intent.txt".to_string()));
}

#[test]
fn discard_rename_refuses_content_changed_after_preview() {
    for staged in [false, true] {
        let repo = repo_with_file(
            if staged {
                "discard-staged-rename-content-race"
            } else {
                "discard-unstaged-rename-content-race"
            },
            "old.txt",
            b"base\n",
        );
        if staged {
            repo.git_ok(&["mv", "old.txt", "new.txt"]);
        } else {
            std::fs::rename(repo.0.join("old.txt"), repo.0.join("new.txt")).unwrap();
        }
        let preview = preview_discard_file(repo.path(), "new.txt", Some("old.txt"), staged)
            .expect("preview rename");
        let before_index = repo.git(&["diff", "--cached", "--binary"]).stdout;

        std::fs::write(repo.0.join("new.txt"), b"late\n").unwrap();
        let error = discard_file(
            repo.path(),
            "new.txt",
            Some("old.txt"),
            staged,
            &preview.expected_state,
        )
        .expect_err("rename content changed after preview");

        assert!(error.contains("changed"), "unexpected error: {error}");
        assert!(!repo.0.join("old.txt").exists());
        assert_eq!(std::fs::read(repo.0.join("new.txt")).unwrap(), b"late\n");
        assert_eq!(
            repo.git(&["diff", "--cached", "--binary"]).stdout,
            before_index
        );
    }
}

#[test]
fn discard_preview_rejects_conflicted_paths_without_mutation() {
    let repo = repo_with_file("discard-conflict", "conflict.txt", b"base\n");
    repo.git_ok(&["checkout", "-q", "-b", "side"]);
    std::fs::write(repo.0.join("conflict.txt"), b"side\n").unwrap();
    repo.git_ok(&["add", "conflict.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "side"]);
    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("conflict.txt"), b"main\n").unwrap();
    repo.git_ok(&["add", "conflict.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "main"]);
    let merge = repo.git(&["merge", "--no-edit", "side"]);
    assert!(!merge.status.success(), "fixture must produce a conflict");
    let before_index = repo.git(&["ls-files", "-u"]).stdout;
    let before_worktree = std::fs::read(repo.0.join("conflict.txt")).unwrap();

    let error = preview_discard_file(repo.path(), "conflict.txt", None, false)
        .expect_err("ordinary discard must refuse conflicts");

    assert!(error.contains("conflicted"), "unexpected error: {error}");
    assert_eq!(repo.git(&["ls-files", "-u"]).stdout, before_index);
    assert_eq!(
        std::fs::read(repo.0.join("conflict.txt")).unwrap(),
        before_worktree
    );
}

#[test]
fn discard_expectation_tolerates_unrelated_path_and_index_changes() {
    let repo = repo_with_file("discard-unrelated-tolerance", "target.txt", b"base\n");
    std::fs::write(repo.0.join("target.txt"), b"target edit\n").unwrap();
    let preview = preview_discard_file(repo.path(), "target.txt", None, false).expect("preview");

    std::fs::write(repo.0.join("other.txt"), b"other\n").unwrap();
    repo.git_ok(&["add", "other.txt"]);
    discard_file(
        repo.path(),
        "target.txt",
        None,
        false,
        &preview.expected_state,
    )
    .expect("unrelated state must not invalidate a path-local expectation");

    assert_eq!(std::fs::read(repo.0.join("target.txt")).unwrap(), b"base\n");
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["show", ":other.txt"]).stdout),
        "other\n"
    );
}

#[test]
fn discard_roots_the_subprocess_at_the_discovered_worktree() {
    let repo = repo_with_file("discard-nested-caller-root", "file.txt", b"root base\n");
    std::fs::create_dir(repo.0.join("subdir")).unwrap();
    std::fs::write(repo.0.join("subdir/file.txt"), b"nested base\n").unwrap();
    repo.git_ok(&["add", "subdir/file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "nested file"]);
    std::fs::write(repo.0.join("file.txt"), b"root edit\n").unwrap();
    std::fs::write(repo.0.join("subdir/file.txt"), b"nested precious\n").unwrap();
    let preview = preview_discard_file(repo.path(), "file.txt", None, false).expect("preview");
    let nested_caller = repo.0.join("subdir");

    discard_file(
        nested_caller.to_str().unwrap(),
        "file.txt",
        None,
        false,
        &preview.expected_state,
    )
    .expect("the discovered root owns both the lease and pathspec");

    assert_eq!(
        std::fs::read(repo.0.join("file.txt")).unwrap(),
        b"root base\n"
    );
    assert_eq!(
        std::fs::read(repo.0.join("subdir/file.txt")).unwrap(),
        b"nested precious\n"
    );
}

#[test]
fn discard_revalidates_path_observations_after_the_content_pass() {
    let repo = repo_with_file("discard-final-leaf-recheck", "old.txt", b"base\n");
    repo.git_ok(&["mv", "old.txt", "new.txt"]);
    // Reverse the rename only in the worktree. Both paths remain inside the
    // staged row's operand set, so this is safe to preview as one logical row.
    std::fs::rename(repo.0.join("new.txt"), repo.0.join("old.txt")).unwrap();
    let preview = preview_discard_file(repo.path(), "new.txt", Some("old.txt"), true)
        .expect("preview the staged rename with its opposite worktree rename");
    let before_index = repo.git(&["diff", "--cached", "--binary"]).stdout;
    let hook_path = repo.0.join("old.txt");
    set_discard_capture_test_hook(move || {
        // Same size, after this earlier rename operand has already been hashed.
        std::fs::write(hook_path, b"late\n").unwrap();
    });

    let error = discard_file(
        repo.path(),
        "new.txt",
        Some("old.txt"),
        true,
        &preview.expected_state,
    )
    .expect_err("the final pathname observation must reject the late edit");

    assert!(error.contains("changed"), "unexpected error: {error}");
    assert_eq!(std::fs::read(repo.0.join("old.txt")).unwrap(), b"late\n");
    assert!(!repo.0.join("new.txt").exists());
    assert_eq!(
        repo.git(&["diff", "--cached", "--binary"]).stdout,
        before_index
    );
}

#[test]
fn discard_revalidates_index_semantics_after_the_content_pass() {
    let repo = repo_with_file("discard-final-index-recheck", "target.txt", b"base\n");
    std::fs::write(repo.0.join("target.txt"), b"edit\n").unwrap();
    let preview = preview_discard_file(repo.path(), "target.txt", None, false).expect("preview");
    let hook_repo = repo.0.clone();
    set_discard_capture_test_hook(move || {
        let output = Command::new("git")
            .arg("-C")
            .arg(hook_repo)
            .args(["add", "target.txt"])
            .output()
            .expect("git launches in capture hook");
        assert!(
            output.status.success(),
            "hook git add failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    });

    let error = discard_file(
        repo.path(),
        "target.txt",
        None,
        false,
        &preview.expected_state,
    )
    .expect_err("the fresh semantic capture must reject the staged transition");

    assert!(error.contains("changed"), "unexpected error: {error}");
    assert_eq!(std::fs::read(repo.0.join("target.txt")).unwrap(), b"edit\n");
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["show", ":target.txt"]).stdout),
        "edit\n"
    );
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
