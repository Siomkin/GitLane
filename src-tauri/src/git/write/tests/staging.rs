//! `staging` write-path tests.

use super::support::*;

#[test]
fn apply_hunk_stages_one_unstaged_hunk_with_unusual_path() {
    let repo = TempRepo::new("stage-hunk-unusual-path");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    let file = "space ü #.txt";
    std::fs::write(
        repo.0.join(file),
        "one\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\ntwelve\n",
    )
    .unwrap();
    repo.git_ok(&["add", file]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(
        repo.0.join(file),
        "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\nTWELVE\n",
    )
    .unwrap();

    apply_hunk(
        repo.path(),
        file,
        false,
        0,
        "@@ -1,4 +1,4 @@",
        "-one\n+ONE\n 2\n 3\n 4",
    )
    .expect("stage first hunk");

    let cached = repo.git(&["diff", "--cached", "--", file]);
    let cached_text = String::from_utf8_lossy(&cached.stdout);
    assert!(cached_text.contains("+ONE"));
    assert!(!cached_text.contains("+TWELVE"));
    let unstaged = repo.git(&["diff", "--", file]);
    let unstaged_text = String::from_utf8_lossy(&unstaged.stdout);
    assert!(!unstaged_text.contains("+ONE"));
    assert!(unstaged_text.contains("+TWELVE"));
}

#[test]
fn apply_patch_diff_args_match_rendered_diff_defaults() {
    assert_eq!(
        patch_diff_args(false, "file.txt"),
        vec![
            "-c",
            "diff.suppressBlankEmpty=false",
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-indent-heuristic",
            "--diff-algorithm=myers",
            "--unified=3",
            "--inter-hunk-context=0",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--",
            "file.txt",
        ]
    );
    assert_eq!(
        patch_diff_args(true, "file.txt"),
        vec![
            "-c",
            "diff.suppressBlankEmpty=false",
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-indent-heuristic",
            "--diff-algorithm=myers",
            "--unified=3",
            "--inter-hunk-context=0",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--cached",
            "--",
            "file.txt",
        ]
    );
}

#[test]
fn apply_hunk_allows_different_function_context_text() {
    let repo = TempRepo::new("hunk-function-context");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "ONE\ntwo\nthree\nfour\n").unwrap();

    apply_hunk(
        repo.path(),
        "file.txt",
        false,
        0,
        "@@ -1,4 +1,4 @@ different context",
        "-one\n+ONE\n two\n three\n four",
    )
    .expect("stage hunk");

    let cached = repo.git(&["diff", "--cached", "--", "file.txt"]);
    assert!(String::from_utf8_lossy(&cached.stdout).contains("+ONE"));
}

#[test]
fn apply_hunk_unstages_one_staged_hunk() {
    let repo = TempRepo::new("unstage-hunk");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(
        repo.0.join("file.txt"),
        "one\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\ntwelve\n",
    )
    .unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(
        repo.0.join("file.txt"),
        "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\nTWELVE\n",
    )
    .unwrap();
    repo.git_ok(&["add", "file.txt"]);

    apply_hunk(
        repo.path(),
        "file.txt",
        true,
        0,
        "@@ -1,4 +1,4 @@",
        "-one\n+ONE\n 2\n 3\n 4",
    )
    .expect("unstage first hunk");

    let cached = repo.git(&["diff", "--cached", "--", "file.txt"]);
    let cached_text = String::from_utf8_lossy(&cached.stdout);
    assert!(!cached_text.contains("+ONE"));
    assert!(cached_text.contains("+TWELVE"));
    let unstaged = repo.git(&["diff", "--", "file.txt"]);
    let unstaged_text = String::from_utf8_lossy(&unstaged.stdout);
    assert!(unstaged_text.contains("+ONE"));
}

