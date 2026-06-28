use super::{commit_file_diff, compare_file_diff, compare_refs, file_blame, file_history};
use super::diff::DIFF_LINE_LIMIT;
use git2::{Repository, Signature};
use std::fs;
use std::path::Path;

fn commit(repo: &Repository, dir: &Path, name: &str, content: &str) -> git2::Oid {
    fs::write(dir.join(name), content).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(name)).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::now("Bench", "bench@example.test").unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, name, &tree, &parents)
        .unwrap()
}

fn commit_index(repo: &Repository, message: &str) -> git2::Oid {
    let mut index = repo.index().unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::now("Bench", "bench@example.test").unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .unwrap()
}

#[test]
fn large_commit_diff_truncates_until_full_is_requested() {
    let dir = std::env::temp_dir().join("gitlane-diff-cap-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");

    let extra = 500;
    let big: String = (0..DIFF_LINE_LIMIT + extra)
        .map(|i| format!("line {i}\n"))
        .collect();
    let oid = commit(&repo, &dir, "big.txt", &big).to_string();
    let path = dir.to_str().unwrap();

    // Default: capped at the line limit, but the +add pill keeps the real total.
    let capped = commit_file_diff(path, &oid, "big.txt", false).unwrap();
    let shown: usize = capped.hunks.iter().map(|h| h.lines.len()).sum();
    assert!(capped.truncated);
    assert!(shown <= DIFF_LINE_LIMIT, "shown {shown}");
    assert_eq!(capped.add, DIFF_LINE_LIMIT + extra);

    // "Show full diff": uncapped, every line present.
    let full = commit_file_diff(path, &oid, "big.txt", true).unwrap();
    let full_shown: usize = full.hunks.iter().map(|h| h.lines.len()).sum();
    assert!(!full.truncated);
    assert_eq!(full_shown, DIFF_LINE_LIMIT + extra);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn diff_skips_no_newline_eofnl_markers() {
    let dir = std::env::temp_dir().join("gitlane-diff-eofnl-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    // A file whose last line has no trailing newline, edited in place — libgit2
    // emits a "\ No newline at end of file" EOFNL marker pseudo-line for it.
    commit(&repo, &dir, "nonl.txt", "one\ntwo\nthree");
    let oid = commit(&repo, &dir, "nonl.txt", "one\ntwo\nTHREE").to_string();
    let path = dir.to_str().unwrap();

    let diff = commit_file_diff(path, &oid, "nonl.txt", false).unwrap();
    let lines: Vec<_> = diff.hunks.iter().flat_map(|h| &h.lines).collect();

    // The real content change is present...
    assert!(lines.iter().any(|l| l.kind == "del" && l.content == "three"));
    assert!(lines.iter().any(|l| l.kind == "add" && l.content == "THREE"));
    // ...and the EOFNL marker pseudo-lines are dropped (no stray rows leak in).
    let allowed = ["one", "two", "three", "THREE"];
    assert!(
        lines.iter().all(|l| allowed.contains(&l.content.as_str())),
        "unexpected line content: {:?}",
        lines.iter().map(|l| &l.content).collect::<Vec<_>>()
    );

    let _ = fs::remove_dir_all(&dir);
}

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
    assert_eq!(first.entries[0].status, "D");
    assert_eq!(first.entries[1].status, "M");

    let second = file_history(path, "tracked.txt", Some(first.next_offset), Some(2)).unwrap();
    assert_eq!(second.entries.len(), 1);
    assert!(!second.has_more);
    assert_eq!(second.entries[0].status, "A");

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
    assert_eq!(page.entries[0].status, "R");
    assert_eq!(page.entries[0].previous_path.as_deref(), Some("old name.txt"));
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
