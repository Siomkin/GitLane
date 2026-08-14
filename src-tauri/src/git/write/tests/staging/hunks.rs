//! Hunk-level staging: the diff args it must match, the context it tolerates,
//! and the stale headers and bodies it rejects.

use super::super::support::*;

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