#[test]
fn apply_hunk_stages_deleted_file_hunk() {
    let repo = TempRepo::new("stage-deleted-hunk");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("gone.txt"), "one\ntwo\nthree\n").unwrap();
    repo.git_ok(&["add", "gone.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::remove_file(repo.0.join("gone.txt")).unwrap();

    apply_hunk(
        repo.path(),
        "gone.txt",
        false,
        0,
        "@@ -1,3 +0,0 @@",
        "-one\n-two\n-three",
    )
    .expect("stage deletion hunk");

    let status = repo.git(&["diff", "--cached", "--name-status", "--", "gone.txt"]);
    assert_eq!(
        String::from_utf8_lossy(&status.stdout).trim(),
        "D\tgone.txt"
    );
}

#[test]
fn stage_files_stages_a_folder_including_a_deletion() {
    let repo = TempRepo::new("stage-files-folder");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::create_dir_all(repo.0.join("src/app")).unwrap();
    std::fs::write(repo.0.join("src/app/keep.txt"), "one\n").unwrap();
    std::fs::write(repo.0.join("src/app/gone.txt"), "bye\n").unwrap();
    std::fs::write(repo.0.join("root.txt"), "root\n").unwrap();
    repo.git_ok(&["add", "-A"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);

    // A folder with an edit + a deletion, plus an unrelated edit outside it.
    std::fs::write(repo.0.join("src/app/keep.txt"), "ONE\n").unwrap();
    std::fs::remove_file(repo.0.join("src/app/gone.txt")).unwrap();
    std::fs::write(repo.0.join("root.txt"), "ROOT\n").unwrap();

    // Roll up just the folder's files (the bulk-stage callback passes explicit paths).
    stage_files(
        repo.path(),
        &["src/app/keep.txt".into(), "src/app/gone.txt".into()],
    )
    .expect("stage the folder's files");

    let staged = repo.git(&["diff", "--cached", "--name-status"]);
    let staged_text = String::from_utf8_lossy(&staged.stdout);
    // The folder's edit and deletion are both staged (-A reaches removals too)…
    assert!(staged_text.contains("M\tsrc/app/keep.txt"), "{staged_text}");
    assert!(staged_text.contains("D\tsrc/app/gone.txt"), "{staged_text}");
    // …and the file outside the folder is left in the working tree.
    assert!(!staged_text.contains("root.txt"), "{staged_text}");
}

#[test]
fn stage_files_with_no_paths_is_a_noop() {
    let repo = TempRepo::new("stage-files-empty");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("root.txt"), "root\n").unwrap();

    // Empty set returns Ok without invoking git (mirrors unstage_files).
    assert_eq!(stage_files(repo.path(), &[]).unwrap(), "");
    let staged = repo.git(&["diff", "--cached", "--name-only"]);
    assert!(String::from_utf8_lossy(&staged.stdout).trim().is_empty());
}

#[cfg(not(windows))]
#[test]
fn exact_file_staging_treats_pathspec_magic_as_a_literal_filename() {
    let repo = repo_with_file("stage-pathspec-magic", "tracked.txt", b"base\n");
    let magic = ":(glob)z*";
    std::fs::write(repo.0.join(magic), "base\n").unwrap();
    std::fs::write(repo.0.join("z-victim.txt"), "base\n").unwrap();

    stage_file(repo.path(), magic).expect("stage literal magic filename");

    let staged = repo.git(&["diff", "--cached", "--name-only"]);
    assert_eq!(String::from_utf8_lossy(&staged.stdout).trim(), magic);
    let status = repo.git(&["status", "--porcelain", "--untracked-files=all"]);
    let status = String::from_utf8_lossy(&status.stdout);
    assert!(status.contains("?? z-victim.txt"), "{status}");

    unstage_file(repo.path(), magic).expect("unstage literal magic filename");
    stage_files(repo.path(), &[magic.to_string()]).expect("bulk-stage literal magic filename");
    stage_file(repo.path(), "z-victim.txt").expect("stage unrelated file");
    unstage_files(repo.path(), &[magic.to_string()]).expect("bulk-unstage literal magic filename");
    let staged = repo.git(&["diff", "--cached", "--name-only"]);
    assert_eq!(
        String::from_utf8_lossy(&staged.stdout).trim(),
        "z-victim.txt"
    );

    stage_file(repo.path(), magic).expect("re-stage literal magic filename");
    unstage_file(repo.path(), magic).expect("single-unstage literal magic filename");
    let staged = repo.git(&["diff", "--cached", "--name-only"]);
    assert_eq!(
        String::from_utf8_lossy(&staged.stdout).trim(),
        "z-victim.txt"
    );
}

#[cfg(not(windows))]
#[test]
fn hunk_staging_uses_the_literal_file_not_a_pathspec_match() {
    let magic = ":(glob)z*";
    let repo = TempRepo::new("hunk-pathspec-magic");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join(magic), "base\n").unwrap();
    std::fs::write(repo.0.join("z-victim.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "-A"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join(magic), "changed\n").unwrap();
    std::fs::write(repo.0.join("z-victim.txt"), "changed\n").unwrap();

    apply_hunk(
        repo.path(),
        magic,
        false,
        0,
        "@@ -1 +1 @@",
        "-base\n+changed",
    )
    .expect("stage hunk in literal magic filename");

    let staged = repo.git(&["diff", "--cached", "--name-only"]);
    assert_eq!(String::from_utf8_lossy(&staged.stdout).trim(), magic);
    let unstaged = repo.git(&["diff", "--name-only"]);
    assert_eq!(
        String::from_utf8_lossy(&unstaged.stdout).trim(),
        "z-victim.txt"
    );
}

#[test]
fn apply_hunk_rejects_stale_hunk_header() {
    let repo = TempRepo::new("stale-hunk");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "ONE\ntwo\n").unwrap();

    let err = apply_hunk(repo.path(), "file.txt", false, 0, "@@ -9,1 +9,1 @@", "").unwrap_err();

    assert!(err.contains("changed on disk"));
}

#[test]
fn apply_hunk_rejects_stale_hunk_body() {
    let repo = TempRepo::new("stale-hunk-body");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "ONE\ntwo\n").unwrap();

    // Correct @@ range but a body the diff never produced (the file changed on
    // disk since it was displayed) → rejected before anything is staged.
    let err = apply_hunk(
        repo.path(),
        "file.txt",
        false,
        0,
        "@@ -1,2 +1,2 @@",
        "-stale\n+content\n two",
    )
    .unwrap_err();

    assert!(err.contains("changed on disk"));
}

