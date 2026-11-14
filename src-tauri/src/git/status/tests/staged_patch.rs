//! The staged diff as patch text for an agent prompt.

use super::super::{diff_patch, staged_patch};
use super::support::*;

#[test]
fn staged_patch_holds_only_staged_changes_and_gives_up_over_the_cap() {
    let dir = git_init("staged-patch");
    fs::write(dir.join("seed.txt"), "seed\n").unwrap();
    fs::write(dir.join(".gitkeep"), "").unwrap();
    git_ok(&dir, &["add", "seed.txt", ".gitkeep"]);
    git_ok(&dir, &["commit", "-q", "-m", "seed"]);
    fs::write(dir.join("seed.txt"), "seed\nmore\n").unwrap();
    fs::write(dir.join("new.txt"), "one\n").unwrap();
    git_ok(&dir, &["add", "seed.txt", "new.txt"]);
    fs::write(dir.join("loose.txt"), "unstaged\n").unwrap();
    fs::write(dir.join("planned.txt"), "later\n").unwrap();
    git_ok(&dir, &["add", "--intent-to-add", "planned.txt"]);
    git_ok(&dir, &["rm", "-q", ".gitkeep"]);
    let path = dir.to_str().unwrap();

    let patch = staged_patch(path, 100_000).unwrap().unwrap();
    assert!(patch.contains("diff --git a/new.txt b/new.txt"), "{patch}");
    assert!(patch.contains("\n+one\n"), "{patch}");
    assert!(patch.contains("\n seed\n+more\n"), "{patch}");
    // An empty file's deletion must not pair with the empty intent-to-add entry.
    assert!(patch.contains("deleted file mode 100644"), "{patch}");
    // What `git diff --staged` leaves out stays out.
    assert!(!patch.contains("loose.txt"), "{patch}");
    assert!(!patch.contains("planned.txt"), "{patch}");

    assert_eq!(staged_patch(path, 10).unwrap(), None);
}

#[test]
fn diff_patch_reads_a_commit_a_range_and_the_working_tree() {
    let dir = git_init("diff-patch");
    fs::write(dir.join("a.txt"), "one\n").unwrap();
    git_ok(&dir, &["add", "a.txt"]);
    git_ok(&dir, &["commit", "-q", "-m", "root"]);
    fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
    git_ok(
        &dir,
        &["commit", "-q", "-am", "add two", "-m", "why it matters"],
    );
    fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    fs::write(dir.join("untracked.txt"), "fresh\n").unwrap();
    let path = dir.to_str().unwrap();

    // A root commit diffs against the empty tree, like `git show`.
    let root = diff_patch(path, None, Some("HEAD~1"), 100_000)
        .unwrap()
        .unwrap();
    assert!(
        root.contains("    root\n") && root.contains("new file mode"),
        "{root}"
    );

    let commit = diff_patch(path, None, Some("HEAD"), 100_000)
        .unwrap()
        .unwrap();
    assert!(commit.starts_with("commit "), "{commit}");
    assert!(
        commit.contains("    add two\n    \n    why it matters\n"),
        "{commit}"
    );
    assert!(commit.contains("\n one\n+two\n"), "{commit}");
    assert!(!commit.contains("three"), "{commit}");

    let range = diff_patch(path, Some("HEAD~1"), Some("HEAD"), 100_000)
        .unwrap()
        .unwrap();
    assert!(
        range.contains("+two\n") && !range.contains("add two"),
        "{range}"
    );

    let working = diff_patch(path, Some("HEAD"), None, 100_000)
        .unwrap()
        .unwrap();
    assert!(
        working.contains("+three\n") && !working.contains("+two\n"),
        "{working}"
    );
    assert!(working.contains("+fresh\n"), "untracked content: {working}");

    assert_eq!(diff_patch(path, None, Some("HEAD"), 10).unwrap(), None);
    assert!(diff_patch(path, None, None, 100).is_err());
}
