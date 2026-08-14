//! Single-path `discard` on one plain file, plus the revalidation the
//! content pass runs before mutating.

use super::super::support::*;

#[test]
fn discard_file_preserves_empty_directory_shells() {
    let repo = repo_with_file("discard-file-empty-dirs", "tracked.txt", b"base\n");
    std::fs::create_dir_all(repo.0.join("untracked/empty-nested")).unwrap();
    std::fs::write(repo.0.join("untracked/file.txt"), "new\n").unwrap();

    discard_current(&repo, "untracked/file.txt", None, false).expect("discard untracked file");

    assert!(!repo.0.join("untracked/file.txt").exists());
    assert!(repo.0.join("untracked/empty-nested").is_dir());
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
