//! `discard_all` against a repository moved out from under it: gitfile,
//! commondir, HEAD, replace-ref and symlink retargets attempted between the
//! final validation and the reset.

use super::super::support::*;

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
