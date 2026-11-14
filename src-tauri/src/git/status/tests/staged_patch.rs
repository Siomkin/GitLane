//! The staged diff as patch text for an agent prompt.

use super::super::staged_patch;
use super::support::*;

#[test]
fn staged_patch_holds_only_staged_changes_and_gives_up_over_the_cap() {
    let dir = git_init("staged-patch");
    fs::write(dir.join("seed.txt"), "seed\n").unwrap();
    git_ok(&dir, &["add", "seed.txt"]);
    git_ok(&dir, &["commit", "-q", "-m", "seed"]);
    fs::write(dir.join("seed.txt"), "seed\nmore\n").unwrap();
    fs::write(dir.join("new.txt"), "one\n").unwrap();
    git_ok(&dir, &["add", "seed.txt", "new.txt"]);
    fs::write(dir.join("loose.txt"), "unstaged\n").unwrap();
    fs::write(dir.join("planned.txt"), "later\n").unwrap();
    git_ok(&dir, &["add", "--intent-to-add", "planned.txt"]);
    let path = dir.to_str().unwrap();

    let patch = staged_patch(path, 100_000).unwrap().unwrap();
    assert!(patch.contains("diff --git a/new.txt b/new.txt"), "{patch}");
    assert!(patch.contains("\n+one\n"), "{patch}");
    assert!(patch.contains("\n seed\n+more\n"), "{patch}");
    // What `git diff --staged` leaves out stays out.
    assert!(!patch.contains("loose.txt"), "{patch}");
    assert!(!patch.contains("planned.txt"), "{patch}");

    assert_eq!(staged_patch(path, 10).unwrap(), None);
}