#[test]
fn apply_hunk_patch_surfaces_git_rejection() {
    let repo = TempRepo::new("reject-hunk-patch");
    repo.git_ok(&["init", "-q"]);

    let err = apply_hunk_patch(repo.path(), "not a patch\n", false).unwrap_err();

    assert!(!err.is_empty());
}

#[test]
fn apply_line_stages_one_added_line_with_unusual_path() {
    let repo = TempRepo::new("stage-line-add-unusual-path");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    let file = "line space ü #.txt";
    std::fs::write(repo.0.join(file), "one\ntwo\nthree\nfour\n").unwrap();
    repo.git_ok(&["add", file]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join(file), "one\ntwo\ninserted\nthree\nfour\n").unwrap();

    apply_line(
        repo.path(),
        file,
        false,
        0,
        2,
        "add",
        "inserted",
        None,
        Some(3),
    )
    .expect("stage added line");

    let cached = repo.git(&["diff", "--cached", "--", file]);
    let cached_text = String::from_utf8_lossy(&cached.stdout);
    assert!(cached_text.contains("+inserted"));
    let unstaged = repo.git(&["diff", "--", file]);
    let unstaged_text = String::from_utf8_lossy(&unstaged.stdout);
    assert!(!unstaged_text.contains("+inserted"));
}

