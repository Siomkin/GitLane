//! The staged diff as patch text for an agent prompt.

use super::super::staged_patch;
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
