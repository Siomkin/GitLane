//! `discard` preview tests: what the preview refuses to capture, what it
//! reports, and the bounds it puts on fingerprinting.

use super::super::support::*;

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
    let details = preview.details.join("\n");
    assert!(details.contains("Nested Git repositories"));
    assert!(details.contains("nested/"));
    // The protected tree must not also show up as a removal status entry.
    assert!(!details.contains(" nested/"));
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
