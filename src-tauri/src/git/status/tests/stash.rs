//! Stash inspect: union of worktree, index, and untracked parents.

use super::support::*;
use crate::git::types::ChangeStatus;

#[test]
fn stash_oid_matches_include_untracked_stash_not_a_merge() {
    let dir = git_init("stash-detect");
    fs::write(dir.join("a.txt"), "base\n").unwrap();
    git_ok(&dir, &["add", "a.txt"]);
    git_ok(&dir, &["commit", "-qm", "base"]);
    fs::write(dir.join("a.txt"), "edit\n").unwrap();
    fs::write(dir.join("new.txt"), "untracked\n").unwrap();
    git_ok(
        &dir,
        &["stash", "push", "--include-untracked", "-qm", "wip"],
    );
    let stash = git_stdout(&dir, &["rev-parse", "stash@{0}"]);
    let path = dir.to_str().unwrap();
    let repo = Repository::open(path).unwrap();
    let stash_oid = git2::Oid::from_str(&stash).unwrap();
    assert!(is_stash_oid(&repo, stash_oid));
    drop(repo);

    git_ok(&dir, &["checkout", "-qb", "feat"]);
    fs::write(dir.join("feat.txt"), "feat\n").unwrap();
    git_ok(&dir, &["add", "feat.txt"]);
    git_ok(&dir, &["commit", "-qm", "feat"]);
    git_ok(&dir, &["checkout", "main"]);
    git_ok(&dir, &["merge", "--no-ff", "-m", "merge feat", "feat"]);
    let merge = git_stdout(&dir, &["rev-parse", "HEAD"]);
    let merge_oid = git2::Oid::from_str(&merge).unwrap();
    let repo = Repository::open(path).unwrap();
    assert!(!is_stash_oid(&repo, merge_oid));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn commit_files_includes_tracked_and_untracked_stash_paths() {
    let dir = git_init("stash-files-u");
    fs::write(dir.join("tracked.txt"), "base\n").unwrap();
    git_ok(&dir, &["add", "tracked.txt"]);
    git_ok(&dir, &["commit", "-qm", "base"]);
    fs::write(dir.join("tracked.txt"), "edited\n").unwrap();
    fs::write(dir.join("untracked.txt"), "new file\n").unwrap();
    git_ok(
        &dir,
        &["stash", "push", "--include-untracked", "-qm", "wip"],
    );
    let stash = git_stdout(&dir, &["rev-parse", "stash@{0}"]);
    let path = dir.to_str().unwrap();

    let files = commit_files(path, &stash).unwrap();
    let tracked = files.iter().find(|f| f.path == "tracked.txt").unwrap();
    assert_eq!(tracked.status, ChangeStatus::Modified);
    let untracked = files.iter().find(|f| f.path == "untracked.txt").unwrap();
    assert_eq!(untracked.status, ChangeStatus::Untracked);
    assert_eq!(files.len(), 2);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn commit_files_stash_without_untracked_parent_stays_tracked_only() {
    let dir = git_init("stash-files-no-u");
    fs::write(dir.join("tracked.txt"), "base\n").unwrap();
    git_ok(&dir, &["add", "tracked.txt"]);
    git_ok(&dir, &["commit", "-qm", "base"]);
    fs::write(dir.join("tracked.txt"), "edited\n").unwrap();
    git_ok(&dir, &["stash", "push", "-qm", "wip"]);
    let stash = git_stdout(&dir, &["rev-parse", "stash@{0}"]);
    let path = dir.to_str().unwrap();

    let files = commit_files(path, &stash).unwrap();
    assert!(files.iter().any(|f| f.path == "tracked.txt"));
    assert!(files.iter().all(|f| f.status != ChangeStatus::Untracked));
    let repo = Repository::open(path).unwrap();
    let commit = repo
        .find_commit(git2::Oid::from_str(&stash).unwrap())
        .unwrap();
    assert_eq!(commit.parent_count(), 2, "stash without -u has no ^3");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn commit_files_lists_index_only_stash_path() {
    let dir = git_init("stash-index-only");
    fs::write(dir.join("f.txt"), "base\n").unwrap();
    git_ok(&dir, &["add", "f.txt"]);
    git_ok(&dir, &["commit", "-qm", "base"]);
    fs::write(dir.join("f.txt"), "staged\n").unwrap();
    git_ok(&dir, &["add", "f.txt"]);
    git_ok(&dir, &["restore", "-s", "HEAD", "-W", "f.txt"]);
    git_ok(&dir, &["stash", "push", "-qm", "index only"]);
    let stash = git_stdout(&dir, &["rev-parse", "stash@{0}"]);
    let path = dir.to_str().unwrap();

    let files = commit_files(path, &stash).unwrap();
    let entry = files
        .iter()
        .find(|f| f.path == "f.txt")
        .expect("index-only path");
    assert_eq!(entry.status, ChangeStatus::Modified);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn commit_files_merge_does_not_list_dropped_second_parent_file() {
    // Merge of a one-commit branch has stash-like parent topology; dropping the
    // feature file from the merge tree must not surface it via a stash union.
    let dir = git_init("stash-not-merge");
    fs::write(dir.join("a.txt"), "main\n").unwrap();
    git_ok(&dir, &["add", "a.txt"]);
    git_ok(&dir, &["commit", "-qm", "main"]);
    let main = git_stdout(&dir, &["rev-parse", "HEAD"]);
    git_ok(&dir, &["checkout", "-qb", "feat"]);
    fs::write(dir.join("secret.txt"), "secret\n").unwrap();
    git_ok(&dir, &["add", "secret.txt"]);
    git_ok(&dir, &["commit", "-qm", "feat"]);
    let feat = git_stdout(&dir, &["rev-parse", "HEAD"]);

    let repo = Repository::open(&dir).unwrap();
    let main_commit = repo
        .find_commit(git2::Oid::from_str(&main).unwrap())
        .unwrap();
    let feat_commit = repo
        .find_commit(git2::Oid::from_str(&feat).unwrap())
        .unwrap();
    let tree = main_commit.tree().unwrap();
    let sig = git2::Signature::now("GitLane Test", "gitlane@example.test").unwrap();
    let merge = repo
        .commit(
            None,
            &sig,
            &sig,
            "merge dropping secret",
            &tree,
            &[&main_commit, &feat_commit],
        )
        .unwrap()
        .to_string();
    drop(tree);
    drop(feat_commit);
    drop(main_commit);
    drop(repo);

    let path = dir.to_str().unwrap();
    let files = commit_files(path, &merge).unwrap();
    assert!(
        files.iter().all(|f| f.path != "secret.txt"),
        "merge must stay first-parent: {files:?}"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn commit_file_diff_shows_untracked_stash_file_as_addition() {
    let dir = git_init("stash-file-diff-u");
    fs::write(dir.join("tracked.txt"), "base\n").unwrap();
    git_ok(&dir, &["add", "tracked.txt"]);
    git_ok(&dir, &["commit", "-qm", "base"]);
    fs::write(dir.join("untracked.txt"), "hello stash\n").unwrap();
    git_ok(
        &dir,
        &["stash", "push", "--include-untracked", "-qm", "wip"],
    );
    let stash = git_stdout(&dir, &["rev-parse", "stash@{0}"]);
    let path = dir.to_str().unwrap();

    let diff = commit_file_diff(path, &stash, "untracked.txt", false).unwrap();
    assert_eq!(diff.status, ChangeStatus::Untracked);
    let adds: Vec<&str> = diff
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| l.kind == "add")
        .map(|l| l.content.as_str())
        .collect();
    assert_eq!(adds, vec!["hello stash"]);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selection_diff_includes_untracked_stash_path() {
    let dir = git_init("stash-selection-u");
    fs::write(dir.join("tracked.txt"), "base\n").unwrap();
    git_ok(&dir, &["add", "tracked.txt"]);
    git_ok(&dir, &["commit", "-qm", "base"]);
    let head = git_stdout(&dir, &["rev-parse", "HEAD"]);
    fs::write(dir.join("tracked.txt"), "edited\n").unwrap();
    fs::write(dir.join("untracked.txt"), "new\n").unwrap();
    git_ok(
        &dir,
        &["stash", "push", "--include-untracked", "-qm", "wip"],
    );
    let stash = git_stdout(&dir, &["rev-parse", "stash@{0}"]);
    let path = dir.to_str().unwrap();

    let files = selection_diff(path, &[stash.clone(), head]).unwrap();
    let untracked = files
        .iter()
        .find(|f| f.path == "untracked.txt")
        .expect("untracked stash path in selection");
    assert_eq!(untracked.status, ChangeStatus::Untracked);

    let _ = fs::remove_dir_all(&dir);
}