#[test]
fn apply_line_stages_one_deleted_line() {
    let repo = TempRepo::new("stage-line-delete");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\nfour\n").unwrap();

    apply_line(
        repo.path(),
        "file.txt",
        false,
        0,
        2,
        "del",
        "three",
        Some(3),
        None,
    )
    .expect("stage deleted line");

    let cached = repo.git(&["diff", "--cached", "--", "file.txt"]);
    assert!(String::from_utf8_lossy(&cached.stdout).contains("-three"));
    let unstaged = repo.git(&["diff", "--", "file.txt"]);
    assert!(!String::from_utf8_lossy(&unstaged.stdout).contains("-three"));
}

#[test]
fn apply_line_unstages_one_staged_line() {
    let repo = TempRepo::new("unstage-line");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\ninserted\nthree\nfour\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);

    apply_line(
        repo.path(),
        "file.txt",
        true,
        0,
        2,
        "add",
        "inserted",
        None,
        Some(3),
    )
    .expect("unstage added line");

    let cached = repo.git(&["diff", "--cached", "--", "file.txt"]);
    assert!(!String::from_utf8_lossy(&cached.stdout).contains("+inserted"));
    let unstaged = repo.git(&["diff", "--", "file.txt"]);
    assert!(String::from_utf8_lossy(&unstaged.stdout).contains("+inserted"));
}

#[test]
fn apply_line_rejects_stale_line_state() {
    let repo = TempRepo::new("stale-line");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\nthree\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\ninserted\nthree\n").unwrap();

    let err = apply_line(
        repo.path(),
        "file.txt",
        false,
        0,
        2,
        "add",
        "different",
        None,
        Some(3),
    )
    .unwrap_err();

    assert!(err.contains("changed on disk"));
}

#[test]
fn apply_line_preserves_no_newline_at_eof_marker() {
    let repo = TempRepo::new("stage-line-no-newline");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), b"one\nlast").unwrap();

    apply_line(
        repo.path(),
        "file.txt",
        false,
        0,
        1,
        "add",
        "last",
        None,
        Some(2),
    )
    .expect("stage no-newline line");

    let blob = repo.git(&["show", ":file.txt"]);
    assert_eq!(blob.stdout, b"one\nlast");
}

#[test]
fn unstage_works_on_an_unborn_repo() {
    // GL-115 Bug 1: with no commits yet, `restore --staged` and `reset HEAD`
    // die with "could not resolve 'HEAD'" — the very first stage → unstage in
    // a fresh `git init` repo must still work, via the index-only fallbacks.
    let repo = TempRepo::new("unborn-unstage");
    repo.git_ok(&["init", "-q"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    std::fs::write(repo.0.join("b.txt"), "b\n").unwrap();
    stage_files(repo.path(), &["a.txt".into(), "b.txt".into()]).expect("stage on unborn HEAD");

    unstage_file(repo.path(), "a.txt").expect("unstage one file on unborn HEAD");
    assert_eq!(
        index_entries(&repo),
        ["b.txt"],
        "only a.txt leaves the index"
    );
    assert!(
        repo.0.join("a.txt").exists(),
        "unstage must not touch the worktree copy"
    );

    // Re-stage, then edit the worktree copy so index ≠ worktree — the unborn
    // fallback (`rm --cached`) must still unstage without tripping git's
    // staged-content safety check.
    stage_file(repo.path(), "a.txt").expect("re-stage a.txt");
    std::fs::write(repo.0.join("a.txt"), "a edited\n").unwrap();
    unstage_files(repo.path(), &["a.txt".into(), "b.txt".into()])
        .expect("unstage several files on unborn HEAD");
    assert!(
        index_entries(&repo).is_empty(),
        "index is empty after unstaging both"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
        "a edited\n",
        "worktree edit survives unstaging"
    );

    stage_files(repo.path(), &["a.txt".into(), "b.txt".into()]).expect("stage again");
    unstage_all(repo.path()).expect("unstage all on unborn HEAD");
    assert!(
        index_entries(&repo).is_empty(),
        "index is empty after unstage-all"
    );
    assert!(repo.0.join("a.txt").exists() && repo.0.join("b.txt").exists());
}
