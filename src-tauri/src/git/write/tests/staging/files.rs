//! Whole-file staging and unstaging, the literal-pathspec guarantee, and
//! dropping a file from the index without deleting it.

use super::super::support::*;

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

#[test]
fn stop_tracking_drops_the_index_entry_and_keeps_the_file() {
    let repo = repo_with_file("stop-tracking", "tracked.txt", b"hello\n");
    std::fs::write(repo.0.join("tracked.txt"), b"edited\n").unwrap();

    let message = stop_tracking(repo.path(), "tracked.txt").expect("stop tracking");
    assert!(message.contains("Stopped tracking"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "edited\n",
        "worktree leaf must survive"
    );

    let tracked = repo.git(&["ls-files", "--", "tracked.txt"]);
    assert!(
        String::from_utf8_lossy(&tracked.stdout).trim().is_empty(),
        "path must leave the index"
    );
    let status_out = repo.git(&["status", "--porcelain"]);
    let status = String::from_utf8_lossy(&status_out.stdout);
    assert!(
        status.contains("tracked.txt"),
        "staged deletion / untracked leaf should still be visible, got: {status}"
    );

    assert!(
        stop_tracking(repo.path(), "missing.txt").is_err(),
        "untracked / missing paths must refuse"
    );
}

#[test]
fn stop_tracking_refuses_when_unique_staged_content_would_be_lost() {
    // HEAD / index / worktree are three different blobs. Without `-f`, git must
    // refuse so the staged-only content is not discarded (GL-337 review).
    let repo = repo_with_file("stop-tracking-force", "tracked.txt", b"head\n");
    std::fs::write(repo.0.join("tracked.txt"), b"staged\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    std::fs::write(repo.0.join("tracked.txt"), b"worktree\n").unwrap();

    let err = stop_tracking(repo.path(), "tracked.txt").expect_err("must refuse");
    assert!(
        err.to_ascii_lowercase().contains("staged")
            || err.to_ascii_lowercase().contains("up-to-date")
            || err.to_ascii_lowercase().contains("force")
            || err.contains("tracked.txt"),
        "expected git's up-to-date refusal, got: {err}"
    );

    // Index must still hold the staged blob.
    let cached = repo.git(&["show", ":tracked.txt"]);
    assert_eq!(
        String::from_utf8_lossy(&cached.stdout),
        "staged\n",
        "index content must survive a refused stop-tracking"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "worktree\n"
    );
}
