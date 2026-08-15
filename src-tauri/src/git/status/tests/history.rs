//! File history, blame, and ref comparison.

use super::support::*;
use crate::git::types::ChangeStatus;

#[test]
fn file_history_lists_changes_newest_first_and_paginates() {
    let dir = std::env::temp_dir().join("gitlane-file-history-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "tracked.txt", "one\n");
    commit(&repo, &dir, "tracked.txt", "one\ntwo\n");
    fs::remove_file(dir.join("tracked.txt")).unwrap();
    let mut index = repo.index().unwrap();
    index.remove_path(Path::new("tracked.txt")).unwrap();
    index.write().unwrap();
    commit_index(&repo, "delete tracked.txt");

    let path = dir.to_str().unwrap();
    let first = file_history(path, "tracked.txt", Some(0), Some(2)).unwrap();
    assert_eq!(first.entries.len(), 2);
    assert!(first.has_more);
    assert_eq!(first.entries[0].status, ChangeStatus::Deleted);
    assert_eq!(first.entries[1].status, ChangeStatus::Modified);

    let second = file_history(path, "tracked.txt", Some(first.next_offset), Some(2)).unwrap();
    assert_eq!(second.entries.len(), 1);
    assert!(!second.has_more);
    assert_eq!(second.entries[0].status, ChangeStatus::Added);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn file_history_follows_detected_renames_backward() {
    let dir = std::env::temp_dir().join("gitlane-file-history-rename-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "old name.txt", "same\n");

    fs::rename(dir.join("old name.txt"), dir.join("new name.txt")).unwrap();
    let mut index = repo.index().unwrap();
    index.remove_path(Path::new("old name.txt")).unwrap();
    index.add_path(Path::new("new name.txt")).unwrap();
    index.write().unwrap();
    commit_index(&repo, "rename file");

    let page = file_history(dir.to_str().unwrap(), "new name.txt", None, Some(10)).unwrap();
    assert_eq!(page.entries.len(), 2);
    assert_eq!(page.entries[0].status, ChangeStatus::Renamed);
    assert_eq!(
        page.entries[0].previous_path.as_deref(),
        Some("old name.txt")
    );
    assert_eq!(page.entries[1].path, "old name.txt");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn file_blame_returns_line_attribution() {
    let dir = std::env::temp_dir().join("gitlane-file-blame-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "blame.txt", "first\n");
    let second = commit(&repo, &dir, "blame.txt", "first\nsecond\n").to_string();

    let blame = file_blame(dir.to_str().unwrap(), "blame.txt", Some(second), Some(10)).unwrap();
    assert!(!blame.binary);
    assert_eq!(blame.lines.len(), 2);
    assert_eq!(blame.lines[0].content, "first");
    assert_eq!(blame.lines[1].content, "second");
    assert_eq!(blame.lines[1].author_name, "Bench");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn file_blame_does_not_treat_a_utf8_named_read_failure_as_binary() {
    let dir = std::env::temp_dir().join("gitlane-file-blame-utf8-path-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "missing-UTF-8.txt", "text\n");
    fs::remove_file(dir.join("missing-UTF-8.txt")).unwrap();

    let result = file_blame(dir.to_str().unwrap(), "missing-UTF-8.txt", None, Some(10));

    assert!(
        result.is_err(),
        "a real read failure must propagate: {result:?}"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn working_tree_blame_refuses_an_ancestor_symlink() {
    use std::os::unix::fs::symlink;

    let dir = std::env::temp_dir().join("gitlane-file-blame-symlink-test");
    let outside = dir.with_extension("outside");
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&outside);
    fs::create_dir_all(dir.join("nested")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "nested/blame.txt", "inside\n");
    fs::write(outside.join("blame.txt"), "outside secret\n").unwrap();
    fs::rename(dir.join("nested"), dir.join("nested-original")).unwrap();
    symlink(&outside, dir.join("nested")).unwrap();

    let result = file_blame(dir.to_str().unwrap(), "nested/blame.txt", None, Some(10));

    assert!(
        result.is_err(),
        "working-tree blame must not follow {result:?}"
    );
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&outside);
}

#[test]
fn file_history_reports_line_stats() {
    let dir = std::env::temp_dir().join("gitlane-file-history-stats-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "stats.txt", "a\n");
    commit(&repo, &dir, "stats.txt", "a\nb\nc\n");

    let page = file_history(dir.to_str().unwrap(), "stats.txt", None, Some(10)).unwrap();
    assert_eq!(page.entries.len(), 2);
    // Newest commit appended two lines.
    assert_eq!(page.entries[0].add, 2);
    assert_eq!(page.entries[0].del, 0);
    // The original commit added the file's first line.
    assert_eq!(page.entries[1].add, 1);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn compare_refs_lists_changed_files_with_counts_and_distance() {
    let dir = std::env::temp_dir().join("gitlane-compare-refs-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    let base = commit(&repo, &dir, "kept.txt", "one\n").to_string();
    commit(&repo, &dir, "kept.txt", "one\ntwo\n");
    let head = commit(&repo, &dir, "added.txt", "new\n").to_string();

    let path = dir.to_str().unwrap();
    let result = compare_refs(path, &base, Some(&head)).unwrap();
    let names: Vec<&str> = result.files.iter().map(|f| f.path.as_str()).collect();
    assert!(names.contains(&"kept.txt"));
    assert!(names.contains(&"added.txt"));
    assert!(result.add >= 2);
    // head is two commits past base.
    assert_eq!(result.ahead, 2);
    assert_eq!(result.behind, 0);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn compare_refs_against_working_tree() {
    let dir = std::env::temp_dir().join("gitlane-compare-working-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    let base = commit(&repo, &dir, "work.txt", "one\n").to_string();
    // Uncommitted edit in the working tree.
    fs::write(dir.join("work.txt"), "one\ntwo\n").unwrap();

    let path = dir.to_str().unwrap();
    let result = compare_refs(path, &base, None).unwrap();
    assert_eq!(result.files.len(), 1);
    assert_eq!(result.files[0].path, "work.txt");
    assert_eq!(result.ahead, 0);
    assert_eq!(result.behind, 0);

    let diff = compare_file_diff(path, &base, None, "work.txt", false).unwrap();
    assert!(diff.add >= 1);
    assert!(!diff.hunks.is_empty());

    let _ = fs::remove_dir_all(&dir);
}
