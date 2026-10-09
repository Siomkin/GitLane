//! Renames between two refs: the compare pane diffs a moved file against its
//! old blob, not as a whole-file add.

use super::support::*;
use crate::git::types::ChangeStatus;

#[test]
fn a_rename_between_two_refs_diffs_against_the_old_blob() {
    // The compare pane pathspecs the new path only, so the rename source was
    // dropped before `find_similar` and a pure move opened as a whole-file add
    // beside a list row reading "R +0 −0" (A3-1).
    let dir = git_init("compare-rename");
    fs::write(dir.join("old.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n").unwrap();
    git_ok(&dir, &["add", "old.txt"]);
    git_ok(&dir, &["commit", "-q", "-m", "base"]);
    git_ok(&dir, &["mv", "old.txt", "moved.txt"]);
    git_ok(&dir, &["commit", "-q", "-m", "move"]);
    let path = dir.to_str().unwrap();

    let diff = compare_file_diff(path, "HEAD~1", Some("HEAD"), "moved.txt", false).unwrap();
    assert_eq!(diff.status, ChangeStatus::Renamed);
    assert_eq!((diff.add, diff.del), (0, 0));
    let row = compare_refs(path, "HEAD~1", Some("HEAD")).unwrap().files;
    assert_eq!(row.len(), 1);
    assert_eq!((row[0].add, row[0].del), (diff.add, diff.del));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_rename_with_edits_between_two_refs_shows_only_the_edits() {
    // Spec review/diff "Rename with edits": a move that also changes three lines
    // diffs against the old blob, so only those three lines show — not the whole
    // file as added.
    let dir = git_init("compare-rename-edit");
    let base: String = (1..=20).map(|n| format!("line {n}\n")).collect();
    fs::write(dir.join("old.txt"), &base).unwrap();
    git_ok(&dir, &["add", "old.txt"]);
    git_ok(&dir, &["commit", "-q", "-m", "base"]);
    git_ok(&dir, &["mv", "old.txt", "moved.txt"]);
    let edited = base
        .replace("line 3\n", "THREE\n")
        .replace("line 10\n", "TEN\n")
        .replace("line 17\n", "SEVENTEEN\n");
    fs::write(dir.join("moved.txt"), edited).unwrap();
    git_ok(&dir, &["commit", "-qam", "move and edit"]);
    let path = dir.to_str().unwrap();

    let diff = compare_file_diff(path, "HEAD~1", Some("HEAD"), "moved.txt", false).unwrap();
    assert_eq!(diff.status, ChangeStatus::Renamed);
    assert_eq!((diff.add, diff.del), (3, 3));
    let changed: Vec<(&str, &str)> = diff
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| l.kind != "ctx")
        .map(|l| (l.kind.as_str(), l.content.trim_end()))
        .collect();
    assert_eq!(
        changed,
        [
            ("del", "line 3"),
            ("add", "THREE"),
            ("del", "line 10"),
            ("add", "TEN"),
            ("del", "line 17"),
            ("add", "SEVENTEEN"),
        ]
    );
    let row = compare_refs(path, "HEAD~1", Some("HEAD")).unwrap().files;
    assert_eq!(row.len(), 1);
    assert_eq!((row[0].add, row[0].del), (3, 3));

    let _ = fs::remove_dir_all(&dir);
}
