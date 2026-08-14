//! What `discard_all` must leave alone: empty directories, nested git
//! repositories, and anything created after the confirmation.

use super::super::support::*;

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
    let details = preview.details.join("\n");
    assert!(details.contains("Nested Git repositories"));
    assert!(details.contains("nested.git"));
    // Status entries are "<code> <path>", so a leading space distinguishes a file
    // slated for removal from the bare preserved-repository entry.
    assert!(!details.contains(" nested.git"));
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
    let details = preview.details.join("\n");
    assert!(details.contains("Nested Git repositories"));
    assert!(details.contains("nested"));
    assert!(!details.contains(" nested/precious"));
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
